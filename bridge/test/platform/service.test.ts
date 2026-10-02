import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  launchAgentsDir,
  launchdLabel,
  launchdLogPath,
  launchdManager,
  launchdPath,
  launchdUpdateNames,
  parseDisabled,
  parseLaunchctlPrint,
  renderLaunchAgent,
  renderLaunchUpdateAgent,
  renderPlist,
  serviceManagerFor,
  serviceUnitDir,
  systemdManager,
} from '../../src/platform/service.ts';
import type { ExecResult } from '../../src/tailscale.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-service-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code: number | null = 1): ExecResult => ({ code, stdout: '', stderr });
/** Scripted exec, keyed by command line prefix (the longest match answers); unknown commands succeed silently. */
function fakeExec(script: Record<string, ExecResult | ExecResult[]>) {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const hit = Object.keys(script)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) return ok();
    const v = script[hit];
    if (Array.isArray(v)) return v.length > 1 ? (v.shift() as ExecResult) : (v[0] as ExecResult);
    return v as ExecResult;
  };
  return { exec, calls };
}

const PRINT_RUNNING = ok('gui/501/dev.remotly.remotly-bridge = {\n\tactive count = 1\n\tpath = /Users/alice/Library/LaunchAgents/dev.remotly.remotly-bridge.plist\n\tstate = running\n\tprogram = /usr/local/bin/node\n\tpid = 4242\n\tlast exit code = 0\n}\n');
const PRINT_WAITING = ok('gui/501/dev.remotly.remotly-bridge = {\n\tstate = waiting\n\tlast exit code = 1\n}\n');
// A crash loop as `launchctl print` showed one on macOS 26 (KeepAlive, the program exits 3 every time): no pid, a spawn pending, a recorded exit.
const PRINT_CRASHING = ok('gui/501/dev.remotly.remotly-bridge = {\n\tstate = spawn scheduled\n\tprogram = /bin/sh\n\texit timeout = 5\n\truns = 2\n\tlast exit code = 3\n\tspawn type = daemon (3)\n}\n');
// Right after a bootstrap, before the first run.
const PRINT_FIRST_SPAWN = ok('gui/501/dev.remotly.remotly-bridge = {\n\tstate = spawn scheduled\n\tlast exit code = (never exited)\n}\n');
const NOT_LOADED = fail('Could not find service "dev.remotly.remotly-bridge" in domain for user gui: 501', 113);
const EIO = fail('Could not print service: 5: Input/output error', 5);
const DISABLED = ok('disabled services = {\n\t"com.apple.foo" => disabled\n\t"dev.remotly.remotly-bridge-update" => disabled\n\t"com.example.bar" => enabled\n}\n');

const UNIT = { unit: 'remotly-bridge', nodePath: '/usr/local/bin/node', mainPath: '/Users/alice/.local/share/remotly/app/src/main.ts', home: '/Users/alice' };

test('launchd names and paths: a reverse-DNS label per unit, agents under ~/Library/LaunchAgents, logs under ~/Library/Logs/remotly', () => {
  assert.equal(launchdLabel('remotly-bridge'), 'dev.remotly.remotly-bridge');
  assert.equal(launchdLabel('remotly-dev.service'), 'dev.remotly.remotly-dev');
  assert.deepEqual(launchdUpdateNames('remotly-bridge'), { service: 'dev.remotly.remotly-bridge-update', timer: 'dev.remotly.remotly-bridge-update' });
  assert.equal(launchAgentsDir('/Users/alice'), '/Users/alice/Library/LaunchAgents');
  assert.equal(launchdLogPath('/Users/alice', 'dev.remotly.remotly-bridge'), '/Users/alice/Library/Logs/remotly/dev.remotly.remotly-bridge.log');
  assert.match(launchdPath('/Users/alice'), /^\/usr\/local\/bin:\/opt\/homebrew\/bin:\/Users\/alice\/\.local\/bin:.*\/Applications\/Tailscale\.app\/Contents\/MacOS$/);
  assert.equal(serviceUnitDir('darwin', {}, '/Users/alice'), '/Users/alice/Library/LaunchAgents');
  assert.equal(serviceUnitDir('linux', {}, '/home/alice'), '/home/alice/.config/systemd/user');
  assert.equal(serviceUnitDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/alice'), '/x/systemd/user');
  assert.equal(serviceManagerFor('darwin', { exec: async () => ok(), unitDir: '/u', user: 'a', uid: 501, home: '/h' }).kind, 'launchd');
  assert.equal(serviceManagerFor('linux', { exec: async () => ok(), unitDir: '/u', user: 'a', uid: 1000, home: '/h' }).kind, 'systemd');
});

test('renderPlist: typed values, XML escaping, no newline anywhere', () => {
  const text = renderPlist({ Label: 'a&b<c>', N: 7, Yes: true, No: false, List: ['x', 'y'], Dict: { K: 'v' } });
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.match(text, /<key>Label<\/key>\n\s*<string>a&amp;b&lt;c&gt;<\/string>/);
  assert.match(text, /<key>N<\/key>\n\s*<integer>7<\/integer>/);
  assert.match(text, /<key>Yes<\/key>\n\s*<true\/>/);
  assert.match(text, /<key>No<\/key>\n\s*<false\/>/);
  assert.match(text, /<array>\n\s*<string>x<\/string>\n\s*<string>y<\/string>\n\s*<\/array>/);
  assert.match(text, /<key>Dict<\/key>\n\s*<dict>\n\s*<key>K<\/key>\n\s*<string>v<\/string>\n\s*<\/dict>/);
  assert.match(text, /<\/plist>\n$/);
  assert.throws(() => renderPlist({ Label: 'a\nb' }), /newline/);
});

test('renderLaunchAgent: KeepAlive + RunAtLoad (Restart=always), the agent PATH, the bridge environment, file logs, the repair script first', () => {
  const plain = renderLaunchAgent(UNIT);
  assert.match(plain, /<key>Label<\/key>\n\s*<string>dev\.remotly\.remotly-bridge<\/string>/);
  assert.match(plain, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/usr\/local\/bin\/node<\/string>\n\s*<string>\/Users\/alice\/\.local\/share\/remotly\/app\/src\/main\.ts<\/string>\n\s*<string>serve<\/string>\n\s*<\/array>/);
  assert.match(plain, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(plain, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plain, /<key>ThrottleInterval<\/key>\n\s*<integer>5<\/integer>/);
  assert.match(plain, /<key>NODE_ENV<\/key>\n\s*<string>production<\/string>/);
  assert.match(plain, /<key>PATH<\/key>\n\s*<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:/);
  assert.match(plain, /<key>StandardOutPath<\/key>\n\s*<string>\/Users\/alice\/Library\/Logs\/remotly\/dev\.remotly\.remotly-bridge\.log<\/string>/);
  assert.match(plain, /<key>StandardErrorPath<\/key>\n\s*<string>\/Users\/alice\/Library\/Logs\/remotly\/dev\.remotly\.remotly-bridge\.log<\/string>/);
  assert.match(plain, /<key>WorkingDirectory<\/key>\n\s*<string>\/Users\/alice<\/string>/);
  assert.equal(plain.includes('REMOTLY_CONFIG_DIR'), false);
  assert.equal(plain.includes('HERDR_'), false);
  assert.equal(plain.includes('REMOTLY_TAILSCALE'), false);

  const full = renderLaunchAgent({ ...UNIT, configDir: '/Users/alice/cfg', herdrSession: 'work', herdrSocket: '/Users/alice/herdr.sock', tailscale: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', repairScript: '/Users/alice/.local/share/remotly/repair-app.sh' });
  assert.match(full, /<string>\/bin\/sh<\/string>\n\s*<string>-c<\/string>\n\s*<string>\/bin\/sh "\$0"; exec "\$1" "\$2" serve<\/string>\n\s*<string>\/Users\/alice\/\.local\/share\/remotly\/repair-app\.sh<\/string>\n\s*<string>\/usr\/local\/bin\/node<\/string>\n\s*<string>\/Users\/alice\/\.local\/share\/remotly\/app\/src\/main\.ts<\/string>/);
  assert.match(full, /<key>REMOTLY_CONFIG_DIR<\/key>\n\s*<string>\/Users\/alice\/cfg<\/string>/);
  assert.match(full, /<key>HERDR_SESSION<\/key>\n\s*<string>work<\/string>/);
  assert.match(full, /<key>HERDR_SOCKET_PATH<\/key>\n\s*<string>\/Users\/alice\/herdr\.sock<\/string>/);
  assert.match(full, /<key>REMOTLY_TAILSCALE<\/key>\n\s*<string>\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale<\/string>/, 'a tailscale CLI setup was pointed at stays known to the daemon');
});

test('renderLaunchUpdateAgent: one agent that runs `update` daily at a minute past midnight, with the unit name and the installer settings', () => {
  const text = renderLaunchUpdateAgent({ ...UNIT, minute: 17, tailscale: '/opt/ts/tailscale', installerEnv: { REMOTLY_RELEASE_URL: 'https://mirror.example/releases', REMOTLY_NODE: '/usr/local/bin/node' }, repairScript: '/Users/alice/.local/share/remotly/repair-app.sh' });
  assert.match(text, /<key>Label<\/key>\n\s*<string>dev\.remotly\.remotly-bridge-update<\/string>/);
  assert.match(text, /exec "\$1" "\$2" update<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key>\n\s*<false\/>/);
  assert.equal(text.includes('KeepAlive'), false);
  assert.match(text, /<key>StartCalendarInterval<\/key>\n\s*<dict>\n\s*<key>Hour<\/key>\n\s*<integer>0<\/integer>\n\s*<key>Minute<\/key>\n\s*<integer>17<\/integer>\n\s*<\/dict>/);
  assert.match(text, /<key>REMOTLY_SYSTEMD_UNIT<\/key>\n\s*<string>remotly-bridge<\/string>/);
  assert.match(text, /<key>REMOTLY_RELEASE_URL<\/key>\n\s*<string>https:\/\/mirror\.example\/releases<\/string>/);
  assert.match(text, /<key>REMOTLY_NODE<\/key>\n\s*<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(text, /<key>REMOTLY_TAILSCALE<\/key>\n\s*<string>\/opt\/ts\/tailscale<\/string>/);
  // Without a minute given, one is picked per render (the install's own, so every Mac does not hit GitHub at 00:00).
  const m = Number(/<key>Minute<\/key>\n\s*<integer>(\d+)<\/integer>/.exec(renderLaunchUpdateAgent(UNIT))?.[1]);
  assert.ok(Number.isInteger(m) && m >= 0 && m < 60, `minute ${m}`);
});

test('parseLaunchctlPrint and parseDisabled read what launchctl prints', () => {
  assert.deepEqual(parseLaunchctlPrint(PRINT_RUNNING.stdout), { state: 'running', pid: 4242, lastExit: 0 });
  assert.deepEqual(parseLaunchctlPrint(PRINT_WAITING.stdout), { state: 'waiting', pid: 0, lastExit: 1 });
  assert.deepEqual(parseLaunchctlPrint(PRINT_CRASHING.stdout), { state: 'spawn scheduled', pid: 0, lastExit: 3 }, 'a two-word state, and the exit launchd recorded');
  assert.deepEqual(parseLaunchctlPrint(PRINT_FIRST_SPAWN.stdout), { state: 'spawn scheduled', pid: 0, lastExit: null }, '(never exited) is no exit');
  assert.deepEqual(parseLaunchctlPrint(''), { state: '', pid: 0, lastExit: null });
  assert.deepEqual([...parseDisabled(DISABLED.stdout)], ['com.apple.foo', 'dev.remotly.remotly-bridge-update']);
  assert.deepEqual([...parseDisabled('')], []);
});

test('launchdManager: state and pid from `launchctl print`; not loaded with a plist is inactive, without one not-found; launchctl missing is no verdict', async () => {
  const unitDir = path.join(dir, 'LaunchAgents');
  fs.mkdirSync(unitDir, { recursive: true });
  const { exec, calls } = fakeExec({ 'launchctl print gui/501/dev.remotly.remotly-bridge': [PRINT_RUNNING, PRINT_WAITING, PRINT_CRASHING, PRINT_FIRST_SPAWN, NOT_LOADED, NOT_LOADED, EIO, fail('spawn launchctl ENOENT', null)] });
  const sm = launchdManager({ exec, unitDir, user: 'alice', uid: 501, home: dir });
  assert.equal(sm.name, 'launchd');
  assert.equal(sm.noun, 'launchd agent');
  assert.equal(sm.unitName('remotly-bridge'), 'dev.remotly.remotly-bridge');
  assert.equal(sm.unitPath('remotly-bridge'), path.join(unitDir, 'dev.remotly.remotly-bridge.plist'));
  assert.deepEqual(sm.updatePaths('remotly-bridge'), { service: path.join(unitDir, 'dev.remotly.remotly-bridge-update.plist'), timer: path.join(unitDir, 'dev.remotly.remotly-bridge-update.plist') });
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'active', sub: 'running', pid: 4242 });
  // launchd has no start-rate limit: a crash loop stays "between spawns" forever, so after a recorded exit that is the settled, restartable state (systemd's `failed`).
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'failed', sub: 'waiting, last exit code 1', pid: 0 }, 'between KeepAlive spawns after an exit: a crash loop');
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'failed', sub: 'spawn scheduled, last exit code 3', pid: 0 });
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'activating', sub: 'spawn scheduled', pid: 0 }, 'the first spawn on its way: not settled');
  fs.writeFileSync(sm.unitPath('remotly-bridge'), 'plist');
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'inactive', sub: 'not loaded', pid: 0 }, 'booted out but the plist is there: an operator stop');
  fs.rmSync(sm.unitPath('remotly-bridge'));
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'not-found', active: 'inactive', sub: 'dead', pid: 0 });
  assert.equal(await sm.state('remotly-bridge'), null, 'a failure that is not "Could not find service" (EIO in a teardown, a domain gone): no verdict, never "stopped"');
  assert.equal(await sm.state('remotly-bridge'), null);
  assert.deepEqual(calls, Array(8).fill('launchctl print gui/501/dev.remotly.remotly-bridge'));
});

test('launchdManager: activeState, mainPid, restart (bootout then bootstrap), sessionCheck, persistence', async () => {
  const unitDir = path.join(dir, 'LaunchAgents');
  const { exec, calls } = fakeExec({
    'launchctl print gui/501/dev.remotly.remotly-bridge': [PRINT_RUNNING, PRINT_WAITING, NOT_LOADED, fail('spawn launchctl ENOENT', null), EIO, PRINT_RUNNING, NOT_LOADED, EIO],
    'launchctl print gui/501 ': ok(''),
    'launchctl print-disabled gui/501': DISABLED,
  });
  const sm = launchdManager({ exec, unitDir, user: 'alice', uid: 501, home: dir, sleep: async () => undefined });
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: 'active', asked: 'launchctl print gui/501/dev.remotly.remotly-bridge', said: 'running' });
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: 'failed', asked: 'launchctl print gui/501/dev.remotly.remotly-bridge', said: 'waiting, last exit code 1' });
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: 'inactive', asked: 'launchctl print gui/501/dev.remotly.remotly-bridge', said: 'not loaded' });
  assert.equal((await sm.activeState('remotly-bridge')).state, null, 'no launchctl: no verdict');
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: null, asked: 'launchctl print gui/501/dev.remotly.remotly-bridge', said: 'Could not print service: 5: Input/output error' }, 'another failure: no verdict, with its words');
  assert.equal(await sm.mainPid('remotly-bridge'), 4242);
  assert.equal(await sm.mainPid('remotly-bridge'), 0, 'not loaded: no process');
  assert.equal(await sm.mainPid('remotly-bridge'), null, 'another failure: no verdict');
  calls.length = 0;
  const logs = path.join(dir, 'Library', 'Logs', 'remotly');
  assert.equal(fs.existsSync(logs), false);
  await sm.restart('remotly-bridge');
  assert.deepEqual(calls, ['launchctl bootout gui/501/dev.remotly.remotly-bridge', 'launchctl print gui/501/dev.remotly.remotly-bridge', `launchctl bootstrap gui/501 ${path.join(unitDir, 'dev.remotly.remotly-bridge.plist')}`]);
  assert.ok(fs.statSync(logs).isDirectory(), 'the directory the agent logs to is made before the bootstrap (a clean account has none)');
  assert.equal(fs.statSync(logs).mode & 0o077, 0, 'private');
  calls.length = 0;
  await sm.enable('remotly-bridge');
  assert.deepEqual(calls, ['launchctl enable gui/501/dev.remotly.remotly-bridge']);
  assert.deepEqual(await sm.sessionCheck(), { ok: true, note: 'launchd (gui/501)' });
  assert.deepEqual(await sm.persistenceCheck('remotly-bridge'), { ok: true, message: 'launchd user agent: starts when you log in to this Mac (after a reboot, log in once, or turn on automatic login)' });
  assert.deepEqual(await sm.persistenceCheck('remotly-bridge-update'), { ok: false, message: 'agent dev.remotly.remotly-bridge-update is disabled: launchd does not start it at login', fix: 'launchctl enable gui/501/dev.remotly.remotly-bridge-update' });
  assert.match((await sm.persistence())[0]!, /✔ starts when you log in to this Mac/);

  const noSession = launchdManager({ exec: fakeExec({ 'launchctl print gui/501': fail('Could not find domain for gui/501', 125) }).exec, unitDir, user: 'alice', uid: 501, home: dir });
  const r = await noSession.sessionCheck();
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.problem, /no launchd session for alice \(gui\/501\)/);
  const notMac = launchdManager({ exec: fakeExec({ 'launchctl print gui/501': fail('spawn launchctl ENOENT', null) }).exec, unitDir, user: 'alice', uid: 501, home: dir });
  assert.match(JSON.stringify(await notMac.sessionCheck()), /launchctl not found/);
});

test('launchdManager: the update agent is the timer — enabled/disabled from print-disabled, not-found without its plist, unreadable when launchctl does not answer; enable/disable/restart in launchctl terms', async () => {
  const unitDir = path.join(dir, 'LaunchAgents');
  fs.mkdirSync(unitDir, { recursive: true });
  const { exec, calls } = fakeExec({ 'launchctl print-disabled gui/501': [DISABLED, ok('disabled services = {\n}\n'), fail('Bad request', 1)], 'launchctl print gui/501/dev.remotly.remotly-bridge-update': NOT_LOADED });
  const sm = launchdManager({ exec, unitDir, user: 'alice', uid: 501, home: dir, sleep: async () => undefined });
  assert.deepEqual(await sm.timerState('remotly-bridge'), { state: 'not-found' });
  fs.writeFileSync(sm.updatePaths('remotly-bridge').timer, 'plist');
  assert.deepEqual(await sm.timerState('remotly-bridge'), { state: 'disabled' });
  assert.deepEqual(await sm.timerState('remotly-bridge'), { state: 'enabled' });
  assert.deepEqual(await sm.timerState('remotly-bridge'), { state: '', unreadable: 'launchctl print-disabled gui/501 did not answer' });
  calls.length = 0;
  await sm.enableTimer('remotly-bridge');
  await sm.disableTimerNow('remotly-bridge');
  await sm.restartTimer('remotly-bridge');
  const plist = path.join(unitDir, 'dev.remotly.remotly-bridge-update.plist');
  assert.deepEqual(calls, [
    'launchctl enable gui/501/dev.remotly.remotly-bridge-update',
    'launchctl bootout gui/501/dev.remotly.remotly-bridge-update',
    'launchctl disable gui/501/dev.remotly.remotly-bridge-update',
    'launchctl bootout gui/501/dev.remotly.remotly-bridge-update',
    'launchctl print gui/501/dev.remotly.remotly-bridge-update',
    `launchctl bootstrap gui/501 ${plist}`,
  ]);
  const h = sm.hints;
  assert.equal(h.status('remotly-bridge'), 'launchctl print gui/501/dev.remotly.remotly-bridge');
  assert.equal(h.query('remotly-bridge'), 'launchctl print gui/501/dev.remotly.remotly-bridge');
  assert.equal(h.start('remotly-bridge'), `launchctl bootstrap gui/501 ${path.join(unitDir, 'dev.remotly.remotly-bridge.plist')}`);
  assert.equal(h.stop('remotly-bridge'), 'launchctl bootout gui/501/dev.remotly.remotly-bridge');
  assert.equal(h.restart('remotly-bridge'), 'launchctl kickstart -k gui/501/dev.remotly.remotly-bridge');
  assert.equal(h.logs('remotly-bridge', 30), `tail -n 30 ${path.join(dir, 'Library', 'Logs', 'remotly', 'dev.remotly.remotly-bridge.log')}`);
  assert.equal(h.updateLogs('remotly-bridge', 50), `tail -n 50 ${path.join(dir, 'Library', 'Logs', 'remotly', 'dev.remotly.remotly-bridge-update.log')}`);
  assert.equal(h.cat('remotly-bridge'), `cat ${path.join(unitDir, 'dev.remotly.remotly-bridge.plist')}`);
  assert.equal(h.unmask(['dev.remotly.remotly-bridge']), 'launchctl enable gui/501/dev.remotly.remotly-bridge');
  assert.equal(h.enableTimer('remotly-bridge'), `launchctl enable gui/501/dev.remotly.remotly-bridge-update && launchctl bootstrap gui/501 ${plist}`);
  assert.equal(h.disableTimer('remotly-bridge'), 'launchctl bootout gui/501/dev.remotly.remotly-bridge-update; launchctl disable gui/501/dev.remotly.remotly-bridge-update');
  assert.equal(h.startTimer('remotly-bridge'), `launchctl bootstrap gui/501 ${plist}`);
  // The log tail is the file launchd writes (no journal).
  assert.deepEqual(await sm.logTail('remotly-bridge', 2), [`(no log yet: ENOENT: no such file or directory, open '${path.join(dir, 'Library', 'Logs', 'remotly', 'dev.remotly.remotly-bridge.log')}')`]);
  fs.mkdirSync(path.join(dir, 'Library', 'Logs', 'remotly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Library', 'Logs', 'remotly', 'dev.remotly.remotly-bridge.log'), 'one\ntwo\nthree\n');
  assert.deepEqual(await sm.logTail('remotly-bridge', 2), ['two', 'three']);
});

test('systemdManager: the update-path methods use the same systemctl calls as before', async () => {
  const { exec, calls } = fakeExec({
    'systemctl --user is-active remotly-bridge.service': [ok('active\n'), ok('inactive\n'), fail('Failed to connect to bus', 1), fail('', 4), fail('spawn systemctl ENOENT', null)],
    'systemctl --user show -p MainPID --value remotly-bridge.service': [ok('4242\n'), ok('0\n'), fail('no bus', 1)],
    'loginctl show-user alice -p Linger --value': [ok('yes\n'), ok('no\n')],
  });
  const sm = systemdManager({ exec, unitDir: '/home/alice/.config/systemd/user', user: 'alice', uid: 1000, home: '/home/alice' });
  assert.equal(sm.name, 'systemd');
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: 'active', asked: 'systemctl --user is-active remotly-bridge.service', said: 'active' });
  assert.equal((await sm.activeState('remotly-bridge')).state, 'inactive');
  assert.deepEqual(await sm.activeState('remotly-bridge'), { state: null, asked: 'systemctl --user is-active remotly-bridge.service', said: 'Failed to connect to bus' });
  assert.equal((await sm.activeState('remotly-bridge')).said, 'exit 4, no output');
  assert.equal((await sm.activeState('remotly-bridge')).said, 'spawn systemctl ENOENT');
  assert.equal(await sm.mainPid('remotly-bridge'), 4242);
  assert.equal(await sm.mainPid('remotly-bridge'), 0);
  assert.equal(await sm.mainPid('remotly-bridge'), null);
  assert.deepEqual(await sm.persistenceCheck('remotly-bridge'), { ok: true, message: 'linger on: the unit starts at boot and survives logout' });
  assert.deepEqual(await sm.persistenceCheck('remotly-bridge'), { ok: false, message: 'linger off: the bridge stops when you log out', fix: 'sudo loginctl enable-linger alice' });
  calls.length = 0;
  await sm.resetAndRestart('remotly-bridge');
  assert.deepEqual(calls, ['systemctl --user reset-failed remotly-bridge.service', 'systemctl --user restart remotly-bridge.service']);
  assert.equal(sm.hints.query('remotly-bridge'), 'systemctl --user show');
  assert.equal(sm.unitPath('remotly-bridge'), '/home/alice/.config/systemd/user/remotly-bridge.service');
});

test('launchdManager.restart: waits for launchd to forget the service after bootout, and retries a bootstrap that hits EIO (the teardown window)', async () => {
  const unitDir = path.join(dir, 'LaunchAgents');
  const slept: number[] = [];
  const { exec, calls } = fakeExec({
    'launchctl print gui/501/dev.remotly.remotly-bridge': [PRINT_RUNNING, PRINT_RUNNING, NOT_LOADED],
    'launchctl bootstrap gui/501': [fail('Bootstrap failed: 5: Input/output error', 5), fail('Bootstrap failed: 5: Input/output error', 5), ok()],
  });
  const sm = launchdManager({ exec, unitDir, user: 'alice', uid: 501, home: dir, sleep: async (ms) => void slept.push(ms) });
  const logs = path.join(dir, 'Library', 'Logs', 'remotly');
  fs.mkdirSync(logs, { recursive: true });
  fs.chmodSync(logs, 0o744); // as one launchd made it
  const r = await sm.restart('remotly-bridge');
  assert.equal(r.code, 0);
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700, 'a log directory that was there already is made private too');
  const plist = path.join(unitDir, 'dev.remotly.remotly-bridge.plist');
  assert.deepEqual(calls, [
    'launchctl bootout gui/501/dev.remotly.remotly-bridge',
    'launchctl print gui/501/dev.remotly.remotly-bridge', // still there
    'launchctl print gui/501/dev.remotly.remotly-bridge', // still there
    'launchctl print gui/501/dev.remotly.remotly-bridge', // gone
    `launchctl bootstrap gui/501 ${plist}`, // EIO
    `launchctl bootstrap gui/501 ${plist}`, // EIO
    `launchctl bootstrap gui/501 ${plist}`, // ok
  ]);
  assert.deepEqual(slept, [250, 250, 500, 500]);

  // A service that never goes away (40 looks) and a bootstrap that keeps failing (11 tries): bounded, and the failure is reported.
  const stuck = fakeExec({ 'launchctl print gui/501/dev.remotly.remotly-bridge': PRINT_RUNNING, 'launchctl bootstrap gui/501': fail('Bootstrap failed: 5: Input/output error', 5) });
  const r2 = await launchdManager({ exec: stuck.exec, unitDir, user: 'alice', uid: 501, home: dir, sleep: async () => undefined }).restart('remotly-bridge');
  assert.equal(r2.code, 5);
  assert.equal(stuck.calls.filter((c) => c.startsWith('launchctl print')).length, 40);
  assert.equal(stuck.calls.filter((c) => c.startsWith('launchctl bootstrap')).length, 11);
});
