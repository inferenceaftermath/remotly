// devices.json (0600) CRUD + token hashing, and the tailnet gate (`tailscale whois`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FlowConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import { execFile, normalizeIp, tailscaleStatus, tailscaleWhois, type ExecFn } from '../tailscale.ts';

export type Platform = 'ios' | 'android';

export interface PushRegistration {
  platform: Platform;
  token: string;
  env: 'sandbox' | 'production';
  /** Wants the glanceable status feed: iOS Live Activity pushes, Android `status` data messages. */
  activity?: boolean;
  /** iOS: ActivityKit push-to-start token (starts a Live Activity for a pane that begins working). */
  la_start?: string;
  /** iOS: pane id → update token of the Live Activity running for it. */
  la_panes?: Record<string, string>;
}

/** Fields to change on a registration; `undefined` deletes the field. */
export type PushPatch = { [K in keyof PushRegistration]?: PushRegistration[K] | undefined };

export interface DeviceRecord {
  id: string;
  name: string;
  platform: Platform;
  token_sha256: string;
  created_at: string;
  last_seen: string | null;
  push?: PushRegistration;
  /** Panes whose agent this device wants to hear about when it finishes (`notify {done:true}`). */
  notify_done?: string[];
}

/**
 * The Live Activity update token `reg` holds for `pane`, if any. Pane ids come from the client, so only own keys count:
 * a plain `la_panes[pane]` would answer `Object` for "constructor" or the prototype for "__proto__".
 */
export function activityToken(reg: Pick<PushRegistration, 'la_panes'> | undefined, pane: string): string | undefined {
  const panes = reg?.la_panes;
  return panes !== undefined && Object.hasOwn(panes, pane) ? panes[pane] : undefined;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Write temp + rename so a crash mid-write can never leave a truncated devices.json. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export interface DeviceStoreOptions {
  log?: Logger;
  now?: () => Date;
  /** `touch()` coalesces last_seen writes; the phone pings every 15 s. */
  touchDebounceMs?: number;
}

export class DeviceStore {
  readonly file: string;
  private devices: DeviceRecord[] = [];
  private readonly now: () => Date;
  private readonly touchDebounceMs: number;
  private readonly log: Logger | undefined;
  private touchTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(file: string, opts: DeviceStoreOptions = {}) {
    this.file = file;
    this.now = opts.now ?? (() => new Date());
    this.touchDebounceMs = opts.touchDebounceMs ?? 5000;
    this.log = opts.log;
  }

  /** Missing file → empty store. Corrupt JSON throws: never silently discard paired devices. */
  load(): this {
    if (!fs.existsSync(this.file)) {
      this.devices = [];
      return this;
    }
    const text = fs.readFileSync(this.file, 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${this.file}: not valid JSON (${(err as Error).message})`);
    }
    if (!Array.isArray(raw)) throw new Error(`${this.file}: expected a JSON array`);
    this.devices = raw.filter(
      (d): d is DeviceRecord =>
        typeof d === 'object' && d !== null && typeof d.id === 'string' && typeof d.token_sha256 === 'string',
    );
    return this;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(this.devices, null, 2) + '\n', 0o600);
    this.dirty = false;
  }

  list(): DeviceRecord[] {
    return this.devices.map((d) => ({ ...d }));
  }

  get(id: string): DeviceRecord | null {
    const d = this.devices.find((x) => x.id === id);
    return d ? { ...d } : null;
  }

  /** Create a device with a fresh 32-byte token; only the hash is stored. Return the token once. */
  issueToken(meta: { name: string; platform: Platform }): { token: string; device: DeviceRecord } {
    const token = crypto.randomBytes(32).toString('base64url');
    const device: DeviceRecord = {
      id: crypto.randomUUID(),
      name: meta.name,
      platform: meta.platform,
      token_sha256: hashToken(token),
      created_at: this.now().toISOString(),
      last_seen: null,
    };
    this.devices.push(device);
    this.save();
    return { token, device: { ...device } };
  }

  /** Constant-time over the stored hashes: every record is compared, no early exit. */
  authenticate(token: string): DeviceRecord | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const candidate = Buffer.from(hashToken(token), 'hex');
    let match: DeviceRecord | null = null;
    for (const d of this.devices) {
      const stored = Buffer.from(d.token_sha256, 'hex');
      if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) match = d;
    }
    return match ? { ...match } : null;
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  setPush(id: string, push: PushRegistration | null): boolean {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return false;
    if (push) d.push = { ...push };
    else delete d.push;
    this.save();
    return true;
  }

  /** Merge fields into the device's push registration (no-op without one); `undefined` removes a field. */
  updatePush(id: string, patch: PushPatch): PushRegistration | null {
    const d = this.devices.find((x) => x.id === id);
    if (!d?.push) return null;
    const merged: Record<string, unknown> = { ...d.push, ...patch };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    d.push = merged as unknown as PushRegistration;
    this.save();
    return { ...d.push };
  }

  /** Remember (or forget) the update token of the Live Activity this device runs for `pane`. */
  setActivityToken(id: string, pane: string, token: string | null): boolean {
    const d = this.devices.find((x) => x.id === id);
    if (!d?.push) return false;
    // Own keys only: `panes[pane] = token` for "__proto__" would hit the setter instead of storing a key, so the entry
    // is defined as data. Deleting an own key is safe as is.
    const panes: Record<string, string> = { ...(d.push.la_panes ?? {}) };
    if (token) Object.defineProperty(panes, pane, { value: token, enumerable: true, writable: true, configurable: true });
    else delete panes[pane];
    if (Object.keys(panes).length > 0) d.push.la_panes = panes;
    else delete d.push.la_panes;
    this.save();
    return true;
  }

  notifyDone(id: string): string[] {
    return [...(this.devices.find((x) => x.id === id)?.notify_done ?? [])];
  }

  /** Arm or disarm the "notify when done" alert of one device for one pane. Returns whether anything changed. */
  setNotifyDone(id: string, pane: string, done: boolean): boolean {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return false;
    const armed = new Set(d.notify_done ?? []);
    if (done === armed.has(pane)) return false;
    if (done) armed.add(pane);
    else armed.delete(pane);
    if (armed.size > 0) d.notify_done = [...armed];
    else delete d.notify_done;
    this.save();
    return true;
  }

  /** Devices armed for `pane`. */
  armedFor(pane: string): DeviceRecord[] {
    return this.devices.filter((d) => d.notify_done?.includes(pane)).map((d) => ({ ...d }));
  }

  touch(id: string): void {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return;
    d.last_seen = this.now().toISOString();
    this.dirty = true;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      this.flush();
    }, this.touchDebounceMs);
    this.touchTimer.unref();
  }

  /** Persist pending last_seen updates now (call on shutdown). */
  flush(): void {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    if (!this.dirty) return;
    try {
      this.save();
    } catch (err) {
      this.log?.warn('devices.flush_failed', { error: err });
    }
  }
}

// ---------------------------------------------------------------- tailnet gate

export type GateDecision =
  | { allowed: true; reason: 'gate_off' | 'same_user' }
  | { allowed: false; reason: 'not_on_tailnet' | 'other_user' | 'self_unknown' };

export interface TailnetGateOptions {
  exec?: ExecFn;
  log?: Logger;
  now?: () => number;
  /** Per-peer decision cache; reconnects and /pair retries must not spawn a process each time. */
  cacheMs?: number;
  /**
   * `serve` saw Tailscale up at start-up (server/tailscale-wait.ts): `require_tailnet: 'auto'` is then ON for the life of
   * the process, whatever `tailscale status` says when the first peer arrives — a Tailscale that stops afterwards makes
   * decisions fail closed (`self_unknown`), it cannot turn the gate off.
   */
  tailscaleUp?: boolean;
}

export interface TailnetGate {
  /** `require_tailnet: 'auto'` → true iff tailscale is present. Resolved once. */
  enabled(): Promise<boolean>;
  check(remoteIp: string): Promise<GateDecision>;
  allow(remoteIp: string): Promise<boolean>;
}

interface SelfUser {
  id: number | undefined;
  login: string | undefined;
}

export function createTailnetGate(config: FlowConfig, opts: TailnetGateOptions = {}): TailnetGate {
  const exec = opts.exec ?? execFile;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 60_000;
  const setting = config.security.require_tailnet;
  let self: SelfUser | null = null;
  let enabledP: Promise<boolean> | null = null;
  const cache = new Map<string, { decision: GateDecision; expires: number }>();

  const loadSelf = async (): Promise<SelfUser | null> => {
    const status = await tailscaleStatus(exec);
    if (!status?.Self) return null;
    const id = status.Self.UserID;
    const login = id !== undefined ? status.User?.[String(id)]?.LoginName : undefined;
    return { id, login };
  };

  const enabled = (): Promise<boolean> => {
    if (!enabledP) {
      enabledP = (async () => {
        if (setting === false) return false;
        self = await loadSelf();
        if (setting === true) return true;
        const present = opts.tailscaleUp === true || self !== null;
        opts.log?.info('tailnet_gate', { require_tailnet: present, resolved_from: 'auto', ...(opts.tailscaleUp ? { tailscale_up_at_start: true } : {}) });
        return present;
      })();
    }
    return enabledP;
  };

  const decide = async (ip: string): Promise<GateDecision> => {
    if (!self?.id && !self?.login) self = await loadSelf();
    if (!self || (self.id === undefined && self.login === undefined)) return { allowed: false, reason: 'self_unknown' };
    const who = await tailscaleWhois(ip, exec);
    const peer = who?.UserProfile;
    if (!peer) return { allowed: false, reason: 'not_on_tailnet' };
    const sameId = self.id !== undefined && peer.ID === self.id;
    const sameLogin = self.login !== undefined && peer.LoginName === self.login;
    return sameId || sameLogin ? { allowed: true, reason: 'same_user' } : { allowed: false, reason: 'other_user' };
  };

  const check = async (remoteIp: string): Promise<GateDecision> => {
    if (!(await enabled())) return { allowed: true, reason: 'gate_off' };
    const ip = normalizeIp(remoteIp);
    const hit = cache.get(ip);
    if (hit && hit.expires > now()) return hit.decision;
    const decision = await decide(ip);
    cache.set(ip, { decision, expires: now() + cacheMs });
    if (!decision.allowed) opts.log?.warn('tailnet_gate.denied', { ip, reason: decision.reason });
    return decision;
  };

  return { enabled, check, allow: async (ip) => (await check(ip)).allowed };
}

/** One-shot form of the gate. */
export async function tailnetGate(remoteIp: string, config: FlowConfig, opts: TailnetGateOptions = {}): Promise<GateDecision> {
  return createTailnetGate(config, opts).check(remoteIp);
}
