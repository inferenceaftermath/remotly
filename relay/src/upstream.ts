// The two upstream senders. Same status → result mapping as the bridge's direct clients
// (bridge/src/push/apns.ts, fcm.ts) so a bridge behind the relay behaves exactly like one with local secrets:
// `drop_token` tells it to forget a dead registration. Credentials are cached per sender instance (one per
// isolate); a 403/401 from upstream clears the cache so the next push re-mints. Never log tokens or payload text.
import { importSigningKey, signJwt, type SigningKey } from './jwt.ts';

export type Result = { ok: true } | { ok: false; status: number; reason: string; drop_token: boolean };

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Per upstream attempt; also bounded by the caller's `Budget`, so all attempts of one push fit one relay request. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Below this much remaining budget an attempt is pointless; the caller gets `deadline_exceeded` (or the earlier failure). */
const MIN_ATTEMPT_MS = 1_500;

/**
 * Absolute deadline (ms epoch, from the sender's clock) for everything one relay request does upstream. The bridge
 * waits longer than the relay's total budget, so a push the relay eventually delivered is never reported to it as
 * failed and then re-sent (a lost `end` for a Live Activity would otherwise be retried after the real one landed).
 */
export interface Budget {
  deadlineAt: number;
}

function transportReason(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string };
  return String(e?.code ?? e?.name ?? e?.message ?? 'transport_error');
}

/** POST once; on a transport failure (no HTTP response) retry once on a fresh connection. */
type Posted = { replied: true; status: number; body: string } | { replied: false; reason: string };

/**
 * POST with a bounded number of attempts. Only a rejected `fetch()` (no response at all) is retried, and only when
 * `attempts` > 1; once headers have arrived the peer may have accepted the message, so a failure while reading the
 * body is reported (`response_body_error`) and never retried. Pushes are not idempotent: APNs sends get the same
 * single retry the bridge's direct client has, FCM sends none (parity with `FcmClient`), the Google token exchange
 * (idempotent) one.
 */
async function post(fetchImpl: typeof fetch, url: string, init: RequestInit, attempts: 1 | 2, now: () => number, budget: Budget): Promise<Posted> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = budget.deadlineAt - now();
    if (remaining < MIN_ATTEMPT_MS) return { replied: false, reason: attempt === 0 ? 'deadline_exceeded' : transportReason(last) };
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)) });
    } catch (err) {
      last = err;
      continue;
    }
    try {
      return { replied: true, status: res.status, body: await res.text() };
    } catch {
      return { replied: false, reason: 'response_body_error' };
    }
  }
  return { replied: false, reason: transportReason(last) };
}

/** Cache a promise but forget it again if it rejects, so a transient failure is not replayed for the isolate's life. */
function cached<T>(get: () => Promise<T> | null, set: (p: Promise<T> | null) => void, make: () => Promise<T>): Promise<T> {
  const existing = get();
  if (existing) return existing;
  const p = make();
  set(p);
  p.catch(() => {
    if (get() === p) set(null);
  });
  return p;
}

// ---- APNs ---------------------------------------------------------------------------------------

export type ApnsEnv = 'production' | 'sandbox';
export type ApnsPushType = 'alert' | 'liveactivity';

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** Contents of the `.p8` file. */
  p8: string;
  bundleId: string;
}

export interface ApnsInput {
  token: string;
  env: ApnsEnv;
  collapseId: string;
  pushType: ApnsPushType;
  priority: 5 | 10;
  ttlSec: number;
  /** Already-serialised APNs payload (the bridge built it). */
  payload: string;
}

const APNS_HOSTS: Record<ApnsEnv, string> = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
/** Apple accepts a provider token for up to an hour; re-mint at 50 minutes like the bridge does. */
const APNS_JWT_TTL_MS = 50 * 60_000;

function apnsReason(body: string, status: number): string {
  try {
    const r = (JSON.parse(body) as { reason?: unknown }).reason;
    if (typeof r === 'string') return r;
  } catch {
    // not JSON
  }
  return `HTTP_${status}`;
}

export class ApnsSender {
  private readonly cfg: ApnsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: Deps['log'];
  private key: Promise<SigningKey> | null = null;
  private jwt: { value: Promise<string>; issuedAt: number } | null = null;

  constructor(cfg: ApnsConfig, deps: Deps = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log;
  }

  private signingKey(): Promise<SigningKey> {
    return cached(() => this.key, (p) => (this.key = p), () => importSigningKey(this.cfg.p8, 'ES256'));
  }

  private bearer(): Promise<string> {
    const t = this.now();
    if (!this.jwt || t - this.jwt.issuedAt >= APNS_JWT_TTL_MS) {
      const entry = { value: this.signingKey().then((key) => signJwt({ alg: 'ES256', kid: this.cfg.keyId, typ: 'JWT' }, { iss: this.cfg.teamId, iat: Math.floor(t / 1000) }, key, 'ES256')), issuedAt: t };
      entry.value.catch(() => {
        if (this.jwt === entry) this.jwt = null; // never cache a rejection, never clear a newer token
      });
      this.jwt = entry;
    }
    return this.jwt.value;
  }

  async send(input: ApnsInput, budget: Budget): Promise<Result> {
    let bearer: string;
    try {
      bearer = await this.bearer();
    } catch (err) {
      this.log?.('apns.config_error', { stage: 'jwt', error: String((err as Error).message ?? err) });
      return { ok: false, status: 0, reason: 'provider_key_invalid', drop_token: false };
    }
    const topic = input.pushType === 'liveactivity' ? `${this.cfg.bundleId}.push-type.liveactivity` : this.cfg.bundleId;
    const r = await post(this.fetchImpl, `https://${APNS_HOSTS[input.env]}/3/device/${input.token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${bearer}`,
        'apns-topic': topic,
        'apns-push-type': input.pushType,
        'apns-priority': String(input.priority),
        'apns-expiration': String(Math.floor(this.now() / 1000) + input.ttlSec),
        'apns-collapse-id': input.collapseId,
        'content-type': 'application/json',
      },
      body: input.payload,
    }, 2, this.now, budget);
    if (!r.replied) {
      this.log?.('apns.transport_error', { reason: r.reason });
      return { ok: false, status: 0, reason: r.reason, drop_token: false };
    }
    if (r.status === 200) return { ok: true };
    const reason = apnsReason(r.body, r.status);
    if (r.status === 403 && (reason === 'InvalidProviderToken' || reason === 'ExpiredProviderToken')) {
      this.jwt = null;
      this.log?.('apns.config_error', { status: r.status, reason });
    }
    const drop = (r.status === 410 && reason === 'Unregistered') || (r.status === 400 && reason === 'BadDeviceToken');
    return { ok: false, status: r.status, reason, drop_token: drop };
  }
}

// ---- FCM ----------------------------------------------------------------------------------------

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmInput {
  token: string;
  collapseKey: string;
  ttlSec: number;
  data: Record<string, string>;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ACCESS_TTL_MS = 55 * 60_000;
const ACCESS_SAFETY_SEC = 300;

/**
 * The bridge's `buildFcmEnvelope` (bridge/src/push/payloads.ts) plus `restricted_package_name`: the Firebase project
 * may host other Android apps, and a public relay must only ever reach the Remotly app's registrations.
 */
export function fcmEnvelope(token: string, collapseKey: string, ttlSec: number, data: Record<string, string>, packageName: string): object {
  return { message: { token, android: { priority: 'HIGH', ttl: `${ttlSec}s`, collapse_key: collapseKey, restricted_package_name: packageName }, data } };
}

function fcmError(body: string): { status: string | null; code: string | null; message: string } {
  const out = { status: null as string | null, code: null as string | null, message: '' };
  try {
    const e = (JSON.parse(body) as { error?: { status?: unknown; message?: unknown; details?: unknown } }).error;
    if (!e) return out;
    if (typeof e.status === 'string') out.status = e.status;
    if (typeof e.message === 'string') out.message = e.message;
    if (Array.isArray(e.details)) for (const d of e.details as { errorCode?: unknown }[]) if (typeof d?.errorCode === 'string') out.code = d.errorCode;
  } catch {
    // not JSON
  }
  return out;
}

export class FcmSender {
  private readonly projectId: string;
  private readonly packageName: string;
  private readonly sa: ServiceAccount;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: Deps['log'];
  private key: Promise<SigningKey> | null = null;
  private access: { token: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(projectId: string, packageName: string, sa: ServiceAccount, deps: Deps = {}) {
    this.projectId = projectId;
    this.packageName = packageName;
    this.sa = sa;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log;
  }

  /** Cached access token; concurrent callers share one in-flight exchange (bounded by the budget of whoever started it). */
  private accessToken(budget: Budget): Promise<string> {
    if (this.access && this.access.expires > this.now()) return Promise.resolve(this.access.token);
    this.pending ??= this.exchange(budget).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(budget: Budget): Promise<string> {
    const t = this.now();
    const key = await cached(() => this.key, (p) => (this.key = p), () => importSigningKey(this.sa.private_key, 'RS256'));
    const iat = Math.floor(t / 1000);
    const uri = this.sa.token_uri ?? TOKEN_URI;
    const assertion = await signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: this.sa.client_email, scope: FCM_SCOPE, aud: uri, iat, exp: iat + 3600 }, key, 'RS256');
    const r = await post(this.fetchImpl, uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
    }, 2, this.now, budget);
    if (!r.replied) throw Object.assign(new Error(r.reason), { status: 0 });
    if (r.status !== 200) throw Object.assign(new Error(`token exchange HTTP ${r.status}`), { status: r.status });
    const json = JSON.parse(r.body) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string') throw Object.assign(new Error('token exchange: no access_token'), { status: r.status });
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.access = { token: json.access_token, expires: t + Math.min(ACCESS_TTL_MS, Math.max(0, expiresIn - ACCESS_SAFETY_SEC) * 1000) };
    return json.access_token;
  }

  async send(input: FcmInput, budget: Budget): Promise<Result> {
    let bearer: string;
    try {
      bearer = await this.accessToken(budget);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      this.log?.(status >= 400 && status < 500 ? 'fcm.config_error' : 'fcm.transport_error', { stage: 'token_exchange', status, error: String((err as Error).message) });
      return { ok: false, status: 0, reason: 'token_exchange_failed', drop_token: false };
    }
    const r = await post(this.fetchImpl, `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(fcmEnvelope(input.token, input.collapseKey, input.ttlSec, input.data, this.packageName)),
    }, 1, this.now, budget);
    if (!r.replied) {
      this.log?.('fcm.transport_error', { stage: 'send', reason: r.reason });
      return { ok: false, status: 0, reason: r.reason, drop_token: false };
    }
    if (r.status >= 200 && r.status < 300) return { ok: true };
    const e = fcmError(r.body);
    const reason = e.code ?? e.status ?? `HTTP_${r.status}`;
    if (r.status === 401 || r.status === 403) {
      this.access = null;
      this.log?.('fcm.config_error', { stage: 'send', status: r.status, reason });
    }
    const drop =
      (r.status === 404 && (e.code === 'UNREGISTERED' || e.status === 'NOT_FOUND')) ||
      (r.status === 400 && e.status === 'INVALID_ARGUMENT' && /registration token/i.test(e.message));
    return { ok: false, status: r.status, reason, drop_token: drop };
  }
}
