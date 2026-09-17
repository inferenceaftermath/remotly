// FCM HTTP v1 (§6.6): service-account RS256 JWT → OAuth2 access token (cached), data-only
// high-priority messages. Uses global fetch; tests inject `fetchImpl`.
import crypto from 'node:crypto';
import type { Logger } from '../log.ts';
import { buildFcmEnvelope } from './payloads.ts';
import type { PushResult } from './types.ts';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TTL_MS = 55 * 60_000;
const TOKEN_SAFETY_SEC = 300;
const REQUEST_TIMEOUT_MS = 10_000;

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function buildServiceAccountJwt(sa: ServiceAccount, iat: number): string {
  const claims = { iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URI, iat, exp: iat + 3600 };
  const data = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('sha256', Buffer.from(data, 'utf8'), sa.private_key);
  return `${data}.${sig.toString('base64url')}`;
}

export interface FcmClientOptions {
  projectId: string;
  serviceAccount: ServiceAccount;
  log: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface FcmSendInput {
  token: string;
  collapseKey: string;
  ttlSec: number;
  data: Record<string, string>;
}

interface FcmError {
  status: string | null;
  /** `details[].errorCode` from the FcmError detail (`UNREGISTERED`, …). */
  code: string | null;
  message: string;
}

function parseError(body: string): FcmError {
  const out: FcmError = { status: null, code: null, message: '' };
  try {
    const e = (JSON.parse(body) as { error?: { status?: unknown; message?: unknown; details?: unknown } }).error;
    if (!e) return out;
    if (typeof e.status === 'string') out.status = e.status;
    if (typeof e.message === 'string') out.message = e.message;
    if (Array.isArray(e.details)) {
      for (const d of e.details as { errorCode?: unknown }[]) if (typeof d?.errorCode === 'string') out.code = d.errorCode;
    }
  } catch {
    // not JSON
  }
  return out;
}

class ExchangeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ExchangeError';
    this.status = status;
  }
}

export class FcmClient {
  private readonly projectId: string;
  private readonly sa: ServiceAccount;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private access: { token: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(opts: FcmClientOptions) {
    this.projectId = opts.projectId;
    this.sa = opts.serviceAccount;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Cached access token; concurrent callers share one in-flight exchange. */
  private accessToken(): Promise<string> {
    if (this.access && this.access.expires > this.now()) return Promise.resolve(this.access.token);
    if (!this.pending) {
      this.pending = this.exchange().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const t = this.now();
    const assertion = buildServiceAccountJwt(this.sa, Math.floor(t / 1000));
    const res = await this.fetchImpl(this.sa.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new ExchangeError(res.status, `token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string') throw new ExchangeError(res.status, 'token exchange: no access_token in response');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    const ttl = Math.min(TOKEN_TTL_MS, Math.max(0, expiresIn - TOKEN_SAFETY_SEC) * 1000);
    this.access = { token: json.access_token, expires: t + ttl };
    return json.access_token;
  }

  async send(input: FcmSendInput): Promise<PushResult> {
    let bearer: string;
    try {
      bearer = await this.accessToken();
    } catch (err) {
      const status = err instanceof ExchangeError ? err.status : 0;
      if (status >= 400 && status < 500) this.log.error('fcm.config_error', { stage: 'token_exchange', status, error: err });
      else this.log.warn('fcm.transport_error', { stage: 'token_exchange', error: err });
      return { ok: false, status: 0, reason: 'token_exchange_failed', dropToken: false };
    }
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildFcmEnvelope(input.token, input.collapseKey, input.ttlSec, input.data)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      this.log.warn('fcm.transport_error', { stage: 'send', error: err });
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name ?? 'transport_error';
      return { ok: false, status: 0, reason: String(code), dropToken: false };
    }
    if (res.ok) return { ok: true };
    const e = parseError(text);
    const reason = e.code ?? e.status ?? `HTTP_${res.status}`;
    if (res.status === 401 || res.status === 403) {
      this.access = null;
      this.log.error('fcm.config_error', { stage: 'send', status: res.status, reason, project_id: this.projectId });
    }
    const dropToken =
      (res.status === 404 && (e.code === 'UNREGISTERED' || e.status === 'NOT_FOUND')) ||
      (res.status === 400 && e.status === 'INVALID_ARGUMENT' && /registration token/i.test(e.message));
    return { ok: false, status: res.status, reason, dropToken };
  }

  close(): void {
    this.access = null;
  }
}
