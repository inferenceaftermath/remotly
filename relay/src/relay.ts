// HTTP surface of the relay (README.md "API"). `POST /v1/push` takes the same inputs the bridge's direct clients
// take, pins everything that names the app (topic, project) to this Worker's own configuration, forwards, and
// answers with the upstream result. `GET /health` says which platforms are configured. Stateless apart from the
// cached credentials inside the senders; no request data is ever kept in module scope.
import { ApnsSender, FcmSender, type ApnsEnv, type ApnsPushType, type Deps, type Result, type ServiceAccount } from './upstream.ts';

export const VERSION = '0.1.0';
/**
 * Everything one push does upstream (APNs attempt + retry, or Google token exchange + FCM send) fits this budget, so the
 * bridge, which waits 25 s (`bridge/src/push/relay.ts`), always sees the outcome and never re-sends a delivered push.
 */
export const RELAY_DEADLINE_MS = 20_000;

/** Shape of the Cloudflare rate-limit binding we use (kept structural so tests can pass a stub). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** What the handler reads from `env`; `wrangler types` generates the concrete `Env` this must stay assignable from. */
export interface RelayEnv {
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_P8?: string;
  APNS_BUNDLE_ID?: string;
  FCM_PROJECT_ID?: string;
  FCM_PACKAGE_NAME?: string;
  FCM_SERVICE_ACCOUNT?: string;
  /** Both limiters are required: a deployment without them answers 503 rather than serving an unlimited endpoint. */
  RL_IP?: RateLimiter;
  RL_TOKEN?: RateLimiter;
}

/** Larger than any legal APNs (4 KiB) or FCM (4 KB data) message, small enough to read whole. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_COLLAPSE_BYTES = 64;
/** APNs `apns-expiration` and FCM `ttl` are bounded so a caller cannot park a message at Apple/Google for weeks. */
const MAX_TTL_SEC = 86_400;
const APNS_TOKEN = /^[0-9a-fA-F]{32,256}$/;
const FCM_TOKEN = /^[A-Za-z0-9_:.\-]{20,4096}$/;
/** Collapse ids become HTTP header values / JSON strings: visible ASCII only, so no header injection or CR/LF. */
const COLLAPSE = /^[\x21-\x7e]+$/;

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).byteLength;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

class BadRequest extends Error {}

/** Read at most `cap` bytes; `null` when the body is larger (the caller answers 413). */
async function readBounded(request: Request, cap: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, re: RegExp, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !re.test(v)) throw new BadRequest(`${key} must be ${what}`);
  return v;
}

function collapse(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_COLLAPSE_BYTES || !COLLAPSE.test(v)) throw new BadRequest(`${key} must be 1-${MAX_COLLAPSE_BYTES} visible ASCII characters`);
  return v;
}

function ttl(o: Record<string, unknown>, fallback: number): number {
  const v = o['ttl_sec'];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_TTL_SEC) throw new BadRequest(`ttl_sec must be an integer 0-${MAX_TTL_SEC}`);
  return v;
}

type Parsed =
  | { platform: 'ios'; token: string; env: ApnsEnv; collapseId: string; pushType: ApnsPushType; priority: 5 | 10; ttlSec: number; payload: string }
  | { platform: 'android'; token: string; collapseKey: string; ttlSec: number; data: Record<string, string> };

export function parsePush(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest('body must be JSON');
  }
  if (!isRecord(raw)) throw new BadRequest('body must be a JSON object');
  const platform = raw['platform'];
  if (platform === 'ios') {
    const env = raw['env'] ?? 'production';
    if (env !== 'production' && env !== 'sandbox') throw new BadRequest('env must be production or sandbox');
    const pushType = raw['push_type'] ?? 'alert';
    if (pushType !== 'alert' && pushType !== 'liveactivity') throw new BadRequest('push_type must be alert or liveactivity');
    const priority = raw['priority'] ?? 10;
    if (priority !== 5 && priority !== 10) throw new BadRequest('priority must be 5 or 10');
    if (!isRecord(raw['payload'])) throw new BadRequest('payload must be a JSON object');
    const payload = JSON.stringify(raw['payload']);
    if (bytes(payload) > MAX_PAYLOAD_BYTES) throw new BadRequest(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
    return {
      platform: 'ios',
      token: str(raw, 'token', APNS_TOKEN, 'a hex APNs device token').toLowerCase(), // one rate-limit bucket per token, whatever the casing
      env,
      collapseId: collapse(raw, 'collapse_id'),
      pushType,
      priority,
      ttlSec: ttl(raw, pushType === 'liveactivity' ? 60 : 600),
      payload,
    };
  }
  if (platform === 'android') {
    const data = raw['data'];
    if (!isRecord(data) || Object.values(data).some((v) => typeof v !== 'string')) throw new BadRequest('data must be an object of strings');
    if (bytes(JSON.stringify(data)) > MAX_PAYLOAD_BYTES) throw new BadRequest(`data must be at most ${MAX_PAYLOAD_BYTES} bytes`);
    return {
      platform: 'android',
      token: str(raw, 'token', FCM_TOKEN, 'an FCM registration token'),
      collapseKey: collapse(raw, 'collapse_key'),
      ttlSec: ttl(raw, 600),
      data: data as Record<string, string>,
    };
  }
  throw new BadRequest('platform must be ios or android');
}

export interface Relay {
  fetch(request: Request, env: RelayEnv): Promise<Response>;
}

/** One relay per isolate: the senders inside cache the upstream credentials across requests. */
export function createRelay(deps: Deps = {}): Relay {
  const log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
  const senderDeps: Deps = { ...deps, log };
  let apns: ApnsSender | null | undefined;
  let fcm: FcmSender | null | undefined;

  const apnsFor = (env: RelayEnv): ApnsSender | null => {
    if (apns === undefined) {
      apns = env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_P8 && env.APNS_BUNDLE_ID
        ? new ApnsSender({ teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, p8: env.APNS_P8, bundleId: env.APNS_BUNDLE_ID }, senderDeps)
        : null;
    }
    return apns;
  };
  const fcmFor = (env: RelayEnv): FcmSender | null => {
    if (fcm === undefined) {
      fcm = null;
      if (env.FCM_PROJECT_ID && env.FCM_PACKAGE_NAME && env.FCM_SERVICE_ACCOUNT) {
        try {
          const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as Partial<ServiceAccount>;
          if (typeof sa.client_email === 'string' && typeof sa.private_key === 'string') {
            fcm = new FcmSender(env.FCM_PROJECT_ID, env.FCM_PACKAGE_NAME, { client_email: sa.client_email, private_key: sa.private_key, ...(sa.token_uri ? { token_uri: sa.token_uri } : {}) }, senderDeps);
          } else log('fcm.config_error', { stage: 'startup', error: 'FCM_SERVICE_ACCOUNT lacks client_email/private_key' });
        } catch {
          log('fcm.config_error', { stage: 'startup', error: 'FCM_SERVICE_ACCOUNT is not JSON' });
        }
      }
    }
    return fcm;
  };

  /** `allowed`, `limited`, or `unavailable` (binding missing or throwing): the endpoint fails closed, never open. */
  async function gate(limiter: RateLimiter | undefined, key: string): Promise<'allowed' | 'limited' | 'unavailable'> {
    if (!limiter) {
      log('ratelimit.error', { error: 'binding missing' });
      return 'unavailable';
    }
    try {
      return (await limiter.limit({ key })).success ? 'allowed' : 'limited';
    } catch (err) {
      log('ratelimit.error', { error: String((err as Error).message ?? err) });
      return 'unavailable';
    }
  }

  const gateResponse = (verdict: 'limited' | 'unavailable', scope: 'ip' | 'token'): Response =>
    verdict === 'limited' ? json(429, { error: 'rate_limited', scope }) : json(503, { error: 'rate_limiter_unavailable' });

  const clientIp = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown';

  async function push(request: Request, env: RelayEnv): Promise<Response> {
    const ipVerdict = await gate(env.RL_IP, clientIp(request));
    if (ipVerdict !== 'allowed') return gateResponse(ipVerdict, 'ip');
    const text = await readBounded(request, MAX_BODY_BYTES);
    if (text === null) return json(413, { error: 'body_too_large', max_bytes: MAX_BODY_BYTES });
    let input: Parsed;
    try {
      input = parsePush(text);
    } catch (err) {
      if (err instanceof BadRequest) return json(400, { error: 'bad_request', detail: err.message });
      throw err;
    }
    const tokenVerdict = await gate(env.RL_TOKEN, `${input.platform}:${input.token}`);
    if (tokenVerdict !== 'allowed') return gateResponse(tokenVerdict, 'token');

    const now = deps.now ?? Date.now;
    const started = now();
    const budget = { deadlineAt: started + RELAY_DEADLINE_MS };
    let result: Result;
    if (input.platform === 'ios') {
      const sender = apnsFor(env);
      if (!sender) return json(503, { error: 'not_configured', platform: 'ios' });
      result = await sender.send(input, budget);
    } else {
      const sender = fcmFor(env);
      if (!sender) return json(503, { error: 'not_configured', platform: 'android' });
      result = await sender.send(input, budget);
    }
    log('push', { platform: input.platform, ok: result.ok, ...(result.ok ? {} : { status: result.status, reason: result.reason, drop_token: result.drop_token }), ms: now() - started });
    return json(200, result);
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/health') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });
          const verdict = await gate(env.RL_IP, clientIp(request));
          if (verdict !== 'allowed') return gateResponse(verdict, 'ip');
          return json(200, { ok: true, version: VERSION, apns: apnsFor(env) !== null, fcm: fcmFor(env) !== null });
        }
        if (url.pathname === '/v1/push') {
          if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
          return await push(request, env);
        }
        return json(404, { error: 'not_found' });
      } catch (err) {
        log('relay.error', { path: url.pathname, error: String((err as Error).message ?? err) });
        return json(500, { error: 'internal' });
      }
    },
  };
}
