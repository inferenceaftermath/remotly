// `remotly-bridge setup`: the one command install.sh runs — herdr and Tailscale checks, the certificate, the systemd
// user unit, a health wait and the pairing QR. A failing check prints its fix and, unless --no-wait, polls until the
// user has applied it (so a `sudo …` line runs in another terminal while this one waits). Spawns go through an
// injectable exec and every other effect is a dependency, so tests never touch binaries, systemd or the network.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.ts';
import type { ControlStatus, PairInfo } from './control.ts';
import { tailscaleCertArgs } from './server/tls.ts';
import { magicDnsName, type ExecFn, type TailscaleStatus, selfIdentified } from './tailscale.ts';

export const HERDR_INSTALL = 'curl -fsSL https://herdr.dev/install.sh | sh';
export const TAILSCALE_INSTALL = 'curl -fsSL https://tailscale.com/install.sh | sh';
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
   * For unattended re-runs (the CI deploy, an upgrade script); without it an ordinary `setup` means "Tailscale again".
   */
  keepMode?: boolean;
  /** Poll until a failing check passes (default); false → stop at the first failing check. */
  wait: boolean;
  /** Print a pairing QR at the end (default). */
  pair: boolean;
  ttlSec: number;
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
export function unitFile(name: string): string {
  return `${name.replace(/\.service$/, '')}.service`;
}

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
  /** `~/.config/systemd/user`. */
  unitDir: string;
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
 * version); otherwise the real path (a version manager's install dir, the installer's private runtime, or a system
 * node), which stays valid across shells.
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
  try {
    return realpath(execPath);
  } catch {
    return execPath;
  }
}

/** systemd quoting: double quotes keep spaces together and `%` is a specifier, so it is doubled; the rest is refused. */
function q(s: string): string {
  if (/["\\$\n]/.test(s)) throw new Error(`cannot put ${JSON.stringify(s)} in a unit file (quote, backslash, $ or newline)`);
  return `"${s.replace(/%/g, '%%')}"`;
}

export function renderUnit(o: { nodePath: string; mainPath: string; configDir?: string | undefined; herdrSession?: string | undefined; herdrSocket?: string | undefined }): string {
  // A user unit cannot order itself after the system `tailscaled.service` (the user manager does not see system units),
  // so `serve` itself waits for Tailscale at start-up (server/tailscale-wait.ts) instead of an `After=` that would be ignored.
  const lines = [
    '[Unit]',
    'Description=Remotly bridge (herdr → phone)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${q(o.nodePath)} ${q(o.mainPath)} serve`,
    'Restart=always',
    'RestartSec=2',
    'Environment=NODE_ENV=production',
  ];
  if (o.configDir) lines.push(`Environment=${q(`REMOTLY_CONFIG_DIR=${o.configDir}`)}`);
  if (o.herdrSession) lines.push(`Environment=${q(`HERDR_SESSION=${o.herdrSession}`)}`);
  if (o.herdrSocket) lines.push(`Environment=${q(`HERDR_SOCKET_PATH=${o.herdrSocket}`)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

/** `name` is null only for `cert: false` checks on a tailnet without MagicDNS. */
export type TailnetState = { ok: true; ip: string | null; name: string | null } | { ok: false; problem: string; fix: string[] };

/**
 * What stands between this host and a working Tailscale, in the order the user has to fix it. `cert: true` (default)
 * goes on to what a certificate needs — MagicDNS and "HTTPS Certificates"; `cert: false` stops at a logged-in node,
 * which is all the tailnet gate needs.
 */
export function classifyTailnet(status: TailscaleStatus | null, binaryPresent: boolean, opts: { cert?: boolean } = {}): TailnetState {
  if (!binaryPresent) return { ok: false, problem: 'Tailscale is not installed', fix: [`install it:  ${TAILSCALE_INSTALL}`, 'then log in:  sudo tailscale up'] };
  if (!status) return { ok: false, problem: 'tailscaled is not running', fix: ['sudo systemctl enable --now tailscaled', 'then:  sudo tailscale up'] };
  const state = status.BackendState ?? 'unknown';
  if (state !== 'Running') {
    return { ok: false, problem: state === 'NeedsLogin' ? 'Tailscale is not logged in' : `Tailscale is not running (state ${state})`, fix: ['sudo tailscale up     (prints a login link; open it on any device)'] };
  }
  // The same reading of "up" as serve's start-up wait (tailscale.ts selfIdentified): a Running node whose status has no
  // Self.UserID would pass here and then keep serve waiting, and the gate could identify nobody.
  if (!selfIdentified(status)) {
    return { ok: false, problem: 'Tailscale is running but its status carries no identity for this node (Self.UserID) — the tailnet gate could not tell your phones from strangers', fix: ['sudo tailscale up     (log in again)', 'then:  tailscale status --json | grep -m1 UserID'] };
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
export function classifyCertFailure(output: string, user: string, name: string, tlsMode: 'auto' | 'tailscale' = 'auto'): { problem: string; fix: string[]; retry: boolean } {
  if (/access denied/i.test(output)) {
    return { problem: 'Tailscale refuses certificate requests from this user', fix: [`sudo tailscale set --operator=${user}`], retry: true };
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
export function systemdUserDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'systemd', 'user');
}

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

function herdrCheck(deps: SetupDeps): () => Promise<Check> {
  return async () => {
    if (!fs.existsSync(deps.herdrSocket)) {
      const installed = (await deps.exec('herdr', ['--version'])).code === 0;
      return {
        ok: false,
        problem: `herdr is not running (no socket at ${deps.herdrSocket})`,
        fix: installed ? ['start it: run  herdr  in another terminal'] : [`install it:  ${HERDR_INSTALL}`, 'then run  herdr  in another terminal'],
      };
    }
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
  };
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
    const state = classifyTailnet(status, binary, { cert: opts.cert });
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
    const c = classifyCertFailure(r.stderr || r.stdout, deps.user, name, tlsMode);
    return { ok: false, problem: c.problem, fix: c.fix, retryMs: CERT_POLL_MS, stop: !c.retry };
  };
}

async function systemdCheck(deps: SetupDeps): Promise<Check> {
  const r = await deps.exec('systemctl', ['--user', 'show-environment']);
  if (r.code === 0) return { ok: true, note: 'systemd user session' };
  if (r.code === null && /ENOENT/.test(r.stderr)) {
    return { ok: false, stop: true, problem: 'systemctl not found — the service needs systemd', fix: ['run the bridge yourself instead:  remotly-bridge serve'] };
  }
  return {
    ok: false,
    stop: true,
    problem: `no systemd user session for ${deps.user}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
    fix: ['log in to this machine as this user (console or ssh) so systemd starts a user manager', 'if XDG_RUNTIME_DIR is unset in this shell:  export XDG_RUNTIME_DIR=/run/user/$(id -u)'],
  };
}

async function installUnit(deps: SetupDeps, opts: SetupOptions): Promise<void> {
  fs.mkdirSync(deps.unitDir, { recursive: true });
  const unitPath = path.join(deps.unitDir, unitFile(opts.unit)); // the same name every systemctl call uses
  const text = renderUnit({ nodePath: deps.nodePath, mainPath: deps.mainPath, configDir: opts.configDir, herdrSession: opts.herdrSession, herdrSocket: opts.herdrSocket });
  fs.writeFileSync(`${unitPath}.tmp`, text);
  fs.renameSync(`${unitPath}.tmp`, unitPath);
  await run(deps, 'systemctl', ['--user', 'daemon-reload']);
  await run(deps, 'systemctl', ['--user', 'enable', unitFile(opts.unit)]);
  // `restart` also starts a stopped unit, and a running one picks up the code this setup belongs to.
  await run(deps, 'systemctl', ['--user', 'restart', unitFile(opts.unit)]);
  deps.out(`  ✔ service ${opts.unit} installed at ${unitPath} (node ${deps.nodePath})`);
}

async function ensureLinger(deps: SetupDeps): Promise<void> {
  const linger = async (): Promise<boolean> => (await deps.exec('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value'])).stdout.trim() === 'yes';
  if (await linger()) return deps.out('  ✔ starts at boot and survives logout (linger on)');
  await deps.exec('loginctl', ['enable-linger']);
  if (await linger()) return deps.out('  ✔ starts at boot and survives logout (linger enabled)');
  deps.out(`  ⚠ the bridge stops when you log out; run once:  sudo loginctl enable-linger ${deps.user}`);
}

/** What systemd knows about the unit (`not-found` when it does not exist); null when systemd did not answer. */
interface UnitState {
  load: string;
  active: string;
  sub: string;
  pid: number;
}
async function unitState(deps: SetupDeps, unit: string): Promise<UnitState | null> {
  // `Key=value` lines, read by key: systemctl prints properties in its own order, not in the order asked for.
  const r = await deps.exec('systemctl', ['--user', 'show', '-p', 'LoadState,ActiveState,SubState,MainPID', unitFile(unit)]);
  if (r.code !== 0) return null;
  const props = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const load = props.get('LoadState');
  const active = props.get('ActiveState');
  const sub = props.get('SubState');
  const pidText = props.get('MainPID');
  if (load === undefined || active === undefined || sub === undefined || pidText === undefined) return null; // not an answer we understand
  const pid = Number(pidText);
  return { load, active, sub, pid: Number.isInteger(pid) && pid > 0 ? pid : 0 };
}

/**
 * Two things must not happen in a setup run: repointing a unit that is serving another config dir (production, say,
 * while this run was meant for a second instance), and installing over a daemon that already holds this config dir's
 * control socket (the unit could never bind). A running unit therefore has to be the daemon answering here — same
 * pid, or a pid-less daemon from before this version — and a unit that is starting, stopping or in its restart delay
 * (MainPID 0 for a moment) is left alone rather than taken for "not running". Called before anything is written and
 * again right before the unit file is, since the checks in between can wait for minutes.
 */
async function ownershipGuard(deps: SetupDeps, opts: SetupOptions): Promise<boolean> {
  const unit = unitFile(opts.unit);
  const st = await unitState(deps, opts.unit);
  const existing = await deps.status(3000).catch(() => null);
  if (st === null) {
    if (fs.existsSync(path.join(deps.unitDir, unit))) {
      deps.out(`  ✖ systemd did not say whether unit ${opts.unit} is running (systemctl --user show failed) — not touching its unit file`);
      deps.out(`      check:  systemctl --user status ${unit}`);
      return false;
    }
    // no unit file and no answer from systemd: the systemd check below explains what is missing
  } else if (st.load === 'masked') {
    // an administrator's "never start this": a unit file written over the mask would undo it
    deps.out(`  ✖ unit ${opts.unit} is masked — not writing over that`);
    deps.out(`      to use this name again:  systemctl --user unmask ${unit}   (or pick another --unit)`);
    return false;
  } else if (st.load !== 'not-found' && st.load !== 'loaded') {
    deps.out(`  ✖ unit ${opts.unit} is in load state "${st.load}" — systemd could not read it, so setup does not replace it blindly`);
    deps.out(`      check:  systemctl --user status ${unit}   then remove or fix the unit file and run setup again`);
    return false;
  } else if (st.load === 'loaded') {
    const settled = st.active === 'inactive' || st.active === 'failed' || (st.active === 'active' && st.pid > 0);
    if (!settled) {
      deps.out(`  ✖ unit ${opts.unit} is ${st.active}${st.sub ? ` (${st.sub})` : ''} right now — it may be restarting; not touching it until it has settled`);
      deps.out(`      wait a few seconds and run setup again, or stop it first:  systemctl --user stop ${unit}`);
      return false;
    }
    if (st.active === 'active') {
      if (!existing || (existing.pid !== undefined && existing.pid !== st.pid)) {
        deps.out(`  ✖ unit ${opts.unit} is running (pid ${st.pid}) but not on this config dir — it serves another instance`);
        deps.out(`      for a second instance pick another name:  remotly-bridge setup --unit <name> --config-dir <dir>`);
        deps.out(`      to repoint ${opts.unit} at this config dir anyway, stop it first:  systemctl --user stop ${unit}`);
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
async function waitHealthy(deps: SetupDeps, unit: string): Promise<{ status: ControlStatus | null; other: ControlStatus | null }> {
  const started = deps.now();
  let told = false;
  let other: ControlStatus | null = null;
  for (;;) {
    try {
      const status = await deps.status(3000);
      const main = (await unitState(deps, unit))?.pid ?? 0;
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

  if (!(await ownershipGuard(deps, opts))) return 1; // before anything is written (config, certificate, unit)

  if (!(await waitFor(deps, opts, herdrCheck(deps)))) return 1;

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

  const sd = await systemdCheck(deps);
  if (!sd.ok) {
    deps.out(`  ✖ ${sd.problem}`);
    for (const f of sd.fix) deps.out(`      ${f}`);
    return 1;
  }
  if (!(await ownershipGuard(deps, opts))) return 1; // again: the checks above may have waited for minutes
  try {
    await installUnit(deps, opts);
  } catch (err) {
    deps.out(`  ✖ ${(err as Error).message}`);
    return 1;
  }
  await ensureLinger(deps);

  const { status, other } = await waitHealthy(deps, opts.unit);
  if (!status) {
    if (other) deps.out(`  ✖ a remotly-bridge${other.pid !== undefined ? ` (pid ${other.pid})` : ''} answers on this config dir, but it is not unit ${opts.unit} — another instance holds the control socket; give this one its own --config-dir or stop the other`);
    else deps.out(`  ✖ the bridge did not answer within ${HEALTH_WAIT_MS / 1000} s`);
    deps.out(`    journal of ${opts.unit}:`);
    const j = await deps.exec('journalctl', ['--user', '-u', unitFile(opts.unit), '-n', '20', '--no-pager']);
    for (const line of (j.stdout || j.stderr).trim().split('\n')) deps.out(`      ${line}`);
    return 1;
  }
  deps.out(`  ✔ bridge running: listening ${status.listen ? `${status.listen.host}:${status.listen.port}` : '-'}, certificate ${status.tls.mode}, herdr ${status.herdr}`);
  if (status.herdr === 'down') deps.out('  ⚠ the bridge cannot reach herdr right now; it reconnects by itself when herdr is back');
  if (status.tls.mode === 'selfsigned' && fallback) deps.out(`  ⚠ self-signed certificate in use — iPhones refuse it; once \`tailscale cert\` works, restart:  systemctl --user restart ${unitFile(opts.unit)}`);
  else if (status.tls.mode === 'selfsigned' && !selfSigned) deps.out(`  ⚠ the daemon runs on a self-signed certificate although a Tailscale one was just issued — check its journal:  journalctl --user -u ${unitFile(opts.unit)} -n 30`);
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
