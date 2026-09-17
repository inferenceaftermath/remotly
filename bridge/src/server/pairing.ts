// Pairing codes (single-use, TTL) with the /pair failure lockout, plus the QR payload.
import crypto from 'node:crypto';

/** A–Z2–9 minus I, O, 0, 1: unambiguous when read aloud or typed from a screen. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

export interface PairingOptions {
  /** Milliseconds clock (tests inject a fake). */
  now?: () => number;
  ttlSec?: number;
  maxOutstanding?: number;
  maxFailures?: number;
  lockoutMs?: number;
}

export type RedeemResult = 'ok' | 'bad_code' | 'locked_out';

/** 32 symbols = 5 bits, and 256 % 32 === 0, so `byte % 32` is unbiased. */
export function generateCode(random: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = random(PAIRING_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += PAIRING_ALPHABET[(bytes[i] ?? 0) % PAIRING_ALPHABET.length];
  return out;
}

/** Tolerate what humans type: lowercase, spaces and dashes. Confusables are not in the alphabet. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export class PairingManager {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  /** code → expiry (ms) and whether it survives a successful redemption (`setup` prints one code for every phone). */
  private codes = new Map<string, { expires: number; reusable: boolean }>();
  /** Failure counters per peer address: a stale QR scanned by one phone must not lock out the others. */
  private attempts = new Map<string, { failures: number; lockedUntil: number; last: number }>();

  constructor(opts: PairingOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = (opts.ttlSec ?? 300) * 1000;
    this.maxOutstanding = opts.maxOutstanding ?? 3;
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  }

  private sweep(): void {
    const t = this.now();
    for (const [code, entry] of this.codes) if (entry.expires <= t) this.codes.delete(code);
  }

  /**
   * New code, single-use unless `reusable` (then it pairs any number of devices until it expires). Beyond
   * `maxOutstanding`, the oldest live single-use code is dropped first — a reusable setup code keeps working for every
   * phone until it expires, however many `pair` codes are printed meanwhile; only when nothing else is left does the
   * oldest reusable one go.
   */
  create(ttlSec?: number, opts: { reusable?: boolean } = {}): { code: string; expiresAt: Date } {
    this.sweep();
    while (this.codes.size >= this.maxOutstanding) {
      let victim: string | undefined;
      for (const [code, entry] of this.codes) {
        if (!entry.reusable) {
          victim = code;
          break;
        }
      }
      victim ??= this.codes.keys().next().value;
      if (victim === undefined) break;
      this.codes.delete(victim);
    }
    let code = generateCode();
    while (this.codes.has(code)) code = generateCode();
    const expires = this.now() + (ttlSec ?? this.ttlMs / 1000) * 1000;
    this.codes.set(code, { expires, reusable: opts.reusable ?? false });
    return { code, expiresAt: new Date(expires) };
  }

  private bucket(peer: string): { failures: number; lockedUntil: number; last: number } {
    const t = this.now();
    // Forget peers whose last failure is older than a lockout period.
    for (const [k, b] of this.attempts) if (b.lockedUntil <= t && t - b.last > this.lockoutMs) this.attempts.delete(k);
    let b = this.attempts.get(peer);
    if (!b) {
      b = { failures: 0, lockedUntil: 0, last: t };
      this.attempts.set(peer, b);
    }
    return b;
  }

  isLockedOut(peer = '*'): boolean {
    const b = this.bucket(peer);
    if (b.lockedUntil === 0) return false;
    if (this.now() < b.lockedUntil) return true;
    // Lockout served; start from a clean slate.
    b.lockedUntil = 0;
    b.failures = 0;
    return false;
  }

  lockoutRemainingMs(peer = '*'): number {
    return this.isLockedOut(peer) ? this.bucket(peer).lockedUntil - this.now() : 0;
  }

  outstanding(): number {
    this.sweep();
    return this.codes.size;
  }

  /** Redeem a code (consumed unless reusable). Five failures from one peer → 15 minutes of `locked_out` for that peer only. */
  redeem(input: string, peer = '*'): RedeemResult {
    if (this.isLockedOut(peer)) return 'locked_out';
    const b = this.bucket(peer);
    this.sweep();
    const wanted = Buffer.from(normalizeCode(typeof input === 'string' ? input : ''));
    let matched: string | null = null;
    for (const code of this.codes.keys()) {
      const c = Buffer.from(code);
      if (c.length === wanted.length && crypto.timingSafeEqual(c, wanted)) matched = code;
    }
    if (matched === null) {
      b.failures += 1;
      b.last = this.now();
      if (b.failures >= this.maxFailures) b.lockedUntil = this.now() + this.lockoutMs;
      return b.failures >= this.maxFailures ? 'locked_out' : 'bad_code';
    }
    if (!this.codes.get(matched)?.reusable) this.codes.delete(matched);
    b.failures = 0;
    return 'ok';
  }
}

export interface QrPayloadInput {
  url: string;
  /** Omitted when the certificate is publicly trusted (Tailscale). */
  fingerprintB64url?: string | undefined;
  code: string;
  hostName: string;
}

/** `remotly://pair?u=…&fp=…&c=…&n=…` (§5). */
export function buildQrPayload(input: QrPayloadInput): string {
  const q = new URLSearchParams();
  q.set('u', input.url);
  if (input.fingerprintB64url) q.set('fp', input.fingerprintB64url);
  q.set('c', input.code);
  q.set('n', input.hostName);
  return `remotly://pair?${q.toString()}`;
}

export function parseQrPayload(payload: string): QrPayloadInput | null {
  if (!payload.startsWith('remotly://pair?')) return null;
  const q = new URLSearchParams(payload.slice('remotly://pair?'.length));
  const url = q.get('u');
  const code = q.get('c');
  const hostName = q.get('n');
  if (!url || !code || hostName === null) return null;
  const fp = q.get('fp');
  return fp ? { url, code, hostName, fingerprintB64url: fp } : { url, code, hostName };
}

/**
 * Host for the QR when the listener is a wildcard. Tailscale mode advertises the Tailscale IP; LAN mode (no tailnet
 * gate, `setup --lan`) a LAN address first — a phone on the physical network cannot reach `100.x` even when the
 * host happens to run Tailscale too.
 */
export function pairFallbackHost(o: { lanFirst: boolean; tailscaleIp: string | null; lanIps: string[]; hostName: string }): string {
  const lan = o.lanIps.find((ip) => ip !== o.tailscaleIp) ?? null;
  const order = o.lanFirst ? [lan, o.tailscaleIp] : [o.tailscaleIp, lan];
  return order.find((h): h is string => h !== null) ?? o.hostName;
}

/**
 * Where the phone should connect. Tailscale certs are only valid for the MagicDNS name;
 * a self-signed cert is pinned by fingerprint, so a bare IP is fine there.
 */
export function pairUrl(opts: { tlsMode: 'tailscale' | 'selfsigned'; hostnames: string[]; listenAddress: string; port: number; fallbackHost: string }): string {
  const magic = opts.tlsMode === 'tailscale' ? opts.hostnames[0] : undefined;
  const wildcard = opts.listenAddress === '0.0.0.0' || opts.listenAddress === '::';
  const host = magic ?? (wildcard ? opts.fallbackHost : opts.listenAddress);
  return `wss://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${opts.port}`;
}
