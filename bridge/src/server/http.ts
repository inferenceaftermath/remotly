// HTTPS listener: POST /pair, GET /health, WebSocket upgrade at /ws. Route logic lives in
// `createHandlers` so tests drive it over plain node:http without certificates.
import type http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DeviceStore, Platform } from '../auth/devices.ts';
import type { FlowConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import { execFile, normalizeIp, tailscaleIp4, type ExecFn } from '../tailscale.ts';
import type { PairingManager } from './pairing.ts';
import type { TlsMaterial } from './tls.ts';
import { uploadType, type UploadStore } from './uploads.ts';

export const MAX_BODY_BYTES = 16 * 1024;
export const IDLE_TIMEOUT_MS = 45_000;
export const PROTOCOL_VERSION = 1;
/** Request headers must arrive within this long. */
export const HEADERS_TIMEOUT_MS = 15_000;
/** Deadline for a whole request; `requestTimeoutFor` stretches it for photo uploads (`uploads.max_mb`). */
export const REQUEST_TIMEOUT_MS = 120_000;
/** A body that delivers nothing for this long is dropped (408) — a stalled upload would otherwise hold its socket until the deadline. */
export const BODY_STALL_MS = 30_000;
/** The slowest upload the deadline allows for: below this rate a phone hits `requestTimeout` before its photo is through. */
export const MIN_UPLOAD_BYTES_PER_SEC = 32 * 1024;
/**
 * How often Node looks for requests past `headersTimeout` / `requestTimeout` (its default is 30 s, which would let
 * half-sent headers live up to 45 s). The header and request ceilings are enforced within this much of their value.
 */
export const CONNECTIONS_CHECK_MS = 1_000;

/**
 * The request deadline that lets a `maxUploadBytes` upload through at `MIN_UPLOAD_BYTES_PER_SEC` after the header
 * allowance (`HEADERS_TIMEOUT_MS` plus one sweep), never below `REQUEST_TIMEOUT_MS`.
 */
export function requestTimeoutFor(maxUploadBytes: number): number {
  return Math.max(REQUEST_TIMEOUT_MS, Math.ceil(maxUploadBytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000 + HEADERS_TIMEOUT_MS + CONNECTIONS_CHECK_MS);
}

/**
 * What a route may spend after the headers are in so that the whole request — headers (at most `HEADERS_TIMEOUT_MS`,
 * enforced within one sweep) plus body — stays within `totalMs`. The handler only sees the request once the headers are
 * complete, so the header allowance is subtracted rather than measured.
 */
export function routeBudgetFor(totalMs: number): number {
  return totalMs - HEADERS_TIMEOUT_MS - CONNECTIONS_CHECK_MS;
}

/** Node's per-request deadlines on the listener (`https.Server` is an `http.Server` underneath). */
export function applyTimeouts(server: Pick<http.Server, 'headersTimeout' | 'requestTimeout'>, maxUploadBytes: number): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = requestTimeoutFor(maxUploadBytes);
}

/** The listener's options: TLS material plus the sweep interval that makes `applyTimeouts` bite on time. */
export function serverOptions(tls: Pick<TlsMaterial, 'key' | 'cert'>): https.ServerOptions {
  return { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', connectionsCheckingInterval: CONNECTIONS_CHECK_MS };
}

/** Ceilings that keep one misbehaving peer (or a LAN full of them) from exhausting the bridge. */
export interface HttpLimits {
  /** Open WebSockets per peer address; further upgrades from it get 429 until one closes. */
  maxClientsPerIp: number;
  /** Open WebSockets in total; further upgrades get 503. */
  maxClients: number;
  /** `POST /pair` requests past the gate, per minute, for the whole bridge; further ones get 429 `locked_out` with `retry_after_ms`. */
  pairPerMinute: number;
}
export const DEFAULT_LIMITS: HttpLimits = { maxClientsPerIp: 8, maxClients: 64, pairPerMinute: 30 };

export interface HttpHandlerDeps {
  config: FlowConfig;
  devices: DeviceStore;
  pairing: PairingManager;
  /** Tailnet gate; runs before /pair and before the WebSocket upgrade. */
  gate: (remoteIp: string) => Promise<boolean>;
  onWebSocket: (ws: WebSocket, remoteIp: string) => void;
  log: Logger;
  herdrState: () => 'up' | 'down';
  version: string;
  hostName: string;
  /** Sockets silent for this long are terminated (client pings every 15 s). */
  idleMs?: number;
  /** Photo drop for `POST /upload`; without it the route is 404. */
  uploads?: UploadStore;
  limits?: Partial<HttpLimits>;
  now?: () => number;
  /** Silence on a request body before it is dropped; default `BODY_STALL_MS`. */
  bodyStallMs?: number;
  /**
   * Whole-request budgets per route, counted from the request's arrival (the tailnet gate's `tailscale` calls included);
   * defaults `REQUEST_TIMEOUT_MS` for `/pair` and `requestTimeoutFor(uploads.maxBytes)` for `/upload`. The upload-sized
   * server deadline must not stretch `/pair`.
   */
  bodyMaxMs?: Partial<{ pair: number; upload: number }>;
}

export interface HttpHandlers {
  onRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
  onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  clientCount(): number;
  /** Close every WebSocket (1001 going away). */
  closeClients(): void;
}

/** `close: true` answers with `Connection: close`, so Node drops the socket once the reply is out (a body was left unread). */
function sendJson(res: http.ServerResponse, status: number, body: unknown, opts: { close?: boolean } = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(opts.close ? { connection: 'close' } : {}),
  });
  res.end(text);
}

type BodyStatus = 400 | 408 | 413;
type RawBodyResult = { ok: true; value: Buffer } | { ok: false; status: BodyStatus };

interface BodyDeadlines {
  /** Silence before the body is dropped. */
  stallMs: number;
  /** The whole body must be in by then, however steadily it trickles: the server-wide `requestTimeout` is sized for photo uploads. */
  maxMs: number;
  /**
   * Time the request had already spent (tailnet gate, authentication) before the reader was attached. The first stall
   * window is shortened by it, and bytes that were waiting in the stream meanwhile count as having arrived with the
   * request — they do not renew the window. So "silent for `stallMs`" is measured from the request, not from the gate.
   */
  sinceMs?: number;
}

/** Whole body up to `limit` bytes; 413 past it, 408 when nothing arrives for `stallMs` or the body is not complete after `maxMs`, 400 on a broken request. */
function readRawBody(req: http.IncomingMessage, limit: number, deadlines: BodyDeadlines): Promise<RawBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let stall: NodeJS.Timeout | null = null;
    const giveUp = () => {
      req.removeAllListeners('data');
      finish({ ok: false, status: 408 });
    };
    const deadline = setTimeout(giveUp, deadlines.maxMs);
    const finish = (r: RawBodyResult) => {
      if (done) return;
      done = true;
      if (stall) clearTimeout(stall);
      clearTimeout(deadline);
      resolve(r);
    };
    const arm = (ms = deadlines.stallMs) => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(giveUp, ms);
    };
    // Chunks already buffered are delivered on the next tick, before this immediate: they are what the peer sent while
    // the request waited, so they keep the shortened first window; only bytes arriving after it renew the window. (The
    // stream buffers 16 KiB before it stops reading the socket, so a peer that sent more than that while waiting sees
    // the rest arrive live once reading resumes — the window it buys that way is bounded by the wait itself.)
    let settling = true;
    setImmediate(() => {
      settling = false;
    });
    arm(Math.max(1, deadlines.stallMs - (deadlines.sinceMs ?? 0)));
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        return finish({ ok: false, status: 413 });
      }
      chunks.push(chunk);
      if (!settling) arm();
    });
    req.on('end', () => finish({ ok: true, value: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: BodyStatus };

async function readJsonBody(req: http.IncomingMessage, limit: number, deadlines: BodyDeadlines): Promise<BodyResult> {
  const raw = await readRawBody(req, limit, deadlines);
  if (!raw.ok) return raw;
  try {
    return { ok: true, value: JSON.parse(raw.value.toString('utf8')) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function bodyError(status: BodyStatus, extra: Record<string, unknown> = {}): { error: string } & Record<string, unknown> {
  return { error: status === 413 ? 'too_large' : status === 408 ? 'timeout' : 'bad_request', ...(status === 413 ? extra : {}) };
}

interface PairRequest {
  code: string;
  device: { name: string; platform: Platform; app_version: string };
}

export function parsePairBody(body: unknown): PairRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const code = b['code'];
  const device = b['device'];
  if (typeof code !== 'string' || code.length === 0 || code.length > 32) return null;
  if (typeof device !== 'object' || device === null) return null;
  const d = device as Record<string, unknown>;
  const name = typeof d['name'] === 'string' ? d['name'].trim() : '';
  const platform = d['platform'];
  const appVersion = d['app_version'] === undefined ? '' : d['app_version'];
  if (name.length === 0 || name.length > 64) return null;
  if (platform !== 'ios' && platform !== 'android') return null;
  if (typeof appVersion !== 'string' || appVersion.length > 32) return null;
  return { code, device: { name, platform, app_version: appVersion } };
}

export function createHandlers(deps: HttpHandlerDeps): HttpHandlers {
  const { log } = deps;
  const idleMs = deps.idleMs ?? IDLE_TIMEOUT_MS;
  const limits: HttpLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const stallMs = deps.bodyStallMs ?? BODY_STALL_MS;
  // Route budgets run from the moment the headers are complete (when Node hands the request over) and leave the header
  // allowance out of the whole-request ceiling: 120 s = 15 s headers + 1 s sweep + 104 s route; uploads get their bytes
  // at MIN_UPLOAD_BYTES_PER_SEC on top. The test knobs set the route budgets directly.
  const pairBudgetMs = deps.bodyMaxMs?.pair ?? routeBudgetFor(REQUEST_TIMEOUT_MS);
  const uploadBudgetMs = (maxBytes: number): number => deps.bodyMaxMs?.upload ?? routeBudgetFor(requestTimeoutFor(maxBytes));
  /**
   * What is left of a route's budget for the body once the checks before it (gate, auth) have run; `null` when nothing is:
   * a body that arrived in full while the gate was deciding would otherwise be read (its buffered `data`/`end` events run
   * before any timer), and an expired request must get its 408 whatever the buffer holds. The stall clock is handed the
   * elapsed time too, so silence is counted from the request, not from the gate's answer.
   */
  const remaining = (arrivedAt: number, budgetMs: number): BodyDeadlines | null => {
    const elapsed = Date.now() - arrivedAt;
    const left = budgetMs - elapsed;
    return left > 0 ? { stallMs, maxMs: left, sinceMs: elapsed } : null;
  };
  const expired = (req: http.IncomingMessage, res: http.ServerResponse, extra: Record<string, unknown> = {}): void => {
    req.resume();
    sendJson(res, 408, bodyError(408, extra), { close: true });
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  // WebSocket slots are reserved before the (asynchronous) gate so concurrent upgrades cannot overshoot the caps, and
  // released when the raw socket closes — which covers a refused gate, a failed handshake and a normal close alike.
  const perIp = new Map<string, number>();
  let clients = 0;
  const reserve = (ip: string): 'ok' | 'ip' | 'total' => {
    const n = perIp.get(ip) ?? 0;
    if (n >= limits.maxClientsPerIp) return 'ip'; // the more specific answer when both ceilings are hit
    if (clients >= limits.maxClients) return 'total';
    clients += 1;
    perIp.set(ip, n + 1);
    return 'ok';
  };
  const release = (ip: string): void => {
    clients -= 1;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };

  // One fixed window of pairing attempts for the whole bridge; the per-address lockout lives in PairingManager.
  let pairWindowStart = 0;
  let pairAttempts = 0;
  /** Counts this attempt; `null` when it is within budget, else how long until the window renews. */
  const pairBudget = (): number | null => {
    const t = now();
    if (t - pairWindowStart >= 60_000) {
      pairWindowStart = t;
      pairAttempts = 0;
    }
    if (pairAttempts >= limits.pairPerMinute) return 60_000 - (t - pairWindowStart);
    pairAttempts += 1;
    return null;
  };

  const handlePair = async (req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> => {
    const arrivedAt = Date.now(); // the route budget is the request's, not the body's: a slow gate decision comes out of it
    if (!(await deps.gate(ip))) return sendJson(res, 403, { error: 'forbidden' });
    const retryAfterMs = pairBudget();
    if (retryAfterMs !== null) {
      log.warn('pair.busy', { ip, per_minute: limits.pairPerMinute });
      return sendJson(res, 429, { error: 'locked_out', retry_after_ms: retryAfterMs });
    }
    const deadlines = remaining(arrivedAt, pairBudgetMs);
    if (!deadlines) return expired(req, res);
    const body = await readJsonBody(req, MAX_BODY_BYTES, deadlines);
    if (!body.ok) return sendJson(res, body.status, bodyError(body.status), { close: body.status === 408 });
    const pair = parsePairBody(body.value);
    if (!pair) return sendJson(res, 400, { error: 'bad_request' });
    const outcome = deps.pairing.redeem(pair.code, ip);
    if (outcome === 'locked_out') {
      log.warn('pair.locked_out', { ip });
      return sendJson(res, 429, { error: 'locked_out', retry_after_ms: deps.pairing.lockoutRemainingMs(ip) });
    }
    if (outcome === 'bad_code') {
      log.warn('pair.bad_code', { ip });
      return sendJson(res, 403, { error: 'bad_code' });
    }
    const { token, device } = deps.devices.issueToken({ name: pair.device.name, platform: pair.device.platform });
    log.info('pair.ok', { device_id: device.id, platform: device.platform, app_version: pair.device.app_version, ip });
    sendJson(res, 200, { token, device_id: device.id, host_name: deps.hostName });
  };

  /** A photo from a paired phone → file under the upload dir; the app puts the returned path into its next prompt. */
  const handleUpload = async (req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> => {
    const arrivedAt = Date.now();
    const uploads = deps.uploads;
    if (!uploads) return sendJson(res, 404, { error: 'not_found' });
    if (!(await deps.gate(ip))) return sendJson(res, 403, { error: 'forbidden' });
    const auth = req.headers.authorization ?? '';
    const device = deps.devices.authenticate(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (!device) {
      log.warn('upload.auth_failed', { ip });
      return sendJson(res, 401, { error: 'auth' });
    }
    const type = uploadType(req.headers['content-type']);
    if (!type) return sendJson(res, 415, { error: 'unsupported_type' });
    if (Number(req.headers['content-length'] ?? 0) > uploads.maxBytes) {
      req.resume();
      return sendJson(res, 413, { error: 'too_large', max_bytes: uploads.maxBytes });
    }
    const deadlines = remaining(arrivedAt, uploadBudgetMs(uploads.maxBytes));
    if (!deadlines) return expired(req, res, { max_bytes: uploads.maxBytes });
    const body = await readRawBody(req, uploads.maxBytes, deadlines);
    if (!body.ok) return sendJson(res, body.status, bodyError(body.status, { max_bytes: uploads.maxBytes }), { close: body.status === 408 });
    if (body.value.length === 0) return sendJson(res, 400, { error: 'bad_request' });
    const saved = await uploads.save(body.value, type);
    log.info('upload.saved', { device_id: device.id, type, bytes: saved.bytes, path: saved.path });
    sendJson(res, 200, { path: saved.path, bytes: saved.bytes });
  };

  const onRequest: HttpHandlers['onRequest'] = (req, res) => {
    const ip = normalizeIp(req.socket.remoteAddress);
    const pathname = new URL(req.url ?? '/', 'http://flow.invalid').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, herdr: deps.herdrState(), version: deps.version, protocol: PROTOCOL_VERSION });
    }
    if (req.method === 'POST' && pathname === '/pair') {
      handlePair(req, res, ip).catch((err) => {
        log.error('pair.failed', { error: err });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/upload') {
      handleUpload(req, res, ip).catch((err) => {
        log.error('upload.failed', { error: err });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  };

  const onUpgrade: HttpHandlers['onUpgrade'] = (req, socket, head) => {
    const ip = normalizeIp(req.socket.remoteAddress);
    const pathname = new URL(req.url ?? '/', 'http://flow.invalid').pathname;
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (pathname !== '/ws') return reject(404, 'Not Found');
    socket.on('error', () => {});
    const slot = reserve(ip);
    if (slot !== 'ok') {
      log.warn('ws.refused', { ip, reason: slot === 'ip' ? 'max_clients_per_ip' : 'max_clients', open: clients });
      return slot === 'ip' ? reject(429, 'Too Many Requests') : reject(503, 'Service Unavailable');
    }
    socket.once('close', () => release(ip));
    deps
      .gate(ip)
      .then((allowed) => {
        if (!allowed) return reject(403, 'Forbidden');
        wss.handleUpgrade(req, socket, head, (ws) => {
          armIdle(ws, idleMs);
          log.debug('ws.open', { ip });
          deps.onWebSocket(ws, ip);
        });
      })
      .catch((err) => {
        log.error('ws.upgrade_failed', { error: err });
        reject(500, 'Internal Server Error');
      });
  };

  return {
    onRequest,
    onUpgrade,
    clientCount: () => wss.clients.size,
    closeClients: () => {
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    },
  };
}

/** Any frame (data, ping, pong) counts as liveness; silence for `idleMs` → terminate. */
function armIdle(ws: WebSocket, idleMs: number): void {
  let timer = setTimeout(() => ws.terminate(), idleMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ws.terminate(), idleMs);
  };
  ws.on('message', bump);
  ws.on('ping', bump);
  ws.on('pong', bump);
  ws.on('close', () => clearTimeout(timer));
}

/** `listen.host: 'auto'` → Tailscale IPv4 when tailscale is up, else every interface (LAN mode). */
/**
 * `listen.host: auto` → the Tailscale IPv4, or every interface when there is none. With `tailscaleUp` (serve saw Tailscale
 * up at start-up) a missing address is an error instead: the every-interface fallback is for hosts without Tailscale, not
 * for a Tailscale that went away in the seconds since the start-up check.
 */
export async function resolveListenHost(config: FlowConfig, exec: ExecFn = execFile, opts: { tailscaleUp?: boolean } = {}): Promise<string> {
  if (config.listen.host !== 'auto') return config.listen.host;
  const ip = await tailscaleIp4(exec);
  if (ip) return ip;
  if (opts.tailscaleUp) throw new Error('listen.host is "auto" and Tailscale was up at start-up, but `tailscale ip -4` gave no address now; not falling back to every interface. Exiting so systemd retries.');
  return '0.0.0.0';
}

export interface HttpServer {
  address: string;
  port: number;
  clientCount(): number;
  /** Swap certificates after a renewal without dropping connections. */
  setTls(material: TlsMaterial): void;
  close(): Promise<void>;
}

export async function startHttpServer(opts: HttpHandlerDeps & { tls: TlsMaterial; exec?: ExecFn; tailscaleUp?: boolean }): Promise<HttpServer> {
  const handlers = createHandlers(opts);
  const host = await resolveListenHost(opts.config, opts.exec, { tailscaleUp: opts.tailscaleUp ?? false });
  const server = https.createServer(serverOptions(opts.tls), handlers.onRequest);
  server.on('upgrade', handlers.onUpgrade);
  // A peer that opens a connection and then trickles (or never sends) a request holds a socket otherwise for as long as it likes.
  applyTimeouts(server, opts.uploads?.maxBytes ?? MAX_BODY_BYTES);
  // Failed handshakes are otherwise silent; a phone that rejects the certificate shows up here as a
  // TLS alert (e.g. "unknown ca" / "certificate unknown") from its Tailscale IP.
  server.on('tlsClientError', (err, socket) => {
    opts.log.warn('tls.client_error', { remote: socket.remoteAddress ?? null, error: err.message });
  });
  server.on('clientError', (err, socket) => {
    opts.log.warn('http.client_error', { remote: (socket as import('node:net').Socket).remoteAddress ?? null, error: err.message });
    if (!socket.destroyed) socket.destroy();
  });
  server.on('secureConnection', (socket) => {
    opts.log.debug('tls.handshake_ok', { remote: socket.remoteAddress ?? null, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name ?? null });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.config.listen.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? { address: addr.address, port: addr.port } : { address: host, port: opts.config.listen.port };
  opts.log.info('http.listening', { address: bound.address, port: bound.port, tls: opts.tls.mode });
  return {
    ...bound,
    clientCount: handlers.clientCount,
    setTls: (m) => server.setSecureContext({ key: m.key, cert: m.cert }),
    close: () =>
      new Promise<void>((resolve) => {
        handlers.closeClients();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
