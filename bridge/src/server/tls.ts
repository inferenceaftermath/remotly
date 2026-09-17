// TLS material: `tailscale cert` (publicly trusted) or a self-signed cert via openssl (pinned by
// fingerprint from the QR). Spawns go through an injectable exec so tests never touch binaries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FlowConfig } from '../config.ts';
import { tlsDir } from '../config.ts';
import type { Logger } from '../log.ts';
import { execFile, magicDnsName, tailscaleIp4, tailscaleStatus, type ExecFn } from '../tailscale.ts';

export interface TlsMaterial {
  mode: 'tailscale' | 'selfsigned';
  key: Buffer;
  cert: Buffer;
  /** base64url(SHA-256(leaf DER)); only for self-signed certs (pinned by the app). */
  fingerprintB64url?: string;
  notAfter: Date;
  hostnames: string[];
}

export interface TlsDeps {
  exec?: ExecFn;
  /** Directory for key/cert files (default `<configDir>/tls`). */
  dir?: string;
  now?: () => Date;
  hostname?: () => string;
  lanIps?: () => string[];
}

const RENEW_BEFORE_MS = 14 * 24 * 3600_000;
// Apple's TLS stack rejects server certificates valid for more than 825 days or lacking a serverAuth
// EKU even when the app pins and accepts the trust (iOS 13+ certificate requirements); the handshake
// fails before any request is sent. 800 days keeps a margin. Regenerating the self-signed cert
// changes the pinned fingerprint, so paired phones must pair again after a rotation.
const SELF_SIGNED_DAYS = 800;

export function fingerprintB64url(certPem: Buffer | string): string {
  const der = new crypto.X509Certificate(certPem).raw;
  return crypto.createHash('sha256').update(der).digest('base64url');
}

/** `DNS:a, IP Address:1.2.3.4, IP Address:fd7a::1` → `['a', '1.2.3.4', 'fd7a::1']`. */
export function parseSubjectAltName(san: string | undefined): string[] {
  if (!san) return [];
  const out: string[] = [];
  for (const part of san.split(',')) {
    const entry = part.trim();
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const value = entry.slice(colon + 1).trim();
    if (value) out.push(value);
  }
  return out;
}

export interface CertInfo {
  notAfter: Date;
  hostnames: string[];
  fingerprintB64url: string;
}

export function certInfo(certPem: Buffer | string): CertInfo {
  const x = new crypto.X509Certificate(certPem);
  const hostnames = parseSubjectAltName(x.subjectAltName);
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1];
  if (hostnames.length === 0 && cn) hostnames.push(cn);
  return {
    notAfter: x.validToDate,
    hostnames,
    fingerprintB64url: crypto.createHash('sha256').update(x.raw).digest('base64url'),
  };
}

/** Interface names that are not the way to a phone on the LAN: container bridges, veth pairs, VPN tunnels, VMs. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|tun|tap|tailscale|wg|utun|vmnet|vboxnet|zt|lxc|lxd|cni|flannel|kube)/i;

/**
 * Non-internal IPv4 addresses of this host: self-signed SANs, and in LAN mode the QR advertises the first one, so
 * physical-looking interfaces (eth*, en*, wl*, …) come before virtual ones.
 */
export function lanIPv4Addresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const physical: string[] = [];
  const virtual: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) (VIRTUAL_IFACE.test(name) ? virtual : physical).push(a.address);
  }
  return [...physical, ...virtual];
}

/** openssl argv for an EC P-256 self-signed server cert (≤ 825 days, serverAuth EKU) with the given SAN entries. */
export function selfSignedArgs(keyPath: string, certPath: string, sans: string[]): string[] {
  return [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', String(SELF_SIGNED_DAYS), '-subj', '/CN=remotly-bridge',
    '-addext', `subjectAltName=${sans.join(',')}`,
    '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', 'keyUsage=critical,digitalSignature',
    '-keyout', keyPath, '-out', certPath,
  ];
}

export function buildSans(opts: { tailscaleIp: string | null; lanIps: string[]; hostname: string }): string[] {
  const ips = new Set<string>();
  if (opts.tailscaleIp) ips.add(opts.tailscaleIp);
  for (const ip of opts.lanIps) ips.add(ip);
  const sans = [...ips].map((ip) => `IP:${ip}`);
  if (opts.hostname) sans.push(`DNS:${opts.hostname}`);
  return sans;
}

function readMaterial(mode: TlsMaterial['mode'], keyPath: string, certPath: string): TlsMaterial | null {
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o600);
  const cert = fs.readFileSync(certPath);
  const info = certInfo(cert);
  const material: TlsMaterial = { mode, key: fs.readFileSync(keyPath), cert, notAfter: info.notAfter, hostnames: info.hostnames };
  if (mode === 'selfsigned') material.fingerprintB64url = info.fingerprintB64url;
  return material;
}

export function tlsPaths(dir: string): { tsKey: string; tsCert: string; selfKey: string; selfCert: string; fingerprint: string } {
  return {
    tsKey: path.join(dir, 'ts.key'),
    tsCert: path.join(dir, 'ts.crt'),
    selfKey: path.join(dir, 'self.key'),
    selfCert: path.join(dir, 'self.crt'),
    fingerprint: path.join(dir, 'fingerprint'),
  };
}

/** argv of the `tailscale cert` call that writes the material for `name` under `dir` (shared with `setup`). */
export function tailscaleCertArgs(dir: string, name: string): string[] {
  const p = tlsPaths(dir);
  return ['cert', '--cert-file', p.tsCert, '--key-file', p.tsKey, name];
}

/** Run `tailscale cert`; on failure fall back to a cached cert that still has > 14 days. */
export async function obtainTailscaleCert(dir: string, log: Logger, deps: TlsDeps = {}): Promise<TlsMaterial | null> {
  const exec = deps.exec ?? execFile;
  const now = deps.now ?? (() => new Date());
  const p = tlsPaths(dir);
  const name = magicDnsName(await tailscaleStatus(exec));
  if (!name) {
    log.info('tls.tailscale_unavailable', { reason: 'no MagicDNS name (tailscale missing, stopped, or MagicDNS off)' });
    return null;
  }
  const r = await exec('tailscale', tailscaleCertArgs(dir, name), { timeoutMs: 60_000 });
  if (r.code === 0) {
    const m = readMaterial('tailscale', p.tsKey, p.tsCert);
    if (m) {
      m.hostnames = [name]; // issued for exactly this name; ignore CN/SAN parsing quirks
      return m;
    }
  }
  log.warn('tls.tailscale_cert_failed', { name, code: r.code, stderr: r.stderr.trim().slice(0, 300) });
  const cached = readMaterial('tailscale', p.tsKey, p.tsCert);
  if (cached && cached.notAfter.getTime() - now().getTime() > RENEW_BEFORE_MS) {
    cached.hostnames = [name];
    log.warn('tls.tailscale_using_cached', { not_after: cached.notAfter.toISOString() });
    return cached;
  }
  return null;
}

async function ensureSelfSigned(dir: string, log: Logger, deps: TlsDeps): Promise<TlsMaterial> {
  const exec = deps.exec ?? execFile;
  const now = deps.now ?? (() => new Date());
  const p = tlsPaths(dir);
  const existing = readMaterial('selfsigned', p.selfKey, p.selfCert);
  // Reuse forever while valid: regenerating would change the fingerprint every phone has pinned.
  if (existing && existing.notAfter.getTime() > now().getTime()) return existing;

  const sans = buildSans({
    tailscaleIp: await tailscaleIp4(exec),
    lanIps: (deps.lanIps ?? lanIPv4Addresses)(),
    hostname: (deps.hostname ?? os.hostname)(),
  });
  const r = await exec('openssl', selfSignedArgs(p.selfKey, p.selfCert, sans), { timeoutMs: 30_000 });
  const material = r.code === 0 ? readMaterial('selfsigned', p.selfKey, p.selfCert) : null;
  if (!material) throw new Error(`openssl self-signed certificate generation failed (code ${r.code}): ${r.stderr.trim()}`);
  fs.writeFileSync(p.fingerprint, (material.fingerprintB64url ?? '') + '\n', { mode: 0o600 });
  log.info('tls.selfsigned_created', { sans, not_after: material.notAfter.toISOString() });
  return material;
}

/**
 * `auto`: tailscale cert if the MagicDNS name resolves and the tailnet has HTTPS enabled,
 * else self-signed. Explicit `tailscale` fails hard instead of silently downgrading trust.
 */
export async function ensureTls(config: FlowConfig, log: Logger, deps: TlsDeps = {}): Promise<TlsMaterial> {
  const dir = deps.dir ?? tlsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = config.tls.mode;
  if (mode !== 'selfsigned') {
    const ts = await obtainTailscaleCert(dir, log, deps);
    if (ts) {
      log.info('tls.ready', { mode: 'tailscale', hostnames: ts.hostnames, not_after: ts.notAfter.toISOString() });
      return ts;
    }
    if (mode === 'tailscale') throw new Error('tls.mode is "tailscale" but `tailscale cert` did not produce a certificate');
  }
  const self = await ensureSelfSigned(dir, log, deps);
  log.info('tls.ready', { mode: 'selfsigned', hostnames: self.hostnames, fingerprint: self.fingerprintB64url, not_after: self.notAfter.toISOString() });
  return self;
}

export function needsRenewal(material: TlsMaterial, now: Date = new Date()): boolean {
  return material.mode === 'tailscale' && material.notAfter.getTime() - now.getTime() < RENEW_BEFORE_MS;
}

/**
 * Daily check: when a Tailscale cert has < 14 days left, re-run `tailscale cert` and hand the new
 * material to `onRenewed` (the https server swaps it with `setSecureContext`). Self-signed certs
 * last 800 days and are never rotated automatically (rotation would invalidate the phones' pins).
 */
export function startTlsRenewal(opts: {
  current: TlsMaterial;
  log: Logger;
  onRenewed: (material: TlsMaterial) => void;
  deps?: TlsDeps;
  intervalMs?: number;
}): { stop(): void; runOnce(): Promise<void> } {
  let current = opts.current;
  const deps = opts.deps ?? {};
  const runOnce = async (): Promise<void> => {
    const now = (deps.now ?? (() => new Date()))();
    if (!needsRenewal(current, now)) return;
    const fresh = await obtainTailscaleCert(deps.dir ?? tlsDir(), opts.log, deps);
    if (fresh && fresh.notAfter.getTime() > current.notAfter.getTime()) {
      current = fresh;
      opts.log.info('tls.renewed', { not_after: fresh.notAfter.toISOString() });
      opts.onRenewed(fresh);
    }
  };
  const timer = setInterval(() => void runOnce().catch((err) => opts.log.warn('tls.renewal_failed', { error: err })), opts.intervalMs ?? 24 * 3600_000);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce };
}
