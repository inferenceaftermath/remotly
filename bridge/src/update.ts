// `remotly-bridge update`: bring an installed release to the newest one — by hand, or from the daily timer `setup`
// installs (`<unit>-update.timer`). GitHub answers /releases/latest with a redirect to the newest release's tag; when
// that is the running version there is nothing to do (no download, no restart). Otherwise that release's own install.sh
// runs, pinned to it, with `--no-pair --no-wait --keep-mode --keep-stopped`: it swaps app/ (keeping the previous copy
// in app.prev), refreshes a private Node when there is one, and its `setup` re-renders the unit, restarts it and waits
// for health.
//
// Unattended, so the run is a small transaction: one lock per install — a kernel lock, flock(1) on <home>/update.lock,
// held by the descriptor flock opened for as long as any process has it: this run, and the installer it starts (handed
// the descriptor explicitly; install.sh finds it under /proc/self/fd, confirms with `flock -n` on it that it is the lock
// and takes no lock of its own — a hand-run install.sh takes one), so a second run (the timer beside a hand run, two
// instances sharing one install) does nothing. A bridge that is stopped (`inactive`: an operator's stop) is not updated,
// since an update starts the bridge; one that `failed` (a crash loop that hit its start-rate limit) was running and is
// updated, since the update may be what repairs it — and the unit's state is read again before any restart, by the
// installer's setup (`--keep-stopped`) and here; no answer from systemd is not read as "running" either. A
// pending record is written before the installer runs and cleared only once the outcome is known (a run stopped
// half-way is finished by the next one), and success means the new daemon answered steadily — the unit's main pid, the
// expected version — for a while, not once (after a few seconds to answer at all). When the installer fails and
// this run's swap did happen, the previous copy goes back and the unit is restarted on it, but only when app.prev really
// holds the version that ran before; a bridge that still answers with the old version is the old process a failing
// check left alone (herdr down at that moment) — the new copy stays and the next run, seeing `status` report the old
// version, runs the installer's setup again. A stop between the two renames of a swap (power loss) leaves no app/ (or,
// for a private Node, no node/) at all: both units run `repair-app.sh` (written by setup) first, which puts app.prev
// (node.old) back. Every effect is a dependency, so tests never touch the network or systemd.
import fs from 'node:fs';
import path from 'node:path';
import type { ControlStatus } from './control.ts';
import type { ExecFn } from './tailscale.ts';

export const RELEASES_URL = 'https://github.com/inferenceaftermath/remotly/releases';

/** How long a bridge that the installer left unhealthy gets to answer at all before the previous copy goes back. */
export const ANSWER_WAIT_MS = 10_000;
/** How long the previous copy gets to come back after the rollback restart. */
export const ROLLBACK_WAIT_MS = 60_000;
/** How long a new daemon must keep answering — the unit's main pid, the installed version — before the update counts as done. */
export const STABLE_MS = 30_000;

/** Shell quoting for a line the user is asked to run: plain words stay as they are, anything else is single-quoted. */
const shq = (s: string): string => (/^[A-Za-z0-9_./:@%+,=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** What the installer is told about this install, so it replaces exactly this copy — for the unattended run and the by-hand line alike. */
export interface InstallerCall {
  /** Set for the installer, over the inherited environment (whose REMOTLY_NODE is dropped when this leaves it out). */
  env: Record<string, string>;
  /** Passed on to `setup`. */
  args: string[];
}

/**
 * The version it is asked for, the home it lives in, the release base it came from, the launcher it wrote, the unit
 * (when the environment names one), and the runtime the unit runs — except a private Node under <home>/node, which the
 * installer refreshes (or retires for a distribution package) itself; the Node mirror travels with it, and so does the
 * herdr selection (HERDR_SESSION / HERDR_SOCKET_PATH: the unit's Environment= lines are all that holds it when
 * config.json does not). `setup` reads the unit from REMOTLY_SYSTEMD_UNIT and the herdr socket from HERDR_* (all
 * inherited by the unattended run, so naming them changes nothing there and makes the by-hand line whole), but the
 * config dir only from its flag: without it the re-rendered unit would lose its Environment=REMOTLY_CONFIG_DIR line.
 * `--keep-stopped`: a unit stopped since this run's own check is left stopped by that setup.
 */
export function installerCall(deps: Pick<UpdateDeps, 'env' | 'pathDirs' | 'mainPath' | 'nodePath' | 'unit'>, home: string, releases: string, version: string): InstallerCall {
  const env: Record<string, string> = { REMOTLY_VERSION: version, REMOTLY_HOME: home, REMOTLY_RELEASE_URL: releases };
  const bin = deps.env['REMOTLY_BIN_DIR'] ?? launcherDir(deps.pathDirs, deps.mainPath);
  if (bin) env['REMOTLY_BIN_DIR'] = bin;
  if (!deps.nodePath.startsWith(path.join(home, 'node') + path.sep)) env['REMOTLY_NODE'] = deps.nodePath;
  const dist = deps.env['REMOTLY_NODE_DIST'];
  if (dist) env['REMOTLY_NODE_DIST'] = dist;
  if (deps.env['REMOTLY_SYSTEMD_UNIT']) env['REMOTLY_SYSTEMD_UNIT'] = deps.unit;
  for (const k of ['HERDR_SESSION', 'HERDR_SOCKET_PATH'] as const) {
    const v = deps.env[k];
    if (v) env[k] = v;
  }
  const args = ['--no-pair', '--no-wait', '--keep-mode', '--keep-stopped'];
  const configDir = deps.env['REMOTLY_CONFIG_DIR'];
  if (configDir) args.push('--config-dir', configDir);
  return { env, args };
}

/** The line that does by hand what this run would do: that release's installer, with the same settings and flags (the variables must reach `sh`, not `curl`). */
export function byHandLine(call: InstallerCall, releases: string, version: string): string {
  const assigns = Object.entries(call.env)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(' ');
  return `curl -fsSL ${shq(`${releases}/download/bridge-v${version}/install.sh`)} | ${assigns} sh${call.args.length > 0 ? ` -s -- ${call.args.map(shq).join(' ')}` : ''}`;
}

/**
 * What flock(1) exits with when the lock is taken (`-E`). Outside 0, 1 and 2 (the run under the lock), 64–78 (flock's
 * own failures, sysexits: 66 when it cannot open the lock file, 69 when it cannot run the command), 126/127 (newer
 * flocks for the latter) and 128+ (the command killed by a signal).
 */
export const LOCK_TAKEN_EXIT = 99;
/** Set by the re-run under flock: a run that then finds no lock descriptor stops instead of re-running itself forever. */
export const RELOCKED_ENV = 'REMOTLY_UPDATE_RELOCKED';
export const lockPath = (home: string): string => path.join(home, 'update.lock');
/** The same run again, under the kernel lock: flock(1) opens `<home>/update.lock`, locks it and runs the command holding that descriptor. */
export function lockedCommand(home: string, nodePath: string, mainPath: string): { cmd: string; args: string[] } {
  return { cmd: 'flock', args: ['-n', '-E', String(LOCK_TAKEN_EXIT), lockPath(home), nodePath, mainPath, 'update'] };
}

/**
 * The descriptor this process inherited that is open on `lock` — the proof that it runs under flock, and what it hands
 * the installer (Linux: the links under /proc/self/fd name the files). Null when there is none, or /proc cannot be read.
 */
export function inheritedLockFd(lock: string): number | null {
  let want: string;
  try {
    want = fs.realpathSync(lock);
  } catch {
    want = lock;
  }
  let names: string[];
  try {
    names = fs.readdirSync('/proc/self/fd');
  } catch {
    return null;
  }
  for (const n of names) {
    const fd = Number(n);
    if (!Number.isInteger(fd) || fd < 3) continue;
    try {
      if (fs.readlinkSync(`/proc/self/fd/${n}`) === want) return fd;
    } catch {
      /* closed meanwhile (the directory listing's own descriptor) */
    }
  }
  return null;
}

/** How a process this run started ended: its exit code, the signal that killed it, or why it could not start at all. */
export interface Exit {
  code: number | null;
  signal: string | null;
  error?: string;
}
export const describeExit = (e: Exit): string => (e.error !== undefined ? `could not be started (${e.error})` : e.signal !== null ? `was killed by ${e.signal}` : `exited with ${e.code}`);

export type InstallLayout =
  /** `<home>/app/src/main.ts` beside `package.json`: what install.sh lays out. */
  | { kind: 'release'; home: string; app: string }
  /** `<root>/bridge/src/main.ts` inside a repository (ci/deploy-bridge.sh, or a developer's checkout). */
  | { kind: 'checkout'; root: string }
  | { kind: 'other' };

export function installLayout(mainPath: string, exists: (p: string) => boolean = fs.existsSync): InstallLayout {
  const src = path.dirname(mainPath);
  const app = path.dirname(src);
  if (path.basename(src) !== 'src') return { kind: 'other' };
  if (path.basename(app) === 'bridge' && (exists(path.join(app, '..', 'install.sh')) || exists(path.join(app, '..', '.git')))) return { kind: 'checkout', root: path.dirname(app) };
  if (path.basename(app) === 'app' && exists(path.join(app, 'package.json'))) return { kind: 'release', home: path.dirname(app), app };
  return { kind: 'other' };
}

/** The version in `<dir>/package.json`, or null when there is none to read. */
export function packageVersion(dir: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** The version of a complete copy in `dir` — package.json's version with src/main.ts beside it; null for a bare or partial directory. */
export function installedVersion(dir: string): string | null {
  return fs.existsSync(path.join(dir, 'src', 'main.ts')) ? packageVersion(dir) : null;
}

/** `bridge-v0.2.0`, or a URL ending in `/releases/tag/bridge-v0.2.0` → `0.2.0`; null for anything else. */
export function versionFromTag(tag: string): string | null {
  const m = /(?:^|\/)bridge-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return m ? (m[1] as string) : null;
}

/**
 * Semantic-version order: the three numbers, then a prerelease sorts before its release (1.0.0-rc.1 < 1.0.0), build
 * metadata (`+…`) is ignored. Releases here are stable versions: /releases/latest never points at a prerelease, so a
 * prerelease copy moves on when the next stable release is newer than it.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): { nums: number[]; pre: string | undefined } => {
    const plus = v.indexOf('+');
    const bare = plus < 0 ? v : v.slice(0, plus);
    const dash = bare.indexOf('-');
    const core = dash < 0 ? bare : bare.slice(0, dash);
    return { nums: core.split('.').map(Number), pre: dash < 0 ? undefined : bare.slice(dash + 1) };
  };
  const sign = (d: number): -1 | 0 | 1 => (d < 0 ? -1 : d > 0 ? 1 : 0);
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = sign((A.nums[i] ?? 0) - (B.nums[i] ?? 0));
    if (d !== 0) return d;
  }
  if (A.pre === undefined && B.pre === undefined) return 0;
  if (A.pre === undefined) return 1;
  if (B.pre === undefined) return -1;
  const pa = A.pre.split('.');
  const pb = B.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = sign(Number(x) - Number(y));
      if (d !== 0) return d;
    } else if (nx) return -1;
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The PATH directory whose `remotly-bridge` is install.sh's launcher for this copy (it names this main.ts); null when none. */
export function launcherDir(pathDirs: string[], mainPath: string, read: (p: string) => string | null = readIfFile): string | null {
  for (const d of pathDirs) {
    if (!d) continue;
    const text = read(path.join(d, 'remotly-bridge'));
    if (text !== null && text.includes(mainPath)) return d;
  }
  return null;
}

function readIfFile(p: string): string | null {
  try {
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/** What a run writes before the installer starts, and clears once the outcome is known. */
export interface Pending {
  /** Version on disk (and, normally, running) before; the installer's target; when this run started (ISO 8601). */
  from: string;
  to: string;
  started: string;
}
export const pendingFile = (home: string): string => path.join(home, 'update-pending.json');

export function readPending(home: string): Pending | null {
  try {
    const p = JSON.parse(fs.readFileSync(pendingFile(home), 'utf8')) as Partial<Pending>;
    return typeof p.from === 'string' && typeof p.to === 'string' && typeof p.started === 'string' ? { from: p.from, to: p.to, started: p.started } : null;
  } catch {
    return null;
  }
}
function writePending(home: string, p: Pending): void {
  fs.writeFileSync(`${pendingFile(home)}.tmp`, JSON.stringify(p));
  fs.renameSync(`${pendingFile(home)}.tmp`, pendingFile(home));
}
const clearPending = (home: string): void => fs.rmSync(pendingFile(home), { force: true });

export interface UpdateDeps {
  /** The running copy's version and main.ts. */
  version: string;
  mainPath: string;
  /** The runtime the unit runs (REMOTLY_NODE baked into the update unit, else the stable path of this process's node). */
  nodePath: string;
  env: NodeJS.ProcessEnv;
  /** PATH entries, to find the launcher when REMOTLY_BIN_DIR was not baked into the unit. */
  pathDirs: string[];
  /** The unit setup installed (REMOTLY_SYSTEMD_UNIT), restarted on rollback. */
  unit: string;
  out: (line: string) => void;
  exec: ExecFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The descriptor this process inherited on the lock file, if any (inheritedLockFd). */
  heldLockFd: (lock: string) => number | null;
  /** Runs `flock -n -E LOCK_TAKEN_EXIT 3` with `lockFd` as its fd 3: confirms (or takes) the lock on that open file; LOCK_TAKEN_EXIT when another one holds it. */
  confirmLock: (lockFd: number) => Promise<Exit>;
  /** Runs `cmd args` with `env`, output inherited, and reports how it ended. */
  relock: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Exit>;
  /** The Location of `<releases>/latest` (a tag URL), not followed; null when unreachable or not a redirect. */
  latestTag: (releasesUrl: string) => Promise<string | null>;
  /** Fetches `url` into `dest`; rejects on any failure. */
  download: (url: string, dest: string) => Promise<void>;
  /** Runs `sh <script> …args` with `env`, output inherited and the lock descriptor handed over as fd 3; reports how it ended. */
  runInstaller: (script: string, args: string[], env: NodeJS.ProcessEnv, lockFd: number) => Promise<Exit>;
  /** `status` over the control socket; rejects while the daemon is not up. */
  status: (timeoutMs: number) => Promise<ControlStatus>;
  /** A fresh private directory for the downloaded installer. */
  mkdtemp: () => string;
}

const unitName = (unit: string): string => `${unit.replace(/\.service$/, '')}.service`;

/** Runs the whole sequence; returns the process exit code (0 current or updated, 1 failed, 2 not an installed release). */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const layout = installLayout(deps.mainPath);
  if (layout.kind === 'checkout') {
    deps.out(`this copy runs from a repository checkout (${layout.root}); update is for a release installed by install.sh — a checkout is updated by git and its own deploy (ci/deploy-bridge.sh)`);
    return 2;
  }
  if (layout.kind === 'other') {
    deps.out(`this copy (${deps.mainPath}) is not laid out like an installed release (<home>/app/src/main.ts beside package.json); update only knows that layout`);
    return 2;
  }
  const lock = lockPath(layout.home);
  const lockFd = deps.heldLockFd(lock);
  if (lockFd === null) {
    if (deps.env[RELOCKED_ENV] === '1') {
      deps.out(`re-run under flock, but no descriptor open on ${lock} was inherited (is /proc/self/fd readable?); not updating without the lock`);
      return 1;
    }
    // Not under the lock yet: the same command again under flock(1). The lock is the descriptor flock opens: held for
    // as long as that process, and whatever it hands the descriptor to, lives — a run stopped by a signal or a power
    // loss leaves nothing to clean up, and no pid to misjudge. The environment alone proves nothing: the descriptor does.
    const { cmd, args } = lockedCommand(layout.home, deps.nodePath, deps.mainPath);
    const r = await deps.relock(cmd, args, { ...deps.env, [RELOCKED_ENV]: '1' });
    if (r.error !== undefined) {
      deps.out(r.error.includes('ENOENT') ? 'flock (util-linux) is needed to run one update at a time; install it and run again' : `could not run flock: ${r.error}`);
      return 1;
    }
    if (r.signal !== null) {
      deps.out(`the update under the lock was killed by ${r.signal}`);
      return 1;
    }
    if (r.code === LOCK_TAKEN_EXIT) {
      deps.out(`another install or update of ${layout.home} is running; nothing to do`);
      return 0;
    }
    if (r.code === 0 || r.code === 1 || r.code === 2) return r.code;
    deps.out(r.code !== null && r.code > 128 ? `the update under the lock was killed (flock exited with ${r.code})` : `flock could not run the update (exit ${r.code ?? 'unknown'}; its message is above)`);
    return 1;
  }
  // An open descriptor alone proves nothing (anything could have opened the file and handed it down): flock on that
  // same open file confirms the lock it holds — or takes it, or fails because another one holds it.
  const c = await deps.confirmLock(lockFd);
  if (c.code === LOCK_TAKEN_EXIT) {
    deps.out(`a descriptor on ${lock} was inherited, but another install or update of ${layout.home} holds the lock; nothing to do`);
    return 0;
  }
  if (c.code !== 0) {
    deps.out(`could not confirm the lock on ${lock} (flock ${describeExit(c)}); not updating without it`);
    return 1;
  }
  return updateLocked(deps, layout, lockFd);
}

async function updateLocked(deps: UpdateDeps, layout: { home: string; app: string }, lockFd: number): Promise<number> {
  const pending = readPending(layout.home);
  if (pending) {
    deps.out(`an update ${pending.from} → ${pending.to} started ${pending.started} did not finish (its process was stopped): finishing it`);
    return finish(deps, layout, pending, undefined);
  }
  const releases = (deps.env['REMOTLY_RELEASE_URL'] ?? RELEASES_URL).replace(/\/+$/, '');
  const tag = await deps.latestTag(releases);
  if (tag === null) {
    deps.out(`cannot read the latest release from ${releases}/latest (offline, or no release yet)`);
    return 1;
  }
  const latest = versionFromTag(tag);
  if (latest === null) {
    deps.out(`${releases}/latest points at "${tag}", not at a bridge release (bridge-vX.Y.Z)`);
    return 1;
  }
  const cmp = compareVersions(latest, deps.version);
  if (cmp < 0) {
    deps.out(`the latest release is ${latest}, older than the installed ${deps.version}; not downgrading (by hand:  ${byHandLine(installerCall(deps, layout.home, releases, latest), releases, latest)})`);
    return 0;
  }
  if (cmp === 0) {
    const running = await runningVersion(deps, 3000);
    if (running === null) {
      deps.out(`remotly-bridge ${deps.version} is the latest release (the bridge is not answering right now:  systemctl --user status ${unitName(deps.unit)})`);
      return 0;
    }
    if (running === deps.version) {
      deps.out(`remotly-bridge ${deps.version} is the latest release`);
      return 0;
    }
    // Another version, or none (a daemon from before the field, 0.1.x): the code on disk is not what runs — an earlier
    // upgrade's setup stopped at a failing check before restarting the unit. The installer sees this version installed
    // and only runs setup again.
    deps.out(`remotly-bridge ${deps.version} is installed but the running bridge is still ${running ?? 'a version from before 0.2.0'} (an earlier update did not get to restart it): running the installer's setup again`);
  } else deps.out(`remotly-bridge ${deps.version} → ${latest}: running that release's installer`);
  return install(deps, layout, releases, latest, lockFd);
}

/** The daemon's version within `waitMs`: undefined when it predates the field, null when it does not answer. */
async function runningVersion(deps: UpdateDeps, waitMs: number): Promise<string | undefined | null> {
  const started = deps.now();
  for (;;) {
    try {
      return (await deps.status(3000)).version;
    } catch {
      /* not up */
    }
    if (deps.now() - started >= waitMs) return null;
    await deps.sleep(1000);
  }
}

/**
 * systemd's word on the unit: `running` (active, on its way up, reloading), `failed` (a crash loop that hit its
 * start-rate limit: it was running and is meant to be), `stopped` (inactive, or on its way there: an operator's stop),
 * or null when `is-active` gave no state this code knows (no bus, an unknown word) — never taken for either.
 */
type UnitState = 'running' | 'failed' | 'stopped';
async function unitState(deps: UpdateDeps): Promise<{ state: UnitState | null; said: string }> {
  const r = await deps.exec('systemctl', ['--user', 'is-active', unitName(deps.unit)]);
  const s = r.stdout.trim();
  const said = s || (r.stderr.trim() ? r.stderr.trim() : r.code === null ? 'systemctl did not run' : `exit ${r.code}, no output`);
  if (['active', 'activating', 'reloading'].includes(s)) return { state: 'running', said };
  if (s === 'failed') return { state: 'failed', said };
  if (s === 'inactive' || s === 'deactivating') return { state: 'stopped', said };
  return { state: null, said };
}

/**
 * Why a restart here would be wrong, or null when it is right: the unit was running when the update started, but a
 * stop since (an operator's) stands, and no answer from systemd is not read as "running".
 */
async function noRestart(deps: UpdateDeps): Promise<string | null> {
  const unit = unitName(deps.unit);
  const { state, said } = await unitState(deps);
  if (state === 'running' || state === 'failed') return null;
  return state === 'stopped' ? `${unit} is stopped and stays so` : `whether ${unit} is running cannot be told (systemctl --user is-active ${unit}: ${said}), so it is not restarted`;
}

/** `restart`, after clearing a start-rate limit a crash loop may have left (a unit in that state refuses a plain start). */
async function restartUnit(deps: UpdateDeps): Promise<{ code: number | null; stdout: string; stderr: string }> {
  await deps.exec('systemctl', ['--user', 'reset-failed', unitName(deps.unit)]);
  return deps.exec('systemctl', ['--user', 'restart', unitName(deps.unit)]);
}

/** The unit's main pid as systemd has it; 0 when it has none (stopped, or between restarts), null when systemctl fails. */
async function unitMainPid(deps: UpdateDeps): Promise<number | null> {
  const r = await deps.exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unitName(deps.unit)]);
  const pid = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(pid) && pid >= 0 ? pid : null;
}

/** True when `status` answers with `version` from the process that is the unit's main pid right now. */
async function answersAs(deps: UpdateDeps, version: string): Promise<boolean> {
  try {
    const s = await deps.status(3000);
    return s.version === version && typeof s.pid === 'number' && s.pid > 0 && s.pid === (await unitMainPid(deps));
  } catch {
    return false;
  }
}

/**
 * True when the daemon answers every second for `forMs` with `version`, from one pid throughout, and that pid is the
 * unit's main pid each time — a crash loop changes the pid, a daemon from another unit or a hand-started `serve` on
 * the same socket is not the unit's. The first such answer gets `graceMs` to arrive (a daemon just started by the
 * installer's setup, or by systemd at boot for a run that finishes a stopped one, is not up the same instant); from
 * then on the watch is uninterrupted.
 */
async function steady(deps: UpdateDeps, version: string, forMs: number, graceMs: number): Promise<boolean> {
  const started = deps.now();
  let pid: number | undefined;
  let since = started;
  for (;;) {
    let s: ControlStatus | null = null;
    try {
      s = await deps.status(3000);
    } catch {
      /* not up */
    }
    // The pid is compared before systemd is asked: a changed pid is a verdict on its own.
    const answered = s !== null && s.version === version && typeof s.pid === 'number' && s.pid > 0 && (pid === undefined || s.pid === pid) ? s.pid : null;
    if (answered === null || (await unitMainPid(deps)) !== answered) {
      if (pid !== undefined || deps.now() - started >= graceMs) return false;
    } else if (pid === undefined) {
      pid = answered;
      since = deps.now();
    }
    if (pid !== undefined && deps.now() - since >= forMs) return true;
    await deps.sleep(1000);
  }
}

/** Waits up to `waitMs` for the daemon to answer as `version` from the unit's main pid. */
async function comesBackAs(deps: UpdateDeps, version: string, waitMs: number): Promise<boolean> {
  const started = deps.now();
  for (;;) {
    if (await answersAs(deps, version)) return true;
    if (deps.now() - started >= waitMs) return false;
    await deps.sleep(1000);
  }
}

/** Downloads release `version`'s install.sh and runs it pinned to that version against this install. */
async function install(deps: UpdateDeps, layout: { home: string; app: string }, releases: string, version: string, lockFd: number): Promise<number> {
  const unit = unitName(deps.unit);
  const byHand = byHandLine(installerCall(deps, layout.home, releases, version), releases, version);
  const { state, said } = await unitState(deps);
  if (state === null) {
    deps.out(`cannot tell whether ${unit} is running (systemctl --user is-active ${unit}: ${said}); not updating — by hand:  ${byHand}`);
    return 1;
  }
  if (state === 'stopped') {
    // The installer's setup starts the unit, and so would a rollback: a bridge its operator stopped is not started by
    // an unattended update — it is updated once it runs again. (A `failed` one was running: a crash loop that hit its
    // start-rate limit; the update may be what repairs it.) A stop after this check is caught by that setup's
    // `--keep-stopped` and by the state read before each restart in finish().
    deps.out(`${unit} is not running: an update starts the bridge, so nothing is installed while it is stopped — start it (systemctl --user start ${unit}) and the next run installs ${version}, or install by hand:  ${byHand}`);
    return 0;
  }
  const dir = deps.mkdtemp();
  try {
    return await installFrom(deps, layout, releases, version, dir, lockFd);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // whatever happened in between, the download does not stay
  }
}

async function installFrom(deps: UpdateDeps, layout: { home: string; app: string }, releases: string, version: string, dir: string, lockFd: number): Promise<number> {
  const script = path.join(dir, 'install.sh');
  try {
    await deps.download(`${releases}/download/bridge-v${version}/install.sh`, script);
  } catch (err) {
    deps.out(`could not download the installer of ${version}: ${(err as Error).message}`);
    return 1;
  }
  // The installer is told what this install looks like (installerCall), over the environment this run inherited.
  const call = installerCall(deps, layout.home, releases, version);
  const env: NodeJS.ProcessEnv = { ...deps.env, ...call.env };
  if (!('REMOTLY_NODE' in call.env)) delete env['REMOTLY_NODE'];
  const pending: Pending = { from: deps.version, to: version, started: new Date(deps.now()).toISOString() };
  writePending(layout.home, pending);
  const exit = await deps.runInstaller(script, call.args, env, lockFd);
  return finish(deps, layout, pending, exit);
}

/**
 * The outcome of a pending update: `exit` is how the installer ended, undefined when the run that started it was
 * stopped. Done when the target version is on disk and its daemon answers steadily. Otherwise: nothing to undo when the
 * swap never happened; the old process left in place when it still answers with the old version (its setup will be run
 * again by the next run); the previous copy back in every other case, provided app.prev holds the version from before.
 */
async function finish(deps: UpdateDeps, layout: { home: string; app: string }, pending: Pending, exit: Exit | undefined): Promise<number> {
  const unit = unitName(deps.unit);
  const journal = `journalctl --user -u ${unit} -n 30`; // the daemon's own log: why it does not start or stay up
  const installerLog = `the installer's output above says why (from the timer:  journalctl --user -u ${unit.replace(/\.service$/, '')}-update.service -n 50)`;
  const onDisk = packageVersion(layout.app);
  const releases = (deps.env['REMOTLY_RELEASE_URL'] ?? RELEASES_URL).replace(/\/+$/, '');
  const byHand = (version: string): string => byHandLine(installerCall(deps, layout.home, releases, version), releases, version);
  if (onDisk === pending.to && (await steady(deps, pending.to, STABLE_MS, ANSWER_WAIT_MS))) {
    clearPending(layout.home);
    deps.out(`remotly-bridge ${pending.to} is running${exit === undefined || exit.code === 0 ? '' : ` (the installer ${describeExit(exit)}, but the bridge answered steadily on ${pending.to})`}`);
    return 0;
  }
  if (exit === undefined) deps.out(`the bridge is not steadily running ${pending.to}`);
  else if (exit.code === 0) deps.out(`the installer reported success, but the bridge is not steadily running ${pending.to} (a crash loop, another process answering, or a unit stopped meanwhile)`);
  else deps.out(`the installer of ${pending.to} ${describeExit(exit)}`);

  const swapped = pending.from !== pending.to && onDisk === pending.to;
  if (!swapped) {
    clearPending(layout.home);
    deps.out(`the bridge's files were not replaced (${onDisk ?? 'no version'} on disk); nothing to roll back — ${installerLog}`);
    if ((await runningVersion(deps, 3000)) === null) {
      // Not up on the copy it has: the installer's setup may have stopped it, or a stop between two renames (which
      // repair-app.sh has undone by now) left the unit in its start-rate limit. A restart is what an operator would do;
      // the unit was running when this update started (install() does not run otherwise) — unless an operator stopped
      // it since (a run that finishes a stopped one may be a day later): that stop stands.
      const why = await noRestart(deps);
      if (why !== null) {
        deps.out(`the bridge is not answering and ${why} (systemctl --user start ${unit} starts the ${onDisk ?? 'installed'} copy)`);
        return 1;
      }
      const r = await restartUnit(deps);
      deps.out(r.code === 0 ? `the bridge was not answering; restarted ${unit} on the ${onDisk ?? 'installed'} copy` : `the bridge is not answering and systemctl --user restart ${unit} failed: ${(r.stderr || r.stdout).trim() || 'no output'} — ${journal}`);
    }
    return 1;
  }
  const running = await runningVersion(deps, ANSWER_WAIT_MS);
  if (running !== null && running !== pending.to) {
    clearPending(layout.home);
    deps.out(`the bridge still runs ${running ?? 'the version from before'}; the ${pending.to} copy stays installed and the next update run sets it up again — ${installerLog}`);
    return 1;
  }
  const prev = `${layout.app}.prev`;
  const prevVersion = installedVersion(prev);
  if (prevVersion !== pending.from) {
    clearPending(layout.home);
    deps.out(`cannot roll back: ${prev} holds ${prevVersion ?? 'no complete copy'}, not the ${pending.from} that ran before — install one by hand:  ${byHand(pending.from)}`);
    return 1;
  }
  deps.out(running === null ? `the bridge is not answering: putting ${pending.from} back from ${prev}` : `the bridge answers but does not stay up on ${pending.to}: putting ${pending.from} back from ${prev}`);
  // Two renames under the lock (repair-app.sh does nothing while it is held). Should one fail, the state is reported
  // as it is and the fix is the installer, which is safe in any state — never a `mv` line that could nest directories.
  const failed = `${layout.app}.failed`;
  const describe = (d: string): string => (fs.existsSync(d) ? `holds ${installedVersion(d) ?? 'no complete copy'}` : 'is absent');
  const state = (): string => `${layout.app} ${describe(layout.app)}, ${prev} ${describe(prev)}, ${failed} ${describe(failed)}`;
  try {
    fs.rmSync(failed, { recursive: true, force: true });
    fs.renameSync(layout.app, failed);
  } catch (err) {
    deps.out(`could not move the ${pending.to} copy aside: ${(err as Error).message} (${state()}) — by hand:  ${byHand(pending.from)}`);
    return 1; // pending stays: the next run tries again
  }
  try {
    fs.renameSync(prev, layout.app);
  } catch (err) {
    if (installedVersion(layout.app) !== pending.from) {
      // No app/ at all right now (or not a whole one): put the copy that was there back rather than leave nothing
      // (repair-app.sh would otherwise do it at the units' next start).
      try {
        fs.renameSync(failed, layout.app);
      } catch {
        /* both moves failed: the pending record stays and repair-app.sh puts app.prev back at the next start */
      }
      deps.out(`could not put ${pending.from} back: ${(err as Error).message} (${state()}) — by hand:  ${byHand(pending.from)}`);
      return 1;
    }
    // Someone put it back meanwhile (the rename found app/ present): that is the rollback done.
  }
  clearPending(layout.home); // the files are back; from here on only the restart can still be wrong, which the next run cannot fix better
  const why = await noRestart(deps);
  if (why !== null) {
    deps.out(`${pending.from} is back in ${layout.app}; ${why} (systemctl --user start ${unit} starts it) — the ${pending.to} copy is in ${failed}`);
    return 1;
  }
  const r = await restartUnit(deps);
  if (r.code !== 0) {
    deps.out(`${pending.from} is back in ${layout.app} but systemctl --user restart ${unit} failed: ${(r.stderr || r.stdout).trim() || 'no output'}`);
    return 1;
  }
  if (await comesBackAs(deps, pending.from, ROLLBACK_WAIT_MS)) {
    deps.out(`${pending.from} is running again; the failed ${pending.to} copy is in ${failed} and the reason in the journal:  ${journal}`);
    return 1;
  }
  deps.out(`${pending.from} did not come back either — look at the journal:  ${journal}`);
  return 1;
}
