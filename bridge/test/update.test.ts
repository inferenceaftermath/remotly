import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ControlStatus } from '../src/control.ts';
import { ANSWER_WAIT_MS, LOCK_TAKEN_EXIT, RELEASES_URL, RELOCKED_ENV, STABLE_MS, byHandLine, compareVersions, inheritedLockFd, installLayout, installedVersion, installerCall, launcherDir, lockPath, packageVersion, pendingFile, readPending, runUpdate, versionFromTag, type UpdateDeps } from '../src/update.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-update-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const STATUS: ControlStatus = {
  pid: 4242,
  version: '0.1.0',
  herdr: 'up',
  listen: { host: '100.64.0.7', port: 7460 },
  tls: { mode: 'tailscale', not_after: '2027-01-01T00:00:00.000Z' },
  devices: 0,
  push: { apns: true, fcm: true, mode: { apns: 'relay', fcm: 'relay' } },
  clients: 0,
};
const TAG = (v: string) => `https://github.com/inferenceaftermath/remotly/releases/tag/bridge-v${v}`;

/** A release copy in `app`: `src/main.ts` beside a `package.json` naming `version`. */
function writeApp(app: string, version: string): void {
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src', 'main.ts'), `// main ${version}`);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version }));
}
/** What install_app does: the running copy becomes app.prev, the new release app. */
function swapTo(app: string, version: string): void {
  fs.rmSync(`${app}.prev`, { recursive: true, force: true });
  fs.renameSync(app, `${app}.prev`);
  writeApp(app, version);
}

/** What install.sh leaves behind: `<home>/app/src/main.ts` beside `package.json`, and the launcher in a bin directory. */
function release(home = fs.mkdtempSync(path.join(dir, 'home-'))) {
  const app = path.join(home, 'app');
  writeApp(app, '0.1.0');
  const mainPath = path.join(app, 'src', 'main.ts');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'remotly-bridge'), `#!/bin/sh\nexec '/usr/bin/node' '${mainPath}' "$@"\n`);
  return { home, app, mainPath, bin };
}
/** The by-hand line a run prints for `version`: that release's installer with this install's settings (no unit or config dir in the environment). */
const byHand = (r: { home: string; bin: string }, version: string, releases = RELEASES_URL): string => `curl -fsSL ${releases}/download/bridge-v${version}/install.sh | REMOTLY_VERSION=${version} REMOTLY_HOME=${r.home} REMOTLY_RELEASE_URL=${releases} REMOTLY_BIN_DIR=${r.bin} REMOTLY_NODE=/usr/bin/node sh -s -- --no-pair --no-wait --keep-mode --keep-stopped`;

type Over = Partial<UpdateDeps> & {
  /** The Location `/latest` answers with (default: the 0.2.0 tag); null = unreachable. */
  latest?: string | null;
  /** The installer's exit code (default 0; null = it could not be started); it swaps the copies when it exits 0, or when `swap` says so. */
  installerExit?: number | null;
  /** The installer is killed by this signal instead of exiting. */
  installerSignal?: string;
  swap?: boolean;
  /** Whether the daemon answers (default: yes). What it answers is `running()`: by default the version on disk, pid 4242. */
  up?: boolean | (() => boolean);
  running?: () => Partial<ControlStatus>;
  /** What systemd reports as the unit's MainPID (default 4242, the pid STATUS carries). */
  mainPid?: () => number;
  /** Scripted answers for `exec`; undefined = the default (MainPID from `mainPid`, is-active → active, everything else exit 0). */
  onExec?: (cmd: string, args: string[]) => { code: number | null; stdout: string; stderr: string } | undefined;
};
function makeDeps(over: Over = {}) {
  const r = release();
  const out: string[] = [];
  const calls: string[] = [];
  const downloads: string[] = [];
  const installs: { script: string; args: string[]; env: NodeJS.ProcessEnv; lockFd: number; scriptContent: string | null; pending: ReturnType<typeof readPending> }[] = [];
  let t = 1_000_000;
  const relocks: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const confirms: number[] = [];
  const { latest, installerExit, installerSignal, swap, up, running, mainPid, onExec, env: envOver, ...rest } = over;
  const isUp = (): boolean => (typeof up === 'function' ? up() : (up ?? true));
  const onDisk = (): Partial<ControlStatus> => {
    const v = packageVersion(r.app);
    return v === null ? {} : { version: v };
  };
  const deps: UpdateDeps = {
    version: '0.1.0',
    mainPath: r.mainPath,
    nodePath: '/usr/bin/node',
    env: envOver ?? {},
    pathDirs: ['', '/nowhere', r.bin],
    unit: 'remotly-bridge',
    out: (l) => out.push(l),
    exec: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      const scripted = onExec?.(cmd, args);
      if (scripted) return scripted;
      if (cmd === 'systemctl' && args[1] === 'show') return { code: 0, stdout: `${(mainPid ?? (() => 4242))()}\n`, stderr: '' };
      if (cmd === 'systemctl' && args[1] === 'is-active') return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
    heldLockFd: () => 3, // under the lock, as the re-run is: the body runs
    relock: async (cmd, args, env) => {
      relocks.push({ cmd, args, env });
      return { code: 0, signal: null };
    },
    confirmLock: async (fd) => {
      confirms.push(fd);
      return { code: 0, signal: null };
    },
    latestTag: async (releases) => {
      calls.push(`latest ${releases}`);
      return latest === undefined ? TAG('0.2.0') : latest;
    },
    download: async (url, dest) => {
      downloads.push(url);
      fs.writeFileSync(dest, `#!/bin/sh\n# installer from ${url}\n`);
    },
    runInstaller: async (script, args, env, lockFd) => {
      installs.push({ script, args, env, lockFd, scriptContent: fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : null, pending: readPending(r.home) });
      const code = installerSignal ? null : installerExit === undefined ? 0 : installerExit;
      if (swap ?? code === 0) swapTo(r.app, env['REMOTLY_VERSION'] as string);
      return installerSignal ? { code: null, signal: installerSignal } : code === null ? { code: null, signal: null, error: 'spawn sh ENOENT' } : { code, signal: null };
    },
    status: async () => {
      if (!isUp()) throw new Error('connect ECONNREFUSED');
      return { ...STATUS, ...(running ? running() : onDisk()) };
    },
    mkdtemp: () => fs.mkdtempSync(path.join(dir, 'tmp-')),
    ...rest,
  };
  return { deps, out, calls, downloads, installs, relocks, confirms, clock: () => t, restarts: () => calls.filter((c) => c === `systemctl --user restart ${deps.unit}.service`).length, ...r };
}
const leftovers = () => fs.readdirSync(dir).filter((n) => n.startsWith('tmp-'));
/** No pending record stays behind in `home` (the lock file is flock's and may stay). */
function clean(home: string, msg = ''): void {
  assert.equal(fs.existsSync(pendingFile(home)), false, `pending record ${msg}`);
}
const only = <T>(xs: T[]): T => {
  assert.equal(xs.length, 1);
  return xs[0] as T;
};

test('versionFromTag: the tag or the tag URL of a bridge release, nothing else', () => {
  assert.equal(versionFromTag('bridge-v0.2.0'), '0.2.0');
  assert.equal(versionFromTag(TAG('1.2.3-rc.1')), '1.2.3-rc.1');
  assert.equal(versionFromTag(' bridge-v0.2.0\n'), '0.2.0');
  for (const bad of ['v0.2.0', 'bridge-v0.2', 'app-v1.0.0', 'https://github.com/o/r/releases', 'bridge-v0.2.0/x', '']) assert.equal(versionFromTag(bad), null, bad);
});

test('compareVersions: numbers first, a prerelease before its release, identifiers as semver orders them', () => {
  const ordered = ['0.1.0', '0.1.1', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.beta', '0.2.0-beta', '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0-rc.1', '0.2.0', '0.10.0', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const want = i < j ? -1 : i > j ? 1 : 0;
      assert.equal(compareVersions(ordered[i] as string, ordered[j] as string), want, `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('1.0.0-rc.1+build.7', '1.0.0'), -1);
});

test('installLayout: an installed release, a repository checkout (install.sh or .git beside bridge/), anything else', () => {
  const r = release();
  assert.deepEqual(installLayout(r.mainPath), { kind: 'release', home: r.home, app: r.app });
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'bridge', 'src'), { recursive: true });
  const main = path.join(root, 'bridge', 'src', 'main.ts');
  assert.deepEqual(installLayout(main), { kind: 'other' }, 'bridge/ alone is not a checkout');
  fs.writeFileSync(path.join(root, 'install.sh'), '');
  assert.deepEqual(installLayout(main), { kind: 'checkout', root });
  fs.rmSync(path.join(root, 'install.sh'));
  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(installLayout(main), { kind: 'checkout', root });
  fs.rmSync(path.join(r.app, 'package.json'));
  assert.deepEqual(installLayout(r.mainPath), { kind: 'other' }, 'app/ without package.json');
  assert.deepEqual(installLayout('/x/app/lib/main.ts'), { kind: 'other' });
});

test('launcherDir: the PATH directory whose remotly-bridge names this main.ts', () => {
  const r = release();
  const other = path.join(dir, 'other-bin');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'remotly-bridge'), '#!/bin/sh\nexec node /elsewhere/app/src/main.ts "$@"\n');
  const asDir = path.join(dir, 'dir-bin');
  fs.mkdirSync(path.join(asDir, 'remotly-bridge'), { recursive: true });
  assert.equal(launcherDir(['', other, asDir, '/nowhere', r.bin], r.mainPath), r.bin);
  assert.equal(launcherDir([other, '/nowhere'], r.mainPath), null);
});

test('packageVersion: the version in package.json, null for anything else', () => {
  const r = release();
  assert.equal(packageVersion(r.app), '0.1.0');
  assert.equal(packageVersion(path.join(dir, 'nowhere')), null);
  fs.writeFileSync(path.join(r.app, 'package.json'), '{"name":"x"}');
  assert.equal(packageVersion(r.app), null);
  fs.writeFileSync(path.join(r.app, 'package.json'), 'not json');
  assert.equal(packageVersion(r.app), null);
});

test('current: one request, no download, no installer, exit 0; a daemon that is not answering is said so', async () => {
  const { deps, out, calls, downloads, installs, home } = makeDeps({ latest: TAG('0.1.0') });
  assert.equal(await runUpdate(deps), 0);
  assert.deepEqual(calls, [`latest ${RELEASES_URL}`]);
  assert.deepEqual(downloads, []);
  assert.deepEqual(installs, []);
  assert.match(out.join('\n'), /^remotly-bridge 0\.1\.0 is the latest release$/m);
  clean(home);
  const down = makeDeps({ latest: TAG('0.1.0'), up: false, unit: 'remotly-dev' });
  assert.equal(await runUpdate(down.deps), 0);
  assert.match(down.out.join('\n'), /is the latest release \(the bridge is not answering right now:  systemctl --user status remotly-dev\.service\)/);
  assert.deepEqual(down.installs, []);
  assert.ok(down.clock() - 1_000_000 <= 3000 + 1000, 'a current copy does not wait long for a daemon that is down');
});

test('newer release: that release\'s installer runs pinned to it, told this install\'s home, launcher dir, runtime and release base; success is the new daemon answering steadily', async () => {
  const { deps, out, downloads, installs, home, bin, app, clock } = makeDeps({ env: { HOME: '/home/alice', REMOTLY_SYSTEMD_UNIT: 'remotly-bridge' } });
  assert.equal(await runUpdate(deps), 0);
  assert.deepEqual(downloads, [`${RELEASES_URL}/download/bridge-v0.2.0/install.sh`]);
  const i = only(installs);
  assert.match(i.scriptContent ?? '', /installer from .*bridge-v0\.2\.0\/install\.sh/, 'the downloaded file is what runs');
  assert.deepEqual(i.args, ['--no-pair', '--no-wait', '--keep-mode', '--keep-stopped']);
  assert.equal(i.env['REMOTLY_VERSION'], '0.2.0');
  assert.equal(i.env['REMOTLY_HOME'], home);
  assert.equal(i.env['REMOTLY_BIN_DIR'], bin);
  assert.equal(i.env['REMOTLY_NODE'], '/usr/bin/node');
  assert.equal(i.env['REMOTLY_RELEASE_URL'], RELEASES_URL);
  assert.equal(i.env['HOME'], '/home/alice', 'the environment is inherited');
  assert.deepEqual({ from: i.pending?.from, to: i.pending?.to }, { from: '0.1.0', to: '0.2.0' }, 'the pending record is on disk while the installer runs');
  assert.equal(i.lockFd, 3, 'the installer is handed the lock descriptor');
  assert.equal(i.env[RELOCKED_ENV], undefined, 'nothing in the environment stands for the lock');
  assert.ok(fs.existsSync(`${app}.prev`), 'the installer kept the previous copy');
  assert.match(out.join('\n'), /0\.1\.0 → 0\.2\.0/);
  assert.match(out.join('\n'), /^remotly-bridge 0\.2\.0 is running$/m);
  assert.ok(clock() - 1_000_000 >= STABLE_MS, 'the daemon was watched for the whole stable period');
  assert.deepEqual(leftovers(), [], 'the downloaded installer is removed');
  clean(home, 'after a finished update');
});

test('current on disk but the daemon runs something else (an earlier update stopped at a failing check, or a daemon from before the version field): the installer runs again for the installed version', async () => {
  let setUp = false; // the installer's setup restarts the unit: from then on the daemon is the copy on disk
  const older = makeDeps({ latest: TAG('0.1.0'), running: () => (setUp ? {} : { version: '0.0.9' }), swap: false });
  const install = older.deps.runInstaller;
  older.deps.runInstaller = async (...a) => ((setUp = true), install(...a));
  assert.equal(await runUpdate(older.deps), 0);
  assert.deepEqual(older.downloads, [`${RELEASES_URL}/download/bridge-v0.1.0/install.sh`]);
  assert.equal(only(older.installs).env['REMOTLY_VERSION'], '0.1.0');
  assert.match(older.out.join('\n'), /0\.1\.0 is installed but the running bridge is still 0\.0\.9 .*running the installer's setup again/);
  assert.match(older.out.join('\n'), /^remotly-bridge 0\.1\.0 is running$/m);
  assert.equal(fs.existsSync(`${older.app}.prev`), false, 'setting up again moves nothing');
  // Legacy daemon: answers, but without a version; after the installer's setup it is the copy on disk.
  let restarted = false;
  const legacy = makeDeps({ latest: TAG('0.1.0'), swap: false });
  legacy.deps.runInstaller = async () => ((restarted = true), { code: 0, signal: null });
  const { version: _v, ...withoutVersion } = STATUS;
  legacy.deps.status = async () => (restarted ? STATUS : withoutVersion);
  assert.equal(await runUpdate(legacy.deps), 0);
  assert.match(legacy.out.join('\n'), /running bridge is still a version from before 0\.2\.0/);
  assert.match(legacy.out.join('\n'), /^remotly-bridge 0\.1\.0 is running$/m);
});

test('a private Node under <home>/node is left to the installer (no REMOTLY_NODE); a config dir goes to setup as its flag', async () => {
  const first = makeDeps();
  first.deps.nodePath = path.join(first.home, 'node', 'bin', 'node');
  assert.equal(await runUpdate(first.deps), 0);
  assert.equal(only(first.installs).env['REMOTLY_NODE'], undefined);
  const second = makeDeps({ env: { REMOTLY_CONFIG_DIR: '/home/alice/.config/remotly-dev' } });
  assert.equal(await runUpdate(second.deps), 0);
  assert.deepEqual(only(second.installs).args, ['--no-pair', '--no-wait', '--keep-mode', '--keep-stopped', '--config-dir', '/home/alice/.config/remotly-dev']);
});

test('REMOTLY_RELEASE_URL (mirrors, tests) decides where latest and the installer come from; REMOTLY_NODE_DIST is inherited as is', async () => {
  const { deps, calls, downloads, installs } = makeDeps({ env: { REMOTLY_RELEASE_URL: 'https://mirror.example/releases/', REMOTLY_NODE_DIST: 'https://mirror.example/node' }, latest: 'https://mirror.example/releases/tag/bridge-v0.3.0' });
  assert.equal(await runUpdate(deps), 0);
  assert.equal(calls[0], 'latest https://mirror.example/releases');
  assert.deepEqual(downloads, ['https://mirror.example/releases/download/bridge-v0.3.0/install.sh']);
  assert.equal(only(installs).env['REMOTLY_RELEASE_URL'], 'https://mirror.example/releases');
  assert.equal(only(installs).env['REMOTLY_NODE_DIST'], 'https://mirror.example/node');
});

test('the launcher directory: REMOTLY_BIN_DIR from the unit wins, else the launcher on PATH, else the installer\'s default', async () => {
  const fromEnv = makeDeps({ env: { REMOTLY_BIN_DIR: '/opt/remotly/bin' } });
  assert.equal(await runUpdate(fromEnv.deps), 0);
  assert.equal(only(fromEnv.installs).env['REMOTLY_BIN_DIR'], '/opt/remotly/bin');
  const none = makeDeps({ pathDirs: ['/nowhere'] });
  assert.equal(await runUpdate(none.deps), 0);
  assert.equal(only(none.installs).env['REMOTLY_BIN_DIR'], undefined);
});

test('unreachable, an unexpected redirect, or a failing download: exit 1, nothing runs, nothing is recorded', async () => {
  const offline = makeDeps({ latest: null });
  assert.equal(await runUpdate(offline.deps), 1);
  assert.match(offline.out.join('\n'), /cannot read the latest release from .*\/releases\/latest/);
  const odd = makeDeps({ latest: 'https://github.com/inferenceaftermath/remotly/releases/tag/app-v1.0.0' });
  assert.equal(await runUpdate(odd.deps), 1);
  assert.match(odd.out.join('\n'), /points at "https:.*app-v1\.0\.0", not at a bridge release/);
  const dl = makeDeps({
    download: async () => {
      throw new Error('HTTP 404');
    },
  });
  assert.equal(await runUpdate(dl.deps), 1);
  assert.match(dl.out.join('\n'), /could not download the installer of 0\.2\.0: HTTP 404/);
  assert.deepEqual(dl.installs, []);
  assert.deepEqual(leftovers(), []);
  for (const c of [offline, odd, dl]) clean(c.home);
});

test('an older "latest" (a release withdrawn) is not installed: exit 0 with the reason and the by-hand line', async () => {
  const own = makeDeps({ latest: TAG('0.0.9') });
  assert.equal(await runUpdate(own.deps), 0);
  assert.deepEqual(own.installs, []);
  const text = own.out.join('\n');
  assert.match(text, /latest release is 0\.0\.9, older than the installed 0\.1\.0; not downgrading \(by hand:  curl /);
  assert.ok(text.includes(`(by hand:  ${byHand(own, '0.0.9')})`), text);
});

test("installerCall and byHandLine: what the installer is told about this install, and the same as a line to run by hand (that release's installer; quoted for the shell where needed)", () => {
  const r = release();
  const deps = { env: { REMOTLY_CONFIG_DIR: '/home/al ice/.config/remotly-dev', REMOTLY_SYSTEMD_UNIT: 'remotly-dev', REMOTLY_NODE_DIST: 'https://mirror.example/node', HERDR_SESSION: 'work' }, pathDirs: [r.bin], mainPath: r.mainPath, nodePath: '/usr/bin/node', unit: 'remotly-dev' };
  const call = installerCall(deps, r.home, 'https://mirror.example/releases', '0.2.0');
  assert.deepEqual(call, {
    env: { REMOTLY_VERSION: '0.2.0', REMOTLY_HOME: r.home, REMOTLY_RELEASE_URL: 'https://mirror.example/releases', REMOTLY_BIN_DIR: r.bin, REMOTLY_NODE: '/usr/bin/node', REMOTLY_NODE_DIST: 'https://mirror.example/node', REMOTLY_SYSTEMD_UNIT: 'remotly-dev', HERDR_SESSION: 'work' },
    args: ['--no-pair', '--no-wait', '--keep-mode', '--keep-stopped', '--config-dir', '/home/al ice/.config/remotly-dev'],
  });
  assert.equal(
    byHandLine(call, 'https://mirror.example/releases', '0.2.0'),
    `curl -fsSL https://mirror.example/releases/download/bridge-v0.2.0/install.sh | REMOTLY_VERSION=0.2.0 REMOTLY_HOME=${r.home} REMOTLY_RELEASE_URL=https://mirror.example/releases REMOTLY_BIN_DIR=${r.bin} REMOTLY_NODE=/usr/bin/node REMOTLY_NODE_DIST=https://mirror.example/node REMOTLY_SYSTEMD_UNIT=remotly-dev HERDR_SESSION=work sh -s -- --no-pair --no-wait --keep-mode --keep-stopped --config-dir '/home/al ice/.config/remotly-dev'`,
  );
  // The herdr selection lives in the unit's environment alone when config.json does not name it: a socket path travels too.
  assert.equal(installerCall({ ...deps, env: { HERDR_SOCKET_PATH: '/run/user/1000/herdr/main.sock' } }, r.home, RELEASES_URL, '0.2.0').env['HERDR_SOCKET_PATH'], '/run/user/1000/herdr/main.sock');
  // A private Node is the installer's to refresh (no REMOTLY_NODE); no launcher on PATH, no REMOTLY_BIN_DIR; the unit only when the environment names one.
  const priv = installerCall({ env: {}, pathDirs: ['/nowhere'], mainPath: r.mainPath, nodePath: path.join(r.home, 'node', 'bin', 'node'), unit: 'remotly-bridge' }, r.home, RELEASES_URL, '0.3.0');
  assert.deepEqual(priv, { env: { REMOTLY_VERSION: '0.3.0', REMOTLY_HOME: r.home, REMOTLY_RELEASE_URL: RELEASES_URL }, args: ['--no-pair', '--no-wait', '--keep-mode', '--keep-stopped'] });
  // A quote in a value is quoted for the shell; no arguments, no `-s --`.
  assert.equal(byHandLine({ env: { REMOTLY_HOME: "/home/o'neil/remotly" }, args: [] }, RELEASES_URL, '0.3.0'), `curl -fsSL ${RELEASES_URL}/download/bridge-v0.3.0/install.sh | REMOTLY_HOME='/home/o'\\''neil/remotly' sh`);
});

test('a repository checkout is refused before any request or lock: exit 2', async () => {
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'bridge', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'install.sh'), '');
  const { deps, out, calls } = makeDeps({ mainPath: path.join(root, 'bridge', 'src', 'main.ts') });
  assert.equal(await runUpdate(deps), 2);
  assert.deepEqual(calls, []);
  assert.match(out.join('\n'), new RegExp(`runs from a repository checkout \\(${root}\\)`));
  assert.equal(fs.existsSync(path.join(root, 'update.lock')), false);
  const odd = makeDeps({ mainPath: '/opt/somewhere/lib/main.ts' });
  assert.equal(await runUpdate(odd.deps), 2);
  assert.match(odd.out.join('\n'), /not laid out like an installed release/);
});

test('one update at a time: without an inherited lock descriptor the run is the same command again under flock -n; a taken lock ends it with exit 0; no flock is an error; the environment alone proves nothing', async () => {
  const outer = makeDeps({ heldLockFd: () => null, env: { HOME: '/home/alice' } });
  assert.equal(await runUpdate(outer.deps), 0);
  assert.equal(outer.relocks.length, 1);
  const r = outer.relocks[0] as (typeof outer.relocks)[number];
  assert.equal(r.cmd, 'flock');
  assert.deepEqual(r.args, ['-n', '-E', String(LOCK_TAKEN_EXIT), lockPath(outer.home), '/usr/bin/node', outer.mainPath, 'update']);
  assert.equal(r.env[RELOCKED_ENV], '1', 'the re-run knows it was re-run (no third try)');
  assert.equal(r.env['HOME'], '/home/alice', 'the environment is inherited');
  assert.equal(outer.calls.some((c) => c.startsWith('latest ')), false, 'nothing happens outside the lock');
  assert.deepEqual(outer.installs, []);
  assert.deepEqual(outer.out, [], 'the locked run does the talking');

  const taken = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: LOCK_TAKEN_EXIT, signal: null }) });
  assert.equal(await runUpdate(taken.deps), 0);
  assert.match(taken.out.join('\n'), /another install or update of .* is running; nothing to do/);
  const failed = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: 1, signal: null }) });
  assert.equal(await runUpdate(failed.deps), 1, "the locked run's exit code is this run's");
  const none = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: null, signal: null, error: 'spawn flock ENOENT' }) });
  assert.equal(await runUpdate(none.deps), 1);
  assert.match(none.out.join('\n'), /flock \(util-linux\) is needed/);
  const odd = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: null, signal: null, error: 'spawn flock EACCES' }) });
  assert.equal(await runUpdate(odd.deps), 1);
  assert.match(odd.out.join('\n'), /could not run flock: spawn flock EACCES/);
  const killed = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: null, signal: 'SIGTERM' }) });
  assert.equal(await runUpdate(killed.deps), 1);
  assert.match(killed.out.join('\n'), /the update under the lock was killed by SIGTERM/);
  // flock's own failures (sysexits, 64–78: 66 when it cannot open the lock file, 69 when it cannot run the command) and
  // a command killed under it (128+) are neither the locked run's 0/1/2 nor "taken".
  assert.ok(LOCK_TAKEN_EXIT < 64 || LOCK_TAKEN_EXIT > 78, `${LOCK_TAKEN_EXIT} is not one of flock's own codes`);
  assert.ok(LOCK_TAKEN_EXIT > 2 && LOCK_TAKEN_EXIT < 126);
  const noopen = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: 66, signal: null }) });
  assert.equal(await runUpdate(noopen.deps), 1);
  assert.match(noopen.out.join('\n'), /flock could not run the update \(exit 66; its message is above\)/);
  const sigexit = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: 137, signal: null }) });
  assert.equal(await runUpdate(sigexit.deps), 1);
  assert.match(sigexit.out.join('\n'), /the update under the lock was killed \(flock exited with 137\)/);
  const two = makeDeps({ heldLockFd: () => null, relock: async () => ({ code: 2, signal: null }) });
  assert.equal(await runUpdate(two.deps), 2);

  // Under the lock (a descriptor inherited): flock on that descriptor confirms the lock before anything else happens —
  // an open descriptor alone proves nothing.
  const held = makeDeps();
  assert.equal(await runUpdate(held.deps), 0);
  assert.deepEqual(held.confirms, [3]);
  assert.ok(held.calls.includes(`latest ${RELEASES_URL}`));
  const elsewhere = makeDeps({ confirmLock: async () => ({ code: LOCK_TAKEN_EXIT, signal: null }) });
  assert.equal(await runUpdate(elsewhere.deps), 0);
  assert.equal(elsewhere.calls.some((c) => c.startsWith('latest ')), false);
  assert.deepEqual(elsewhere.installs, []);
  assert.match(elsewhere.out.join('\n'), /a descriptor on .*update\.lock was inherited, but another install or update of .* holds the lock; nothing to do/);
  const unconfirmed = makeDeps({ confirmLock: async () => ({ code: null, signal: null, error: 'spawn flock ENOENT' }) });
  assert.equal(await runUpdate(unconfirmed.deps), 1);
  assert.deepEqual(unconfirmed.installs, []);
  assert.match(unconfirmed.out.join('\n'), /could not confirm the lock on .*update\.lock \(flock could not be started \(spawn flock ENOENT\)\); not updating without it/);

  // Re-run under flock, and still no descriptor on the lock file: not a third try, and nothing without the lock.
  const blind = makeDeps({ heldLockFd: () => null, env: { [RELOCKED_ENV]: '1' } });
  assert.equal(await runUpdate(blind.deps), 1);
  assert.deepEqual(blind.relocks, []);
  assert.deepEqual(blind.installs, []);
  assert.match(blind.out.join('\n'), /re-run under flock, but no descriptor open on .*update\.lock was inherited/);
  // The variable set by hand changes nothing: the descriptor decides.
  const faked = makeDeps({ heldLockFd: () => null, env: { REMOTLY_UPDATE_LOCKED: '1' } });
  assert.equal(await runUpdate(faked.deps), 0);
  assert.equal(faked.relocks.length, 1);
  assert.deepEqual(faked.installs, []);

  // A checkout is refused before any lock.
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'bridge', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'install.sh'), '');
  const checkout = makeDeps({ heldLockFd: () => null, mainPath: path.join(root, 'bridge', 'src', 'main.ts') });
  assert.equal(await runUpdate(checkout.deps), 2);
  assert.deepEqual(checkout.relocks, []);
});

test('the lock is the descriptor: a child handed it keeps the lock after the locked process is gone (flock and node, for real)', async (t) => {
  if (process.platform !== 'linux' || spawnSync('flock', ['--version']).status !== 0) return t.skip('needs Linux and flock');
  const lock = path.join(dir, 'update.lock');
  const src = path.resolve(import.meta.dirname, '..', 'src', 'update.ts');
  // Under flock: find the inherited descriptor as `update` does, hand it to a child that outlives this process.
  const script = `import { inheritedLockFd } from ${JSON.stringify(src)};
import { spawn } from 'node:child_process';
const fd = inheritedLockFd(process.env.LOCK);
if (fd === null) { console.log('no descriptor'); process.exit(3); }
const c = spawn('sleep', ['3'], { stdio: ['ignore', 'ignore', 'ignore', fd], detached: true });
c.unref();
console.log('fd ' + fd);`;
  const out = execFileSync('flock', ['-n', lock, process.execPath, '--input-type=module', '-e', script], { env: { ...process.env, LOCK: lock }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /^fd \d+$/m, 'the locked process found its descriptor');
  const probe = () => spawnSync('flock', ['-n', '-E', String(LOCK_TAKEN_EXIT), lock, 'true']).status;
  assert.equal(probe(), LOCK_TAKEN_EXIT, 'still locked: the child holds the descriptor');
  const until = Date.now() + 8000;
  while (probe() === LOCK_TAKEN_EXIT && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  assert.equal(probe(), 0, 'free once the child is gone');
  assert.equal(inheritedLockFd(lock), null, 'this process, not under flock, has none');
  // What confirmLock relies on: a lock is per open file. On the descriptor flock locked, `flock -n` succeeds again; on
  // another descriptor of the same file — opened without locking, even by the same process — it fails.
  const same = spawnSync('sh', ['-c', `exec 9>"$0"; flock -n 9 || exit 5; flock -n -E ${LOCK_TAKEN_EXIT} 9; echo "same=$?"; exec 3>"$0"; flock -n -E ${LOCK_TAKEN_EXIT} 3; echo "other=$?"`, lock], { encoding: 'utf8' });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /^same=0$/m);
  assert.match(same.stdout, new RegExp(`^other=${LOCK_TAKEN_EXIT}$`, 'm'));
});

test('a stopped bridge is not updated (an update would start it): exit 0 with the by-hand line; a failed one (crash loop) is; no state at all is an error', async () => {
  const stopped = makeDeps({ onExec: (_c, args) => (args[1] === 'is-active' ? { code: 3, stdout: 'inactive\n', stderr: '' } : undefined) });
  assert.equal(await runUpdate(stopped.deps), 0);
  assert.deepEqual(stopped.downloads, []);
  assert.deepEqual(stopped.installs, []);
  const text = stopped.out.join('\n');
  assert.match(text, /remotly-bridge\.service is not running: an update starts the bridge, so nothing is installed while it is stopped — start it \(systemctl --user start remotly-bridge\.service\) and the next run installs 0\.2\.0, or install by hand:  curl /);
  assert.ok(text.includes(`or install by hand:  ${byHand(stopped, '0.2.0')}`), text);
  clean(stopped.home);
  assert.deepEqual(leftovers(), []);
  // `failed` (Restart=always gave up: the start-rate limit): it was running, and the update may be what repairs it.
  const crashed = makeDeps({ onExec: (_c, args) => (args[1] === 'is-active' ? { code: 3, stdout: 'failed\n', stderr: '' } : undefined) });
  assert.equal(await runUpdate(crashed.deps), 0);
  assert.equal(crashed.installs.length, 1);
  assert.match(crashed.out.join('\n'), /^remotly-bridge 0\.2\.0 is running$/m);
  clean(crashed.home);
  // No state (no bus, an unknown word): neither running nor stopped is assumed.
  const nobus = makeDeps({ onExec: (_c, args) => (args[1] === 'is-active' ? { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } : undefined) });
  assert.equal(await runUpdate(nobus.deps), 1);
  assert.deepEqual(nobus.installs, []);
  assert.match(nobus.out.join('\n'), /cannot tell whether remotly-bridge\.service is running \(systemctl --user is-active remotly-bridge\.service: Failed to connect to bus: No medium found\); not updating — by hand:  curl /);
  const odd = makeDeps({ onExec: (_c, args) => (args[1] === 'is-active' ? { code: 3, stdout: 'maintenance\n', stderr: '' } : undefined) });
  assert.equal(await runUpdate(odd.deps), 1);
  assert.match(odd.out.join('\n'), /is running \(systemctl --user is-active remotly-bridge\.service: maintenance\)/);
  clean(nobus.home);
});

test('installer failed before it replaced anything: nothing to roll back, the record is cleared, exit 1', async () => {
  const { deps, out, calls, app, home } = makeDeps({ installerExit: 1 });
  assert.equal(await runUpdate(deps), 1);
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.equal(fs.existsSync(`${app}.prev`), false);
  assert.equal(calls.filter((c) => c.startsWith('systemctl') && !c.includes('is-active') && !c.includes('show')).length, 0, 'the bridge is up: nothing to restart');
  const text = out.join('\n');
  assert.match(text, /installer of 0\.2\.0 exited with 1/);
  assert.match(text, /files were not replaced \(0\.1\.0 on disk\); nothing to roll back — the installer's output above says why \(from the timer:  journalctl --user -u remotly-bridge-update\.service -n 50\)/);
  clean(home);
  const notStarted = makeDeps({ installerExit: null });
  assert.equal(await runUpdate(notStarted.deps), 1);
  assert.match(notStarted.out.join('\n'), /installer of 0\.2\.0 could not be started \(spawn sh ENOENT\)/);
  const killed = makeDeps({ installerSignal: 'SIGKILL' });
  assert.equal(await runUpdate(killed.deps), 1);
  assert.match(killed.out.join('\n'), /installer of 0\.2\.0 was killed by SIGKILL/);
  // Not replaced and the bridge is down (its setup stopped it, or the unit sits in its start-rate limit): one restart,
  // after clearing the start-rate limit.
  const down = makeDeps({ installerExit: 1, up: false });
  assert.equal(await runUpdate(down.deps), 1);
  assert.equal(down.restarts(), 1);
  assert.ok(down.calls.indexOf('systemctl --user reset-failed remotly-bridge.service') < down.calls.indexOf('systemctl --user restart remotly-bridge.service'), `reset-failed first: ${down.calls.join(' | ')}`);
  assert.match(down.out.join('\n'), /the bridge was not answering; restarted remotly-bridge\.service on the 0\.1\.0 copy/);
  // Not replaced, the bridge down — and the unit stopped since this update started (an operator's stop stands): no restart.
  const states = ['active\n'];
  const halted = makeDeps({ installerExit: 1, up: false, onExec: (_c, args) => (args[1] === 'is-active' ? { code: 0, stdout: states.shift() ?? 'inactive\n', stderr: '' } : undefined) });
  assert.equal(await runUpdate(halted.deps), 1);
  assert.equal(halted.restarts(), 0);
  assert.match(halted.out.join('\n'), /the bridge is not answering and remotly-bridge\.service is stopped and stays so \(systemctl --user start remotly-bridge\.service starts the 0\.1\.0 copy\)/);
  clean(halted.home);
  // No answer from systemd at that moment is not "running" either: no restart, and the message says what was asked.
  const answers = [{ code: 0, stdout: 'active\n', stderr: '' }];
  const blind = makeDeps({ installerExit: 1, up: false, onExec: (_c, args) => (args[1] === 'is-active' ? (answers.shift() ?? NOBUS) : undefined) });
  assert.equal(await runUpdate(blind.deps), 1);
  assert.equal(blind.restarts(), 0);
  assert.match(blind.out.join('\n'), /the bridge is not answering and whether remotly-bridge\.service is running cannot be told \(systemctl --user is-active remotly-bridge\.service: Failed to connect to bus: No medium found\), so it is not restarted \(systemctl --user start remotly-bridge\.service starts the 0\.1\.0 copy\)/);
  clean(blind.home);
});
const NOBUS = { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };

test('installer failed after the swap, the old bridge still answering with its version: the new copy stays, nothing is moved, exit 1', async () => {
  const { deps, out, calls, app, home } = makeDeps({ installerExit: 1, swap: true, running: () => ({ version: '0.1.0' }) });
  assert.equal(await runUpdate(deps), 1);
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), '// main 0.2.0', 'the new copy is still app/');
  assert.equal(fs.readFileSync(path.join(`${app}.prev`, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.equal(calls.some((c) => c.includes('restart')), false);
  assert.match(out.join('\n'), /bridge still runs 0\.1\.0; the 0\.2\.0 copy stays installed and the next update run sets it up again — the installer's output above says why/);
  clean(home);
});

test('installer failed after the swap, bridge not answering: the previous copy goes back, the unit is restarted, exit 1', async () => {
  let restarted = false;
  const { deps, out, calls, app, home } = makeDeps({
    installerExit: 1,
    swap: true,
    up: () => restarted,
    onExec: (cmd, args) => ((restarted ||= cmd === 'systemctl' && args[1] === 'restart'), undefined),
  });
  assert.equal(await runUpdate(deps), 1);
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0', 'the previous copy is app/ again');
  assert.equal(fs.readFileSync(path.join(`${app}.failed`, 'src', 'main.ts'), 'utf8'), '// main 0.2.0', 'the failed copy is kept');
  assert.equal(fs.existsSync(`${app}.prev`), false);
  assert.deepEqual(calls.filter((c) => c.includes('reset-failed') || c.includes('restart')), ['systemctl --user reset-failed remotly-bridge.service', 'systemctl --user restart remotly-bridge.service']);
  const text = out.join('\n');
  assert.match(text, /bridge is not answering: putting 0\.1\.0 back from .*app\.prev/);
  assert.match(text, /0\.1\.0 is running again; the failed 0\.2\.0 copy is in .*app\.failed and the reason in the journal:  journalctl --user -u remotly-bridge\.service -n 30/);
  clean(home);
  // The unit stopped since this update started: the files go back, the unit stays stopped.
  const states = ['active\n'];
  const halted = makeDeps({ installerExit: 1, swap: true, up: false, onExec: (_c, args) => (args[1] === 'is-active' ? { code: 0, stdout: states.shift() ?? 'inactive\n', stderr: '' } : undefined) });
  assert.equal(await runUpdate(halted.deps), 1);
  assert.equal(fs.readFileSync(path.join(halted.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0', 'the previous copy is app/ again');
  assert.equal(halted.restarts(), 0, 'the unit stays stopped');
  assert.match(halted.out.join('\n'), /0\.1\.0 is back in .*app; remotly-bridge\.service is stopped and stays so \(systemctl --user start remotly-bridge\.service starts it\) — the 0\.2\.0 copy is in .*app\.failed/);
  clean(halted.home);
  // No answer from systemd right before the restart: the files are back, the unit is not restarted blindly.
  const answers = [{ code: 0, stdout: 'active\n', stderr: '' }];
  const blind = makeDeps({ installerExit: 1, swap: true, up: false, onExec: (_c, args) => (args[1] === 'is-active' ? (answers.shift() ?? NOBUS) : undefined) });
  assert.equal(await runUpdate(blind.deps), 1);
  assert.equal(fs.readFileSync(path.join(blind.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.equal(blind.restarts(), 0);
  assert.match(blind.out.join('\n'), /0\.1\.0 is back in .*app; whether remotly-bridge\.service is running cannot be told \(systemctl --user is-active remotly-bridge\.service: Failed to connect to bus: No medium found\), so it is not restarted \(systemctl --user start remotly-bridge\.service starts it\) — the 0\.2\.0 copy is in .*app\.failed/);
  clean(blind.home);
});

test('a new daemon that takes a few seconds to answer gets its stability window (no rollback); once it has answered, a gap is a verdict', async () => {
  const late = makeDeps({ up: () => late.clock() >= 1_000_000 + 4000 });
  assert.equal(await runUpdate(late.deps), 0);
  assert.equal(late.restarts(), 0);
  assert.equal(fs.existsSync(`${late.app}.failed`), false);
  assert.match(late.out.join('\n'), /^remotly-bridge 0\.2\.0 is running$/m);
  assert.ok(late.clock() - 1_000_000 >= 4000 + STABLE_MS, 'the watch starts with the first answer');
  clean(late.home);
  // Answers, then not for a moment: not steady — the window is uninterrupted once it has begun.
  let n = 0;
  const blink = makeDeps({ up: () => n++ !== 3 });
  assert.equal(await runUpdate(blink.deps), 1);
  assert.equal(fs.readFileSync(path.join(blink.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.match(blink.out.join('\n'), /bridge answers but does not stay up on 0\.2\.0: putting 0\.1\.0 back/);
  clean(blink.home);
});

test('installer reported success but the new daemon does not stay up (crash loop, or never answers): the previous copy goes back', async () => {
  // A crash loop: each poll finds a new process — the unit's own main pid each time (systemd restarted it), so the
  // first sample passes (pid = MainPID) and the second fails on the changed pid, before asking systemd again. The
  // events before the rollback's restart pin that order.
  const watch = (running: (n: number) => number, mainPid: (n: number) => number) => {
    let n = 0;
    const events: string[] = [];
    const d = makeDeps({
      running: () => (events.push(`status ${running(n)}`), { version: packageVersion(d.app) ?? '', pid: running(n) }),
      mainPid: () => (events.push(`show ${mainPid(n)}`), mainPid(n)),
      onExec: (_c, args) => ((args[1] === 'reset-failed' || args[1] === 'restart') && events.push(args[1] as string), undefined),
    });
    const tick = d.deps.sleep;
    d.deps.sleep = async (ms) => (n++, tick(ms));
    return { ...d, before: () => events.slice(0, events.indexOf('reset-failed')) };
  };
  const loop = watch((n) => 5000 + n, (n) => 5000 + n);
  assert.equal(await runUpdate(loop.deps), 1);
  assert.equal(fs.readFileSync(path.join(loop.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.deepEqual(loop.before(), ['status 5000', 'show 5000', 'status 5001', 'status 5001'], 'sample, its MainPID; the changed pid; the answer check before the rollback');
  // The pid stays but the unit's MainPID moves (the unit was restarted under a process that still answers): the second
  // MainPID query is what fails.
  const moved = watch(() => 5000, (n) => 5000 + n);
  assert.equal(await runUpdate(moved.deps), 1);
  assert.equal(fs.readFileSync(path.join(moved.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.deepEqual(moved.before(), ['status 5000', 'show 5000', 'status 5000', 'show 5001', 'status 5000']);
  assert.match(loop.out.join('\n'), /installer reported success, but the bridge is not steadily running 0\.2\.0 \(a crash loop, another process answering, or a unit stopped meanwhile\)/);
  assert.match(loop.out.join('\n'), /bridge answers but does not stay up on 0\.2\.0: putting 0\.1\.0 back/);
  const silent = makeDeps({ up: false });
  assert.equal(await runUpdate(silent.deps), 1);
  assert.equal(fs.readFileSync(path.join(silent.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.match(silent.out.join('\n'), /bridge is not answering: putting 0\.1\.0 back/);
  assert.ok(silent.clock() - 1_000_000 >= ANSWER_WAIT_MS);
  // Answers with the new version but not from the unit's main pid (a hand-started serve, another unit): not steady.
  const foreign = makeDeps({ mainPid: () => 9999 });
  assert.equal(await runUpdate(foreign.deps), 1);
  assert.equal(fs.readFileSync(path.join(foreign.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  assert.match(foreign.out.join('\n'), /did not come back either/, 'the restored copy is not the unit\'s process either');
  // No pid in the answer at all: not steady.
  const { pid: _p, ...noPid } = STATUS;
  const pidless = makeDeps();
  pidless.deps.status = async () => ({ ...noPid, version: packageVersion(pidless.app) ?? '' });
  assert.equal(await runUpdate(pidless.deps), 1);
  assert.equal(fs.readFileSync(path.join(pidless.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
});

test('a run stopped half-way is finished by the next one, without asking GitHub again', async () => {
  // Stopped after the swap; the new daemon is up: done.
  const done = makeDeps();
  swapTo(done.app, '0.2.0');
  fs.writeFileSync(pendingFile(done.home), JSON.stringify({ from: '0.1.0', to: '0.2.0', started: '2026-09-18T01:00:00.000Z' }));
  assert.equal(await runUpdate(done.deps), 0);
  assert.equal(done.calls.some((c) => c.startsWith('latest ')), false, 'no request: the pending record says what to check');
  assert.match(done.out.join('\n'), /an update 0\.1\.0 → 0\.2\.0 started 2026-09-18T01:00:00\.000Z did not finish/);
  assert.match(done.out.join('\n'), /^remotly-bridge 0\.2\.0 is running$/m);
  clean(done.home);
  // Stopped before the swap: nothing to undo; the record goes, the next run starts over.
  const early = makeDeps();
  fs.writeFileSync(pendingFile(early.home), JSON.stringify({ from: '0.1.0', to: '0.2.0', started: '2026-09-18T01:00:00.000Z' }));
  assert.equal(await runUpdate(early.deps), 1);
  assert.match(early.out.join('\n'), /the bridge is not steadily running 0\.2\.0/);
  assert.match(early.out.join('\n'), /files were not replaced \(0\.1\.0 on disk\)/);
  clean(early.home);
  // Stopped after the swap, the daemon down: the previous copy goes back.
  let restarted = false;
  const broken = makeDeps({ up: () => restarted, onExec: (cmd, args) => ((restarted ||= cmd === 'systemctl' && args[1] === 'restart'), undefined) });
  swapTo(broken.app, '0.2.0');
  fs.writeFileSync(pendingFile(broken.home), JSON.stringify({ from: '0.1.0', to: '0.2.0', started: '2026-09-18T01:00:00.000Z' }));
  assert.equal(await runUpdate(broken.deps), 1);
  assert.equal(fs.readFileSync(path.join(broken.app, 'src', 'main.ts'), 'utf8'), '// main 0.1.0');
  clean(broken.home);
  // An unreadable record is ignored (a run that starts over does not stay stuck on it).
  const junk = makeDeps({ latest: TAG('0.1.0') });
  fs.writeFileSync(pendingFile(junk.home), '{"from":1}');
  assert.equal(await runUpdate(junk.deps), 0);
  assert.deepEqual(junk.calls, [`latest ${RELEASES_URL}`]);
});

test('no rollback onto a copy that is not the version that ran before: app.prev missing or holding something else', async () => {
  const missing = makeDeps({ installerExit: 1, up: false, unit: 'remotly-dev' });
  missing.deps.runInstaller = async () => {
    fs.rmSync(missing.app, { recursive: true });
    writeApp(missing.app, '0.2.0'); // swapped without keeping a previous copy
    return { code: 1, signal: null };
  };
  assert.equal(await runUpdate(missing.deps), 1);
  assert.equal(fs.readFileSync(path.join(missing.app, 'src', 'main.ts'), 'utf8'), '// main 0.2.0', 'nothing moved');
  assert.equal(missing.restarts(), 0);
  assert.match(missing.out.join('\n'), /cannot roll back: .*app\.prev holds no complete copy, not the 0\.1\.0 that ran before — install one by hand:  curl /);
  assert.ok(missing.out.join('\n').includes(`install one by hand:  ${byHand(missing, '0.1.0')}`), missing.out.join('\n'));
  clean(missing.home);
  const other = makeDeps({ installerExit: 1, swap: true, up: false });
  other.deps.runInstaller = async (_s, _a, env) => {
    swapTo(other.app, env['REMOTLY_VERSION'] as string);
    fs.writeFileSync(path.join(`${other.app}.prev`, 'package.json'), '{"version":"0.0.5"}'); // an older leftover, not what ran
    return { code: 1, signal: null };
  };
  assert.equal(await runUpdate(other.deps), 1);
  assert.match(other.out.join('\n'), /cannot roll back: .*app\.prev holds 0\.0\.5, not the 0\.1\.0 that ran before/);
  assert.equal(fs.existsSync(`${other.app}.failed`), false);
  // A package.json with the right version but no code beside it is not a copy to roll back onto.
  const hollow = makeDeps({ installerExit: 1, swap: true, up: false });
  hollow.deps.runInstaller = async (_s, _a, env) => {
    swapTo(hollow.app, env['REMOTLY_VERSION'] as string);
    fs.rmSync(path.join(`${hollow.app}.prev`, 'src'), { recursive: true });
    return { code: 1, signal: null };
  };
  assert.equal(await runUpdate(hollow.deps), 1);
  assert.equal(installedVersion(`${hollow.app}.prev`), null);
  assert.match(hollow.out.join('\n'), /cannot roll back: .*app\.prev holds no complete copy/);
  assert.equal(fs.existsSync(`${hollow.app}.failed`), false);
});

test('rollback whose restart fails, or whose previous copy does not come back either, says so', async () => {
  const failing = makeDeps({ installerExit: 1, swap: true, up: false, onExec: (_c, args) => (args[1] === 'restart' ? { code: 1, stdout: '', stderr: 'Failed to restart remotly-bridge.service: Unit not found.' } : undefined) });
  assert.equal(await runUpdate(failing.deps), 1);
  assert.match(failing.out.join('\n'), /0\.1\.0 is back in .*app but systemctl --user restart remotly-bridge\.service failed: Failed to restart/);
  clean(failing.home);
  const dead = makeDeps({ installerExit: 1, swap: true, up: false });
  assert.equal(await runUpdate(dead.deps), 1);
  assert.match(dead.out.join('\n'), /0\.1\.0 did not come back either — look at the journal/);
  clean(dead.home);
});
