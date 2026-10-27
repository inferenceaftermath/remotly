// `remotly-bridge setup`: the one command install.sh runs — a service for herdr itself (so a reboot brings it back),
// herdr and Tailscale checks, the certificate, the bridge's user service (a systemd user unit on Linux, a launchd agent
// on macOS: platform/service.ts), a health wait and the pairing QR. A failing check prints its fix and, unless
// --no-wait, polls until the user has applied it (so a `sudo …` line runs in another terminal while this one waits).
// Spawns go through an injectable exec and every other effect is a dependency, so tests never touch binaries, the
// service manager or the network.
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_SETTINGS_RECORD, agentDirs, agentSettingsStep, claudeRunning, type AgentDirs } from './agent-settings.ts';
import { expandHome } from './config.ts';
import type { ControlStatus, PairInfo } from './control.ts';
import { TAILSCALE_INSTALL, tailscaleHints } from './platform/hints.ts';
import { HERDR_CONFIG_HOME_VAR, HERDR_ENV_PREFIX, HERDR_UNIT_MARKER, INSTALLER_ENV, PLUTIL, herdrConfigHome, herdrUnit, xmlPlistRoot, renderSystemdUnit, renderSystemdUpdateUnits, serviceUnitDir, systemdManager, systemdUnitFile, systemdUpdateNames, type BootStart, type ServiceKind, type ServiceManager, type UnitSource, type UnitState } from './platform/service.ts';
import { tailscaleCertArgs } from './server/tls.ts';
import { magicDnsName, type ExecFn, type ExecResult, type TailscaleStatus, selfIdentified } from './tailscale.ts';
import { installLayout, launcherDir } from './update.ts';

export const HERDR_INSTALL = 'curl -fsSL https://herdr.dev/install.sh | sh';
export { TAILSCALE_INSTALL };
export const TAILSCALE_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';
export const HERDR_PROTOCOL = 19;

const POLL_MS = 3000;
const CERT_POLL_MS = 5000;
const MAX_WAIT_MS = 20 * 60_000;
const HEALTH_WAIT_MS = 90_000;

export interface SetupOptions {
  /** Unit name without `.service` (the suffix is accepted and dropped). */
  unit: string;
  /** Absolute; baked into the unit as REMOTLY_CONFIG_DIR (several instances on one host). */
  configDir?: string;
  herdrSession?: string;
  /** Absolute. */
  herdrSocket?: string;
  /**
   * LAN mode for a host without Tailscale: no Tailscale checks, and `LAN_CONFIG` is written to config.json so `serve`
   * listens on every interface with the self-signed certificate and no tailnet gate — even if Tailscale is present.
   */
  lan: boolean;
  /**
   * Keep the network mode config.json already has: LAN (the `LAN_CONFIG` triple) stays LAN, anything else stays as it is.
   * For unattended re-runs (`update`, an upgrade script); without it an ordinary `setup` means "Tailscale again".
   */
  keepMode?: boolean;
  /** Poll until a failing check passes (default); false → stop at the first failing check. */
  wait: boolean;
  /** Print a pairing QR at the end (default). */
  pair: boolean;
  ttlSec: number;
  /** Enable the daily update timer (default). false (`--no-auto-update`): the timer units are written but left disabled. */
  autoUpdate?: boolean;
  /**
   * Leave a stopped unit stopped: written, reloaded and enabled, but not restarted (`--keep-stopped`; what `update`
   * passes, so an operator's stop while an unattended update runs stands). A running or failed unit is restarted as
   * always; no answer from systemd is not read as "running".
   */
  keepStopped?: boolean;
  /** Set the coding agents up to keep their output in the scrollback (agent-settings.ts; default). false: `--no-agent-settings`. */
  agentSettings?: boolean;
  /** Run herdr as a user service too, so a reboot brings it back (default). false (`--no-herdr-service`): the unit is written but left disabled. */
  herdrService?: boolean;
}

/** What `--lan` writes into config.json (keys the daemon otherwise resolves from Tailscale's presence). */
export const LAN_CONFIG = { tls: { mode: 'selfsigned' }, listen: { host: '0.0.0.0' }, security: { require_tailnet: false } } as const;

export function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SetupOptions {
  const opts: SetupOptions = { unit: env['REMOTLY_SYSTEMD_UNIT'] ?? 'remotly-bridge', lan: false, wait: true, pair: true, ttlSec: 600 };
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  // The unit runs from systemd's working directory, so relative paths and `~` must be resolved here.
  const abs = (v: string): string => path.resolve(expandHome(v));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    switch (a) {
      case '--unit':
        opts.unit = value(i++);
        break;
      case '--config-dir':
        opts.configDir = abs(value(i++));
        break;
      case '--herdr-session':
        opts.herdrSession = value(i++);
        break;
      case '--herdr-socket':
        opts.herdrSocket = abs(value(i++));
        break;
      case '--ttl': {
        const ttl = Number(value(i++));
        if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) throw new Error('--ttl must be an integer between 30 and 3600 seconds');
        opts.ttlSec = ttl;
        break;
      }
      case '--lan':
        opts.lan = true;
        break;
      case '--keep-mode':
        opts.keepMode = true;
        break;
      case '--no-wait':
        opts.wait = false;
        break;
      case '--no-pair':
        opts.pair = false;
        break;
      case '--no-auto-update':
        opts.autoUpdate = false;
        break;
      case '--keep-stopped':
        opts.keepStopped = true;
        break;
      case '--no-agent-settings':
        opts.agentSettings = false;
        break;
      case '--no-herdr-service':
        opts.herdrService = false;
        break;
      default:
        throw new Error(`unknown setup option "${a}"`);
    }
  }
  // `remotly-bridge` and `remotly-bridge.service` name the same unit; the file and every systemctl call use the short form.
  opts.unit = opts.unit.replace(/\.service$/, '');
  if (/\.service$/.test(opts.unit)) throw new Error(`--unit ${JSON.stringify(opts.unit)}.service: ".service" twice — give the name alone (setup adds the suffix)`);
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(opts.unit)) throw new Error('--unit must be a plain unit name (letters, digits, . _ -; not starting with -)');
  return opts;
}

/** Merge `LAN_CONFIG` into config.json (created by `loadConfig` first); returns the dotted keys written. */
export function enableLanMode(configPath: string): string[] {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${configPath}: top level must be a JSON object`);
    raw = parsed as Record<string, unknown>;
  }
  const written: string[] = [];
  for (const [section, values] of Object.entries(LAN_CONFIG)) {
    const cur = raw[section];
    const target: Record<string, unknown> = typeof cur === 'object' && cur !== null && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(values)) {
      target[k] = v;
      written.push(`${section}.${k}`);
    }
    raw[section] = target;
  }
  writeConfig(configPath, raw);
  return written;
}

/** Whether config.json holds exactly the LAN triple `enableLanMode` writes. */
export function isLanMode(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const cfg = raw as Record<string, Record<string, unknown> | undefined>;
  return Object.entries(LAN_CONFIG).every(([section, values]) => Object.entries(values).every(([k, v]) => cfg[section]?.[k] === v));
}

/** Undo `enableLanMode`: when config.json holds exactly the LAN triple, drop those keys so the defaults (`auto`) apply again. */
export function disableLanMode(configPath: string): boolean {
  if (!isLanMode(configPath)) return false;
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, Record<string, unknown> | undefined>;
  for (const [section, values] of Object.entries(LAN_CONFIG)) {
    const target = cfg[section];
    if (!target) continue;
    for (const k of Object.keys(values)) delete target[k];
    if (Object.keys(target).length === 0) delete cfg[section];
  }
  writeConfig(configPath, cfg);
  return true;
}

function writeConfig(configPath: string, raw: unknown): void {
  fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${configPath}.tmp`, configPath);
}

/** What `setup` needs from the validated config (FlowConfig satisfies it). */
export interface SetupConfigView {
  tls: { mode: 'auto' | 'tailscale' | 'selfsigned' };
  security: { require_tailnet: 'auto' | boolean };
}

/** `name` or `name.service` → `name.service`: the form every systemctl/journalctl call uses, so `remotly.dev` or an existing `x.timer` cannot be taken for another unit. */
export const unitFile = systemdUnitFile;

export interface SetupDeps {
  version: string;
  exec: ExecFn;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  user: string;
  uid: number;
  /** Node binary the unit runs (see `stableNodePath`) and the bridge's own main.ts. */
  nodePath: string;
  mainPath: string;
  /** The process environment: the installer's REMOTLY_* settings (mirror, launcher dir, runtime) are carried into the update unit. */
  env: NodeJS.ProcessEnv;
  /** `~/.config/systemd/user` (Linux) or `~/Library/LaunchAgents` (macOS). */
  unitDir: string;
  /** `process.platform` of the host; the Tailscale fixes are worded for it. Default `linux`. */
  platform?: string;
  /** A running process's arguments (the herdr unit's main process: which session it serves); default `readProcessArgs`. */
  processArgs?: (pid: number) => Promise<string[] | null>;
  /** A running process's herdr directory, from its environment (`XDG_CONFIG_HOME`, else `HOME/.config`); null when it cannot be read; default `readProcessConfigHome`. */
  processConfigHome?: (pid: number) => string | null;
  /** The pid listening on a Unix socket (the herdr that answers for the session); null when it cannot be told; default `pidListeningOn`. */
  socketPid?: (socketPath: string) => MaybePromise<number | null>;
  /** The manager's unit a process runs under, by its native name (`herdr.service`, a launchd label), when it is one; null for a terminal's process; default `readProcessUnit`. */
  processUnit?: (pid: number) => MaybePromise<string | null>;
  /** A process's executable name (a unit's main process: a terminal emulator, or a wrapper); default `readProcessComm`. */
  processComm?: (pid: number) => MaybePromise<string | null>;
  /** The service manager; default: systemd over `exec`, with `unitDir`, `user`, `uid` and the home above `unitDir`. */
  service?: ServiceManager;
  home?: string;
  configPath: string;
  tlsDir: string;
  herdrSocket: string;
  /** Load (creating on first run) and validate the config; throws ConfigError with the precise problem. */
  loadConfig: () => SetupConfigView;
  herdrPing: (socketPath: string) => Promise<{ version: string; protocol: number }>;
  /** `status` over the control socket; rejects while the daemon is not up. */
  status: (timeoutMs: number) => Promise<ControlStatus>;
  /** Reusable pairing code from the daemon. */
  pair: (ttlSec: number) => Promise<PairInfo>;
  showPairing: (info: PairInfo) => Promise<void>;
  /** Where Claude Code and Codex keep their settings; default from `env` and `home` (`agentDirs`). */
  agentDirs?: AgentDirs;
  /** What became of those settings on this install; default `agent-settings.json` beside `configPath`. */
  agentRecord?: string;
  /** Whether Claude Code runs for this user; default a look at the processes (`claudeRunning`). */
  claudeRunning?: () => boolean;
  /** The `herdr` binary the herdr service runs, absolute; null when there is none. Default: the first in `herdrSearchDirs` (`findExecutable`), else the one the unit already runs; asked again while setup waits for herdr. */
  herdrBinary?: () => string | null;
  /** Whether a path is an executable file (tests stand in for the file system). */
  executable?: (p: string) => boolean;
}

type Check =
  | { ok: true; note: string; warn?: string }
  | { ok: false; problem: string; fix: string[]; retryMs?: number; /** No point polling: the user must act and re-run. */ stop?: boolean };

/** Major version of the node binary at `p`, or null when it does not run. */
export function nodeMajor(p: string): number | null {
  try {
    const v = execFileSync(p, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const major = Number(v.trim().split('.')[0]);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
}

/**
 * The node path the unit should run. fnm's per-shell `multishells/<pid>` links vanish with the shell, so prefer its
 * `default` alias when the caller runs an fnm node and the alias is Node ≥ 24 (it may still point at an older
 * version). A Homebrew node runs from `<prefix>/Cellar/<formula>/<version>/bin/node` (process.execPath is that real
 * path even when a link was called), which brew removes on upgrade: a link brew repoints is used instead when it
 * leads to the same binary — `<prefix>/bin/node` (the node the user's shell runs), else `<prefix>/opt/<formula>/bin/node`
 * (a keg-only formula such as `node@24` has no `bin/node` link; its `opt` path follows every upgrade). Otherwise the
 * real path (a version manager's install dir, the installer's private runtime, or a system node), which stays valid
 * across shells.
 */
export function stableNodePath(
  execPath: string,
  home: string,
  io: { exists?: (p: string) => boolean; realpath?: (p: string) => string; major?: (p: string) => number | null } = {},
): string {
  const exists = io.exists ?? fs.existsSync;
  const realpath = io.realpath ?? fs.realpathSync;
  const major = io.major ?? nodeMajor;
  const alias = path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node');
  if (execPath.includes(`${path.sep}fnm${path.sep}`) && exists(alias) && (major(alias) ?? 0) >= 24) return alias;
  let real: string;
  try {
    real = realpath(execPath);
  } catch {
    return execPath;
  }
  const cellar = real.indexOf('/Cellar/');
  if (cellar > 0) {
    const prefix = real.slice(0, cellar);
    const formula = real.slice(cellar + '/Cellar/'.length).split('/')[0] ?? '';
    const links = [path.join(prefix, 'bin', 'node'), ...(formula ? [path.join(prefix, 'opt', formula, 'bin', 'node')] : [])];
    for (const link of links) {
      try {
        if (exists(link) && realpath(link) === real) return link;
      } catch {
        /* a dangling link: the next one, else the real path below */
      }
    }
  }
  return real;
}

/** Shell single-quoting for a generated script (`'` → `'\''`); a newline is refused, the unit could not carry the path anyway. */
function sq(s: string): string {
  if (s.includes('\n')) throw new Error(`cannot put ${JSON.stringify(s)} in a shell script (newline)`);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A word in a command the user is to paste: as it is when plain, single-quoted otherwise (a session name with a space). */
/**
 * The line that stops the herdr the bridge follows, for a user to paste: the unit's own prefix before `herdr … server
 * stop`. A pane's shell has HERDR_SOCKET_PATH and HERDR_SESSION set by the herdr that runs it, and a bare `herdr server
 * stop` follows them to that pane's own session (probed with herdr 0.8.0; `--session NAME` beats both), and it has
 * that herdr's XDG_CONFIG_HOME, under which the same session name is another socket. Unset and pinned, the line
 * reaches the socket the bridge follows from any shell — through the herdr the unit runs, by its path (setup may
 * have found it off this shell's PATH: under ~/.local/bin in an unattended run, or in the unit it already wrote).
 */
/** "a", "a and b", "a, b and c". */
export function listOf(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function herdrStopCommand(session: string | undefined, configHome: string, herdrPath: string): string {
  return `env -u HERDR_SESSION -u HERDR_SOCKET_PATH ${shellWord(`${HERDR_CONFIG_HOME_VAR}=${configHome}`)} ${shellWord(herdrPath)}${session ? ` --session ${shellWord(session)}` : ''} server stop`;
}

export function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : sq(s);
}

export const repairScriptPath = (home: string): string => path.join(home, 'repair-app.sh');
/** Present while a setup is installing `unit`'s update timer; a later setup finding it knows that timer's "disabled" is not the user's word (one per timer: two units may share one install). */
export const timerMarkerPath = (home: string, unit: string): string => path.join(home, `${updateUnitNames(unit).timer}.enabling`);

/**
 * What both units run first (`ExecStartPre`) on an installed release: an install or a rollback stopped between its two
 * renames (power loss) leaves no `app/` at all, and nothing that could repair it would start — this puts the previous
 * copy back, else the new one (never a failed one); a private `node/` likewise from `node.old`. Nothing when app/ is
 * there in any form, and nothing while an install or update holds `update.lock` (they are between their renames on
 * purpose). Two units starting together run it twice: `update.lock.repair` puts the second in line behind the first,
 * so it finds the copy back rather than its unit starting over a directory still being moved. The locks are flock(2):
 * flock(1) where there is one (Linux), else perl's — macOS has no flock(1), and the installer and `update` lock with
 * perl there (platform/lock.ts) — which runs the script again under both locks; without either tool the repair runs
 * unlocked, as before.
 */
export function renderRepairScript(home: string): string {
  // perl: queue on update.lock.repair, try update.lock (taken → another run is between its renames: nothing to do),
  // keep both descriptors across exec, run the script again (REMOTLY_REPAIR_LOCKED says: locked already).
  const perl = [
    'use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC);',
    'my ($lock, $script) = @ARGV;',
    'open(my $q, ">>", "$lock.repair") or exit 0;',
    'flock($q, LOCK_EX) or exit 0;',
    'open(my $l, ">>", $lock) or exit 0;',
    'flock($l, LOCK_EX | LOCK_NB) or exit 0;',
    'for my $fh ($q, $l) { fcntl($fh, F_SETFD, fcntl($fh, F_GETFD, 0) & ~FD_CLOEXEC) or exit 0; }',
    'exec "/bin/sh", $script or exit 0;',
  ].join(' ');
  if (perl.includes("'")) throw new Error('the perl lock program cannot carry a single quote');
  return [
    '#!/bin/sh',
    '# Written by `remotly-bridge setup`; run by the bridge unit and the update unit before they start. Puts app/ back',
    '# when an install or a rollback was stopped between its two renames (the previous copy first, else the new one),',
    '# and a private node/ back from node.old (else node.new). Nothing while an install or update holds update.lock: it',
    '# is between its renames on purpose. Repairs run one after another (update.lock.repair): the second waits for the',
    '# first and then finds nothing left to do, so its unit starts on a copy that is there.',
    `app=${sq(path.join(home, 'app'))}`,
    `node=${sq(path.join(home, 'node'))}`,
    `lock=${sq(path.join(home, 'update.lock'))}`,
    'need() { [ ! -e "$app" ] || { [ ! -e "$node" ] && { [ -d "$node.old" ] || [ -d "$node.new" ]; }; }; }',
    'need || exit 0',
    'if command -v flock >/dev/null 2>&1; then exec 8>"$lock.repair"; flock 8; exec 9>"$lock"; flock -n 9 || exit 0;',
    'elif [ -z "${REMOTLY_REPAIR_LOCKED:-}" ] && command -v perl >/dev/null 2>&1; then export REMOTLY_REPAIR_LOCKED=1; exec perl -e ' + `'${perl}'` + ' "$lock" "$0"; fi',
    'if [ ! -e "$app" ]; then if [ -d "$app.prev" ]; then mv "$app.prev" "$app"; elif [ -d "$app.new" ]; then mv "$app.new" "$app"; fi; fi',
    'if [ ! -e "$node" ]; then if [ -d "$node.old" ]; then mv "$node.old" "$node"; elif [ -d "$node.new" ]; then mv "$node.new" "$node"; fi; fi',
    'exit 0',
    '',
  ].join('\n');
}

/** The systemd unit (Linux); launchd agents are rendered by the service manager (platform/service.ts). */
export const renderUnit = renderSystemdUnit;

/** The two units of the daily update: `<unit>-update.service` (oneshot, runs `update`) and `<unit>-update.timer`. */
export const updateUnitNames = systemdUpdateNames;

/** The installer settings a later `update` has to repeat, as its unit's Environment= lines: where releases come from, where Node comes from, the launcher directory, the runtime. */
export { INSTALLER_ENV };

/**
 * What the update unit must carry so that an unattended run installs the same way the hand-run installer did: a
 * mirror (REMOTLY_RELEASE_URL, REMOTLY_NODE_DIST) and a launcher directory (REMOTLY_BIN_DIR) from the environment —
 * the installer exports them to `setup` — or the launcher found on PATH; the runtime (REMOTLY_NODE) is the unit's own
 * Node unless it is the private one under `<home>/node`, which the installer refreshes itself.
 */
export function installerEnv(env: NodeJS.ProcessEnv, nodePath: string, mainPath: string, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['REMOTLY_RELEASE_URL', 'REMOTLY_NODE_DIST', 'REMOTLY_BIN_DIR'] as const) {
    const v = env[k]?.trim();
    if (v) out[k] = v;
  }
  if (!out['REMOTLY_BIN_DIR']) {
    const bin = launcherDir((env['PATH'] ?? '').split(path.delimiter), mainPath);
    if (bin) out['REMOTLY_BIN_DIR'] = bin;
  }
  if (!nodePath.startsWith(path.join(home, 'node') + path.sep)) out['REMOTLY_NODE'] = nodePath;
  return out;
}

/** The systemd update units (Linux); see renderUnit. */
export const renderUpdateUnits = renderSystemdUpdateUnits;

/** `name` is null only for `cert: false` checks on a tailnet without MagicDNS. */
export type TailnetState = { ok: true; ip: string | null; name: string | null } | { ok: false; problem: string; fix: string[] };

/**
 * What stands between this host and a working Tailscale, in the order the user has to fix it. `cert: true` (default)
 * goes on to what a certificate needs — MagicDNS and "HTTPS Certificates"; `cert: false` stops at a logged-in node,
 * which is all the tailnet gate needs.
 */
export function classifyTailnet(status: TailscaleStatus | null, binaryPresent: boolean, opts: { cert?: boolean; platform?: string } = {}): TailnetState {
  const h = tailscaleHints(opts.platform ?? 'linux');
  if (!binaryPresent) return { ok: false, problem: 'Tailscale is not installed', fix: h.install };
  if (!status) return { ok: false, problem: 'tailscaled is not running', fix: h.daemon };
  const state = status.BackendState ?? 'unknown';
  if (state !== 'Running') {
    return { ok: false, problem: state === 'NeedsLogin' ? 'Tailscale is not logged in' : `Tailscale is not running (state ${state})`, fix: [h.up] };
  }
  // The same reading of "up" as serve's start-up wait (tailscale.ts selfIdentified): a Running node whose status has no
  // Self.UserID would pass here and then keep serve waiting, and the gate could identify nobody.
  if (!selfIdentified(status)) {
    return { ok: false, problem: 'Tailscale is running but its status carries no identity for this node (Self.UserID) — the tailnet gate could not tell your phones from strangers', fix: h.identity };
  }
  const ip = status.Self?.TailscaleIPs?.find((a) => !a.includes(':')) ?? null;
  const name = magicDnsName(status);
  if (opts.cert === false) return { ok: true, ip, name };
  if (!name) return { ok: false, problem: 'MagicDNS is off for this tailnet (the certificate is issued for the machine\'s DNS name)', fix: [`enable MagicDNS:  ${TAILSCALE_DNS_ADMIN}`] };
  if (!status.CertDomains?.length) {
    return { ok: false, problem: 'HTTPS Certificates are not enabled for this tailnet (iPhones refuse the self-signed fallback)', fix: [`enable "HTTPS Certificates":  ${TAILSCALE_DNS_ADMIN}`] };
  }
  return { ok: true, ip, name };
}

/** Why `tailscale cert` failed and whether polling makes sense (`retry`) or the user has to look at it. */
export function classifyCertFailure(output: string, user: string, name: string, tlsMode: 'auto' | 'tailscale' = 'auto', platform = 'linux'): { problem: string; fix: string[]; retry: boolean } {
  if (/access denied/i.test(output)) {
    return { problem: 'Tailscale refuses certificate requests from this user', fix: [tailscaleHints(platform).certDenied(user)], retry: true };
  }
  if (/not enabled|not configured/i.test(output)) {
    return { problem: 'HTTPS Certificates are not enabled for this tailnet', fix: [`enable "HTTPS Certificates":  ${TAILSCALE_DNS_ADMIN}`], retry: true };
  }
  const then =
    tlsMode === 'tailscale'
      ? 'tls.mode is "tailscale", so the bridge does not start without it — or set tls.mode to "auto" to allow the self-signed fallback'
      : 'until it works the bridge uses a self-signed certificate, which iPhones refuse';
  return { problem: `tailscale cert failed: ${output.trim().slice(0, 300) || 'no output'}`, fix: [`run  tailscale cert ${name}  by hand to see the full error; ${then}`], retry: false };
}

/** `$XDG_CONFIG_HOME/systemd/user`, the directory the user manager reads (default `~/.config/systemd/user`). */
export const systemdUserDir = (env: NodeJS.ProcessEnv, home: string): string => serviceUnitDir('linux', env, home);

/**
 * Where the daemon finds herdr, the same way the checks below and `serve` do: flags first; an explicit `--herdr-session`
 * drops an inherited HERDR_SOCKET_PATH (a herdr pane exports one, and the socket would otherwise win); with no flags,
 * whatever this shell inherited is validated and therefore written into the unit too.
 */
export function reconcileHerdrEnv(opts: SetupOptions, env: NodeJS.ProcessEnv, configured: { socket?: string | null; session?: string | null } = {}): void {
  // config.json's herdr.socket / herdr.session are authoritative for `serve` (an environment socket would still beat a
  // configured session there, so it must not reach the unit): with them set, flags are refused rather than silently
  // ignored, and nothing inherited from the shell is checked or persisted.
  if (configured.socket || configured.session) {
    if (opts.herdrSocket || opts.herdrSession) {
      const which = configured.socket ? `herdr.socket = ${configured.socket}` : `herdr.session = ${configured.session}`;
      throw new Error(`config.json already selects herdr (${which}); serve uses that, so --herdr-socket / --herdr-session would be ignored — change config.json instead, or drop the flag`);
    }
    delete env['HERDR_SOCKET_PATH'];
    delete env['HERDR_SESSION'];
    return;
  }
  const explicitSocket = opts.herdrSocket;
  if (explicitSocket) env['HERDR_SOCKET_PATH'] = explicitSocket;
  else if (opts.herdrSession) delete env['HERDR_SOCKET_PATH'];
  else if (env['HERDR_SOCKET_PATH']) env['HERDR_SOCKET_PATH'] = opts.herdrSocket = path.resolve(expandHome(env['HERDR_SOCKET_PATH'])); // one absolute value for the check and the unit
  if (opts.herdrSession) env['HERDR_SESSION'] = opts.herdrSession;
  else if (env['HERDR_SESSION'] && !explicitSocket) opts.herdrSession = env['HERDR_SESSION'];
}

async function waitFor(deps: SetupDeps, opts: SetupOptions, check: () => Promise<Check>): Promise<boolean> {
  const deadline = deps.now() + MAX_WAIT_MS;
  let announced: string | null = null;
  for (;;) {
    const r = await check();
    if (r.ok) {
      deps.out(`  ✔ ${r.note}`);
      if (r.warn) deps.out(`  ⚠ ${r.warn}`);
      return true;
    }
    if (announced !== r.problem) {
      deps.out(`  ✖ ${r.problem}`);
      for (const f of r.fix) deps.out(`      ${f}`);
      if (!opts.wait || r.stop) return false;
      if (announced === null) deps.out('    waiting — setup continues by itself once that is done (Ctrl-C and run `remotly-bridge setup` again any time)');
      announced = r.problem;
    }
    if (deps.now() >= deadline) {
      deps.out(`  ✖ gave up after ${MAX_WAIT_MS / 60_000} minutes; run \`remotly-bridge setup\` again when ready`);
      return false;
    }
    await deps.sleep(r.retryMs ?? POLL_MS);
  }
}

async function run(deps: SetupDeps, cmd: string, args: string[]): Promise<string> {
  const r = await deps.exec(cmd, args, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code ?? 'no exit code'}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
}

/** The first executable file called `name` in `pathDirs` (PATH, split), absolute; null when there is none. */
export function findExecutable(name: string, pathDirs: string[], isExecutable: (p: string) => boolean = executableFile): string | null {
  for (const dir of pathDirs) {
    if (!dir || !path.isAbsolute(dir)) continue; // a relative PATH entry depends on the shell's directory: not for a unit
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

/**
 * Where `herdr` is looked for: setup's PATH first, then where installers put a user's tools (herdr's own goes to
 * `~/.local/bin`) — a unit's PATH, which an unattended update runs with, has none of those.
 */
export function herdrSearchDirs(env: Record<string, string | undefined>, home: string): string[] {
  const dirs = [...(env['PATH'] ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set(dirs.filter((d) => d))];
}

export interface HerdrArgs {
  herdrPath: string;
  session?: string;
  /** herdr's directory as the unit pins it (`XDG_CONFIG_HOME=…` among env's arguments); not in a process's own arguments. */
  configHome?: string;
}

/** A herdr unit's target in words: its session, and its directory when that is not the one wanted. */
export function describeHerdr(a: HerdrArgs | null, configHome: string): string {
  const base = a?.session ? `session ${a.session}` : 'the default session';
  return a?.configHome !== undefined && a.configHome !== configHome ? `${base} under ${path.join(a.configHome, 'herdr')}` : base;
}

/**
 * `herdr [--session <name>] server` as an argument vector, with or without the `env -u …` setup's units put ahead of
 * it (HERDR_ENV_PREFIX: launchd shows the arguments it spawned, env's; /proc shows herdr's own, after the exec) — and
 * nothing else.
 */
export function herdrArgv(argv: string[] | null): HerdrArgs | null {
  if (!argv) return null;
  const prefixed = argv.length > HERDR_ENV_PREFIX.length && HERDR_ENV_PREFIX.every((t, i) => argv[i] === t);
  let rest = argv;
  let pinned: { configHome: string } | Record<string, never> = {};
  if (prefixed) {
    // env's arguments: after the two -u, the directory pinned (absolute), then herdr's own.
    const assign = new RegExp(`^${HERDR_CONFIG_HOME_VAR}=(.*)$`).exec(argv[HERDR_ENV_PREFIX.length] as string);
    if (!assign || !path.isAbsolute(assign[1] as string)) return null;
    pinned = { configHome: assign[1] as string };
    rest = argv.slice(HERDR_ENV_PREFIX.length + 1);
  }
  const [bin, ...args] = rest;
  if (!bin || !path.isAbsolute(bin) || path.basename(bin) !== 'herdr' || args.at(-1) !== 'server') return null;
  if (args.length === 1) return { herdrPath: bin, ...pinned };
  return args.length === 3 && args[0] === '--session' && args[1] ? { herdrPath: bin, session: args[1], ...pinned } : null;
}

/** The words of a systemd command line as setup writes them — `"quoted"` (with `%%` for `%`) or bare — or null for anything else on the line. */
function unitLineWords(line: string): string[] | null {
  const words: string[] = [];
  const re = /\s*(?:"([^"\n]*)"|([^\s"]+))/y;
  for (let i = 0; i < line.length; i = re.lastIndex) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (!m) return null;
    words.push(((m[1] ?? m[2]) as string).replace(/%%/g, '%'));
  }
  return words;
}

/**
 * What a herdr unit setup wrote runs, read back from the file: the marker line every such unit carries
 * (HERDR_UNIT_MARKER), and the one shape setup writes — the systemd `ExecStart` line (paths quoted, `%%` for `%`) or
 * the plist's ProgramArguments, `herdr [--session <name>] server`, nothing else. null for any other file: one setup did
 * not write (a wrapper, a hand-made unit under the same name), or one it wrote that was edited into another shape.
 * Ownership is this, so every shape setup ever wrote has to be read here.
 */
/** The marker where the renderers put it — the first line of a systemd unit, the comment right after `<plist version="1.0">` — not anywhere in the text. */
const hasHerdrMarker = (text: string): boolean => text.startsWith(`# ${HERDR_UNIT_MARKER}`) || text.includes(`<plist version="1.0">\n<!-- ${HERDR_UNIT_MARKER}`);

export function herdrUnitArgs(text: string, label?: string): HerdrArgs | null {
  if (!hasHerdrMarker(text)) return null;
  let words: string[] | null;
  if (text.startsWith('# ')) {
    // systemd: one ExecStart directive in the whole file (systemd takes whitespace around `=`; a second one after an
    // empty one, which resets, is what runs), in the shape setup writes.
    if ((text.match(/^\s*ExecStart\s*=/gm) ?? []).length !== 1) return null;
    const sd = /^ExecStart=(.*)$/m.exec(text);
    words = sd ? unitLineWords(sd[1] as string) : null;
  } else {
    // launchd: the root dictionary as XML has it (keys decoded, each once, one whole document) — the agent's Label, one
    // ProgramArguments of strings, no Program (launchd would run that, with the array as its argv), and the start as
    // setup writes it: RunAtLoad and KeepAlive true, not Disabled (a plist that would not start at login starts nothing).
    const root = xmlPlistRoot(text);
    if (root === null || root.has('Program')) return null;
    const lbl = root.get('Label');
    if (lbl === undefined || lbl.kind !== 'string' || lbl.value === '' || (label !== undefined && lbl.value !== label)) return null;
    const bool = (k: string, want: boolean, absent: boolean): boolean => {
      const v = root.get(k);
      return v === undefined ? absent : v.kind === 'bool' && v.value === want;
    };
    if (!bool('RunAtLoad', true, false) || !bool('KeepAlive', true, false) || !bool('Disabled', false, true)) return null;
    const pa = root.get('ProgramArguments');
    words = pa !== undefined && pa.kind === 'strings' ? pa.items : null;
  }
  // A file is setup's only with the env prefix in front (a process may show herdr's own arguments; a file may not).
  return words !== null && words.length > HERDR_ENV_PREFIX.length && HERDR_ENV_PREFIX.every((t, i) => words[i] === t) ? herdrArgv(words) : null;
}

/** What stands at a herdr unit's path: nothing, a file setup wrote (and what it runs), or something else — a symlink, another file. */
export type HerdrUnitFile = { kind: 'absent' } | { kind: 'foreign'; why: string } | { kind: 'owned'; args: HerdrArgs };

/**
 * On a Mac, launchd's own reading of a plist of setup's: plutil's verdict (a document this read as well-formed but
 * CoreFoundation rejects — an encoding it does not take, say — starts nothing). No plutil to be had: the text's word stands.
 */
export async function lintedPlist(file: HerdrUnitFile, unitPath: string, sm: ServiceManager, exec: ExecFn): Promise<HerdrUnitFile> {
  if (file.kind !== 'owned' || sm.kind !== 'launchd') return file;
  const r = await exec(PLUTIL, ['-lint', '-s', unitPath]);
  if (r.code === 0) return file;
  if (r.code === null) return { kind: 'foreign', why: `a plist ${PLUTIL} could not check (${r.stderr.trim() || 'it did not run'})` };
  return { kind: 'foreign', why: `a plist plutil rejects (${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`})` };
}

/**
 * `label`: the launchd label a plist must declare (ignored for a systemd unit, which has none). `render`: what setup
 * writes for a file's arguments — given, the file is setup's only when it is exactly that: its marker, its one
 * command, nothing more. A directive or key added since (a condition, a working directory, a load gate: anything that
 * changes what runs or whether it starts) is a change setup does not read, so the file is left as it is.
 */
export function herdrUnitFile(file: string, label?: string, render?: (args: HerdrArgs) => string): HerdrUnitFile {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isSymbolicLink()) return { kind: 'foreign', why: 'a symlink' };
  if (!st.isFile()) return { kind: 'foreign', why: 'not a regular file' };
  const text = readTextIfAny(file);
  if (text === null) return { kind: 'foreign', why: 'a file that cannot be read' };
  if (!hasHerdrMarker(text)) return { kind: 'foreign', why: 'a unit file setup did not write' };
  const args = herdrUnitArgs(text, label);
  if (args === null) return { kind: 'foreign', why: 'a unit file of another shape' };
  if (render !== undefined) {
    let expected: string | null;
    try {
      expected = render(args);
    } catch {
      expected = null;
    }
    if (expected !== text) return { kind: 'foreign', why: 'a unit file changed since setup wrote it' };
  }
  // A drop-in beside the file (`systemctl --user edit` makes `<unit>.d/override.conf`, effective after the next
  // reload) is the user's arrangement for the unit: no longer what setup wrote alone (dropInAgainst). Drop-ins from
  // the other load paths are the manager's to list: `unitSourceCheck`.
  const against = dropInAgainst(dropInsBeside(file));
  return against === null ? { kind: 'owned', args } : { kind: 'foreign', why: against };
}

function dropInsBeside(file: string): string[] {
  try {
    return fs
      .readdirSync(`${file}.d`)
      .filter((n) => n.endsWith('.conf'))
      .sort()
      .map((n) => path.join(`${file}.d`, n));
  } catch {
    return [];
  }
}

/**
 * A drop-in merged into the unit is the user's arrangement for it, and the unit is theirs from then on, whatever the
 * drop-in sets: there is hardly a directive whose value cannot decide whether the start succeeds (`StandardOutput=file:`
 * where the user may not write, `Nice=` below what an unprivileged manager may set, a `Limit*` above the hard limit,
 * `TasksMax=0`, …) or what runs (`Exec*`, `Environment=LD_PRELOAD=`), and setup vouches for nothing it does not read.
 * The one exception: a type-level drop-in (`service.d/*.conf`) under one of the system's load paths for user units
 * (SYSTEM_USER_UNIT_DIRS: root's to write — Fedora ships two for every user service) is the baseline every service of
 * every user runs under, the bridge's own unit included, which setup starts and checks; it counts only when it is more
 * than that baseline — a directive outside TYPE_LEVEL_ALLOWED, a specifier that differs per unit (UNIT_SPECIFIER) —
 * or cannot be read. The same file under the user's own load paths is their arrangement.
 */
export const SYSTEM_USER_UNIT_DIRS: readonly string[] = [
  '/etc/systemd/user', '/etc/xdg/systemd/user', '/run/systemd/user',
  '/usr/local/lib/systemd/user', '/usr/local/share/systemd/user', '/usr/lib/systemd/user', '/lib/systemd/user', '/usr/share/systemd/user',
];
/**
 * What a system type-level drop-in may set and still be the baseline rather than an arrangement against one unit:
 * timeouts and failure modes, memory-pressure handling, scheduling weights, stop behaviour, logging — each the same
 * for every service, none naming a unit or deciding per unit, none a cap. Not `Exec*`, `Condition*`, `Assert*`,
 * `Type`, not `Environment*` (a variable one program reads and another does not), nothing that names units
 * (`Conflicts=`, `Wants=`, `OnFailure=`, …), nothing about restarting (a `Restart=on-failure` would leave a
 * `herdr server stop` down for good, against the unit's `Restart=always`; a `RestartSec=` can be anything), no cap
 * one program fits under and another does not (`MemoryMax=`, `TasksMax=`, `CPUQuota=`, `Limit*=`, `OOMPolicy=`: the
 * bridge, which setup starts and verifies in the same run, is the smaller program, so its start says nothing of
 * herdr's), nothing unknown. Fedora's two files set `TimeoutStopFailureMode` and `ManagedOOMMemoryPressure*`; the
 * latter stays allowed: systemd-oomd acts on a service's own sustained memory stall (a herdr thrashing serves nobody,
 * and `Restart=always` brings it back), Fedora sets it for every user service as shipped, and refusing it would
 * refuse the herdr service on every Fedora.
 */
const TYPE_LEVEL_ALLOWED = new Set([
  'TimeoutStopFailureMode', 'TimeoutStartFailureMode', 'TimeoutStopSec', 'TimeoutStartSec', 'TimeoutAbortSec', 'TimeoutSec',
  'ManagedOOMMemoryPressure', 'ManagedOOMMemoryPressureLimit', 'ManagedOOMMemoryPressureDurationSec', 'ManagedOOMSwap', 'ManagedOOMPreference',
  'OOMScoreAdjust', 'Nice', 'CPUWeight', 'IOWeight',
  'KillMode', 'KillSignal', 'FinalKillSignal', 'SendSIGHUP', 'SendSIGKILL',
  'LogRateLimitIntervalSec', 'LogRateLimitBurst', 'LogLevelMax', 'LogExtraFields', 'SyslogIdentifier', 'SyslogLevel', 'SyslogFacility', 'StandardOutput', 'StandardError',
  'Description', 'Documentation',
]);
/** The specifiers whose value differs from unit to unit — name, prefix, instance, unit file path, credentials directory, the unit's own cgroup path `%c` (systemd.unit(5)): `StandardOutput=append:%t/%N.log` is one file per unit, and `EnvironmentFile=%h/.config/%p.env` fails one unit and not another. */
const UNIT_SPECIFIER = /%[cdfiIjJnNpPyY]/;

/**
 * What in a system type-level drop-in's text makes it more than the baseline, or null: a directive outside
 * TYPE_LEVEL_ALLOWED, a value carrying a per-unit specifier, a line this does not read. Lines are
 * read as systemd reads them (systemd.syntax(7), conf-parser.c): a byte order mark is skipped; a comment line (`#` or
 * `;` first) is dropped before anything else, inside a continuation too; a line ending in an unescaped backslash
 * continues on the next, which is then value, not directive; `\\` is an escaped backslash. A carriage return is not read.
 */
export function typeLevelAgainst(text: string): string | null {
  let continued = false; // the line before ended in a backslash: this one is the rest of its value
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith(';')) continue;
    if (line.includes('\r')) return `with a line this does not read (${t.slice(0, 40)})`;
    if (UNIT_SPECIFIER.test(line)) return 'that varies by unit';
    const wasContinued = continued;
    continued = endsInContinuation(line);
    if (wasContinued) continue;
    if (t === '' || /^\[[^\]]+\]$/.test(t)) continue;
    const m = /^([A-Za-z]\w*)\s*=/.exec(t);
    if (!m) return `with a line this does not read (${t.slice(0, 40)})`;
    const d = m[1] as string;
    if (!TYPE_LEVEL_ALLOWED.has(d)) return `overriding ${d}`;
  }
  return null;
}

/** Whether a line ends in an unescaped backslash — systemd's test for a continuation (each backslash escapes the character after it). */
function endsInContinuation(line: string): boolean {
  let escaped = false;
  for (const ch of line) escaped = escaped ? false : ch === '\\';
  return escaped;
}

/** Whether `file` is a type-level drop-in of the system's: `<system load path>/service.d/<name>.conf`. */
function systemTypeLevelDropIn(file: string, systemDirs: readonly string[]): boolean {
  const dir = path.dirname(file);
  return path.basename(dir) === 'service.d' && systemDirs.includes(path.dirname(dir));
}

/**
 * The first drop-in that takes the unit out of setup's hands, as the reason, or null: any of the unit's own (one
 * under the user's load paths too; a path systemctl printed in a form this did not parse ends up here as well); a
 * system type-level one that cannot be read, or that is more than the baseline (typeLevelAgainst).
 */
function dropInAgainst(files: string[], systemDirs: readonly string[] = SYSTEM_USER_UNIT_DIRS): string | null {
  for (const f of files) {
    if (!systemTypeLevelDropIn(f, systemDirs)) return `a unit with a drop-in (${f})`;
    const text = readTextIfAny(f);
    if (text === null) return `a unit with a drop-in that cannot be read (${f})`;
    const against = typeLevelAgainst(text);
    if (against !== null) return `a unit with a drop-in ${against} (${f})`;
  }
  return null;
}

/**
 * The other herdr units setup wrote for the same session under the same directory — another bridge unit's
 * (`<other>-herdr`, in the manager's unit directory), as `{ unit, bridge }` — that start it at boot as setup would:
 * the file setup's own (marker, shape, the exact rendering for bridge unit `x`), its `herdr` there to run, the unit
 * enabled (not disabled, masked, a label another plist declares, unreadable), known to the manager and loaded by it
 * from that very file (the path it names) with no drop-in of its own — or, on a Mac, standing unbootstrapped (a plist
 * launchd names no path for, enabled: the next login loads it, as it does setup's own after a setup over a herdr
 * started by hand). Two bridges following one session must not each start a herdr for it: at boot both
 * would bind the same socket, one failing and restarting forever. Such a unit is the session's provider; a second
 * bridge installs none while it stands (setup and doctor name it). Anything short of it is nobody's provider.
 */
export async function otherHerdrUnits(sm: ServiceManager, unit: string, session: string | undefined, configHome: string, executable: (p: string) => boolean = executableFile): Promise<OtherHerdrUnit[]> {
  let names: string[];
  try {
    names = fs.readdirSync(sm.unitDir);
  } catch {
    return [];
  }
  const own = herdrUnit(unit);
  const out: OtherHerdrUnit[] = [];
  for (const n of names.sort()) {
    const m = sm.kind === 'launchd' ? /^dev\.remotly\.(.+-herdr)\.plist$/.exec(n) : /^(.+-herdr)\.service$/.exec(n);
    if (!m || m[1] === own) continue;
    const other = m[1] as string;
    const bridge = other.slice(0, -'-herdr'.length);
    const render = (a: HerdrArgs): string => sm.renderHerdrUnit({ unit: bridge, herdrPath: a.herdrPath, session: a.session, configHome: a.configHome ?? '' });
    const file = herdrUnitFile(sm.unitPath(other), sm.kind === 'launchd' ? sm.unitName(other) : undefined, render);
    if (file.kind !== 'owned' || (file.args.session ?? '') !== (session ?? '') || file.args.configHome !== configHome) continue;
    const st = await sm.state(other);
    if (st === null || st.load !== 'loaded') continue; // the manager does not know it (never reloaded), or does not answer
    const src = await sm.source(other);
    const unloaded = sm.kind === 'launchd' && st.sub === 'not loaded'; // a plist launchd has not bootstrapped (setup over a herdr started by hand enables one and leaves it so until the next login, which loads it): no path to ask for, and a provider all the same
    if (!unloaded && (src === null || src.path !== sm.unitPath(other))) continue; // not loaded from that file: a unit from another load path, a label bootstrapped from another plist, no answer — what runs under the name is not this file's
    if (unitSourceCheck(src, sm.unitPath(other), sm.name) !== null) continue; // a drop-in of its own: what it runs is not this file's either
    // What the manager runs under the name is this file's. Short of a provider — disabled (without --now), or its herdr
    // gone since it started — but running the session now: a runner, stopped through the manager in the hand-over
    // lines, since a `herdr server stop` alone would have its Restart=always bring it back against ours.
    const { atBoot, activators, pullers, stoppedWith } = await sm.startsAtBoot(sm.unitName(other)); // a timer or socket of the user's own that triggers it, a unit that upholds it, a target that wants it: a stop or disable of the unit alone would not hold; what the manager stops with it is named wherever a line stops it
    const runner: OtherHerdrUnit = { unit: other, bridge, role: 'runner', activators: [], pullers: [], stoppedWith };
    const running = st.active === 'active';
    if (!executable(file.args.herdrPath)) { if (running) out.push(runner); continue; } // nothing it could start
    const standing = await sm.enabledState(other);
    const enabled = standing.state === 'enabled'; // else: not starting at boot on its own, or not established
    const twin = standing.state.startsWith('defined by ') ? standing.state.slice('defined by '.length) : null; // launchd: another plist declares the label — it loads at login, whatever is done to this file's
    if (enabled) out.push({ unit: other, bridge, role: 'provider', activators, pullers, stoppedWith });
    else if (atBoot === null && activators.length + pullers.length > 0) out.push({ unit: other, bridge, role: 'possible', activators, pullers, stoppedWith }); // the user's timer or target may start the session at boot: not the provider, not nothing
    else if (twin !== null) out.push({ unit: other, bridge, role: 'possible', activators, pullers: [{ unit: twin, how: 'declares the label too (a plist launchd loads at login)' }], stoppedWith });
    else if (running) out.push(runner);
  }
  return out;
}

/**
 * Another bridge's herdr unit for the session: its `provider` (enabled, loaded from its file, no drop-in: it starts
 * the session at boot); a `possible` (not enabled, but a unit of the user's own — a timer — triggers or upholds it:
 * whether it starts the session at boot is that unit's arrangement, so no take-over at boot is claimed beside it); or
 * a `runner` (short of either, but running it now). `activators`: those units of the user's, named with it in every
 * line that stops or disables it (stopped alone, a timer would start it again).
 */
export interface OtherHerdrUnit {
  unit: string;
  bridge: string;
  role: 'provider' | 'possible' | 'runner';
  activators: string[];
  pullers: { unit: string; how: string }[];
  stoppedWith: string[];
}

/**
 * How a unit that runs or may start herdr — one of the user's own, or another bridge's — is turned off, as far as
 * lines for the user to paste can: `now` stops it with what would start it again (its triggers and upholders) and
 * turns off what is enabled among them; `later` turns off what is enabled among them from the next boot, or is null
 * when nothing is (a `static` unit, a disabled one a target of the user's pulls in: nothing here to disable);
 * `unheld` says, in words, what neither line undoes — the units that pull it in, a trigger of its own arrangement —
 * so no line claims more than it does; `stops`: the units `now` stops as a whole, every one named where the line
 * says what it ends; `alongside`: what the manager stops with them (a unit that requires it, a part of it), named
 * there too.
 */
export interface OffPlan {
  now: string;
  later: string | null;
  unheld: string[];
  stops: string[];
  alongside: string[];
  state: string;
}

/** "and whatever else X and Y run, and Z, which the manager stops with them (and whatever depends on those)": the tail of a line that stops units as a whole. */
export function stopsEnd(plans: OffPlan[], prefix: string, suffix = '', elseWord = ''): string {
  const stops = [...new Set(plans.flatMap((p) => p.stops))];
  const alongside = [...new Set(plans.flatMap((p) => p.alongside))].filter((u) => !stops.includes(u));
  if (stops.length === 0) return '';
  return `${prefix}whatever ${elseWord}${listOf(stops)} run${stops.length > 1 ? '' : 's'}${suffix}${alongside.length > 0 ? `, and ${listOf(alongside)}, which the manager stops with ${stops.length > 1 ? 'them' : 'it'} (and whatever depends on those)` : ''}`;
}

export async function offPlan(sm: ServiceManager, native: string, boot: BootStart): Promise<OffPlan> {
  // Each trigger or upholder by its own standing: enabled, it is disabled with the unit; not at boot (a transient
  // timer, a disabled one nothing starts), stopped; its own arrangement (static, pulled in), stopped — and said to be
  // beyond these lines, as what starts it is not undone here.
  // … and each trigger's own triggers (a timer that triggers the timer), as far as they go (a cycle or a chain past
  // sixteen units ends the walk, and what is left is said to be its own arrangement).
  const acts: ({ name: string } & BootStart)[] = [];
  const seen = new Set<string>([native]);
  const queue = [...boot.activators];
  let beyond = false;
  while (queue.length > 0) {
    const a = queue.shift() as string;
    if (seen.has(a)) continue;
    if (seen.size > 16) { beyond = true; break; }
    seen.add(a);
    const b = await sm.startsAtBoot(a);
    acts.push({ name: a, ...b });
    queue.push(...b.activators);
  }
  const enabledActs = acts.filter((a) => a.atBoot === true).map((a) => a.name);
  const stopActs = acts.filter((a) => a.atBoot !== true).map((a) => a.name);
  const ownActs = acts.filter((a) => a.atBoot === null).map((a) => a.name);
  const off = [...enabledActs, ...(boot.atBoot === true ? [native] : [])];
  const stop = [...stopActs, ...(boot.atBoot === true ? [] : [native])];
  const lines = [...(stop.length > 0 ? [sm.hints.nativeStop(stop)] : []), ...(off.length > 0 ? [sm.hints.nativeDisableNow(off)] : [])];
  return {
    now: (boot.atBoot === true ? lines : lines.reverse()).join('; '), // the triggers before the unit, whichever line holds them
    later: off.length > 0 ? sm.hints.nativeDisable(off) : null,
    // What pulls in a trigger is as much beyond these lines as what pulls in the unit ("my-desk.target wants herdr.timer"); what the manager stops with a trigger ends with it too.
    unheld: [...boot.pullers.map((p) => `${p.unit} ${p.how}`), ...acts.flatMap((a) => a.pullers.map((p) => `${p.unit} ${p.how.replace(/\bit\b/, a.name)}`)), ...(ownActs.length > 0 ? [`what starts ${listOf(ownActs)} is its own arrangement`] : []), ...(beyond ? [`what starts ${listOf(queue)} and beyond is its own arrangement (not followed further)`] : [])],
    stops: [...acts.map((a) => a.name), native],
    alongside: [...new Set([...boot.stoppedWith, ...acts.flatMap((a) => a.stoppedWith)])],
    state: boot.state,
  };
}

/** Another bridge's unit's plan: a provider is enabled (turned off with `disable`, on either manager), a possible or a runner is not. */
export function otherPlan(sm: ServiceManager, o: OtherHerdrUnit): Promise<OffPlan> {
  return offPlan(sm, sm.unitName(o.unit), { state: o.role === 'provider' ? 'enabled' : 'disabled', atBoot: o.role === 'provider' ? true : o.role === 'possible' ? null : false, activators: o.activators, pullers: o.pullers, stoppedWith: o.stoppedWith });
}

/** The keep-one tail: the line that keeps the unit from the next boot when there is one, the starters' own, and what no line undoes — said, not claimed. */
export function keepOne(name: string, plan: OffPlan, ours: string): string {
  const note = plan.unheld.length > 0 ? ` (${name}: ${plan.unheld.join('; ')} — which no line here undoes)` : '';
  if (plan.later !== null) return `${plan.later}   or  ${ours}${note}`;
  return `${ours}   — or keep ${name} from starting yourself (${plan.unheld.length > 0 ? plan.unheld.join('; ') : `it is ${plan.state || 'of unknown standing'}`}: no line here turns it off)`;
}

/** "herdr.timer starts it", "my-desk.target wants it", both: how a unit that is not enabled may still be started. */
export function startsHow(o: { activators: string[]; pullers: { unit: string; how: string }[] }): string {
  return [...(o.activators.length > 0 ? [`${listOf(o.activators)} start${o.activators.length > 1 ? '' : 's'} it`] : []), ...o.pullers.map((p) => `${p.unit} ${p.how}`)].join(' and ');
}

/**
 * The manager's side of ownership, for a unit it has loaded: the file it loaded must be the one at `unitPath` (a label
 * bootstrapped from another plist, a unit file from another load path, each under setup's name), and what it merged
 * in from any load path (`<unit>.d`, `remotly-bridge-.service.d`, `service.d`, under ~/.config, /etc, ~/.local/share)
 * must leave the unit setup's (dropInAgainst: none of the unit's own, and no system `service.d` one that can single
 * it out). The reason it is not setup's, or null. `systemDirs`: the system's load paths (tests stand in for them).
 */
export function unitSourceCheck(src: UnitSource | null, unitPath: string, manager: string, systemDirs: readonly string[] = SYSTEM_USER_UNIT_DIRS): string | null {
  if (src === null) return null;
  if (src.path === null) return `loaded by ${manager} from no file it names (a transient or submitted job under the name)`; // systemd-run, `launchctl submit`: not the file at the path, whatever that says
  if (src.path !== unitPath) return `loaded by ${manager} from ${src.path}, not ${unitPath}`;
  return dropInAgainst(src.dropIns, systemDirs);
}

/**
 * A running process's arguments: `/proc/<pid>/cmdline` on Linux, `ps` elsewhere. null when the process is gone or
 * cannot be read. From `ps` the arguments come as one line split on spaces, so one with a space inside (a session
 * name) does not parse as herdr's — the caller falls back to the unit file.
 */
export async function readProcessArgs(pid: number, platform: string, exec: ExecFn): Promise<string[] | null> {
  if (platform === 'linux') {
    try {
      const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (parts.at(-1) === '') parts.pop();
      return parts.length ? parts : null;
    } catch {
      return null;
    }
  }
  const r = await exec('ps', ['-o', 'args=', '-p', String(pid)]);
  const line = r.code === 0 ? r.stdout.trim() : '';
  return line ? line.split(' ') : null;
}

/**
 * The directory a running herdr serves under, from its environment (Linux: /proc/<pid>/environ, readable for the
 * user's own processes): `XDG_CONFIG_HOME` when set and absolute (herdr takes anything else literally: no verdict),
 * else `<HOME>/.config`. Null when it cannot be read, or on another platform — never taken for the one wanted then.
 */
export function readProcessConfigHome(pid: number, platform: string): string | null {
  if (platform !== 'linux') return null;
  let env: string[];
  try {
    env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return null;
  }
  const value = (name: string): string | undefined => env.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);
  const dir = value(HERDR_CONFIG_HOME_VAR);
  if (dir !== undefined) return path.isAbsolute(dir) ? dir : null;
  const home = value('HOME');
  return home !== undefined && path.isAbsolute(home) ? path.join(home, '.config') : null;
}

export type MaybePromise<T> = T | Promise<T>;

/** The inodes of the sockets listening on `socketPath`, from /proc/net/unix: seven fixed columns (`Num RefCount Protocol Flags Type St Inode`), then the path, spaces and all; a listener has the ACC flag, 00010000. */
export function listenerInodes(unixTable: string, socketPath: string): Set<string> {
  const out = new Set<string>();
  for (const line of unixTable.split('\n').slice(1)) {
    const m = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (m && m[8] === socketPath && m[4] === '00010000') out.add(m[7] as string);
  }
  return out;
}

/** `lsof -U -F pn` (macOS): a `p<pid>` line, then that process's `n<name>` lines — a socket bound to a path is named by it. The pids with the socket, in lsof's order. */
export function pidsFromLsof(out: string, socketPath: string): number[] {
  const pids: number[] = [];
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (pid !== null && line.startsWith('n') && line.slice(1) === socketPath && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** `launchctl list` (macOS): `PID\tStatus\tLabel` rows for the user's domain; the label whose main process is `pid`, if a job's. */
export function labelFromLaunchctlList(out: string, pid: number): string | null {
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f.length >= 3 && f[0]?.trim() === String(pid)) return (f[2] as string).trim() || null;
  }
  return null;
}

/**
 * The pid listening on a Unix socket: on Linux /proc/net/unix names the listener's inode, and a process's fd links to
 * `socket:[inode]` (the user's own processes are readable; others are not, and are skipped); on macOS `lsof -U` names
 * the socket's path against its process. null when not found, or when neither tells (herdr's ping does not say its pid).
 */
export async function pidListeningOn(socketPath: string, platform: string, exec: ExecFn): Promise<number | null> {
  if (platform === 'darwin') {
    const r = await exec('lsof', ['-U', '-F', 'pn'], { timeoutMs: 10_000 }).catch(() => null);
    if (r === null || r.code !== 0) return null;
    // A connection to the socket may be named by the path as well (its peer's): the server among them is the one
    // running `herdr … server` — this process (it pinged) is none.
    const pids = pidsFromLsof(r.stdout, socketPath).filter((p) => p !== process.pid);
    if (pids.length <= 1) return pids[0] ?? null;
    // Among several, the one running herdr: by its executable's name (`ps -o comm=` prints the path whole, spaces and
    // all; `args=` is a display that loses them), and among several herdrs the one whose arguments are a server's.
    const named: number[] = [];
    for (const p of pids) {
      const c = await exec('ps', ['-o', 'comm=', '-p', String(p)]).catch(() => null);
      if (c !== null && c.code === 0 && path.basename(c.stdout.trim()) === 'herdr') named.push(p);
    }
    if (named.length <= 1) return named[0] ?? null;
    // Several herdrs (a client of herdr's own beside the server): the server by its arguments — parsed when they
    // parse, else by the last word, the verb (`ps` shows arguments as text: a path with a space splits, the verb does
    // not). None told apart: not told.
    const serverLike: number[] = [];
    for (const p of named) {
      const args = await readProcessArgs(p, platform, exec);
      if (herdrArgv(args) !== null) return p;
      if (args !== null && args.at(-1) === 'server') serverLike.push(p);
    }
    return serverLike.length === 1 ? (serverLike[0] as number) : null;
  }
  if (platform !== 'linux') return null;
  let inodes: Set<string>;
  try {
    inodes = listenerInodes(fs.readFileSync('/proc/net/unix', 'utf8'), socketPath);
  } catch {
    return null;
  }
  // Two listeners under one path — an old socket keeps its address after the path was unlinked and bound anew — and
  // which of them answers is not told: nothing claimed, rather than the wrong process's unit.
  if (inodes.size !== 1) return null;
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const p of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(`/proc/${p}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1] as string)) return Number(p);
    }
  }
  return null;
}

/**
 * The unit a process runs under, from its cgroup path (`0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr.service`):
 * the last segment when it is a `.service` below the user manager — one of the user's own, a `systemd-run` one
 * (`run-…service`), a desktop app's transient one (KDE's `app-org.kde.konsole@….service`: a terminal). Which of them
 * supervises herdr — brings it back when it exits, starts it at boot — is the manager's word, asked next; one that
 * does neither is a terminal's kind. null for a scope (a terminal under GNOME), outside a user manager, or unreadable.
 */
export function unitOfCgroup(text: string): string | null {
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  const segs = line.slice(3).trim().split('/');
  if (!segs.some((s) => /^user@\d+\.service$/.test(s))) return null;
  const last = segs[segs.length - 1] ?? '';
  return last.endsWith('.service') ? last : null;
}

/**
 * Terminal emulators, by the executable's name (`comm`: 15 characters on Linux): a desktop app's transient unit whose
 * main process is one of these is a terminal — herdr started in it runs under that unit, but the unit does not start
 * herdr again, and stopping it would close the terminal. Any other main process of such a unit (a shell, a wrapper)
 * may start herdr again: the unit is stopped as a whole then.
 */
export const TERMINAL_APPS = new Set(['konsole', 'yakuake', 'gnome-terminal-', 'gnome-terminal', 'kgx', 'ghostty', 'kitty', 'alacritty', 'wezterm-gui', 'wezterm', 'foot', 'footclient', 'xterm', 'urxvt', 'rxvt', 'tilix', 'terminator', 'xfce4-terminal', 'mate-terminal', 'lxterminal', 'qterminal', 'sakura', 'guake', 'tilda', 'terminology', 'cool-retro-term', 'deepin-terminal', 'hyper', 'tabby', 'warp-terminal', 'zutty', 'st', 'contour', 'blackbox', 'ptyxis', 'io.elementary.t', 'wayst', 'Terminal', 'iTerm2']);

/** A live process's executable name: /proc/<pid>/comm on Linux (15 characters at most), the basename of `ps -o comm=` elsewhere; null when it cannot be read. */
export async function readProcessComm(pid: number, platform: string, exec: ExecFn): Promise<string | null> {
  if (platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  const r = await exec('ps', ['-o', 'comm=', '-p', String(pid)]).catch(() => null);
  return r === null || r.code !== 0 || !r.stdout.trim() ? null : path.basename(r.stdout.trim());
}

/**
 * The manager's unit a live process runs under, by its native name: `unitOfCgroup` of /proc/<pid>/cgroup on Linux; on
 * macOS the label `launchctl list` has the process — or an ancestor of it, a job's main process being a wrapper (a
 * shell) at times — under; a GUI app's label (`application.com.apple.Terminal.…`) is a terminal's kind, nobody's. null
 * elsewhere.
 */
export async function readProcessUnit(pid: number, platform: string, exec: ExecFn): Promise<string | null> {
  if (platform === 'darwin') {
    const r = await exec('launchctl', ['list'], { timeoutMs: 10_000 }).catch(() => null);
    if (r === null || r.code !== 0) return null;
    let p: number | null = pid;
    for (let hops = 0; p !== null && p > 1 && hops < 32; hops += 1) {
      const label = labelFromLaunchctlList(r.stdout, p);
      if (label !== null) return label.startsWith('application.') ? null : label;
      const pp: ExecResult | null = await exec('ps', ['-o', 'ppid=', '-p', String(p)]).catch(() => null);
      p = pp !== null && pp.code === 0 ? Number(pp.stdout.trim()) || null : null;
    }
    return null;
  }
  if (platform !== 'linux') return null;
  try {
    return unitOfCgroup(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The lock a setup holds from its look at a session's herdr services to its own install: two setups at once (two
 * bridges, two terminals) would each find no provider for the session and both install one. Per session (directory
 * and name), under the user's home — one place for every setup of the user's, whatever its environment (a TMPDIR of
 * its own would be a lock of its own); the file is flock's, and stays (an empty file; removing lock files is how two
 * end up holding different ones).
 */
export function sessionLockPath(home: string, configHome: string, session: string | undefined): string {
  const key = crypto.createHash('sha1').update(`${configHome}\0${session ?? ''}`).digest('hex').slice(0, 16);
  return path.join(home, '.local', 'state', 'remotly', 'locks', `herdr-${key}.lock`);
}

export interface SessionLock {
  /** Whether this process still holds it (the child that holds it is alive). */
  held(): boolean;
  /** Lets go. */
  release(): void;
}

const PERL_FLOCK = `use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or exit 2; my $until = time + $ARGV[1]; until (flock($f, LOCK_EX | LOCK_NB)) { exit 1 if time >= $until; select(undef, undef, undef, 0.25); } $| = 1; print "locked\\n"; <STDIN>;`;

/**
 * Takes the lock: a kernel lock (flock) on the file, held by a child process — `flock(1)` on Linux, perl's flock
 * where there is none (a Linux without util-linux's) and on a Mac, as the install's update lock is; flock(2) under both,
 * so holders through either tool meet — for as long as this process holds it, and let go by the kernel should
 * either die: no stale lock to judge, none to take over, and no two holders. Waits up to `waitMs` for another holder,
 * then throws. null when there is nothing to run the lock with (no flock, no perl): setups go unserialised, said.
 */
export async function lockSession(lockFile: string, opts: { platform?: string; waitMs?: number } = {}): Promise<SessionLock | null> {
  const secs = String(Math.max(0.1, (opts.waitMs ?? 60_000) / 1000));
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const perl: [string, string[]] = ['perl', ['-e', PERL_FLOCK, lockFile, secs]];
  const tools: [string, string[]][] = (opts.platform ?? process.platform) === 'linux' ? [['flock', ['-w', secs, lockFile, '-c', 'echo locked; exec cat']], perl] : [perl];
  for (const [cmd, args] of tools) {
    const got = await lockWith(cmd, args, lockFile);
    if (got !== null) return got;
  }
  return null;
}

/** The lock through one tool: the child that holds it, null when the tool is not there (ENOENT), the error otherwise. */
function lockWith(cmd: string, args: string[], lockFile: string): Promise<SessionLock | null> {
  const child = spawnProcess(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // Once held, nothing here keeps this process alive (a setup that ends without releasing — it cannot, but should it —
  // exits, the pipe closes, the child reads EOF and the kernel lets go). While waiting for the lock the pipes are what
  // keeps it alive: unref'd before, a setup with nothing else pending would exit before the word came.
  const letGo = (): void => {
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as unknown as { unref?: () => void }).unref?.();
  };
  const release = (): void => {
    child.stdin.end();
    child.kill();
  };
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!settled && out.includes('locked')) {
        settled = true;
        letGo();
        resolve({ held: () => child.exitCode === null && child.signalCode === null, release });
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (e.code === 'ENOENT') resolve(null);
      else reject(e);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 1) reject(new Error(`another setup holds ${lockFile} (a setup is running for this session; wait for it)`));
      else reject(new Error(`${cmd} could not take ${lockFile}${err.trim() ? `: ${err.trim()}` : ` (exit ${code})`}`));
    });
  });
}

function readTextIfAny(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function executableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Which herdr session the socket the bridge follows belongs to, as `herdr` lays them out under `~/.config/herdr` (the
 * default session's `herdr.sock`, a named one's `sessions/<name>/herdr.sock`; herdr/client.ts resolveSocketPath): the
 * herdr service starts that session. `null` for any other path — a socket handed in by `HERDR_SOCKET_PATH` or
 * `herdr.socket` that herdr cannot be told to listen on, so no service can bring it back.
 */
export function herdrSessionFor(socket: string, home: string): { session?: string } | null {
  const base = path.join(home, '.config', 'herdr');
  if (socket === path.join(base, 'herdr.sock')) return {};
  const rel = path.relative(path.join(base, 'sessions'), socket).split(path.sep);
  if (rel.length === 2 && rel[0] && rel[0] !== '..' && rel[1] === 'herdr.sock') return { session: rel[0] };
  return null;
}

/** Whether herdr answers on the socket the bridge follows. */
async function herdrUp(deps: SetupDeps): Promise<boolean> {
  if (!fs.existsSync(deps.herdrSocket)) return false;
  try {
    await deps.herdrPing(deps.herdrSocket);
    return true;
  } catch {
    return false;
  }
}

const HERDR_START_WAIT_MS = 15_000;
/** The unit file states the herdr service is written over: none yet, enabled by setup, or disabled (by the user, or `--no-herdr-service`). Anything else (`linked`, `static`, `alias`, …) is a hand-made arrangement. */
export const HERDR_UNIT_STATES_SETUP_OWNS = new Set(['not-found', 'enabled', 'enabled-runtime', 'disabled']);

/**
 * herdr as a user service beside the bridge's — `<unit>-herdr`, `herdr [--session <name>] server` for the session the
 * bridge follows — so a host reboot brings herdr back (its saved workspaces, tabs and panes with it, and the agents in
 * them when herdr's `resume_agents_on_restore` says so) without anyone opening a terminal. Written on every setup so
 * it follows the `herdr` on PATH; enabled on its first install, afterwards left as the user has it (a disabled or
 * masked unit stays so; `--no-herdr-service` writes it disabled). Started only when herdr is not running: a herdr
 * started from a terminal keeps running and the service takes over at the next boot — the unit is never restarted
 * over a running herdr, since that ends every pane's processes. Never fails the setup: the bridge still works with a
 * herdr started by hand.
 *
 * Runs once; a run that found no `herdr` binary is repeated when asked again (herdrCheck asks on every poll, so a
 * herdr installed while setup waits is set up as a service at once).
 */
function herdrServiceInstaller(deps: SetupDeps, sm: ServiceManager, opts: SetupOptions): () => Promise<void> {
  const unit = herdrUnit(opts.unit);
  const name = sm.unitName(unit);
  const home = deps.home ?? os.homedir();
  const cfg = herdrConfigHome(home); // the directory the bridge's socket is under: pinned in the unit, so its arguments say which socket it serves
  const herdrBinary =
    deps.herdrBinary ??
    (() => {
      const found = findExecutable('herdr', herdrSearchDirs(deps.env, home));
      if (found) return found;
      // None to be found from here: the `herdr` the unit setup wrote already runs, while it is still there (herdr in
      // a place of its own, setup under a unit's PATH). Only from a file setup wrote (herdrUnitFile: an absolute `herdr`).
      const file = ownFile();
      return file.kind === 'owned' && executableFile(file.args.herdrPath) ? file.args.herdrPath : null;
    });
  const processArgs = deps.processArgs ?? ((pid: number) => readProcessArgs(pid, deps.platform ?? 'linux', deps.exec));
  const processConfigHome = deps.processConfigHome ?? ((pid: number) => readProcessConfigHome(pid, deps.platform ?? 'linux'));
  const socketPid = deps.socketPid ?? ((p: string) => pidListeningOn(p, deps.platform ?? 'linux', deps.exec));
  const processUnit = deps.processUnit ?? ((pid: number) => readProcessUnit(pid, deps.platform ?? 'linux', deps.exec));
  const processComm = deps.processComm ?? ((pid: number) => readProcessComm(pid, deps.platform ?? 'linux', deps.exec));
  // What setup writes for a file's arguments: a file of setup's is exactly that (herdrUnitFile).
  const renderFor = (a: HerdrArgs): string => sm.renderHerdrUnit({ unit: opts.unit, herdrPath: a.herdrPath, session: a.session, configHome: a.configHome ?? '' });
  const ownFile = (): HerdrUnitFile => herdrUnitFile(sm.unitPath(unit), name, renderFor);
  const boot = sm.kind === 'launchd' ? 'login' : 'boot';
  let done = false;
  return async () => {
    if (done) return;
    const up = await herdrUp(deps);
    const session = herdrSessionFor(deps.herdrSocket, home);
    if (session === null) {
      done = true;
      // A unit from an earlier setup (the bridge followed a session then) keeps starting that session: said, not touched.
      const strayDeps = ownFile().kind === 'owned' ? await sm.dependents(name) : { stopped: [], conflicting: [] };
      const stray = ownFile().kind !== 'owned' ? '' : `; ${name}, from an earlier setup, keeps starting its own session — off:  ${sm.hints.disableNow(unit)}${strayDeps.stopped.length > 0 ? `   (which stops ${listOf(strayDeps.stopped)} with it, and whatever depends on those)` : ''}`;
      deps.out(`  · no herdr service: the bridge follows ${deps.herdrSocket}, which is not a herdr session under ${path.join(home, '.config', 'herdr')} — start that herdr yourself after a reboot${stray}`);
      return;
    }
    const bin = herdrBinary();
    if (!bin) {
      // Not running and not installed: herdrCheck prints the install line; once it is there, this runs again.
      if (up) {
        done = true;
        deps.out('  · no herdr service: herdr is running, but there is no `herdr` on PATH (or under ~/.local/bin) to start it from at boot');
      }
      return;
    }
    done = true;
    const unitPath = sm.unitPath(unit);
    let takeBack = false; // a unit this setup wrote and has neither enabled nor (--no-herdr-service) disabled yet: taken back should it fail
    let standingState = '';
    let lock: SessionLock | null = null;
    let afterword: string[] = []; // the keep-one lines beside a unit of the user's own that may start herdr at boot too, or another bridge's unit a timer of the user's may: last, after whatever the install says
    try {
      // From here to the enable, one setup at a time per session: two at once would each find no provider and both install one.
      lock = await lockSession(sessionLockPath(deps.home ?? path.dirname(path.dirname(path.dirname(deps.unitDir))), cfg, session.session), { platform: deps.platform ?? 'linux' });
      if (lock === null) deps.out(`  · herdr service: setups are not serialised on this host (nothing to run a lock with: no ${(deps.platform ?? 'linux') === 'linux' ? 'flock, no perl' : 'perl'})`);
      const lost = (): boolean => lock !== null && !lock.held(); // the child that holds the lock is gone: nothing more is written or enabled under it
      const standing = await sm.enabledState(unit);
      if (standing.unreadable) {
        deps.out(`  ⚠ cannot tell whether ${name} is enabled (${standing.unreadable}); the herdr service is left as it is`);
        return;
      }
      if (standing.state === 'masked') {
        // A mask over a unit file in another load path (`~/.local/share/systemd/user`, `/etc/systemd/user`) hides a unit setup did not write: unmasking would expose it, so neither is touched.
        const hidden = await sm.maskHides(unit);
        if (hidden !== null) deps.out(`  · herdr service off: ${name} is masked, and the mask hides a unit setup did not write (${hidden}); both are left alone`);
        else deps.out(`  · herdr service off: ${name} is masked (${sm.hints.unmask(standing.masked ?? [name])}, then setup again, turns it on)`);
        return;
      }
      standingState = standing.state;
      const fresh = standing.state === 'not-found';
      // A first install on systemd writes the file, reloads, then enables: killed in between (power, a SIGKILL), it leaves
      // a unit of setup's that is `disabled` without anyone having chosen so — read as the user's choice by the next
      // setup. So the write is announced in a `.pending` file beside the unit, removed once the standing is settled
      // (enabled, or disabled by --no-herdr-service): a disabled unit with its `.pending` still there is enabled after all.
      // launchd needs none: a label nobody disabled is enabled.
      const pending = `${unitPath}.pending`;
      const interrupted = sm.kind === 'systemd' && !fresh && standing.state === 'disabled' && fs.existsSync(pending);
      const st = await sm.state(unit);
      // Only what setup leaves behind is written over (the file follows the current `herdr`): a file it wrote — its
      // marker line, its one shape (herdrUnitFile) — in a standing it leaves (enabled, or disabled by the user or
      // --no-herdr-service). A hand-made arrangement — a `linked` symlink, a `static` or `alias` unit, a symlink or a
      // file of another shape under this name, a drop-in that changes what it runs, a unit whose file is elsewhere,
      // a name the manager knows without a file of ours (a dangling symlink; a plist bootstrapped from another path) —
      // is left as it is, file and all. A file of ours the manager does not know yet (written, not reloaded) is fresh.
      const file = await lintedPlist(ownFile(), unitPath, sm, deps.exec);
      const before = file.kind === 'owned' ? file.args : null;
      const loaded = st?.load === 'loaded';
      const foreign = !HERDR_UNIT_STATES_SETUP_OWNS.has(standing.state)
        ? standing.state
        : file.kind === 'foreign'
          ? file.why
          : (loaded ? unitSourceCheck(await sm.source(unit), unitPath, sm.name) : null) ??
            (fresh
              ? loaded
                ? `loaded by ${sm.name} from a file that is not ${unitPath}`
                : null
              : file.kind === 'absent'
                ? `${standing.state} with no file at ${unitPath}`
                : null);
      if (foreign !== null) {
        deps.out(`  · herdr service left as it is: ${name} is ${foreign}, not a unit setup wrote`);
        return;
      }
      const stopHerdr = herdrStopCommand(session.session, cfg, bin);
      const want = session.session ? `session ${session.session}` : 'the default session';
      // What a running unit serves, against what is written now (the bridge was moved to another session; the file is
      // for the next start only): its process's own arguments — launchd tells them, on Linux /proc does — so that the
      // next setup, reading a file already rewritten, still sees the old session running. Arguments that are not
      // herdr's shape (a wrapper; a `ps` line split on spaces) tell nothing: no ✔ then. Arguments that cannot be read
      // at all (the process gone between two looks) leave the file it was started from to stand in.
      const argv = st?.active === 'active' ? (st.args ?? (st.pid ? await processArgs(st.pid) : null)) : null;
      // launchd runs `program` with the arguments as its argv (a plist with a Program key, bootstrapped before the file
      // was put back): what runs is not what the arguments say — nothing to be told from them.
      const programOff = st?.program !== undefined && argv !== null && st.program !== argv[0];
      // A process's own arguments (after the exec) carry no directory — its environment does, read where it can be.
      let parsed = argv === null || programOff ? null : herdrArgv(argv);
      if (parsed !== null && parsed.configHome === undefined && st?.pid) {
        const dir = processConfigHome(st.pid);
        if (dir !== null) parsed = { ...parsed, configHome: dir };
      }
      const runs: HerdrArgs | null | 'unknown' = argv === null ? (st?.active === 'active' ? before : null) : (parsed ?? 'unknown');
      const opaque = runs === 'unknown';
      // The session the bridge follows, under its directory: the same session name under another XDG_CONFIG_HOME (a file
      // written under another home) is another socket, so moved; a directory that cannot be told (the environment not
      // readable, a relative value herdr takes literally) is never taken for the one wanted — said, no ✔.
      const sameSessionName = (a: HerdrArgs): boolean => (a.session ?? '') === (session.session ?? '');
      const moved = runs !== null && !opaque && (!sameSessionName(runs) || (runs.configHome !== undefined && runs.configHome !== cfg));
      const dirUnknown = runs !== null && !opaque && !moved && runs.configHome === undefined;
      const runsWhat = opaque
        ? `what cannot be told from its process (${programOff ? `program ${st?.program}, arguments ` : ''}${(argv ?? []).join(' ')})`
        : dirUnknown
          ? `for ${describeHerdr(runs, cfg)} under a directory that cannot be told (its process's environment could not be read)`
          : describeHerdr(runs, cfg);
      const offSession = moved ? ` (for ${runsWhat}, not ${want})` : opaque || dirUnknown ? ` (running ${runsWhat})` : '';
      // One herdr service per session: another bridge unit's, written by setup for this very session, is its provider —
      // a fresh unit here would be a second one racing it for the socket at every boot, so none is written. Both
      // already there (each from before the other followed this session) is said, with the line that keeps one.
      // With --no-herdr-service ours is still written, disabled: that is how the choice lasts (a later setup, an
      // unattended update, leaves a disabled unit so — and installs one when the provider is gone otherwise). A
      // disabled unit of ours beside the provider races nobody.
      // Every other bridge's enabled unit for this session is one (two already there are each from before the other followed it): each is named, and each is turned off in the lines that put ours in their place. One short of that but running the session (a runner) is stopped in them.
      const others = await otherHerdrUnits(sm, opts.unit, session.session, cfg, deps.executable ?? executableFile);
      const providers = others.filter((o) => o.role === 'provider');
      const possibles = others.filter((o) => o.role === 'possible'); // another bridge's unit, not enabled, that a timer or target of the user's own may start: turned off (with its timer) in the hand-over lines as far as a line can, said with its keep-one line; no take-over at boot is claimed beside it
      const runners = others.filter((o) => o.role === 'runner');
      const plans = new Map<string, OffPlan>(); // how each is turned off: now, from the next boot, and what no line undoes
      for (const o of others) plans.set(o.unit, await otherPlan(sm, o));
      const planOf = (o: OtherHerdrUnit): OffPlan => plans.get(o.unit) as OffPlan;
      const notes = (os: OtherHerdrUnit[]): string => os.map((o) => (planOf(o).unheld.length > 0 ? ` (${sm.unitName(o.unit)}: ${planOf(o).unheld.join('; ')} — which no line here undoes)` : '')).join('');
      const provider = providers[0] ?? null;
      const many = providers.length > 1;
      const theirs = listOf(providers.map((p) => sm.unitName(p.unit)));
      const theirsFull = listOf(providers.map((p) => `${sm.unitName(p.unit)} (bridge unit ${p.bridge}'s)`));
      // What runs the herdr that answers for the session, when it is a unit of the user's own (not setup's: Linux tells
      // from the socket's listener and its cgroup, a terminal being a scope; macOS from lsof and launchctl list, where
      // a client of the socket may be named by its path too, so the bridge's own unit counts as nobody's): stopped
      // through the manager in the lines printed — a `herdr server stop` alone would have its Restart=always bring it
      // back against ours. Whether it starts herdr at boot too is asked of the manager: enabled, yes (it and whatever
      // setup-owned unit starts the session race); disabled and nothing pulling it in, no; else its own arrangement
      // (`static`, wanted or triggered by a unit of the user's, an agent's RunAtLoad) — not claimed either way. Beside
      // one that may, no take-over at boot is promised, and the keep-one line is printed last (`afterword`), naming the
      // setup-owned units that start the session after this run: theirs, ours, or both.
      const answering = up ? await socketPid(deps.herdrSocket) : null;
      const underUnit = answering === null ? null : await processUnit(answering);
      const candidate = underUnit !== null && underUnit !== name && underUnit !== sm.unitName(opts.unit) && !others.some((o) => sm.unitName(o.unit) === underUnit) ? { name: underUnit, ...(await sm.startsAtBoot(underUnit)), ...(await sm.unitFacts(underUnit)) } : null;
      // One that neither brings herdr back when it exits nor may start it at boot, and either has herdr for its main
      // process (a plain `systemd-run`: stopping herdr ends it) or is a desktop app's transient unit (`app-…`, under
      // KDE) whose main process is a terminal emulator, is a terminal's kind — nothing to stop through the manager,
      // nothing that races. Anything else — a unit whose main process is a wrapper (a shell loop) that may start herdr
      // again, however `Restart=` reads and whatever its name — is stopped as a unit.
      const terminalApp = candidate !== null && candidate.transient === true && /^app-/.test(candidate.name) && candidate.mainPid !== null && candidate.mainPid !== answering ? TERMINAL_APPS.has((await processComm(candidate.mainPid)) ?? '') : false;
      const supervisor = candidate !== null && !(candidate.restarts === false && candidate.atBoot === false && (candidate.mainPid === answering || terminalApp)) ? candidate : null;
      // What may start the session at boot besides setup's own units: the supervisor (enabled, or its own arrangement), another bridge's unit a timer or target of the user's may start. Beside either, no take-over at boot is claimed.
      const supMayStart = supervisor !== null && supervisor.atBoot !== false;
      const mayStart = supMayStart || possibles.length > 0;
      // How the supervisor is turned off: with its triggers and upholders (the unit alone, they would start it again), each named where the line says what it ends; what pulls it in is named as not undone.
      const supPlan = supervisor === null ? null : await offPlan(sm, supervisor.name, supervisor);
      const stopOutside = supPlan === null ? stopHerdr : supPlan.now;
      const outsideEnds = supPlan === null ? '' : stopsEnd([supPlan], ' and ', '', 'else '); // units stopped as a whole, and what the manager stops with them
      const supNote = supervisor === null ? '' : `${supervisor.atBoot === true ? ', enabled' : ''}${supervisor.activators.length + supervisor.pullers.length > 0 || supervisor.atBoot === null ? ` (${[...(supervisor.activators.length + supervisor.pullers.length > 0 ? [startsHow(supervisor)] : []), ...(supervisor.atBoot === null ? [`whether it starts herdr at ${boot} is its own arrangement`] : [])].join('; ')})` : ''}`;
      const outside = supervisor !== null ? `under ${supervisor.name}, a unit setup did not write${supNote}` : others.length > 0 ? `under ${listOf(others.map((o) => sm.unitName(o.unit)))}, or from a terminal` : 'from a terminal';
      const oursStarter = { name, off: sm.hints.disable(unit) };
      const theirStarters = providers.map((p) => ({ name: sm.unitName(p.unit), off: planOf(p).later ?? sm.hints.disable(p.unit) }));
      // The keep-one lines, for the setup-owned units that start the session after this run (`starters`): beside the
      // supervisor when it may start herdr at boot; and one for each other bridge's unit a timer or target of the user's may start.
      const raceLines = (starters: { name: string; off: string }[]): string[] => {
        if (starters.length === 0) return [];
        const ours = starters.map((s) => s.off).join('; ');
        const who = listOf(starters.map((s) => s.name));
        return [
          ...(supervisor === null || supPlan === null || !supMayStart ? [] : [`  ⚠ herdr runs under ${supervisor.name}, a unit setup did not write${supervisor.activators.length + supervisor.pullers.length > 0 ? ` (${startsHow(supervisor)})` : ''}${supervisor.atBoot === true ? ` and enabled too: at ${boot} it and ${who} race for the socket` : `: if it starts herdr at ${boot} too, it and ${who} race for the socket there`} — keep one, from the next ${boot}:  ${keepOne(supervisor.name, supPlan, ours)}`]),
          ...possibles.map((p) => `  ⚠ herdr service ${sm.unitName(p.unit)} (bridge unit ${p.bridge}'s) is not enabled, but ${startsHow(p)}: if that starts ${want} at ${boot} too, it and ${who} race for the socket there — keep one, from the next ${boot}:  ${keepOne(sm.unitName(p.unit), planOf(p), ours)}`),
        ];
      };
      if (provider !== null) {
        const already = `${theirsFull} start${many ? '' : 's'} ${want} at ${boot} already`;
        if (fresh && opts.herdrService !== false) {
          deps.out(`  · herdr service: ${already}; none installed for ${opts.unit} (a second would race it for the socket)`);
          afterword = raceLines(theirStarters);
          return;
        }
        // Ours enabled beside it is the race — unless this run turns ours off (--no-herdr-service), in which case nothing is to be done about theirs.
        if (fresh || opts.herdrService === false || standing.state !== 'enabled') deps.out(`  · herdr service: ${already}${fresh || opts.herdrService === false ? '' : `; ${name} is ${standing.state} and races ${many ? 'them' : 'it'} for nothing${standing.state === 'enabled-runtime' ? ' (left so: enabled until the next boot only)' : ''}`}`);
        else deps.out(`  ⚠ ${many ? providers.length + 1 : 'two'} herdr services for ${want}: ${listOf([name, ...providers.map((p) => `${sm.unitName(p.unit)} (bridge unit ${p.bridge}'s)`)])} — at ${boot} they race for the socket; keep one, from the next ${boot}:  ${providers.map((p) => planOf(p).later ?? sm.hints.disable(p.unit)).join('; ')}   (what runs now keeps running)${notes(providers)}`);
      }
      // The lines that start or restart ours for the session, composed from what stands in the way: the provider is
      // turned off and stopped first (its Restart=always would bring its herdr back against ours); the wanted session's
      // herdr running outside the unit is stopped (it holds the socket: ours would start against it forever — with an
      // opaque process the answering herdr may be the unit's own, and the stop costs one restart more); a unit that is
      // running another session is restarted, not started (`enable --now` would leave it as it runs: a start is nothing
      // to an active unit, and launchd's bootstrap fails on a loaded one). Each line says what it ends.
      const theirsFirst = others.length === 0 ? '' : `${[...providers.map((p) => planOf(p).now), ...possibles.map((p) => planOf(p).now), ...runners.map((r) => sm.hints.stop(r.unit))].join('; ')}; `;
      const running = st?.active === 'active';
      const offSessionNow = running && (moved || opaque || dirUnknown);
      const stopFirst = up && (!running || offSessionNow) ? `${stopOutside}; ` : '';
      // What the manager stops along with setup's own unit when it stops or restarts (a unit of the user's with PartOf= or
      // Requires= on it), and what it stops when ours starts (one with Conflicts= on it): named in every line that starts,
      // restarts or stops ours.
      const ownDeps = st !== null && st.load === 'loaded' ? await sm.dependents(name) : { stopped: [], conflicting: [] };
      const stoppedWithOurs = (units: string[]): string => (units.length === 0 ? '' : `, and ${listOf(units)}, which the manager stops with ${name} (and whatever depends on those)`);
      const ownEnds = stoppedWithOurs([...new Set([...ownDeps.stopped, ...ownDeps.conflicting])]); // a restart or stop of ours
      const ownStarts = stoppedWithOurs(ownDeps.conflicting); // a start of ours
      const ends = (restart: boolean, ...what: string[]): string => {
        const w = what.filter((x) => x !== '');
        return w.length === 0 ? '' : `   (ends ${listOf(w)}${restart ? ownEnds : ownStarts}; herdr restores the layout${w.length > 1 ? 's' : ''})`;
      };
      const wantedPanes = stopFirst ? `every pane of ${want}${outsideEnds}` : '';
      const theirsPanes = stopsEnd(others.map(planOf), '', ' now'); // each unit those lines stop as a whole, a timer among them, and what the manager stops with them
      const turnOn = `${stopFirst}${offSessionNow ? sm.hints.enableRestart(unit) : sm.hints.enableNow(unit)}`;
      const onLine =
        provider === null
          ? `on:  ${theirsFirst}${turnOn}${ends(offSessionNow, wantedPanes, offSessionNow ? 'every pane this unit runs' : '', theirsPanes)}`
          : `on, as the session's one (${theirs} start${many ? '' : 's'} it already; two would race):  ${theirsFirst}${turnOn}${ends(offSessionNow, wantedPanes, offSessionNow ? 'every pane this unit runs' : '', theirsPanes)}`;
      // A fresh plist is enabled by default — RunAtLoad at the next login — so with --no-herdr-service the label is
      // disabled before the plist exists: a setup stopped in between leaves nothing that starts. (systemd: a fresh file
      // nobody enabled is `disabled` already; the .pending marker is for an enabling run only, so an opt-out cut short
      // reads as the opt-out.)
      if (lost()) throw new Error(`another setup took the lock for ${want} meanwhile; run setup again`);
      if (fresh && sm.kind === 'launchd' && opts.herdrService === false) await sm.disable(unit);
      takeBack = fresh;
      fs.mkdirSync(deps.unitDir, { recursive: true });
      if (fresh && sm.kind === 'systemd' && opts.herdrService !== false) fs.writeFileSync(pending, '');
      writeUnitFile(unitPath, sm.renderHerdrUnit({ unit: opts.unit, herdrPath: bin, session: session.session, configHome: cfg }));
      await sm.reload();
      // The file started another session before (the bridge was moved): a bridge that shared this unit for that session (one provider per session) has no service now until its own setup runs.
      if (before !== null && (!sameSessionName(before) || (before.configHome !== undefined && before.configHome !== cfg))) deps.out(`  · herdr service ${name} started ${describeHerdr(before, cfg)} before: a bridge that shared it for that session has no service now, until its own setup runs again (its doctor says so)`);
      // systemd's word once it has read the file: a drop-in from a load path that applies to the unit only now that it
      // is loaded (a prefix directory, `service.d`), or any that changed since the look above. Not setup's then — a
      // fresh file is taken back, an existing one left — before anything is enabled, disabled or started.
      if (sm.kind === 'systemd') {
        const after = unitSourceCheck(await sm.source(unit), unitPath, sm.name);
        if (after !== null) {
          if (fresh) {
            fs.rmSync(unitPath, { force: true });
            fs.rmSync(pending, { force: true });
            await sm.reload().catch(() => undefined);
            takeBack = false;
          }
          deps.out(`  · herdr service left as it is: ${name} is ${after}, not a unit setup wrote${fresh ? ' (the file written for it was taken back)' : ''}`);
          return;
        }
      }
      if (opts.herdrService === false) {
        // Disabled first, then kept: a fresh plist launchd was not told to skip would start at login, so one whose
        // `disable` failed is taken back.
        await sm.disable(unit);
        fs.rmSync(pending, { force: true });
        takeBack = false; // what --no-herdr-service leaves behind: the unit, disabled
        deps.out(`  · herdr service off (--no-herdr-service): ${name} written but disabled${st?.active === 'active' ? `; it keeps running${offSession} until:  ${sm.hints.stop(unit)}${ownDeps.stopped.length > 0 ? `   (which stops ${listOf(ownDeps.stopped)} with it, and whatever depends on those)` : ''}` : ''}; ${onLine}`);
        afterword = raceLines(theirStarters);
        return;
      }
      // A unit that exists and is not enabled was turned off by the user (`disable`, or --no-herdr-service): later
      // setups leave that alone. `enabled-runtime` is enabled until the next boot — made permanent below like a fresh one.
      // `enabled-runtime` beside another bridge's provider is left so: making it permanent would make two at boot — as
      // would finishing an interrupted install beside one (the other bridge's setup took the session meanwhile): that
      // unit stays disabled, its pending file gone, with the hand-over line for turning it on.
      const finish = interrupted && provider === null;
      if (interrupted && !finish) fs.rmSync(pending, { force: true });
      if (!fresh && !finish && standing.state !== 'enabled' && (standing.state !== 'enabled-runtime' || provider !== null)) {
        // launchd does not bootstrap a disabled agent: the only restart that runs the file turns it on (restartDisabled), and the line says so.
        const turnsOn = sm.hints.restartNeedsEnabled;
        // Beside a provider there is no "disabled, running the session" to offer (its herdr and the provider's would fight for the socket now): the on-line is the one line then.
        deps.out(`  · herdr service off (${name} is ${standing.state})${moved || opaque || dirUnknown ? `; it is running ${moved ? `for ${runsWhat}, not ${want}` : runsWhat}${provider === null ? ` — for ${want}:  ${theirsFirst}${stopFirst}${sm.hints.restartDisabled(unit)}   (ends every pane it runs${up ? `, and the herdr answering for ${want} outside it${outsideEnds}` : ''}${theirsPanes ? `, and ${theirsPanes}` : ''}${ownEnds}${turnsOn ? '; a disabled agent is bootstrapped only once enabled, so this turns it on' : ''})` : ''}` : ''}; ${onLine}`);
        afterword = raceLines(theirStarters);
        return;
      }
      if (finish) deps.out(`  · herdr service ${name} was written by a setup that did not get to enable it: enabled now`);
      if (lost()) throw new Error(`another setup took the lock for ${want} meanwhile; run setup again`);
      await sm.enable(unit);
      fs.rmSync(pending, { force: true });
      takeBack = false;
      const where = `${name} (${bin}${session.session ? `, session ${session.session}` : ''})`;
      afterword = raceLines([oursStarter, ...theirStarters]);
      if (st?.active === 'active') {
        const pid = st.pid ? ` (pid ${st.pid})` : '';
        // herdr answering for the wanted session while the unit runs another (`up`): it runs outside the unit, and holds
        // the socket — restarted alone, the unit could not bind it and would start against it forever. So that herdr is
        // stopped first in the line printed (both sessions' panes end; herdr restores the layouts). With an opaque
        // process the answering herdr may be the unit's own: the stop then costs one restart more, nothing else.
        // The file was just rewritten: the restart printed is the one that runs it (launchd: bootout and bootstrap; a kickstart would respawn what it loaded).
        // Ours enabled here beside a provider (the two-services warning above): a restart of ours for the session turns the provider off first.
        if (moved) deps.out(`  ⚠ herdr service ${where} is running${pid} for ${runsWhat}, rewritten for ${want}${mayStart ? ` — for ${want} now:` : `: it takes over at the next ${boot} — or now:`}  ${theirsFirst}${stopFirst}${sm.hints.reloadRestart(unit)}${ends(true, `every pane of ${runsWhat}`, up ? `every pane of ${want} (it runs outside the unit now)${outsideEnds}` : '', theirsPanes)}`);
        else if (opaque || dirUnknown) deps.out(`  ⚠ herdr service ${where} is running${pid} ${runsWhat}; the file is for ${want}, which a restart starts:  ${theirsFirst}${stopFirst}${sm.hints.reloadRestart(unit)}${ends(true, 'every pane it runs', up ? `the herdr answering for ${want} if that is another${outsideEnds}` : '', theirsPanes)}`);
        else if (up) deps.out(`  ✔ herdr service ${where} running${pid}`);
        else deps.out(`  ⚠ herdr service ${where} is running, but herdr does not answer at ${deps.herdrSocket}; a restart ends every pane's processes${ownEnds}${others.length === 0 ? '' : `, and ${provider === null ? '' : `${theirs} ${many ? 'are' : 'is'} turned off first (${many ? 'they' : 'it'} would race the restarted unit for the socket), ending `}${theirsPanes}`}:  ${theirsFirst}${sm.hints.reloadRestart(unit)}`);
        return;
      }
      if (up) {
        // A failed unit (a crash loop before herdr was started by hand) is start-rate-limited: the hand-over clears that first.
        const startOurs = `${theirsFirst}${stopOutside}; ${st?.active === 'failed' ? sm.hints.resetAndRestart(unit) : sm.hints.start(unit)}${ends(st?.active === 'failed', `every pane of ${want}${outsideEnds}`, theirsPanes)}`;
        deps.out(`  · herdr service ${where} installed: herdr is running outside it now (${outside})${mayStart ? ' — hand over to this one now:' : `, so it takes over at the next ${boot} — or now:`}  ${startOurs}`);
        return;
      }
      if (opts.keepStopped && !fresh && st !== null && st.load === 'loaded' && (st.active === 'inactive' || st.active === 'deactivating')) {
        // The bridge's rule: a unit an operator stopped is not started by an unattended update. A fresh unit was stopped by nobody.
        deps.out(`  · herdr service ${where} installed, but it is ${st.active}: left stopped (--keep-stopped);  ${sm.hints.start(unit)}`);
        return;
      }
      const r = st?.active === 'failed' ? await sm.resetAndRestart(unit) : await sm.start(unit);
      if (r.code !== 0) throw new Error(`${sm.hints.start(unit)} failed (${r.code ?? 'no exit code'}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      const started = deps.now();
      while (!(await herdrUp(deps)) && deps.now() - started < HERDR_START_WAIT_MS) await deps.sleep(500);
      if (await herdrUp(deps)) deps.out(`  ✔ herdr service ${where} started`);
      else deps.out(`  ⚠ herdr service ${where} started, but herdr does not answer yet at ${deps.herdrSocket}:  ${sm.hints.logs(unit, 30)}`);
    } catch (err) {
      if (takeBack) {
        fs.rmSync(unitPath, { force: true });
        fs.rmSync(`${unitPath}.pending`, { force: true });
        await sm.reload().catch(() => undefined);
      }
      const why = (err as Error).message;
      if (opts.herdrService === false) deps.out(`  ⚠ --no-herdr-service: ${name} could not be written disabled (${why}); ${takeBack || standingState === 'not-found' ? 'nothing was installed' : `it stays ${standingState}`}`);
      else deps.out(`  ⚠ could not install the herdr service ${name}: ${why} — start herdr yourself after a reboot (run \`herdr\`)`);
    } finally {
      for (const line of afterword) deps.out(line);
      lock?.release();
    }
  };
}

function herdrCheck(deps: SetupDeps, herdrService: () => Promise<void>): () => Promise<Check> {
  return async () => {
    // Nothing once it has run; until then on every poll, before the socket is looked at: a herdr installed while
    // setup waits gets its service, which starts it — or, when the user started it as well, takes over at the next boot.
    await herdrService();
    if (!fs.existsSync(deps.herdrSocket)) {
      const installed = (await deps.exec('herdr', ['--version'])).code === 0;
      return {
        ok: false,
        problem: `herdr is not running (no socket at ${deps.herdrSocket})`,
        fix: installed ? ['start it: run  herdr  in another terminal'] : [`install it:  ${HERDR_INSTALL}`, 'then run  herdr  in another terminal'],
      };
    }
    return check();
  };
  async function check(): Promise<Check> {
    try {
      const pong = await deps.herdrPing(deps.herdrSocket);
      const note = `herdr ${pong.version} (protocol ${pong.protocol}) at ${deps.herdrSocket}`;
      if (pong.protocol === HERDR_PROTOCOL) return { ok: true, note };
      return { ok: true, note, warn: `this bridge was built against herdr protocol ${HERDR_PROTOCOL}; panes may not mirror correctly` };
    } catch (err) {
      return {
        ok: false,
        problem: `herdr did not answer at ${deps.herdrSocket}: ${(err as Error).message}`,
        fix: ['start herdr (run  herdr  in another terminal); a stale socket from an old session is replaced when it starts'],
      };
    }
  }
}

async function readTailscale(deps: SetupDeps): Promise<{ binary: boolean; status: TailscaleStatus | null }> {
  const r = await deps.exec('tailscale', ['status', '--json']);
  const binary = !(r.code === null && /ENOENT/.test(r.stderr));
  let status: TailscaleStatus | null = null;
  if (r.code === 0) {
    try {
      status = JSON.parse(r.stdout) as TailscaleStatus;
    } catch {
      status = null;
    }
  }
  return { binary, status };
}

function tailnetCheck(deps: SetupDeps, seen: { name: string | null }, opts: { cert: boolean }): () => Promise<Check> {
  return async () => {
    const { binary, status } = await readTailscale(deps);
    const state = classifyTailnet(status, binary, { cert: opts.cert, platform: deps.platform ?? 'linux' });
    if (!state.ok) return state;
    seen.name = state.name;
    const who = state.name ?? state.ip ?? 'this node';
    return opts.cert
      ? { ok: true, note: `Tailscale running as ${who}${state.ip && state.name ? ` (${state.ip})` : ''}, HTTPS Certificates enabled` }
      : { ok: true, note: `Tailscale running as ${who}: the tailnet gate can identify your phones` };
  };
}

function certCheck(deps: SetupDeps, name: string, tlsMode: 'auto' | 'tailscale'): () => Promise<Check> {
  return async () => {
    fs.mkdirSync(deps.tlsDir, { recursive: true, mode: 0o700 });
    const r = await deps.exec('tailscale', tailscaleCertArgs(deps.tlsDir, name), { timeoutMs: 90_000 });
    if (r.code === 0) return { ok: true, note: `certificate for ${name} (publicly trusted, renewed by the bridge)` };
    const c = classifyCertFailure(r.stderr || r.stdout, deps.user, name, tlsMode, deps.platform ?? 'linux');
    return { ok: false, problem: c.problem, fix: c.fix, retryMs: CERT_POLL_MS, stop: !c.retry };
  };
}

/** For an installed release, the repair script both units run first (written here, so it follows this install); undefined otherwise. */
function installRepairScript(deps: SetupDeps): string | undefined {
  const layout = installLayout(deps.mainPath);
  if (layout.kind !== 'release') return undefined;
  const file = repairScriptPath(layout.home);
  fs.rmSync(`${file}.tmp`, { force: true });
  fs.writeFileSync(`${file}.tmp`, renderRepairScript(layout.home), { mode: 0o755 });
  fs.chmodSync(`${file}.tmp`, 0o755); // the mode above is filtered by the umask
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/** REMOTLY_TAILSCALE as this setup runs with it (tailscale.ts honours it), for the units to carry; undefined when unset or blank. */
const tailscaleOverride = (env: NodeJS.ProcessEnv): string | undefined => env['REMOTLY_TAILSCALE']?.trim() || undefined;

/** A unit file or agent plist, in place by rename, 0644 whatever the umask (launchd refuses a group-writable plist; a unit file is world-readable by convention). */
function writeUnitFile(file: string, text: string): void {
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  fs.chmodSync(`${file}.tmp`, 0o644); // the mode above is filtered by the umask
  fs.renameSync(`${file}.tmp`, file);
}

/** Writes, reloads, enables and restarts the unit; false when `--keep-stopped` found it stopped and left it so. */
async function installUnit(deps: SetupDeps, sm: ServiceManager, opts: SetupOptions): Promise<boolean> {
  fs.mkdirSync(deps.unitDir, { recursive: true });
  const unitPath = sm.unitPath(opts.unit); // the same name every service-manager call uses
  const text = sm.renderUnit({ unit: opts.unit, nodePath: deps.nodePath, mainPath: deps.mainPath, configDir: opts.configDir, herdrSession: opts.herdrSession, herdrSocket: opts.herdrSocket, tailscale: tailscaleOverride(deps.env), repairScript: installRepairScript(deps) });
  writeUnitFile(unitPath, text);
  await sm.reload();
  await sm.enable(opts.unit);
  if (opts.keepStopped) {
    // Read right before the restart (the checks above may have taken a while): a unit an operator stopped meanwhile is
    // not started by an unattended update; a `failed` one (crash loop) was running and is. No answer is neither.
    const st = await sm.state(opts.unit);
    const stopped = st === null ? `${sm.name} did not say whether it is running` : st.load === 'loaded' && (st.active === 'inactive' || st.active === 'deactivating') ? `it is ${st.active}` : null;
    if (stopped !== null) {
      deps.out(`  · service ${opts.unit} installed at ${unitPath} (node ${deps.nodePath}), but ${stopped}: left stopped (--keep-stopped);  ${sm.hints.start(opts.unit)}`);
      return false;
    }
  }
  // `restart` also starts a stopped unit, and a running one picks up the code this setup belongs to.
  const r = await sm.restart(opts.unit);
  if (r.code !== 0) throw new Error(`${sm.hints.restart(opts.unit)} failed (${r.code ?? 'no exit code'}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  deps.out(`  ✔ service ${opts.unit} installed at ${unitPath} (node ${deps.nodePath})`);
  return true;
}

/**
 * The daily update timer, for an installed release only (a checkout has its own delivery; `update` would only ever
 * refuse). Written on every setup so it follows the node and paths of this install; enabled on the first install,
 * afterwards left as the user has it: a timer they disabled or masked stays that way (`--no-auto-update` writes it
 * disabled). Never fails the setup: the bridge matters more than its updater.
 */
async function installUpdateTimer(deps: SetupDeps, sm: ServiceManager, opts: SetupOptions): Promise<void> {
  const names = sm.updateNames(opts.unit);
  const layout = installLayout(deps.mainPath);
  if (layout.kind !== 'release') {
    deps.out(`  · no update timer: this copy runs from ${layout.kind === 'checkout' ? `a repository checkout (${layout.root})` : deps.mainPath}, not from an installed release`);
    return;
  }
  const paths = sm.updatePaths(opts.unit);
  const files = paths.service === paths.timer ? [paths.timer] : [paths.service, paths.timer]; // launchd: one agent is both
  const marker = timerMarkerPath(layout.home, opts.unit);
  let fresh = false;
  let takeBack = false; // units this setup wrote and has not enabled: taken back should it fail — never an enabled timer's
  try {
    // The manager's word on the timer: `enabled`, `enabled-runtime`, `disabled`, `masked` (systemd: the timer, its
    // service, or both — a masked service makes the timer fail every day), `not-found` (does not exist yet), or another
    // arrangement. Unreadable — no answer, an error — leaves the units as they are: a query that failed must not pass
    // for "fresh" and enable a timer the user turned off.
    const timer = await sm.timerState(opts.unit);
    if (timer.unreadable) {
      deps.out(`  ⚠ cannot tell whether ${names.timer} is enabled (${timer.unreadable}); the update units are left as they are`);
      return;
    }
    if (timer.state === 'masked') {
      const masked = timer.masked ?? [names.timer];
      fs.rmSync(marker, { force: true }); // the user's word, whatever an interrupted setup left behind
      deps.out(`  · auto-update off: ${masked.join(' and ')} ${masked.length > 1 ? 'are' : 'is'} masked (${sm.hints.unmask(masked)}, then setup again, turns it on)`);
      return;
    }
    // A marker left by a setup that stopped between writing the timer and enabling it: that "disabled" is not the
    // user's word either.
    fresh = timer.state === 'not-found' || fs.existsSync(marker);
    takeBack = fresh && timer.state !== 'enabled' && timer.state !== 'enabled-runtime'; // a marker beside an enabled timer: a setup stopped between `enable` and removing it
    if (fresh) fs.writeFileSync(marker, '');
    const units = sm.renderUpdateUnits({
      unit: opts.unit,
      nodePath: deps.nodePath,
      mainPath: deps.mainPath,
      configDir: opts.configDir,
      herdrSession: opts.herdrSession,
      herdrSocket: opts.herdrSocket,
      tailscale: tailscaleOverride(deps.env),
      installerEnv: installerEnv(deps.env, deps.nodePath, deps.mainPath, layout.home),
      repairScript: repairScriptPath(layout.home), // written by installUnit just before
    });
    for (const [file, text] of files.map((f) => [f, f === paths.timer ? units.timer : units.service] as const)) writeUnitFile(file, text);
    await sm.reload();
    if (opts.autoUpdate === false) {
      fs.rmSync(marker, { force: true }); // the user's word, whatever `disable` makes of it
      try {
        await sm.disableTimerNow(opts.unit);
      } catch (err) {
        // The units stay (they are what --no-auto-update leaves behind, disabled); a timer that was enabled before may still be.
        deps.out(`  ⚠ could not turn auto-update off (${(err as Error).message}): ${names.timer} may still be enabled — off:  ${sm.hints.disableTimer(opts.unit)}`);
        return;
      }
      deps.out(`  · auto-update off (--no-auto-update); on:  ${sm.hints.enableTimer(opts.unit)}`);
      return;
    }
    // A timer that exists and is not enabled was turned off by the user (`disable`, or never enabled after
    // --no-auto-update): later setups leave that alone. `enabled-runtime` is enabled until the next boot — made
    // permanent below like a fresh one. Anything else (`linked`, `static`, …) is a hand-made arrangement: left alone.
    if (!fresh && timer.state !== 'enabled' && timer.state !== 'enabled-runtime') {
      const active = await sm.timerActive(opts.unit);
      deps.out(`  · auto-update off (${names.timer} is ${timer.state}${active ? ', started by hand: it runs until the next boot only' : ''}); on:  ${sm.hints.enableTimer(opts.unit)}`);
      return;
    }
    await sm.enableTimer(opts.unit);
    takeBack = false; // enabled: the files stay whatever happens next (taking them back would leave the enabling link dangling)
    fs.rmSync(marker, { force: true }); // and from here on a "disabled" is the user's word (a stop before the restart leaves it enabled)
    try {
      await sm.restartTimer(opts.unit); // starts it, and a running one re-reads the schedule
    } catch (err) {
      // Enabled, so it runs from the next boot; the units stay (taking them back would leave the enabling link dangling).
      deps.out(`  ⚠ daily update ${names.timer} is enabled but could not be started now (${(err as Error).message}); it starts at the next ${sm.kind === 'launchd' ? 'login' : 'boot'}, or now:  ${sm.hints.startTimer(opts.unit)}`);
      return;
    }
    deps.out(`  ✔ daily update ${names.timer} (runs \`remotly-bridge update\`; off:  ${sm.hints.disableTimer(opts.unit)})`);
  } catch (err) {
    // Units this setup wrote and could not enable are taken back: left in place, the next setup would read their
    // "disabled" as the user's choice and never try again. (The marker stays too, for a setup stopped by a signal.)
    if (takeBack) {
      for (const f of files) fs.rmSync(f, { force: true });
      await sm.reload().catch(() => undefined);
    }
    deps.out(`  ⚠ could not install the update timer ${names.timer}: ${(err as Error).message} — the bridge runs without it; \`remotly-bridge update\` updates by hand`);
  }
}

/**
 * Two things must not happen in a setup run: repointing a unit that is serving another config dir (production, say,
 * while this run was meant for a second instance), and installing over a daemon that already holds this config dir's
 * control socket (the unit could never bind). A running unit therefore has to be the daemon answering here — same
 * pid, or a pid-less daemon from before this version — and a unit that is starting, stopping or in its restart delay
 * (MainPID 0 for a moment) is left alone rather than taken for "not running". Called before anything is written and
 * again right before the unit file is, since the checks in between can wait for minutes.
 */
/**
 * A unit of setup's of a derived kind, by its text: its herdr unit (the marker as the comment setup writes, wherever
 * it stands — a file re-saved with CRLF keeps it), its update unit (the Description directive setup writes, as a line) or its update agent
 * (a plist whose ProgramArguments has an argument that is `update` or ends in ` update`: `node main update`, or the
 * repair wrapper's `/bin/sh "$0"; exec "$1" "$2" update`). A bridge unit's own text — `serve`, its Description, an
 * environment that may mention anything — is none of these.
 */
export function derivedUnitKind(text: string): 'herdr service' | 'updater' | null {
  if (new RegExp(`^# ${HERDR_UNIT_MARKER}\\b`, 'm').test(text) || text.includes(`<!-- ${HERDR_UNIT_MARKER}`)) return 'herdr service'; // the comment setup writes it as (a `#` line; an XML comment, which no plist value can hold unescaped), wherever it stands: a value that merely holds the words (a config dir so named) is not it
  if (/^Description=Remotly bridge update(?:,| \()/m.test(text)) return 'updater';
  const pa = xmlPlistRoot(text)?.get('ProgramArguments');
  if (pa?.kind === 'strings' && pa.items.some((a) => a === 'update' || a.endsWith(' update'))) return 'updater';
  return null;
}

/**
 * A bridge unit of setup's, told from its text — the shape every release has written (0.1.0 on; launchd since 0.3.0):
 * on systemd the Description `Remotly bridge (herdr → phone)` and an `ExecStart=` of two words (node, main.ts,
 * quoted as `q` does) then `serve`; on launchd a plist `xmlPlistRoot` reads whose Label is this unit's, with no
 * `Program` key and ProgramArguments exactly `node main serve` or the repair wrapper's six (`/bin/sh -c '/bin/sh
 * "$0"; exec "$1" "$2" serve' repair node main`). A unit of the user's own that happens to end in `serve`
 * (`ExecStart=/usr/local/bin/worker serve`) is not told; nor is what this does not read — a binary plist
 * (`plutil -convert binary1` keeps a ProgramArguments and drops a comment, so an updater or a herdr agent so
 * converted is told by nothing above), text of another shape. At a derived name nothing is written over those.
 */
export function bridgeUnitOfSetup(text: string, kind: ServiceKind, label?: string): boolean {
  if (kind === 'launchd') {
    const root = xmlPlistRoot(text);
    const l = root?.get('Label');
    const pa = root?.get('ProgramArguments');
    if (!root || root.has('Program') || l?.kind !== 'string' || l.value !== label || pa?.kind !== 'strings') return false;
    const a = pa.items;
    return (a.length === 3 && a[2] === 'serve') || (a.length === 6 && a[0] === '/bin/sh' && a[1] === '-c' && a[2] === '/bin/sh "$0"; exec "$1" "$2" serve');
  }
  // The one ExecStart systemd runs: a second `ExecStart=` line, or an empty one (a reset) before another, makes the
  // unit run something else than the line that matches — not the shape setup wrote.
  const execs = text.split(/\r?\n/).filter((l) => /^\s*ExecStart\s*=/.test(l));
  return /^Description=Remotly bridge \(herdr → phone\)$/m.test(text) && execs.length === 1 && /^ExecStart=(?:"[^"\n]*"|[^\s"]+) (?:"[^"\n]*"|[^\s"]+) serve$/.test(execs[0] as string);
}

async function ownershipGuard(deps: SetupDeps, sm: ServiceManager, opts: SetupOptions): Promise<boolean> {
  // The names setup derives for a bridge — `<unit>-herdr` for its herdr service, `<unit>-update` for its updater — are
  // no new bridge's: bridge `alpha-herdr` and bridge `alpha`'s herdr unit would be one file, written over by turns (an
  // enabled-but-inactive herdr unit looks settled below). So a unit of setup's of either kind under this name is never
  // written over — the herdr marker as the comment setup writes (a file re-saved with CRLF keeps it); an
  // update unit by its Description, an update agent by the `update` its arguments end in — and a name of that shape
  // with nothing at its path is refused outright. A bridge installed under such a name before this check, its own
  // unit at the path, keeps working (its unattended updates run setup under that name): at a derived name the file
  // has to be told to be a bridge unit (bridgeUnitOfSetup: the shape every release wrote); one that cannot be read,
  // or that this does not read (a unit of the user's own, a plist converted to binary), may be the other bridge's,
  // and is left alone.
  const unitFile = sm.unitPath(opts.unit);
  const derived = /-(herdr|update)$/.exec(opts.unit);
  const base = derived ? opts.unit.slice(0, -derived[0].length) : '';
  const what = derived?.[1] === 'herdr' ? 'herdr service' : 'updater';
  const present = fs.existsSync(unitFile);
  const atPath = present ? readTextIfAny(unitFile) : null;
  const ours = atPath === null ? null : derivedUnitKind(atPath);
  if (ours !== null) {
    deps.out(`  ✖ unit ${opts.unit} is the ${ours} setup wrote${derived ? ` for the bridge unit ${base}` : ''} — not writing a bridge unit over it`);
    deps.out('      pick another name:  remotly-bridge setup --unit <name>');
    return false;
  }
  if (derived && present && (atPath === null || !bridgeUnitOfSetup(atPath, sm.kind, sm.kind === 'launchd' ? sm.unitName(opts.unit) : undefined))) {
    deps.out(`  ✖ unit ${opts.unit}: ${unitFile} ${atPath === null ? 'cannot be read' : 'is not a bridge unit setup can tell (not what setup writes for one)'} — not writing a bridge unit over what may be ${base}'s ${what}`);
    return false;
  }
  if (derived && !present) {
    deps.out(`  ✖ --unit ${opts.unit}: a name ending in -${derived[1]} is one setup derives for a bridge (${base}'s ${what} would be this unit) — pick another`);
    return false;
  }
  const st: UnitState | null = await sm.state(opts.unit);
  const existing = await deps.status(3000).catch(() => null);
  if (st === null) {
    if (fs.existsSync(sm.unitPath(opts.unit))) {
      deps.out(`  ✖ ${sm.name} did not say whether unit ${opts.unit} is running (${sm.hints.query(opts.unit)} failed) — not touching its unit file`);
      deps.out(`      check:  ${sm.hints.status(opts.unit)}`);
      return false;
    }
    // no unit file and no answer from the manager: the session check below explains what is missing
  } else if (st.load === 'masked') {
    // an administrator's "never start this": a unit file written over the mask would undo it
    deps.out(`  ✖ unit ${opts.unit} is masked — not writing over that`);
    deps.out(`      to use this name again:  ${sm.hints.unmask([sm.unitName(opts.unit)])}   (or pick another --unit)`);
    return false;
  } else if (st.load !== 'not-found' && st.load !== 'loaded') {
    deps.out(`  ✖ unit ${opts.unit} is in load state "${st.load}" — ${sm.name} could not read it, so setup does not replace it blindly`);
    deps.out(`      check:  ${sm.hints.status(opts.unit)}   then remove or fix the unit file and run setup again`);
    return false;
  } else if (st.load === 'loaded') {
    const settled = st.active === 'inactive' || st.active === 'failed' || (st.active === 'active' && st.pid > 0);
    if (!settled) {
      deps.out(`  ✖ unit ${opts.unit} is ${st.active}${st.sub ? ` (${st.sub})` : ''} right now — it may be restarting; not touching it until it has settled`);
      deps.out(`      wait a few seconds and run setup again, or stop it first:  ${sm.hints.stop(opts.unit)}`);
      return false;
    }
    if (st.active === 'active') {
      if (!existing || (existing.pid !== undefined && existing.pid !== st.pid)) {
        deps.out(`  ✖ unit ${opts.unit} is running (pid ${st.pid}) but not on this config dir — it serves another instance`);
        deps.out(`      for a second instance pick another name:  remotly-bridge setup --unit <name> --config-dir <dir>`);
        deps.out(`      to repoint ${opts.unit} at this config dir anyway, stop it first:  ${sm.hints.stop(opts.unit)}`);
        return false;
      }
      return true;
    }
  }
  if (existing) {
    deps.out(`  ✖ another remotly-bridge${existing.pid !== undefined ? ` (pid ${existing.pid})` : ''} already serves this config dir (its control socket answers) and it is not unit ${opts.unit}`);
    deps.out('      a second instance needs its own --config-dir (and port); to replace a manually started `serve`, stop it first');
    return false;
  }
  return true;
}

/**
 * Healthy means the daemon answering on this config dir's control socket *is* the unit just restarted (same pid as
 * systemd's MainPID). Another instance on the same socket — a manual `serve`, or another unit without its own
 * `--config-dir` — answers too, while the new unit keeps failing to bind; that must not pass.
 */
async function waitHealthy(deps: SetupDeps, sm: ServiceManager, unit: string): Promise<{ status: ControlStatus | null; other: ControlStatus | null }> {
  const started = deps.now();
  let told = false;
  let other: ControlStatus | null = null;
  for (;;) {
    try {
      const status = await deps.status(3000);
      const main = (await sm.state(unit))?.pid ?? 0;
      if (status.pid !== undefined && main > 0 && status.pid === main) return { status, other: null };
      other = status;
    } catch {
      /* not up yet */
    }
    if (deps.now() - started >= HEALTH_WAIT_MS) return { status: null, other };
    if (!told && deps.now() - started >= 5000) {
      deps.out('    waiting for the bridge to start…');
      told = true;
    }
    await deps.sleep(1000);
  }
}

/** Runs the whole sequence; returns the process exit code. */
export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<number> {
  const sm = deps.service ?? systemdManager({ exec: deps.exec, unitDir: deps.unitDir, user: deps.user, uid: deps.uid, home: deps.home ?? path.dirname(path.dirname(path.dirname(deps.unitDir))), env: deps.env });
  deps.out(`remotly-bridge ${deps.version} setup`);
  if (deps.uid === 0) {
    deps.out('  ✖ run setup as the user who runs herdr, not as root (herdr\'s socket and the service are per user)');
    return 1;
  }
  let cfg: SetupConfigView;
  try {
    cfg = deps.loadConfig();
    deps.out(`  ✔ config ${deps.configPath}`);
  } catch (err) {
    deps.out(`  ✖ ${(err as Error).message}`);
    return 1;
  }

  if (!(await ownershipGuard(deps, sm, opts))) return 1; // before anything is written (config, certificate, unit)

  // The service manager, before the first unit is written (the herdr service comes first: it is what starts herdr
  // when it is not running).
  const sd = await sm.sessionCheck();
  if (!sd.ok) {
    deps.out(`  ✖ ${sd.problem}`);
    for (const f of sd.fix) deps.out(`      ${f}`);
    return 1;
  }
  const herdrService = herdrServiceInstaller(deps, sm, opts);
  await herdrService();
  if (!(await waitFor(deps, opts, herdrCheck(deps, herdrService)))) return 1;

  // The agents' own settings: made by every setup run by hand, by an unattended re-run (`update`) only once per install
  // (one from before this step); after that they are the user's.
  {
    const home = deps.home ?? os.homedir();
    agentSettingsStep(
      {
        dirs: deps.agentDirs ?? agentDirs(deps.env, home),
        env: deps.env,
        home,
        out: deps.out,
        record: deps.agentRecord ?? path.join(path.dirname(deps.configPath), AGENT_SETTINGS_RECORD),
        claudeRunning: deps.claudeRunning ?? (() => claudeRunning(deps.uid)),
      },
      { unattended: opts.keepMode === true, skip: opts.agentSettings === false },
    );
  }

  // Which certificate the daemon will run on. `--lan` and `tls.mode` decide; only `auto` tries Tailscale with a fallback.
  // `--keep-mode` (unattended re-runs) takes the mode from config.json instead of switching a LAN host back to Tailscale.
  let selfSigned = false;
  let fallback = false; // self-signed only because `tailscale cert` failed under tls.mode auto
  try {
    if (opts.keepMode && !opts.lan && isLanMode(deps.configPath)) {
      opts = { ...opts, lan: true };
      deps.out('  ⚠ LAN mode kept (config.json: tls.mode selfsigned, listen.host 0.0.0.0, require_tailnet false) — no Tailscale checks');
    } else if (opts.lan) {
      const keys = enableLanMode(deps.configPath);
      cfg = deps.loadConfig(); // still valid after the merge
      deps.out(`  ⚠ LAN mode: ${keys.join(', ')} written to config.json — self-signed certificate (iPhones refuse it; Android pins it), every interface, no tailnet gate`);
    } else if (!opts.keepMode && disableLanMode(deps.configPath)) {
      cfg = deps.loadConfig();
      deps.out('  ⚠ LAN mode removed from config.json (tls.mode, listen.host, security.require_tailnet back to auto) — this host uses Tailscale again; run `setup --lan` to keep LAN mode');
    }
  } catch (err) {
    deps.out(`  ✖ could not update ${deps.configPath}: ${(err as Error).message}`);
    return 1;
  }
  if (cfg.tls.mode === 'selfsigned') {
    // No certificate to request, but the tailnet gate is a separate matter: `true` needs a logged-in Tailscale, and
    // `auto` switches the gate on whenever Tailscale is installed — the daemon waits for a stopped tailscaled at start-up
    // and refuses to run with the gate off (server/tailscale-wait.ts), so setup insists on it too; only a host without
    // the binary runs with the gate off (LAN).
    if (!opts.lan) deps.out('  ⚠ tls.mode is "selfsigned" in config.json: no Tailscale certificate (iPhones refuse the self-signed one)');
    const gate = cfg.security.require_tailnet;
    if (gate === true || (gate === 'auto' && (await readTailscale(deps)).binary)) {
      if (!(await waitFor(deps, opts, tailnetCheck(deps, { name: null }, { cert: false })))) return 1;
    } else if (gate === 'auto') deps.out('  ⚠ Tailscale is not installed here, so the tailnet gate is off: any device that can reach this host may try to pair');
    selfSigned = true;
  } else {
    const seen: { name: string | null } = { name: null };
    if (!(await waitFor(deps, opts, tailnetCheck(deps, seen, { cert: true }))) || !seen.name) return 1;
    deps.out('    requesting the certificate (the first one can take up to a minute)…');
    if (!(await waitFor(deps, opts, certCheck(deps, seen.name, cfg.tls.mode)))) {
      if (!opts.wait) return 1;
      if (cfg.tls.mode === 'tailscale') {
        deps.out('  ✖ tls.mode is "tailscale" in config.json: the bridge does not start without that certificate — make `tailscale cert` work, or set tls.mode to "auto" to allow the self-signed fallback');
        return 1;
      }
      deps.out('    continuing without it; the bridge falls back to a self-signed certificate until `tailscale cert` works');
      selfSigned = true;
      fallback = true;
    }
  }
  if (selfSigned && (await deps.exec('openssl', ['version'])).code !== 0) {
    deps.out('  ✖ openssl not found — the bridge needs it to create its self-signed certificate');
    deps.out('      install it (Debian/Ubuntu: sudo apt install openssl; Fedora: sudo dnf install openssl), then run setup again');
    return 1;
  }

  if (!(await ownershipGuard(deps, sm, opts))) return 1; // again: the checks above may have waited for minutes
  let started: boolean;
  try {
    started = await installUnit(deps, sm, opts);
  } catch (err) {
    deps.out(`  ✖ ${(err as Error).message}`);
    return 1;
  }
  for (const line of await sm.persistence()) deps.out(line);
  await installUpdateTimer(deps, sm, opts);
  if (!started) {
    // Nothing to wait for or to pair with: the unit was left stopped on purpose.
    deps.out(`setup complete (${opts.unit} left stopped)`);
    return 0;
  }

  const { status, other } = await waitHealthy(deps, sm, opts.unit);
  if (!status) {
    if (other) deps.out(`  ✖ a remotly-bridge${other.pid !== undefined ? ` (pid ${other.pid})` : ''} answers on this config dir, but it is not unit ${opts.unit} — another instance holds the control socket; give this one its own --config-dir or stop the other`);
    else deps.out(`  ✖ the bridge did not answer within ${HEALTH_WAIT_MS / 1000} s`);
    deps.out(`    ${sm.kind === 'systemd' ? 'journal' : 'log'} of ${opts.unit}:`);
    for (const line of await sm.logTail(opts.unit, 20)) deps.out(`      ${line}`);
    return 1;
  }
  deps.out(`  ✔ bridge running: listening ${status.listen ? `${status.listen.host}:${status.listen.port}` : '-'}, certificate ${status.tls.mode}, herdr ${status.herdr}`);
  if (status.herdr === 'down') deps.out('  ⚠ the bridge cannot reach herdr right now; it reconnects by itself when herdr is back');
  if (status.tls.mode === 'selfsigned' && fallback) deps.out(`  ⚠ self-signed certificate in use — iPhones refuse it; once \`tailscale cert\` works, restart:  ${sm.hints.restart(opts.unit)}`);
  else if (status.tls.mode === 'selfsigned' && !selfSigned) deps.out(`  ⚠ the daemon runs on a self-signed certificate although a Tailscale one was just issued — check its ${sm.kind === 'systemd' ? 'journal' : 'log'}:  ${sm.hints.logs(opts.unit, 30)}`);
  if (!status.push.apns && !status.push.fcm) deps.out('  ⚠ no push route: notifications are off (push.relay_url is empty and no local credentials)');

  if (opts.pair) {
    try {
      await deps.showPairing(await deps.pair(opts.ttlSec));
    } catch (err) {
      deps.out(`  ✖ could not create a pairing code: ${(err as Error).message}`);
      return 1;
    }
  }
  deps.out('setup complete');
  return 0;
}
