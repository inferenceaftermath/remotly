// Relay transport (relay/README.md): for a platform without local credentials the bridge posts the same inputs
// `ApnsClient.send` / `FcmClient.send` take to `<relay_url>/v1/push`; the relay holds the app's APNs key and
// Firebase service account and answers with the result it got from Apple or Google, so `Notifier` sees the same
// `PushResult` either way (including `dropToken`). Never logs device tokens or payload text.
import type { Logger } from '../log.ts';
import { ACTIVITY_EXPIRATION_SEC, EXPIRATION_SEC, type ApnsClient, type ApnsSendInput } from './apns.ts';
import type { FcmClient, FcmSendInput } from './fcm.ts';
import type { PushResult } from './types.ts';

export interface RelayClientOptions {
  /** Base URL, no trailing slash (config `push.relay_url`). */
  url: string;
  log: Logger;
  /** Bridge version for the `user-agent`. */
  version: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * Longer than the relay's whole upstream budget (20 s, `relay/src/relay.ts` RELAY_DEADLINE_MS) plus transit, so the
 * bridge always learns the real outcome and never treats a delivered push as failed (a Live Activity `end` would be
 * retried on top of the one that landed).
 */
const DEFAULT_TIMEOUT_MS = 25_000;

/** Wire body of `POST /v1/push` (relay/src/relay.ts `parsePush`). */
export type RelayPush =
  | { platform: 'ios'; token: string; env: 'production' | 'sandbox'; collapse_id: string; push_type: 'alert' | 'liveactivity'; priority: 5 | 10; ttl_sec: number; payload: unknown }
  | { platform: 'android'; token: string; collapse_key: string; ttl_sec: number; data: Record<string, string> };

export function relayApnsBody(input: ApnsSendInput): RelayPush {
  const pushType = input.pushType ?? 'alert';
  return {
    platform: 'ios',
    token: input.token,
    env: input.env,
    collapse_id: input.collapseId,
    push_type: pushType,
    priority: input.priority ?? 10,
    ttl_sec: pushType === 'liveactivity' ? ACTIVITY_EXPIRATION_SEC : EXPIRATION_SEC,
    payload: input.payload,
  };
}

export function relayFcmBody(input: FcmSendInput): RelayPush {
  return { platform: 'android', token: input.token, collapse_key: input.collapseKey, ttl_sec: input.ttlSec, data: input.data };
}

function isResult(v: unknown): v is { ok: true } | { ok: false; status: number; reason: string; drop_token: boolean } {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['ok'] === true) return true;
  return r['ok'] === false && typeof r['status'] === 'number' && typeof r['reason'] === 'string' && typeof r['drop_token'] === 'boolean';
}

export class RelayClient {
  private readonly url: string;
  private readonly log: Logger;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RelayClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.log = opts.log;
    this.version = opts.version;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Drop-in for `ApnsClient` in `NotifierDeps`. */
  apns(): Pick<ApnsClient, 'send' | 'close'> {
    return { send: (input) => this.post(relayApnsBody(input)), close: () => undefined };
  }

  /** Drop-in for `FcmClient` in `NotifierDeps`. */
  fcm(): Pick<FcmClient, 'send' | 'close'> {
    return { send: (input) => this.post(relayFcmBody(input)), close: () => undefined };
  }

  /** `GET /health` → which platforms the relay can serve; `null` when unreachable or not a relay. */
  async health(): Promise<{ apns: boolean; fcm: boolean; version: string } | null> {
    try {
      const res = await this.fetchImpl(`${this.url}/health`, { headers: { 'user-agent': `remotly-bridge/${this.version}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      const j = (await res.json()) as { ok?: unknown; apns?: unknown; fcm?: unknown; version?: unknown };
      if (j.ok !== true || typeof j.apns !== 'boolean' || typeof j.fcm !== 'boolean') return null;
      return { apns: j.apns, fcm: j.fcm, version: typeof j.version === 'string' ? j.version : '?' };
    } catch {
      return null;
    }
  }

  private async post(body: RelayPush): Promise<PushResult> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `remotly-bridge/${this.version}` },
      body: JSON.stringify(body),
      // The configured URL is https; a redirect could re-post the token and text elsewhere (307/308 keep the body).
      redirect: 'error',
    };
    // Exactly one attempt: a push is not idempotent and the relay already retries a failed connection upstream
    // (APNs) or deliberately does not (FCM, like the direct client). A lost reply is reported, never re-sent.
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.url}/v1/push`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'transport_error';
      this.log.warn('relay.transport_error', { platform: body.platform, error: String(code) });
      return { ok: false, status: 0, reason: 'relay_unreachable', dropToken: false };
    }
    try {
      text = await res.text();
    } catch (err) {
      this.log.warn('relay.transport_error', { platform: body.platform, status: res.status, error: String((err as Error)?.name ?? 'body_error') });
      return { ok: false, status: 0, reason: 'relay_bad_response', dropToken: false };
    }
    if (res.status !== 200) {
      let error = `HTTP_${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === 'string') error = j.error;
      } catch {
        // not JSON
      }
      const fields = { platform: body.platform, status: res.status, error };
      // Diagnose from the relay's own error word, not the status: 503 also covers its fail-closed rate limiter.
      if (error === 'not_configured') this.log.error('relay.not_configured', fields);
      else if (error === 'rate_limiter_unavailable' || res.status >= 500) this.log.warn('relay.unavailable', fields);
      else this.log.warn('relay.rejected', fields);
      return { ok: false, status: 0, reason: `relay_${error}`, dropToken: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isResult(parsed)) {
      this.log.warn('relay.rejected', { platform: body.platform, status: 200, error: 'bad_response' });
      return { ok: false, status: 0, reason: 'relay_bad_response', dropToken: false };
    }
    if (parsed.ok) return { ok: true };
    return { ok: false, status: parsed.status, reason: parsed.reason, dropToken: parsed.drop_token };
  }
}
