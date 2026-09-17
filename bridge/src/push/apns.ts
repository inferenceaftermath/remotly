// APNs provider API over node:http2 (§6.6): ES256 provider JWT cached 50 min, one long-lived
// session per host, recreated after close/error, dropped after IDLE_MS without traffic (NATs and Apple drop idle
// connections silently, after which requests only time out), and every transport failure is retried once on a fresh
// session. Never logs device tokens or payload text.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { Logger } from '../log.ts';
import type { PushResult } from './types.ts';

export type ApnsEnv = 'sandbox' | 'production';

const HOSTS: Record<ApnsEnv, string> = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const JWT_TTL_MS = 50 * 60_000;
export const EXPIRATION_SEC = 600;
/** A Live Activity state older than this is worthless; let APNs drop it. */
export const ACTIVITY_EXPIRATION_SEC = 60;
const DEFAULT_TIMEOUT_MS = 10_000;
/** A session idle this long is destroyed; the next push opens a new one instead of hanging on a dead socket. */
const IDLE_MS = 4 * 60_000;

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function buildApnsJwt(opts: { teamId: string; keyId: string; key: crypto.KeyObject | string | Buffer; iat: number }): string {
  const key = opts.key instanceof crypto.KeyObject ? opts.key : crypto.createPrivateKey(opts.key);
  const data = `${b64url(JSON.stringify({ alg: 'ES256', kid: opts.keyId, typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: opts.teamId, iat: opts.iat }))}`;
  const sig = crypto.sign('sha256', Buffer.from(data, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

export interface ApnsClientOptions {
  teamId: string;
  keyId: string;
  /** Contents of the `.p8` file (PEM). */
  p8: string | Buffer;
  bundleId: string;
  log: Logger;
  now?: () => number;
  /** Test seam: supply a fake `ClientHttp2Session`. Default `http2.connect`. */
  connect?: (authority: string) => http2.ClientHttp2Session;
  requestTimeoutMs?: number;
}

export type ApnsPushType = 'alert' | 'liveactivity';

export interface ApnsSendInput {
  token: string;
  env: ApnsEnv;
  collapseId: string;
  payload: unknown;
  /** Default `alert`. `liveactivity` posts to the `<bundle>.push-type.liveactivity` topic. */
  pushType?: ApnsPushType;
  /** Default 10. Live Activity updates that need not wake the screen use 5. */
  priority?: 5 | 10;
}

interface Reply {
  status: number;
  body: string;
}

/** `{reason}` from an APNs error body; falls back to the status when the body is not JSON. */
function parseReason(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { reason?: unknown }).reason === 'string') {
      return (parsed as { reason: string }).reason;
    }
  } catch {
    // not JSON
  }
  return `HTTP_${status}`;
}

export class ApnsClient {
  private readonly teamId: string;
  private readonly keyId: string;
  private readonly key: crypto.KeyObject;
  private readonly bundleId: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly connect: (authority: string) => http2.ClientHttp2Session;
  private readonly timeoutMs: number;
  private jwt: { value: string; issuedAt: number } | null = null;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(opts: ApnsClientOptions) {
    this.teamId = opts.teamId;
    this.keyId = opts.keyId;
    this.key = crypto.createPrivateKey(opts.p8);
    this.bundleId = opts.bundleId;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.connect = opts.connect ?? ((authority) => http2.connect(authority));
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private bearer(): string {
    const t = this.now();
    if (!this.jwt || t - this.jwt.issuedAt >= JWT_TTL_MS) {
      this.jwt = { value: buildApnsJwt({ teamId: this.teamId, keyId: this.keyId, key: this.key, iat: Math.floor(t / 1000) }), issuedAt: t };
    }
    return this.jwt.value;
  }

  private session(host: string): http2.ClientHttp2Session {
    const live = this.sessions.get(host);
    if (live && !live.closed && !live.destroyed) return live;
    const s = this.connect(`https://${host}`);
    const forget = (): void => {
      if (this.sessions.get(host) === s) this.sessions.delete(host);
    };
    s.on('error', (err) => {
      this.log.warn('apns.session_error', { host, error: err });
      forget();
    });
    s.on('close', forget);
    s.setTimeout?.(IDLE_MS, () => {
      forget();
      s.destroy();
    });
    this.sessions.set(host, s);
    return s;
  }

  /** Forget and destroy the session for `host`: the next request connects anew. */
  private dropSession(host: string): void {
    const s = this.sessions.get(host);
    if (!s) return;
    this.sessions.delete(host);
    s.destroy();
  }

  private request(session: http2.ClientHttp2Session, headers: http2.OutgoingHttpHeaders, body: string): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const req = session.request(headers);
      const chunks: Buffer[] = [];
      let status = 0;
      let settled = false;
      const timer = setTimeout(() => {
        settle(() => reject(new Error('timeout')));
        req.close(http2.constants.NGHTTP2_CANCEL);
      }, this.timeoutMs);
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => settle(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') })));
      req.on('error', (err) => settle(() => reject(err)));
      req.end(body);
    });
  }

  async send(input: ApnsSendInput): Promise<PushResult> {
    const host = HOSTS[input.env];
    const pushType = input.pushType ?? 'alert';
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${input.token}`,
      authorization: `bearer ${this.bearer()}`,
      'apns-topic': pushType === 'liveactivity' ? `${this.bundleId}.push-type.liveactivity` : this.bundleId,
      'apns-push-type': pushType,
      'apns-priority': String(input.priority ?? 10),
      'apns-expiration': String(Math.floor(this.now() / 1000) + (pushType === 'liveactivity' ? ACTIVITY_EXPIRATION_SEC : EXPIRATION_SEC)),
      'apns-collapse-id': input.collapseId,
      'content-type': 'application/json',
    };
    const body = JSON.stringify(input.payload);
    let reply: Reply;
    try {
      reply = await this.request(this.session(host), headers, body);
    } catch (first) {
      // A timeout or socket error almost always means the long-lived session died quietly: retry once on a new one.
      this.dropSession(host);
      this.log.warn('apns.transport_error', { host, error: first, retry: true });
      try {
        reply = await this.request(this.session(host), headers, body);
      } catch (err) {
        this.dropSession(host);
        this.log.warn('apns.transport_error', { host, error: err, retry: false });
        const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message ?? 'transport_error';
        return { ok: false, status: 0, reason: String(code), dropToken: false };
      }
    }
    if (reply.status === 200) return { ok: true };
    const reason = parseReason(reply.body, reply.status);
    if (reply.status === 403 && (reason === 'InvalidProviderToken' || reason === 'ExpiredProviderToken')) {
      this.jwt = null;
      this.log.error('apns.config_error', { status: reply.status, reason, team_id: this.teamId, key_id: this.keyId });
    }
    const dropToken = (reply.status === 410 && reason === 'Unregistered') || (reply.status === 400 && reason === 'BadDeviceToken');
    return { ok: false, status: reply.status, reason, dropToken };
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
