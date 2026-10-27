// Spawning helpers shared by tls.ts (tailscale cert / openssl), devices.ts (tailnet gate) and
// http.ts (listen address). Everything takes an injectable `exec` so tests never spawn anything.
import { execFile as cpExecFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface ExecResult {
  /** Exit code; `null` when the binary is missing, the spawn failed, or the timeout killed it. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Where the Tailscale CLI lives when it is not on PATH: the Mac app ships it inside the bundle; Homebrew links it under its prefix. */
export const TAILSCALE_CANDIDATES: Record<string, string[]> = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
};

const executable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The `tailscale` command to spawn: REMOTLY_TAILSCALE when set, `tailscale` when PATH has one (so a missing binary still
 * fails as `spawn tailscale ENOENT`, the reading every caller knows), else the first platform candidate that exists —
 * on macOS the CLI is inside the app bundle and a launchd agent's PATH does not reach it. Back to `tailscale` when
 * nothing is found.
 */
export function resolveTailscaleBinary(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = executable): string {
  return findTailscaleBinary(env, platform, exists) ?? 'tailscale';
}

/** resolveTailscaleBinary without the fallback: null when nothing is found anywhere. */
export function findTailscaleBinary(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = executable): string | null {
  const pinned = env['REMOTLY_TAILSCALE']?.trim();
  if (pinned) return pinned;
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) if (dir && exists(path.join(dir, 'tailscale'))) return 'tailscale';
  for (const p of TAILSCALE_CANDIDATES[platform] ?? []) if (exists(p)) return p;
  return null;
}

/**
 * A `tailscale` command for one process: `find` is asked until it finds one, which is then kept (PATH and the bundle do
 * not move while the bridge runs). Until then every call looks again — `tailscale` as the plain name, so the failure
 * reads as ENOENT — which is how a Tailscale installed while `setup` waits for it is found on the next poll.
 */
export function tailscaleResolver(find: () => string | null): () => string {
  let found: string | undefined;
  return () => {
    if (found === undefined) found = find() ?? undefined;
    return found ?? 'tailscale';
  };
}

/** The `tailscale` command this process spawns (see tailscaleResolver). */
export const tailscaleCommand: () => string = tailscaleResolver(() => findTailscaleBinary());

/** No shell, never rejects: a missing binary or a timeout is an ordinary failed result. `tailscale` is spawned as tailscaleCommand() says. */
export const execFile: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    cpExecFile(
      cmd === 'tailscale' ? tailscaleCommand() : cmd,
      args,
      { timeout: opts.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof err.code === 'number' ? err.code : null;
        const why = err.killed ? `${cmd} timed out` : err.message;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || why });
      },
    );
  });

export interface TailscaleUser {
  ID: number;
  LoginName: string;
  DisplayName?: string;
}

/** Subset of `tailscale status --json` that Remotly reads. */
export interface TailscaleStatus {
  BackendState?: string;
  /** DNS names the control plane will issue certificates for; empty until "HTTPS Certificates" is enabled for the tailnet. */
  CertDomains?: string[];
  Self?: { DNSName?: string; UserID?: number; TailscaleIPs?: string[]; HostName?: string };
  User?: Record<string, TailscaleUser>;
  CurrentTailnet?: { MagicDNSEnabled?: boolean; MagicDNSSuffix?: string };
}

/**
 * A node the bridge can rely on: `Running` with a `Self` that carries a `UserID`. The tailnet gate compares every peer's
 * owner against that id (a login name is looked up through it too), so a status without it can identify nobody; the
 * certificate and the listener need less, but `serve`, `setup` and `doctor` share this one reading of "up" so they never
 * disagree about the same `tailscale status` output.
 */
export function selfIdentified(status: TailscaleStatus | null | undefined): boolean {
  return status?.BackendState === 'Running' && typeof status.Self?.UserID === 'number';
}

/** Subset of `tailscale whois --json <ip>`. */
export interface TailscaleWhois {
  Node?: { Name?: string; User?: number };
  UserProfile?: TailscaleUser;
}

function parseJson<T>(text: string): T | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

export async function tailscaleStatus(exec: ExecFn = execFile): Promise<TailscaleStatus | null> {
  const r = await exec('tailscale', ['status', '--json']);
  return r.code === 0 ? parseJson<TailscaleStatus>(r.stdout) : null;
}

/** Our Tailscale IPv4, or null when tailscale is missing or not running. */
export async function tailscaleIp4(exec: ExecFn = execFile): Promise<string | null> {
  const r = await exec('tailscale', ['ip', '-4']);
  if (r.code !== 0) return null;
  const ip = r.stdout.trim().split(/\s+/)[0] ?? '';
  return net.isIPv4(ip) ? ip : null;
}

export async function tailscaleWhois(ip: string, exec: ExecFn = execFile): Promise<TailscaleWhois | null> {
  if (!net.isIP(ip)) return null;
  const r = await exec('tailscale', ['whois', '--json', ip]);
  return r.code === 0 ? parseJson<TailscaleWhois>(r.stdout) : null;
}

/** MagicDNS name without the trailing dot (`host.tailnet-example.ts.net`), or null. */
export function magicDnsName(status: TailscaleStatus | null): string | null {
  const raw = status?.Self?.DNSName?.trim();
  if (!raw || status?.CurrentTailnet?.MagicDNSEnabled === false) return null;
  const name = raw.replace(/\.$/, '');
  return name.length > 0 ? name : null;
}

/** Accepts `::ffff:1.2.3.4` (dual-stack sockets) and returns the plain IPv4. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}
