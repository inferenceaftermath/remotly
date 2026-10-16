import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  HERDR_ENV_PREFIX,
  HERDR_UNIT_MARKER,
  herdrCommand,
  herdrServerArgs,
  herdrUnit,
  launchAgentsDir,
  launchdLabel,
  launchdLogPath,
  launchdManager,
  launchdPath,
  launchdUpdateNames,
  parseDisabled,
  parseLaunchctlPrint,
  renderLaunchAgent,
  renderLaunchHerdrAgent,
  renderLaunchUpdateAgent,
  renderPlist,
  renderSystemdHerdrUnit,
  serviceManagerFor,
  serviceUnitDir,
  systemdManager,
  herdrConfigHome,
  systemctlWords,
  xmlPlistLabel,
  xmlPlistRoot,
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
  assert.deepEqual(parseLaunchctlPrint(PRINT_RUNNING.stdout), { state: 'running', pid: 4242, lastExit: 0, path: '/Users/alice/Library/LaunchAgents/dev.remotly.remotly-bridge.plist', program: '/usr/local/bin/node' });
  assert.deepEqual(parseLaunchctlPrint(PRINT_WAITING.stdout), { state: 'waiting', pid: 0, lastExit: 1 });
  assert.deepEqual(parseLaunchctlPrint(PRINT_CRASHING.stdout), { state: 'spawn scheduled', pid: 0, lastExit: 3, program: '/bin/sh' }, 'a two-word state, and the exit launchd recorded');
  // The arguments block: one per line, as launchd spawned the process — spaces inside an argument intact.
  assert.deepEqual(parseLaunchctlPrint('gui/501/dev.remotly.remotly-bridge-herdr = {\n\tstate = running\n\tprogram = /opt/homebrew/bin/herdr\n\targuments = {\n\t\t/opt/homebrew/bin/herdr\n\t\t--session\n\t\twork 2\n\t\tserver\n\t}\n\tpid = 777\n}\n'), {
    state: 'running',
    pid: 777,
    lastExit: null,
    args: ['/opt/homebrew/bin/herdr', '--session', 'work 2', 'server'],
    program: '/opt/homebrew/bin/herdr',
  });
  assert.deepEqual(parseLaunchctlPrint(PRINT_FIRST_SPAWN.stdout), { state: 'spawn scheduled', pid: 0, lastExit: null }, '(never exited) is no exit');
  assert.deepEqual(parseLaunchctlPrint(''), { state: '', pid: 0, lastExit: null });
  assert.deepEqual([...parseDisabled(DISABLED.stdout)], ['com.apple.foo', 'dev.remotly.remotly-bridge-update']);
  assert.deepEqual([...parseDisabled('disabled services = {\n\t"com.apple.foo" => true\n\t"dev.remotly.remotly-bridge-herdr" => true\n\t"com.example.bar" => false\n}\n')], ['com.apple.foo', 'dev.remotly.remotly-bridge-herdr'], 'the older wording: true is disabled, false enabled');
  assert.deepEqual([...parseDisabled('disabled services = {\n\t"dev.remotly.trueish" => enabled\n\t"dev.remotly.other" => disabledness\n}\n')], [], 'a word that only begins so is not read');
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
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'active', sub: 'running', pid: 4242, program: '/usr/local/bin/node' });
  // launchd has no start-rate limit: a crash loop stays "between spawns" forever, so after a recorded exit that is the settled, restartable state (systemd's `failed`).
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'failed', sub: 'waiting, last exit code 1', pid: 0 }, 'between KeepAlive spawns after an exit: a crash loop');
  assert.deepEqual(await sm.state('remotly-bridge'), { load: 'loaded', active: 'failed', sub: 'spawn scheduled, last exit code 3', pid: 0, program: '/bin/sh' });
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

// ---- the herdr service ---------------------------------------------------------------------------

test('herdr service: named <unit>-herdr beside the bridge\'s; systemd runs `herdr [--session X] server` with the paths quoted, Restart=always, wanted by default.target; launchd the same argv with KeepAlive, the agent PATH and file logs', () => {
  assert.equal(herdrUnit('remotly-bridge'), 'remotly-bridge-herdr');
  assert.equal(herdrUnit('remotly-dev.service'), 'remotly-dev-herdr');
  assert.deepEqual(herdrServerArgs(undefined), ['server']);
  assert.deepEqual(herdrServerArgs('work'), ['--session', 'work', 'server']);
  assert.deepEqual(herdrCommand('/usr/local/bin/herdr', 'work', '/home/alice/.config'), ['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME=/home/alice/.config', '/usr/local/bin/herdr', '--session', 'work', 'server'], 'env -u: the manager\'s environment cannot move herdr off the session the arguments name');
  assert.deepEqual(HERDR_ENV_PREFIX, ['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH']);
  assert.equal(herdrConfigHome('/home/alice'), '/home/alice/.config');
  assert.deepEqual(herdrCommand('/usr/local/bin/herdr', undefined, '/home/alice/.config').slice(5), ['XDG_CONFIG_HOME=/home/alice/.config', '/usr/local/bin/herdr', 'server'], 'the directory pinned after the two -u, then herdr\'s own arguments');
  const unit = renderSystemdHerdrUnit({ unit: 'remotly-bridge', herdrPath: '/home/alice/.local/bin/herdr', configHome: '/home/alice/.config' });
  assert.match(unit, /^# written by remotly-bridge setup: rewritten by every setup, so edits do not last \(opt out: remotly-bridge setup --no-herdr-service\)\n\[Unit\]\n/, 'the marker line setup reads back before it touches a unit under its name');
  assert.ok(unit.includes(HERDR_UNIT_MARKER));
  assert.match(unit, /^Description=herdr server for Remotly \(remotly-bridge\)$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=\/home\/alice\/\.config" "\/home\/alice\/\.local\/bin\/herdr" server$/m);
  assert.match(unit, /^Restart=always$/m, 'a crash and a `herdr server stop` both come back; the lasting stop is the unit\'s');
  assert.match(unit, /^RestartSec=2$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(unit.includes('After='), false, 'no ordering against the bridge: it reconnects to herdr by itself');
  assert.equal(unit.includes('Environment='), false, 'the panes get their environment from the shells herdr starts, not from the unit');
  const named = renderSystemdHerdrUnit({ unit: 'remotly-dev', herdrPath: '/opt/my tools/herdr', session: 'work 2', configHome: '/home/alice/.config' });
  assert.match(named, /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=\/home\/alice\/\.config" "\/opt\/my tools\/herdr" --session "work 2" server$/m);
  assert.match(renderSystemdHerdrUnit({ unit: 'u', herdrPath: '/opt/100%/herdr', configHome: '/home/alice/.config' }), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=\/home\/alice\/\.config" "\/opt\/100%%\/herdr" server$/m, '% is a specifier to systemd');
  assert.throws(() => renderSystemdHerdrUnit({ unit: 'u', herdrPath: '/bin/herdr', session: 'a"b', configHome: '/home/alice/.config' }), /cannot put/);
  assert.match(renderSystemdHerdrUnit({ unit: 'u', herdrPath: '/bin/herdr', configHome: '/Users/a b/.config' }), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=\/Users\/a b\/\.config" "\/bin\/herdr" server$/m, 'the directory quoted as one word');

  const plist = renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', session: 'work', home: '/Users/alice', configHome: '/Users/alice/.config' });
  assert.match(plist, /^<\?xml[^\n]*\n<!DOCTYPE[^\n]*\n<plist version="1\.0">\n<!-- written by remotly-bridge setup: rewritten by every setup, so edits do not last -->\n<dict>\n/, 'the marker as an XML comment (no "--" inside: not XML), after the root element');
  assert.ok(plist.includes(HERDR_UNIT_MARKER));
  assert.match(plist, /<key>Label<\/key>\n\s*<string>dev\.remotly\.remotly-bridge-herdr<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/usr\/bin\/env<\/string>\n\s*<string>-u<\/string>\n\s*<string>HERDR_SESSION<\/string>\n\s*<string>-u<\/string>\n\s*<string>HERDR_SOCKET_PATH<\/string>\n\s*<string>XDG_CONFIG_HOME=\/Users\/alice\/\.config<\/string>\n\s*<string>\/opt\/homebrew\/bin\/herdr<\/string>\n\s*<string>--session<\/string>\n\s*<string>work<\/string>\n\s*<string>server<\/string>\n\s*<\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n\s*<integer>5<\/integer>/);
  assert.match(plist, /<key>PATH<\/key>\n\s*<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/Users\/alice\/\.local\/bin:/);
  assert.match(plist, /<key>StandardOutPath<\/key>\n\s*<string>\/Users\/alice\/Library\/Logs\/remotly\/dev\.remotly\.remotly-bridge-herdr\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\n\s*<string>\/Users\/alice\/Library\/Logs\/remotly\/dev\.remotly\.remotly-bridge-herdr\.log<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\n\s*<string>\/Users\/alice<\/string>/);
  assert.match(renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }), /<string>\/usr\/local\/bin\/herdr<\/string>\n\s*<string>server<\/string>\n\s*<\/array>/, 'the default session: no --session');
});

test('source: where the manager has a unit from — systemd\'s FragmentPath and DropInPaths, the plist launchd bootstrapped; null when not loaded or not said', async () => {
  const sd = fakeExec({
    'systemctl --user show -p FragmentPath,DropInPaths remotly-bridge-herdr.service': [
      ok('FragmentPath=/home/alice/.config/systemd/user/remotly-bridge-herdr.service\nDropInPaths=/home/alice/.config/systemd/user/remotly-bridge-.service.d/90-other.conf /etc/systemd/user/service.d/10-env.conf\n'),
      ok('FragmentPath=/home/alice/.config/systemd/user/remotly-bridge-herdr.service\nDropInPaths="/home/alice/.config/systemd/user/remotly-bridge-.service.d/90 foreign.conf" /etc/systemd/user/service.d/10-env.conf\n'),
      ok('FragmentPath=/home/alice/.config/systemd/user/remotly-bridge-herdr.service\nDropInPaths="/home/alice/.config/systemd/user/unclosed.conf\n'),
      ok('FragmentPath=\nDropInPaths=\n'),
      ok(''),
      fail('Failed to connect to bus', 1),
    ],
  });
  const sm = systemdManager({ exec: sd.exec, unitDir: '/home/alice/.config/systemd/user', user: 'alice', uid: 1000, home: '/home/alice' });
  assert.deepEqual(await sm.source('remotly-bridge-herdr'), { path: '/home/alice/.config/systemd/user/remotly-bridge-herdr.service', dropIns: ['/home/alice/.config/systemd/user/remotly-bridge-.service.d/90-other.conf', '/etc/systemd/user/service.d/10-env.conf'] });
  assert.deepEqual(await sm.source('remotly-bridge-herdr'), { path: '/home/alice/.config/systemd/user/remotly-bridge-herdr.service', dropIns: ['/home/alice/.config/systemd/user/remotly-bridge-.service.d/90 foreign.conf', '/etc/systemd/user/service.d/10-env.conf'] }, 'a path with a space, as systemctl quotes it');
  assert.deepEqual(await sm.source('remotly-bridge-herdr'), { path: '/home/alice/.config/systemd/user/remotly-bridge-herdr.service', dropIns: ['"/home/alice/.config/systemd/user/unclosed.conf'] }, 'a list that does not parse: one path nobody can read');
  assert.deepEqual(await sm.source('remotly-bridge-herdr'), { path: null, dropIns: [] }, 'not loaded: empty properties');
  assert.equal(await sm.source('remotly-bridge-herdr'), null, 'nothing said');
  assert.equal(await sm.source('remotly-bridge-herdr'), null);

  const label = 'dev.remotly.remotly-bridge-herdr';
  const ld = fakeExec({ [`launchctl print gui/501/${label}`]: [ok(`gui/501/${label} = {\n\tpath = /Users/alice/elsewhere/${label}.plist\n\tstate = running\n\tpid = 7\n}\n`), ok(`gui/501/${label} = {\n\tstate = running\n}\n`), fail(`Could not find service "${label}" in domain for user gui: 501`, 113)] });
  const lm = launchdManager({ exec: ld.exec, unitDir: '/Users/alice/Library/LaunchAgents', user: 'alice', uid: 501, home: '/Users/alice', sleep: async () => undefined });
  assert.deepEqual(await lm.source('remotly-bridge-herdr'), { path: `/Users/alice/elsewhere/${label}.plist`, dropIns: [] });
  assert.deepEqual(await lm.source('remotly-bridge-herdr'), { path: null, dropIns: [] }, 'no path line: not said');
  assert.equal(await lm.source('remotly-bridge-herdr'), null, 'not loaded');
});

test('systemdManager: the herdr service — enabledState from is-enabled (a mask named, not-found on exit 4 or the older "No such file", anything else unreadable), disable, start, the enable --now hint', async () => {
  const { exec, calls } = fakeExec({
    'systemctl --user is-enabled remotly-bridge-herdr.service': [
      ok('enabled\n'),
      ok('disabled\n'),
      ok('masked-runtime\n'),
      { code: 4, stdout: 'not-found\n', stderr: '' },
      { code: 4, stdout: '', stderr: '' },
      fail('Failed to get unit file state for remotly-bridge-herdr.service: No such file or directory', 1),
      fail('Failed to connect to bus: No medium found', 1),
      fail('spawn systemctl ENOENT', null),
    ],
  });
  const sm = systemdManager({ exec, unitDir: '/home/alice/.config/systemd/user', user: 'alice', uid: 1000, home: '/home/alice' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'enabled' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'disabled' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'masked', masked: ['remotly-bridge-herdr.service'] });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'exit 4 with nothing printed');
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'an older systemd: nothing on stdout, the unit file state it could not get on stderr');
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: '', unreadable: 'systemctl --user is-enabled remotly-bridge-herdr.service: exit 1, Failed to connect to bus: No medium found' }, 'a failed query never passes for "fresh"');
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: '', unreadable: 'systemctl --user is-enabled remotly-bridge-herdr.service: did not run, spawn systemctl ENOENT' });
  calls.length = 0;
  await sm.disable('remotly-bridge-herdr');
  assert.equal((await sm.start('remotly-bridge-herdr')).code, 0);
  assert.deepEqual(calls, ['systemctl --user disable remotly-bridge-herdr.service', 'systemctl --user start remotly-bridge-herdr.service']);
  assert.equal(sm.hints.enableNow('remotly-bridge-herdr'), 'systemctl --user enable --now remotly-bridge-herdr.service');
  assert.equal(sm.hints.enable('remotly-bridge-herdr'), 'systemctl --user enable remotly-bridge-herdr.service');
  assert.equal(sm.hints.disableNow('remotly-bridge-herdr'), 'systemctl --user disable --now remotly-bridge-herdr.service');
  assert.equal(sm.hints.resetAndRestart('remotly-bridge-herdr'), 'systemctl --user reset-failed remotly-bridge-herdr.service; systemctl --user restart remotly-bridge-herdr.service');
  assert.equal(sm.hints.enableRestart('remotly-bridge-herdr'), 'systemctl --user enable remotly-bridge-herdr.service; systemctl --user restart remotly-bridge-herdr.service', 'enable --now would leave an active unit running what it runs');
  assert.equal(sm.hints.nativeStop(['herdr.service']), 'systemctl --user stop herdr.service', 'a unit of the user\'s own, by its name');
  assert.equal(sm.hints.nativeDisable(['herdr.service']), 'systemctl --user disable herdr.service');
  assert.equal(sm.hints.nativeDisableNow(['herdr.service']), 'systemctl --user disable --now herdr.service');
  assert.equal(sm.hints.nativeDisableNow(['herdr.timer', 'herdr.service']), 'systemctl --user disable --now herdr.timer herdr.service', 'the timer that triggers it goes first, in the one command');
  assert.equal(sm.hints.nativeStop(['my\\x20herdr.service']), "systemctl --user stop 'my\\x20herdr.service'", 'a name the shell would mangle is quoted');
  // startsAtBoot: enabled by its own link under unitDir (what a user-level disable removes: no puller) or only under /etc/systemd/user (a global enablement: a puller, said); what requires it is stopped with it; a masked unit starts nowhere.
  const boots = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-boots-'));
  try {
    const unitDir = path.join(boots, 'user');
    const globalDir = path.join(boots, 'etc');
    const show = 'systemctl --user show -p WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo herdr.service';
    const manager = (script: Record<string, ExecResult>) => systemdManager({ exec: fakeExec(script).exec, unitDir, user: 'alice', uid: 1000, home: boots, globalUnitDir: globalDir });
    const enabled = { 'systemctl --user is-enabled herdr.service': ok('enabled\n') };
    fs.mkdirSync(path.join(unitDir, 'default.target.wants'), { recursive: true });
    fs.symlinkSync('/dev/null', path.join(unitDir, 'default.target.wants', 'herdr.service'));
    assert.deepEqual(await manager({ ...enabled, [show]: ok('WantedBy=default.target\nRequiredBy=desk.service\nUpheldBy=\nBoundBy=\nTriggeredBy=herdr.timer\nOnFailureOf=\nOnSuccessOf=\nRequisiteOf=\nConsistsOf=herdr-part.service\nPropagatesStopTo=after.service\n') }).startsAtBoot('herdr.service'), { state: 'enabled', atBoot: true, activators: ['herdr.timer'], pullers: [{ unit: 'desk.service', how: 'requires it' }], stoppedWith: ['desk.service', 'herdr-part.service', 'after.service'] }, 'its own link: default.target is no puller; what requires it, is part of it or is stopped with it is listed');
    fs.rmSync(path.join(unitDir, 'default.target.wants'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'default.target.wants'), { recursive: true });
    fs.symlinkSync('/dev/null', path.join(globalDir, 'default.target.wants', 'herdr.service'));
    assert.deepEqual((await manager({ ...enabled, [show]: ok('WantedBy=default.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=\nPropagatesStopTo=\n') }).startsAtBoot('herdr.service')).pullers, [{ unit: 'default.target', how: `wants it by an enablement under ${globalDir}, which a user-level disable leaves` }], 'a global enablement is a puller a user-level disable does not undo');
    fs.mkdirSync(path.join(unitDir, 'default.target.wants'), { recursive: true });
    fs.symlinkSync('/dev/null', path.join(unitDir, 'default.target.wants', 'herdr.service'));
    assert.deepEqual((await manager({ ...enabled, [show]: ok('WantedBy=default.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=\nPropagatesStopTo=\n') }).startsAtBoot('herdr.service')).pullers, [{ unit: 'default.target', how: `wants it by an enablement under ${globalDir}, which a user-level disable leaves` }], 'a global link beside the local one: the global stays after the disable, so it is said');
    assert.deepEqual(await manager({ 'systemctl --user show -p RequiredBy,BoundBy,RequisiteOf,ConsistsOf,PropagatesStopTo,Conflicts,ConflictedBy herdr.service': ok('RequiredBy=desk.service\nBoundBy=\nRequisiteOf=req.service\nConsistsOf=part.service\nPropagatesStopTo=desk.service\nConflicts=\nConflictedBy=rival.service\n') }).dependents('herdr.service'), { stopped: ['desk.service', 'req.service', 'part.service'], conflicting: ['rival.service'] }, 'dependents: what a stop takes with it (once each), what a start stops');
    assert.deepEqual(await manager({ 'systemctl --user is-enabled herdr.service': { code: 1, stdout: 'masked\n', stderr: '' }, [show]: ok('WantedBy=default.target\nRequiredBy=desk.service\nUpheldBy=\nBoundBy=\nTriggeredBy=herdr.timer\nOnFailureOf=\nOnSuccessOf=\nRequisiteOf=\nConsistsOf=\nPropagatesStopTo=\n') }).startsAtBoot('herdr.service'), { state: 'masked', atBoot: false, activators: [], pullers: [], stoppedWith: ['desk.service'] }, 'masked: starts nowhere, whatever wants or triggers it — but what the manager stops with it (it may still run) counts');
    // A link a user-level disable leaves may be in any persistent load path but the user's own: a vendor's /usr/lib (here: the manager's own UnitPath answer names the directory).
    const vendor = path.join(boots, 'usr-lib');
    fs.rmSync(path.join(globalDir, 'default.target.wants'), { recursive: true });
    fs.mkdirSync(path.join(vendor, 'default.target.wants'), { recursive: true });
    fs.symlinkSync('/dev/null', path.join(vendor, 'default.target.wants', 'herdr.service'));
    assert.deepEqual((await systemdManager({ exec: fakeExec({ ...enabled, 'systemctl --user show -p UnitPath': ok(`UnitPath=${unitDir} ${globalDir} ${vendor}\n`), [show]: ok('WantedBy=default.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nRequisiteOf=\nConsistsOf=\nPropagatesStopTo=\n') }).exec, unitDir, user: 'alice', uid: 1000, home: boots }).startsAtBoot('herdr.service')).pullers, [{ unit: 'default.target', how: `wants it by an enablement under ${vendor}, which a user-level disable leaves` }], 'a link under another persistent load path, beside the local one: said');
    assert.deepEqual(await manager({ 'systemctl --user is-enabled herdr.service': { code: 1, stdout: 'disabled\n', stderr: '' }, [show]: ok('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=\nPropagatesStopTo=\n') }).startsAtBoot('herdr.service'), { state: 'disabled', atBoot: false, activators: [], pullers: [], stoppedWith: [] }, 'disabled, nothing of the user\'s: not at boot');
  } finally {
    fs.rmSync(boots, { recursive: true, force: true });
  }
  assert.equal(sm.unitName('remotly-bridge-herdr'), 'remotly-bridge-herdr.service');
  assert.equal(sm.unitPath('remotly-bridge-herdr'), '/home/alice/.config/systemd/user/remotly-bridge-herdr.service');
  assert.match(sm.renderHerdrUnit({ unit: 'remotly-bridge', herdrPath: '/usr/bin/herdr', configHome: '/home/alice/.config' }), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=\/home\/alice\/\.config" "\/usr\/bin\/herdr" server$/m);
  await assert.rejects(systemdManager({ exec: fakeExec({ 'systemctl --user disable': fail('Access denied', 1) }).exec, unitDir: '/u', user: 'alice', uid: 1000, home: '/h' }).disable('remotly-bridge-herdr'), /disable remotly-bridge-herdr\.service failed/);
});

test('launchdManager: the herdr agent — enabledState like the timer\'s (not-found without its plist, else print-disabled); start kickstarts a loaded agent without -k (a running herdr is left alone) and bootstraps one that is not loaded, no verdict from launchctl is the answer; disable; the enable hint', async () => {
  const unitDir = path.join(dir, 'LaunchAgents');
  fs.mkdirSync(unitDir, { recursive: true });
  const label = 'dev.remotly.remotly-bridge-herdr';
  const plist = path.join(unitDir, `${label}.plist`);
  const { exec, calls } = fakeExec({
    'launchctl print-disabled gui/501': [ok(`disabled services = {\n\t"${label}" => disabled\n}\n`), ok('disabled services = {\n}\n'), fail('Bad request', 1)],
    [`launchctl print gui/501/${label}`]: [ok(`gui/501/${label} = {\n\tstate = running\n\targuments = {\n\t\t/opt/homebrew/bin/herdr\n\t\tserver\n\t}\n\tpid = 777\n}\n`), ok(`gui/501/${label} = {\n\tstate = running\n\tpid = 777\n}\n`), fail(`Could not find service "${label}" in domain for user gui: 501`, 113), EIO],
  });
  const everyone = path.join(dir, 'Library-LaunchAgents'); // stands in for /Library/LaunchAgents (a Mac's holds real plists: the count below is of ours)
  const sm = launchdManager({ exec, unitDir, globalUnitDir: everyone, user: 'alice', uid: 501, home: dir, sleep: async () => undefined });
  assert.equal(sm.unitName('remotly-bridge-herdr'), label);
  assert.equal(sm.unitPath('remotly-bridge-herdr'), plist);
  assert.deepEqual(await sm.state('remotly-bridge-herdr'), { load: 'loaded', active: 'active', sub: 'running', pid: 777, args: ['/opt/homebrew/bin/herdr', 'server'] }, 'the arguments launchd spawned the process with, when print shows them');
  calls.length = 0;
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' });
  // Another plist in the agents directory declaring the label: the label's standing is that file, whatever stands at the canonical path.
  const twin = path.join(unitDir, 'herdr-by-hand.plist');
  fs.writeFileSync(twin, `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>Label</key>\n<string>${label}</string>\n</dict></plist>\n`);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: `defined by ${twin}` });
  fs.writeFileSync(plist, 'plist');
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: `defined by ${twin}` }, 'also with the canonical plist there: two definitions');
  fs.writeFileSync(twin, `<plist version="1.0"><dict><key>Label</key><string>${label}.other</string></dict></plist>\n`);
  fs.rmSync(plist);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'a label that only starts the same is another label');
  // The label is what the plist declares, not how the XML is laid out: a comment between key and value, an entity, CDATA.
  fs.writeFileSync(twin, `<plist version="1.0"><dict>\n<key>Label</key> <!-- the herdr agent -->\n<string>dev.remotly.remotly&#45;bridge-herdr</string>\n</dict></plist>\n`);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: `defined by ${twin}` }, 'a comment and an entity in the way');
  fs.writeFileSync(twin, `<plist version="1.0"><dict><key>Label</key><string><![CDATA[${label}]]></string></dict></plist>\n`);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: `defined by ${twin}` }, 'CDATA');
  // A plist in another layout — nested first: a `Label` inside EnvironmentVariables is not the agent's.
  fs.writeFileSync(twin, `<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>Label</key><string>${label}</string></dict><key>Label</key><string>${label}.other</string></dict></plist>\n`);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'a decoy Label inside a value is not the root dictionary\'s');
  fs.writeFileSync(twin, `<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>Label</key><string>decoy</string></dict><key>Label</key><string>${label}</string></dict></plist>\n`);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: `defined by ${twin}` }, 'the root dictionary\'s Label after a nested one');
  // A binary plist (or any file this cannot read as XML): plutil says what it declares; no answer is no declaration.
  const binary = path.join(unitDir, 'binary.plist');
  fs.writeFileSync(binary, Buffer.from('62706c6973743030d101025f10054c6162656c5f10', 'hex'));
  fs.rmSync(twin);
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'plutil unanswered (the fake says nothing of it)');
  assert.equal(calls.filter((c) => c === `/usr/bin/plutil -extract Label raw -o - ${binary}`).length, 1, 'plutil is asked of every other plist (it reads one as launchd does); unanswered, the text is read as XML here');
  const { exec: exec2, calls: calls2 } = fakeExec({ [`/usr/bin/plutil -extract Label raw -o - ${binary}`]: [ok(`${label}\n`), ok(`${label}.other\n`)], 'launchctl print-disabled gui/501': ok('disabled services = {\n}\n') });
  const sm2 = launchdManager({ exec: exec2, unitDir, globalUnitDir: everyone, user: 'alice', uid: 501, home: dir, sleep: async () => undefined });
  assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: `defined by ${binary}` }, 'a binary plist declaring the label');
  assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'a binary plist declaring another');
  assert.equal(calls2.filter((c) => c.startsWith('/usr/bin/plutil')).length, 2);
  // A plist for every user (/Library/LaunchAgents) declaring the label: launchd loads it at login too; the user's own directory is looked through first.
  fs.mkdirSync(everyone, { recursive: true });
  const shared = path.join(everyone, 'site-herdr.plist');
  fs.writeFileSync(shared, `<plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>\n`);
  assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: `defined by ${shared}` }, 'declared for every user');
  fs.rmSync(shared);
  assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: 'not-found' });
  // A plist this user cannot read (root's, mode 0600 — launchd loads it at login all the same): whether it declares the label is not known, and nothing is vouched for.
  if (process.getuid?.() !== 0) {
    const sealed = path.join(unitDir, 'sealed.plist');
    fs.writeFileSync(sealed, 'whatever', { mode: 0o000 });
    assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: '', unreadable: `${sealed} cannot be read (EACCES): whether it declares the label cannot be told` });
    fs.rmSync(sealed);
  }
  fs.mkdirSync(path.join(unitDir, 'a-directory.plist'));
  assert.deepEqual(await sm2.enabledState('remotly-bridge-herdr'), { state: 'not-found' }, 'a directory by a plist name is nothing launchd loads');
  fs.rmdirSync(path.join(unitDir, 'a-directory.plist'));
  // plutil not running at all (a PATH is not the question: it is asked by its path) leaves the label's standing open: nothing is vouched for.
  const { exec: exec3 } = fakeExec({ [`/usr/bin/plutil -extract Label raw -o - ${binary}`]: fail('spawn /usr/bin/plutil ENOENT', null), 'launchctl print-disabled gui/501': ok('disabled services = {\n}\n') });
  const sm3 = launchdManager({ exec: exec3, unitDir, globalUnitDir: everyone, user: 'alice', uid: 501, home: dir, sleep: async () => undefined });
  assert.deepEqual(await sm3.enabledState('remotly-bridge-herdr'), { state: '', unreadable: '/usr/bin/plutil did not run (spawn /usr/bin/plutil ENOENT): whether another plist declares the label cannot be told' });
  fs.rmSync(binary);
  fs.writeFileSync(plist, 'plist');
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'disabled' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: 'enabled' });
  assert.deepEqual(await sm.enabledState('remotly-bridge-herdr'), { state: '', unreadable: 'launchctl print-disabled gui/501 did not answer' });
  calls.length = 0;
  assert.equal((await sm.start('remotly-bridge-herdr')).code, 0, 'loaded and running: kickstart (a no-op for a running agent)');
  assert.equal((await sm.start('remotly-bridge-herdr')).code, 0, 'not loaded: bootstrap, which starts it (RunAtLoad)');
  assert.ok(fs.statSync(path.join(dir, 'Library', 'Logs', 'remotly')).isDirectory(), 'the log directory is made before the bootstrap');
  assert.deepEqual(await sm.start('remotly-bridge-herdr'), EIO, 'launchctl gave no verdict: that is the result; nothing is bootstrapped over an agent that may be running');
  await sm.disable('remotly-bridge-herdr');
  assert.deepEqual(calls, [
    `launchctl print gui/501/${label}`,
    `launchctl kickstart gui/501/${label}`,
    `launchctl print gui/501/${label}`,
    `launchctl bootstrap gui/501 ${plist}`,
    `launchctl print gui/501/${label}`,
    `launchctl disable gui/501/${label}`,
  ]);
  assert.equal(sm.hints.enableNow('remotly-bridge-herdr'), `launchctl enable gui/501/${label} && launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.enable('remotly-bridge-herdr'), `launchctl enable gui/501/${label}`);
  assert.equal(sm.hints.disableNow('remotly-bridge-herdr'), `launchctl bootout gui/501/${label}; launchctl disable gui/501/${label}`);
  assert.equal(sm.hints.resetAndRestart('remotly-bridge-herdr'), `launchctl bootout gui/501/${label}; sleep 2; launchctl bootstrap gui/501 ${plist}`, 'launchd has no start-rate limit to clear: bootout and bootstrap clear any state, and load the plist as it is now');
  assert.equal(sm.hints.reloadRestart('remotly-bridge-herdr'), `launchctl bootout gui/501/${label}; sleep 2; launchctl bootstrap gui/501 ${plist}`, 'a kickstart would respawn the definition launchd loaded, not the rewritten plist');
  assert.equal(sm.hints.disable('remotly-bridge-herdr'), `launchctl disable gui/501/${label}`);
  assert.equal(sm.hints.restartNeedsEnabled, true, 'launchd does not bootstrap a disabled agent');
  assert.equal(sm.hints.start('remotly-bridge-herdr'), `launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.stop('remotly-bridge-herdr'), `launchctl bootout gui/501/${label}`);
  const rendered = sm.renderHerdrUnit({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', session: 'work', configHome: '/Users/alice/.config' });
  assert.match(rendered, new RegExp(`<key>StandardOutPath</key>\\n\\s*<string>${path.join(dir, 'Library', 'Logs', 'remotly', `${label}.log`)}</string>`), 'the home the manager was given');
  assert.match(rendered, /<string>--session<\/string>\n\s*<string>work<\/string>/);
});

test('xmlPlistLabel: the root dictionary\'s Label — not one nested in a value — with comments, CDATA and entities as XML has them; null for anything else', () => {
  const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  assert.equal(xmlPlistLabel(doc('<key>Label</key>\n<string>dev.remotly.x</string>')), 'dev.remotly.x');
  assert.equal(xmlPlistLabel(doc('<key>ProgramArguments</key><array><string>Label</string><string>a</string></array>\n<key>Label</key> <!-- c --> <string>dev.remotly.x</string>')), 'dev.remotly.x', 'after an array; a comment between key and value');
  assert.equal(xmlPlistLabel(doc('<key>EnvironmentVariables</key>\n<dict>\n<key>Label</key>\n<string>decoy</string>\n</dict>\n<key>Label</key>\n<string>dev.remotly.x</string>')), 'dev.remotly.x', 'a Label inside a value is not the root\'s');
  assert.equal(xmlPlistLabel(doc('<key>EnvironmentVariables</key><dict><key>Label</key><string>decoy</string></dict>')), null, 'only a nested one: none');
  assert.equal(xmlPlistLabel(doc('<key>Label</key><string>dev.remotly.a&amp;b&#45;c&#x2D;d</string>')), 'dev.remotly.a&b-c-d', 'entities');
  assert.equal(xmlPlistLabel(doc('<key>Label</key><string><![CDATA[dev.remotly.x]]></string>')), 'dev.remotly.x', 'CDATA');
  assert.equal(xmlPlistLabel(doc('<key>Label</key><dict><key>a</key><string>b</string></dict>')), null, 'a Label that is no string');
  assert.equal(xmlPlistLabel(doc('<key>Label</key><string/>')), null, 'an empty one');
  assert.equal(xmlPlistLabel(doc('<key>Disabled</key><true/>\n<key>Label</key><string>dev.remotly.x</string>')), 'dev.remotly.x', 'an empty element before it');
  assert.equal(xmlPlistLabel(doc('<key>Label</key><string>dev.remotly.x')), null, 'not well-formed');
  assert.equal(xmlPlistLabel('<dict><key>Label</key><string>dev.remotly.x</string></dict>'), null, 'no plist root');
  assert.equal(xmlPlistLabel('bplist00\u0000\u0001'), null, 'binary');
  assert.equal(xmlPlistLabel(''), null);
  // The root dictionary as a whole: keys decoded, strings and arrays of strings read, the rest `other`; a key twice is nothing.
  const root = xmlPlistRoot(doc('<key>Label</key><string>dev.remotly.x</string>\n<key>Pr&#111;gram</key><string>/opt/other</string>\n<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>a b</string></array>\n<key>KeepAlive</key><true/>\n<key>EnvironmentVariables</key><dict><key>Label</key><string>decoy</string></dict>\n<key>Empty</key><array/>'));
  assert.deepEqual(root && [...root.entries()], [
    ['Label', { kind: 'string', value: 'dev.remotly.x' }],
    ['Program', { kind: 'string', value: '/opt/other' }],
    ['ProgramArguments', { kind: 'strings', items: ['/usr/bin/env', 'a b'] }],
    ['KeepAlive', { kind: 'bool', value: true }],
    ['EnvironmentVariables', { kind: 'other' }],
    ['Empty', { kind: 'strings', items: [] }],
  ]);
  assert.deepEqual(xmlPlistRoot(doc('<key>ProgramArguments</key><array><string>a</string><integer>1</integer></array>'))?.get('ProgramArguments'), { kind: 'other' }, 'an array with something besides strings');
  assert.equal(xmlPlistRoot(doc('<key>Label</key><string>a</string><key>Label</key><string>b</string>')), null, 'a key twice');
  assert.equal(xmlPlistRoot(doc('<string>a</string>')), null, 'a value without its key');
  assert.equal(xmlPlistRoot(doc('<key>A</key><key>B</key><string>x</string>')), null, 'two keys in a row');
  assert.deepEqual(xmlPlistRoot(doc('')), new Map(), 'an empty dictionary');
  assert.deepEqual(xmlPlistRoot(doc('<key>Disabled</key><false/>'))?.get('Disabled'), { kind: 'bool', value: false });
  // One whole document, as launchd would have to read it.
  const whole = doc('<key>Label</key><string>dev.remotly.x</string>');
  assert.equal(xmlPlistRoot(whole.replace('</plist>\n', '')), null, 'cut off after the dictionary: no </plist>');
  assert.equal(xmlPlistRoot(whole.replace(/<\/dict>\n<\/plist>\n$/, '')), null, 'cut off inside the dictionary');
  assert.equal(xmlPlistRoot(`${whole}<dict/>`), null, 'anything after </plist>');
  assert.equal(xmlPlistRoot(`${whole}x`), null, 'text after </plist>');
  assert.deepEqual(xmlPlistRoot(`${whole}\n\n`)?.get('Label'), { kind: 'string', value: 'dev.remotly.x' }, 'whitespace after it is fine');
  assert.equal(xmlPlistRoot(doc('<key>Label</key><string>a &bogus; b</string>')), null, 'an entity XML does not know');
  assert.equal(xmlPlistRoot(doc('<key>Label</key><string>a < b</string>')), null, 'a stray <');
  assert.equal(xmlPlistRoot(doc('<key>Label</key><string>a</string><1x>')), null, 'something that is no tag');
  assert.equal(xmlPlistRoot(`garbage${whole}`), null, 'text before the document');
  assert.equal(xmlPlistRoot(`\n  ${whole}`)?.size, 1, 'whitespace before it is fine');
  assert.equal(xmlPlistRoot(whole.replace('<plist version="1.0">', '<plist version="1.0&bogus;">')), null, 'an entity XML does not know, in an attribute');
});

test('systemctlWords: a list as `systemctl show` prints it — bare words, "quoted" ones with backslash escapes when a path has a space; null when a quote does not close', () => {
  assert.deepEqual(systemctlWords(''), []);
  assert.deepEqual(systemctlWords('/a/b.conf /c/d.conf'), ['/a/b.conf', '/c/d.conf']);
  assert.deepEqual(systemctlWords('"/a/90 foreign.conf" /c/d.conf  '), ['/a/90 foreign.conf', '/c/d.conf']);
  assert.deepEqual(systemctlWords('"/a/say \\"hi\\".conf"'), ['/a/say "hi".conf']);
  assert.equal(systemctlWords('"/a/unclosed.conf'), null);
});

test('launchdManager: paths in the hints are quoted for a shell when a home has a space', () => {
  const home = '/Volumes/Fast Disk/alice';
  const sm = launchdManager({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), unitDir: path.join(home, 'Library', 'LaunchAgents'), user: 'alice', uid: 501, home, updateMinute: 17, sleep: async () => undefined });
  const plist = "'/Volumes/Fast Disk/alice/Library/LaunchAgents/dev.remotly.remotly-bridge-herdr.plist'";
  assert.equal(sm.hints.start('remotly-bridge-herdr'), `launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.enableNow('remotly-bridge-herdr'), `launchctl enable gui/501/dev.remotly.remotly-bridge-herdr && launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.reloadRestart('remotly-bridge-herdr'), `launchctl bootout gui/501/dev.remotly.remotly-bridge-herdr; sleep 2; launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.restartDisabled('remotly-bridge-herdr'), `launchctl bootout gui/501/dev.remotly.remotly-bridge-herdr; sleep 2; launchctl enable gui/501/dev.remotly.remotly-bridge-herdr && launchctl bootstrap gui/501 ${plist}`);
  assert.equal(sm.hints.enableRestart('remotly-bridge-herdr'), sm.hints.restartDisabled('remotly-bridge-herdr'), 'the one way to restart a disabled agent turns it on already');
  assert.equal(sm.hints.nativeStop(['com.example.herdr']), 'launchctl bootout gui/501/com.example.herdr', 'an agent of the user\'s own, by its label');
  assert.equal(sm.hints.nativeDisable(['com.example.herdr']), 'launchctl disable gui/501/com.example.herdr');
  assert.equal(sm.hints.nativeDisableNow(['com.example.herdr']), 'launchctl bootout gui/501/com.example.herdr; launchctl disable gui/501/com.example.herdr');
  assert.equal(sm.hints.nativeDisableNow(['com.example.a', 'com.example.b']), 'launchctl bootout gui/501/com.example.a; launchctl bootout gui/501/com.example.b; launchctl disable gui/501/com.example.a; launchctl disable gui/501/com.example.b', 'several: each booted out, then each disabled');
  assert.equal(sm.hints.nativeStop(['com.example.my herdr']), "launchctl bootout 'gui/501/com.example.my herdr'", 'a label with a space is one argument');
  assert.equal(sm.hints.cat('remotly-bridge-herdr'), `cat ${plist}`);
  assert.equal(sm.hints.logs('remotly-bridge-herdr', 30), "tail -n 30 '/Volumes/Fast Disk/alice/Library/Logs/remotly/dev.remotly.remotly-bridge-herdr.log'");
  assert.equal(sm.hints.startTimer('remotly-bridge'), "launchctl bootstrap gui/501 '/Volumes/Fast Disk/alice/Library/LaunchAgents/dev.remotly.remotly-bridge-update.plist'");
  const plain = launchdManager({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), unitDir: '/Users/alice/Library/LaunchAgents', user: 'alice', uid: 501, home: '/Users/alice', updateMinute: 17, sleep: async () => undefined });
  assert.equal(plain.hints.start('remotly-bridge-herdr'), 'launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/dev.remotly.remotly-bridge-herdr.plist', 'a plain path stays bare');
  assert.equal(plain.hints.restartDisabled('remotly-bridge-herdr'), 'launchctl bootout gui/501/dev.remotly.remotly-bridge-herdr; sleep 2; launchctl enable gui/501/dev.remotly.remotly-bridge-herdr && launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/dev.remotly.remotly-bridge-herdr.plist');
});
