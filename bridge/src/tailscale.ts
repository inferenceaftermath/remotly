// Spawning helpers shared by tls.ts (tailscale cert / openssl), devices.ts (tailnet gate) and
// http.ts (listen address). Everything takes an injectable `exec` so tests never spawn anything.
import { execFile as cpExecFile } from 'node:child_process';
import net from 'node:net';

export interface ExecResult {
  /** Exit code; `null` when the binary is missing, the spawn failed, or the timeout killed it. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** No shell, never rejects: a missing binary or a timeout is an ordinary failed result. */
export const execFile: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    cpExecFile(
      cmd,
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
