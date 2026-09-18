// Local control channel (`<configDir>/remotly.sock`, mode 0600, NDJSON): the CLI's pair / devices /
// status / push-test talk to the live daemon instead of touching its files.
import fs from 'node:fs';
import net from 'node:net';
import { statePath } from './config.ts';
import type { Logger } from './log.ts';

export interface PairInfo {
  code: string;
  expires_at: string;
  /** True when the code pairs any number of devices until it expires (`setup`); absent from older daemons. */
  reusable?: boolean;
  url: string;
  fingerprint?: string;
  host_name: string;
  qr_payload: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  created_at: string;
  last_seen: string | null;
  push: boolean;
}

export interface ControlStatus {
  /** The daemon's pid, so `setup` can tell the unit it just restarted from another instance on the same socket. */
  pid?: number;
  /** The daemon's version, so `update` can tell a bridge still running the code from before an unfinished update. Absent before 0.2.0. */
  version?: string;
  herdr: 'up' | 'down';
  listen: { host: string; port: number } | null;
  tls: { mode: 'tailscale' | 'selfsigned'; not_after: string; fingerprint?: string };
  devices: number;
  push: { apns: boolean; fcm: boolean; mode: { apns: PushMode; fcm: PushMode } };
  clients: number;
}

/** How a platform's notifications leave the host: with local credentials, through the relay, or not at all. */
export type PushMode = 'direct' | 'relay' | 'off';

/** Implemented by the daemon; every method may be sync or async. */
export interface ControlHandlers {
  pair(ttlSec: number | undefined, reusable: boolean): PairInfo | Promise<PairInfo>;
  devices(): DeviceSummary[] | Promise<DeviceSummary[]>;
  revoke(id: string): boolean | Promise<boolean>;
  status(): ControlStatus | Promise<ControlStatus>;
  pushTest(id: string): unknown;
}

export type ControlRequest =
  | { cmd: 'pair'; ttl?: number; reusable?: boolean }
  | { cmd: 'devices' }
  | { cmd: 'revoke'; id: string }
  | { cmd: 'status' }
  | { cmd: 'push-test'; id: string };

export type ControlResponse = { ok: true; result: unknown } | { ok: false; error: string; message: string };

export class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

export function controlSocketPath(): string {
  return statePath('remotly.sock');
}

const MAX_LINE_BYTES = 64 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate one request line and run the matching handler. */
export async function dispatch(handlers: ControlHandlers, raw: unknown): Promise<ControlResponse> {
  if (!isRecord(raw) || typeof raw['cmd'] !== 'string') return { ok: false, error: 'bad_request', message: 'expected {"cmd": ...}' };
  const idOf = (): string => {
    const id = raw['id'];
    if (typeof id !== 'string' || id.length === 0) throw new ControlError('bad_request', '"id" is required');
    return id;
  };
  try {
    switch (raw['cmd']) {
      case 'pair': {
        const ttl = raw['ttl'];
        if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 10 || ttl > 3600)) {
          throw new ControlError('bad_request', '"ttl" must be an integer 10-3600 seconds');
        }
        const reusable = raw['reusable'];
        if (reusable !== undefined && typeof reusable !== 'boolean') throw new ControlError('bad_request', '"reusable" must be true or false');
        return { ok: true, result: await handlers.pair(ttl, reusable ?? false) };
      }
      case 'devices':
        return { ok: true, result: await handlers.devices() };
      case 'revoke': {
        const id = idOf();
        const revoked = await handlers.revoke(id);
        if (!revoked) throw new ControlError('not_found', `no device with id ${id}`);
        return { ok: true, result: { revoked: true, id } };
      }
      case 'status':
        return { ok: true, result: await handlers.status() };
      case 'push-test':
        return { ok: true, result: await handlers.pushTest(idOf()) };
      default:
        return { ok: false, error: 'unknown_cmd', message: `unknown cmd ${JSON.stringify(raw['cmd'])}` };
    }
  } catch (err) {
    if (err instanceof ControlError) return { ok: false, error: err.code, message: err.message };
    return { ok: false, error: 'internal', message: (err as Error).message };
  }
}

/** Remove a socket file nobody is listening on (previous daemon crashed). Throws if one is live. */
async function reclaimSocket(path: string): Promise<void> {
  if (!fs.existsSync(path)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`another remotly-bridge is already listening on ${path}`);
  fs.unlinkSync(path);
}

export async function startControlServer(
  handlers: ControlHandlers,
  opts: { socketPath?: string; log?: Logger } = {},
): Promise<{ path: string; close(): Promise<void> }> {
  const path = opts.socketPath ?? controlSocketPath();
  await reclaimSocket(path);
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) return socket.destroy();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ ok: false, error: 'bad_request', message: 'invalid JSON' } satisfies ControlResponse) + '\n');
          continue;
        }
        void dispatch(handlers, parsed).then((resp) => {
          if (!socket.destroyed) socket.write(JSON.stringify(resp) + '\n');
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(path, 0o600);
  opts.log?.info('control.listening', { path });
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(path);
          } catch {
            /* already gone */
          }
          resolve();
        });
      }),
  };
}

/** CLI side: one request, one response line. Throws ControlError for daemon-side errors. */
export function controlRequest<T = unknown>(req: ControlRequest, opts: { socketPath?: string; timeoutMs?: number } = {}): Promise<T> {
  const path = opts.socketPath ?? controlSocketPath();
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      socket.destroy();
    };
    const timer = setTimeout(() => finish(() => reject(new ControlError('timeout', `daemon did not answer within ${opts.timeoutMs ?? 15_000} ms`))), opts.timeoutMs ?? 15_000);
    socket.once('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      let resp: ControlResponse;
      try {
        resp = JSON.parse(buffer.slice(0, nl)) as ControlResponse;
      } catch {
        return finish(() => reject(new ControlError('bad_response', 'daemon sent a non-JSON line')));
      }
      finish(() => (resp.ok ? resolve(resp.result as T) : reject(new ControlError(resp.error, resp.message))));
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? `remotly-bridge daemon is not running (no control socket at ${path})` : err.message;
      finish(() => reject(new ControlError('unreachable', hint)));
    });
    socket.on('close', () => finish(() => reject(new ControlError('closed', 'daemon closed the connection without answering'))));
  });
}
