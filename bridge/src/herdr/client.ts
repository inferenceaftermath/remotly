import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HerdrErrorBody, HerdrEvent, Subscription } from './types.ts';

/**
 * herdr socket API connection model (measured in M0 against herdr 0.8.0 / protocol 19):
 *  - one request per Unix-socket connection; the server answers a single line and closes;
 *  - a connection whose first request is `events.subscribe` stays open and streams
 *    `{"event": kind, "data": {...}}` lines; sending anything else on it resets the connection.
 * `params` is mandatory on every request (an empty object for parameterless methods).
 */

export class HerdrError extends Error {
  readonly code: string;
  constructor(body: HerdrErrorBody) {
    super(body.message);
    this.name = 'HerdrError';
    this.code = body.code;
  }
}

/** Resolve the herdr socket path the same way the herdr CLI does. */
export function resolveSocketPath(opts: { socket?: string | null; session?: string | null } = {}): string {
  if (opts.socket) return expandHome(opts.socket);
  if (process.env['HERDR_SOCKET_PATH']) return process.env['HERDR_SOCKET_PATH'];
  const session = opts.session ?? process.env['HERDR_SESSION'] ?? null;
  const base = path.join(os.homedir(), '.config', 'herdr');
  return session ? path.join(base, 'sessions', session, 'herdr.sock') : path.join(base, 'herdr.sock');
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export interface HerdrClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
}

export interface HerdrSubscription {
  /** Resolves when the stream ends (server closed, error, or `close()`). */
  readonly closed: Promise<Error | undefined>;
  close(): void;
}

/** Splits a UTF-8 stream into complete JSON lines. */
class LineReader {
  private buffer = '';
  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
    }
  }
}

export class HerdrClient {
  readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private nextId = 1;

  constructor(opts: HerdrClientOptions) {
    this.socketPath = opts.socketPath;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  /** Send one request on a fresh connection; resolves with `result`, rejects with HerdrError, timeout, or socket error. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const id = `req_${this.nextId++}`;
    const line = JSON.stringify({ id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding('utf8');
      const reader = new LineReader();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        socket.destroy();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr request ${method} timed out after ${timeoutMs ?? this.requestTimeoutMs} ms`))),
        timeoutMs ?? this.requestTimeoutMs,
      );
      socket.once('connect', () => socket.write(line));
      socket.on('data', (chunk: string) =>
        reader.push(chunk, (raw) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return finish(() => reject(new Error(`herdr sent a non-JSON line for ${method}`)));
          }
          if (msg['error']) return finish(() => reject(new HerdrError(msg['error'] as HerdrErrorBody)));
          finish(() => resolve(msg['result'] as T));
        }),
      );
      socket.on('error', (err) => finish(() => reject(err)));
      socket.on('close', () => finish(() => reject(new Error(`herdr closed the connection before answering ${method}`))));
    });
  }

  /**
   * Open a streaming connection. Resolves once herdr acknowledges with `subscription_started`;
   * afterwards every server event is delivered to `onEvent`.
   */
  subscribe(subscriptions: Subscription[], onEvent: (ev: HerdrEvent) => void): Promise<HerdrSubscription> {
    const id = `sub_${this.nextId++}`;
    const line = JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n';
    return new Promise<HerdrSubscription>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding('utf8');
      const reader = new LineReader();
      let started = false;
      let resolveClosed!: (err: Error | undefined) => void;
      const closed = new Promise<Error | undefined>((r) => (resolveClosed = r));
      let closeErr: Error | undefined;
      const timer = setTimeout(() => {
        if (!started) {
          socket.destroy();
          reject(new Error(`herdr events.subscribe timed out after ${this.requestTimeoutMs} ms`));
        }
      }, this.requestTimeoutMs);
      const handle: HerdrSubscription = { closed, close: () => socket.destroy() };
      socket.once('connect', () => socket.write(line));
      socket.on('data', (chunk: string) =>
        reader.push(chunk, (raw) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return;
          }
          if (!started) {
            if (msg['error']) {
              clearTimeout(timer);
              socket.destroy();
              return reject(new HerdrError(msg['error'] as HerdrErrorBody));
            }
            if (msg['id'] === id) {
              started = true;
              clearTimeout(timer);
              resolve(handle);
            }
            return;
          }
          if (typeof msg['event'] === 'string') {
            onEvent({ event: msg['event'], data: (msg['data'] as Record<string, unknown>) ?? {} });
          }
        }),
      );
      socket.on('error', (err) => {
        closeErr = err;
        if (!started) {
          clearTimeout(timer);
          reject(err);
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!started) reject(closeErr ?? new Error('herdr closed the subscription before acknowledging it'));
        resolveClosed(closeErr);
      });
    });
  }
}
