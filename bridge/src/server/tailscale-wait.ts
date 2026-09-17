// Start-up guard for `serve`. A systemd *user* unit cannot order itself after the system `tailscaled.service` (user
// managers do not see system units), so at boot the bridge can start before Tailscale is up. Every `auto` setting would
// then resolve as if Tailscale were absent — a listener on every interface, a self-signed certificate, the tailnet gate
// OFF, and the gate's decision is memoised for the life of the process. Instead: when Tailscale is installed but not up
// and a setting depends on it, wait (bounded) and then refuse to start, so systemd (`Restart=always`) tries again and the
// journal says why. A host without the binary is left alone: that is the documented fallback (`setup` warns about it).
import type { FlowConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import { execFile, selfIdentified, type ExecFn, type ExecResult, type TailscaleStatus } from '../tailscale.ts';

/** `absent`: no `tailscale` binary. `down`: tailscaled not answering, or the node not `Running` with an identified `Self` (logging in, logged out). */
export type TailscalePresence = 'absent' | 'down' | 'up';

export const TAILSCALE_WAIT_MS = 60_000;
export const TAILSCALE_POLL_MS = 2_000;

export class TailscaleNotUp extends Error {}

/** What one `tailscale status --json` run says, read the way the tailnet gate and `tailscale ip -4` need it (`setup` and `doctor` use the same reading). */
export function presenceFrom(r: ExecResult): TailscalePresence {
  if (r.code === null && /ENOENT/.test(r.stderr)) return 'absent';
  if (r.code !== 0) return 'down';
  let status: TailscaleStatus | null = null;
  try {
    status = JSON.parse(r.stdout) as TailscaleStatus;
  } catch {
    status = null;
  }
  return selfIdentified(status) ? 'up' : 'down';
}

export async function tailscalePresence(exec: ExecFn = execFile, timeoutMs?: number): Promise<TailscalePresence> {
  return presenceFrom(await exec('tailscale', ['status', '--json'], timeoutMs === undefined ? {} : { timeoutMs }));
}

/** The longest one `tailscale status` probe may take; a wedged CLI must not stretch the wait past its deadline. */
export const TAILSCALE_PROBE_MS = 10_000;

/** What each Tailscale-dependent setting does on a host without Tailscale: `auto` falls back, explicit values fail or deny. */
export function absentResolution(config: FlowConfig): string[] {
  return tailscaleDependents(config).map((d) => {
    if (d === 'listen.host') return 'listen.host auto → every interface';
    if (d === 'tls.mode') return config.tls.mode === 'tailscale' ? 'tls.mode tailscale → no certificate, serve stops' : 'tls.mode auto → self-signed certificate';
    return config.security.require_tailnet === true ? 'security.require_tailnet true → every /pair and WebSocket request is denied' : 'security.require_tailnet auto → tailnet gate off';
  });
}

/**
 * The settings whose value needs Tailscale up at start-up (`auto`, or a Tailscale-only value). Empty after `setup --lan`.
 * `listen.host: auto` alone is not a reason to wait: with a self-signed certificate and the gate off nothing about the
 * perimeter depends on Tailscale — the automatic listener still binds the Tailscale IPv4 when Tailscale happens to be
 * running and every interface otherwise (`doctor` spells that out for this combination); it rides along when something
 * else needs Tailscale.
 */
export function tailscaleDependents(config: FlowConfig): string[] {
  const out: string[] = [];
  if (config.tls.mode !== 'selfsigned') out.push('tls.mode');
  if (config.security.require_tailnet !== false) out.push('security.require_tailnet');
  if (out.length > 0 && config.listen.host === 'auto') out.unshift('listen.host');
  return out;
}

export interface TailscaleWaitOptions {
  exec?: ExecFn;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock (ms); the deadline counts probe time too, not only the sleeps. */
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * `null` when no setting depends on Tailscale (nothing checked); otherwise the presence once it is `up` or `absent`, both of
 * which let `serve` go on. Throws `TailscaleNotUp` when Tailscale stays installed-but-down for `timeoutMs`.
 */
export async function waitForTailscale(config: FlowConfig, log: Logger, opts: TailscaleWaitOptions = {}): Promise<TailscalePresence | null> {
  const dependents = tailscaleDependents(config);
  if (dependents.length === 0) return null;
  const exec = opts.exec ?? execFile;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? TAILSCALE_WAIT_MS;
  const pollMs = opts.pollMs ?? TAILSCALE_POLL_MS;
  const started = now();
  const deadline = started + timeoutMs;
  // Each probe gets at most what is left of the budget (and never more than TAILSCALE_PROBE_MS), so a CLI that hangs
  // cannot turn the 60 s into minutes.
  const remaining = (): number => Math.max(0, deadline - now());
  const probe = (): Promise<TailscalePresence> => tailscalePresence(exec, Math.max(1_000, Math.min(TAILSCALE_PROBE_MS, remaining())));
  let presence = await probe();
  if (presence === 'absent') {
    log.warn('tailscale.absent', { resolves: absentResolution(config) });
    return presence;
  }
  if (presence === 'up') return presence;
  log.info('tailscale.waiting', { depends: dependents, timeout_ms: timeoutMs });
  while (remaining() > 0) {
    await sleep(Math.min(pollMs, remaining()));
    if (remaining() <= 0) break;
    presence = await probe();
    if (presence === 'up') {
      log.info('tailscale.up', { waited_ms: now() - started });
      return presence;
    }
    if (presence === 'absent') {
      // The binary went away while we waited (an uninstall): the same fallback, and the same warning, as when it was never there.
      log.warn('tailscale.absent', { resolves: absentResolution(config), waited_ms: now() - started });
      return presence;
    }
  }
  const waited = now() - started;
  log.error('tailscale.not_up', { depends: dependents, waited_ms: waited });
  throw new TailscaleNotUp(
    `Tailscale is installed but not up after ${Math.round(waited / 1000)} s (tailscaled stopped, or the node not logged in), and ${dependents.join(', ')} depend on it. ` +
      'Fix:  sudo systemctl enable --now tailscaled && sudo tailscale up   — or, for a LAN-only host:  remotly-bridge setup --lan. Exiting so systemd retries.',
  );
}
