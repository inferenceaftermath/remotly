// The service manager the bridge runs under: systemd's user manager on Linux, launchd's per-user agents on macOS.
// `setup` installs the bridge and its daily update under one; `update`, `doctor` and the client commands ask it whether
// the bridge runs and tell the user how to start, stop or read the logs of it. Everything here spawns through an
// injectable exec, so tests script the answers; the systemd side issues exactly the `systemctl --user` calls the bridge
// always made, the launchd side the `launchctl` equivalents (`bootstrap` into the user's gui domain, `bootout`,
// `kickstart -k`, `print`, `enable`/`disable`, `print-disabled`).
//
// What differs and how it is reconciled:
// - A systemd unit is enabled, started and restarted as separate steps; a launchd agent is `bootstrap`ped from its
//   plist (which starts it, RunAtLoad) and re-read only by `bootout` + `bootstrap` again — `restart` here does both.
// - systemd's timer is two units (`<unit>-update.service` + `.timer`); launchd's is one agent with a
//   StartCalendarInterval. `updateNames` returns the same name twice on launchd so callers can treat them alike.
// - A systemd unit can be masked; launchd has `launchctl disable`, which is the user's "never run this" — it reads as
//   `disabled` here (nothing is masked on launchd).
// - Linger: a systemd user manager with linger runs from boot without a login; a launchd user agent runs from login
//   to logout, so after a reboot the Mac needs one login (or automatic login).
// - Logs: systemd's journal; launchd agents write to a file under ~/Library/Logs/remotly.
import fs from 'node:fs';
import path from 'node:path';
import type { ExecFn, ExecResult } from '../tailscale.ts';

export type ServiceKind = 'systemd' | 'launchd';

/** What the service manager knows about a unit; null when it did not answer. */
export interface UnitState {
  /** `loaded` (the manager knows the unit), `not-found` (no such unit), `masked` (systemd only), anything else: unreadable. */
  load: string;
  /** `active`, `activating`, `deactivating`, `inactive`, `failed`. */
  active: string;
  sub: string;
  pid: number;
}

/** What the daily update timer is, in the user's eyes: `enabled`, `enabled-runtime` (systemd: until the next boot), `disabled`, `masked` (systemd), `not-found`, or another arrangement (`linked`, `static`, …). */
export interface TimerState {
  state: string;
  /** Set when the state could not be read: what the manager said. */
  unreadable?: string;
  /** With `masked`: the unit names that are (systemd: the timer, its service, or both). */
  masked?: string[];
}

/** Lines the user is told to run, in the manager's own commands. */
export interface ServiceHints {
  status(unit: string): string;
  /** The query `state()` runs, named when it gave no answer. */
  query(unit: string): string;
  start(unit: string): string;
  stop(unit: string): string;
  restart(unit: string): string;
  /** The daemon's own log (why it does not start or stay up), last `n` lines. */
  logs(unit: string, n: number): string;
  /** The update run's output as the timer saw it. */
  updateLogs(unit: string, n: number): string;
  /** Show the unit as installed. */
  cat(unit: string): string;
  unmask(units: string[]): string;
  enableTimer(unit: string): string;
  disableTimer(unit: string): string;
  startTimer(unit: string): string;
}

export interface ServiceManager {
  readonly kind: ServiceKind;
  /** `systemd` / `launchd`: the manager's name in messages. */
  readonly name: string;
  /** `systemd unit` / `launchd agent`: the noun in messages. */
  readonly noun: string;
  /** Where unit files live: `~/.config/systemd/user` / `~/Library/LaunchAgents`. */
  readonly unitDir: string;
  /** The name every command and message uses: `remotly-bridge.service` / `dev.remotly.remotly-bridge`. */
  unitName(unit: string): string;
  unitPath(unit: string): string;
  /** The daily update's unit names (`<unit>-update.service` + `.timer`; on launchd one agent, named twice). */
  updateNames(unit: string): { service: string; timer: string };
  updatePaths(unit: string): { service: string; timer: string };
  renderUnit(o: UnitRender & { unit: string }): string;
  /** The update unit(s); on launchd `service` and `timer` are the same text. */
  renderUpdateUnits(o: UpdateRender): { service: string; timer: string };
  /**
   * The manager's one word on whether the unit runs — `active`, `activating`, `reloading`, `failed`, `inactive`,
   * `deactivating` — or null when it gave none this code knows; `asked` names the query, `said` what came back.
   */
  activeState(unit: string): Promise<{ state: string | null; asked: string; said: string }>;
  /** `restart`, after clearing a failed state a crash loop may have left (a systemd unit in that state refuses a plain start). */
  resetAndRestart(unit: string): Promise<ExecResult>;
  /** The unit's main pid as the manager has it; 0 when it has none (stopped, or between restarts), null when the query failed. */
  mainPid(unit: string): Promise<number | null>;
  /** Doctor's reading of what keeps the service alive across logouts and reboots. */
  persistenceCheck(unit: string): Promise<{ ok: boolean; message: string; fix?: string }>;
  /** Whether this manager can be used from here: a systemd user session / the launchd gui domain of this user. */
  sessionCheck(): Promise<SessionCheck>;
  state(unit: string): Promise<UnitState | null>;
  /** After unit files were written: systemd re-reads them (`daemon-reload`); launchd reads a plist at bootstrap, so nothing. */
  reload(): Promise<void>;
  enable(unit: string): Promise<void>;
  /** Starts a stopped unit, restarts a running one on the unit file as it is now; a failed one is reset first where that matters. */
  restart(unit: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** What stands between this unit and running at boot/login, as ✔/⚠ lines for setup (empty when nothing to say). */
  persistence(): Promise<string[]>;
  timerState(unit: string): Promise<TimerState>;
  enableTimer(unit: string): Promise<void>;
  disableTimerNow(unit: string): Promise<void>;
  restartTimer(unit: string): Promise<void>;
  timerActive(unit: string): Promise<boolean>;
  /** The last `n` lines of the daemon's log. */
  logTail(unit: string, n: number): Promise<string[]>;
  readonly hints: ServiceHints;
}

export type SessionCheck = { ok: true; note: string } | { ok: false; problem: string; fix: string[] };

export interface UnitRender {
  nodePath: string;
  mainPath: string;
  configDir?: string | undefined;
  herdrSession?: string | undefined;
  herdrSocket?: string | undefined;
  /** REMOTLY_TAILSCALE as setup ran with it: a `tailscale` CLI off PATH stays known to the daemon and the updater (tailscale.ts). */
  tailscale?: string | undefined;
  /** `repair-app.sh`, run before the daemon on an installed release (setup.ts renderRepairScript). */
  repairScript?: string | undefined;
}

export interface UpdateRender extends UnitRender {
  unit: string;
  installerEnv?: Record<string, string> | undefined;
}

/** The installer settings a later `update` has to repeat, as the update unit's environment. */
export const INSTALLER_ENV = ['REMOTLY_RELEASE_URL', 'REMOTLY_NODE_DIST', 'REMOTLY_BIN_DIR', 'REMOTLY_NODE'] as const;

export interface ManagerDeps {
  exec: ExecFn;
  /** Resolved by the caller: `~/.config/systemd/user` (systemd) or `~/Library/LaunchAgents` (launchd). */
  unitDir: string;
  user: string;
  uid: number;
  home: string;
  /** launchd: the minute past midnight the daily update runs at (default: drawn once per setup). */
  updateMinute?: number;
  /** Sleep between launchctl polls; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

const run = async (exec: ExecFn, cmd: string, args: string[]): Promise<string> => {
  const r = await exec(cmd, args, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code ?? 'no exit code'}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
};

// ---- systemd ----------------------------------------------------------------------------------

/** `name` or `name.service` → `name.service`: the form every systemctl/journalctl call uses, so `remotly.dev` or an existing `x.timer` cannot be taken for another unit. */
export function systemdUnitFile(name: string): string {
  return `${name.replace(/\.service$/, '')}.service`;
}

/** The two units of the daily update: `<unit>-update.service` (oneshot, runs `update`) and `<unit>-update.timer`. */
export function systemdUpdateNames(unit: string): { service: string; timer: string } {
  const base = `${unit.replace(/\.service$/, '')}-update`;
  return { service: `${base}.service`, timer: `${base}.timer` };
}

/** systemd quoting: double quotes keep spaces together and `%` is a specifier, so it is doubled; the rest is refused. */
function q(s: string): string {
  if (/["\\$\n]/.test(s)) throw new Error(`cannot put ${JSON.stringify(s)} in a unit file (quote, backslash, $ or newline)`);
  return `"${s.replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(o: UnitRender): string {
  // A user unit cannot order itself after the system `tailscaled.service` (the user manager does not see system units),
  // so `serve` itself waits for Tailscale at start-up (server/tailscale-wait.ts) instead of an `After=` that would be ignored.
  const lines = [
    '[Unit]',
    'Description=Remotly bridge (herdr → phone)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    ...(o.repairScript ? [`ExecStartPre=-/bin/sh ${q(o.repairScript)}`] : []),
    `ExecStart=${q(o.nodePath)} ${q(o.mainPath)} serve`,
    'Restart=always',
    'RestartSec=2',
    'Environment=NODE_ENV=production',
  ];
  if (o.configDir) lines.push(`Environment=${q(`REMOTLY_CONFIG_DIR=${o.configDir}`)}`);
  if (o.herdrSession) lines.push(`Environment=${q(`HERDR_SESSION=${o.herdrSession}`)}`);
  if (o.herdrSocket) lines.push(`Environment=${q(`HERDR_SOCKET_PATH=${o.herdrSocket}`)}`);
  if (o.tailscale) lines.push(`Environment=${q(`REMOTLY_TAILSCALE=${o.tailscale}`)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

/** `update` runs with the bridge's environment (unit, config dir, herdr) so the installer's `setup` re-renders the same unit, and with the installer's own settings (`installerEnv`). */
export function renderSystemdUpdateUnits(o: UpdateRender): { service: string; timer: string } {
  const service = [
    '[Unit]',
    `Description=Remotly bridge update (installs the newest release for ${o.unit})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    ...(o.repairScript ? [`ExecStartPre=-/bin/sh ${q(o.repairScript)}`] : []),
    `ExecStart=${q(o.nodePath)} ${q(o.mainPath)} update`,
    'Environment=NODE_ENV=production',
    `Environment=${q(`REMOTLY_SYSTEMD_UNIT=${o.unit}`)}`,
  ];
  if (o.configDir) service.push(`Environment=${q(`REMOTLY_CONFIG_DIR=${o.configDir}`)}`);
  if (o.herdrSession) service.push(`Environment=${q(`HERDR_SESSION=${o.herdrSession}`)}`);
  if (o.herdrSocket) service.push(`Environment=${q(`HERDR_SOCKET_PATH=${o.herdrSocket}`)}`);
  if (o.tailscale) service.push(`Environment=${q(`REMOTLY_TAILSCALE=${o.tailscale}`)}`);
  for (const k of INSTALLER_ENV) {
    const v = o.installerEnv?.[k];
    if (v) service.push(`Environment=${q(`${k}=${v}`)}`);
  }
  service.push('');
  // Daily, at a random moment within an hour of midnight (hosts do not all hit GitHub at once); a missed day (host
  // off) runs at the next boot.
  const timer = ['[Unit]', `Description=Remotly bridge update, daily (${o.unit})`, '', '[Timer]', 'OnCalendar=daily', 'RandomizedDelaySec=1h', 'Persistent=true', '', '[Install]', 'WantedBy=timers.target', ''];
  return { service: service.join('\n'), timer: timer.join('\n') };
}

/** What `systemctl is-enabled` can print (systemd.unit's UnitFileState), plus its `not-found`. */
/** What `systemctl is-active` can print (systemd.unit's ActiveState). */
const ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'failed', 'inactive', 'deactivating']);
const UNIT_FILE_STATES = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'indirect', 'disabled', 'generated', 'transient', 'bad', 'not-found']);

export function systemdManager(deps: ManagerDeps): ServiceManager {
  const { exec } = deps;
  const names = systemdUpdateNames;
  const hints: ServiceHints = {
    status: (u) => `systemctl --user status ${systemdUnitFile(u)}`,
    query: () => 'systemctl --user show',
    start: (u) => `systemctl --user start ${systemdUnitFile(u)}`,
    stop: (u) => `systemctl --user stop ${systemdUnitFile(u)}`,
    restart: (u) => `systemctl --user restart ${systemdUnitFile(u)}`,
    logs: (u, n) => `journalctl --user -u ${systemdUnitFile(u)} -n ${n}`,
    updateLogs: (u, n) => `journalctl --user -u ${names(u).service} -n ${n}`,
    cat: (u) => `systemctl --user cat ${systemdUnitFile(u)}`,
    unmask: (units) => `systemctl --user unmask ${units.join(' ')}`,
    enableTimer: (u) => `systemctl --user enable --now ${names(u).timer}`,
    disableTimer: (u) => `systemctl --user disable --now ${names(u).timer}`,
    startTimer: (u) => `systemctl --user start ${names(u).timer}`,
  };
  const linger = async (): Promise<boolean> => (await exec('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value'])).stdout.trim() === 'yes';
  return {
    kind: 'systemd',
    name: 'systemd',
    noun: 'systemd unit',
    unitDir: deps.unitDir,
    unitName: systemdUnitFile,
    unitPath: (u) => path.join(deps.unitDir, systemdUnitFile(u)),
    updateNames: names,
    updatePaths: (u) => ({ service: path.join(deps.unitDir, names(u).service), timer: path.join(deps.unitDir, names(u).timer) }),
    renderUnit: renderSystemdUnit,
    renderUpdateUnits: renderSystemdUpdateUnits,
    async sessionCheck() {
      const r = await exec('systemctl', ['--user', 'show-environment']);
      if (r.code === 0) return { ok: true, note: 'systemd user session' };
      if (r.code === null && /ENOENT/.test(r.stderr)) {
        return { ok: false, problem: 'systemctl not found — the service needs systemd', fix: ['run the bridge yourself instead:  remotly-bridge serve'] };
      }
      return {
        ok: false,
        problem: `no systemd user session for ${deps.user}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
        fix: ['log in to this machine as this user (console or ssh) so systemd starts a user manager', 'if XDG_RUNTIME_DIR is unset in this shell:  export XDG_RUNTIME_DIR=/run/user/$(id -u)'],
      };
    },
    async state(unit) {
      // `Key=value` lines, read by key: systemctl prints properties in its own order, not in the order asked for.
      const r = await exec('systemctl', ['--user', 'show', '-p', 'LoadState,ActiveState,SubState,MainPID', systemdUnitFile(unit)]);
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
    },
    async reload() {
      await run(exec, 'systemctl', ['--user', 'daemon-reload']);
    },
    async enable(unit) {
      await run(exec, 'systemctl', ['--user', 'enable', systemdUnitFile(unit)]);
    },
    // `restart` also starts a stopped unit, and a running one picks up the code this setup belongs to.
    restart: (unit) => exec('systemctl', ['--user', 'restart', systemdUnitFile(unit)], { timeoutMs: 30_000 }),
    async activeState(unit) {
      const u = systemdUnitFile(unit);
      const r = await exec('systemctl', ['--user', 'is-active', u]);
      const s = r.stdout.trim();
      const said = s || (r.stderr.trim() ? r.stderr.trim() : r.code === null ? 'systemctl did not run' : `exit ${r.code}, no output`);
      return { state: ACTIVE_STATES.has(s) ? s : null, asked: `systemctl --user is-active ${u}`, said };
    },
    async resetAndRestart(unit) {
      await exec('systemctl', ['--user', 'reset-failed', systemdUnitFile(unit)]);
      return exec('systemctl', ['--user', 'restart', systemdUnitFile(unit)]);
    },
    async mainPid(unit) {
      const r = await exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', systemdUnitFile(unit)]);
      const pid = Number(r.stdout.trim());
      return r.code === 0 && Number.isInteger(pid) && pid >= 0 ? pid : null;
    },
    async persistenceCheck() {
      if (await linger()) return { ok: true, message: 'linger on: the unit starts at boot and survives logout' };
      return { ok: false, message: 'linger off: the bridge stops when you log out', fix: `sudo loginctl enable-linger ${deps.user}` };
    },
    async persistence() {
      if (await linger()) return ['  ✔ starts at boot and survives logout (linger on)'];
      await exec('loginctl', ['enable-linger']);
      if (await linger()) return ['  ✔ starts at boot and survives logout (linger enabled)'];
      return [`  ⚠ the bridge stops when you log out; run once:  sudo loginctl enable-linger ${deps.user}`];
    },
    async timerState(unit) {
      // `is-enabled` of both units, wherever they live (a mask is a symlink under the same directory, a runtime mask
      // under /run): a mask on either is the user's word — a masked timer never fires, a masked service makes the timer
      // fail every day. Its stdout is the state (`enabled`, `enabled-runtime`, `disabled`, `masked`, `masked-runtime`, …);
      // `not-found` (exit 4; an older systemd prints nothing and complains on stderr) means the unit does not exist yet.
      // Anything else — no answer, an error — is reported as unreadable: a query that failed must not pass for "fresh".
      const n = names(unit);
      let unreadable = '';
      const stateOf = async (u: string): Promise<string> => {
        const r = await exec('systemctl', ['--user', 'is-enabled', u]);
        const s = r.stdout.trim();
        if (UNIT_FILE_STATES.has(s)) return s;
        // The older form names the unit file state it could not get: a bus that is not there says "No such file" too.
        if (s === '' && (r.code === 4 || /unit file state for \S+: no such file/i.test(r.stderr))) return 'not-found';
        unreadable ||= `systemctl --user is-enabled ${u}: ${r.code === null ? 'did not run' : `exit ${r.code}`}${(r.stderr || r.stdout).trim() ? `, ${(r.stderr || r.stdout).trim()}` : ', no output'}`;
        return '';
      };
      const timer = await stateOf(n.timer);
      const service = await stateOf(n.service);
      if (unreadable) return { state: '', unreadable };
      // A mask on either is the user's word: a masked timer never fires, a masked service makes the timer fail every day.
      const masked = [n.timer, n.service].filter((u, i) => [timer, service][i]?.startsWith('masked'));
      if (masked.length > 0) return { state: 'masked', masked };
      return { state: timer };
    },
    async enableTimer(unit) {
      await run(exec, 'systemctl', ['--user', 'enable', names(unit).timer]);
    },
    async disableTimerNow(unit) {
      await run(exec, 'systemctl', ['--user', 'disable', '--now', names(unit).timer]);
    },
    async restartTimer(unit) {
      await run(exec, 'systemctl', ['--user', 'restart', names(unit).timer]); // starts it, and a running one re-reads the schedule
    },
    timerActive: async (unit) => (await exec('systemctl', ['--user', 'is-active', names(unit).timer])).stdout.trim() === 'active',
    async logTail(unit, n) {
      const j = await exec('journalctl', ['--user', '-u', systemdUnitFile(unit), '-n', String(n), '--no-pager']);
      return (j.stdout || j.stderr).trim().split('\n');
    },
    hints,
  };
}

// ---- launchd ----------------------------------------------------------------------------------

/** The agent's label: reverse-DNS, one per unit name (`remotly-bridge` → `dev.remotly.remotly-bridge`). */
export function launchdLabel(unit: string): string {
  return `dev.remotly.${unit.replace(/\.service$/, '')}`;
}

export function launchdUpdateNames(unit: string): { service: string; timer: string } {
  const label = `${launchdLabel(unit)}-update`;
  return { service: label, timer: label };
}

/** `~/Library/LaunchAgents`: where launchd reads a user's agents at login. */
export const launchAgentsDir = (home: string): string => path.join(home, 'Library', 'LaunchAgents');
/** `~/Library/Logs/remotly/<label>.log`: an agent's stdout and stderr (launchd has no journal). */
export const launchdLogPath = (home: string, label: string): string => path.join(home, 'Library', 'Logs', 'remotly', `${label}.log`);

/** The PATH an agent runs with: launchd gives agents almost none, and the bridge spawns `tailscale`, `openssl`, `stty` and `herdr`. */
export function launchdPath(home: string): string {
  return ['/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Applications/Tailscale.app/Contents/MacOS'].join(':');
}

type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistNode(v: PlistValue, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${xml(v)}</string>`;
  if (typeof v === 'number') return `${indent}<integer>${v}</integer>`;
  if (typeof v === 'boolean') return `${indent}<${v}/>`;
  if (Array.isArray(v)) return [`${indent}<array>`, ...v.map((x) => plistNode(x, `${indent}  `)), `${indent}</array>`].join('\n');
  const entries = Object.entries(v).flatMap(([k, x]) => [`${indent}  <key>${xml(k)}</key>`, plistNode(x, `${indent}  `)]);
  return [`${indent}<dict>`, ...entries, `${indent}</dict>`].join('\n');
}

const hasNewline = (v: PlistValue): boolean =>
  typeof v === 'string' ? v.includes('\n') : Array.isArray(v) ? v.some(hasNewline) : typeof v === 'object' ? Object.entries(v).some(([k, x]) => k.includes('\n') || hasNewline(x)) : false;

/** A property list (XML 1.0) for launchd; written once by setup, read by `launchctl bootstrap`. A newline is refused: no path of ours carries one, and a plist would not either. */
export function renderPlist(dict: { [k: string]: PlistValue }): string {
  if (hasNewline(dict)) throw new Error('cannot put a newline in a launchd plist');
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', plistNode(dict, ''), '</plist>', ''].join('\n');
}

function agentEnvironment(o: UnitRender, home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: 'production', PATH: launchdPath(home) };
  if (o.configDir) env['REMOTLY_CONFIG_DIR'] = o.configDir;
  if (o.herdrSession) env['HERDR_SESSION'] = o.herdrSession;
  if (o.herdrSocket) env['HERDR_SOCKET_PATH'] = o.herdrSocket;
  if (o.tailscale) env['REMOTLY_TAILSCALE'] = o.tailscale;
  return { ...env, ...extra };
}

/** `node main <command>`, after `repair-app.sh` when there is one: launchd has no ExecStartPre, so a shell runs both. */
function programArguments(o: UnitRender, command: 'serve' | 'update'): string[] {
  return o.repairScript ? ['/bin/sh', '-c', `/bin/sh "$0"; exec "$1" "$2" ${command}`, o.repairScript, o.nodePath, o.mainPath] : [o.nodePath, o.mainPath, command];
}

export function renderLaunchAgent(o: UnitRender & { unit: string; home: string }): string {
  const label = launchdLabel(o.unit);
  return renderPlist({
    Label: label,
    ProgramArguments: programArguments(o, 'serve'),
    EnvironmentVariables: agentEnvironment(o, o.home),
    RunAtLoad: true,
    // Restart=always: launchd respawns the agent whenever it exits, waiting ThrottleInterval seconds between spawns.
    KeepAlive: true,
    ThrottleInterval: 5,
    WorkingDirectory: o.home,
    StandardOutPath: launchdLogPath(o.home, label),
    StandardErrorPath: launchdLogPath(o.home, label),
  });
}

/** The daily update as one agent: `node main update` at a fixed minute between 00:00 and 01:00 (chosen per install); a missed run (Mac asleep) is made up when it wakes. */
export function renderLaunchUpdateAgent(o: UpdateRender & { home: string; minute?: number }): string {
  const label = launchdUpdateNames(o.unit).service;
  const extra: Record<string, string> = { REMOTLY_SYSTEMD_UNIT: o.unit };
  for (const k of INSTALLER_ENV) {
    const v = o.installerEnv?.[k];
    if (v) extra[k] = v;
  }
  const minute = o.minute ?? Math.floor(Math.random() * 60);
  return renderPlist({
    Label: label,
    ProgramArguments: programArguments(o, 'update'),
    EnvironmentVariables: agentEnvironment(o, o.home, extra),
    RunAtLoad: false,
    StartCalendarInterval: { Hour: 0, Minute: minute },
    WorkingDirectory: o.home,
    StandardOutPath: launchdLogPath(o.home, label),
    StandardErrorPath: launchdLogPath(o.home, label),
  });
}

/** What `launchctl print` says of a service: its state word(s), its pid (0 without one), and the exit code of its last run (null when it never ran, or the line is missing). */
export interface LaunchctlPrint {
  state: string;
  pid: number;
  lastExit: number | null;
}

/**
 * `state = running`, `pid = N` and `last exit code = N` out of `launchctl print`. The state is the rest of its line
 * (`running`, `waiting`, `spawn scheduled`, …); the last exit code is a number once the service has run and exited
 * (`(never exited)` before that).
 */
export function parseLaunchctlPrint(out: string): LaunchctlPrint {
  const state = (/^\s*state = (.+?)\s*$/m.exec(out)?.[1] ?? '').trim();
  const pid = Number(/^\s*pid = (\d+)/m.exec(out)?.[1] ?? 0);
  const exit = /^\s*last exit code = (\d+)\s*$/m.exec(out)?.[1];
  return { state, pid: Number.isInteger(pid) && pid > 0 ? pid : 0, lastExit: exit === undefined ? null : Number(exit) };
}

/**
 * launchd's words as systemd's: `running` (a process) → active; `waiting` / `spawn scheduled` before the first run →
 * activating (the spawn is on its way); the same after a run that exited → failed: KeepAlive respawns it after
 * ThrottleInterval, forever — launchd has no start-rate limit that would settle a crash loop into a final state, so
 * this is the state setup and update may act on (restart, replace), as they do on a `failed` systemd unit. Anything
 * else → inactive.
 */
function activeOf(p: LaunchctlPrint): string {
  if (p.state === 'running') return 'active';
  if (p.state === 'waiting' || p.state.startsWith('spawn')) return p.lastExit === null ? 'activating' : 'failed';
  return 'inactive';
}

/** The state as `launchctl print` had it, with the last exit code when it is not running and there is one (`spawn scheduled, last exit code 3`). */
const saidOf = (p: LaunchctlPrint): string => (p.state ? `${p.state}${p.lastExit === null || p.state === 'running' ? '' : `, last exit code ${p.lastExit}`}` : 'no state');

/** `"label" => disabled` lines of `launchctl print-disabled`. */
export function parseDisabled(out: string): Set<string> {
  const disabled = new Set<string>();
  for (const m of out.matchAll(/"([^"]+)"\s*=>\s*disabled/g)) disabled.add(m[1] as string);
  return disabled;
}

export function launchdManager(deps: ManagerDeps): ServiceManager {
  const { exec } = deps;
  const domain = `gui/${deps.uid}`;
  const target = (label: string): string => `${domain}/${label}`;
  const names = launchdUpdateNames;
  const plistPath = (label: string): string => path.join(deps.unitDir, `${label}.plist`);
  const hints: ServiceHints = {
    status: (u) => `launchctl print ${target(launchdLabel(u))}`,
    query: (u) => `launchctl print ${target(launchdLabel(u))}`,
    start: (u) => `launchctl bootstrap ${domain} ${plistPath(launchdLabel(u))}`,
    stop: (u) => `launchctl bootout ${target(launchdLabel(u))}`,
    restart: (u) => `launchctl kickstart -k ${target(launchdLabel(u))}`,
    logs: (u, n) => `tail -n ${n} ${launchdLogPath(deps.home, launchdLabel(u))}`,
    updateLogs: (u, n) => `tail -n ${n} ${launchdLogPath(deps.home, names(u).service)}`,
    cat: (u) => `cat ${plistPath(launchdLabel(u))}`,
    unmask: (units) => `launchctl enable ${units.map((l) => target(l)).join(' ')}`,
    enableTimer: (u) => `launchctl enable ${target(names(u).timer)} && launchctl bootstrap ${domain} ${plistPath(names(u).timer)}`,
    disableTimer: (u) => `launchctl bootout ${target(names(u).timer)}; launchctl disable ${target(names(u).timer)}`,
    startTimer: (u) => `launchctl bootstrap ${domain} ${plistPath(names(u).timer)}`,
  };
  const print = (label: string) => exec('launchctl', ['print', target(label)]);
  /** launchd's one answer for a service that is not loaded: `Could not find service "<label>" in domain for user gui: <uid>`, exit 113. Any other failure (EIO in a teardown, a domain that is gone, a permission problem) is no verdict. */
  const notLoaded = (r: ExecResult): boolean => r.code === 113 || /Could not find service/i.test(r.stderr + r.stdout);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /**
   * `bootout` (nothing when it was not loaded) then `bootstrap`: the only way launchd re-reads a plist. launchd tears a
   * service down after `bootout` returns; a bootstrap in that window fails with EIO (5, "Input/output error"), so wait
   * for `print` to stop knowing the service (a few seconds at most), and retry a bootstrap that still hits it. The
   * agents log to files under ~/Library/Logs/remotly: that directory is made here (0700) rather than left to launchd
   * — one macOS was seen to create it (0744), none is relied on to.
   */
  const reboot = async (label: string): Promise<ExecResult> => {
    const logDir = path.dirname(launchdLogPath(deps.home, label));
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(logDir, 0o700); // the mode above applies only when the directory is made: one launchd made is 0744
    } catch {
      /* not ours to change: the bootstrap is what matters */
    }
    await exec('launchctl', ['bootout', target(label)], { timeoutMs: 30_000 });
    for (let i = 0; i < 40 && (await print(label)).code === 0; i++) await sleep(250);
    let r = await exec('launchctl', ['bootstrap', domain, plistPath(label)], { timeoutMs: 30_000 });
    for (let i = 0; i < 10 && r.code === 5; i++) {
      await sleep(500);
      r = await exec('launchctl', ['bootstrap', domain, plistPath(label)], { timeoutMs: 30_000 });
    }
    return r;
  };
  const disabledSet = async (): Promise<Set<string> | null> => {
    const r = await exec('launchctl', ['print-disabled', domain]);
    return r.code === 0 ? parseDisabled(r.stdout) : null;
  };
  return {
    kind: 'launchd',
    name: 'launchd',
    noun: 'launchd agent',
    unitDir: deps.unitDir,
    unitName: launchdLabel,
    unitPath: (u) => plistPath(launchdLabel(u)),
    updateNames: names,
    updatePaths: (u) => ({ service: plistPath(names(u).service), timer: plistPath(names(u).timer) }),
    renderUnit: (o) => renderLaunchAgent({ ...o, home: deps.home }),
    renderUpdateUnits: (o) => {
      const text = renderLaunchUpdateAgent({ ...o, home: deps.home, ...(deps.updateMinute === undefined ? {} : { minute: deps.updateMinute }) });
      return { service: text, timer: text };
    },
    async sessionCheck() {
      const r = await exec('launchctl', ['print', domain]);
      if (r.code === 0) return { ok: true, note: `launchd (${domain})` };
      if (r.code === null && /ENOENT/.test(r.stderr)) return { ok: false, problem: 'launchctl not found — this is not macOS', fix: ['run the bridge yourself instead:  remotly-bridge serve'] };
      return {
        ok: false,
        problem: `no launchd session for ${deps.user} (${domain}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
        fix: ['log in to this Mac as this user (the desktop session; a user agent runs in it), then run setup again'],
      };
    },
    async state(unit) {
      const label = launchdLabel(unit);
      const r = await print(label);
      if (r.code === 0) {
        const p = parseLaunchctlPrint(r.stdout);
        const active = activeOf(p);
        return { load: 'loaded', active, sub: saidOf(p), pid: active === 'active' ? p.pid : 0 };
      }
      if (!notLoaded(r)) return null; // launchctl missing, not answering, or failing for another reason: no verdict
      // Not loaded: the plist may still be there (bootout, or never bootstrapped): known to us, inactive.
      return fs.existsSync(plistPath(label)) ? { load: 'loaded', active: 'inactive', sub: 'not loaded', pid: 0 } : { load: 'not-found', active: 'inactive', sub: 'dead', pid: 0 };
    },
    async reload() {
      /* a plist is read at bootstrap */
    },
    async enable(unit) {
      await run(exec, 'launchctl', ['enable', target(launchdLabel(unit))]);
    },
    restart: (unit) => reboot(launchdLabel(unit)),
    async activeState(unit) {
      const label = launchdLabel(unit);
      const asked = `launchctl print ${target(label)}`;
      const r = await print(label);
      if (r.code === 0) {
        const p = parseLaunchctlPrint(r.stdout);
        return { state: activeOf(p), asked, said: saidOf(p) };
      }
      if (notLoaded(r)) return { state: 'inactive', asked, said: 'not loaded' }; // bootout, or never bootstrapped: an operator's stop
      return { state: null, asked, said: (r.stderr || r.stdout).trim() || (r.code === null ? 'launchctl did not run' : `exit ${r.code}, no output`) };
    },
    resetAndRestart: (unit) => reboot(launchdLabel(unit)),
    async mainPid(unit) {
      const r = await print(launchdLabel(unit));
      if (r.code === 0) return parseLaunchctlPrint(r.stdout).pid;
      return notLoaded(r) ? 0 : null; // not loaded: no process; anything else: no verdict
    },
    async persistenceCheck(unit) {
      const disabled = await disabledSet();
      const label = launchdLabel(unit);
      if (disabled?.has(label)) return { ok: false, message: `agent ${label} is disabled: launchd does not start it at login`, fix: `launchctl enable ${target(label)}` };
      return { ok: true, message: 'launchd user agent: starts when you log in to this Mac (after a reboot, log in once, or turn on automatic login)' };
    },
    async persistence() {
      return ['  ✔ starts when you log in to this Mac (launchd user agent); after a reboot, log in once — or turn on automatic login'];
    },
    async timerState(unit) {
      const label = names(unit).timer;
      if (!fs.existsSync(plistPath(label))) return { state: 'not-found' };
      const disabled = await disabledSet();
      if (disabled === null) return { state: '', unreadable: `launchctl print-disabled ${domain} did not answer` };
      return { state: disabled.has(label) ? 'disabled' : 'enabled' };
    },
    async enableTimer(unit) {
      await run(exec, 'launchctl', ['enable', target(names(unit).timer)]);
    },
    async disableTimerNow(unit) {
      const label = names(unit).timer;
      await exec('launchctl', ['bootout', target(label)], { timeoutMs: 30_000 });
      await run(exec, 'launchctl', ['disable', target(label)]);
    },
    async restartTimer(unit) {
      const r = await reboot(names(unit).timer);
      if (r.code !== 0) throw new Error(`launchctl bootstrap ${names(unit).timer} failed (${r.code ?? 'no exit code'}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    },
    timerActive: async (unit) => (await print(names(unit).timer)).code === 0,
    async logTail(unit, n) {
      try {
        const lines = fs.readFileSync(launchdLogPath(deps.home, launchdLabel(unit)), 'utf8').trimEnd().split('\n');
        return lines.slice(-n);
      } catch (err) {
        return [`(no log yet: ${(err as Error).message})`];
      }
    },
    hints,
  };
}

/** The manager for this host: launchd on macOS, systemd elsewhere. */
export function serviceManagerFor(platform: string, deps: ManagerDeps): ServiceManager {
  return platform === 'darwin' ? launchdManager(deps) : systemdManager(deps);
}

/** Where unit files go on this host (`unitDir` of ManagerDeps). */
export function serviceUnitDir(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return launchAgentsDir(home);
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'systemd', 'user');
}
