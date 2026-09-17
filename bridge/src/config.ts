// ~/.config/remotly/config.json: defaults, validation, and the paths every other module derives
// from the config directory. `auto` values are resolved lazily by tls.ts / devices.ts / http.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from './log.ts';

export interface FlowConfig {
  listen: { host: string; port: number };
  tls: { mode: 'auto' | 'tailscale' | 'selfsigned' };
  security: { require_tailnet: 'auto' | boolean };
  herdr: { socket: string | null; session: string | null };
  push: {
    include_excerpt: boolean;
    debounce_ms: number;
    /** How long an agent must stay idle/done before a "finished" alert goes out (absorbs idle blips between turns). */
    done_settle_ms: number;
    apns: { team_id: string; key_id: string; p8_path: string; bundle_id: string };
    fcm: { project_id: string; service_account_path: string };
    /**
     * Push relay (relay/README.md) used for a platform whose local credentials are not configured: the bridge posts
     * the notification there and the relay, which holds the app's APNs key and Firebase service account, forwards it.
     * Empty string disables the relay, so a host without secrets sends no push at all.
     */
    relay_url: string;
  };
  approvals: { strict_verify: boolean };
  /** Photos from the phones (`POST /upload`): where they land, how long day folders are kept, the size cap. */
  uploads: { dir: string; keep_days: number; max_mb: number };
}

/** The app owner's relay; a bridge with its own secrets never talks to it. */
export const DEFAULT_RELAY_URL = 'https://relay.remotly.dev';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Inverse of expandHome, so the generated config file shows `~/…` like the spec. */
function contractHome(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** REMOTLY_CONFIG_DIR lets several bridge instances share one host (bridge/README.md "Install"). */
export function configDir(): string {
  const override = process.env['REMOTLY_CONFIG_DIR'];
  return path.resolve(override && override.trim() ? expandHome(override.trim()) : path.join(os.homedir(), '.config', 'remotly'));
}

export function statePath(name: string): string {
  return path.join(configDir(), name);
}

export function secretsDir(): string {
  return statePath('secrets');
}

export function tlsDir(): string {
  return statePath('tls');
}

/** Everything under the config dir is private to the user: 0700 dirs, 0600 files. */
export function ensureDirs(): void {
  for (const dir of [configDir(), secretsDir(), tlsDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

export function defaultConfig(): FlowConfig {
  const secrets = contractHome(secretsDir());
  return {
    listen: { host: 'auto', port: 7460 },
    tls: { mode: 'auto' },
    security: { require_tailnet: 'auto' },
    herdr: { socket: null, session: null },
    push: {
      include_excerpt: true,
      debounce_ms: 2500,
      done_settle_ms: 3000,
      apns: { team_id: '', key_id: '', p8_path: `${secrets}/AuthKey.p8`, bundle_id: '' },
      fcm: { project_id: '', service_account_path: `${secrets}/fcm-service-account.json` },
      relay_url: DEFAULT_RELAY_URL,
    },
    approvals: { strict_verify: true },
    uploads: { dir: path.join(os.homedir(), '.local', 'share', 'remotly', 'uploads'), keep_days: 14, max_mb: 20 },
  };
}

type Warn = (message: string) => void;

/** A validated section plus its dotted name, so errors read `listen.port must be …`. */
interface Scope {
  name: string;
  v: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(key: string, expected: string, got: unknown): never {
  throw new ConfigError(`config.json: ${key} must be ${expected} (got ${JSON.stringify(got)})`);
}

/** Returns a validated section; unknown keys are reported, not fatal. */
function section(parent: Scope, key: string, known: string[], warn: Warn): Scope {
  const name = parent.name ? `${parent.name}.${key}` : key;
  const v = parent.v[key];
  if (v === undefined) return { name, v: {} };
  if (!isObject(v)) fail(name, 'an object', v);
  for (const k of Object.keys(v)) if (!known.includes(k)) warn(`config.json: unknown key ${name}.${k} ignored`);
  return { name, v };
}

function str(s: Scope, key: string, fallback: string): string {
  const v = s.v[key];
  if (v === undefined) return fallback;
  return typeof v === 'string' ? v : fail(`${s.name}.${key}`, 'a string', v);
}

function strOrNull(s: Scope, key: string): string | null {
  const v = s.v[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.length > 0 ? v : fail(`${s.name}.${key}`, 'a non-empty string or null', v);
}

function bool(s: Scope, key: string, fallback: boolean): boolean {
  const v = s.v[key];
  if (v === undefined) return fallback;
  return typeof v === 'boolean' ? v : fail(`${s.name}.${key}`, 'true or false', v);
}

function int(s: Scope, key: string, fallback: number, min: number, max: number): number {
  const v = s.v[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${s.name}.${key}`, `an integer ${min}-${max}`, v);
  return v;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `""` (relay off) or an absolute https URL without query, fragment or credentials; plain http only to a loopback
 * host (a local `wrangler dev`). Requests carry device tokens and notification text, and a forged reply could make
 * the bridge drop a registration, so nothing else may travel in clear. The trailing slash is dropped.
 */
function relayUrl(s: Scope, fallback: string): string {
  const v = str(s, 'relay_url', fallback).trim();
  if (v === '') return '';
  const expected = 'an https URL (http only for localhost) without query, fragment or credentials, or ""';
  if (v.includes('?') || v.includes('#')) fail(`${s.name}.relay_url`, expected, v);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return fail(`${s.name}.relay_url`, expected, v);
  }
  const loopback = LOOPBACK_HOSTS.has(u.hostname) || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) fail(`${s.name}.relay_url`, expected, v);
  if (u.username || u.password) fail(`${s.name}.relay_url`, expected, v);
  return u.href.replace(/\/+$/, '');
}

function oneOf<T extends string>(s: Scope, key: string, allowed: readonly T[], fallback: T): T {
  const v = s.v[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(`${s.name}.${key}`, `one of ${allowed.join(' | ')}`, v);
  return v as T;
}

/** Merge `raw` over the defaults with type checks; `~` in paths is expanded. */
export function validateConfig(raw: unknown, warn: Warn = () => {}): FlowConfig {
  if (!isObject(raw)) throw new ConfigError('config.json: top level must be a JSON object');
  const d = defaultConfig();
  const root: Scope = { name: '', v: raw };
  const top = ['listen', 'tls', 'security', 'herdr', 'push', 'approvals', 'uploads'];
  for (const k of Object.keys(raw)) if (!top.includes(k)) warn(`config.json: unknown key ${k} ignored`);

  const listen = section(root, 'listen', ['host', 'port'], warn);
  const tls = section(root, 'tls', ['mode'], warn);
  const security = section(root, 'security', ['require_tailnet'], warn);
  const herdr = section(root, 'herdr', ['socket', 'session'], warn);
  const push = section(root, 'push', ['include_excerpt', 'debounce_ms', 'done_settle_ms', 'apns', 'fcm', 'relay_url'], warn);
  const apns = section(push, 'apns', ['team_id', 'key_id', 'p8_path', 'bundle_id'], warn);
  const fcm = section(push, 'fcm', ['project_id', 'service_account_path'], warn);
  const approvals = section(root, 'approvals', ['strict_verify'], warn);
  const uploads = section(root, 'uploads', ['dir', 'keep_days', 'max_mb'], warn);

  const requireTailnet = security.v['require_tailnet'];
  if (requireTailnet !== undefined && requireTailnet !== 'auto' && typeof requireTailnet !== 'boolean') {
    fail('security.require_tailnet', '"auto", true or false', requireTailnet);
  }
  const host = str(listen, 'host', d.listen.host).trim();
  if (host.length === 0) fail('listen.host', '"auto" or an IP address', host);

  const socket = strOrNull(herdr, 'socket');
  // Relative would mean "relative to whoever runs this": setup in some shell, the service in systemd's working dir.
  if (socket !== null && !path.isAbsolute(expandHome(socket))) fail('herdr.socket', 'an absolute path (or ~/…)', socket);
  return {
    listen: { host, port: int(listen, 'port', d.listen.port, 1, 65535) },
    tls: { mode: oneOf(tls, 'mode', ['auto', 'tailscale', 'selfsigned'] as const, d.tls.mode) },
    security: { require_tailnet: (requireTailnet as 'auto' | boolean | undefined) ?? d.security.require_tailnet },
    herdr: { socket: socket === null ? null : expandHome(socket), session: strOrNull(herdr, 'session') },
    push: {
      include_excerpt: bool(push, 'include_excerpt', d.push.include_excerpt),
      debounce_ms: int(push, 'debounce_ms', d.push.debounce_ms, 0, 600_000),
      done_settle_ms: int(push, 'done_settle_ms', d.push.done_settle_ms, 0, 600_000),
      apns: {
        team_id: str(apns, 'team_id', ''),
        key_id: str(apns, 'key_id', ''),
        p8_path: expandHome(str(apns, 'p8_path', d.push.apns.p8_path)),
        bundle_id: str(apns, 'bundle_id', ''),
      },
      fcm: {
        project_id: str(fcm, 'project_id', ''),
        service_account_path: expandHome(str(fcm, 'service_account_path', d.push.fcm.service_account_path)),
      },
      relay_url: relayUrl(push, d.push.relay_url),
    },
    approvals: { strict_verify: bool(approvals, 'strict_verify', d.approvals.strict_verify) },
    uploads: {
      dir: expandHome(str(uploads, 'dir', d.uploads.dir)),
      keep_days: int(uploads, 'keep_days', d.uploads.keep_days, 1, 3650),
      max_mb: int(uploads, 'max_mb', d.uploads.max_mb, 1, 200),
    },
  };
}

export function configPath(): string {
  return statePath('config.json');
}

/** Whether a platform can send directly: `ready` needs every identifier and the secret file; `intended` = any identifier set. */
export interface DirectPush {
  intended: boolean;
  ready: boolean;
  /** Config keys or files that are missing (empty when `ready`). */
  missing: string[];
}

export function directApns(c: FlowConfig): DirectPush {
  const a = c.push.apns;
  const missing: string[] = [];
  if (!a.team_id) missing.push('push.apns.team_id');
  if (!a.key_id) missing.push('push.apns.key_id');
  if (!a.bundle_id) missing.push('push.apns.bundle_id');
  if (!fs.existsSync(a.p8_path)) missing.push(a.p8_path);
  return { intended: Boolean(a.team_id || a.key_id || a.bundle_id), ready: missing.length === 0, missing };
}

export function directFcm(c: FlowConfig): DirectPush {
  const f = c.push.fcm;
  const missing: string[] = [];
  if (!f.project_id) missing.push('push.fcm.project_id');
  if (!fs.existsSync(f.service_account_path)) missing.push(f.service_account_path);
  return { intended: Boolean(f.project_id), ready: missing.length === 0, missing };
}

/**
 * Load `<configDir>/config.json`, creating it with defaults on first run.
 * Throws ConfigError with a precise message on invalid JSON or values.
 */
export function loadConfig(logger?: Logger): FlowConfig {
  ensureDirs();
  const file = configPath();
  const warn: Warn = (m) => logger?.warn('config.warning', { message: m });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2) + '\n', { mode: 0o600 });
    logger?.info('config.created', { path: file });
    return validateConfig(defaultConfig(), warn);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`config.json: not valid JSON (${(err as Error).message}) at ${file}`);
  }
  return validateConfig(raw, warn);
}
