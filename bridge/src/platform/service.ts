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
  /** The arguments the manager started the process with, when it tells them (launchd's `print`); systemd's are read from /proc by the caller. */
  args?: string[];
  /** The executable the manager runs, when it tells it (launchd's `program =`): another than `args[0]` when the plist had a `Program` key. */
  program?: string;
}

export interface UnitSource {
  /** The unit file the manager loaded; null when it does not say. */
  path: string | null;
  /** Drop-in files merged into it (systemd), in the manager's order. */
  dropIns: string[];
}

/** What a unit is, in the user's eyes: `enabled`, `enabled-runtime` (systemd: until the next boot), `disabled`, `masked` (systemd), `not-found`, or another arrangement (`linked`, `static`, …). The daily update timer's and the herdr service's word. */
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
  /** Enable the unit and start it now (the herdr service a user turned off). */
  /** Enable without starting: a unit that is to take over at the next boot while what it runs is running by hand. */
  enable(unit: string): string;
  enableNow(unit: string): string;
  /** Disable and stop: what turns a unit off for good. */
  disableNow(unit: string): string;
  /** A restart that also clears a start-rate limit (systemd's `failed` after a crash loop refuses a plain start). */
  resetAndRestart(unit: string): string;
  /**
   * A restart that runs the unit file as it is now: systemd read it at setup's daemon-reload, so its plain restart;
   * launchd reads a plist at bootstrap only (a `kickstart -k` respawns the definition it loaded), so bootout, then
   * bootstrap — with a pause for the old instance to be gone, which a bootstrap right behind the bootout may still hit.
   */
  reloadRestart(unit: string): string;
  /** Disable without stopping: a unit that is not to start at the next boot, what it runs now left running. */
  disable(unit: string): string;
  /**
   * Whether a disabled unit cannot be restarted as it is: launchd does not bootstrap a disabled service (`Service is
   * disabled`), so the only restart that runs its file turns it on (`stop`, then `enableNow`); systemd restarts a
   * disabled unit as any other — disabled is about the next boot only.
   */
  readonly restartNeedsEnabled: boolean;
  /** The restart of a disabled unit that runs its file as it is now: systemd's plain restart (disabled stays); on launchd `bootout`, a pause, then `enable && bootstrap` — the one way, so it turns the agent on (restartNeedsEnabled says so for the wording). */
  restartDisabled(unit: string): string;
  /**
   * Turn on and restart in one: for a disabled unit that is running (another session, say) — `enableNow` would leave
   * it as it runs (a start is nothing to an active systemd unit; launchd's bootstrap fails on a loaded one). systemd:
   * `enable`, then `restart`; launchd: `bootout`, a pause, `enable && bootstrap` (restartDisabled's one way).
   */
  enableRestart(unit: string): string;
  /**
   * For units of the user's own — one, or one and the timer that triggers it — by their manager-native names (quoted
   * for the shell where needed), in one line: stop them; keep them from the next boot; both.
   */
  nativeStop(natives: string[]): string;
  nativeDisable(natives: string[]): string;
  nativeDisableNow(natives: string[]): string;
  enableTimer(unit: string): string;
  disableTimer(unit: string): string;
  startTimer(unit: string): string;
}

/**
 * `startsAtBoot`'s answer: the unit-file state as the manager words it ('' when not told); whether the unit starts at
 * boot; the units of the user's own that start it again after a stop (`activators`); and those that pull it in
 * without being undone by a `disable` of it (`pullers`: each with how — `wants it`, `requires it`, `is bound to it`,
 * `starts it when it fails`, `starts it when it succeeds`).
 */
export interface BootStart {
  state: string;
  atBoot: boolean | null;
  activators: string[];
  pullers: { unit: string; how: string }[];
  /** The units the manager stops along with it when it is stopped (systemd: `RequiredBy`, `BoundBy`, `RequisiteOf`, `ConsistsOf`, `PropagatesStopTo`), one level down; named where a line says what it ends. */
  stoppedWith: string[];
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
  /**
   * Whether a unit of the user's own, by its manager-native name (`herdr.service`, `com.example.herdr`), starts at
   * boot (login on a Mac) — `atBoot`: true when enabled; false when it does not on its own and nothing of the user's
   * starts it (systemd: `disabled`, `enabled-runtime` — gone with this boot — or `transient`, with no `WantedBy`,
   * `RequiredBy`, `UpheldBy`, `BoundBy`, `TriggeredBy`, `OnFailureOf` or `OnSuccessOf` from another unit; launchd:
   * the label disabled); null when it is its own arrangement — `static`, `indirect`, pulled in or triggered by
   * another unit (a timer, a socket), started when another fails, an agent whose plist (RunAtLoad, KeepAlive)
   * decides — or not told. `activators`: the units of the user's own that start it again on their own after a stop
   * (systemd: `TriggeredBy` — a timer, a socket, a path — and `UpheldBy`), enabled or not; named with it in every
   * line that stops or disables it (stopping the unit alone, a timer would start it again). `pullers`: the units
   * that pull it in at their own start — `WantedBy`/`RequiredBy` other than the unit's own enablement links
   * (`<target>.wants/<unit>` under the user's config directories, which `disable` removes), `BoundBy`, `OnFailureOf`,
   * `OnSuccessOf` — which no `disable` of the unit undoes: named, never claimed undone (a link under `/etc/systemd/user`,
   * a global enablement, is one of those: a user-level `disable` leaves it). `stoppedWith`: what the manager stops with
   * it. A masked unit starts nowhere: false, nothing. Every list empty on launchd.
   */
  startsAtBoot(native: string): Promise<BootStart>;
  /**
   * Of setup's own unit, by its native name: the units the manager stops along with it when it is stopped or restarted
   * (`stopped`: systemd's `RequiredBy`, `BoundBy`, `RequisiteOf`, `ConsistsOf`, `PropagatesStopTo`) and the ones it stops
   * when this one starts (`conflicting`: `Conflicts`, `ConflictedBy`), one level down — named where a line that starts,
   * restarts or stops ours says what it ends. launchd: none of either.
   */
  dependents(native: string): Promise<{ stopped: string[]; conflicting: string[] }>;
  /**
   * Of a unit of the user's own, by its native name: whether the manager brings its process back when it exits
   * (systemd's `Restart=` other than `no`), its main pid, and whether it is transient (`systemd-run`, a desktop app's).
   * launchd is not asked (KeepAlive is the plist's): every field null.
   */
  unitFacts(native: string): Promise<{ restarts: boolean | null; mainPid: number | null; transient: boolean | null }>;
  /** systemd: a unit file under the name in another load path, which a mask in `unitDir` hides (a unit setup did not write); null when none, or not a question (launchd). */
  maskHides(unit: string): Promise<string | null>;
  unitPath(unit: string): string;
  /** The daily update's unit names (`<unit>-update.service` + `.timer`; on launchd one agent, named twice). */
  updateNames(unit: string): { service: string; timer: string };
  updatePaths(unit: string): { service: string; timer: string };
  renderUnit(o: UnitRender & { unit: string }): string;
  /** The update unit(s); on launchd `service` and `timer` are the same text. */
  renderUpdateUnits(o: UpdateRender): { service: string; timer: string };
  /** The herdr service (`herdrUnit(unit)`): `herdr server` for the session the bridge follows, kept running like the bridge. */
  renderHerdrUnit(o: HerdrRender & { unit: string }): string;
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
  /** `enable` undone: the unit no longer starts at boot/login; one that runs keeps running (no `--now`). */
  disable(unit: string): Promise<void>;
  /** Starts a stopped unit and leaves a running one alone (the herdr service: a restart would end every pane's processes). */
  start(unit: string): Promise<ExecResult>;
  /** Starts a stopped unit, restarts a running one on the unit file as it is now; a failed one is reset first where that matters. */
  restart(unit: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** `enabled`, `enabled-runtime`, `disabled`, `masked`, `not-found`, another arrangement, or unreadable — of one unit (the herdr service). */
  enabledState(unit: string): Promise<TimerState>;
  /**
   * Where the manager has the unit from, as loaded: the file (systemd's FragmentPath; the `path` launchd bootstrapped
   * the label from) and, on systemd, every drop-in merged into it from any load path. null when the unit is not
   * loaded or the manager does not say.
   */
  source(unit: string): Promise<UnitSource | null>;
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

/** The herdr service: which binary, and which session (`herdr --session <name> server`; the default session when none). */
export interface HerdrRender {
  /** Absolute: the `herdr` setup found on PATH (the unit runs from no shell). */
  herdrPath: string;
  session?: string | undefined;
  /** Absolute: herdr's directory, the one the bridge's socket is under (herdrConfigHome), pinned in the unit's command. */
  configHome: string;
}

/** The herdr service's unit name (without `.service`): `<unit>-herdr`, beside `<unit>` and `<unit>-update` — so each bridge instance brings the herdr session it follows. */
export function herdrUnit(unit: string): string {
  return `${unit.replace(/\.service$/, '')}-herdr`;
}

/** `herdr [--session <name>] server`: the arguments after the binary. */
/**
 * What runs ahead of herdr in every herdr unit: `env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=<home>/.config`
 * (herdrCommand). herdr reads the first two before it falls back to the default session, and takes its directory from
 * XDG_CONFIG_HOME, else from HOME (`$XDG_CONFIG_HOME/herdr/…`, else `$HOME/.config/herdr/…`); the user manager's
 * environment can carry any of them (a shell's `systemctl --user import-environment`, `launchctl setenv`, a drop-in's
 * Environment=) — a `herdr server` would then quietly serve another socket. The two are dropped and the directory is
 * pinned to the one the bridge looks under (absolute: herdr takes a relative or empty value literally), so the
 * arguments alone say which socket the unit serves. The one shape setup writes and reads back (setup.ts,
 * herdrUnitArgs / herdrArgv).
 */
export const HERDR_ENV_PREFIX = ['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH'];
export const HERDR_CONFIG_HOME_VAR = 'XDG_CONFIG_HOME';
/** macOS's property-list tool, by its path: a unit's PATH may not have /usr/bin. */
export const PLUTIL = '/usr/bin/plutil';

const errnoCode = (e: unknown): string => (e as { code?: string } | null)?.code ?? 'unknown error';
/** Nothing at the path (or a component of it is no directory): the file system's "not there", as against "not yours to read". */
const fileMissing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(errnoCode(e));

/** herdr's directory for a home — `<home>/.config`, which holds `herdr/` — the one the bridge's socket paths are under. */
export function herdrConfigHome(home: string): string {
  return path.join(home, '.config');
}

export function herdrCommand(herdrPath: string, session: string | undefined, configHome: string): string[] {
  return [...HERDR_ENV_PREFIX, `${HERDR_CONFIG_HOME_VAR}=${configHome}`, herdrPath, ...herdrServerArgs(session)];
}

export function herdrServerArgs(session: string | undefined): string[] {
  return session ? ['--session', session, 'server'] : ['server'];
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
  /** The environment the user manager's load paths follow (`XDG_DATA_HOME`, `XDG_RUNTIME_DIR`); default the process's. */
  env?: NodeJS.ProcessEnv;
  /** systemd: where `systemctl --global enable` links live (`/etc/systemd/user`), which a user-level `disable` leaves; tests point it elsewhere. */
  globalUnitDir?: string;
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

/**
 * `herdr server` as a unit, so a host reboot brings herdr back before anyone opens a terminal: the headless server
 * restores the saved workspaces, tabs and panes (and, with its `resume_agents_on_restore`, the agents in them) and the
 * TUI `herdr` attaches to it as it would to one it started itself. `Restart=always` like the bridge: a crash comes
 * back, and so does a `herdr server stop` — a stop that is meant to last is the unit's (`systemctl --user stop`).
 * No `After=` on the bridge: it reconnects to herdr every 2 s on its own.
 */
/**
 * The line every herdr unit setup writes carries, and the one setup reads back before it rewrites or reuses a unit
 * under its name (setup.ts, `herdrUnitArgs`): a unit file without it is somebody else's, however it is named. And a
 * file of setup's is exactly what the renderers below produce for the arguments read from it (setup.ts,
 * `herdrUnitFile`) — a directive or key added since is a change setup does not read, and the file is left alone. So a
 * change to either template orphans the files earlier releases wrote, unless the earlier rendering stays accepted
 * alongside: make that part of the change.
 */
export const HERDR_UNIT_MARKER = 'written by remotly-bridge setup';
const HERDR_UNIT_HEADER = `${HERDR_UNIT_MARKER}: rewritten by every setup, so edits do not last`;

export function renderSystemdHerdrUnit(o: HerdrRender & { unit: string }): string {
  return [
    `# ${HERDR_UNIT_HEADER} (opt out: remotly-bridge setup --no-herdr-service)`,
    '[Unit]',
    `Description=herdr server for Remotly (${o.unit})`,
    '',
    '[Service]',
    `ExecStart=${q(HERDR_ENV_PREFIX[0] as string)} ${HERDR_ENV_PREFIX.slice(1).join(' ')} ${q(`${HERDR_CONFIG_HOME_VAR}=${o.configHome}`)} ${q(o.herdrPath)}${o.session ? ` --session ${q(o.session)}` : ''} server`, // herdrCommand, quoted as a unit file wants it
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** What `systemctl is-enabled` can print (systemd.unit's UnitFileState), plus its `not-found`. */
/** What `systemctl is-active` can print (systemd.unit's ActiveState). */
const ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'failed', 'inactive', 'deactivating']);
const UNIT_FILE_STATES = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'indirect', 'disabled', 'generated', 'transient', 'bad', 'not-found']);

/** What systemd stops with a unit, from the `show` properties: what requires it (`Requires=`, `Requisite=`) or is bound to it, its parts, what it propagates a stop to. */
const stoppedWithOf = (of: (k: string) => string[]): string[] => [...new Set([...of('RequiredBy'), ...of('BoundBy'), ...of('RequisiteOf'), ...of('ConsistsOf'), ...of('PropagatesStopTo')])];
/** `Key=a b` lines of `systemctl show` as a lookup. */
const shown = (stdout: string): ((k: string) => string[]) => {
  const by = new Map<string, string[]>();
  for (const l of stdout.split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) by.set(l.slice(0, i), l.slice(i + 1).trim().split(/\s+/).filter(Boolean));
  }
  return (k) => by.get(k) ?? [];
};

export function systemdManager(deps: ManagerDeps): ServiceManager {
  const { exec } = deps;
  // The user manager's load paths, as it lists them (`UnitPath`; a path with a space comes quoted — systemctlWords — and
  // a quote that does not close is no answer) or the documented set when it does not answer.
  const loadPaths = async (): Promise<string[]> => {
    const env = deps.env ?? process.env;
    const r = await exec('systemctl', ['--user', 'show', '-p', 'UnitPath']);
    const fromManager = r.code === 0 ? (systemctlWords(/^UnitPath=(.*)$/m.exec(r.stdout)?.[1] ?? '') ?? []).filter((d) => path.isAbsolute(d)) : [];
    if (fromManager.length > 0) return fromManager;
    const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(deps.home, '.local', 'share');
    const configDirs = (env.XDG_CONFIG_DIRS ?? '/etc/xdg').split(':').filter((d) => path.isAbsolute(d));
    return [
      ...(env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) ? [path.join(env.XDG_RUNTIME_DIR, 'systemd', 'user')] : []),
      path.join(deps.home, '.config', 'systemd', 'user'),
      ...configDirs.map((d) => path.join(d, 'systemd', 'user')),
      '/etc/systemd/user',
      '/run/systemd/user',
      path.join(dataHome, 'systemd', 'user'),
      '/usr/local/share/systemd/user',
      '/usr/share/systemd/user',
      '/usr/local/lib/systemd/user',
      '/usr/lib/systemd/user',
    ];
  };
  // Where an enablement link a user-level `disable` leaves may live: every persistent load path but `unitDir` (the
  // global `/etc/systemd/user`, a vendor's `/usr/lib/systemd/user`, …); `globalUnitDir` first when a caller names one.
  const persistentLinkDirs = async (): Promise<string[]> => {
    const env = deps.env ?? process.env;
    const runtime = env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) ? path.resolve(env.XDG_RUNTIME_DIR) : null;
    const dirs = (await loadPaths()).filter((d) => path.resolve(d) !== path.resolve(deps.unitDir) && !path.resolve(d).startsWith('/run/') && (runtime === null || !path.resolve(d).startsWith(`${runtime}/`)));
    return [...new Set([...(deps.globalUnitDir ? [deps.globalUnitDir] : []), ...dirs])];
  };
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
    enable: (u) => `systemctl --user enable ${systemdUnitFile(u)}`,
    enableNow: (u) => `systemctl --user enable --now ${systemdUnitFile(u)}`,
    disableNow: (u) => `systemctl --user disable --now ${systemdUnitFile(u)}`,
    disable: (u) => `systemctl --user disable ${systemdUnitFile(u)}`,
    resetAndRestart: (u) => `systemctl --user reset-failed ${systemdUnitFile(u)}; systemctl --user restart ${systemdUnitFile(u)}`,
    reloadRestart: (u) => `systemctl --user restart ${systemdUnitFile(u)}`,
    restartNeedsEnabled: false,
    restartDisabled: (u) => `systemctl --user restart ${systemdUnitFile(u)}`,
    enableRestart: (u) => `systemctl --user enable ${systemdUnitFile(u)}; systemctl --user restart ${systemdUnitFile(u)}`,
    nativeStop: (ns) => `systemctl --user stop ${ns.map(shq).join(' ')}`,
    nativeDisable: (ns) => `systemctl --user disable ${ns.map(shq).join(' ')}`,
    nativeDisableNow: (ns) => `systemctl --user disable --now ${ns.map(shq).join(' ')}`,
    enableTimer: (u) => `systemctl --user enable --now ${names(u).timer}`,
    disableTimer: (u) => `systemctl --user disable --now ${names(u).timer}`,
    startTimer: (u) => `systemctl --user start ${names(u).timer}`,
  };
  const linger = async (): Promise<boolean> => (await exec('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value'])).stdout.trim() === 'yes';
  // `is-enabled` of a unit, wherever it lives (a mask is a symlink under the same directory, a runtime mask under /run).
  // Its stdout is the state (`enabled`, `enabled-runtime`, `disabled`, `masked`, `masked-runtime`, …); `not-found` (exit
  // 4; an older systemd prints nothing and complains on stderr) means the unit does not exist yet. Anything else — no
  // answer, an error — is unreadable: a query that failed must not pass for "fresh".
  const isEnabled = async (u: string): Promise<{ state: string; unreadable?: string }> => {
    const r = await exec('systemctl', ['--user', 'is-enabled', u]);
    const s = r.stdout.trim();
    if (UNIT_FILE_STATES.has(s)) return { state: s };
    // The older form names the unit file state it could not get: a bus that is not there says "No such file" too.
    if (s === '' && (r.code === 4 || /unit file state for \S+: no such file/i.test(r.stderr))) return { state: 'not-found' };
    return { state: '', unreadable: `systemctl --user is-enabled ${u}: ${r.code === null ? 'did not run' : `exit ${r.code}`}${(r.stderr || r.stdout).trim() ? `, ${(r.stderr || r.stdout).trim()}` : ', no output'}` };
  };
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
    renderHerdrUnit: renderSystemdHerdrUnit,
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
    async disable(unit) {
      await run(exec, 'systemctl', ['--user', 'disable', systemdUnitFile(unit)]);
    },
    start: (unit) => exec('systemctl', ['--user', 'start', systemdUnitFile(unit)], { timeoutMs: 30_000 }),
    // `restart` also starts a stopped unit, and a running one picks up the code this setup belongs to.
    restart: (unit) => exec('systemctl', ['--user', 'restart', systemdUnitFile(unit)], { timeoutMs: 30_000 }),
    async source(unit) {
      const r = await exec('systemctl', ['--user', 'show', '-p', 'FragmentPath,DropInPaths', systemdUnitFile(unit)]);
      if (r.code !== 0) return null;
      const props = new Map<string, string>();
      for (const line of r.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
      if (!props.has('FragmentPath') && !props.has('DropInPaths')) return null;
      const fragment = props.get('FragmentPath') ?? '';
      // Paths as systemctl quotes them (one with a space comes as "…"); a list that does not parse is one path nobody can read: the caller fails closed on it.
      const raw = props.get('DropInPaths') ?? '';
      return { path: fragment || null, dropIns: systemctlWords(raw) ?? [raw] };
    },
    async enabledState(unit) {
      const u = systemdUnitFile(unit);
      const r = await isEnabled(u);
      if (r.unreadable) return { state: '', unreadable: r.unreadable };
      return r.state.startsWith('masked') ? { state: 'masked', masked: [u] } : { state: r.state };
    },
    async startsAtBoot(native) {
      const r = await exec('systemctl', ['--user', 'is-enabled', native]);
      const s = r.stdout.trim();
      const none = { activators: [], pullers: [], stoppedWith: [] };
      if (!UNIT_FILE_STATES.has(s)) return { state: '', atBoot: null, ...none }; // no bus, an error: not told
      // Whatever its own [Install] says, another unit of the user's may start it — a target's Wants=/Requires= (a
      // drop-in), a timer or a socket that triggers it, one that upholds it, one it is the OnFailure=/OnSuccess= of:
      // the manager lists those. Whether that one starts at boot is its own arrangement. The ones that start it again
      // on their own after a stop — triggers, upholders — go in every line that stops or disables it; the ones a
      // `disable` of the unit does not undo are named as its pullers. An enabled unit's own links (`<target>.wants/<unit>`
      // under `unitDir`) are what a user-level `disable` removes: that target is no puller; the same link under
      // /etc/systemd/user (`systemctl --global enable`) stays, so it is one. What the manager stops with the unit
      // (a unit that requires it or is bound to it, a part of it, what it propagates its stop to) is listed too.
      const pulled = await exec('systemctl', ['--user', 'show', '-p', 'WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo', native]);
      if (pulled.code !== 0) return { state: s, atBoot: s === 'enabled' ? true : null, ...none };
      const of = shown(pulled.stdout);
      // Masked (perhaps after it started — it may still run): starts nowhere, whatever wants or triggers it; what the manager stops with it still counts.
      if (s === 'masked' || s === 'masked-runtime') return { state: s, atBoot: false, activators: [], pullers: [], stoppedWith: stoppedWithOf(of) };
      const activators = [...of('TriggeredBy'), ...of('UpheldBy')];
      const linkIn = (dir: string, target: string, kind: string): boolean => { try { fs.lstatSync(path.join(dir, `${target}.${kind}`, native)); return true; } catch { return false; } };
      // A link in a persistent load path other than the user's own counts first: beside a local one, the local is what the disable removes and the other stays.
      const elsewhere = await persistentLinkDirs();
      const puller = (kind: 'wants' | 'requires') => (target: string): { unit: string; how: string } | null => {
        const kept = elsewhere.find((d) => linkIn(d, target, kind));
        if (kept !== undefined) return { unit: target, how: `${kind} it by an enablement under ${kept}, which a user-level disable leaves` };
        return s === 'enabled' && linkIn(deps.unitDir, target, kind) ? null : { unit: target, how: `${kind} it` };
      };
      const pullers = [
        ...of('WantedBy').map(puller('wants')),
        ...of('RequiredBy').map(puller('requires')),
        ...of('BoundBy').map((unit) => ({ unit, how: 'is bound to it' })),
        ...of('OnFailureOf').map((unit) => ({ unit, how: 'starts it when it fails' })),
        ...of('OnSuccessOf').map((unit) => ({ unit, how: 'starts it when it succeeds' })),
      ].filter((p): p is { unit: string; how: string } => p !== null);
      const stoppedWith = stoppedWithOf(of);
      if (s === 'enabled') return { state: s, atBoot: true, activators, pullers, stoppedWith };
      if (activators.length > 0 || pullers.length > 0) return { state: s, atBoot: null, activators, pullers, stoppedWith };
      // `enabled-runtime` lives under /run, so ends with this boot; a transient unit (`systemd-run`) is gone with it too.
      return { state: s, atBoot: s === 'disabled' || s === 'enabled-runtime' || s === 'transient' ? false : null, activators, pullers, stoppedWith }; // static, indirect, generated, linked, alias, …: not told
    },
    async dependents(native) {
      const r = await exec('systemctl', ['--user', 'show', '-p', 'RequiredBy,BoundBy,RequisiteOf,ConsistsOf,PropagatesStopTo,Conflicts,ConflictedBy', native]);
      if (r.code !== 0) return { stopped: [], conflicting: [] };
      const of = shown(r.stdout);
      return { stopped: stoppedWithOf(of), conflicting: [...new Set([...of('Conflicts'), ...of('ConflictedBy')])] };
    },
    async unitFacts(native) {
      const r = await exec('systemctl', ['--user', 'show', '-p', 'Restart,MainPID,Transient', native]);
      if (r.code !== 0) return { restarts: null, mainPid: null, transient: null };
      const prop = (k: string): string | undefined => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1]?.trim();
      const restart = prop('Restart');
      const pid = prop('MainPID');
      const transient = prop('Transient');
      return {
        restarts: restart === undefined || restart === '' ? null : restart !== 'no',
        mainPid: pid === undefined || pid === '' || !/^\d+$/.test(pid) ? null : Number(pid),
        transient: transient === 'yes' ? true : transient === 'no' ? false : null,
      };
    },
    async maskHides(unit) {
      // The user manager's load paths besides `unitDir` (where the mask is). A file under the name in any of them is what the mask hides.
      for (const d of await loadPaths()) {
        if (path.resolve(d) === path.resolve(deps.unitDir)) continue;
        const p = path.join(d, systemdUnitFile(unit));
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() && fs.readlinkSync(p) === '/dev/null') continue; // a mask itself
          return p;
        } catch {
          /* not there */
        }
      }
      return null;
    },
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
      // Both units: a mask on either is the user's word — a masked timer never fires, a masked service makes the timer
      // fail every day.
      const n = names(unit);
      const timer = await isEnabled(n.timer);
      const service = await isEnabled(n.service);
      const unreadable = timer.unreadable ?? service.unreadable;
      if (unreadable) return { state: '', unreadable };
      const masked = [n.timer, n.service].filter((u, i) => [timer, service][i]?.state.startsWith('masked'));
      if (masked.length > 0) return { state: 'masked', masked };
      return { state: timer.state };
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
/** A path as a pasted line wants it: bare when a shell would take it whole, else in single quotes. */
const shq = (p: string): string => (/^[A-Za-z0-9_./~+:@=,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

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
const xmlUnescape = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (m, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1), 10)) : m,
  );
/** A value of a plist's root dictionary as far as this reads it: a string, a boolean, an array of strings, or anything else. */
export type XmlPlistValue = { kind: 'string'; value: string } | { kind: 'bool'; value: boolean } | { kind: 'strings'; items: string[] } | { kind: 'other' };

const ENTITY = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g;
/** Text with only the entities XML (and this) knows — an `&` otherwise is a document launchd rejects. */
const entitiesKnown = (run: string): boolean => !run.replace(ENTITY, '').includes('&');

/**
 * The root dictionary of an XML plist's text (`plist > dict`): its keys, with string values, `<true/>`/`<false/>`,
 * arrays of strings, and anything else as `other` — comments, CDATA and entities as XML has them, so a key is what it
 * decodes to. Null when the text is no such plist (binary, UTF-16, no root dictionary), is not one whole well-formed
 * document (a stray `<` or `&`, an element left open, anything after `</plist>`), or a key occurs twice (whichever
 * launchd would take, this does not vouch for it).
 */
export function xmlPlistRoot(text: string): Map<string, XmlPlistValue> | null {
  const src = text.replace(/<!--[\s\S]*?-->/g, '');
  const token = /<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w.-]*)\s*>|<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  const out = new Map<string, XmlPlistValue>();
  const stack: string[] = [];
  let root = -1; // the depth of the root dictionary once seen
  let closed = false; // … and whether it has closed: only `</plist>` and whitespace may follow
  let key: string | null = null; // the key read at the root, waiting for its value
  let reading: 'key' | 'string' | 'item' | null = null; // the text being collected
  let buf = '';
  let items: string[] | null = null; // an array at the root being collected …
  let plain = true; // … and whether it holds strings only
  let pos = 0; // every character must be some token's
  const set = (k: string, v: XmlPlistValue): boolean => {
    if (out.has(k)) return false;
    out.set(k, v);
    return true;
  };
  for (let m = token.exec(src); m !== null; m = token.exec(src)) {
    if (m.index !== pos) return null;
    pos = token.lastIndex;
    const [, cdata, close, open, empty, run] = m;
    if (cdata !== undefined || run !== undefined) {
      if (run !== undefined && !entitiesKnown(run)) return null;
      if (closed || root < 0) {
        if (cdata !== undefined || (run as string).trim() !== '') return null; // text before the document or after it: not a plist launchd reads
        continue;
      }
      if (reading !== null) buf += cdata ?? xmlUnescape(run as string);
      continue;
    }
    if (open !== undefined) {
      if (closed || !entitiesKnown(m[0])) return null; // an element after the end; an entity in an attribute XML does not know
      if (root < 0) {
        if (empty) continue;
        stack.push(open);
        if (open === 'dict' && stack.length === 2 && stack[0] === 'plist') root = 2;
        continue;
      }
      if (stack.length === root) {
        // A direct child of the root dictionary: a key, or the value of the key before it.
        if (open === 'key') {
          if (key !== null || empty) return null; // two keys in a row; an empty key
          reading = 'key';
          buf = '';
          stack.push(open);
          continue;
        }
        if (key === null) return null; // a value without its key
        if (empty) {
          const v: XmlPlistValue =
            open === 'string' ? { kind: 'string', value: '' } : open === 'true' || open === 'false' ? { kind: 'bool', value: open === 'true' } : open === 'array' ? { kind: 'strings', items: [] } : { kind: 'other' };
          if (!set(key, v)) return null;
          key = null;
          continue;
        }
        stack.push(open);
        if (open === 'string') {
          reading = 'string';
          buf = '';
        } else if (open === 'array') {
          items = [];
          plain = true;
        }
        continue;
      }
      if (stack.length === root + 1 && items !== null) {
        // An item of an array at the root: strings are read, anything else makes the array `other`.
        if (open === 'string') {
          if (empty) items.push('');
          else {
            reading = 'item';
            buf = '';
            stack.push(open);
          }
          continue;
        }
        plain = false;
      }
      if (!empty) stack.push(open);
      continue;
    }
    if (close !== undefined) {
      if (stack.pop() !== close) return null; // not well-formed: nothing this can vouch for
      if (root < 0) continue;
      if (stack.length < root) {
        closed = true; // the root dictionary closed (and later, the plist element)
        continue;
      }
      if (stack.length === root) {
        // A direct child closed: the key, or a value.
        if (reading === 'key') {
          key = buf;
          reading = null;
          continue;
        }
        if (key === null) return null;
        const v: XmlPlistValue = reading === 'string' ? { kind: 'string', value: buf } : items !== null ? (plain ? { kind: 'strings', items } : { kind: 'other' }) : { kind: 'other' };
        if (!set(key, v)) return null;
        key = null;
        reading = null;
        items = null;
        continue;
      }
      if (stack.length === root + 1 && reading === 'item' && items !== null) {
        items.push(buf);
        reading = null;
      }
    }
  }
  return closed && stack.length === 0 && pos === src.length ? out : null; // one whole document, closed
}

/** The `Label` an XML plist's root dictionary declares (xmlPlistRoot), or null — an empty one, a non-string, none. */
export function xmlPlistLabel(text: string): string | null {
  const v = xmlPlistRoot(text)?.get('Label');
  return v !== undefined && v.kind === 'string' && v.value !== '' ? v.value : null;
}

/**
 * The words of a list `systemctl show` prints (DropInPaths): bare, or `"quoted"` with backslash escapes when one has
 * a space; null when a quote does not close.
 */
export function systemctlWords(value: string): string[] | null {
  const words: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))/y;
  for (let i = 0; i < value.length; i = re.lastIndex) {
    re.lastIndex = i;
    const m = re.exec(value);
    if (!m) return /^\s*$/.test(value.slice(i)) ? words : null;
    words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] as string));
  }
  return words;
}

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

/** The herdr service as an agent: `herdr [--session <name>] server`, kept alive like the bridge (KeepAlive), with the agent PATH (a Mac's `herdr` may be Homebrew's). */
export function renderLaunchHerdrAgent(o: HerdrRender & { unit: string; home: string }): string {
  const label = launchdLabel(herdrUnit(o.unit));
  const plist = renderPlist({
    Label: label,
    ProgramArguments: herdrCommand(o.herdrPath, o.session, o.configHome),
    EnvironmentVariables: { PATH: launchdPath(o.home) },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 5,
    WorkingDirectory: o.home,
    StandardOutPath: launchdLogPath(o.home, label),
    StandardErrorPath: launchdLogPath(o.home, label),
  });
  // The marker as an XML comment after the root element: launchd reads the plist through CoreFoundation, which skips
  // comments; an unknown key, the other place for it, is not something every launchd is known to let pass.
  return plist.replace('<plist version="1.0">\n', `<plist version="1.0">\n<!-- ${HERDR_UNIT_HEADER} -->\n`);
}

/** What `launchctl print` says of a service: its state word(s), its pid (0 without one), and the exit code of its last run (null when it never ran, or the line is missing). */
export interface LaunchctlPrint {
  state: string;
  pid: number;
  lastExit: number | null;
  /** The `arguments = { … }` block, one argument per line as launchd spawned the process (the plist as it was bootstrapped, not as it is on disk). */
  args?: string[];
  /** `path = …`: the plist the label was bootstrapped from. */
  path?: string;
  /** `program = …`: the executable launchd runs — `ProgramArguments[0]`, or the plist's `Program`. */
  program?: string;
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
  const block = /^\s*arguments = \{\n([\s\S]*?)\n\s*\}/m.exec(out)?.[1];
  const args = block === undefined ? undefined : block.split('\n').map((l) => l.replace(/^[\t ]+/, ''));
  const plist = /^\s*path = (.+?)\s*$/m.exec(out)?.[1];
  const program = /^\s*program = (.+?)\s*$/m.exec(out)?.[1];
  return { state, pid: Number.isInteger(pid) && pid > 0 ? pid : 0, lastExit: exit === undefined ? null : Number(exit), ...(args ? { args } : {}), ...(plist ? { path: plist } : {}), ...(program ? { program } : {}) };
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
  // `"label" => disabled` (and `=> enabled`) as launchd prints it now; `=> true` (`false`) as older launchd did for the same: both read as what they say.
  for (const m of out.matchAll(/"([^"]+)"\s*=>\s*(?:disabled|true)\b/g)) disabled.add(m[1] as string);
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
    // Paths in the lines printed are meant to be pasted: quoted when a shell would split or expand them (a home with a space).
    start: (u) => `launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    stop: (u) => `launchctl bootout ${target(launchdLabel(u))}`,
    restart: (u) => `launchctl kickstart -k ${target(launchdLabel(u))}`,
    logs: (u, n) => `tail -n ${n} ${shq(launchdLogPath(deps.home, launchdLabel(u)))}`,
    updateLogs: (u, n) => `tail -n ${n} ${shq(launchdLogPath(deps.home, names(u).service))}`,
    cat: (u) => `cat ${shq(plistPath(launchdLabel(u)))}`,
    unmask: (units) => `launchctl enable ${units.map((l) => target(l)).join(' ')}`,
    enable: (u) => `launchctl enable ${target(launchdLabel(u))}`,
    enableNow: (u) => `launchctl enable ${target(launchdLabel(u))} && launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    disableNow: (u) => `launchctl bootout ${target(launchdLabel(u))}; launchctl disable ${target(launchdLabel(u))}`,
    disable: (u) => `launchctl disable ${target(launchdLabel(u))}`,
    // launchd has no start-rate limit to clear; bootout and bootstrap clear whatever state the agent is in, and load the plist as it is now (a `kickstart -k` respawns the definition launchd loaded — stale after every setup, which rewrites the plist and never restarts a running herdr unit). The pause: a bootstrap right behind the bootout may hit the old instance still going (EIO), as `reboot` below waits for.
    resetAndRestart: (u) => `launchctl bootout ${target(launchdLabel(u))}; sleep 2; launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    reloadRestart: (u) => `launchctl bootout ${target(launchdLabel(u))}; sleep 2; launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    restartNeedsEnabled: true,
    restartDisabled: (u) => `launchctl bootout ${target(launchdLabel(u))}; sleep 2; launchctl enable ${target(launchdLabel(u))} && launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    enableRestart: (u) => `launchctl bootout ${target(launchdLabel(u))}; sleep 2; launchctl enable ${target(launchdLabel(u))} && launchctl bootstrap ${domain} ${shq(plistPath(launchdLabel(u)))}`,
    nativeStop: (ns) => ns.map((n) => `launchctl bootout ${shq(target(n))}`).join('; '),
    nativeDisable: (ns) => ns.map((n) => `launchctl disable ${shq(target(n))}`).join('; '),
    nativeDisableNow: (ns) => [...ns.map((n) => `launchctl bootout ${shq(target(n))}`), ...ns.map((n) => `launchctl disable ${shq(target(n))}`)].join('; '),
    enableTimer: (u) => `launchctl enable ${target(names(u).timer)} && launchctl bootstrap ${domain} ${shq(plistPath(names(u).timer))}`,
    disableTimer: (u) => `launchctl bootout ${target(names(u).timer)}; launchctl disable ${target(names(u).timer)}`,
    startTimer: (u) => `launchctl bootstrap ${domain} ${shq(plistPath(names(u).timer))}`,
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
  const bootstrap = async (label: string): Promise<ExecResult> => {
    const logDir = path.dirname(launchdLogPath(deps.home, label));
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(logDir, 0o700); // the mode above applies only when the directory is made: one launchd made is 0744
    } catch {
      /* not ours to change: the bootstrap is what matters */
    }
    let r = await exec('launchctl', ['bootstrap', domain, plistPath(label)], { timeoutMs: 30_000 });
    for (let i = 0; i < 10 && r.code === 5; i++) {
      await sleep(500);
      r = await exec('launchctl', ['bootstrap', domain, plistPath(label)], { timeoutMs: 30_000 });
    }
    return r;
  };
  const reboot = async (label: string): Promise<ExecResult> => {
    await exec('launchctl', ['bootout', target(label)], { timeoutMs: 30_000 });
    for (let i = 0; i < 40 && (await print(label)).code === 0; i++) await sleep(250);
    return bootstrap(label);
  };
  const disabledSet = async (): Promise<Set<string> | null> => {
    const r = await exec('launchctl', ['print-disabled', domain]);
    return r.code === 0 ? parseDisabled(r.stdout) : null;
  };
  /**
   * Another plist declaring this label — under another file name in the agents directory, or in /Library/LaunchAgents,
   * XML or binary: launchd would load that one too, and which wins at login is not ours to say. The standing of such a label is that
   * file, and setup leaves the label alone (enabledState; the update timer's own plists are setup's whatever else
   * declares their labels, so timerState does not look).
   */
  const otherPlist = async (label: string): Promise<{ file: string | null } | { unreadable: string }> => {
    for (const dir of [deps.unitDir, '/Library/LaunchAgents']) {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.plist')).sort();
      } catch (e) {
        if (fileMissing(e)) continue; // no such directory: nothing in it
        return { unreadable: `${dir} cannot be listed (${errnoCode(e)}): whether another plist declares the label cannot be told` };
      }
      for (const n of names) {
        const f = path.join(dir, n);
        if (f === plistPath(label)) continue;
        let text: string;
        try {
          if (!fs.statSync(f).isFile()) continue; // a directory or a device by that name: nothing launchd loads
          text = fs.readFileSync(f, 'utf8');
        } catch (e) {
          if (fileMissing(e)) continue; // gone since the listing, or a symlink to nowhere
          // One this user cannot read — a root-owned 0600 plist in /Library/LaunchAgents is loaded at login all the same — leaves the question open.
          return { unreadable: `${f} cannot be read (${errnoCode(e)}): whether it declares the label cannot be told` };
        }
        // The plist tool's word first — it reads a plist as launchd does, XML or binary, whatever the layout (`raw`
        // output: macOS 12 and later); where it answers nothing (no Label, an older plutil), the text as XML
        // (xmlPlistLabel). A plutil that does not run at all leaves the question open: nothing is vouched for then.
        const r = await exec(PLUTIL, ['-extract', 'Label', 'raw', '-o', '-', f]);
        if (r.code === null) return { unreadable: `${PLUTIL} did not run (${r.stderr.trim() || 'no output'}): whether another plist declares the label cannot be told` };
        const said = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
        const declared = said !== '' ? said : xmlPlistLabel(text);
        if (declared === label) return { file: f };
      }
    }
    return { file: null };
  };
  /** An agent's standing: no plist → not-found; else enabled unless `launchctl disable` was said of it; unreadable when launchctl does not answer. */
  const labelState = async (label: string): Promise<TimerState> => {
    if (!fs.existsSync(plistPath(label))) return { state: 'not-found' };
    const disabled = await disabledSet();
    if (disabled === null) return { state: '', unreadable: `launchctl print-disabled ${domain} did not answer` };
    return { state: disabled.has(label) ? 'disabled' : 'enabled' };
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
    renderHerdrUnit: (o) => renderLaunchHerdrAgent({ ...o, home: deps.home }),
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
        return { load: 'loaded', active, sub: saidOf(p), pid: active === 'active' ? p.pid : 0, ...(p.args ? { args: p.args } : {}), ...(p.program ? { program: p.program } : {}) };
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
    async disable(unit) {
      await run(exec, 'launchctl', ['disable', target(launchdLabel(unit))]);
    },
    // Loaded: `kickstart` without `-k` starts a stopped agent and leaves a running one alone. Not loaded: bootstrap it
    // (which starts it, RunAtLoad). No verdict from launchctl: that answer is the result.
    async start(unit) {
      const label = launchdLabel(unit);
      const r = await print(label);
      if (r.code === 0) return exec('launchctl', ['kickstart', target(label)], { timeoutMs: 30_000 });
      if (!notLoaded(r)) return r;
      return bootstrap(label);
    },
    restart: (unit) => reboot(launchdLabel(unit)),
    // A unit's standing (the herdr unit, which setup owns only in some standings): another plist declaring the label is its standing, before anything launchd says.
    async enabledState(unit) {
      const label = launchdLabel(unit);
      const other = await otherPlist(label);
      if ('unreadable' in other) return { state: '', unreadable: other.unreadable };
      return other.file === null ? labelState(label) : { state: `defined by ${other.file}` };
    },
    async startsAtBoot(native) {
      const s = await labelState(native);
      return { state: s.state, atBoot: s.state === 'disabled' ? false : null, activators: [], pullers: [], stoppedWith: [] }; // not disabled: its plist (RunAtLoad, KeepAlive) decides, not told here; nothing of the user's triggers or pulls in an agent
    },
    async dependents() {
      return { stopped: [], conflicting: [] }; // launchd has no stop propagation between agents
    },
    async unitFacts() {
      return { restarts: null, mainPid: null, transient: null }; // KeepAlive is the plist's: taken as yes
    },
    async maskHides() {
      return null;
    },
    async source(unit) {
      const r = await print(launchdLabel(unit));
      if (r.code !== 0) return null;
      const p = parseLaunchctlPrint(r.stdout);
      return { path: p.path ?? null, dropIns: [] };
    },
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
    timerState: (unit) => labelState(names(unit).timer),
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
