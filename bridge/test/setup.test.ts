import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ControlStatus, PairInfo } from '../src/control.ts';
import { bridgeUnitOfSetup, classifyCertFailure, classifyTailnet, derivedUnitKind, disableLanMode, enableLanMode, findExecutable, HERDR_INSTALL, herdrArgv, herdrSearchDirs, herdrSessionFor, herdrStopCommand, herdrUnitArgs, herdrUnitFile, installerEnv, labelFromLaunchctlList, LAN_CONFIG, listenerInodes, lockSession, nodeMajor, otherHerdrUnits, parseSetupArgs, pidListeningOn, pidsFromLsof, readProcessArgs, readProcessConfigHome, readProcessUnit, reconcileHerdrEnv, renderRepairScript, renderUnit, renderUpdateUnits, repairScriptPath, runSetup, type SessionLock, sessionLockPath, type SetupConfigView, type SetupDeps, type SetupOptions, shellWord, stableNodePath, systemdUserDir, TAILSCALE_DNS_ADMIN, TAILSCALE_INSTALL, timerMarkerPath, typeLevelAgainst, unitFile, unitOfCgroup, unitSourceCheck, updateUnitNames } from '../src/setup.ts';
import { lockedCommand } from '../src/platform/lock.ts';
import { HERDR_UNIT_MARKER, launchdManager, renderLaunchAgent, renderLaunchHerdrAgent, renderLaunchUpdateAgent, renderPlist, renderSystemdHerdrUnit, renderSystemdUnit, systemdManager } from '../src/platform/service.ts';
import { pairFallbackHost } from '../src/server/pairing.ts';
import { lanIPv4Addresses } from '../src/server/tls.ts';
import type { ExecResult, TailscaleStatus } from '../src/tailscale.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-setup-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const RUNNING: TailscaleStatus = {
  BackendState: 'Running',
  CertDomains: ['host.tail1234.ts.net'],
  Self: { DNSName: 'host.tail1234.ts.net.', TailscaleIPs: ['100.64.0.7', 'fd7a::7'], UserID: 1 },
  CurrentTailnet: { MagicDNSEnabled: true },
};

const STATUS: ControlStatus = {
  pid: 4242,
  herdr: 'up',
  listen: { host: '100.64.0.7', port: 7460 },
  tls: { mode: 'tailscale', not_after: '2027-01-01T00:00:00.000Z' },
  devices: 0,
  push: { apns: true, fcm: true, mode: { apns: 'relay', fcm: 'relay' } },
  clients: 0,
};

const PAIR: PairInfo = { code: 'ABCDEFGH', expires_at: 'x', reusable: true, url: 'wss://host.tail1234.ts.net:7460', host_name: 'host', qr_payload: 'remotly://pair?…' };

const okRun = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
/** `systemctl is-enabled` of a unit that does not exist (what systemd answers on a fresh install). */
const NOT_FOUND: ExecResult = { code: 4, stdout: 'not-found\n', stderr: 'Failed to get unit file state: No such file or directory' };
const failRun = (stderr: string, code: number | null = 1): ExecResult => ({ code, stdout: '', stderr });
const missing = (): ExecResult => failRun('spawn x ENOENT', null);

/** Scripted exec: `script[key]` is a result or a queue of results consumed in order; anything else succeeds silently. */
function fakeExec(script: Record<string, ExecResult | ExecResult[]>) {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const hit = Object.keys(script)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0]; // the most specific key answers, whatever the order they were given in
    if (hit === undefined) return okRun();
    const v = script[hit];
    if (Array.isArray(v)) return v.length > 1 ? (v.shift() as ExecResult) : (v[0] as ExecResult);
    return v as ExecResult;
  };
  return { exec, calls };
}

function makeDeps(over: Partial<SetupDeps> & { script?: Record<string, ExecResult | ExecResult[]> } = {}) {
  const out: string[] = [];
  // Unless a test scripts it, the unit is the daemon that STATUS describes: systemd reports its main pid as 4242 — and
  // the update units do not exist yet (a fresh install). A test's own keys come after, so the same key overrides, and a
  // more specific one wins on length.
  const { exec: scripted, calls } = fakeExec({ [SHOW]: unitShow('loaded', 'active', 'running', 4242), 'systemctl --user is-enabled ': NOT_FOUND, ...(over.script ?? {}) });
  const exec = scripted;
  let t = 1_000_000;
  const sock = path.join(dir, 'herdr.sock');
  const deps: SetupDeps = {
    version: '0.1.0',
    exec,
    out: (l) => out.push(l),
    sleep: async (ms) => void (t += ms),
    now: () => t,
    user: 'alice',
    uid: 1000,
    nodePath: '/opt/node/bin/node',
    mainPath: path.join(dir, 'app', 'src', 'main.ts'),
    env: {},
    unitDir: path.join(dir, 'systemd'),
    configPath: path.join(dir, 'config.json'),
    tlsDir: path.join(dir, 'tls'),
    herdrSocket: sock,
    // Like the real loader: what the file says, defaults otherwise (setup rewrites the file for --lan and reads it back).
    loadConfig: (): SetupConfigView => {
      const raw = fs.existsSync(path.join(dir, 'config.json')) ? (JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { tls?: { mode?: SetupConfigView['tls']['mode'] }; security?: { require_tailnet?: 'auto' | boolean } }) : {};
      return { tls: { mode: raw.tls?.mode ?? 'auto' }, security: { require_tailnet: raw.security?.require_tailnet ?? 'auto' } };
    },
    herdrPing: async () => ({ version: '0.8.0', protocol: 19 }),
    status: async () => STATUS,
    pair: async () => PAIR,
    showPairing: async (info) => void out.push(`QR ${info.code} ${info.reusable ? 'reusable' : 'single'}`),
    // never the real ~/.claude or ~/.codex: nothing is installed here unless a test creates the directory
    agentDirs: { claude: path.join(dir, 'agents', 'claude'), codex: path.join(dir, 'agents', 'codex') },
    claudeRunning: () => false,
    processArgs: async () => null, // never this host's /proc: a test that wants a live herdr process says so
    processConfigHome: () => null,
    socketPid: () => null, // nor /proc/net/unix: a test with a herdr under a unit of the user's own says so
    processUnit: () => null,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'script')),
  };
  return { deps, out, calls, sock, touchSocket: () => fs.writeFileSync(sock, '') };
}

const OPTS: SetupOptions = { unit: 'remotly-bridge', lan: false, wait: true, pair: true, ttlSec: 600 };
/** An update timer an earlier release wrote (every release that wrote one named it so in its Description; setup rewrites only those). */
const OLD_TIMER = '[Unit]\nDescription=Remotly bridge update, daily (remotly-bridge)\n# old timer\n';
const tsScript = (status: TailscaleStatus | null = RUNNING) => ({ 'tailscale status --json': status ? okRun(JSON.stringify(status)) : failRun('failed to connect to local tailscaled') });
const lingerYes = { 'loginctl show-user': okRun('yes\n') };
// A first install: the unit is not running when setup looks (MainPID 0); after the restart it is the 4242 process.
// (looked at twice before the write — see ownershipGuard — then by the health wait)
const freshUnit = () => ({ [SHOW]: [unitShow('not-found', 'inactive', 'dead', 0), unitShow('not-found', 'inactive', 'dead', 0), unitShow('loaded', 'active', 'running', 4242)] });
// What `systemctl --user show -p LoadState,ActiveState,SubState,MainPID` prints: `Key=value` lines in systemd's own
// order (not the order asked for — the fake deliberately shuffles it).
const SHOW = 'systemctl --user show -p LoadState,ActiveState,SubState,MainPID';
function unitShow(load: string, active: string, sub: string, pid: number): ExecResult {
  return okRun(`MainPID=${pid}\nSubState=${sub}\nLoadState=${load}\nActiveState=${active}\n`);
}

test('parseSetupArgs: defaults, flags, validation', () => {
  const d = parseSetupArgs([], {});
  assert.deepEqual(d, { unit: 'remotly-bridge', lan: false, wait: true, pair: true, ttlSec: 600 });
  assert.equal(parseSetupArgs([], { REMOTLY_SYSTEMD_UNIT: 'remotly-dev' }).unit, 'remotly-dev');
  const o = parseSetupArgs(['--unit', 'u2', '--config-dir', '/c', '--herdr-session', 'main', '--herdr-socket', '/s', '--ttl', '120', '--lan', '--no-wait', '--no-pair', '--keep-mode', '--keep-stopped'], {});
  assert.deepEqual(o, { unit: 'u2', configDir: '/c', herdrSession: 'main', herdrSocket: '/s', ttlSec: 120, lan: true, wait: false, pair: false, keepMode: true, keepStopped: true });
  assert.throws(() => parseSetupArgs(['--ttl', '5'], {}), /between 30 and 3600/);
  assert.throws(() => parseSetupArgs(['--ttl'], {}), /needs a value/);
  assert.throws(() => parseSetupArgs(['--unit', '--lan'], {}), /needs a value/);
  assert.throws(() => parseSetupArgs(['--unit', 'a b'], {}), /plain unit name/);
  assert.throws(() => parseSetupArgs(['--unit', '-x'], {}), /plain unit name/, 'a leading dash would be taken as a systemctl option');
  assert.throws(() => parseSetupArgs(['--bogus'], {}), /unknown setup option/);
});

test('setup sets the installed agents up by hand, on an unattended re-run (--keep-mode) only once per install, never with --no-agent-settings', async () => {
  const record = path.join(dir, 'agent-settings.json');
  const toml = path.join(dir, 'agents', 'codex', 'config.toml');
  // [options, record before, settings made, record after]
  const cases = [
    [OPTS, null, true, 'on'],
    [OPTS, '{"choice":"off"}', true, 'on'],
    [{ ...OPTS, agentSettings: false }, null, false, 'off'],
    [{ ...OPTS, keepMode: true }, null, true, 'on'],
    [{ ...OPTS, keepMode: true }, '{"choice":"on"}', false, 'on'],
    [{ ...OPTS, keepMode: true }, '{"choice":"off"}', false, 'off'],
  ] as const;
  for (const [opts, before, applied, after] of cases) {
    fs.rmSync(path.join(dir, 'agents'), { recursive: true, force: true });
    fs.rmSync(record, { force: true });
    if (before) fs.writeFileSync(record, before);
    fs.mkdirSync(path.join(dir, 'agents', 'codex'), { recursive: true });
    const { deps, out, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes } });
    touchSocket();
    const label = JSON.stringify([opts, before]);
    assert.equal(await runSetup(deps, opts), 0, label);
    assert.equal(fs.existsSync(toml), applied, label);
    assert.equal(out.some((l) => l.includes('Codex: [tui] alternate_screen')), applied, label);
    assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).choice, after, label);
    assert.equal(fs.existsSync(path.join(dir, 'agents', 'claude')), false, 'Claude Code is not installed: left alone');
  }
  assert.equal(parseSetupArgs(['--no-agent-settings'], {}).agentSettings, false);
});

test('parseSetupArgs: `.service` is dropped from the unit name; path options become absolute', () => {
  assert.equal(parseSetupArgs(['--unit', 'remotly-bridge.service'], {}).unit, 'remotly-bridge');
  assert.throws(() => parseSetupArgs(['--unit', 'backup.service.service'], {}), /"\.service" twice/, 'the file and the systemctl name must be the same unit');
  assert.equal(parseSetupArgs([], { REMOTLY_SYSTEMD_UNIT: 'remotly-dev.service' }).unit, 'remotly-dev');
  const rel = parseSetupArgs(['--config-dir', './dev', '--herdr-socket', 'run/herdr.sock'], {});
  assert.equal(rel.configDir, path.resolve('./dev'), 'the unit runs from systemd\'s cwd, not this shell\'s');
  assert.equal(rel.herdrSocket, path.resolve('run/herdr.sock'));
  const tilde = parseSetupArgs(['--config-dir', '~/.config/remotly-2'], {});
  assert.equal(tilde.configDir, path.join(os.homedir(), '.config', 'remotly-2'));
});

test('enableLanMode merges the three LAN keys into an existing config and keeps everything else', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 7461 }, push: { debounce_ms: 100 } }));
  const keys = enableLanMode(file);
  assert.deepEqual(keys, ['tls.mode', 'listen.host', 'security.require_tailnet']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, { listen: { port: 7461, host: '0.0.0.0' }, push: { debounce_ms: 100 }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false } });
  assert.equal(after.tls.mode, LAN_CONFIG.tls.mode);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(file);
  enableLanMode(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tls: { mode: 'selfsigned' }, listen: { host: '0.0.0.0' }, security: { require_tailnet: false } }, 'no file yet: created with just the LAN keys');
  fs.writeFileSync(file, '[1]');
  assert.throws(() => enableLanMode(file), /top level must be a JSON object/);
});

test('disableLanMode removes exactly the LAN triple and nothing else; a partial or different config is left alone', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 7461, host: '0.0.0.0' }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false }, push: { debounce_ms: 5 } }));
  assert.equal(disableLanMode(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { listen: { port: 7461 }, push: { debounce_ms: 5 } }, 'emptied sections disappear, other keys stay');
  assert.equal(disableLanMode(file), false, 'nothing left to undo');
  fs.writeFileSync(file, JSON.stringify({ tls: { mode: 'selfsigned' } }));
  assert.equal(disableLanMode(file), false, 'a hand-set selfsigned mode without the other two keys is the user\'s choice');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tls: { mode: 'selfsigned' } });
  assert.equal(disableLanMode(path.join(dir, 'missing.json')), false);
});

test('unitFile: one optional .service suffix, then exactly one', () => {
  assert.equal(unitFile('remotly-bridge'), 'remotly-bridge.service');
  assert.equal(unitFile('remotly-bridge.service'), 'remotly-bridge.service');
  assert.equal(unitFile('backup.service'), 'backup.service', 'setup writes and addresses the same file name');
  assert.equal(unitFile('remotly.dev'), 'remotly.dev.service');
  assert.equal(unitFile('existing.timer'), 'existing.timer.service', 'never acts on a unit of another type');
});

test('pairFallbackHost: Tailscale IP first normally, a LAN address first without the tailnet gate', () => {
  const lanIps = ['100.64.0.7', '192.168.1.20'];
  assert.equal(pairFallbackHost({ lanFirst: false, tailscaleIp: '100.64.0.7', lanIps, hostName: 'h' }), '100.64.0.7');
  assert.equal(pairFallbackHost({ lanFirst: true, tailscaleIp: '100.64.0.7', lanIps, hostName: 'h' }), '192.168.1.20', 'LAN mode on a host that also runs Tailscale');
  assert.equal(pairFallbackHost({ lanFirst: true, tailscaleIp: '100.64.0.7', lanIps: ['100.64.0.7'], hostName: 'h' }), '100.64.0.7', 'no other address: the Tailscale one is better than a bare host name');
  assert.equal(pairFallbackHost({ lanFirst: false, tailscaleIp: null, lanIps: ['192.168.1.20'], hostName: 'h' }), '192.168.1.20');
  assert.equal(pairFallbackHost({ lanFirst: true, tailscaleIp: null, lanIps: [], hostName: 'h' }), 'h');
});

test('renderUnit quotes paths, doubles % and only emits the environment lines it was given', () => {
  const unit = renderUnit({ nodePath: '/home/a b/.local/share/remotly/node/bin/node', mainPath: '/home/a b/.local/share/remotly/app/src/main.ts' });
  assert.match(unit, /^ExecStart="\/home\/a b\/.local\/share\/remotly\/node\/bin\/node" "\/home\/a b\/.local\/share\/remotly\/app\/src\/main.ts" serve$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  assert.equal(unit.includes('REMOTLY_CONFIG_DIR'), false);
  assert.equal(unit.includes('HERDR_'), false);
  assert.equal(unit.includes('REMOTLY_TAILSCALE'), false);
  const full = renderUnit({ nodePath: '/usr/bin/node', mainPath: '/x/main.ts', configDir: '/home/a/.config/remotly-2', herdrSession: 'main', herdrSocket: '/run/100%/herdr.sock', tailscale: '/opt/ts/tailscale' });
  assert.match(full, /^Environment="REMOTLY_CONFIG_DIR=\/home\/a\/.config\/remotly-2"$/m);
  assert.match(full, /^Environment="HERDR_SESSION=main"$/m);
  assert.match(full, /^Environment="HERDR_SOCKET_PATH=\/run\/100%%\/herdr.sock"$/m, 'a literal % is %% in a unit file');
  assert.match(full, /^Environment="REMOTLY_TAILSCALE=\/opt\/ts\/tailscale"$/m, 'a tailscale CLI setup was pointed at stays known to the daemon');
  const repaired = renderUnit({ nodePath: '/usr/bin/node', mainPath: '/h/app/src/main.ts', repairScript: '/h o/repair-app.sh' });
  assert.match(repaired, /^ExecStartPre=-\/bin\/sh "\/h o\/repair-app\.sh"\nExecStart=/m, 'the repair runs first, and its failure does not stop the start');
  assert.equal(unit.includes('ExecStartPre'), false, 'no repair for a copy that is not an installed release');
  assert.throws(() => renderUnit({ nodePath: '/usr/bin/node', mainPath: '/x/"quoted"/main.ts' }), /cannot put/);
  assert.throws(() => renderUnit({ nodePath: '/usr/bin/node', mainPath: '/x/$HOME/main.ts' }), /cannot put/);
});

test('stableNodePath prefers the fnm default alias for fnm shells only when it is Node ≥ 24, else the real path', () => {
  const home = '/home/alice';
  const alias = '/home/alice/.local/share/fnm/aliases/default/bin/node';
  const multishell = '/home/alice/.local/share/fnm/multishells/4242_1700000000/bin/node';
  const installed = '/home/alice/.local/share/fnm/node-versions/v24.1.0/installation/bin/node';
  assert.equal(stableNodePath(multishell, home, { exists: (p) => p === alias, realpath: (p) => p, major: () => 24 }), alias);
  assert.equal(stableNodePath(multishell, home, { exists: (p) => p === alias, realpath: () => installed, major: () => 22 }), installed, 'default alias still on Node 22: keep the runtime setup runs on');
  assert.equal(stableNodePath(multishell, home, { exists: (p) => p === alias, realpath: () => installed, major: () => null }), installed, 'alias that does not run');
  assert.equal(stableNodePath(multishell, home, { exists: () => false, realpath: () => installed, major: () => 24 }), installed, 'no alias: the resolved install directory outlives the shell');
  assert.equal(stableNodePath('/usr/bin/node', home, { exists: () => true, realpath: () => '/usr/bin/node', major: () => 24 }), '/usr/bin/node', 'non-fnm node ignores the alias');
  assert.equal(stableNodePath('/nowhere/node', home, { exists: () => false, realpath: () => { throw new Error('ENOENT'); }, major: () => null }), '/nowhere/node');
  assert.equal(nodeMajor(process.execPath), Number(process.versions.node.split('.')[0]), 'the default probe runs the binary');
  assert.equal(nodeMajor('/nowhere/node'), null);
});

test('classifyTailnet walks the fixes in the order the user must apply them', () => {
  const missingBin = classifyTailnet(null, false);
  assert.equal(missingBin.ok, false);
  assert.match(JSON.stringify(missingBin), new RegExp(TAILSCALE_INSTALL.replace(/[|]/g, '\\|')));
  const down = classifyTailnet(null, true);
  assert.match(JSON.stringify(down), /tailscaled is not running/);
  const login = classifyTailnet({ BackendState: 'NeedsLogin' }, true);
  assert.match(JSON.stringify(login), /not logged in.*sudo tailscale up/);
  const noMagic = classifyTailnet({ ...RUNNING, CurrentTailnet: { MagicDNSEnabled: false } }, true);
  assert.match(JSON.stringify(noMagic), /MagicDNS is off/);
  assert.match(JSON.stringify(noMagic), new RegExp(TAILSCALE_DNS_ADMIN));
  const noCerts = classifyTailnet({ ...RUNNING, CertDomains: [] }, true);
  assert.match(JSON.stringify(noCerts), /HTTPS Certificates are not enabled/);
  const { CertDomains: _omitted, ...withoutField } = RUNNING;
  assert.equal(classifyTailnet(withoutField, true).ok, false, 'older tailscale without the field is treated as not enabled');
  const ok = classifyTailnet(RUNNING, true);
  assert.deepEqual(ok, { ok: true, ip: '100.64.0.7', name: 'host.tail1234.ts.net' });
});

test('classifyTailnet with cert:false stops at a logged-in node (what the tailnet gate needs)', () => {
  const noMagic = { ...RUNNING, CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [] };
  assert.equal(classifyTailnet(noMagic, true).ok, false, 'a certificate still needs MagicDNS');
  assert.deepEqual(classifyTailnet(noMagic, true, { cert: false }), { ok: true, ip: '100.64.0.7', name: null });
  assert.equal(classifyTailnet({ BackendState: 'NeedsLogin' }, true, { cert: false }).ok, false, 'the gate cannot identify peers without a login');
  // What serve's start-up wait calls "down" (tailscale-wait.ts presenceFrom) is not ok here either, in both modes
  const noSelf: TailscaleStatus = { BackendState: 'Running', CertDomains: ['host.tail1234.ts.net'], CurrentTailnet: { MagicDNSEnabled: true } };
  const noUser: TailscaleStatus = { ...RUNNING, Self: { DNSName: 'host.tail1234.ts.net.', TailscaleIPs: ['100.64.0.7', 'fd7a::7'] } };
  for (const s of [noSelf, noUser]) {
    for (const cert of [true, false]) {
      const r = classifyTailnet(s, true, { cert });
      assert.equal(r.ok, false, `Running without an identified Self is not ok (cert ${cert})`);
      assert.match(r.ok ? '' : r.problem, /no identity for this node/);
    }
  }
  assert.equal(classifyTailnet(null, false, { cert: false }).ok, false);
});

test('reconcileHerdrEnv: flags win, an explicit session drops an inherited socket, inherited values are adopted', () => {
  const base = (): SetupOptions => ({ unit: 'u', lan: false, wait: true, pair: true, ttlSec: 600 });
  // inherited socket + explicit --herdr-session: the socket must not silently win
  let o: SetupOptions = { ...base(), herdrSession: 'B' };
  let env: NodeJS.ProcessEnv = { HERDR_SOCKET_PATH: '/run/A/herdr.sock' };
  reconcileHerdrEnv(o, env);
  assert.deepEqual([o.herdrSocket, o.herdrSession, env['HERDR_SOCKET_PATH'], env['HERDR_SESSION']], [undefined, 'B', undefined, 'B']);
  // explicit socket: env follows it; an inherited session is not written into the unit
  o = { ...base(), herdrSocket: '/run/X/herdr.sock' };
  env = { HERDR_SESSION: 'A' };
  reconcileHerdrEnv(o, env);
  assert.deepEqual([o.herdrSocket, o.herdrSession, env['HERDR_SOCKET_PATH']], ['/run/X/herdr.sock', undefined, '/run/X/herdr.sock']);
  // nothing explicit: what the shell inherited (a herdr pane exports the socket) is what setup checks and the unit gets
  o = base();
  env = { HERDR_SOCKET_PATH: '~/.config/herdr/sessions/A/herdr.sock', HERDR_SESSION: 'A' };
  reconcileHerdrEnv(o, env);
  assert.equal(o.herdrSocket, path.join(os.homedir(), '.config/herdr/sessions/A/herdr.sock'));
  assert.equal(env['HERDR_SOCKET_PATH'], o.herdrSocket, 'the environment (what resolveSocketPath reads for the check) carries the same absolute path as the unit');
  assert.equal(o.herdrSession, 'A');
  o = base();
  env = {};
  reconcileHerdrEnv(o, env);
  assert.deepEqual([o.herdrSocket, o.herdrSession], [undefined, undefined]);
  // config.json selects the herdr: the shell's environment is neither checked nor persisted (serve would let an
  // environment socket beat the configured session), and a flag that serve would ignore is refused instead
  o = base();
  env = { HERDR_SOCKET_PATH: '/run/dev/herdr.sock', HERDR_SESSION: 'dev' };
  reconcileHerdrEnv(o, env, { socket: null, session: 'production' });
  assert.deepEqual([o.herdrSocket, o.herdrSession, env['HERDR_SOCKET_PATH'], env['HERDR_SESSION']], [undefined, undefined, undefined, undefined]);
  assert.throws(() => reconcileHerdrEnv({ ...base(), herdrSession: 'dev' }, {}, { session: 'production' }), /config.json already selects herdr \(herdr.session = production\).*--herdr-session would be ignored/);
  assert.throws(() => reconcileHerdrEnv({ ...base(), herdrSocket: '/run/x' }, {}, { socket: '/srv/h.sock' }), /herdr.socket = \/srv\/h.sock/);
});

test('systemdUserDir honours XDG_CONFIG_HOME', () => {
  assert.equal(systemdUserDir({}, '/home/alice'), '/home/alice/.config/systemd/user');
  assert.equal(systemdUserDir({ XDG_CONFIG_HOME: '/custom/config' }, '/home/alice'), '/custom/config/systemd/user');
  assert.equal(systemdUserDir({ XDG_CONFIG_HOME: 'relative' }, '/home/alice'), '/home/alice/.config/systemd/user', 'the spec says to ignore a relative value');
  assert.equal(systemdUserDir({ XDG_CONFIG_HOME: '  ' }, '/home/alice'), '/home/alice/.config/systemd/user');
});

test('lanIPv4Addresses lists physical-looking interfaces before container bridges and tunnels', () => {
  const v4 = (address: string): os.NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00', internal: false, cidr: null });
  const ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    lo: [{ ...v4('127.0.0.1'), internal: true }],
    docker0: [v4('172.17.0.1')],
    'br-1a2b': [v4('172.18.0.1')],
    tailscale0: [v4('100.64.0.7')],
    enp3s0: [v4('192.168.1.20')],
    wlan0: [v4('192.168.1.21')],
  };
  assert.deepEqual(lanIPv4Addresses(ifaces), ['192.168.1.20', '192.168.1.21', '172.17.0.1', '172.18.0.1', '100.64.0.7']);
  assert.equal(pairFallbackHost({ lanFirst: true, tailscaleIp: '100.64.0.7', lanIps: lanIPv4Addresses(ifaces), hostName: 'h' }), '192.168.1.20');
  assert.ok(lanIPv4Addresses().every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)), 'the default reads the real interfaces');
});

test('classifyCertFailure: operator and HTTPS problems are pollable, anything else is not', () => {
  const denied = classifyCertFailure('Access denied: cert access denied', 'alice', 'h.ts.net');
  assert.deepEqual(denied, { problem: 'Tailscale refuses certificate requests from this user', fix: ['sudo tailscale set --operator=alice'], retry: true });
  const off = classifyCertFailure('HTTPS cert support is not enabled/configured for your tailnet.', 'alice', 'h.ts.net');
  assert.equal(off.retry, true);
  assert.match(off.fix[0] ?? '', /HTTPS Certificates/);
  const other = classifyCertFailure('acme: urn:ietf:params:acme:error:rateLimited', 'alice', 'h.ts.net');
  assert.equal(other.retry, false);
  assert.match(other.problem, /rateLimited/);
  assert.match(other.fix[0] ?? '', /tailscale cert h\.ts\.net.*self-signed certificate, which iPhones refuse/);
  const strict = classifyCertFailure('acme: rateLimited', 'alice', 'h.ts.net', 'tailscale');
  assert.match(strict.fix[0] ?? '', /does not start without it — or set tls.mode to "auto"/, 'no fallback promise when tls.mode forbids it');
  assert.equal(strict.fix[0]?.includes('uses a self-signed'), false);
});

test('happy path: checks, certificate, unit, linger, health, one reusable QR', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.match(text, /✔ config /);
  assert.match(text, /✔ herdr 0\.8\.0 \(protocol 19\)/);
  assert.match(text, /✔ Tailscale running as host\.tail1234\.ts\.net \(100\.64\.0\.7\), HTTPS Certificates enabled/);
  assert.match(text, /✔ certificate for host\.tail1234\.ts\.net/);
  assert.match(text, /✔ service remotly-bridge installed at .*remotly-bridge\.service \(node \/opt\/node\/bin\/node\)/);
  assert.match(text, /✔ starts at boot and survives logout \(linger on\)/);
  assert.match(text, /✔ bridge running: listening 100\.64\.0\.7:7460, certificate tailscale, herdr up/);
  assert.match(text, /QR ABCDEFGH reusable/);
  assert.match(text, /setup complete$/);
  assert.equal(text.includes('✖'), false);
  assert.equal(text.includes('⚠'), false);

  const unit = fs.readFileSync(path.join(deps.unitDir, 'remotly-bridge.service'), 'utf8');
  assert.match(unit, new RegExp(`^ExecStart="/opt/node/bin/node" "${deps.mainPath}" serve$`, 'm'));
  const cert = calls.find((c) => c.startsWith('tailscale cert'));
  assert.equal(cert, `tailscale cert --cert-file ${path.join(deps.tlsDir, 'ts.crt')} --key-file ${path.join(deps.tlsDir, 'ts.key')} host.tail1234.ts.net`);
  assert.ok(fs.existsSync(deps.tlsDir), 'tls dir created before tailscale writes into it');
  const sd = calls.filter((c) => c.startsWith('systemctl') && !c.includes('MainPID'));
  assert.deepEqual(sd, ['systemctl --user show-environment', 'systemctl --user daemon-reload', 'systemctl --user enable remotly-bridge.service', 'systemctl --user restart remotly-bridge.service']);
  assert.ok(calls.includes(`${SHOW} remotly-bridge.service`), 'health = the answering daemon is the unit\'s main process');
});

test('a daemon from before this version (no pid in status) is taken for the running unit and upgraded', async () => {
  let answered = 0;
  const { pid: _pid, ...legacy } = STATUS;
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes },
    // Before the restart the old daemon answers without a pid; after it the new one answers with the unit's pid.
    status: async () => (answered++ === 0 ? legacy : STATUS),
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  assert.ok(calls.includes('systemctl --user restart remotly-bridge.service'));
  assert.match(out.join('\n'), /✔ bridge running/);
});

test('an ordinary setup after --lan removes the LAN keys again', async () => {
  const { deps, out, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  touchSocket();
  fs.writeFileSync(deps.configPath, JSON.stringify({ listen: { port: 7461, host: '0.0.0.0' }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false } }));
  assert.equal(await runSetup(deps, OPTS), 0);
  assert.match(out.join('\n'), /⚠ LAN mode removed from config.json[\s\S]*✔ Tailscale running[\s\S]*✔ certificate for/);
  assert.deepEqual(JSON.parse(fs.readFileSync(deps.configPath, 'utf8')), { listen: { port: 7461 } });
});

test('--keep-mode (update, upgrade scripts): a LAN host stays LAN without Tailscale checks; a Tailscale host stays as it is', async () => {
  // LAN host, Tailscale not installed: an ordinary setup would drop the triple and then fail on Tailscale; --keep-mode does neither
  const lan = makeDeps({ script: { ...lingerYes, 'tailscale status --json': missing(), 'tailscale ip -4': missing() }, status: async () => ({ ...STATUS, tls: { mode: 'selfsigned' as const, not_after: 'x', fingerprint: 'f' } }) });
  lan.touchSocket();
  const lanFile = { listen: { port: 7461, host: '0.0.0.0' }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false } };
  fs.writeFileSync(lan.deps.configPath, JSON.stringify(lanFile));
  assert.equal(await runSetup(lan.deps, { ...OPTS, keepMode: true, pair: false }), 0);
  const text = lan.out.join('\n');
  assert.match(text, /⚠ LAN mode kept \(config.json/);
  assert.equal(text.includes('LAN mode removed'), false);
  assert.equal(text.includes('written to config.json'), false, 'nothing rewritten');
  assert.deepEqual(JSON.parse(fs.readFileSync(lan.deps.configPath, 'utf8')), lanFile, 'config.json untouched');
  assert.equal(lan.calls.some((c) => c.startsWith('tailscale')), false, 'no Tailscale check on a LAN host');
  assert.ok(lan.calls.includes('systemctl --user restart remotly-bridge.service'));

  // Tailscale host: --keep-mode changes nothing — the Tailscale checks and the certificate run as for an ordinary setup
  const ts = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  ts.touchSocket();
  fs.writeFileSync(ts.deps.configPath, JSON.stringify({ listen: { port: 7461 } }));
  assert.equal(await runSetup(ts.deps, { ...OPTS, keepMode: true }), 0);
  assert.match(ts.out.join('\n'), /✔ Tailscale running[\s\S]*✔ certificate for/);
  assert.equal(ts.out.join('\n').includes('LAN mode'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(ts.deps.configPath, 'utf8')), { listen: { port: 7461 } });

  // --lan wins over --keep-mode: it is the explicit request
  const both = makeDeps({ script: { ...lingerYes, 'tailscale status --json': missing(), 'tailscale ip -4': missing() }, status: async () => ({ ...STATUS, tls: { mode: 'selfsigned' as const, not_after: 'x', fingerprint: 'f' } }) });
  both.touchSocket();
  assert.equal(await runSetup(both.deps, { ...OPTS, keepMode: true, lan: true, pair: false }), 0);
  assert.match(both.out.join('\n'), /⚠ LAN mode: tls.mode, listen.host, security.require_tailnet written to config.json/);
});

test('tls.mode "tailscale": a certificate failure is fatal instead of a promised fallback', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), 'tailscale cert': failRun('acme: rate limited'), ...lingerYes },
    loadConfig: () => ({ tls: { mode: 'tailscale' }, security: { require_tailnet: 'auto' } }),
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  assert.match(out.join('\n'), /✖ tls.mode is "tailscale" in config.json: the bridge does not start without that certificate/);
  assert.equal(calls.some((c) => c.startsWith('systemctl --user restart')), false);
});

test('tls.mode "selfsigned" set by hand: no certificate step, but the tailnet gate still needs a logged-in Tailscale', async () => {
  const selfsigned = { ...STATUS, tls: { mode: 'selfsigned' as const, not_after: 'x', fingerprint: 'f' } };
  // require_tailnet auto + Tailscale absent: gate off, LAN-like, proceeds with a warning
  const absent = makeDeps({ script: { ...lingerYes, 'tailscale status --json': missing() }, loadConfig: () => ({ tls: { mode: 'selfsigned' }, security: { require_tailnet: 'auto' } }), status: async () => selfsigned });
  absent.touchSocket();
  assert.equal(await runSetup(absent.deps, OPTS), 0);
  let text = absent.out.join('\n');
  assert.match(text, /⚠ tls.mode is "selfsigned" in config.json: no Tailscale certificate/);
  assert.match(text, /⚠ Tailscale is not installed here, so the tailnet gate is off/);
  assert.equal(absent.calls.some((c) => c.startsWith('tailscale cert')), false);
  assert.ok(absent.calls.includes('openssl version'));
  assert.equal(text.includes('once `tailscale cert` works'), false);

  // require_tailnet auto + Tailscale installed but tailscaled stopped: the daemon would wait for it and then refuse to
  // start with the gate off (server/tailscale-wait.ts), so setup does not call this "gate off" — it is a failing check
  const stopped = makeDeps({ script: { ...lingerYes, 'tailscale status --json': failRun('failed to connect to local tailscaled; it doesn\'t appear to be running') }, loadConfig: () => ({ tls: { mode: 'selfsigned' }, security: { require_tailnet: 'auto' } }), status: async () => selfsigned });
  stopped.touchSocket();
  assert.equal(await runSetup(stopped.deps, { ...OPTS, wait: false }), 1);
  assert.match(stopped.out.join('\n'), /✖ tailscaled is not running\n\s+sudo systemctl enable --now tailscaled/);
  assert.equal(stopped.out.join('\n').includes('gate is off'), false);
  assert.equal(stopped.calls.some((c) => c.startsWith('systemctl --user restart')), false);

  // require_tailnet auto + tailscaled answering but not logged in: the gate would deny everyone → wait for the login
  const needsLogin = makeDeps({ script: { ...lingerYes, 'tailscale status --json': okRun(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } })) }, loadConfig: () => ({ tls: { mode: 'selfsigned' }, security: { require_tailnet: 'auto' } }), status: async () => selfsigned });
  needsLogin.touchSocket();
  assert.equal(await runSetup(needsLogin.deps, { ...OPTS, wait: false }), 1);
  assert.match(needsLogin.out.join('\n'), /✖ Tailscale is not logged in\n\s+sudo tailscale up/);

  // require_tailnet true + Tailscale absent: hard, whatever the certificate mode
  const strict = makeDeps({ script: { ...lingerYes, 'tailscale status --json': missing() }, loadConfig: () => ({ tls: { mode: 'selfsigned' }, security: { require_tailnet: true } }), status: async () => selfsigned });
  strict.touchSocket();
  assert.equal(await runSetup(strict.deps, { ...OPTS, wait: false }), 1);
  assert.match(strict.out.join('\n'), /✖ Tailscale is not installed/);

  // require_tailnet auto + logged in, MagicDNS off: fine for the gate (a certificate would have needed MagicDNS)
  const running = makeDeps({ script: { ...lingerYes, 'tailscale status --json': okRun(JSON.stringify({ ...RUNNING, CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [] })) }, loadConfig: () => ({ tls: { mode: 'selfsigned' }, security: { require_tailnet: 'auto' } }), status: async () => selfsigned });
  running.touchSocket();
  assert.equal(await runSetup(running.deps, OPTS), 0);
  text = running.out.join('\n');
  assert.match(text, /✔ Tailscale running as 100\.64\.0\.7: the tailnet gate can identify your phones/);
  assert.equal(running.calls.some((c) => c.startsWith('tailscale cert')), false);
});

test('a running unit that serves another config dir is never repointed (setup --config-dir B without --unit)', async () => {
  // The unit runs (pid 4242) for config A; this run targets config B, whose control socket answers nobody.
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes },
    status: async () => {
      throw new Error('ENOENT');
    },
  });
  touchSocket();
  const before = fs.existsSync(deps.configPath) ? fs.readFileSync(deps.configPath, 'utf8') : null;
  // --lan on top: the refusal comes before config.json is touched or a certificate requested
  assert.equal(await runSetup(deps, { ...OPTS, lan: true, configDir: '/home/alice/.config/remotly-b' }), 1);
  const text = out.join('\n');
  assert.match(text, /✖ unit remotly-bridge is running \(pid 4242\) but not on this config dir — it serves another instance/);
  assert.match(text, /setup --unit <name> --config-dir <dir>/);
  assert.match(text, /systemctl --user stop remotly-bridge\.service/);
  assert.equal(calls.some((c) => /systemctl --user (enable|restart|daemon-reload)/.test(c)), false, 'nothing written or restarted');
  assert.equal(calls.some((c) => c.startsWith('tailscale cert') || c.startsWith('herdr')), false, 'refused before the herdr and certificate steps');
  assert.equal(fs.existsSync(deps.configPath) ? fs.readFileSync(deps.configPath, 'utf8') : null, before, 'config.json untouched (no LAN triple written)');
  assert.equal(text.includes('LAN mode'), false);
  assert.equal(fs.existsSync(path.join(deps.unitDir, 'remotly-bridge.service')), false);

  // Same, but a daemon with another pid answers on this config dir (a manual `serve` for B): still refused.
  const manual = makeDeps({ script: { ...tsScript(), ...lingerYes }, status: async () => ({ ...STATUS, pid: 999 }) });
  manual.touchSocket();
  assert.equal(await runSetup(manual.deps, OPTS), 1);
  assert.match(manual.out.join('\n'), /✖ unit remotly-bridge is running \(pid 4242\) but not on this config dir/);
});

test('--keep-stopped (what `update` passes): a stopped unit is written and enabled but not restarted, and setup ends there; a running or failed one is restarted; no answer from systemd is not "running"', async () => {
  const noSocket = async () => {
    throw new Error('ENOENT');
  };
  const stopped = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
  stopped.touchSocket();
  assert.equal(await runSetup(stopped.deps, { ...OPTS, keepStopped: true }), 0);
  const text = stopped.out.join('\n');
  assert.match(text, /· service remotly-bridge installed at .*remotly-bridge\.service \(node \/opt\/node\/bin\/node\), but it is inactive: left stopped \(--keep-stopped\);  systemctl --user start remotly-bridge\.service/);
  assert.match(text, /setup complete \(remotly-bridge left stopped\)$/);
  assert.ok(stopped.calls.includes('systemctl --user enable remotly-bridge.service'));
  assert.equal(stopped.calls.some((c) => c === 'systemctl --user restart remotly-bridge.service'), false);
  assert.equal(text.includes('did not answer'), false, 'no health wait for a unit left stopped on purpose');
  assert.ok(fs.existsSync(path.join(stopped.deps.unitDir, 'remotly-bridge.service')), 'the unit file is written all the same');
  // Running: restarted as always (the flag only concerns a stopped unit).
  const running = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  running.touchSocket();
  assert.equal(await runSetup(running.deps, { ...OPTS, keepStopped: true }), 0);
  assert.ok(running.calls.includes('systemctl --user restart remotly-bridge.service'));
  assert.match(running.out.join('\n'), /✔ service remotly-bridge installed/);
  // Failed (a crash loop that hit its start-rate limit): it was running, and this setup may be what repairs it.
  let restarted = false;
  const failed = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: [unitShow('loaded', 'failed', 'failed', 0), unitShow('loaded', 'failed', 'failed', 0), unitShow('loaded', 'failed', 'failed', 0), unitShow('loaded', 'active', 'running', 4242)] }, status: async () => (restarted ? STATUS : noSocket()) });
  const inner = failed.deps.exec;
  failed.deps.exec = async (c, a) => ((restarted ||= c === 'systemctl' && a[1] === 'restart'), inner(c, a));
  failed.touchSocket();
  assert.equal(await runSetup(failed.deps, { ...OPTS, keepStopped: true }), 0);
  assert.ok(failed.calls.includes('systemctl --user restart remotly-bridge.service'));
  // systemd does not answer right before the restart: not started blindly.
  const blind = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: [unitShow('loaded', 'active', 'running', 4242), unitShow('loaded', 'active', 'running', 4242), failRun('Failed to connect to bus: No medium found')] } });
  blind.touchSocket();
  assert.equal(await runSetup(blind.deps, { ...OPTS, keepStopped: true }), 0);
  assert.equal(blind.calls.some((c) => c === 'systemctl --user restart remotly-bridge.service'), false);
  assert.match(blind.out.join('\n'), /but systemd did not say whether it is running: left stopped \(--keep-stopped\)/);
  // Without the flag a stopped unit is started: that is what a hand-run setup means.
  const plain = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
  plain.touchSocket();
  await runSetup(plain.deps, OPTS);
  assert.ok(plain.calls.includes('systemctl --user restart remotly-bridge.service'));
});

test('a unit in its restart delay (MainPID 0 while activating) is left alone, whatever the socket says', async () => {
  const noSocket = async () => {
    throw new Error('ENOENT');
  };
  for (const [active, sub] of [['activating', 'auto-restart'], ['deactivating', 'stop-sigterm'], ['reloading', 'reload'], ['active', 'running']] as const) {
    const pid = active === 'active' ? 0 : 0; // an "active" unit without a main pid has not settled either
    const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', active, sub, pid) }, status: noSocket });
    touchSocket();
    assert.equal(await runSetup(deps, { ...OPTS, configDir: '/home/alice/.config/remotly-b' }), 1, `${active}/${sub}`);
    const text = out.join('\n');
    assert.match(text, new RegExp(`✖ unit remotly-bridge is ${active} \\(${sub}\\) right now — it may be restarting; not touching it until it has settled`));
    assert.match(text, /wait a few seconds and run setup again, or stop it first:\s+systemctl --user stop remotly-bridge\.service/);
    assert.equal(calls.some((c) => /systemctl --user (enable|restart|daemon-reload)/.test(c) || c.startsWith('herdr')), false, 'refused before herdr and before any write');
    assert.equal(fs.existsSync(path.join(deps.unitDir, 'remotly-bridge.service')), false);
  }
});

test('a unit setup derived for another bridge (its herdr service, its updater) is never written over as a bridge unit; a new bridge is not given such a name; a bridge installed under one keeps working', async () => {
  const noSocket = async () => {
    throw new Error('ENOENT');
  };
  const herdrFor = (unit: string) => renderSystemdHerdrUnit({ unit, herdrPath: HERDR_BIN, configHome: '/home/alice/.config' });
  const updater = '[Unit]\nDescription=Remotly bridge update (installs the newest release for alpha)\n\n[Service]\nType=oneshot\nExecStart="/opt/node/bin/node" "/app/src/main.ts" update\n';
  const agent = renderLaunchUpdateAgent({ unit: 'alpha', nodePath: '/opt/node/bin/node', mainPath: '/app/src/main.ts', repairScript: '/Users/alice/.local/share/remotly/repair.sh', home: '/Users/alice', minute: 7 });
  assert.match(agent, /exec "\$1" "\$2" update<\/string>/, 'a release\'s update agent runs through the repair wrapper: `update` ends an argument, no argument is `update`');
  const cases: [string, string, string][] = [
    ['remotly-bridge', herdrFor('remotly-bridge'), 'is the herdr service setup wrote — not writing a bridge unit over it'],
    ['alpha-herdr', herdrFor('alpha').replace(/\n/g, '\r\n'), 'is the herdr service setup wrote for the bridge unit alpha — not writing a bridge unit over it'], // re-saved with CRLF: the marker is still in it
    ['alpha-update', updater, 'is the updater setup wrote for the bridge unit alpha — not writing a bridge unit over it'],
    ['alpha-update', agent, 'is the updater setup wrote for the bridge unit alpha — not writing a bridge unit over it'],
  ];
  let n = 0;
  for (const [unit, text, said] of cases) {
    const d = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
    d.deps.unitDir = path.join(dir, `systemd-derived-${++n}`); // its own unit dir: the cases must not see each other's files
    d.touchSocket();
    fs.mkdirSync(d.deps.unitDir, { recursive: true });
    const unitFile = path.join(d.deps.unitDir, `${unit}.service`);
    fs.writeFileSync(unitFile, text);
    assert.equal(await runSetup(d.deps, { ...OPTS, unit }), 1);
    assert.ok(d.out.join('\n').includes(`  ✖ unit ${unit} ${said}\n      pick another name:  remotly-bridge setup --unit <name>`), d.out.join('\n'));
    assert.equal(fs.readFileSync(unitFile, 'utf8'), text, 'untouched');
    assert.equal(d.calls.some((c) => /systemctl --user (enable|restart|daemon-reload)/.test(c)), false, 'refused before any write');
  }
  // A new bridge under a derived name, nothing at the path: refused outright (bridge alpha's unit would be this file one day).
  for (const [unit, what] of [['alpha-herdr', "alpha's herdr service"], ['alpha-update', "alpha's updater"]] as const) {
    const d = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('not-found', 'inactive', 'dead', 0) }, status: noSocket });
    d.deps.unitDir = path.join(dir, `systemd-derived-${++n}`);
    d.touchSocket();
    assert.equal(await runSetup(d.deps, { ...OPTS, unit }), 1);
    assert.ok(d.out.join('\n').includes(`  ✖ --unit ${unit}: a name ending in -${unit.split('-')[1]} is one setup derives for a bridge (${what} would be this unit) — pick another`), d.out.join('\n'));
    assert.equal(fs.existsSync(path.join(d.deps.unitDir, `${unit}.service`)), false);
  }
  // A derived name whose file is not a bridge unit setup can tell — nothing in it runs `serve`; a plist converted to binary (no comment survives that, so a herdr agent or an updater so converted is told by nothing else) — may be the other bridge's: nothing is written over it.
  const binary = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0x01, 0x02, 0x5f, 0x10, 0x10])]).toString('latin1');
  const plain = renderLaunchAgent({ unit: 'alpha', home: '/Users/alice', nodePath: '/opt/node/bin/node', mainPath: '/app/src/main.ts' });
  const wrapped = renderLaunchAgent({ unit: 'alpha', home: '/Users/alice', nodePath: '/opt/node/bin/node', mainPath: '/app/src/main.ts', repairScript: '/Users/alice/.local/share/remotly/repair.sh' });
  assert.equal(bridgeUnitOfSetup(binary, 'launchd', 'dev.remotly.alpha'), false);
  assert.equal(bridgeUnitOfSetup(plain, 'launchd', 'dev.remotly.alpha'), true);
  assert.equal(bridgeUnitOfSetup(wrapped, 'launchd', 'dev.remotly.alpha'), true, 'through the repair wrapper');
  assert.equal(bridgeUnitOfSetup(plain, 'launchd', 'dev.remotly.alpha-herdr'), false, 'another label: not this unit\'s');
  assert.equal(bridgeUnitOfSetup(plain.replace('<key>ProgramArguments</key>', '<key>Program</key>\n\t<string>/usr/local/bin/worker</string>\n\t<key>ProgramArguments</key>'), 'launchd', 'dev.remotly.alpha'), false, 'a Program key: launchd runs that, whatever the arguments say');
  assert.equal(bridgeUnitOfSetup(plain.replace('<string>serve</string>', '<string>serve</string>\n\t\t<string>--lan</string>'), 'launchd', 'dev.remotly.alpha'), false, 'arguments setup never wrote');
  assert.equal(bridgeUnitOfSetup(agent, 'launchd', 'dev.remotly.alpha'), false);
  assert.equal(bridgeUnitOfSetup(renderLaunchHerdrAgent({ unit: 'alpha', herdrPath: HERDR_BIN, home: '/Users/alice', configHome: '/Users/alice/.config' }), 'launchd', 'dev.remotly.alpha-herdr'), false);
  assert.equal(bridgeUnitOfSetup(renderSystemdUnit({ nodePath: '/opt/node/bin/node', mainPath: '/app/src/main.ts', repairScript: '/home/alice/.local/share/remotly/repair.sh' }), 'systemd'), true);
  assert.equal(bridgeUnitOfSetup('[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart=/opt/node/bin/node /app/src/main.ts serve\n', 'systemd'), true, 'bare words, as an older release may have quoted them');
  assert.equal(bridgeUnitOfSetup('[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart=/usr/local/bin/worker serve\n', 'systemd'), false, 'one word then serve: not node main.ts');
  assert.equal(bridgeUnitOfSetup('[Service]\nExecStart="/opt/node/bin/node" "/app/src/main.ts" serve\n', 'systemd'), false, 'without the Description');
  assert.equal(bridgeUnitOfSetup('[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart="/opt/node/bin/node" "/app/src/main.ts" serve\nExecStart=\nExecStart=/usr/local/bin/foreign\n', 'systemd'), false, 'a reset and another ExecStart after the matching line: systemd runs the other');
  assert.equal(bridgeUnitOfSetup('[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart=/usr/local/bin/first\nExecStart="/opt/node/bin/node" "/app/src/main.ts" serve\n', 'systemd'), false, 'two ExecStart lines: not a simple service of setup\'s');
  assert.equal(bridgeUnitOfSetup(herdrFor('alpha'), 'systemd'), false);
  assert.equal(bridgeUnitOfSetup(updater, 'systemd'), false);
  for (const [unit, text] of [['alpha-update', binary], ['alpha-herdr', '[Unit]\nDescription=something of alice\'s\n\n[Service]\nExecStart=/usr/bin/true\n'], ['alpha-herdr', '[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart=/usr/local/bin/worker serve\n']] as const) {
    const d = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
    d.deps.unitDir = path.join(dir, `systemd-derived-${++n}`);
    d.touchSocket();
    fs.mkdirSync(d.deps.unitDir, { recursive: true });
    const unitFile = path.join(d.deps.unitDir, `${unit}.service`);
    const enc = text === binary ? 'latin1' : 'utf8'; // the binary plist's bytes as they are
    fs.writeFileSync(unitFile, text, enc);
    assert.equal(await runSetup(d.deps, { ...OPTS, unit }), 1);
    assert.ok(d.out.join('\n').includes(`  ✖ unit ${unit}: ${unitFile} is not a bridge unit setup can tell (not what setup writes for one) — not writing a bridge unit over what may be alpha's ${unit === 'alpha-herdr' ? 'herdr service' : 'updater'}`), d.out.join('\n'));
    assert.equal(fs.readFileSync(unitFile, enc), text, 'untouched');
  }
  // A derived name whose file cannot be read: what it is cannot be told, so nothing is written over it.
  if (process.getuid?.() !== 0) {
    const sealed = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
    sealed.deps.unitDir = path.join(dir, `systemd-derived-${++n}`);
    sealed.touchSocket();
    fs.mkdirSync(sealed.deps.unitDir, { recursive: true });
    fs.writeFileSync(path.join(sealed.deps.unitDir, 'alpha-update.service'), updater, { mode: 0o000 });
    assert.equal(await runSetup(sealed.deps, { ...OPTS, unit: 'alpha-update' }), 1);
    assert.ok(sealed.out.join('\n').includes(`  ✖ unit alpha-update: ${path.join(sealed.deps.unitDir, 'alpha-update.service')} cannot be read — not writing a bridge unit over what may be alpha's updater`), sealed.out.join('\n'));
  }
  // A bridge installed under such a name before this check (its own unit at the path): its unattended update runs setup under that name, and is not refused —
  // whatever its environment mentions (a config dir named like the updater's Description is no updater).
  const legacy = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: noSocket });
  legacy.deps.unitDir = path.join(dir, `systemd-derived-${++n}`);
  legacy.touchSocket();
  fs.mkdirSync(legacy.deps.unitDir, { recursive: true });
  const legacyFile = path.join(legacy.deps.unitDir, 'alpha-update.service');
  fs.writeFileSync(legacyFile, `[Unit]\nDescription=Remotly bridge (herdr → phone)\n\n[Service]\nExecStart="/opt/node/bin/node" "/app/src/main.ts" serve\nEnvironment="REMOTLY_CONFIG_DIR=/home/alice/Remotly bridge update, ${HERDR_UNIT_MARKER}"\n`);
  assert.equal(derivedUnitKind(fs.readFileSync(legacyFile, 'utf8')), null, 'a value holding the words of the marker, or the updater\'s Description, is neither');
  assert.equal(derivedUnitKind(renderLaunchAgent({ unit: 'alpha', home: '/Users/alice', nodePath: '/opt/node/bin/node', mainPath: '/app/src/main.ts', configDir: `/Users/alice/${HERDR_UNIT_MARKER}` })), null, 'a plist value holding the words: not the XML comment');
  assert.equal(derivedUnitKind(renderLaunchHerdrAgent({ unit: 'alpha', herdrPath: HERDR_BIN, home: '/Users/alice', configHome: '/Users/alice/.config' }).replace(/\n/g, '\r\n')), 'herdr service');
  assert.equal(derivedUnitKind(herdrFor('alpha').replace(/\n/g, '\r\n')), 'herdr service');
  assert.equal(derivedUnitKind(agent), 'updater');
  assert.equal(derivedUnitKind(updater), 'updater');
  assert.equal(await runSetup(legacy.deps, { ...OPTS, unit: 'alpha-update', keepStopped: true }), 0, legacy.out.join('\n'));
  assert.equal(legacy.out.join('\n').includes('✖'), false);
  assert.match(fs.readFileSync(legacyFile, 'utf8'), /^ExecStart=.* serve$/m, 'rewritten as the bridge unit it is');
});

test('a masked unit, or one systemd could not load, is never written over', async () => {
  const noSocket = async () => {
    throw new Error('ENOENT');
  };
  const masked = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('masked', 'inactive', 'dead', 0) }, status: noSocket });
  masked.touchSocket();
  assert.equal(await runSetup(masked.deps, OPTS), 1);
  assert.match(masked.out.join('\n'), /✖ unit remotly-bridge is masked — not writing over that\n\s+to use this name again:\s+systemctl --user unmask remotly-bridge\.service/);
  assert.equal(fs.existsSync(path.join(masked.deps.unitDir, 'remotly-bridge.service')), false);
  for (const load of ['bad-setting', 'error', 'stub']) {
    const broken = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow(load, 'inactive', 'dead', 0) }, status: noSocket });
    broken.touchSocket();
    assert.equal(await runSetup(broken.deps, OPTS), 1, load);
    assert.match(broken.out.join('\n'), new RegExp(`✖ unit remotly-bridge is in load state "${load}" — systemd could not read it`));
    assert.equal(broken.calls.some((c) => /systemctl --user (enable|restart|daemon-reload)/.test(c)), false);
  }
  // an answer without the four properties is no answer: with a unit file present, hands off
  const odd = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: okRun('LoadState=loaded\n') }, status: noSocket });
  odd.touchSocket();
  fs.mkdirSync(odd.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(odd.deps.unitDir, 'remotly-bridge.service'), 'old');
  assert.equal(await runSetup(odd.deps, OPTS), 1);
  assert.match(odd.out.join('\n'), /systemd did not say whether unit remotly-bridge is running/);
  assert.equal(fs.readFileSync(path.join(odd.deps.unitDir, 'remotly-bridge.service'), 'utf8'), 'old');
});

test('when systemd does not answer, an existing unit file is not touched; without one the systemd check explains', async () => {
  const silent = { [SHOW]: { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } as ExecResult };
  const withFile = makeDeps({
    script: { ...tsScript(), ...lingerYes, ...silent },
    status: async () => {
      throw new Error('ENOENT');
    },
  });
  withFile.touchSocket();
  fs.mkdirSync(withFile.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(withFile.deps.unitDir, 'remotly-bridge.service'), '[Service]\nExecStart=/old\n');
  assert.equal(await runSetup(withFile.deps, OPTS), 1);
  assert.match(withFile.out.join('\n'), /✖ systemd did not say whether unit remotly-bridge is running \(systemctl --user show failed\) — not touching its unit file\n\s+check:\s+systemctl --user status remotly-bridge\.service/);
  assert.equal(fs.readFileSync(path.join(withFile.deps.unitDir, 'remotly-bridge.service'), 'utf8'), '[Service]\nExecStart=/old\n');
  fs.rmSync(path.join(withFile.deps.unitDir, 'remotly-bridge.service')); // same temp dir within one test

  const noFile = makeDeps({
    script: { ...tsScript(), ...silent, 'systemctl --user show-environment': { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } as ExecResult },
    status: async () => {
      throw new Error('ENOENT');
    },
  });
  noFile.touchSocket();
  assert.equal(await runSetup(noFile.deps, { ...OPTS, wait: false }), 1);
  assert.match(noFile.out.join('\n'), /✖ .*systemd/i);
  assert.equal(noFile.out.join('\n').includes('did not say whether'), false, 'no unit file: nothing to protect, the systemd check speaks');
});

test('the ownership check is repeated right before the unit is written: a unit that came up meanwhile is not repointed', async () => {
  // First look: the unit is inactive (a fresh second instance, say). While setup waited for herdr, the old unit — which
  // serves another config dir — came back (pid 4242, no socket on this config dir): the second look refuses.
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes, [SHOW]: [unitShow('loaded', 'inactive', 'dead', 0), unitShow('loaded', 'active', 'running', 4242)] },
    status: async () => {
      throw new Error('ENOENT');
    },
  });
  touchSocket();
  assert.equal(await runSetup(deps, { ...OPTS, configDir: '/home/alice/.config/remotly-b' }), 1);
  const text = out.join('\n');
  assert.match(text, /✔ herdr/);
  assert.match(text, /✔ certificate/);
  assert.match(text, /✖ unit remotly-bridge is running \(pid 4242\) but not on this config dir/);
  assert.equal(calls.filter((c) => c.startsWith(SHOW)).length, 2, 'looked twice: before the waits and before the write');
  assert.equal(calls.some((c) => /systemctl --user (enable|restart|daemon-reload)/.test(c)), false);
  assert.equal(fs.existsSync(path.join(deps.unitDir, 'remotly-bridge.service')), false);
});

test('a daemon already serving this config dir that is not the unit stops setup before the unit is written', async () => {
  // The existing daemon (pid 999) answers on the socket; the unit is not running (MainPID 0).
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes, [SHOW]: unitShow('loaded', 'inactive', 'dead', 0) }, status: async () => ({ ...STATUS, pid: 999 }) });
  touchSocket();
  assert.equal(await runSetup(deps, { ...OPTS, unit: 'remotly-dev' }), 1);
  assert.match(out.join('\n'), /✖ another remotly-bridge \(pid 999\) already serves this config dir .* not unit remotly-dev\n\s+a second instance needs its own --config-dir/);
  assert.equal(calls.some((c) => c.startsWith('systemctl --user restart') || c.startsWith('systemctl --user enable')), false);
  assert.equal(fs.existsSync(path.join(deps.unitDir, 'remotly-dev.service')), false);
});

test('after the restart, a daemon with another pid on the socket is not health: the journal is shown and setup fails', async () => {
  let answered = 0;
  const { deps, out, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes, ...freshUnit(), 'journalctl --user -u remotly-bridge.service': okRun('main.ts: another remotly-bridge is already listening on …/remotly.sock\n') },
    // Nobody answers before the restart (both ownership looks pass); afterwards a foreign daemon (pid 7) answers.
    status: async () => {
      if (answered++ < 2) throw new Error('ENOENT');
      return { ...STATUS, pid: 7 };
    },
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  const text = out.join('\n');
  assert.match(text, /✖ a remotly-bridge \(pid 7\) answers on this config dir, but it is not unit remotly-bridge/);
  assert.match(text, /journal of remotly-bridge:\n\s+main.ts: another remotly-bridge is already listening/);
});

test('an old daemon without a pid in its status never counts as healthy', async () => {
  let answered = 0;
  const { pid: _pid, ...legacy } = STATUS;
  const { deps, out, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes, ...freshUnit() },
    status: async () => {
      if (answered++ < 2) throw new Error('ENOENT'); // silent through both ownership looks
      return legacy;
    },
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  assert.match(out.join('\n'), /✖ a remotly-bridge answers on this config dir, but it is not unit remotly-bridge/);
});

test('--no-wait stops at the first failing check with its fix and touches nothing', async () => {
  const { deps, out, calls } = makeDeps({ script: { 'herdr --version': missing() } });
  assert.equal(await runSetup(deps, { ...OPTS, wait: false }), 1);
  const text = out.join('\n');
  assert.match(text, /✖ herdr is not running/);
  assert.match(text, new RegExp(HERDR_INSTALL.replace(/[|]/g, '\\|')));
  assert.equal(calls.some((c) => (c.startsWith('systemctl') && !c.includes('MainPID') && !c.includes('show-environment')) || c.startsWith('tailscale')), false, 'queries only: nothing written, enabled or started');
  assert.equal(fs.existsSync(deps.unitDir), false);
});

test('waiting: herdr appears later, the problem is announced once, and setup carries on', async () => {
  const { deps, out, sock } = makeDeps({ script: { 'herdr --version': okRun('herdr 0.8.0'), ...tsScript(), ...lingerYes } });
  let polls = 0;
  const realSleep = deps.sleep;
  deps.sleep = async (ms) => {
    await realSleep(ms);
    if (++polls === 2) fs.writeFileSync(sock, '');
  };
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.equal(text.match(/✖ herdr is not running/g)?.length, 1, 'announced once, not on every poll');
  assert.match(text, /start it: run  herdr  in another terminal/);
  assert.match(text, /waiting — setup continues by itself/);
  assert.match(text, /✔ herdr 0\.8\.0/);
});

test('waiting: the announced problem changes as the user progresses (login, then MagicDNS, then certificates)', async () => {
  const states: (TailscaleStatus | null)[] = [{ BackendState: 'NeedsLogin' }, { ...RUNNING, CurrentTailnet: { MagicDNSEnabled: false } }, { ...RUNNING, CertDomains: [] }, RUNNING];
  const { deps, out, touchSocket } = makeDeps({ script: { 'tailscale status --json': states.map((s) => okRun(JSON.stringify(s))), ...lingerYes } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.match(text, /✖ Tailscale is not logged in[\s\S]*✖ MagicDNS is off[\s\S]*✖ HTTPS Certificates are not enabled[\s\S]*✔ Tailscale running/);
});

test('certificate: "access denied" prints the operator command and polls until it works', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), 'tailscale cert': [failRun('Access denied: cert access denied'), okRun()], ...lingerYes },
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.match(text, /✖ Tailscale refuses certificate requests from this user\n\s+sudo tailscale set --operator=alice/);
  assert.match(text, /✔ certificate for host\.tail1234\.ts\.net/);
  assert.equal(calls.filter((c) => c.startsWith('tailscale cert')).length, 2);
});

test('certificate: an unexplained failure is reported once and setup continues to the service', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({
    script: { ...tsScript(), 'tailscale cert': failRun('acme: rate limited'), ...lingerYes },
    status: async () => ({ ...STATUS, tls: { mode: 'selfsigned', not_after: 'x', fingerprint: 'f' } }),
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.match(text, /✖ tailscale cert failed: acme: rate limited/);
  assert.match(text, /continuing without it/);
  assert.match(text, /⚠ self-signed certificate in use — iPhones refuse it/);
  assert.equal(calls.filter((c) => c.startsWith('tailscale cert')).length, 1, 'no polling against Let\'s Encrypt');
  assert.ok(calls.includes('systemctl --user restart remotly-bridge.service'));
});

test('--lan skips Tailscale and the certificate, writes the LAN keys to config.json and needs openssl', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: lingerYes, status: async () => ({ ...STATUS, tls: { mode: 'selfsigned', not_after: 'x', fingerprint: 'f' } }) });
  touchSocket();
  fs.writeFileSync(deps.configPath, JSON.stringify({ listen: { port: 7461 } }));
  assert.equal(await runSetup(deps, { ...OPTS, lan: true }), 0);
  assert.equal(calls.some((c) => c.startsWith('tailscale')), false);
  assert.ok(calls.includes('openssl version'), 'self-signed certificates need openssl on the host');
  assert.match(out.join('\n'), /⚠ LAN mode: tls\.mode, listen\.host, security\.require_tailnet written to config\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(deps.configPath, 'utf8')), { listen: { port: 7461, host: '0.0.0.0' }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false } });
  assert.equal(out.join('\n').includes('iPhones refuse it; once'), false, 'no second warning about the self-signed certificate in LAN mode');

  const noOpenssl = makeDeps({ script: { ...lingerYes, 'openssl version': missing() } });
  noOpenssl.touchSocket();
  assert.equal(await runSetup(noOpenssl.deps, { ...OPTS, lan: true }), 1);
  assert.match(noOpenssl.out.join('\n'), /✖ openssl not found[\s\S]*sudo apt install openssl/);
  assert.equal(noOpenssl.calls.some((c) => c.startsWith('systemctl') && !c.includes('MainPID') && !c.includes('show-environment')), false, 'stops before touching the unit');
});

test('a Tailscale certificate failure that falls back to self-signed also checks openssl', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), 'tailscale cert': failRun('acme: rate limited'), 'openssl version': missing(), ...lingerYes } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  assert.match(out.join('\n'), /continuing without it[\s\S]*✖ openssl not found/);
  assert.equal(calls.some((c) => c.startsWith('systemctl') && !c.includes('MainPID') && !c.includes('show-environment')), false, 'queries only: nothing written, enabled or started');
});

test('unit options land in the unit file and env; linger is enabled when off', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), 'loginctl show-user': [okRun('no\n'), okRun('yes\n')] }, env: { REMOTLY_TAILSCALE: '/opt/ts/tailscale' } });
  touchSocket();
  const code = await runSetup(deps, { ...OPTS, unit: 'remotly-dev', configDir: '/home/alice/.config/remotly-dev', herdrSession: 'dev', pair: false });
  assert.equal(code, 0);
  const unit = fs.readFileSync(path.join(deps.unitDir, 'remotly-dev.service'), 'utf8');
  assert.match(unit, /^Environment="REMOTLY_CONFIG_DIR=\/home\/alice\/.config\/remotly-dev"$/m);
  assert.match(unit, /^Environment="HERDR_SESSION=dev"$/m);
  assert.match(unit, /^Environment="REMOTLY_TAILSCALE=\/opt\/ts\/tailscale"$/m, 'REMOTLY_TAILSCALE as setup ran with it');
  assert.equal(fs.statSync(path.join(deps.unitDir, 'remotly-dev.service')).mode & 0o777, 0o644);
  assert.ok(calls.includes('systemctl --user enable remotly-dev.service'));
  assert.ok(calls.includes('loginctl enable-linger'));
  assert.match(out.join('\n'), /linger enabled/);
  assert.equal(out.join('\n').includes('QR '), false, '--no-pair');
});

test('linger that cannot be enabled is a warning with the sudo line, not a failure', async () => {
  const { deps, out, touchSocket } = makeDeps({ script: { ...tsScript(), 'loginctl show-user': okRun('no\n'), 'loginctl enable-linger': failRun('Access denied') } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  assert.match(out.join('\n'), /⚠ the bridge stops when you log out; run once:  sudo loginctl enable-linger alice/);
});

test('no systemd user session: stops with the fix before writing anything', async () => {
  const { deps, out, touchSocket } = makeDeps({ script: { ...tsScript(), 'systemctl --user show-environment': failRun('Failed to connect to bus: No medium found') } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  assert.match(out.join('\n'), /✖ no systemd user session for alice: Failed to connect to bus/);
  assert.match(out.join('\n'), /XDG_RUNTIME_DIR/);
  assert.equal(fs.existsSync(deps.unitDir), false);
});

test('a unit that never answers: journal excerpt and exit 1', async () => {
  const { deps, out, touchSocket } = makeDeps({
    script: { ...tsScript(), ...lingerYes, ...freshUnit(), 'journalctl --user -u remotly-bridge.service': okRun('Sep 16 10:00:00 host node[1]: config.json: listen.port must be an integer\n') },
    status: async () => {
      throw new Error('ENOENT');
    },
  });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  const text = out.join('\n');
  assert.match(text, /waiting for the bridge to start…/);
  assert.match(text, /✖ the bridge did not answer within 90 s\n\s+journal of remotly-bridge:\n\s+Sep 16 10:00:00 host node\[1\]: config.json: listen.port/);
});

test('root, a broken config and a herdr protocol mismatch are reported the way the user sees them', async () => {
  const asRoot = makeDeps({ uid: 0 });
  assert.equal(await runSetup(asRoot.deps, OPTS), 1);
  assert.match(asRoot.out.join('\n'), /not as root/);

  const badConfig = makeDeps({
    loadConfig: () => {
      throw new Error('config.json: listen.port must be an integer 1-65535 (got "x")');
    },
  });
  assert.equal(await runSetup(badConfig.deps, OPTS), 1);
  assert.match(badConfig.out.join('\n'), /✖ config.json: listen.port must be an integer/);

  const mismatch = makeDeps({ script: { ...tsScript(), ...lingerYes }, herdrPing: async () => ({ version: '0.9.0', protocol: 20 }) });
  mismatch.touchSocket();
  assert.equal(await runSetup(mismatch.deps, OPTS), 0);
  assert.match(mismatch.out.join('\n'), /✔ herdr 0\.9\.0 \(protocol 20\) at .*\n\s+⚠ this bridge was built against herdr protocol 19/);
});

// ---- the daily update timer ---------------------------------------------------------------------

/** Turns makeDeps' `dir/app/src/main.ts` into an installed release (package.json beside src/), as install.sh lays it out. */
function asRelease(deps: SetupDeps): void {
  fs.mkdirSync(path.dirname(deps.mainPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(path.dirname(deps.mainPath)), 'package.json'), '{"version":"0.1.0"}');
}
const UPDATE_TIMER = 'remotly-bridge-update.timer';

test('renderUpdateUnits: a oneshot `update` with the bridge\'s environment, and a daily persistent timer', () => {
  const { service, timer } = renderUpdateUnits({ unit: 'remotly-dev', nodePath: '/opt/node/bin/node', mainPath: '/h/app/src/main.ts', configDir: '/h/cfg', herdrSession: 'work', herdrSocket: '/h/herdr.sock' });
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart="\/opt\/node\/bin\/node" "\/h\/app\/src\/main\.ts" update$/m);
  for (const env of ['REMOTLY_SYSTEMD_UNIT=remotly-dev', 'REMOTLY_CONFIG_DIR=/h/cfg', 'HERDR_SESSION=work', 'HERDR_SOCKET_PATH=/h/herdr.sock']) assert.ok(service.includes(`Environment="${env}"`), env);
  assert.equal(service.includes('[Install]'), false, 'the service is started by the timer, never enabled itself');
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^RandomizedDelaySec=1h$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  const plain = renderUpdateUnits({ unit: 'remotly-bridge', nodePath: '/usr/bin/node', mainPath: '/h/app/src/main.ts' });
  assert.equal(plain.service.match(/^Environment=/gm)?.length, 2, 'NODE_ENV and the unit only');
  const mirror = renderUpdateUnits({ unit: 'remotly-bridge', nodePath: '/usr/bin/node', mainPath: '/h/app/src/main.ts', installerEnv: { REMOTLY_RELEASE_URL: 'https://mirror.example/releases', REMOTLY_NODE_DIST: 'https://mirror.example/node', REMOTLY_BIN_DIR: '/h/bin', REMOTLY_NODE: '/usr/bin/node', REMOTLY_VERSION: '0.1.0' } });
  for (const env of ['REMOTLY_RELEASE_URL=https://mirror.example/releases', 'REMOTLY_NODE_DIST=https://mirror.example/node', 'REMOTLY_BIN_DIR=/h/bin', 'REMOTLY_NODE=/usr/bin/node']) assert.ok(mirror.service.includes(`Environment="${env}"`), env);
  assert.equal(mirror.service.includes('REMOTLY_VERSION'), false, 'the pinned version of one install never reaches the unit');
  assert.deepEqual(updateUnitNames('remotly-dev.service'), { service: 'remotly-dev-update.service', timer: 'remotly-dev-update.timer' });
  assert.deepEqual(updateUnitNames('remotly-bridge'), { service: 'remotly-bridge-update.service', timer: UPDATE_TIMER });
});

test('parseSetupArgs: --no-auto-update', () => {
  assert.equal(parseSetupArgs([], {}).autoUpdate, undefined);
  assert.equal(parseSetupArgs(['--no-auto-update'], {}).autoUpdate, false);
});

test('installerEnv: the mirror and launcher settings from the environment, the launcher found on PATH otherwise, the unit\'s Node unless it is the private one', () => {
  const home = path.join(dir, 'h');
  const bin = path.join(home, 'bin');
  const mainPath = path.join(home, 'app', 'src', 'main.ts');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'remotly-bridge'), `#!/bin/sh\nexec '/usr/bin/node' '${mainPath}' "$@"\n`);
  assert.deepEqual(installerEnv({ PATH: `/usr/bin:${bin}` }, '/usr/bin/node', mainPath, home), { REMOTLY_BIN_DIR: bin, REMOTLY_NODE: '/usr/bin/node' });
  assert.deepEqual(installerEnv({ PATH: '/usr/bin' }, path.join(home, 'node', 'bin', 'node'), mainPath, home), {}, 'no launcher on PATH, a private Node');
  assert.deepEqual(installerEnv({ REMOTLY_RELEASE_URL: 'https://mirror.example/releases ', REMOTLY_NODE_DIST: 'https://mirror.example/node', REMOTLY_BIN_DIR: '/opt/bin', REMOTLY_VERSION: '0.1.0', REMOTLY_HOME: home, PATH: bin }, '/usr/bin/node', mainPath, home), {
    REMOTLY_RELEASE_URL: 'https://mirror.example/releases',
    REMOTLY_NODE_DIST: 'https://mirror.example/node',
    REMOTLY_BIN_DIR: '/opt/bin',
    REMOTLY_NODE: '/usr/bin/node',
  });
});

test('an installed release gets the update timer on its first setup: both units written, daemon-reload, enable, restart', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  asRelease(deps);
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  const text = out.join('\n');
  assert.match(text, /✔ daily update remotly-bridge-update\.timer \(runs `remotly-bridge update`; off:  systemctl --user disable --now remotly-bridge-update\.timer\)/);
  assert.equal(text.includes('⚠'), false);
  const service = fs.readFileSync(path.join(deps.unitDir, 'remotly-bridge-update.service'), 'utf8');
  assert.match(service, new RegExp(`^ExecStart="/opt/node/bin/node" "${deps.mainPath}" update$`, 'm'));
  assert.match(service, /^Environment="REMOTLY_SYSTEMD_UNIT=remotly-bridge"$/m);
  assert.match(service, /^Environment="REMOTLY_NODE=\/opt\/node\/bin\/node"$/m, 'the runtime the unit runs goes to the installer');
  assert.match(fs.readFileSync(path.join(deps.unitDir, UPDATE_TIMER), 'utf8'), /^OnCalendar=daily$/m);
  // Both units run the repair script first; setup wrote it beside app/.
  const home = path.dirname(path.dirname(path.dirname(deps.mainPath)));
  const repair = repairScriptPath(home);
  assert.ok(fs.existsSync(repair), 'repair-app.sh written');
  assert.equal(fs.statSync(repair).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(timerMarkerPath(path.dirname(repair), 'remotly-bridge')), false, 'the "enabling" marker is gone once the timer is enabled');
  assert.match(service, new RegExp(`^ExecStartPre=-/bin/sh "${repair}"$`, 'm'));
  assert.match(fs.readFileSync(path.join(deps.unitDir, 'remotly-bridge.service'), 'utf8'), new RegExp(`^ExecStartPre=-/bin/sh "${repair}"$`, 'm'));
  const sd = calls.filter((c) => c.startsWith('systemctl') && !c.includes('MainPID'));
  assert.deepEqual(sd, [
    'systemctl --user show-environment',
    'systemctl --user daemon-reload',
    'systemctl --user enable remotly-bridge.service',
    'systemctl --user restart remotly-bridge.service',
    `systemctl --user is-enabled ${UPDATE_TIMER}`,
    'systemctl --user is-enabled remotly-bridge-update.service',
    'systemctl --user daemon-reload',
    `systemctl --user enable ${UPDATE_TIMER}`,
    `systemctl --user restart ${UPDATE_TIMER}`,
  ]);

  // The installer's settings travel from setup's environment into the unit, so the timer installs the same way.
  const mirror = makeDeps({ script: { ...tsScript(), ...lingerYes }, env: { REMOTLY_RELEASE_URL: 'https://mirror.example/releases', REMOTLY_NODE_DIST: 'https://mirror.example/node', REMOTLY_BIN_DIR: '/opt/remotly/bin', REMOTLY_VERSION: '0.1.0' } });
  mirror.deps.unitDir = path.join(dir, 'systemd-mirror');
  asRelease(mirror.deps);
  mirror.touchSocket();
  assert.equal(await runSetup(mirror.deps, OPTS), 0);
  const unit = fs.readFileSync(path.join(mirror.deps.unitDir, 'remotly-bridge-update.service'), 'utf8');
  for (const env of ['REMOTLY_RELEASE_URL=https://mirror.example/releases', 'REMOTLY_NODE_DIST=https://mirror.example/node', 'REMOTLY_BIN_DIR=/opt/remotly/bin']) assert.ok(unit.includes(`Environment="${env}"`), env);
  assert.equal(unit.includes('REMOTLY_VERSION'), false);
});

test('a timer the user disabled stays disabled on later setups (rewritten, reloaded, not enabled); a masked one is not even rewritten', async () => {
  const disabled = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'disabled\n', stderr: '' } } });
  asRelease(disabled.deps);
  fs.mkdirSync(disabled.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(disabled.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  disabled.touchSocket();
  assert.equal(await runSetup(disabled.deps, OPTS), 0);
  assert.match(disabled.out.join('\n'), /· auto-update off \(remotly-bridge-update\.timer is disabled\); on:  systemctl --user enable --now remotly-bridge-update\.timer/);
  assert.match(fs.readFileSync(path.join(disabled.deps.unitDir, UPDATE_TIMER), 'utf8'), /^OnCalendar=daily$/m, 'the unit text follows this install');
  assert.equal(disabled.calls.some((c) => c.includes(`enable ${UPDATE_TIMER}`) || c.includes(`restart ${UPDATE_TIMER}`)), false);
  assert.equal(disabled.calls.filter((c) => c === 'systemctl --user daemon-reload').length, 2);

  const masked = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'masked\n', stderr: '' } } });
  masked.deps.unitDir = path.join(dir, 'systemd-masked'); // its own unit dir: the case above wrote the timer units
  asRelease(masked.deps);
  fs.mkdirSync(masked.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(masked.deps.unitDir, UPDATE_TIMER), '# mask stand-in\n');
  masked.touchSocket();
  assert.equal(await runSetup(masked.deps, OPTS), 0);
  assert.match(masked.out.join('\n'), /· auto-update off: remotly-bridge-update\.timer is masked/);
  assert.equal(fs.readFileSync(path.join(masked.deps.unitDir, UPDATE_TIMER), 'utf8'), '# mask stand-in\n', 'not rewritten');
  assert.equal(fs.existsSync(path.join(masked.deps.unitDir, 'remotly-bridge-update.service')), false);
  assert.equal(masked.calls.filter((c) => c === 'systemctl --user daemon-reload').length, 1);

  // A masked service (the timer would fail every day) counts the same; `masked-runtime` too.
  const maskedService = makeDeps({ script: { ...tsScript(), ...lingerYes, 'systemctl --user is-enabled remotly-bridge-update.service': okRun('masked-runtime\n') } });
  maskedService.deps.unitDir = path.join(dir, 'systemd-masked-service');
  asRelease(maskedService.deps);
  fs.mkdirSync(maskedService.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(maskedService.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  maskedService.touchSocket();
  assert.equal(await runSetup(maskedService.deps, OPTS), 0);
  assert.match(maskedService.out.join('\n'), /· auto-update off: remotly-bridge-update\.service is masked \(systemctl --user unmask remotly-bridge-update\.service, then setup again, turns it on\)/);
  assert.equal(fs.readFileSync(path.join(maskedService.deps.unitDir, UPDATE_TIMER), 'utf8'), OLD_TIMER, 'not rewritten');

  // Enabled until the next boot only (`enable --runtime`): made permanent like a fresh one.
  const runtime = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: okRun('enabled-runtime\n') } });
  runtime.deps.unitDir = path.join(dir, 'systemd-runtime');
  asRelease(runtime.deps);
  fs.mkdirSync(runtime.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  runtime.touchSocket();
  assert.equal(await runSetup(runtime.deps, OPTS), 0);
  assert.ok(runtime.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`));
  assert.match(runtime.out.join('\n'), /✔ daily update remotly-bridge-update\.timer/);

  // Started by hand but never enabled: stays the user's business, with a word on what that means.
  const started = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`systemctl --user is-active ${UPDATE_TIMER}`]: okRun('active\n') } });
  started.deps.unitDir = path.join(dir, 'systemd-started');
  asRelease(started.deps);
  fs.mkdirSync(started.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(started.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  started.touchSocket();
  assert.equal(await runSetup(started.deps, OPTS), 0);
  assert.match(started.out.join('\n'), /· auto-update off \(remotly-bridge-update\.timer is disabled, started by hand: it runs until the next boot only\); on:  systemctl --user enable --now remotly-bridge-update\.timer/);

  // A masked timer that lives nowhere in this unit dir (a runtime mask under /run, or a mask in another directory) is
  // found through is-enabled and respected on the very first setup: nothing written.
  const elsewhere = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'masked-runtime\n', stderr: '' } } });
  elsewhere.deps.unitDir = path.join(dir, 'systemd-elsewhere');
  asRelease(elsewhere.deps);
  elsewhere.touchSocket();
  assert.equal(await runSetup(elsewhere.deps, OPTS), 0);
  assert.match(elsewhere.out.join('\n'), /· auto-update off: remotly-bridge-update\.timer is masked/);
  assert.equal(fs.existsSync(path.join(elsewhere.deps.unitDir, UPDATE_TIMER)), false);

  // A setup stopped after writing the timer but before enabling it left the marker behind: that "disabled" is not the
  // user's choice either.
  const interrupted = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'disabled\n', stderr: '' } } });
  interrupted.deps.unitDir = path.join(dir, 'systemd-interrupted');
  asRelease(interrupted.deps);
  fs.mkdirSync(interrupted.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(interrupted.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  const interruptedHome = path.dirname(path.dirname(path.dirname(interrupted.deps.mainPath)));
  fs.writeFileSync(timerMarkerPath(interruptedHome, 'remotly-bridge'), '');
  interrupted.touchSocket();
  assert.equal(await runSetup(interrupted.deps, OPTS), 0);
  assert.ok(interrupted.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`), interrupted.calls.join(' | '));
  assert.equal(fs.existsSync(timerMarkerPath(interruptedHome, 'remotly-bridge')), false, 'the marker goes once the timer is enabled');
  assert.equal(path.basename(timerMarkerPath(interruptedHome, 'remotly-dev')), 'remotly-dev-update.timer.enabling', 'one marker per timer: two units may share one install');

  // A service file left by a setup stopped before it wrote the timer: systemd knows no timer (not-found, exit 4), so
  // this is a fresh install, not the user's choice.
  const partial = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 4, stdout: 'not-found\n', stderr: `Failed to get unit file state for ${UPDATE_TIMER}: No such file or directory` } } });
  partial.deps.unitDir = path.join(dir, 'systemd-partial');
  asRelease(partial.deps);
  fs.mkdirSync(partial.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(partial.deps.unitDir, 'remotly-bridge-update.service'), '[Unit]\nDescription=Remotly bridge update (installs the newest release for remotly-bridge)\n# the rest as setup wrote it, whole: the write is a rename\n');
  partial.touchSocket();
  assert.equal(await runSetup(partial.deps, OPTS), 0);
  assert.ok(partial.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`));
  assert.match(partial.out.join('\n'), /✔ daily update remotly-bridge-update\.timer/);
});

test('a failed `is-enabled` query (no bus, an error) leaves the update units as they are: nothing written, nothing enabled', async () => {
  const nobus = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } } });
  nobus.deps.unitDir = path.join(dir, 'systemd-nobus');
  asRelease(nobus.deps);
  nobus.touchSocket();
  assert.equal(await runSetup(nobus.deps, OPTS), 0);
  assert.match(nobus.out.join('\n'), /⚠ cannot tell whether remotly-bridge-update\.timer is enabled \(systemctl --user is-enabled remotly-bridge-update\.timer: exit 1, Failed to connect to bus: No medium found\); the update units are left as they are/);
  assert.equal(fs.existsSync(path.join(nobus.deps.unitDir, UPDATE_TIMER)), false);
  assert.equal(fs.existsSync(path.join(nobus.deps.unitDir, 'remotly-bridge-update.service')), false);
  assert.equal(nobus.calls.some((c) => c.includes(`enable ${UPDATE_TIMER}`)), false);
  // An answer that is no state at all (exit 0, nothing printed) is not "fresh" either.
  const mute = makeDeps({ script: { ...tsScript(), ...lingerYes, 'systemctl --user is-enabled remotly-bridge-update.service': okRun('') } });
  mute.deps.unitDir = path.join(dir, 'systemd-mute');
  asRelease(mute.deps);
  mute.touchSocket();
  assert.equal(await runSetup(mute.deps, OPTS), 0);
  assert.match(mute.out.join('\n'), /cannot tell whether .*: exit 0, no output/);
  assert.equal(fs.existsSync(path.join(mute.deps.unitDir, UPDATE_TIMER)), false);
  // An older systemd that prints nothing and complains on stderr means the same as `not-found`: a fresh install. (The
  // timer's own key, so this answer — not the default `not-found` — is what the code reads.)
  const older = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: '', stderr: `Failed to get unit file state for ${UPDATE_TIMER}: No such file or directory` } } });
  older.deps.unitDir = path.join(dir, 'systemd-older');
  asRelease(older.deps);
  older.touchSocket();
  assert.equal(await runSetup(older.deps, OPTS), 0);
  assert.equal(older.out.join('\n').includes('cannot tell whether'), false, older.out.join('\n'));
  assert.ok(older.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`));
  // A bus that is not there says "No such file" too: that is no state, not a fresh install.
  const nosock = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' } } });
  nosock.deps.unitDir = path.join(dir, 'systemd-nosock');
  asRelease(nosock.deps);
  nosock.touchSocket();
  assert.equal(await runSetup(nosock.deps, OPTS), 0);
  assert.match(nosock.out.join('\n'), /cannot tell whether .*: exit 1, Failed to connect to bus: No such file or directory/);
  assert.equal(fs.existsSync(path.join(nosock.deps.unitDir, UPDATE_TIMER)), false);
  assert.equal(nosock.calls.some((c) => c.includes(`enable ${UPDATE_TIMER}`)), false);
});

test('renderRepairScript: puts app/ back from app.prev, else app.new, and a private node/ back from node.old; leaves what is present alone, and everything alone while an install holds the lock', () => {
  const home = path.join(dir, "h'ome"); // a quote in the path is quoted for the shell
  const app = path.join(home, 'app');
  fs.mkdirSync(home, { recursive: true });
  const script = path.join(dir, 'repair-app.sh');
  fs.writeFileSync(script, renderRepairScript(home));
  const run = () => execFileSync('sh', [script], { stdio: 'pipe' });
  const lay = (name: string, marker: string) => {
    fs.mkdirSync(path.join(home, name, 'src'), { recursive: true });
    fs.writeFileSync(path.join(home, name, 'src', 'main.ts'), marker);
  };
  // app/ present: nothing moves, even with app.prev around.
  lay('app', 'current');
  lay('app.prev', 'previous');
  run();
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), 'current');
  assert.ok(fs.existsSync(path.join(home, 'app.prev')));
  // app/ present but odd (no src/main.ts): still not touched — the repair is for a missing app/, nothing else.
  fs.rmSync(path.join(app, 'src'), { recursive: true });
  run();
  assert.ok(fs.existsSync(app) && !fs.existsSync(path.join(app, 'src')));
  assert.ok(fs.existsSync(path.join(home, 'app.prev')));
  // app/ gone after a stop between two renames — but an install or update holds the lock (it is between its renames on
  // purpose): nothing moves.
  fs.rmSync(app, { recursive: true });
  lay('app.failed', 'broken');
  lay('app.new', 'new');
  if (spawnSync('flock', ['--version']).status === 0) {
    execFileSync('flock', [path.join(home, 'update.lock'), 'sh', script], { stdio: 'pipe' }); // flock holds the lock while the script runs
    assert.equal(fs.existsSync(app), false, 'left to the run that holds the lock');
    assert.ok(fs.existsSync(path.join(home, 'app.prev')));
  }
  // Without flock(1) (macOS) perl takes the locks: held by an install (platform/lock.ts's own perl lock) → nothing moves; free → the repair, in line on update.lock.repair.
  const perlPath = spawnSync('sh', ['-c', 'command -v perl']).stdout.toString().trim();
  if (perlPath) {
    const noFlock = path.join(dir, 'bin-without-flock');
    fs.mkdirSync(noFlock, { recursive: true });
    for (const tool of ['sh', 'mv', 'perl']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`]).stdout.toString().trim(), path.join(noFlock, tool));
    const env = { PATH: noFlock };
    const held = lockedCommand('darwin', path.join(home, 'update.lock'), ['sh', script]);
    execFileSync(perlPath, held.args, { stdio: 'pipe', env }); // perl holds update.lock while the script runs
    assert.equal(fs.existsSync(app), false, 'left to the run that holds the lock (perl)');
    assert.ok(fs.existsSync(path.join(home, 'app.prev')));
    fs.rmSync(path.join(home, 'update.lock.repair'), { force: true });
    execFileSync(path.join(noFlock, 'sh'), [script], { stdio: 'pipe', env });
    assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), 'previous', 'the lock free: the previous copy comes back under perl');
    assert.ok(fs.existsSync(path.join(home, 'update.lock.repair')), 'repairs queue on update.lock.repair under perl too');
    fs.renameSync(app, path.join(home, 'app.prev')); // as before, for the run below
  }
  // Nobody holds the lock: the previous copy comes back, never a failed one. Repairs queue on their own lock file.
  run();
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), 'previous');
  assert.equal(fs.existsSync(path.join(home, 'app.prev')), false);
  if (spawnSync('flock', ['--version']).status === 0) assert.ok(fs.existsSync(path.join(home, 'update.lock.repair')), 'repairs run one after another on update.lock.repair');
  assert.ok(fs.existsSync(path.join(home, 'app.new')), 'the new copy is left for the installer');
  // No previous copy either: the new one.
  fs.rmSync(app, { recursive: true });
  run();
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), 'new');
  // Nothing at all: exits 0 quietly (the unit start goes on to fail on its own terms).
  fs.rmSync(app, { recursive: true });
  run();
  assert.equal(fs.existsSync(app), false);
  // A private node/ missing after a stop between the runtime's two renames: node.old back (else node.new), app/ untouched.
  lay('app', 'current');
  const runtime = (name: string, marker: string) => {
    fs.mkdirSync(path.join(home, name, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, name, 'bin', 'node'), marker);
  };
  runtime('node.old', 'old');
  runtime('node.new', 'new');
  run();
  assert.equal(fs.readFileSync(path.join(home, 'node', 'bin', 'node'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(home, 'node.new')), 'the new runtime is left for the installer');
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.ts'), 'utf8'), 'current');
  fs.rmSync(path.join(home, 'node'), { recursive: true });
  run();
  assert.equal(fs.readFileSync(path.join(home, 'node', 'bin', 'node'), 'utf8'), 'new');
  // node/ present: node.old is left alone (the installer removes it); no runtime at all (system node): nothing to do.
  runtime('node.old', 'older');
  run();
  assert.equal(fs.readFileSync(path.join(home, 'node', 'bin', 'node'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(home, 'node.old')));
  fs.rmSync(path.join(home, 'node'), { recursive: true });
  fs.rmSync(path.join(home, 'node.old'), { recursive: true });
  run();
  assert.equal(fs.existsSync(path.join(home, 'node')), false);
  assert.throws(() => renderRepairScript('/h\nome'), /newline/);
});

test('--no-auto-update writes the timer units and disables the timer; a checkout gets no timer at all', async () => {
  const off = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  asRelease(off.deps);
  off.touchSocket();
  assert.equal(await runSetup(off.deps, { ...OPTS, autoUpdate: false }), 0);
  assert.ok(fs.existsSync(path.join(off.deps.unitDir, UPDATE_TIMER)));
  assert.ok(off.calls.includes(`systemctl --user disable --now ${UPDATE_TIMER}`));
  assert.equal(off.calls.some((c) => c === `systemctl --user enable ${UPDATE_TIMER}`), false);
  assert.match(off.out.join('\n'), /· auto-update off \(--no-auto-update\); on:  systemctl --user enable --now remotly-bridge-update\.timer/);
  // `disable --now` failing is said as such, with the line that turns it off — not "the bridge runs without it".
  const stuck = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: okRun('enabled\n'), [`systemctl --user disable --now ${UPDATE_TIMER}`]: failRun('Failed to disable unit: Access denied') } });
  stuck.deps.unitDir = path.join(dir, 'systemd-stuck');
  asRelease(stuck.deps);
  stuck.touchSocket();
  assert.equal(await runSetup(stuck.deps, { ...OPTS, autoUpdate: false }), 0);
  assert.match(stuck.out.join('\n'), /⚠ could not turn auto-update off \(.*Access denied.*\): remotly-bridge-update\.timer may still be enabled — off:  systemctl --user disable --now remotly-bridge-update\.timer/);
  assert.equal(stuck.out.join('\n').includes('the bridge runs without it'), false);
  assert.ok(fs.existsSync(path.join(stuck.deps.unitDir, UPDATE_TIMER)), 'the units stay: they are what --no-auto-update leaves behind');
  const stuckHome = path.dirname(path.dirname(path.dirname(stuck.deps.mainPath)));
  assert.equal(fs.existsSync(timerMarkerPath(stuckHome, 'remotly-bridge')), false, "the opt-out is the user's word, whatever disable made of it");

  const checkout = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  checkout.deps.unitDir = path.join(dir, 'systemd-checkout'); // its own unit dir: the case above wrote the timer units
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'bridge', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'install.sh'), '');
  checkout.deps.mainPath = path.join(root, 'bridge', 'src', 'main.ts');
  checkout.touchSocket();
  assert.equal(await runSetup(checkout.deps, OPTS), 0);
  assert.match(checkout.out.join('\n'), new RegExp(`· no update timer: this copy runs from a repository checkout \\(${root}\\), not from an installed release`));
  assert.equal(fs.existsSync(path.join(checkout.deps.unitDir, UPDATE_TIMER)), false);
  assert.equal(checkout.calls.some((c) => c.includes('update.timer')), false);
});

test('a timer that cannot be installed is a warning, not a failed setup; the units it wrote are taken back so the next setup tries again', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user enable ${UPDATE_TIMER}`]: failRun('Failed to enable unit: Access denied') } });
  asRelease(deps);
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  assert.match(out.join('\n'), /⚠ could not install the update timer remotly-bridge-update\.timer: .*Access denied.* — the bridge runs without it; `remotly-bridge update` updates by hand/);
  assert.match(out.join('\n'), /setup complete$/);
  assert.equal(fs.existsSync(path.join(deps.unitDir, UPDATE_TIMER)), false, 'no half-installed timer left behind');
  assert.equal(fs.existsSync(path.join(deps.unitDir, 'remotly-bridge-update.service')), false);
  assert.equal(calls.filter((c) => c === 'systemctl --user daemon-reload').length, 3, 'reloaded after taking them back');
  // The next setup (systemd cooperating now) does not read the earlier failure as the user's choice.
  const again = makeDeps({ script: { ...tsScript(), ...lingerYes } });
  again.deps.unitDir = deps.unitDir;
  again.touchSocket();
  assert.equal(await runSetup(again.deps, OPTS), 0);
  assert.match(again.out.join('\n'), /✔ daily update remotly-bridge-update\.timer/);
  assert.ok(again.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`));
  // Units that existed before are left as they are when the daemon-reload fails.
  const existing = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: okRun('enabled\n'), 'systemctl --user daemon-reload': [okRun(), failRun('Failed to reload daemon: Access denied')] } });
  existing.deps.unitDir = path.join(dir, 'systemd-existing');
  asRelease(existing.deps);
  fs.mkdirSync(existing.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(existing.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  existing.touchSocket();
  assert.equal(await runSetup(existing.deps, OPTS), 0);
  assert.match(existing.out.join('\n'), /⚠ could not install the update timer/);
  assert.match(fs.readFileSync(path.join(existing.deps.unitDir, UPDATE_TIMER), 'utf8'), /^OnCalendar=daily$/m, 'rewritten and kept');
  // Enabled, then the start fails: the timer is installed and runs from the next boot — the units stay (taking them
  // back would leave the enabling link dangling) and the message says how to start it now. Fresh install or not.
  for (const [name, isEnabled] of [
    ['fresh', NOT_FOUND],
    ['enabled', okRun('enabled\n')],
  ] as const) {
    const late = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: isEnabled, [`systemctl --user restart ${UPDATE_TIMER}`]: failRun('Job failed') } });
    late.deps.unitDir = path.join(dir, `systemd-late-${name}`);
    asRelease(late.deps);
    late.touchSocket();
    assert.equal(await runSetup(late.deps, OPTS), 0, name);
    assert.match(late.out.join('\n'), /⚠ daily update remotly-bridge-update\.timer is enabled but could not be started now \(.*Job failed.*\); it starts at the next boot, or now:  systemctl --user start remotly-bridge-update\.timer/, name);
    assert.equal(late.out.join('\n').includes('could not install the update timer'), false, name);
    assert.ok(fs.existsSync(path.join(late.deps.unitDir, UPDATE_TIMER)), `${name}: the enabled units stay`);
    assert.ok(fs.existsSync(path.join(late.deps.unitDir, 'remotly-bridge-update.service')), name);
    assert.ok(late.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`), name);
    const lateHome = path.dirname(path.dirname(path.dirname(late.deps.mainPath)));
    assert.equal(fs.existsSync(timerMarkerPath(lateHome, 'remotly-bridge')), false, `${name}: enabled, so the marker is gone`);
  }
  // A marker beside an enabled timer (a setup stopped between `enable` and removing the marker) makes the next setup
  // enable again, but never take the enabled units back when something fails before that.
  const enabledMarker = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: okRun('enabled\n'), 'systemctl --user daemon-reload': [okRun(), failRun('Failed to reload daemon: Access denied')] } });
  enabledMarker.deps.unitDir = path.join(dir, 'systemd-enabled-marker');
  asRelease(enabledMarker.deps);
  fs.mkdirSync(enabledMarker.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(enabledMarker.deps.unitDir, UPDATE_TIMER), OLD_TIMER);
  const emHome = path.dirname(path.dirname(path.dirname(enabledMarker.deps.mainPath)));
  fs.writeFileSync(timerMarkerPath(emHome, 'remotly-bridge'), '');
  enabledMarker.touchSocket();
  assert.equal(await runSetup(enabledMarker.deps, OPTS), 0);
  assert.match(enabledMarker.out.join('\n'), /⚠ could not install the update timer/);
  assert.ok(fs.existsSync(path.join(enabledMarker.deps.unitDir, UPDATE_TIMER)), 'an enabled timer is never taken back');
  assert.ok(fs.existsSync(path.join(enabledMarker.deps.unitDir, 'remotly-bridge-update.service')));
  assert.ok(fs.existsSync(timerMarkerPath(emHome, 'remotly-bridge')), 'the marker stays for the next setup, which enables again');
});

// ---- macOS: launchd -----------------------------------------------------------------------------

const MAC_PRINT_RUNNING = okRun('gui/1000/dev.remotly.remotly-bridge = {\n\tstate = running\n\tpid = 4242\n}\n');
const MAC_NOT_LOADED: ExecResult = { code: 113, stdout: '', stderr: 'Could not find service "dev.remotly.remotly-bridge" in domain for user gui: 1000' };
/** makeDeps for a Mac: the launchd manager over the same scripted exec, agents under <dir>/LaunchAgents, the home above app/. */
function macDeps(over: Parameters<typeof makeDeps>[0] = {}, agents = 'LaunchAgents') {
  const m = makeDeps({ platform: 'darwin', ...over });
  const home = path.dirname(path.dirname(path.dirname(m.deps.mainPath)));
  m.deps.unitDir = path.join(dir, agents);
  m.deps.home = home;
  m.deps.service = launchdManager({ exec: m.deps.exec, unitDir: m.deps.unitDir, user: 'alice', uid: 1000, home, updateMinute: 17, sleep: async () => undefined });
  return { ...m, home, launchctl: () => m.calls.filter((c) => c.startsWith('launchctl')) };
}

test('macOS: the service is a launchd agent — plist written, enabled and bootstrapped, health read from launchctl print; the update agent is written and enabled; no systemctl anywhere', async () => {
  // A first install: nobody answers on the socket before the bootstrap (both ownership looks pass); the agent's process does after.
  let answered = 0;
  // Both ownership looks and the "gone after bootout" check see no agent; afterwards it runs. The update agent is never loaded before.
  const m = macDeps({
    script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING], 'launchctl print gui/1000/dev.remotly.remotly-bridge-update': MAC_NOT_LOADED },
    status: async () => {
      if (answered++ < 2) throw new Error('ENOENT');
      return STATUS;
    },
  });
  asRelease(m.deps);
  m.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  m.touchSocket();
  const logs = path.join(m.home, 'Library', 'Logs', 'remotly');
  assert.equal(fs.existsSync(logs), false, 'a clean account');
  const umask = process.umask(0o002); // a permissive umask: the plists must still not be group-writable (launchd refuses those)
  try {
    assert.equal(await runSetup(m.deps, OPTS), 0);
  } finally {
    process.umask(umask);
  }
  const text = m.out.join('\n');
  const plist = path.join(m.deps.unitDir, 'dev.remotly.remotly-bridge.plist');
  const updatePlist = path.join(m.deps.unitDir, 'dev.remotly.remotly-bridge-update.plist');
  assert.ok(fs.statSync(logs).isDirectory(), 'the log directory the agents write to is made by setup');
  assert.equal(fs.statSync(logs).mode & 0o077, 0);
  assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
  assert.equal(fs.statSync(updatePlist).mode & 0o777, 0o644);
  assert.match(text, new RegExp(`✔ service remotly-bridge installed at ${plist} \\(node /opt/node/bin/node\\)`));
  assert.match(text, /✔ starts when you log in to this Mac \(launchd user agent\)/);
  assert.match(text, /✔ daily update dev\.remotly\.remotly-bridge-update \(runs `remotly-bridge update`; off:  launchctl bootout gui\/1000\/dev\.remotly\.remotly-bridge-update; launchctl disable gui\/1000\/dev\.remotly\.remotly-bridge-update\)/);
  assert.match(text, /✔ bridge running: listening 100\.64\.0\.7:7460, certificate tailscale, herdr up/);
  assert.match(text, /setup complete$/);
  assert.equal(text.includes('✖'), false);
  assert.equal(text.includes('⚠'), false);
  assert.equal(text.includes('systemd'), false);
  assert.equal(m.calls.some((c) => c.startsWith('systemctl') || c.startsWith('loginctl') || c.startsWith('journalctl')), false);

  const agent = fs.readFileSync(plist, 'utf8');
  const repair = repairScriptPath(m.home);
  assert.ok(fs.existsSync(repair), 'repair-app.sh written beside app/');
  assert.match(agent, new RegExp(`<string>/bin/sh "\\$0"; exec "\\$1" "\\$2" serve</string>\\n\\s*<string>${repair}</string>\\n\\s*<string>/opt/node/bin/node</string>\\n\\s*<string>${m.deps.mainPath}</string>`));
  assert.match(agent, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(agent, /<key>REMOTLY_TAILSCALE<\/key>\n\s*<string>\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale<\/string>/, 'the CLI setup ran with stays known to the agent');
  const update = fs.readFileSync(updatePlist, 'utf8');
  assert.match(update, /<key>REMOTLY_TAILSCALE<\/key>\n\s*<string>\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale<\/string>/, 'and to the updater');
  assert.match(update, /exec "\$1" "\$2" update<\/string>/);
  assert.match(update, /<key>Minute<\/key>\n\s*<integer>17<\/integer>/);
  assert.match(update, /<key>REMOTLY_SYSTEMD_UNIT<\/key>\n\s*<string>remotly-bridge<\/string>/);
  assert.match(update, /<key>REMOTLY_NODE<\/key>\n\s*<string>\/opt\/node\/bin\/node<\/string>/);
  assert.equal(fs.existsSync(timerMarkerPath(m.home, 'remotly-bridge')), false);
  assert.deepEqual(m.launchctl(), [
    'launchctl print gui/1000/dev.remotly.remotly-bridge', // ownership, before the checks
    'launchctl print gui/1000', // the session
    'launchctl print gui/1000/dev.remotly.remotly-bridge', // ownership again, right before the write
    'launchctl enable gui/1000/dev.remotly.remotly-bridge',
    'launchctl bootout gui/1000/dev.remotly.remotly-bridge',
    'launchctl print gui/1000/dev.remotly.remotly-bridge', // gone after the bootout?
    `launchctl bootstrap gui/1000 ${plist}`,
    'launchctl enable gui/1000/dev.remotly.remotly-bridge-update',
    'launchctl bootout gui/1000/dev.remotly.remotly-bridge-update',
    'launchctl print gui/1000/dev.remotly.remotly-bridge-update',
    `launchctl bootstrap gui/1000 ${updatePlist}`,
    'launchctl print gui/1000/dev.remotly.remotly-bridge', // health: the answering daemon is the agent's process
  ]);
});

test('macOS: --keep-stopped leaves a booted-out agent alone with the bootstrap line; a disabled update agent stays disabled; no launchd session stops before anything is written', async () => {
  const nobody = async (): Promise<ControlStatus> => Promise.reject(new Error('ENOENT')); // a stopped bridge answers nowhere
  const stopped = macDeps({ status: nobody, script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': MAC_NOT_LOADED, 'launchctl print-disabled gui/1000': okRun('disabled services = {\n\t"dev.remotly.remotly-bridge-update" => disabled\n}\n') } });
  asRelease(stopped.deps);
  fs.mkdirSync(stopped.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(stopped.deps.unitDir, 'dev.remotly.remotly-bridge.plist'), 'old plist');
  fs.writeFileSync(path.join(stopped.deps.unitDir, 'dev.remotly.remotly-bridge-update.plist'), 'old update plist <string>update</string>');
  stopped.touchSocket();
  assert.equal(await runSetup(stopped.deps, { ...OPTS, keepStopped: true }), 0);
  const text = stopped.out.join('\n');
  assert.match(text, new RegExp(`· service remotly-bridge installed at .*dev\\.remotly\\.remotly-bridge\\.plist \\(node /opt/node/bin/node\\), but it is inactive: left stopped \\(--keep-stopped\\);  launchctl bootstrap gui/1000 ${stopped.deps.unitDir}/dev\\.remotly\\.remotly-bridge\\.plist`));
  assert.match(text, /· auto-update off \(dev\.remotly\.remotly-bridge-update is disabled\); on:  launchctl enable gui\/1000\/dev\.remotly\.remotly-bridge-update && launchctl bootstrap gui\/1000 /);
  assert.equal(stopped.launchctl().some((c) => c.startsWith('launchctl bootstrap')), false, 'nothing started');
  assert.notEqual(fs.readFileSync(path.join(stopped.deps.unitDir, 'dev.remotly.remotly-bridge.plist'), 'utf8'), 'old plist', 'the agent plist is rewritten for this install');
  assert.notEqual(fs.readFileSync(path.join(stopped.deps.unitDir, 'dev.remotly.remotly-bridge-update.plist'), 'utf8'), 'old update plist', 'and so is the update agent, still disabled');

  const noSession = macDeps({ status: nobody, script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': MAC_NOT_LOADED, 'launchctl print gui/1000': failRun('Could not find domain for gui/1000', 125) } }, 'LaunchAgents-2');
  noSession.touchSocket();
  assert.equal(await runSetup(noSession.deps, OPTS), 1);
  assert.match(noSession.out.join('\n'), /✖ no launchd session for alice \(gui\/1000\)/);
  assert.equal(fs.existsSync(path.join(noSession.deps.unitDir, 'dev.remotly.remotly-bridge.plist')), false);
});

test('macOS: when the agent never comes up, the log file (not a journal) is shown and setup fails', async () => {
  const m = macDeps({ script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, okRun('gui/1000/dev.remotly.remotly-bridge = {\n\tstate = waiting\n}\n')] }, status: async () => Promise.reject(new Error('ECONNREFUSED')) });
  fs.mkdirSync(path.join(m.home, 'Library', 'Logs', 'remotly'), { recursive: true });
  fs.writeFileSync(path.join(m.home, 'Library', 'Logs', 'remotly', 'dev.remotly.remotly-bridge.log'), 'boom: port in use\n');
  m.touchSocket();
  assert.equal(await runSetup(m.deps, OPTS), 1);
  const text = m.out.join('\n');
  assert.match(text, /log of remotly-bridge:\n\s+boom: port in use/);
  assert.equal(text.includes('journal'), false);
});

test('macOS: a crash-looping agent (spawn scheduled after an exit, which launchd never settles) is settled for setup, which replaces and restarts it; a first spawn on its way is left alone', async () => {
  // A bad node path, say: launchd respawns every ThrottleInterval forever. Both ownership looks see that; the bootout
  // takes it down, the bootstrap brings the new plist up, and the agent's process answers.
  const crashing = okRun('gui/1000/dev.remotly.remotly-bridge = {\n\tstate = spawn scheduled\n\truns = 7\n\tlast exit code = 1\n}\n');
  let answered = 0;
  const m = macDeps(
    {
      script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [crashing, crashing, MAC_NOT_LOADED, MAC_PRINT_RUNNING], 'launchctl print gui/1000/dev.remotly.remotly-bridge-update': MAC_NOT_LOADED },
      status: async () => {
        if (answered++ < 2) throw new Error('ECONNREFUSED');
        return STATUS;
      },
    },
    'LaunchAgents-3',
  );
  m.touchSocket();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  const text = m.out.join('\n');
  assert.equal(text.includes('not touching it until it has settled'), false);
  assert.match(text, /✔ service remotly-bridge installed at/);
  assert.ok(m.launchctl().includes('launchctl bootout gui/1000/dev.remotly.remotly-bridge'));
  assert.match(text, /setup complete$/);
  // The first spawn after a bootstrap, before any run: launchd is on it — setup lets it settle rather than tear it down.
  const first = macDeps({ script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': okRun('gui/1000/dev.remotly.remotly-bridge = {\n\tstate = spawn scheduled\n\tlast exit code = (never exited)\n}\n') }, status: async () => Promise.reject(new Error('ECONNREFUSED')) }, 'LaunchAgents-4');
  first.touchSocket();
  assert.equal(await runSetup(first.deps, OPTS), 1);
  assert.match(first.out.join('\n'), /unit remotly-bridge is activating \(spawn scheduled\) right now — it may be restarting; not touching it until it has settled/);
});

test('macOS wording: the Tailscale fixes name the app, not systemd or --operator', () => {
  const fixOf = (s: ReturnType<typeof classifyTailnet>): string[] => (s.ok ? [] : s.fix);
  assert.deepEqual(fixOf(classifyTailnet(null, false, { platform: 'darwin' })), ['install it:  https://tailscale.com/download/mac   (or:  brew install --cask tailscale)', 'then log in from the Tailscale menu bar icon']);
  assert.deepEqual(fixOf(classifyTailnet(null, true, { platform: 'darwin' })), ['open the Tailscale app (tailscaled runs inside it) and connect']);
  assert.deepEqual(fixOf(classifyTailnet({ BackendState: 'NeedsLogin' }, true, { platform: 'darwin' })), ['open the Tailscale app and log in (its menu bar icon)']);
  assert.match(classifyCertFailure('access denied', 'alice', 'h.ts.net', 'auto', 'darwin').fix[0]!, /macOS has no --operator/);
  // Linux is untouched.
  assert.deepEqual(fixOf(classifyTailnet(null, true)), ['sudo systemctl enable --now tailscaled', 'then:  sudo tailscale up']);
  assert.deepEqual(classifyCertFailure('access denied', 'alice', 'h.ts.net').fix, ['sudo tailscale set --operator=alice']);
});

test('stableNodePath: a Homebrew node is the link brew repoints (process.execPath is the Cellar path even when the link was run), unless the link leads elsewhere', () => {
  const cellar = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
  const links: Record<string, string> = { '/opt/homebrew/bin/node': cellar };
  const io = { exists: (p: string) => p in links || p === cellar, realpath: (p: string) => links[p] ?? p, major: () => 24 };
  assert.equal(stableNodePath(cellar, '/Users/alice', io), '/opt/homebrew/bin/node');
  assert.equal(stableNodePath('/opt/homebrew/bin/node', '/Users/alice', io), '/opt/homebrew/bin/node');
  assert.equal(stableNodePath('/usr/local/Cellar/node@24/24.1.0/bin/node', '/Users/alice', { ...io, exists: (p) => p === '/usr/local/bin/node', realpath: (p) => (p === '/usr/local/bin/node' ? '/usr/local/Cellar/node@24/24.1.0/bin/node' : p) }), '/usr/local/bin/node', 'Intel prefix, a versioned formula');
  links['/opt/homebrew/bin/node'] = '/opt/homebrew/Cellar/node/22.0.0/bin/node';
  assert.equal(stableNodePath(cellar, '/Users/alice', io), cellar, 'the link points at another version: the real path, not a surprise downgrade');
  assert.equal(stableNodePath(cellar, '/Users/alice', { ...io, exists: () => false }), cellar, 'no link at all');
  // A keg-only formula (node@24) has no <prefix>/bin/node of its own: its <prefix>/opt/<formula> link, which brew keeps on the current version.
  const keg = '/opt/homebrew/Cellar/node@24/24.1.0/bin/node';
  const kegLinks: Record<string, string> = { '/opt/homebrew/opt/node@24/bin/node': keg, '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.0.0/bin/node' };
  const kegIo = { exists: (p: string) => p in kegLinks || p === keg, realpath: (p: string) => kegLinks[p] ?? p, major: () => 24 };
  assert.equal(stableNodePath(keg, '/Users/alice', kegIo), '/opt/homebrew/opt/node@24/bin/node', 'bin/node is another formula: the keg\'s opt link');
  assert.equal(stableNodePath('/opt/homebrew/opt/node@24/bin/node', '/Users/alice', kegIo), '/opt/homebrew/opt/node@24/bin/node');
  kegLinks['/opt/homebrew/bin/node'] = keg; // `brew link node@24`: the shell's node is the keg — that link first
  assert.equal(stableNodePath(keg, '/Users/alice', kegIo), '/opt/homebrew/bin/node');
  assert.equal(stableNodePath(keg, '/Users/alice', { ...kegIo, exists: (p) => p === keg }), keg, 'no link leads to it: the real path');
});

// ---- the herdr service ---------------------------------------------------------------------------

const HERDR_UNIT = 'remotly-bridge-herdr.service';
const HERDR_BIN = '/usr/local/bin/herdr';
/**
 * makeDeps whose bridge follows a herdr session as herdr lays them out under `<home>/.config/herdr` (the default one, or
 * `sessions/<name>`), with a `herdr` to be found: what the herdr service needs. `touchHerdr` is herdr coming up on that
 * socket; `startsHerdr` makes it come up when the service is started (the systemctl start or restart of the herdr unit).
 */
let herdrHomes = 0;
function herdrDeps(over: Parameters<typeof makeDeps>[0] = {}, session?: string) {
  const n = ++herdrHomes; // its own home (so its own socket) and unit directory: cases in one test do not see each other's
  const home = path.join(dir, `home-${n}`);
  const unitDir = path.join(dir, `systemd-${n}`);
  const sock = session ? path.join(home, '.config', 'herdr', 'sessions', session, 'herdr.sock') : path.join(home, '.config', 'herdr', 'herdr.sock');
  const { script, ...rest } = over;
  const m = makeDeps({ home, unitDir, herdrSocket: sock, herdrBinary: () => HERDR_BIN, executable: () => true, processConfigHome: () => path.join(home, '.config'), script: { ...tsScript(), ...lingerYes, ...(script ?? {}) }, ...rest });
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  // A unit the manager reports loaded has a file: one of setup's own shape, for this session, as an earlier setup left it (a case that wants another overwrites or removes it).
  const shown = script?.[`${SHOW} ${HERDR_UNIT}`];
  const first = Array.isArray(shown) ? shown[0] : shown;
  if (first && /LoadState=loaded/.test(first.stdout)) {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, HERDR_UNIT), ownUnit(HERDR_BIN, session, home));
  }
  const touchHerdr = () => fs.writeFileSync(sock, '');
  const startsHerdr = (on = new RegExp(`^systemctl --user (start|restart) ${HERDR_UNIT}$`)) => {
    const base = m.deps.exec;
    m.deps.exec = async (cmd, args, o) => {
      if (on.test(`${cmd} ${args.join(' ')}`)) touchHerdr();
      return base(cmd, args, o);
    };
  };
  // The unit's calls that do something or decide something, without the two looks every run takes (state; where the manager has it from).
  const herdrCalls = () => m.calls.filter((c) => c.includes('remotly-bridge-herdr') && !c.includes('MainPID') && !c.includes('FragmentPath') && !c.includes('ConsistsOf')); // actions and standing, not the read-only questions (process, source, what is stopped with it)
  return { ...m, home, sock, touchHerdr, startsHerdr, herdrCalls, unitPath: path.join(unitDir, HERDR_UNIT) };
}
const herdrDown = (): Record<string, ExecResult> => ({ [`${SHOW} ${HERDR_UNIT}`]: unitShow('not-found', 'inactive', 'dead', 0) });
/** A herdr unit file as setup writes it for `remotly-bridge` — exactly: a file of setup's is its rendering and nothing else (a template change in a later release must keep reading the earlier renderings). */
const ownUnit = (bin: string, session?: string, home = '/home/alice'): string => renderSystemdHerdrUnit({ unit: 'remotly-bridge', herdrPath: bin, session, configHome: path.join(home, '.config') });

test('herdrSessionFor: the default session\'s socket and a named session\'s under ~/.config/herdr; any other socket is nobody\'s to start', () => {
  assert.deepEqual(herdrSessionFor('/home/alice/.config/herdr/herdr.sock', '/home/alice'), {});
  assert.deepEqual(herdrSessionFor('/home/alice/.config/herdr/sessions/work/herdr.sock', '/home/alice'), { session: 'work' });
  assert.equal(herdrSessionFor('/home/alice/.config/herdr/sessions/work/other.sock', '/home/alice'), null);
  assert.equal(herdrSessionFor('/home/alice/.config/herdr/sessions/herdr.sock', '/home/alice'), null);
  assert.equal(herdrSessionFor('/home/alice/.config/herdr/sessions/a/b/herdr.sock', '/home/alice'), null);
  assert.equal(herdrSessionFor('/home/alice/.config/herdr/sessions/../herdr.sock', '/home/alice'), null);
  assert.equal(herdrSessionFor('/home/bob/.config/herdr/herdr.sock', '/home/alice'), null, 'another user\'s herdr');
  assert.equal(herdrSessionFor('/run/herdr/herdr.sock', '/home/alice'), null, 'HERDR_SOCKET_PATH pointing elsewhere: herdr cannot be told to listen there');
});

test('findExecutable: the first executable file on PATH, by absolute entries only', () => {
  const bin = path.join(dir, 'bin');
  const later = path.join(dir, 'later');
  for (const d of [bin, later, path.join(dir, 'plain'), path.join(dir, 'asdir', 'herdr')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(later, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plain', 'herdr'), 'not executable', { mode: 0o644 });
  assert.equal(findExecutable('herdr', ['', 'bin', path.join(dir, 'missing'), path.join(dir, 'plain'), path.join(dir, 'asdir'), bin, later]), path.join(bin, 'herdr'));
  assert.equal(findExecutable('herdr', [later, bin]), path.join(later, 'herdr'), 'PATH order');
  assert.equal(findExecutable('herdr', ['', 'relative/bin', path.join(dir, 'plain')]), null);
  assert.equal(findExecutable('herdr', []), null);
  // The hook for a fake: `isExecutable` decides.
  assert.equal(findExecutable('herdr', ['/x', '/y'], (p) => p === '/y/herdr'), '/y/herdr');
  assert.equal(parseSetupArgs(['--no-herdr-service'], {}).herdrService, false);
  assert.equal(parseSetupArgs([], {}).herdrService, undefined);
});

test('herdr service: where herdr is looked for — setup\'s PATH, then ~/.local/bin and the other usual places (an unattended update runs with a unit\'s PATH), then the one the unit already runs', async () => {
  assert.deepEqual(herdrSearchDirs({ PATH: '/usr/bin:/bin::/usr/bin' }, '/home/alice'), ['/usr/bin', '/bin', '/home/alice/.local/bin', '/home/alice/.cargo/bin', '/home/alice/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  assert.equal(herdrSearchDirs({}, '/h')[0], '/h/.local/bin');
  assert.deepEqual(herdrUnitArgs(ownUnit('/home/alice/.local/bin/herdr', 'work')), { herdrPath: '/home/alice/.local/bin/herdr', session: 'work', configHome: '/home/alice/.config' });
  assert.deepEqual(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/home/alice/.config" "/opt/100%%/herdr" server\n`), { herdrPath: '/opt/100%/herdr', configHome: '/home/alice/.config' });
  assert.deepEqual(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/Users/a b/.config" "/opt/herdr" server\n`), { herdrPath: '/opt/herdr', configHome: '/Users/a b/.config' }, 'the directory as one quoted word');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "/usr/local/bin/herdr" server\n`), null, 'the directory not pinned: not the shape setup writes');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=.config" "/usr/local/bin/herdr" server\n`), null, 'a relative directory (herdr would take it from the working directory)');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=" "/usr/local/bin/herdr" server\n`), null, 'an empty one');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/local/bin/herdr" server\n`), null, 'a file without the env prefix is not the shape setup writes (a process shows herdr\'s own arguments; a file does not)');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION "/usr/local/bin/herdr" server\n`), null, 'half the prefix');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/home/alice/.config" "/usr/local/bin/herdr" server   \n`), null, 'trailing words or spaces: not as written');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\n[Service]\nExecStart=\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/home/alice/.config" "/usr/local/bin/herdr" server\n`), null, 'an empty ExecStart (a reset) before ours: two lines, not the shape');
  assert.equal(herdrUnitArgs(`${ownUnit('/usr/local/bin/herdr')}ExecStart=\nExecStart=/usr/local/bin/herdr --session other server\n`), null, 'a reset and another after ours: systemd runs the later one');
  assert.equal(herdrUnitArgs(`${ownUnit('/usr/local/bin/herdr')}ExecStart =\n  ExecStart = /usr/local/bin/herdr --session other server\n`), null, 'the same with the whitespace systemd allows around =');
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace('<key>ProgramArguments</key>', '<key>Pr&#111;gram</key>\n<string>/opt/other</string>\n<key>ProgramArguments</key>')), null, 'a Program key spelled with an entity: what the XML decodes to');
  assert.deepEqual(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }), 'dev.remotly.u-herdr'), { herdrPath: '/usr/local/bin/herdr', configHome: '/Users/alice/.config' }, 'the label it must declare');
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }), 'dev.remotly.other-herdr'), null, 'a marked plist of setup\'s shape declaring another label: that job is not this one');
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace('<key>KeepAlive</key>', '<key>Label</key>\n<string>dev.remotly.u-herdr</string>\n<key>KeepAlive</key>')), null, 'a key twice');
  const agent = renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' });
  const swap = (key: string, value: string): string => {
    const re = new RegExp(`(<key>${key}</key>\\s*)<true/>`);
    assert.match(agent, re, `the rendered plist has ${key} true`);
    return agent.replace(re, `$1${value}`);
  };
  assert.equal(herdrUnitArgs(swap('RunAtLoad', '<false/>')), null, 'RunAtLoad false: not started at login');
  assert.equal(herdrUnitArgs(swap('KeepAlive', '<false/>')), null, 'KeepAlive false: not kept');
  assert.equal(herdrUnitArgs(swap('KeepAlive', '<dict><key>SuccessfulExit</key><false/></dict>')), null, 'KeepAlive as a dictionary: not the shape');
  assert.equal(herdrUnitArgs(agent.replace('<key>KeepAlive</key>', '<key>Disabled</key>\n\t<true/>\n\t<key>KeepAlive</key>')), null, 'Disabled');
  assert.ok(herdrUnitArgs(agent.replace('<key>KeepAlive</key>', '<key>Disabled</key>\n\t<false/>\n\t<key>KeepAlive</key>')), 'Disabled false is fine');
  assert.equal(herdrUnitArgs(agent.replace('</plist>\n', '')), null, 'cut off: launchd rejects it');
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace('<key>ProgramArguments</key>', '<key>Program</key>\n<string>/opt/other</string>\n<key>ProgramArguments</key>')), null, 'a Program key: launchd runs that, with the array as its argv');
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace('</array>', '</array>\n<key>ProgramArguments</key>\n<array>\n<string>/opt/other</string>\n</array>')), null, 'two ProgramArguments');
  assert.deepEqual(herdrUnitArgs(renderSystemdHerdrUnit({ unit: 'u', herdrPath: '/opt/my tools/herdr', session: 'work 2', configHome: '/home/al ice/.config' })), { herdrPath: '/opt/my tools/herdr', session: 'work 2', configHome: '/home/al ice/.config' }, 'what the renderer writes, read back');
  assert.deepEqual(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', session: 'work', home: '/Users/alice', configHome: '/Users/alice/.config' })), { herdrPath: '/opt/homebrew/bin/herdr', session: 'work', configHome: '/Users/alice/.config' });
  assert.deepEqual(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/a&b/herdr', home: '/Users/alice', configHome: '/Users/a&b/.config' })), { herdrPath: '/opt/a&b/herdr', configHome: '/Users/a&b/.config' }, 'entities in the directory and the path, read back');
  // Without the marker line it is somebody else's file, whatever it runs; with it, only the one shape setup writes, and only a `herdr`.
  assert.equal(herdrUnitArgs('[Service]\nExecStart="/home/alice/.local/bin/herdr" --session "work" server\n'), null, 'no marker: a hand-made unit under setup\'s name');
  assert.equal(herdrUnitArgs(`# not ${HERDR_UNIT_MARKER}\nExecStart="/usr/local/bin/herdr" server\n`), null, 'the marker is the first line as written, not a phrase anywhere');
  assert.equal(herdrUnitArgs(`[Service]\n# ${HERDR_UNIT_MARKER}\nExecStart="/usr/local/bin/herdr" server\n`), null);
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace(`<!-- ${HERDR_UNIT_MARKER}`, '<!-- x').replace('</dict>', `</dict>\n<!-- ${HERDR_UNIT_MARKER} -->`)), null, 'a plist comment elsewhere');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/bin/sh" -c "exec herdr server"\n`), null);
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/herdr" server --foreground\n`), null);
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/home/alice/.config" "/usr/bin/not-herdr" server\n`), null, 'not a herdr');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=/home/alice/.config" "herdr" server\n`), null, 'not absolute');
  assert.equal(herdrUnitArgs(`# ${HERDR_UNIT_MARKER}\nExecStart=/usr/bin/true\n`), null);
  assert.equal(herdrUnitArgs(`<!-- ${HERDR_UNIT_MARKER} -->\n<key>ProgramArguments</key>\n<array>\n<string>/bin/sh</string>\n<string>-c</string>\n<string>herdr server</string>\n</array>`), null);
  assert.equal(herdrUnitArgs(renderLaunchHerdrAgent({ unit: 'u', herdrPath: '/usr/local/bin/herdr', home: '/Users/alice', configHome: '/Users/alice/.config' }).replace('<string>server</string>', '<string>server</string>\n<integer>1</integer>')), null, 'something besides strings in the array');
  assert.equal(herdrUnitArgs(''), null);

  // herdrArgv: the same shape as a process shows it.
  assert.deepEqual(herdrArgv(['/usr/local/bin/herdr', 'server']), { herdrPath: '/usr/local/bin/herdr' });
  assert.deepEqual(herdrArgv(['/usr/local/bin/herdr', '--session', 'work', 'server']), { herdrPath: '/usr/local/bin/herdr', session: 'work' });
  assert.deepEqual(herdrArgv(['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME=/Users/alice/.config', '/usr/local/bin/herdr', '--session', 'work', 'server']), { herdrPath: '/usr/local/bin/herdr', session: 'work', configHome: '/Users/alice/.config' }, 'as launchd spawned it: env\'s arguments, the directory among them');
  assert.equal(herdrArgv(['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH', '/usr/local/bin/herdr', 'server']), null, 'env\'s arguments without the directory: not this shape');
  assert.equal(herdrArgv(['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME=config', '/usr/local/bin/herdr', 'server']), null, 'a relative directory');
  assert.equal(herdrArgv(['/usr/bin/env', '-u', 'HERDR_SESSION', '/usr/local/bin/herdr', 'server']), null, 'another env line');
  assert.equal(herdrArgv(['/usr/bin/env', '-u', 'HERDR_SESSION', '-u', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME=/Users/alice/.config']), null);
  assert.equal(herdrArgv(['/usr/local/bin/herdr', '--session', 'work']), null);
  assert.equal(herdrArgv(['/usr/local/bin/herdr', '--session', 'a', 'b', 'server']), null, 'a session name with a space, as ps shows it: no verdict');
  assert.equal(herdrArgv(['/bin/sh', '-c', 'herdr server']), null);
  assert.equal(herdrArgv(['herdr', 'server']), null);
  assert.equal(herdrArgv(null), null);

  // herdrUnitFile: what stands at the path.
  const udir = path.join(dir, 'unit-files');
  fs.mkdirSync(udir, { recursive: true });
  assert.deepEqual(herdrUnitFile(path.join(udir, 'none.service')), { kind: 'absent' });
  fs.writeFileSync(path.join(udir, 'own.service'), ownUnit('/usr/local/bin/herdr', 'work'));
  assert.deepEqual(herdrUnitFile(path.join(udir, 'own.service')), { kind: 'owned', args: { herdrPath: '/usr/local/bin/herdr', session: 'work', configHome: '/home/alice/.config' } });
  // With the rendering to compare against: exactly setup's, or changed since (a directive added, a line removed — whatever it is, setup does not read it).
  const asWritten = (a: { herdrPath: string; session?: string; configHome?: string }) => renderSystemdHerdrUnit({ unit: 'remotly-bridge', herdrPath: a.herdrPath, session: a.session, configHome: a.configHome ?? '' });
  assert.equal(herdrUnitFile(path.join(udir, 'own.service'), undefined, asWritten).kind, 'owned');
  fs.writeFileSync(path.join(udir, 'gated.service'), ownUnit('/usr/local/bin/herdr', 'work').replace('[Unit]\n', '[Unit]\nConditionPathExists=/run/herdr-ok\n'));
  assert.deepEqual(herdrUnitFile(path.join(udir, 'gated.service'), undefined, asWritten), { kind: 'foreign', why: 'a unit file changed since setup wrote it' }, 'a condition added to the file');
  fs.writeFileSync(path.join(udir, 'trimmed.service'), ownUnit('/usr/local/bin/herdr', 'work').replace('Restart=always\n', ''));
  assert.deepEqual(herdrUnitFile(path.join(udir, 'trimmed.service'), undefined, asWritten), { kind: 'foreign', why: 'a unit file changed since setup wrote it' }, 'a line removed');
  const asAgent = (a: { herdrPath: string; session?: string; configHome?: string }) => renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: a.herdrPath, session: a.session, configHome: a.configHome ?? '', home: '/Users/alice' });
  const agentFile = path.join(udir, 'dev.remotly.remotly-bridge-herdr.plist');
  fs.writeFileSync(agentFile, asAgent({ herdrPath: '/opt/homebrew/bin/herdr', configHome: '/Users/alice/.config' }));
  assert.equal(herdrUnitFile(agentFile, 'dev.remotly.remotly-bridge-herdr', asAgent).kind, 'owned');
  fs.writeFileSync(agentFile, asAgent({ herdrPath: '/opt/homebrew/bin/herdr', configHome: '/Users/alice/.config' }).replace('<key>KeepAlive</key>', '<key>LimitLoadToSessionType</key>\n\t<string>Background</string>\n\t<key>KeepAlive</key>'));
  assert.deepEqual(herdrUnitFile(agentFile, 'dev.remotly.remotly-bridge-herdr', asAgent), { kind: 'foreign', why: 'a unit file changed since setup wrote it' }, 'a load gate added to the plist');
  fs.writeFileSync(path.join(udir, 'theirs.service'), '[Service]\nExecStart="/usr/local/bin/herdr" server\n');
  assert.deepEqual(herdrUnitFile(path.join(udir, 'theirs.service')), { kind: 'foreign', why: 'a unit file setup did not write' });
  fs.writeFileSync(path.join(udir, 'edited.service'), `# ${HERDR_UNIT_MARKER}\n[Service]\nExecStart="/bin/sh" -c "herdr server"\n`);
  assert.deepEqual(herdrUnitFile(path.join(udir, 'edited.service')), { kind: 'foreign', why: 'a unit file of another shape' });
  fs.symlinkSync(path.join(udir, 'own.service'), path.join(udir, 'link.service'));
  assert.deepEqual(herdrUnitFile(path.join(udir, 'link.service')), { kind: 'foreign', why: 'a symlink' }, 'even to a file setup wrote: not the arrangement setup makes');
  fs.mkdirSync(path.join(udir, 'dir.service'));
  assert.deepEqual(herdrUnitFile(path.join(udir, 'dir.service')), { kind: 'foreign', why: 'not a regular file' });
  // A drop-in beside the file (`systemctl --user edit`): the user's arrangement for the unit, whatever it sets — the unit is theirs.
  fs.mkdirSync(path.join(udir, 'own.service.d'));
  fs.writeFileSync(path.join(udir, 'own.service.d', 'env.conf'), '[Service]\nEnvironment=HERDR_LOG=debug\n');
  assert.deepEqual(herdrUnitFile(path.join(udir, 'own.service')), { kind: 'foreign', why: `a unit with a drop-in (${path.join(udir, 'own.service.d', 'env.conf')})` });
  fs.rmSync(path.join(udir, 'own.service.d'), { recursive: true });
  assert.equal(herdrUnitFile(path.join(udir, 'own.service')).kind, 'owned', 'the drop-in gone: setup\'s again');

  // unitSourceCheck: the manager's side — the file it loaded must be ours, and nothing of the unit's own merged in from any load path.
  // A type-level drop-in (service.d: every service runs under it, the bridge's own too) is fine unless it can single a service out, or cannot be read.
  const mine = path.join(udir, 'mine.service');
  fs.writeFileSync(path.join(udir, 'env.conf'), '[Service]\nEnvironment=A=1\n');
  fs.writeFileSync(path.join(udir, 'exec.conf'), '[Service]\nExecStart=\nExecStart=/usr/local/bin/herdr --session other server\n');
  assert.equal(unitSourceCheck(null, mine, 'systemd'), null, 'not loaded, or not said: nothing against it');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [] }, mine, 'systemd'), null);
  assert.equal(unitSourceCheck({ path: null, dropIns: [] }, mine, 'systemd'), 'loaded by systemd from no file it names (a transient or submitted job under the name)', 'a loaded unit the manager names no file for (systemd-run) is not the file at the path');
  assert.equal(unitSourceCheck({ path: null, dropIns: [] }, mine, 'launchd'), 'loaded by launchd from no file it names (a transient or submitted job under the name)', 'a `launchctl submit` under the label, with setup\'s plist booted out: not it');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(udir, 'env.conf')] }, mine, 'systemd'), `a unit with a drop-in (${path.join(udir, 'env.conf')})`, 'an environment tweak is an arrangement too: a Nice, a Limit, a StandardOutput=file: can each decide whether the start succeeds, so none is read');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(udir, 'exec.conf')] }, mine, 'systemd'), `a unit with a drop-in (${path.join(udir, 'exec.conf')})`);
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(udir, 'missing.conf')] }, mine, 'systemd'), `a unit with a drop-in (${path.join(udir, 'missing.conf')})`, 'listed by the manager is enough');
  // A type-level drop-in (service.d) under a system load path — root's to write; Fedora ships two — is the baseline every service runs under:
  // fine unless it can single a service out (a directive that decides per unit, a specifier that differs per unit) or cannot be read.
  // The same file under the user's own load paths is their arrangement.
  const typeDir = path.join(udir, 'service.d');
  const sys = [udir]; // udir standing in for /usr/lib/systemd/user
  fs.mkdirSync(typeDir);
  fs.writeFileSync(path.join(typeDir, '10-timeout-abort.conf'), '# Fedora ships this one for every user service\n[Service]\nTimeoutStopFailureMode=abort\n');
  fs.writeFileSync(path.join(typeDir, '10-oomd-user-service-defaults.conf'), '[Service]\nManagedOOMMemoryPressure=kill\nManagedOOMMemoryPressureLimit=50%\n');
  const fedora = [path.join(typeDir, '10-timeout-abort.conf'), path.join(typeDir, '10-oomd-user-service-defaults.conf')];
  assert.equal(unitSourceCheck({ path: mine, dropIns: fedora }, mine, 'systemd', sys), null, 'the baseline every service here runs under (a 50% is no specifier)');
  assert.equal(unitSourceCheck({ path: mine, dropIns: fedora }, mine, 'systemd'), `a unit with a drop-in (${fedora[0]})`, 'the same files under a load path of the user\'s own: their arrangement');
  fs.writeFileSync(path.join(typeDir, '20-cond.conf'), '[Service]\nExecCondition=/bin/sh -c \'test "$INVOCATION_ID" != x\'\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [...fedora, path.join(typeDir, '20-cond.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding ExecCondition (${path.join(typeDir, '20-cond.conf')})`, 'one that can single a service out');
  fs.writeFileSync(path.join(typeDir, '25-envfile.conf'), '# %N would be the unit here, but a comment is nothing\n[Service]\nEnvironmentFile=%h/.config/remotly/%p.env\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '25-envfile.conf')] }, mine, 'systemd', sys), `a unit with a drop-in that varies by unit (${path.join(typeDir, '25-envfile.conf')})`, 'a specifier that differs per unit: a file for one unit and none for another');
  fs.writeFileSync(path.join(typeDir, '26-home.conf'), '[Service]\nStandardOutput=append:%t/services.log\nNice=5\nOOMScoreAdjust=100\nKillMode=mixed\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '26-home.conf')] }, mine, 'systemd', sys), null, 'specifiers the same for every service (runtime directory), nice, OOM preference, stop behaviour: the baseline');
  for (const [name, line] of [['26-memory.conf', 'MemoryMax=256M'], ['26-tasks.conf', 'TasksMax=64'], ['26-nofile.conf', 'LimitNOFILE=64'], ['26-oom.conf', 'OOMPolicy=stop'], ['26-cpu.conf', 'CPUQuota=5%']] as const) {
    fs.writeFileSync(path.join(typeDir, name), `[Service]\n${line}\n`);
    assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, name)] }, mine, 'systemd', sys), `a unit with a drop-in overriding ${line.split('=')[0]} (${path.join(typeDir, name)})`, `a cap the bridge fits under says nothing of herdr: ${line}`);
  }
  fs.writeFileSync(path.join(typeDir, '26-restart.conf'), '[Service]\nRestart=on-failure\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '26-restart.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding Restart (${path.join(typeDir, '26-restart.conf')})`, 'restart policy: a clean `herdr server stop` would stay down, against the unit\'s Restart=always');
  fs.writeFileSync(path.join(typeDir, '27-conflicts.conf'), '[Unit]\nConflicts=remotly-bridge-herdr.service\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '27-conflicts.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding Conflicts (${path.join(typeDir, '27-conflicts.conf')})`, 'a directive naming a unit: starting the bridge would stop herdr');
  fs.writeFileSync(path.join(typeDir, '28-env.conf'), '[Service]\nEnvironment=GODEBUG=x\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '28-env.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding Environment (${path.join(typeDir, '28-env.conf')})`, 'a variable one program reads and another does not');
  fs.writeFileSync(path.join(typeDir, '29-envfile.conf'), '[Service]\nEnvironmentFile=-/etc/remotly/all.env\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '29-envfile.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding EnvironmentFile (${path.join(typeDir, '29-envfile.conf')})`, 'not on the list');
  // The text is read as systemd reads it.
  assert.equal(typeLevelAgainst('[Service]\nDescription=x \\\nExecStart=/evil\n'), null, 'a continuation line is the value before it, not a directive');
  assert.equal(typeLevelAgainst('[Service]\nStandardOutput=file:/tmp/remotly%c/out\n'), 'that varies by unit', '%c: the unit\'s own cgroup path');
  assert.equal(typeLevelAgainst('[Service]\nDescription=x \\\n# a comment inside the continuation\nExecStart=/evil\n'), null, 'systemd drops the comment and the continuation goes on: still the value');
  assert.equal(typeLevelAgainst('[Service]\n# a comment ending in a backslash \\\nExecStart=/evil\n'), 'overriding ExecStart', 'a comment never continues: the directive after it is one');
  assert.equal(typeLevelAgainst('[Service]\nDescription=x\\\\\nExecStart=/evil\n'), 'overriding ExecStart', 'two backslashes are one escaped backslash, no continuation');
  assert.equal(typeLevelAgainst('[Service]\nDescription=x \\\r\nExecStart=/evil\n'), 'with a line this does not read (Description=x \\)', 'a carriage return is not read');
  assert.equal(typeLevelAgainst('[Service]\n\nDescription=x \\\n\nExecStart=/evil\n'), 'overriding ExecStart', 'an empty line ends a continuation');
  assert.equal(typeLevelAgainst('[Service]\nDescription=x \\\n  for %N\n'), 'that varies by unit', 'a specifier in a continued value counts');
  assert.equal(typeLevelAgainst('[Service]\nthis is no directive\n'), 'with a line this does not read (this is no directive)');
  fs.writeFileSync(path.join(typeDir, '30-bom.conf'), '\uFEFFConditionPathExists=/nowhere\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '30-bom.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding ConditionPathExists (${path.join(typeDir, '30-bom.conf')})`, 'a byte order mark first, which systemd skips');
  fs.writeFileSync(path.join(typeDir, '35-commented.conf'), '# ExecStart= is not set here; see systemctl edit --global service\n[Service]\n  ; Type=oneshot was tried\nSyslogIdentifier=svc\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '35-commented.conf')] }, mine, 'systemd', sys), null, 'a comment is never a directive');
  fs.writeFileSync(path.join(typeDir, '40-spaced.conf'), '[Service]\n  Type = oneshot\n');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [path.join(typeDir, '40-spaced.conf')] }, mine, 'systemd', sys), `a unit with a drop-in overriding Type (${path.join(typeDir, '40-spaced.conf')})`, 'whitespace around, as systemd allows');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [...fedora, path.join(typeDir, 'missing.conf')] }, mine, 'systemd', sys), `a unit with a drop-in that cannot be read (${path.join(typeDir, 'missing.conf')})`, 'a system type-level one this cannot read: what it sets is unknown');
  assert.equal(unitSourceCheck({ path: mine, dropIns: [...fedora, path.join(udir, 'env.conf')] }, mine, 'systemd', sys), `a unit with a drop-in (${path.join(udir, 'env.conf')})`, 'the unit\'s own after the system\'s');
  assert.equal(unitSourceCheck({ path: '/etc/systemd/user/mine.service', dropIns: [] }, mine, 'systemd'), `loaded by systemd from /etc/systemd/user/mine.service, not ${mine}`);
  assert.equal(unitSourceCheck({ path: '/Users/alice/elsewhere/x.plist', dropIns: [] }, '/Users/alice/Library/LaunchAgents/x.plist', 'launchd'), 'loaded by launchd from /Users/alice/elsewhere/x.plist, not /Users/alice/Library/LaunchAgents/x.plist');

  // readProcessArgs: this process's own line on Linux; `ps` elsewhere (one line, split on spaces).
  if (process.platform === 'linux') {
    const own = await readProcessArgs(process.pid, 'linux', async () => okRun(''));
    assert.ok(own && own.length >= 1 && own[0]!.length > 0, `argv of this process: ${JSON.stringify(own)}`);
    assert.equal(await readProcessArgs(2 ** 22 - 1, 'linux', async () => okRun('')), null, 'no such process');
  }
  const ps = fakeExec({ 'ps -o args= -p 777': okRun('/opt/homebrew/bin/herdr --session work server\n'), 'ps -o args= -p 778': failRun('') });
  assert.deepEqual(await readProcessArgs(777, 'darwin', ps.exec), ['/opt/homebrew/bin/herdr', '--session', 'work', 'server']);
  assert.equal(await readProcessArgs(778, 'darwin', ps.exec), null);

  // Setup under the update unit: a PATH without ~/.local/bin, herdr installed there (where herdr's own installer puts it).
  const unattended = herdrDeps({ script: herdrDown(), env: { PATH: '/usr/bin:/bin' } });
  delete unattended.deps.herdrBinary;
  fs.mkdirSync(path.join(unattended.home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(unattended.home, '.local', 'bin', 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
  unattended.startsHerdr();
  assert.equal(await runSetup(unattended.deps, { ...OPTS, keepMode: true, keepStopped: true }), 0);
  assert.match(fs.readFileSync(unattended.unitPath, 'utf8'), new RegExp(`^ExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=${unattended.home}/.config" "${unattended.home}/.local/bin/herdr" server$`, 'm'));
  assert.match(unattended.out.join('\n'), new RegExp(`✔ herdr service remotly-bridge-herdr\\.service \\(${unattended.home}/.local/bin/herdr\\) started`));

  // herdr in a place of its own that this run's PATH does not reach: the unit keeps the herdr it runs while that is still there.
  const kept = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') }, env: { PATH: '/usr/bin' } });
  delete kept.deps.herdrBinary;
  const odd = path.join(kept.home, 'tools', 'herdr');
  fs.mkdirSync(path.dirname(odd), { recursive: true });
  fs.writeFileSync(odd, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(kept.deps.unitDir, { recursive: true });
  fs.writeFileSync(kept.unitPath, ownUnit(odd, undefined, kept.home));
  kept.touchHerdr();
  assert.equal(await runSetup(kept.deps, OPTS), 0);
  assert.match(kept.out.join('\n'), new RegExp(`✔ herdr service remotly-bridge-herdr\\.service \\(${odd}\\) running \\(pid 777\\)`));
  assert.match(fs.readFileSync(kept.unitPath, 'utf8'), new RegExp(`^ExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=${kept.home}/.config" "${odd}" server$`, 'm'));

  // That herdr gone too: no herdr to be had; the unit is left as it is (nothing to write it for) and the note says so.
  const gone = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') }, env: { PATH: '/usr/bin' } });
  delete gone.deps.herdrBinary;
  fs.mkdirSync(gone.deps.unitDir, { recursive: true });
  fs.writeFileSync(gone.unitPath, ownUnit(path.join(gone.home, 'nowhere', 'herdr'), undefined, gone.home));
  gone.touchHerdr();
  assert.equal(await runSetup(gone.deps, OPTS), 0);
  assert.match(gone.out.join('\n'), /· no herdr service: herdr is running, but there is no `herdr` on PATH \(or under ~\/\.local\/bin\) to start it from at boot/);
  assert.deepEqual(gone.herdrCalls(), []);

  // A unit of another shape under setup's name (a wrapper somebody made): never taken for the herdr to run — /bin/sh is not it — and never written over.
  const wrapper = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 900), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') }, env: { PATH: '/usr/bin' } });
  delete wrapper.deps.herdrBinary;
  fs.mkdirSync(wrapper.deps.unitDir, { recursive: true });
  const wrapped = `# ${HERDR_UNIT_MARKER}\n[Service]\nExecStart="/bin/sh" -c "exec herdr server"\n`; // the marker, but not the shape: edited, or copied
  fs.writeFileSync(wrapper.unitPath, wrapped);
  wrapper.touchHerdr();
  assert.equal(await runSetup(wrapper.deps, OPTS), 0);
  assert.match(wrapper.out.join('\n'), /· no herdr service: herdr is running, but there is no `herdr` on PATH/);
  assert.equal(fs.readFileSync(wrapper.unitPath, 'utf8'), wrapped);
});

test('herdr service: a unit under setup\'s name that setup did not write — another shape, or a file elsewhere — is left as it is even when enabled or disabled; a bridge moved to a socket that is no session says what the old unit still does', async () => {
  const other = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 900), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  const theirs = '[Service]\nExecStart="/usr/local/bin/herdr" server\n'; // the very command, but not setup's file: no marker line
  fs.writeFileSync(other.unitPath, theirs);
  other.touchHerdr();
  assert.equal(await runSetup(other.deps, OPTS), 0);
  assert.match(other.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is a unit file setup did not write, not a unit setup wrote\n\s+✔ herdr 0\.8\.0/);
  assert.equal(fs.readFileSync(other.unitPath, 'utf8'), theirs);
  assert.deepEqual(other.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  const edited = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  const wrapper = `# ${HERDR_UNIT_MARKER}\n[Service]\nExecStart="/bin/sh" -c "exec herdr server"\n`;
  fs.writeFileSync(edited.unitPath, wrapper);
  edited.touchHerdr();
  assert.equal(await runSetup(edited.deps, OPTS), 0);
  assert.match(edited.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is a unit file of another shape, not a unit setup wrote/);
  assert.equal(fs.readFileSync(edited.unitPath, 'utf8'), wrapper);

  // A symlink under setup's name, enabled (systemd says `enabled`, not `linked`, once a linked unit is enabled): not touched, whatever it points at.
  const linkedEnabled = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  const target = path.join(linkedEnabled.home, 'their-herdr.service');
  fs.writeFileSync(target, ownUnit(HERDR_BIN));
  fs.rmSync(linkedEnabled.unitPath);
  fs.symlinkSync(target, linkedEnabled.unitPath);
  linkedEnabled.touchHerdr();
  assert.equal(await runSetup(linkedEnabled.deps, OPTS), 0);
  assert.match(linkedEnabled.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is a symlink, not a unit setup wrote/);
  assert.ok(fs.lstatSync(linkedEnabled.unitPath).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), ownUnit(HERDR_BIN));
  assert.deepEqual(linkedEnabled.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  const elsewhere = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('disabled\n') } });
  fs.rmSync(elsewhere.unitPath); // the manager knows the unit from another directory (/etc/systemd/user, ~/.local/share/systemd/user)
  elsewhere.touchHerdr();
  assert.equal(await runSetup(elsewhere.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(elsewhere.out.join('\n'), new RegExp(`· herdr service left as it is: remotly-bridge-herdr\\.service is disabled with no file at ${elsewhere.unitPath}, not a unit setup wrote`));
  assert.equal(fs.existsSync(elsewhere.unitPath), false);
  assert.deepEqual(elsewhere.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  // The bridge now follows a socket that is no session: the unit from before keeps starting its session — said, with the line that turns it off.
  const moved = makeDeps({ script: { ...tsScript(), ...lingerYes }, home: path.join(dir, 'home-moved'), herdrBinary: () => HERDR_BIN });
  fs.mkdirSync(moved.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(moved.deps.unitDir, HERDR_UNIT), ownUnit(HERDR_BIN, undefined, moved.deps.home));
  moved.touchSocket();
  assert.equal(await runSetup(moved.deps, OPTS), 0);
  assert.match(moved.out.join('\n'), /· no herdr service: the bridge follows .*herdr\.sock, which is not a herdr session under .* — start that herdr yourself after a reboot; remotly-bridge-herdr\.service, from an earlier setup, keeps starting its own session — off:  systemctl --user disable --now remotly-bridge-herdr\.service/);
  assert.equal(moved.calls.some((c) => c.includes('remotly-bridge-herdr') && !c.includes('ConsistsOf')), false, 'asked what the manager stops with it (for the off line), nothing done to it');
});

test('herdr service: a running unit rewritten for another session than it runs (the bridge was moved) is said to take over at the next boot, with the restart that does it now — read from its process, so the next setup says it again', async () => {
  const running = { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') };
  const oldProcess = async (pid: number) => (pid === 777 ? [HERDR_BIN, '--session', 'old', 'server'] : null);
  const m = herdrDeps({ script: running, processArgs: oldProcess }, 'new');
  fs.writeFileSync(m.unitPath, ownUnit(HERDR_BIN, 'old', m.home));
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  // `new` answers on its socket, so it runs outside the unit and holds the socket: the line stops it before the restart (a restart alone would start the unit against it forever).
  const warned = /⚠ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session new\) is running \(pid 777\) for session old, rewritten for session new: it takes over at the next boot — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session new server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session old and every pane of session new \(it runs outside the unit now\); herdr restores the layouts\)/;
  assert.match(m.out.join('\n'), warned);
  assert.match(m.out.join('\n'), /· herdr service remotly-bridge-herdr\.service started session old before: a bridge that shared it for that session has no service now, until its own setup runs again \(its doctor says so\)\n/, 'one provider per session: a bridge that relied on this unit for `old` is told of, as far as setup can');
  // `new` not running anywhere: the restart alone does it.
  const idle = herdrDeps({ script: running, processArgs: oldProcess }, 'new');
  fs.writeFileSync(idle.unitPath, ownUnit(HERDR_BIN, 'old', idle.home));
  assert.equal(await runSetup(idle.deps, { ...OPTS, wait: false }), 1, 'herdr is not running for the session: the check fails');
  assert.match(idle.out.join('\n'), /rewritten for session new: it takes over at the next boot — or now:  systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session old; herdr restores the layout\)\n/);
  assert.match(fs.readFileSync(m.unitPath, 'utf8'), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/usr\/local\/bin\/herdr" --session "new" server$/m);
  assert.deepEqual(m.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`], 'rewritten and enabled, never restarted by setup');

  // The next setup: the file already says `new`, the process still runs `old` — the warning stands, from the process.
  const next = herdrDeps({ script: running, processArgs: oldProcess }, 'new');
  next.touchHerdr();
  assert.equal(await runSetup(next.deps, OPTS), 0);
  assert.match(next.out.join('\n'), warned);

  // The process cannot be read (gone between the two calls, or `ps` unparsable): the file it was started from stands in; a file already rewritten then reads as serving.
  const blind = herdrDeps({ script: running }, 'new');
  fs.writeFileSync(blind.unitPath, ownUnit(HERDR_BIN, 'old', blind.home));
  blind.touchHerdr();
  assert.equal(await runSetup(blind.deps, OPTS), 0);
  assert.match(blind.out.join('\n'), warned);

  // The file is for the same session under another directory (written under another HOME): another socket, so moved as well — the file's word, since a process's own arguments say nothing of the directory.
  const otherHome = herdrDeps({ script: running }, 'new');
  fs.writeFileSync(otherHome.unitPath, ownUnit(HERDR_BIN, 'new', '/srv/elsewhere'));
  otherHome.touchHerdr();
  assert.equal(await runSetup(otherHome.deps, OPTS), 0);
  assert.match(otherHome.out.join('\n'), /is running \(pid 777\) for session new under \/srv\/elsewhere\/\.config\/herdr, rewritten for session new: it takes over at the next boot/);
  assert.match(fs.readFileSync(otherHome.unitPath, 'utf8'), new RegExp(`^ExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=${otherHome.home}/.config" "/usr/local/bin/herdr" --session "new" server$`, 'm'));

  // Disabled by the user, or opted out now, but running for the other session: said in those lines too.
  const disabled = herdrDeps({ script: { ...running, [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('disabled\n') }, processArgs: oldProcess }, 'new');
  disabled.touchHerdr();
  assert.equal(await runSetup(disabled.deps, OPTS), 0);
  assert.match(disabled.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); it is running for session old, not session new — for session new:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session new server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane it runs, and the herdr answering for session new outside it\); on:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session new server stop; systemctl --user enable remotly-bridge-herdr\.service; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session new and every pane this unit runs; herdr restores the layouts\)/, 'running another session: enable --now would leave it so, so the on-line restarts it');
  const optOut = herdrDeps({ script: running, processArgs: oldProcess }, 'new');
  optOut.touchHerdr();
  assert.equal(await runSetup(optOut.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(optOut.out.join('\n'), /· herdr service off \(--no-herdr-service\): remotly-bridge-herdr\.service written but disabled; it keeps running \(for session old, not session new\) until:  systemctl --user stop remotly-bridge-herdr\.service; on:/);

  // The process runs what the bridge follows: no warning, whatever an older file said.
  const fine = herdrDeps({ script: running, processArgs: async () => [HERDR_BIN, '--session', 'new', 'server'] }, 'new');
  fine.touchHerdr();
  assert.equal(await runSetup(fine.deps, OPTS), 0);
  assert.match(fine.out.join('\n'), /✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session new\) running \(pid 777\)/);

  // A process that is not herdr's shape (a wrapper; a `ps` line split on spaces) tells nothing: no ✔ from the file, and said so.
  const opaque = herdrDeps({ script: running, processArgs: async () => ['/bin/sh', '-c', 'herdr server'] }, 'new');
  opaque.touchHerdr();
  assert.equal(await runSetup(opaque.deps, OPTS), 0);
  assert.match(opaque.out.join('\n'), /⚠ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session new\) is running \(pid 777\) what cannot be told from its process \(\/bin\/sh -c herdr server\); the file is for session new, which a restart starts:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session new server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane it runs and the herdr answering for session new if that is another; herdr restores the layouts\)/);
  assert.equal(opaque.out.join('\n').includes('✔ herdr service'), false);
  assert.deepEqual(opaque.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`], 'never restarted by setup');

  // The process's own arguments say nothing of its directory (env set it before the exec): its environment does. Unreadable, the directory is not taken for the one wanted — said, no ✔.
  const dirUnknown = herdrDeps({ script: running, processArgs: async () => [HERDR_BIN, '--session', 'new', 'server'], processConfigHome: () => null }, 'new');
  dirUnknown.touchHerdr();
  assert.equal(await runSetup(dirUnknown.deps, OPTS), 0);
  assert.match(dirUnknown.out.join('\n'), /⚠ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session new\) is running \(pid 777\) for session new under a directory that cannot be told \(its process's environment could not be read\); the file is for session new, which a restart starts:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session new server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane it runs and the herdr answering for session new if that is another; herdr restores the layouts\)/);
  assert.equal(dirUnknown.out.join('\n').includes('✔ herdr service'), false);
  // Read from its environment: another directory is another socket (moved); the one wanted is ✔ (the `fine` case above, through herdrDeps' default).
  const dirOther = herdrDeps({ script: running, processArgs: async () => [HERDR_BIN, '--session', 'new', 'server'], processConfigHome: () => '/srv/elsewhere/.config' }, 'new');
  dirOther.touchHerdr();
  assert.equal(await runSetup(dirOther.deps, OPTS), 0);
  assert.match(dirOther.out.join('\n'), /is running \(pid 777\) for session new under \/srv\/elsewhere\/\.config\/herdr, rewritten for session new: it takes over at the next boot/);
  assert.equal(dirOther.out.join('\n').includes('✔ herdr service'), false);
});

test('readProcessConfigHome: the directory from a process\'s environment on Linux (XDG_CONFIG_HOME when absolute, else HOME/.config); null when it cannot be read, and on any other platform', () => {
  const own = readProcessConfigHome(process.pid, 'linux');
  const xdg = process.env.XDG_CONFIG_HOME;
  assert.equal(own, xdg !== undefined ? (path.isAbsolute(xdg) ? xdg : null) : process.env.HOME ? path.join(process.env.HOME, '.config') : null, 'this process, as /proc has it');
  assert.equal(readProcessConfigHome(process.pid, 'darwin'), null);
  assert.equal(readProcessConfigHome(2 ** 22 - 1, 'linux'), null, 'no such process');
});

test('herdr service: a name the manager does not know is not fresh when something stands at the path (a dangling symlink), nor when the manager loaded it from elsewhere', async () => {
  const dangling = herdrDeps({ script: herdrDown() });
  fs.mkdirSync(dangling.deps.unitDir, { recursive: true });
  fs.symlinkSync(path.join(dangling.home, 'gone.service'), dangling.unitPath);
  dangling.touchHerdr();
  assert.equal(await runSetup(dangling.deps, OPTS), 0);
  assert.match(dangling.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is a symlink, not a unit setup wrote/);
  assert.ok(fs.lstatSync(dangling.unitPath).isSymbolicLink(), 'not replaced by a file');
  assert.deepEqual(dangling.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  // The manager knows and runs the unit, yet there is no file of setup's at the path (a plist bootstrapped from another directory, on a Mac): not setup's name to take.
  const elsewhere = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 900), [`systemctl --user is-enabled ${HERDR_UNIT}`]: NOT_FOUND } });
  fs.rmSync(elsewhere.unitPath);
  elsewhere.touchHerdr();
  assert.equal(await runSetup(elsewhere.deps, OPTS), 0);
  assert.match(elsewhere.out.join('\n'), new RegExp(`· herdr service left as it is: remotly-bridge-herdr\\.service is loaded by systemd from a file that is not ${elsewhere.unitPath}, not a unit setup wrote`));
  assert.equal(fs.existsSync(elsewhere.unitPath), false);
  assert.deepEqual(elsewhere.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  // A drop-in from another load path (`remotly-bridge-.service.d`, /etc/systemd/user) that sets ExecStart, listed by systemd: the unit runs something else than its file says — left alone, even with a file of setup's at the path.
  const prefixed = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } }, 'work');
  const prefixDir = path.join(prefixed.deps.unitDir, 'remotly-bridge-.service.d');
  fs.mkdirSync(prefixDir, { recursive: true });
  fs.writeFileSync(path.join(prefixDir, '90-other.conf'), '[Service]\nExecStart=\nExecStart=/usr/local/bin/herdr --session other server\n');
  prefixed.deps.exec = ((base) => async (cmd, args, o) => {
    const r = await base(cmd, args, o); // recorded like every call
    return `${cmd} ${args.join(' ')}` === `systemctl --user show -p FragmentPath,DropInPaths ${HERDR_UNIT}` ? okRun(`FragmentPath=${prefixed.unitPath}\nDropInPaths=${path.join(prefixDir, '90-other.conf')}\n`) : r;
  })(prefixed.deps.exec);
  const was = fs.readFileSync(prefixed.unitPath, 'utf8');
  prefixed.touchHerdr();
  assert.equal(await runSetup(prefixed.deps, OPTS), 0);
  assert.match(prefixed.out.join('\n'), new RegExp(`· herdr service left as it is: remotly-bridge-herdr\\.service is a unit with a drop-in \\(${path.join(prefixDir, '90-other.conf')}\\), not a unit setup wrote`));
  assert.equal(fs.readFileSync(prefixed.unitPath, 'utf8'), was, 'not rewritten');
  assert.deepEqual(prefixed.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);
  assert.ok(prefixed.calls.includes(`systemctl --user show -p FragmentPath,DropInPaths ${HERDR_UNIT}`), 'systemd was asked where it has the unit from');

  // Loaded from another file while a file of setup's stands at the path (a unit under /etc/systemd/user that systemd picked): not setup's name any more.
  // A drop-in from a load path that applies to the unit only once it is loaded (a prefix directory): systemd lists it after the reload — seen then, before anything is enabled; the fresh file is taken back.
  const late = herdrDeps({ script: herdrDown() }, 'work');
  const lateDir = path.join(late.deps.unitDir, 'remotly-bridge-.service.d');
  fs.mkdirSync(lateDir, { recursive: true });
  fs.writeFileSync(path.join(lateDir, '90-foreign.conf'), '[Service]\nExecStart=\nExecStart=/opt/other/herdr server\n');
  const lateBase = late.deps.exec;
  late.deps.exec = async (cmd, args, o) => {
    const r = await lateBase(cmd, args, o);
    return `${cmd} ${args.join(' ')}` === `systemctl --user show -p FragmentPath,DropInPaths ${HERDR_UNIT}` ? okRun(`FragmentPath=${late.unitPath}\nDropInPaths=${path.join(lateDir, '90-foreign.conf')}\n`) : r;
  };
  late.touchHerdr();
  assert.equal(await runSetup(late.deps, OPTS), 0);
  assert.match(late.out.join('\n'), new RegExp(`· herdr service left as it is: remotly-bridge-herdr\\.service is a unit with a drop-in \\(${path.join(lateDir, '90-foreign.conf')}\\), not a unit setup wrote \\(the file written for it was taken back\\)`));
  assert.equal(fs.existsSync(late.unitPath), false, 'taken back');
  assert.deepEqual(late.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'never enabled or started');

  const other = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 901), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), [`systemctl --user show -p FragmentPath,DropInPaths ${HERDR_UNIT}`]: okRun(`FragmentPath=/etc/systemd/user/${HERDR_UNIT}\nDropInPaths=\n`) } }, 'work');
  other.touchHerdr();
  assert.equal(await runSetup(other.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(other.out.join('\n'), new RegExp(`· herdr service left as it is: remotly-bridge-herdr\\.service is loaded by systemd from /etc/systemd/user/${HERDR_UNIT}, not ${other.unitPath}, not a unit setup wrote`));
  assert.deepEqual(other.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'not disabled either: --no-herdr-service is about setup\'s unit');

  // A file of setup's the manager does not know yet (written by a setup that did not get to the reload): fresh, rewritten, reloaded, enabled.
  const unreloaded = herdrDeps({ script: herdrDown() }, 'work');
  fs.mkdirSync(unreloaded.deps.unitDir, { recursive: true });
  fs.writeFileSync(unreloaded.unitPath, ownUnit('/old/herdr', 'work', unreloaded.home));
  unreloaded.touchHerdr();
  assert.equal(await runSetup(unreloaded.deps, OPTS), 0);
  assert.match(unreloaded.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now/);
  assert.match(fs.readFileSync(unreloaded.unitPath, 'utf8'), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/usr\/local\/bin\/herdr" --session "work" server$/m);
});

test('macOS: what the herdr agent runs is what launchd spawned it with (the arguments block of launchctl print), so a moved session is seen without /proc', async () => {
  const label = 'dev.remotly.remotly-bridge-herdr';
  let answered = 0;
  const m = macDeps(
    {
      script: {
        ...tsScript(),
        'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING],
        [`launchctl print gui/1000/${label}`]: okRun(`gui/1000/${label} = {\n\tstate = running\n\targuments = {\n\t\t/usr/bin/env\n\t\t-u\n\t\tHERDR_SESSION\n\t\t-u\n\t\tHERDR_SOCKET_PATH\n\t\tXDG_CONFIG_HOME=${dir}/.config\n\t\t/opt/homebrew/bin/herdr\n\t\t--session\n\t\told one\n\t\tserver\n\t}\n\tpath = ${dir}/LaunchAgents-4/${label}.plist\n\tpid = 4343\n}\n`),
        'launchctl print-disabled gui/1000': okRun('disabled services = {\n}\n'),
      },
      status: async () => {
        if (answered++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'sessions', 'new one', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
      processArgs: async () => {
        throw new Error('not asked: launchd told the arguments');
      },
    },
    'LaunchAgents-4',
  );
  m.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(m.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(m.deps.herdrSocket, '');
  fs.mkdirSync(m.deps.unitDir, { recursive: true });
  // The plist as the last setup left it, already for the new session; the agent still runs the old one.
  fs.writeFileSync(path.join(m.deps.unitDir, `${label}.plist`), renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', session: 'new one', home: m.home, configHome: path.join(m.home, '.config') }));
  assert.equal(await runSetup(m.deps, OPTS), 0, m.out.join('\n'));
  assert.match(m.out.join('\n'), new RegExp(`⚠ herdr service ${label} \\(/opt/homebrew/bin/herdr, session new one\\) is running \\(pid 4343\\) for session old one, rewritten for session new one: it takes over at the next login — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\\S+/\\.config \\S*herdr --session 'new one' server stop; launchctl bootout gui/1000/${label}; sleep 2; launchctl bootstrap gui/1000 \\S+/${label}\\.plist   \\(ends every pane of session old one and every pane of session new one \\(it runs outside the unit now\\); herdr restores the layouts\\)`));
  assert.deepEqual(m.launchctl().filter((c) => c.includes('-herdr')), [`launchctl print gui/1000/${label}`, `launchctl print gui/1000/${label}`, `launchctl enable gui/1000/${label}`], 'state, source (the plist launchd has it from), enabled again; never kickstarted by setup');

  // The same agent disabled (the user's choice, kept): launchd would not bootstrap it again, so the line that runs the rewritten plist turns it on, and says so.
  let answeredOff = 0;
  const off = macDeps(
    {
      script: {
        ...tsScript(),
        'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING],
        [`launchctl print gui/1000/${label}`]: okRun(`gui/1000/${label} = {\n\tstate = running\n\targuments = {\n\t\t/usr/bin/env\n\t\t-u\n\t\tHERDR_SESSION\n\t\t-u\n\t\tHERDR_SOCKET_PATH\n\t\tXDG_CONFIG_HOME=${dir}/.config\n\t\t/opt/homebrew/bin/herdr\n\t\t--session\n\t\told one\n\t\tserver\n\t}\n\tpath = ${dir}/LaunchAgents-off/${label}.plist\n\tpid = 4343\n}\n`),
        'launchctl print-disabled gui/1000': okRun(`disabled services = {\n\t"${label}" => disabled\n}\n`),
      },
      status: async () => {
        if (answeredOff++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'sessions', 'new one', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-off',
  );
  off.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(off.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(off.deps.unitDir, `${label}.plist`), renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', session: 'new one', home: off.home, configHome: path.join(off.home, '.config') }));
  assert.equal(await runSetup(off.deps, OPTS), 0, off.out.join('\n'));
  assert.match(off.out.join('\n'), new RegExp(`· herdr service off \\(${label} is disabled\\); it is running for session old one, not session new one — for session new one:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\\S+/\\.config \\S*herdr --session 'new one' server stop; launchctl bootout gui/1000/${label}; sleep 2; launchctl enable gui/1000/${label} && launchctl bootstrap gui/1000 \\S+/${label}\\.plist   \\(ends every pane it runs, and the herdr answering for session new one outside it; a disabled agent is bootstrapped only once enabled, so this turns it on\\); on:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\\S+/\\.config \\S*herdr --session 'new one' server stop; launchctl bootout gui/1000/${label}; sleep 2; launchctl enable gui/1000/${label} && launchctl bootstrap gui/1000 \\S+/${label}\\.plist   \\(ends every pane of session new one and every pane this unit runs; herdr restores the layouts\\)`), 'a disabled agent running another session: the on-line restarts it (enable && bootstrap would fail on a loaded one)');
  assert.equal(off.launchctl().some((c) => /launchctl (enable|bootstrap|kickstart|bootout)/.test(c) && c.includes('-herdr')), false, 'disabled stays disabled; nothing restarted by setup');

  // The label bootstrapped from another plist (bootout, then bootstrap of a same-label plist elsewhere) while setup's plist stands: not setup's to reuse or disable.
  let answered2 = 0;
  const swapped = macDeps(
    {
      script: {
        ...tsScript(),
        'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING],
        [`launchctl print gui/1000/${label}`]: okRun(`gui/1000/${label} = {\n\tpath = /Users/alice/elsewhere/${label}.plist\n\tstate = running\n\targuments = {\n\t\t/opt/homebrew/bin/herdr\n\t\tserver\n\t}\n\tpid = 4444\n}\n`),
        'launchctl print-disabled gui/1000': okRun('disabled services = {\n}\n'),
      },
      status: async () => {
        if (answered2++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-5',
  );
  swapped.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(swapped.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(swapped.deps.herdrSocket, '');
  fs.mkdirSync(swapped.deps.unitDir, { recursive: true });
  const ours = renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', home: swapped.home, configHome: path.join(swapped.home, '.config') });
  fs.writeFileSync(path.join(swapped.deps.unitDir, `${label}.plist`), ours);
  assert.equal(await runSetup(swapped.deps, { ...OPTS, herdrService: false }), 0, swapped.out.join('\n'));
  assert.match(swapped.out.join('\n'), new RegExp(`· herdr service left as it is: ${label} is loaded by launchd from /Users/alice/elsewhere/${label}.plist, not ${path.join(swapped.deps.unitDir, `${label}.plist`)}, not a unit setup wrote`));
  assert.equal(fs.readFileSync(path.join(swapped.deps.unitDir, `${label}.plist`), 'utf8'), ours);
  assert.deepEqual(swapped.launchctl().filter((c) => c.includes('-herdr')), [`launchctl print gui/1000/${label}`, `launchctl print gui/1000/${label}`], 'looked at, not disabled');

  // launchd runs `program` (a Program key in the plist it was bootstrapped from) with the arguments as argv: what the arguments say is not what runs — opaque, never ✔.
  let answered4 = 0;
  const programOff = macDeps(
    {
      script: {
        ...tsScript(),
        'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING],
        [`launchctl print gui/1000/${label}`]: okRun(`gui/1000/${label} = {\n\tpath = ${path.join(dir, 'LaunchAgents-7', `${label}.plist`)}\n\tstate = running\n\tprogram = /tmp/run-other\n\targuments = {\n\t\t/usr/bin/env\n\t\t-u\n\t\tHERDR_SESSION\n\t\t-u\n\t\tHERDR_SOCKET_PATH\n\t\tXDG_CONFIG_HOME=${dir}/.config\n\t\t/opt/homebrew/bin/herdr\n\t\tserver\n\t}\n\tpid = 4545\n}\n`),
        'launchctl print-disabled gui/1000': okRun('disabled services = {\n}\n'),
      },
      status: async () => {
        if (answered4++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-7',
  );
  programOff.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(programOff.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(programOff.deps.herdrSocket, '');
  fs.mkdirSync(programOff.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(programOff.deps.unitDir, `${label}.plist`), renderLaunchHerdrAgent({ unit: 'remotly-bridge', herdrPath: '/opt/homebrew/bin/herdr', home: programOff.home, configHome: path.join(programOff.home, '.config') }));
  assert.equal(await runSetup(programOff.deps, OPTS), 0, programOff.out.join('\n'));
  assert.match(programOff.out.join('\n'), new RegExp(`⚠ herdr service ${label} \\(/opt/homebrew/bin/herdr\\) is running \\(pid 4545\\) what cannot be told from its process \\(program /tmp/run-other, arguments /usr/bin/env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=${dir}/.config /opt/homebrew/bin/herdr server\\); the file is for the default session, which a restart starts:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\\S+/\\.config \\S*herdr server stop; launchctl bootout gui/1000/${label}; sleep 2; launchctl bootstrap gui/1000 \\S+/${label}\\.plist   \\(ends every pane it runs and the herdr answering for the default session if that is another; herdr restores the layouts\\)`));
  assert.equal(programOff.out.join('\n').includes('✔ herdr service'), false);

  // A plist under another file name declaring the label (booted out or not): the label is that file's; nothing written, enabled or disabled.
  let answered3 = 0;
  const twin = macDeps(
    {
      script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING], [`launchctl print gui/1000/${label}`]: { code: 113, stdout: '', stderr: `Could not find service "${label}" in domain for user gui: 1000` } },
      status: async () => {
        if (answered3++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-6',
  );
  twin.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(twin.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(twin.deps.herdrSocket, '');
  fs.mkdirSync(twin.deps.unitDir, { recursive: true });
  const twinPlist = path.join(twin.deps.unitDir, 'my-herdr.plist');
  fs.writeFileSync(twinPlist, `<plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>\n`);
  assert.equal(await runSetup(twin.deps, { ...OPTS, herdrService: false }), 0, twin.out.join('\n'));
  assert.match(twin.out.join('\n'), new RegExp(`· herdr service left as it is: ${label} is defined by ${twinPlist}, not a unit setup wrote`));
  assert.equal(fs.existsSync(path.join(twin.deps.unitDir, `${label}.plist`)), false);
  assert.deepEqual(twin.launchctl().filter((c) => c.includes('-herdr')), [`launchctl print gui/1000/${label}`], 'state looked at; not disabled');
});

test('herdr service: a first setup with herdr down writes <unit>-herdr for the herdr on PATH, enables and starts it, and has herdr up before the herdr check', async () => {
  const m = herdrDeps({ script: herdrDown() });
  m.startsHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  const text = m.out.join('\n');
  assert.match(text, /✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) started\n\s+✔ herdr 0\.8\.0 \(protocol 19\)/);
  assert.match(text, /✔ bridge running: .*herdr up/);
  assert.match(text, /setup complete$/);
  assert.equal(text.includes('✖'), false);
  assert.equal(text.includes('⚠'), false);
  const unit = fs.readFileSync(m.unitPath, 'utf8');
  assert.match(unit, /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/usr\/local\/bin\/herdr" server$/m, 'the default session');
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(fs.statSync(m.unitPath).mode & 0o777, 0o644);
  const sd = m.calls.filter((c) => c.startsWith('systemctl') && !c.includes('MainPID'));
  assert.deepEqual(sd, [
    'systemctl --user show-environment', // the session, before anything is written
    `systemctl --user is-enabled ${HERDR_UNIT}`, // fresh?
    'systemctl --user daemon-reload',
    `systemctl --user show -p FragmentPath,DropInPaths ${HERDR_UNIT}`, // loaded now: any drop-in from a load path that applies to it only now
    `systemctl --user enable ${HERDR_UNIT}`,
    `systemctl --user start ${HERDR_UNIT}`, // herdr is down: started (never restarted)
    'systemctl --user daemon-reload',
    'systemctl --user enable remotly-bridge.service',
    'systemctl --user restart remotly-bridge.service',
  ]);
  assert.equal(m.calls.includes('herdr --version'), false, 'herdr came up under the service: no "is it installed?" question');

  // The herdr on PATH, by default: found by setup's own environment, absolute (the unit runs from no shell).
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\n', { mode: 0o755 });
  const fromPath = herdrDeps({ script: herdrDown(), env: { PATH: `relative:/nonexistent/bin:${bin}` } });
  delete fromPath.deps.herdrBinary; // the default: setup's own PATH
  fromPath.startsHerdr();
  assert.equal(await runSetup(fromPath.deps, OPTS), 0);
  assert.match(fs.readFileSync(fromPath.unitPath, 'utf8'), new RegExp(`^ExecStart="/usr/bin/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=${fromPath.home}/.config" "${bin}/herdr" server$`, 'm'));
  assert.match(fromPath.out.join('\n'), new RegExp(`✔ herdr service remotly-bridge-herdr\\.service \\(${bin}/herdr\\) started`));
});

test('herdr service: a herdr started from a terminal keeps running — the unit is written and enabled for the session the bridge follows, not started; it takes over at the next boot', async () => {
  const m = herdrDeps({ script: herdrDown() }, 'work');
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  const text = m.out.join('\n');
  assert.match(text, /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(from a terminal\), so it takes over at the next boot — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work; herdr restores the layout\)\n\s+✔ herdr 0\.8\.0/);
  assert.equal(text.includes('⚠'), false);
  assert.match(fs.readFileSync(m.unitPath, 'utf8'), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/usr\/local\/bin\/herdr" --session "work" server$/m);
  assert.deepEqual(m.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`], 'enabled, never started or restarted over the running herdr (that ends every pane)');

  // Later setups find the unit enabled: rewritten (the herdr on PATH may have moved), enabled again, still not started.
  const again = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') }, herdrBinary: () => '/opt/herdr/bin/herdr' }, 'work');
  again.touchHerdr();
  assert.equal(await runSetup(again.deps, OPTS), 0);
  assert.match(again.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/opt\/herdr\/bin\/herdr, session work\) installed: herdr is running outside it now/);
  assert.match(fs.readFileSync(again.unitPath, 'utf8'), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/opt\/herdr\/bin\/herdr" --session "work" server$/m);
  assert.deepEqual(again.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);

  // A unit that failed (a crash loop before herdr was started by hand) is start-rate-limited: the hand-over printed clears that first.
  const failed = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'failed', 'failed', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } }, 'work');
  failed.touchHerdr();
  assert.equal(await runSetup(failed.deps, OPTS), 0);
  assert.match(failed.out.join('\n'), /installed: herdr is running outside it now \(from a terminal\), so it takes over at the next boot — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user reset-failed remotly-bridge-herdr\.service; systemctl --user restart remotly-bridge-herdr\.service/);
  assert.deepEqual(failed.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`], 'not restarted by setup');
});

test('herdr service: one per session — a second bridge following the same session gets none while the first\'s unit exists; two already there are said', async () => {
  // The provider as the manager has it: enabled, loaded, from its file, no drop-in of its own. (`vouch` answers the manager's questions about alpha's unit.)
  const ALPHA = 'alpha-herdr.service';
  const alphaWord = (over: Record<string, ExecResult> = {}) => ({ [`systemctl --user is-enabled ${ALPHA}`]: okRun('enabled\n'), [`${SHOW} ${ALPHA}`]: unitShow('loaded', 'inactive', 'dead', 0), ...over });
  const vouch = (d: ReturnType<typeof herdrDeps>, dropIns = '', from?: string) => {
    const base = d.deps.exec;
    d.deps.exec = async (cmd, args, o) => (`${cmd} ${args.join(' ')}` === `systemctl --user show -p FragmentPath,DropInPaths ${ALPHA}` ? okRun(`FragmentPath=${from ?? path.join(path.dirname(d.unitPath), ALPHA)}\nDropInPaths=${dropIns}\n`) : base(cmd, args, o));
  };
  const m = herdrDeps({ script: { ...herdrDown(), ...alphaWord() } }, 'work');
  vouch(m);
  m.touchHerdr();
  fs.mkdirSync(path.dirname(m.unitPath), { recursive: true });
  const alphas = renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(m.home, '.config') });
  fs.writeFileSync(path.join(path.dirname(m.unitPath), ALPHA), alphas);
  fs.writeFileSync(path.join(path.dirname(m.unitPath), 'beta-herdr.service'), renderSystemdHerdrUnit({ unit: 'beta', herdrPath: HERDR_BIN, session: 'other', configHome: path.join(m.home, '.config') })); // another session: not this one's
  fs.writeFileSync(path.join(path.dirname(m.unitPath), 'gamma-herdr.service'), '[Service]\nExecStart=/usr/local/bin/herdr --session work server\n'); // not setup's: nobody's provider
  assert.equal(await runSetup(m.deps, OPTS), 0);
  assert.match(m.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already; none installed for remotly-bridge \(a second would race it for the socket\)/);
  assert.equal(fs.existsSync(m.unitPath), false, 'nothing written');
  assert.deepEqual(m.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'nothing enabled or started');
  const smFor = (d: ReturnType<typeof herdrDeps>) => systemdManager({ exec: d.deps.exec, unitDir: path.dirname(d.unitPath), user: 'alice', uid: 1000, home: d.home, sleep: async () => undefined });
  assert.deepEqual(await otherHerdrUnits(smFor(m), 'remotly-bridge', 'work', path.join(m.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'provider', activators: [], pullers: [], stoppedWith: [] }]);
  assert.deepEqual(await otherHerdrUnits(smFor(m), 'remotly-bridge', 'work', path.join(m.home, '.config'), () => false), [], 'a herdr that is not there to run: nobody\'s provider');

  // Alpha's unit short of a provider — disabled; or with a drop-in of its own as the manager lists it (an ExecStart reset to another session) — is nobody's: ours is installed.
  for (const [why, over, dropIns, from] of [
    ['disabled', { [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' } }, '', undefined],
    ['a drop-in of its own', {}, '/etc/systemd/user/alpha-herdr.service.d/override.conf', undefined],
    ['unknown to the manager', { [`${SHOW} ${ALPHA}`]: unitShow('not-found', 'inactive', 'dead', 0) }, '', undefined],
    ['loaded from another path', {}, '', '/etc/systemd/user/alpha-herdr.service'],
    ['no path the manager names', {}, '', ''],
  ] as const) {
    const d = herdrDeps({ script: { ...herdrDown(), ...alphaWord(over) } }, 'work');
    vouch(d, dropIns, from);
    d.touchHerdr();
    fs.mkdirSync(path.dirname(d.unitPath), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(d.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(d.home, '.config') }));
    assert.equal(await runSetup(d.deps, OPTS), 0);
    assert.equal(d.out.join('\n').includes('none installed'), false, why);
    assert.ok(fs.existsSync(d.unitPath), `${why}: ours is written`);
    assert.deepEqual(await otherHerdrUnits(smFor(d), 'remotly-bridge', 'work', path.join(d.home, '.config'), () => true), [], why);
  }

  // --no-herdr-service beside a provider: ours is still written, disabled — that is how the choice lasts (an unattended update leaves a disabled unit so; with nothing written, it would install one once the provider is gone). A later setup finds a disabled unit of ours beside the provider: no race.
  const optOut = herdrDeps({ script: { ...herdrDown(), ...alphaWord() } }, 'work');
  vouch(optOut);
  optOut.touchHerdr();
  fs.mkdirSync(path.dirname(optOut.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(optOut.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(optOut.home, '.config') }));
  assert.equal(await runSetup(optOut.deps, { ...OPTS, herdrService: false }), 0, optOut.out.join('\n'));
  assert.match(optOut.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already\n/);
  assert.match(optOut.out.join('\n'), /· herdr service off \(--no-herdr-service\): remotly-bridge-herdr\.service written but disabled; on, as the session's one \(alpha-herdr\.service starts it already; two would race\):  systemctl --user disable --now alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service runs now; herdr restores the layouts\)/);
  assert.ok(fs.existsSync(optOut.unitPath), 'written, so the choice lasts');
  assert.deepEqual(optOut.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user disable ${HERDR_UNIT}`]);
  const later = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, ...alphaWord() } }, 'work');
  vouch(later);
  later.touchHerdr();
  fs.writeFileSync(path.join(path.dirname(later.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(later.home, '.config') }));
  assert.equal(await runSetup(later.deps, OPTS), 0, later.out.join('\n'));
  assert.match(later.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already; remotly-bridge-herdr\.service is disabled and races it for nothing\n/);
  assert.match(later.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); on, as the session's one \(alpha-herdr\.service starts it already; two would race\):  systemctl --user disable --now alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service runs now; herdr restores the layouts\)/, 'turning ours on beside the provider would make two: the line hands the session over');
  assert.equal(later.out.join('\n').includes('⚠ two herdr services'), false);
  // Both enabled, and this run turns ours off: nothing to say against theirs.
  const turningOff = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), ...alphaWord() } }, 'work');
  vouch(turningOff);
  turningOff.touchHerdr();
  fs.writeFileSync(path.join(path.dirname(turningOff.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(turningOff.home, '.config') }));
  assert.equal(await runSetup(turningOff.deps, { ...OPTS, herdrService: false }), 0, turningOff.out.join('\n'));
  assert.match(turningOff.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already\n/);
  assert.equal(turningOff.out.join('\n').includes('⚠ two herdr services'), false, 'a line disabling theirs, with ours disabled by this run, would leave none');
  assert.deepEqual(turningOff.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user disable ${HERDR_UNIT}`]);

  // Both enabled, ours running another session (the bridge was moved to `work`): the restart that puts ours on `work` turns alpha off first — its Restart=always would bring its herdr back against ours.
  const oldProc = async (pid: number) => (pid === 777 ? [HERDR_BIN, '--session', 'old', 'server'] : null);
  const bothMoved = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), ...alphaWord() }, processArgs: oldProc }, 'work');
  vouch(bothMoved);
  bothMoved.touchHerdr();
  fs.writeFileSync(path.join(path.dirname(bothMoved.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(bothMoved.home, '.config') }));
  assert.equal(await runSetup(bothMoved.deps, OPTS), 0, bothMoved.out.join('\n'));
  assert.match(bothMoved.out.join('\n'), /⚠ two herdr services for session work: remotly-bridge-herdr\.service and alpha-herdr\.service \(bridge unit alpha's\) — at boot they race for the socket; keep one, from the next boot:  systemctl --user disable alpha-herdr\.service   \(what runs now keeps running\)\n/);
  assert.match(bothMoved.out.join('\n'), /is running \(pid 777\) for session old, rewritten for session work: it takes over at the next boot — or now:  systemctl --user disable --now alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session old, every pane of session work \(it runs outside the unit now\) and whatever alpha-herdr\.service runs now; herdr restores the layouts\)\n/, 'the hand-over turns the provider off first');
  assert.deepEqual(bothMoved.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`], 'nothing restarted or disabled by setup');
  // Ours disabled and running another session beside the provider: `enable --now` would leave it running that one (a start is nothing to an active unit), so the on-line restarts it — and no "disabled, running work" is offered beside the provider (the two would fight for the socket now).
  const offMoved = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, ...alphaWord() }, processArgs: oldProc }, 'work');
  vouch(offMoved);
  offMoved.touchHerdr();
  fs.writeFileSync(path.join(path.dirname(offMoved.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(offMoved.home, '.config') }));
  assert.equal(await runSetup(offMoved.deps, OPTS), 0, offMoved.out.join('\n'));
  assert.match(offMoved.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); it is running for session old, not session work; on, as the session's one \(alpha-herdr\.service starts it already; two would race\):  systemctl --user disable --now alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user enable remotly-bridge-herdr\.service; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session work, every pane this unit runs and whatever alpha-herdr\.service runs now; herdr restores the layouts\)\n/);
  assert.deepEqual(offMoved.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'nothing enabled or restarted by setup');

  // Two providers already there (each from before the other followed `work`): every one is named, and every one is turned off in the lines that put ours in their place — one left enabled would race ours.
  const BETA = 'beta2-herdr.service';
  const pair = (over: Record<string, ExecResult>) => herdrDeps({ script: { ...alphaWord({ [`systemctl --user is-enabled ${BETA}`]: okRun('enabled\n'), [`${SHOW} ${BETA}`]: unitShow('loaded', 'inactive', 'dead', 0), ...over }) } }, 'work');
  const vouchBoth = (d: ReturnType<typeof herdrDeps>) => {
    vouch(d);
    const base = d.deps.exec;
    d.deps.exec = async (cmd, args, o) => (`${cmd} ${args.join(' ')}` === `systemctl --user show -p FragmentPath,DropInPaths ${BETA}` ? okRun(`FragmentPath=${path.join(path.dirname(d.unitPath), BETA)}\nDropInPaths=\n`) : base(cmd, args, o));
    for (const [u, f] of [['alpha', ALPHA], ['beta2', BETA]] as const) fs.writeFileSync(path.join(path.dirname(d.unitPath), f), renderSystemdHerdrUnit({ unit: u, herdrPath: HERDR_BIN, session: 'work', configHome: path.join(d.home, '.config') }));
  };
  const twoOff = pair({ [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' } });
  vouchBoth(twoOff);
  twoOff.touchHerdr();
  assert.equal(await runSetup(twoOff.deps, OPTS), 0, twoOff.out.join('\n'));
  assert.deepEqual(await otherHerdrUnits(smFor(twoOff), 'remotly-bridge', 'work', path.join(twoOff.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'provider', activators: [], pullers: [], stoppedWith: [] }, { unit: 'beta2-herdr', bridge: 'beta2', role: 'provider', activators: [], pullers: [], stoppedWith: [] }]);
  assert.match(twoOff.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) and beta2-herdr\.service \(bridge unit beta2's\) start session work at boot already; remotly-bridge-herdr\.service is disabled and races them for nothing\n/);
  assert.match(twoOff.out.join('\n'), /on, as the session's one \(alpha-herdr\.service and beta2-herdr\.service start it already; two would race\):  systemctl --user disable --now alpha-herdr\.service; systemctl --user disable --now beta2-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service and beta2-herdr\.service run now; herdr restores the layouts\)/);
  const twoOn = pair({ [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') });
  vouchBoth(twoOn);
  twoOn.touchHerdr();
  assert.equal(await runSetup(twoOn.deps, OPTS), 0, twoOn.out.join('\n'));
  assert.match(twoOn.out.join('\n'), /⚠ 3 herdr services for session work: remotly-bridge-herdr\.service, alpha-herdr\.service \(bridge unit alpha's\) and beta2-herdr\.service \(bridge unit beta2's\) — at boot they race for the socket; keep one, from the next boot:  systemctl --user disable alpha-herdr\.service; systemctl --user disable beta2-herdr\.service   \(what runs now keeps running\)\n/);
  assert.match(twoOn.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(under alpha-herdr\.service and beta2-herdr\.service, or from a terminal\), so it takes over at the next boot — or now:  systemctl --user disable --now alpha-herdr\.service; systemctl --user disable --now beta2-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service and beta2-herdr\.service run now; herdr restores the layouts\)\n/);

  // Alpha's unit disabled (without --now) but still running the session: nobody's provider — ours is installed — but a runner: the hand-over stops it through the manager (a `herdr server stop` alone would have its Restart=always bring it back against ours).
  const runner = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`${SHOW} ${ALPHA}`]: unitShow('loaded', 'active', 'running', 4040) }) } }, 'work');
  vouch(runner);
  runner.touchHerdr();
  fs.mkdirSync(path.dirname(runner.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(runner.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(runner.home, '.config') }));
  assert.deepEqual(await otherHerdrUnits(smFor(runner), 'remotly-bridge', 'work', path.join(runner.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'runner', activators: [], pullers: [], stoppedWith: [] }]);
  // Ours disabled and running another session while alpha's unit (disabled) runs the wanted one: the "for session work" line turns alpha off first and names what it ends, as the on-line does.
  const runnerMoved = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`${SHOW} ${ALPHA}`]: unitShow('loaded', 'active', 'running', 4040) }), [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' } }, processArgs: async (pid: number) => (pid === 777 ? [HERDR_BIN, '--session', 'old', 'server'] : null) }, 'work');
  vouch(runnerMoved);
  runnerMoved.touchHerdr();
  fs.mkdirSync(path.dirname(runnerMoved.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(runnerMoved.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(runnerMoved.home, '.config') }));
  fs.writeFileSync(runnerMoved.unitPath, ownUnit(HERDR_BIN, 'old', runnerMoved.home));
  assert.equal(await runSetup(runnerMoved.deps, OPTS), 0, runnerMoved.out.join('\n'));
  assert.match(runnerMoved.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); it is running for session old, not session work — for session work:  systemctl --user stop alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane it runs, and the herdr answering for session work outside it, and whatever alpha-herdr\.service runs now\); on:  systemctl --user stop alpha-herdr\.service; /, 'alpha off first on the shortcut line too');
  // A runner with a unit of the user's that is part of it: the stop names that unit too.
  const runnerPart = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`${SHOW} ${ALPHA}`]: unitShow('loaded', 'active', 'running', 4040), [`systemctl --user show -p WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo ${ALPHA}`]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=desk.service\nPropagatesStopTo=\n') }) } }, 'work');
  vouch(runnerPart);
  runnerPart.touchHerdr();
  fs.mkdirSync(path.dirname(runnerPart.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(runnerPart.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(runnerPart.home, '.config') }));
  assert.deepEqual(await otherHerdrUnits(smFor(runnerPart), 'remotly-bridge', 'work', path.join(runnerPart.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'runner', activators: [], pullers: [], stoppedWith: ['desk.service'] }]);
  assert.equal(await runSetup(runnerPart.deps, OPTS), 0, runnerPart.out.join('\n'));
  assert.match(runnerPart.out.join('\n'), /systemctl --user stop alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service runs now, and desk\.service, which the manager stops with it \(and whatever depends on those\); herdr restores the layouts\)\n/);
  assert.equal(await runSetup(runner.deps, OPTS), 0, runner.out.join('\n'));
  assert.ok(fs.existsSync(runner.unitPath), 'no provider: ours is installed');
  assert.match(runner.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(under alpha-herdr\.service, or from a terminal\), so it takes over at the next boot — or now:  systemctl --user stop alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service runs now; herdr restores the layouts\)\n/);

  // Alpha's unit disabled, but a timer of the user's own (`alpha-herdr.timer`) triggers it: nobody's provider — ours is installed — but a possible starter of the session at boot (the timer's arrangement): no take-over at boot is claimed, the hand-over turns it off with its timer in one command, and the keep-one line names both.
  const ALPHA_PULLED = `systemctl --user show -p WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo ${ALPHA}`;
  const possible = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [ALPHA_PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=alpha-herdr.timer\nOnFailureOf=\nOnSuccessOf=\n'), 'systemctl --user is-enabled alpha-herdr.timer': okRun('enabled\n') }) } }, 'work');
  vouch(possible);
  possible.touchHerdr();
  fs.mkdirSync(path.dirname(possible.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(possible.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(possible.home, '.config') }));
  assert.deepEqual(await otherHerdrUnits(smFor(possible), 'remotly-bridge', 'work', path.join(possible.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'possible', activators: ['alpha-herdr.timer'], pullers: [], stoppedWith: [] }]);
  assert.equal(await runSetup(possible.deps, OPTS), 0, possible.out.join('\n'));
  assert.ok(fs.existsSync(possible.unitPath), 'no provider: ours is installed');
  assert.match(possible.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(under alpha-herdr\.service, or from a terminal\) — hand over to this one now:  systemctl --user disable --now alpha-herdr\.timer; systemctl --user stop alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.timer and alpha-herdr\.service run now; herdr restores the layouts\)\n  ⚠ herdr service alpha-herdr\.service \(bridge unit alpha's\) is not enabled, but alpha-herdr\.timer starts it: if that starts session work at boot too, it and remotly-bridge-herdr\.service race for the socket there — keep one, from the next boot:  systemctl --user disable alpha-herdr\.timer   or  systemctl --user disable remotly-bridge-herdr\.service\n/);
  assert.equal(possible.out.join('\n').includes('takes over at the next boot'), false, 'no take-over claim beside a unit a timer of the user\'s may start');
  // Alpha's unit disabled but wanted by a drop-in of the user's on default.target: a possible starter too, with nothing here that keeps it from starting — the keep-one line says what wants it and offers ours alone.
  const wantedAlpha = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [`systemctl --user is-enabled ${ALPHA}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [ALPHA_PULLED]: okRun('WantedBy=default.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\n') }) } }, 'work');
  vouch(wantedAlpha);
  wantedAlpha.touchHerdr();
  fs.mkdirSync(path.dirname(wantedAlpha.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(wantedAlpha.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(wantedAlpha.home, '.config') }));
  assert.deepEqual(await otherHerdrUnits(smFor(wantedAlpha), 'remotly-bridge', 'work', path.join(wantedAlpha.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'possible', activators: [], pullers: [{ unit: 'default.target', how: 'wants it' }], stoppedWith: [] }]);
  assert.equal(await runSetup(wantedAlpha.deps, OPTS), 0, wantedAlpha.out.join('\n'));
  assert.match(wantedAlpha.out.join('\n'), /— hand over to this one now:  systemctl --user stop alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.service runs now; herdr restores the layouts\)\n  ⚠ herdr service alpha-herdr\.service \(bridge unit alpha's\) is not enabled, but default\.target wants it: if that starts session work at boot too, it and remotly-bridge-herdr\.service race for the socket there — keep one, from the next boot:  systemctl --user disable remotly-bridge-herdr\.service   — or keep alpha-herdr\.service from starting yourself \(default\.target wants it: no line here turns it off\)\n/);
  assert.equal(wantedAlpha.out.join('\n').includes('takes over at the next boot'), false);
  // A provider the user's timer triggers too: turned off with the timer, in the hand-over line and the keep-one line both.
  const timedProvider = herdrDeps({ script: { ...herdrDown(), ...alphaWord({ [ALPHA_PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=alpha-herdr.timer\nOnFailureOf=\nOnSuccessOf=\n'), 'systemctl --user is-enabled alpha-herdr.timer': okRun('enabled\n') }), [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' } } }, 'work');
  vouch(timedProvider);
  timedProvider.touchHerdr();
  fs.mkdirSync(path.dirname(timedProvider.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(timedProvider.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(timedProvider.home, '.config') }));
  fs.writeFileSync(timedProvider.unitPath, ownUnit(HERDR_BIN, 'work', timedProvider.home));
  assert.deepEqual(await otherHerdrUnits(smFor(timedProvider), 'remotly-bridge', 'work', path.join(timedProvider.home, '.config'), () => true), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'provider', activators: ['alpha-herdr.timer'], pullers: [], stoppedWith: [] }]);
  assert.equal(await runSetup(timedProvider.deps, OPTS), 0, timedProvider.out.join('\n'));
  assert.match(timedProvider.out.join('\n'), /on, as the session's one \(alpha-herdr\.service starts it already; two would race\):  systemctl --user disable --now alpha-herdr\.timer alpha-herdr\.service; env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of session work and whatever alpha-herdr\.timer and alpha-herdr\.service run now; herdr restores the layouts\)/);

  // The herdr that answers runs under a service of the user's own (`herdr.service`, Restart=always): told from its process on Linux. The hand-over stops that unit, not the herdr (which would be back in 2 s); enabled, it is a second starter at boot, said as such with the line that keeps one.
  const supervised = (standing: ExecResult, more: Record<string, ExecResult> = {}, session = 'work', script: Record<string, ExecResult> = {}, sup = 'herdr.service', restart = 'always', mainPid = 4242, transient = 'no', comm = 'konsole') => herdrDeps({ script: { ...herdrDown(), ...script, [`systemctl --user is-enabled ${sup}`]: standing, [`systemctl --user show -p Restart,MainPID,Transient ${sup}`]: okRun(`Restart=${restart}\nMainPID=${mainPid}\nTransient=${transient}\n`), ...more }, socketPid: () => 4242, processUnit: (pid: number) => (pid === 4242 ? sup : null), processComm: (pid: number) => (pid === 4000 ? comm : pid === 4242 ? 'herdr' : null), processArgs: async (pid: number) => (pid === 777 ? [HERDR_BIN, '--session', 'old', 'server'] : null) }, session);
  const PULLED = 'systemctl --user show -p WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo herdr.service';
  const disabledUnit: ExecResult = { code: 1, stdout: 'disabled\n', stderr: '' };
  const own = supervised(disabledUnit);
  own.touchHerdr();
  assert.equal(await runSetup(own.deps, OPTS), 0, own.out.join('\n'));
  assert.match(own.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write\), so it takes over at the next boot — or now:  systemctl --user stop herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs; herdr restores the layout\)\n/);
  assert.deepEqual(own.calls.filter((c) => c.endsWith(' herdr.service')), ['systemctl --user is-enabled herdr.service', PULLED, 'systemctl --user show -p Restart,MainPID,Transient herdr.service'], 'disabled, and nothing of the user\'s pulls in or triggers it: it does not start at boot; Restart=always: stopped as a unit');
  // A unit that neither brings herdr back (Restart=no) nor starts at boot, and has herdr for its main process (a plain `systemd-run`: stopping herdr ends it) or is a desktop app's transient unit whose main process is a terminal emulator (konsole's under KDE, herdr started in its terminal), is a terminal's kind: the stop line is herdr's own, nothing is said of the unit.
  for (const [kind, m] of [['konsole under KDE', supervised({ code: 1, stdout: 'transient\n', stderr: '' }, {}, 'work', {}, 'app-org.kde.konsole@abc.service', 'no', 4000, 'yes')], ['plain systemd-run', supervised({ code: 1, stdout: 'transient\n', stderr: '' }, {}, 'work', {}, 'run-u7.service', 'no', 4242, 'yes')]] as const) {
    m.touchHerdr();
    assert.equal(await runSetup(m.deps, OPTS), 0, m.out.join('\n'));
    assert.match(m.out.join('\n'), /installed: herdr is running outside it now \(from a terminal\), so it takes over at the next boot — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session work server stop; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work; herdr restores the layout\)\n/, kind);
  }
  // Restart=no and not at boot, but herdr is not its main process (a wrapper — a shell loop — that may start herdr again): stopped as a unit, whatever Restart= reads — and whatever its name: a transient `app-…` unit whose main process is a shell, not a terminal emulator, is one too.
  for (const [kind, name, transient] of [['a unit of the user\'s', 'herdr-loop.service', 'no'], ['a transient app- unit run by hand', 'app-herdr-loop.service', 'yes']] as const) {
    const wrapper = supervised(transient === 'yes' ? { code: 1, stdout: 'transient\n', stderr: '' } : disabledUnit, { [`systemctl --user show -p WantedBy,RequiredBy,UpheldBy,BoundBy,TriggeredBy,OnFailureOf,OnSuccessOf,RequisiteOf,ConsistsOf,PropagatesStopTo ${name}`]: okRun('') }, 'work', {}, name, 'no', 4000, transient, 'sh');
    wrapper.touchHerdr();
    assert.equal(await runSetup(wrapper.deps, OPTS), 0, wrapper.out.join('\n'));
    assert.match(wrapper.out.join('\n'), new RegExp(`installed: herdr is running outside it now \\(under ${name.replace('.', '\\.')}, a unit setup did not write\\), so it takes over at the next boot — or now:  systemctl --user stop ${name.replace('.', '\\.')}; systemctl --user start remotly-bridge-herdr\\.service   \\(ends every pane of session work and whatever else ${name.replace('.', '\\.')} runs; herdr restores the layout\\)\n`), kind);
  }
  // Enabled, though Restart=no: a starter at boot all the same — the keep-one line, and the hand-over turns it off.
  const noRestartOn = supervised(okRun('enabled\n'), {}, 'work', {}, 'herdr.service', 'no');
  noRestartOn.touchHerdr();
  assert.equal(await runSetup(noRestartOn.deps, OPTS), 0, noRestartOn.out.join('\n'));
  assert.match(noRestartOn.out.join('\n'), /— hand over to this one now:  systemctl --user disable --now herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write and enabled too/);
  // `enabled-runtime` ends with this boot (its links live under /run); a transient unit (`systemd-run --user -p Restart=always … herdr server`) goes with it too: neither starts herdr at the next boot — and the transient one is stopped as a unit, since a `herdr server stop` would have it restarted.
  const runtime = supervised(okRun('enabled-runtime\n'));
  runtime.touchHerdr();
  assert.equal(await runSetup(runtime.deps, OPTS), 0, runtime.out.join('\n'));
  assert.match(runtime.out.join('\n'), /installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write\), so it takes over at the next boot — or now:  systemctl --user stop herdr\.service; /);
  const transient = supervised({ code: 1, stdout: 'transient\n', stderr: '' }, {}, 'work', {}, 'run-u5.service');
  transient.touchHerdr();
  assert.equal(await runSetup(transient.deps, OPTS), 0, transient.out.join('\n'));
  assert.match(transient.out.join('\n'), /installed: herdr is running outside it now \(under run-u5\.service, a unit setup did not write\), so it takes over at the next boot — or now:  systemctl --user stop run-u5\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else run-u5\.service runs; herdr restores the layout\)\n/);
  assert.equal(transient.out.join('\n').includes('⚠ herdr runs under'), false, 'a transient unit is no starter at boot: no keep-one line');
  const ownOn = supervised(okRun('enabled\n'));
  ownOn.touchHerdr();
  assert.equal(await runSetup(ownOn.deps, OPTS), 0, ownOn.out.join('\n'));
  assert.match(ownOn.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write, enabled\) — hand over to this one now:  systemctl --user disable --now herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service\n/);
  assert.equal(ownOn.out.join('\n').includes('takes over at the next boot'), false, 'no take-over claim beside an enabled unit of the user\'s own');
  // Beside another bridge's provider (nothing of ours installed): the race is theirs and the user's unit's, said with the line that keeps one of those two.
  const sharedOn = supervised(okRun('enabled\n'), { ...alphaWord() });
  vouch(sharedOn);
  sharedOn.touchHerdr();
  fs.mkdirSync(path.dirname(sharedOn.unitPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(sharedOn.unitPath), ALPHA), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(sharedOn.home, '.config') }));
  assert.equal(await runSetup(sharedOn.deps, OPTS), 0, sharedOn.out.join('\n'));
  assert.match(sharedOn.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already; none installed for remotly-bridge \(a second would race it for the socket\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write and enabled too: at boot it and alpha-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.service   or  systemctl --user disable alpha-herdr\.service\n/);
  assert.equal(fs.existsSync(sharedOn.unitPath), false);
  // `static` (no [Install]; started by whatever wants it), or disabled but wanted by a target of the user's own, or started when a unit of theirs fails: whether it starts herdr at boot is not told — no take-over is claimed, the race is said as a possibility, the hand-over stops it (nothing enabled to disable: a `disable` would undo none of that), and the keep-one line says what pulls it in and that no line here undoes it, instead of a disable that would not hold.
  for (const [arrangement, m, how] of [['static', supervised(okRun('static\n')), 'it is static'], ['pulled in', supervised(disabledUnit, { [PULLED]: okRun('WantedBy=my-desk.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\n') }), 'my-desk.target wants it'], ['started when another fails', supervised(disabledUnit, { [PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=my-desk.service\nOnSuccessOf=\n') }), 'my-desk.service starts it when it fails']] as const) {
    m.touchHerdr();
    assert.equal(await runSetup(m.deps, OPTS), 0, m.out.join('\n'));
    const pulled = how === 'it is static' ? '' : `${how}; `;
    const text = m.out.join('\n');
    assert.ok(text.includes(`  · herdr service remotly-bridge-herdr.service (/usr/local/bin/herdr, session work) installed: herdr is running outside it now (under herdr.service, a unit setup did not write (${pulled}whether it starts herdr at boot is its own arrangement)) — hand over to this one now:  systemctl --user stop herdr.service; systemctl --user start remotly-bridge-herdr.service   (ends every pane of session work and whatever else herdr.service runs; herdr restores the layout)\n  ⚠ herdr runs under herdr.service, a unit setup did not write${pulled ? ` (${how})` : ''}: if it starts herdr at boot too, it and remotly-bridge-herdr.service race for the socket there — keep one, from the next boot:  systemctl --user disable remotly-bridge-herdr.service   — or keep herdr.service from starting yourself (${how}: no line here turns it off)\n`), `${arrangement}: ${text}`);
    assert.equal(m.out.join('\n').includes('takes over at the next boot'), false, arrangement);
    assert.equal(m.out.join('\n').includes('disable herdr.service'), false, `${arrangement}: no disable that would not hold`);
  }
  // Triggered by a timer (or a socket) of the user's own, or upheld by a unit of theirs: stopped or disabled alone, that would start it again — so every line names the trigger with it, in one command, the trigger first. Disabled itself: its own arrangement (the timer's); enabled too: a starter at boot, its timer named all the same.
  const timerOn = { 'systemctl --user is-enabled herdr.timer': okRun('enabled\n') };
  const timed = supervised(disabledUnit, { [PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=herdr.timer\nOnFailureOf=\nOnSuccessOf=\n'), ...timerOn });
  timed.touchHerdr();
  assert.equal(await runSetup(timed.deps, OPTS), 0, timed.out.join('\n'));
  assert.match(timed.out.join('\n'), /installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write \(herdr\.timer starts it; whether it starts herdr at boot is its own arrangement\)\) — hand over to this one now:  systemctl --user disable --now herdr\.timer; systemctl --user stop herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.timer and herdr\.service run; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(herdr\.timer starts it\): if it starts herdr at boot too, it and remotly-bridge-herdr\.service race for the socket there — keep one, from the next boot:  systemctl --user disable herdr\.timer   or  systemctl --user disable remotly-bridge-herdr\.service\n/, 'the disabled unit is stopped, its enabled timer turned off first; both named among what ends');
  // Enabled, with its own link under default.target.wants (what `disable` removes: no puller), an enabled timer and socket triggering it, a static upholder (`workspace.service`, Upholds=): the enabled ones are disabled with it, the static one stopped with it — and named among what the line ends, since a unit is stopped as a whole — and what starts the static one is said to be beyond these lines.
  const timedOn = supervised(okRun('enabled\n'), { [PULLED]: okRun('WantedBy=default.target\nRequiredBy=\nUpheldBy=workspace.service\nBoundBy=\nTriggeredBy=herdr.timer herdr.socket\nOnFailureOf=\nOnSuccessOf=\n'), ...timerOn, 'systemctl --user is-enabled herdr.socket': okRun('enabled\n'), 'systemctl --user is-enabled workspace.service': okRun('static\n') });
  fs.mkdirSync(path.join(path.dirname(timedOn.unitPath), 'default.target.wants'), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(timedOn.unitPath), 'herdr.service'), path.join(path.dirname(timedOn.unitPath), 'default.target.wants', 'herdr.service'));
  timedOn.touchHerdr();
  assert.equal(await runSetup(timedOn.deps, OPTS), 0, timedOn.out.join('\n'));
  assert.match(timedOn.out.join('\n'), /installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write, enabled \(herdr\.timer, herdr\.socket and workspace\.service start it\)\) — hand over to this one now:  systemctl --user stop workspace\.service; systemctl --user disable --now herdr\.timer herdr\.socket herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.timer, herdr\.socket, workspace\.service and herdr\.service run; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(herdr\.timer, herdr\.socket and workspace\.service start it\) and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.timer herdr\.socket herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service \(herdr\.service: what starts workspace\.service is its own arrangement — which no line here undoes\)\n/, 'triggers and upholders go with it, the enabled ones disabled, the static one stopped and said; its own default.target link is no puller');
  // A unit of the user's own that requires herdr.service (`desk.service`, Requires=): stopping herdr.service stops it too (systemd propagates an explicit stop to what requires it), so it is named among what the hand-over ends, and as a puller no line undoes.
  const required = supervised(okRun('enabled\n'), { [PULLED]: okRun('WantedBy=\nRequiredBy=desk.service\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=\nPropagatesStopTo=\n') });
  required.touchHerdr();
  assert.equal(await runSetup(required.deps, OPTS), 0, required.out.join('\n'));
  assert.match(required.out.join('\n'), /— hand over to this one now:  systemctl --user disable --now herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs, and desk\.service, which the manager stops with it \(and whatever depends on those\); herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(desk\.service requires it\) and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service \(herdr\.service: desk\.service requires it — which no line here undoes\)\n/, 'what requires it is named among what ends');
  // A trigger's own dependents and pullers: `desk.service` is PartOf= the timer (stopped with it), and a target of the user's wants the timer (a disable of the timer does not undo that) — both said.
  const timerPart = supervised(okRun('enabled\n'), { [PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=herdr.timer\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=\nPropagatesStopTo=\n'), ...timerOn, [PULLED.replace('herdr.service', 'herdr.timer')]: okRun('WantedBy=my-desk.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\nConsistsOf=desk.service\nPropagatesStopTo=\n') });
  timerPart.touchHerdr();
  assert.equal(await runSetup(timerPart.deps, OPTS), 0, timerPart.out.join('\n'));
  assert.match(timerPart.out.join('\n'), /— hand over to this one now:  systemctl --user disable --now herdr\.timer herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.timer and herdr\.service run, and desk\.service, which the manager stops with them \(and whatever depends on those\); herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(herdr\.timer starts it\) and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.timer herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service \(herdr\.service: my-desk\.target wants herdr\.timer — which no line here undoes\)\n/, 'what the manager stops with the timer, and what wants the timer, are said');
  // Ours running another session while a unit of the user's is PartOf= it: the restart line names that unit among what it ends.
  const ownPart = supervised(okRun('enabled\n'), {}, 'work', { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), [`systemctl --user show -p RequiredBy,BoundBy,RequisiteOf,ConsistsOf,PropagatesStopTo,Conflicts,ConflictedBy ${HERDR_UNIT}`]: okRun('RequiredBy=\nBoundBy=\nRequisiteOf=\nConsistsOf=desk.service\nPropagatesStopTo=\nConflicts=\nConflictedBy=\n') });
  fs.writeFileSync(ownPart.unitPath, ownUnit(HERDR_BIN, 'old', ownPart.home));
  ownPart.touchHerdr();
  assert.equal(await runSetup(ownPart.deps, OPTS), 0, ownPart.out.join('\n'));
  assert.match(ownPart.out.join('\n'), /rewritten for session work — for session work now:  systemctl --user disable --now herdr\.service; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session old and every pane of session work \(it runs outside the unit now\) and whatever else herdr\.service runs, and desk\.service, which the manager stops with remotly-bridge-herdr\.service \(and whatever depends on those\); herdr restores the layouts\)\n/, 'a unit of the user\'s that is part of ours goes with its restart: said');
  // A trigger's trigger (`wake.timer` triggers `herdr.timer`): followed, stopped and disabled with the rest, named among what ends.
  const nested = supervised(okRun('enabled\n'), { [PULLED]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=herdr.timer\nOnFailureOf=\nOnSuccessOf=\nRequisiteOf=\nConsistsOf=\nPropagatesStopTo=\n'), ...timerOn, [PULLED.replace('herdr.service', 'herdr.timer')]: okRun('WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=wake.timer\nOnFailureOf=\nOnSuccessOf=\nRequisiteOf=\nConsistsOf=\nPropagatesStopTo=\n'), 'systemctl --user is-enabled wake.timer': okRun('enabled\n') });
  nested.touchHerdr();
  assert.equal(await runSetup(nested.deps, OPTS), 0, nested.out.join('\n'));
  assert.match(nested.out.join('\n'), /— hand over to this one now:  systemctl --user disable --now herdr\.timer wake\.timer herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.timer, wake\.timer and herdr\.service run; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(herdr\.timer starts it\) and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.timer wake\.timer herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service\n/, 'the trigger\'s trigger goes with them');
  // A unit of the user's with Conflicts= on ours: starting ours stops it — said on the start line; a restart names it too.
  const rival = supervised(okRun('enabled\n'), {}, 'work', { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), [`systemctl --user show -p RequiredBy,BoundBy,RequisiteOf,ConsistsOf,PropagatesStopTo,Conflicts,ConflictedBy ${HERDR_UNIT}`]: okRun('RequiredBy=\nBoundBy=\nRequisiteOf=\nConsistsOf=\nPropagatesStopTo=\nConflicts=\nConflictedBy=rival.service\n') });
  fs.writeFileSync(rival.unitPath, ownUnit(HERDR_BIN, 'work', rival.home));
  rival.touchHerdr();
  assert.equal(await runSetup(rival.deps, OPTS), 0, rival.out.join('\n'));
  assert.match(rival.out.join('\n'), /— hand over to this one now:  systemctl --user disable --now herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs, and rival\.service, which the manager stops with remotly-bridge-herdr\.service \(and whatever depends on those\); herdr restores the layout\)\n/, 'what a start of ours stops is said');
  // The same enabled unit also wanted by a drop-in of the user's (`default.target.d/herdr.conf`: no link of its own under default.target.wants): a `disable` does not undo that, so the keep-one line says so instead of claiming it.
  const wantedToo = supervised(okRun('enabled\n'), { [PULLED]: okRun('WantedBy=default.target my-desk.target\nRequiredBy=\nUpheldBy=\nBoundBy=\nTriggeredBy=\nOnFailureOf=\nOnSuccessOf=\n') });
  fs.mkdirSync(path.join(path.dirname(wantedToo.unitPath), 'default.target.wants'), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(wantedToo.unitPath), 'herdr.service'), path.join(path.dirname(wantedToo.unitPath), 'default.target.wants', 'herdr.service'));
  wantedToo.touchHerdr();
  assert.equal(await runSetup(wantedToo.deps, OPTS), 0, wantedToo.out.join('\n'));
  assert.match(wantedToo.out.join('\n'), /installed: herdr is running outside it now \(under herdr\.service, a unit setup did not write, enabled \(my-desk\.target wants it\)\) — hand over to this one now:  systemctl --user disable --now herdr\.service; systemctl --user start remotly-bridge-herdr\.service   \(ends every pane of session work and whatever else herdr\.service runs; herdr restores the layout\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write \(my-desk\.target wants it\) and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service \(herdr\.service: my-desk\.target wants it — which no line here undoes\)\n/, 'a target that wants it without a link of its own is a puller, said as not undone');
  // Ours running another session (the bridge was moved) while the wanted one's herdr runs under the enabled unit of the user's own: the restart line turns that unit off first, no take-over at boot is claimed, and the race is said.
  const movedOn = supervised(okRun('enabled\n'), {}, 'work', { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') });
  fs.writeFileSync(movedOn.unitPath, ownUnit(HERDR_BIN, 'old', movedOn.home));
  movedOn.touchHerdr();
  assert.equal(await runSetup(movedOn.deps, OPTS), 0, movedOn.out.join('\n'));
  assert.match(movedOn.out.join('\n'), /⚠ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) is running \(pid 777\) for session old, rewritten for session work — for session work now:  systemctl --user disable --now herdr\.service; systemctl --user restart remotly-bridge-herdr\.service   \(ends every pane of session old and every pane of session work \(it runs outside the unit now\) and whatever else herdr\.service runs; herdr restores the layouts\)\n  ⚠ herdr runs under herdr\.service, a unit setup did not write and enabled too: at boot it and remotly-bridge-herdr\.service race for the socket — keep one, from the next boot:  systemctl --user disable herdr\.service   or  systemctl --user disable remotly-bridge-herdr\.service\n/);
  assert.equal(movedOn.out.join('\n').includes('takes over at the next boot'), false, 'moved: no take-over claim beside an enabled unit of the user\'s own either');
  // The bridge's own unit named for the process (a Mac's lsof names a client of the socket too; the bridge is one): nobody's.
  const client = herdrDeps({ script: herdrDown(), socketPid: () => 4242, processUnit: () => 'remotly-bridge.service' }, 'work');
  client.touchHerdr();
  assert.equal(await runSetup(client.deps, OPTS), 0);
  assert.match(client.out.join('\n'), /installed: herdr is running outside it now \(from a terminal\)/);
  // Under a terminal (a scope: no unit), or under this very unit: nothing of the kind.
  const scoped = herdrDeps({ script: herdrDown(), socketPid: () => 4242, processUnit: () => null }, 'work');
  scoped.touchHerdr();
  assert.equal(await runSetup(scoped.deps, OPTS), 0);
  assert.match(scoped.out.join('\n'), /installed: herdr is running outside it now \(from a terminal\)/);

  // On a Mac the provider's plist may stand unbootstrapped — a setup over a herdr started by hand enables it and leaves it so until the next login, which loads it — and launchd names no path for it: the session's provider all the same. Bootstrapped from its file it is one too; a label launchd has from another plist is not this file's doing.
  const macLabel = 'dev.remotly.alpha-herdr';
  const macCase = async (print: ExecResult, agents: string) => {
    const mm = macDeps({ script: { [`launchctl print gui/1000/${macLabel}`]: print, 'launchctl print-disabled gui/1000': okRun('disabled services = {\n}\n') } }, agents);
    fs.mkdirSync(mm.deps.unitDir, { recursive: true });
    fs.writeFileSync(path.join(mm.deps.unitDir, `${macLabel}.plist`), renderLaunchHerdrAgent({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', home: mm.home, configHome: path.join(mm.home, '.config') }));
    const sm = launchdManager({ exec: mm.deps.exec, unitDir: mm.deps.unitDir, user: 'alice', uid: 1000, home: mm.home, updateMinute: 17, sleep: async () => undefined });
    return otherHerdrUnits(sm, 'remotly-bridge', 'work', path.join(mm.home, '.config'), () => true);
  };
  const notBootstrapped: ExecResult = { code: 113, stdout: '', stderr: `Could not find service "${macLabel}" in domain for user gui: 1000` };
  assert.deepEqual(await macCase(notBootstrapped, 'LaunchAgents-share-1'), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'provider', activators: [], pullers: [], stoppedWith: [] }], 'enabled, not bootstrapped: the next login loads it');
  // Another plist in ~/Library/LaunchAgents declaring the same label (a twin): launchd loads it at login whatever is done to this file's agent — a possible starter, said with the twin's path, not a runner stopped once and taken over from.
  const twinDir = path.join(dir, 'LaunchAgents-twin');
  fs.mkdirSync(twinDir, { recursive: true });
  fs.writeFileSync(path.join(twinDir, 'com.example.alpha-twin.plist'), renderPlist({ Label: macLabel, ProgramArguments: ['/usr/local/bin/herdr', 'server'], RunAtLoad: true }));
  const twins = await macCase(okRun(`gui/1000/${macLabel} = {\n\tstate = running\n\tpath = ${path.join(dir, 'LaunchAgents-twin', `${macLabel}.plist`)}\n\tpid = 99\n}\n`), 'LaunchAgents-twin');
  assert.deepEqual(twins, [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'possible', activators: [], pullers: [{ unit: path.join(twinDir, 'com.example.alpha-twin.plist'), how: 'declares the label too (a plist launchd loads at login)' }], stoppedWith: [] }]);
  assert.deepEqual(await macCase(okRun(`gui/1000/${macLabel} = {\n\tstate = running\n\tpath = ${path.join(dir, 'LaunchAgents-share-2', `${macLabel}.plist`)}\n\tpid = 99\n}\n`), 'LaunchAgents-share-2'), [{ unit: 'alpha-herdr', bridge: 'alpha', role: 'provider', activators: [], pullers: [], stoppedWith: [] }], 'bootstrapped from its file');
  assert.deepEqual(await macCase(okRun(`gui/1000/${macLabel} = {\n\tstate = running\n\tpath = /Users/alice/elsewhere/${macLabel}.plist\n\tpid = 99\n}\n`), 'LaunchAgents-share-3'), [], 'the label bootstrapped from another plist');
  assert.deepEqual(await macCase(okRun(`gui/1000/${macLabel} = {\n\tstate = running\n\tpid = 99\n}\n`), 'LaunchAgents-share-4'), [], 'bootstrapped, from a path launchd does not say');

  // Both there already (each written before the other bridge followed this session): ours is maintained, the race is said with the line that keeps one.
  const both = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), ...alphaWord() } }, 'work');
  vouch(both);
  both.touchHerdr();
  fs.writeFileSync(path.join(path.dirname(both.unitPath), 'alpha-herdr.service'), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(both.home, '.config') }));
  assert.equal(await runSetup(both.deps, OPTS), 0);
  assert.match(both.out.join('\n'), /⚠ two herdr services for session work: remotly-bridge-herdr\.service and alpha-herdr\.service \(bridge unit alpha's\) — at boot they race for the socket; keep one, from the next boot:  systemctl --user disable alpha-herdr\.service   \(what runs now keeps running\)/);
  assert.deepEqual(both.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);
});

test('herdr service: a first install killed between the write and the enable (systemd) is finished by the next setup, not read as the user\'s choice', async () => {
  const m = herdrDeps({ script: { ...herdrDown(), [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' } } }, 'work');
  m.touchHerdr();
  fs.writeFileSync(`${m.unitPath}.pending`, '');
  assert.equal(await runSetup(m.deps, OPTS), 0, m.out.join('\n'));
  assert.match(m.out.join('\n'), /· herdr service remotly-bridge-herdr\.service was written by a setup that did not get to enable it: enabled now\n\s+· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work\) installed: herdr is running outside it now/);
  assert.deepEqual(m.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);
  assert.equal(fs.existsSync(`${m.unitPath}.pending`), false, 'settled');
  // Interrupted, and another bridge's unit took the session meanwhile: ours stays disabled (two would race), the pending file goes, the hand-over line is printed.
  const ALPHA2 = 'alpha-herdr.service';
  const beside = herdrDeps({ script: { ...herdrDown(), [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`systemctl --user is-enabled ${ALPHA2}`]: okRun('enabled\n'), [`${SHOW} ${ALPHA2}`]: unitShow('loaded', 'inactive', 'dead', 0) } }, 'work');
  const base = beside.deps.exec;
  beside.deps.exec = async (cmd, args, o) => (`${cmd} ${args.join(' ')}` === `systemctl --user show -p FragmentPath,DropInPaths ${ALPHA2}` ? okRun(`FragmentPath=${path.join(path.dirname(beside.unitPath), ALPHA2)}\nDropInPaths=\n`) : base(cmd, args, o));
  beside.touchHerdr();
  fs.writeFileSync(`${beside.unitPath}.pending`, '');
  fs.writeFileSync(path.join(path.dirname(beside.unitPath), ALPHA2), renderSystemdHerdrUnit({ unit: 'alpha', herdrPath: HERDR_BIN, session: 'work', configHome: path.join(beside.home, '.config') }));
  assert.equal(await runSetup(beside.deps, OPTS), 0, beside.out.join('\n'));
  assert.match(beside.out.join('\n'), /· herdr service: alpha-herdr\.service \(bridge unit alpha's\) starts session work at boot already; remotly-bridge-herdr\.service is disabled and races it for nothing\n\s+· herdr service off \(remotly-bridge-herdr\.service is disabled\); on, as the session's one/);
  assert.deepEqual(beside.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'not enabled');
  assert.equal(fs.existsSync(`${beside.unitPath}.pending`), false, 'settled: disabled beside the provider');
  // Without the pending file, disabled is the user's choice, as before.
  const chosen = herdrDeps({ script: { ...herdrDown(), [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: { code: 1, stdout: 'disabled\n', stderr: '' } } }, 'work');
  chosen.touchHerdr();
  assert.equal(await runSetup(chosen.deps, OPTS), 0);
  assert.match(chosen.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); on:  /);
  assert.deepEqual(chosen.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);
  // A fresh install leaves no pending file behind, enabled or (--no-herdr-service) disabled.
  const fresh = herdrDeps({ script: herdrDown() }, 'work');
  fresh.touchHerdr();
  assert.equal(await runSetup(fresh.deps, OPTS), 0);
  assert.equal(fs.existsSync(`${fresh.unitPath}.pending`), false);
  const off = herdrDeps({ script: herdrDown() }, 'work');
  off.touchHerdr();
  assert.equal(await runSetup(off.deps, { ...OPTS, herdrService: false }), 0);
  assert.equal(fs.existsSync(`${off.unitPath}.pending`), false);
});

test('herdr service: every stop line printed unsets what a pane\'s shell carries (HERDR_SOCKET_PATH, HERDR_SESSION) and pins the directory (XDG_CONFIG_HOME), as the unit does', async () => {
  assert.equal(herdrStopCommand(undefined, '/home/alice/.config', '/usr/local/bin/herdr'), 'env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=/home/alice/.config /usr/local/bin/herdr server stop');
  assert.equal(herdrStopCommand('work', '/home/alice/.config', '/home/alice/.local/bin/herdr'), 'env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=/home/alice/.config /home/alice/.local/bin/herdr --session work server stop', 'the herdr the unit runs, by its path: it may be off this shell\'s PATH');
  assert.equal(herdrStopCommand('work 2', '/Users/al ice/.config', '/Volumes/Fast Disk/bin/herdr'), "env -u HERDR_SESSION -u HERDR_SOCKET_PATH 'XDG_CONFIG_HOME=/Users/al ice/.config' '/Volumes/Fast Disk/bin/herdr' --session 'work 2' server stop");
  const m = herdrDeps({ script: herdrDown() });
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  assert.match(m.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) installed: herdr is running outside it now \(from a terminal\), so it takes over at the next boot — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr server stop; systemctl --user start remotly-bridge-herdr\.service/);
});

test('herdr service: a session name with a space is quoted in the unit and in the commands printed (shellWord)', async () => {
  assert.equal(shellWord('work'), 'work');
  assert.equal(shellWord('dev.2024-01_a:b'), 'dev.2024-01_a:b');
  assert.equal(shellWord('work 2'), "'work 2'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
  assert.equal(shellWord('a;b'), "'a;b'");
  const m = herdrDeps({ script: herdrDown() }, 'work 2');
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  assert.match(m.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr, session work 2\) installed: .* — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr --session 'work 2' server stop; systemctl --user start remotly-bridge-herdr\.service/);
  assert.match(fs.readFileSync(m.unitPath, 'utf8'), /^ExecStart="\/usr\/bin\/env" -u HERDR_SESSION -u HERDR_SOCKET_PATH "XDG_CONFIG_HOME=[^"]+\/\.config" "\/usr\/local\/bin\/herdr" --session "work 2" server$/m);
});

test('herdr service: a unit already running herdr is reported with its pid; one running without herdr answering is a warning with the restart line, never restarted by setup', async () => {
  const running = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  running.touchHerdr();
  assert.equal(await runSetup(running.deps, OPTS), 0);
  assert.match(running.out.join('\n'), /✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) running \(pid 777\)\n\s+✔ herdr 0\.8\.0/);
  assert.deepEqual(running.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);

  const mute = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), 'herdr --version': okRun('herdr 0.8.0') } });
  assert.equal(await runSetup(mute.deps, { ...OPTS, wait: false }), 1);
  const text = mute.out.join('\n');
  assert.match(text, new RegExp(`⚠ herdr service remotly-bridge-herdr\\.service \\(/usr/local/bin/herdr\\) is running, but herdr does not answer at ${mute.sock}; a restart ends every pane's processes:  systemctl --user restart remotly-bridge-herdr\\.service`));
  assert.match(text, /✖ herdr is not running \(no socket at /);
  assert.equal(mute.calls.some((c) => /^systemctl --user (start|restart|reset-failed) remotly-bridge-herdr/.test(c)), false);
});

test('herdr service: a unit the user disabled stays off with the line that turns it on; a masked one is not even written; an unreadable is-enabled leaves it alone', async () => {
  const off = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('disabled\n') } });
  off.touchHerdr();
  assert.equal(await runSetup(off.deps, OPTS), 0);
  assert.match(off.out.join('\n'), /· herdr service off \(remotly-bridge-herdr\.service is disabled\); on:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of the default session; herdr restores the layout\)/, 'herdr runs outside the unit (from a terminal): turning the unit on stops that one first, else the unit starts against it');
  assert.ok(fs.existsSync(off.unitPath), 'rewritten for the current herdr, as the update units are');
  assert.deepEqual(off.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'neither enabled nor started');

  const masked = herdrDeps({ script: { [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('masked\n') } });
  masked.touchHerdr();
  assert.equal(await runSetup(masked.deps, OPTS), 0);
  assert.match(masked.out.join('\n'), /· herdr service off: remotly-bridge-herdr\.service is masked \(systemctl --user unmask remotly-bridge-herdr\.service, then setup again, turns it on\)/);
  assert.equal(fs.existsSync(masked.unitPath), false);
  assert.deepEqual(masked.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);
  // The mask (a link to /dev/null in ~/.config/systemd/user) over a unit file under the name in another load path: that file is a unit setup did not write, which the unmask line would expose — so no such line, and nothing touched.
  const hiding = herdrDeps({ script: { [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('masked\n') } });
  hiding.touchHerdr();
  fs.mkdirSync(path.dirname(hiding.unitPath), { recursive: true });
  fs.symlinkSync('/dev/null', hiding.unitPath);
  const lower = path.join(hiding.home, '.local', 'share', 'systemd', 'user', HERDR_UNIT);
  fs.mkdirSync(path.dirname(lower), { recursive: true });
  fs.writeFileSync(lower, '[Service]\nExecStart=/usr/bin/herdr server\n[Install]\nWantedBy=default.target\n');
  assert.equal(await runSetup(hiding.deps, OPTS), 0);
  assert.match(hiding.out.join('\n'), new RegExp(`· herdr service off: remotly-bridge-herdr\\.service is masked, and the mask hides a unit setup did not write \\(${lower.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\); both are left alone\n`));
  assert.equal(hiding.out.join('\n').includes('unmask'), false, 'no unmask line');
  assert.equal(fs.readlinkSync(hiding.unitPath), '/dev/null', 'the mask stands');
  assert.deepEqual(hiding.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);
  // The manager's own list of load paths is the one looked through when it answers — a path with a space in it comes quoted, as `show` prints lists.
  const spacedDir = path.join(dir, 'my units');
  const quoted = herdrDeps({ script: { [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('masked\n'), 'systemctl --user show -p UnitPath': okRun(`UnitPath=/run/user/1000/systemd/transient "${spacedDir}" /usr/lib/systemd/user\n`) } });
  quoted.touchHerdr();
  fs.mkdirSync(path.dirname(quoted.unitPath), { recursive: true });
  fs.symlinkSync('/dev/null', quoted.unitPath);
  fs.mkdirSync(spacedDir, { recursive: true });
  fs.writeFileSync(path.join(spacedDir, HERDR_UNIT), '[Service]\nExecStart=/usr/bin/herdr server\n');
  assert.equal(await runSetup(quoted.deps, OPTS), 0);
  assert.match(quoted.out.join('\n'), new RegExp(`is masked, and the mask hides a unit setup did not write \\(${path.join(spacedDir, HERDR_UNIT).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\); both are left alone\n`));

  const blind = herdrDeps({ script: { [`systemctl --user is-enabled ${HERDR_UNIT}`]: failRun('Failed to connect to bus: No medium found') } });
  blind.touchHerdr();
  assert.equal(await runSetup(blind.deps, OPTS), 0);
  assert.match(blind.out.join('\n'), /⚠ cannot tell whether remotly-bridge-herdr\.service is enabled \(systemctl --user is-enabled remotly-bridge-herdr\.service: exit 1, Failed to connect to bus: No medium found\); the herdr service is left as it is/);
  assert.equal(fs.existsSync(blind.unitPath), false);
  assert.deepEqual(blind.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);
});

test('herdr service: a unit setup did not write (linked, static, alias…) is left as it is, file and all — also under --no-herdr-service', async () => {
  const linked = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('linked\n') } });
  fs.rmSync(linked.unitPath); // a symlink to the user's own file, in place of a file of setup's
  const elsewhere = path.join(linked.home, 'my-herdr.service');
  fs.writeFileSync(elsewhere, '# the user\'s own unit\n');
  fs.symlinkSync(elsewhere, linked.unitPath);
  linked.touchHerdr();
  assert.equal(await runSetup(linked.deps, OPTS), 0);
  assert.match(linked.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is linked, not a unit setup wrote\n\s+✔ herdr 0\.8\.0/);
  assert.ok(fs.lstatSync(linked.unitPath).isSymbolicLink(), 'the symlink was not replaced');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '# the user\'s own unit\n');
  assert.deepEqual(linked.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`]);

  const isStatic = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('static\n') } });
  fs.rmSync(isStatic.unitPath); // a static unit lives in another directory
  isStatic.touchHerdr();
  assert.equal(await runSetup(isStatic.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(isStatic.out.join('\n'), /· herdr service left as it is: remotly-bridge-herdr\.service is static, not a unit setup wrote/);
  assert.equal(fs.existsSync(isStatic.unitPath), false, 'nothing written over a unit that lives elsewhere');
  assert.deepEqual(isStatic.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`], 'not disabled either');
});

test('herdr service: --no-herdr-service writes the unit disabled (the choice later setups respect), and says so when it is running', async () => {
  const m = herdrDeps({ script: herdrDown() });
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(m.out.join('\n'), /· herdr service off \(--no-herdr-service\): remotly-bridge-herdr\.service written but disabled; on:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\S+\/\.config \S*herdr server stop; systemctl --user enable --now remotly-bridge-herdr\.service   \(ends every pane of the default session; herdr restores the layout\)\n\s+✔ herdr 0\.8\.0/);
  assert.equal(fs.existsSync(`${m.unitPath}.pending`), false, 'an opt-out writes no .pending: cut short, a fresh file nobody enabled reads as the opt-out, not as an install to finish');
  assert.ok(fs.existsSync(m.unitPath));
  assert.deepEqual(m.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user disable ${HERDR_UNIT}`]);

  const running = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'active', 'running', 777), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  running.touchHerdr();
  assert.equal(await runSetup(running.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(running.out.join('\n'), /· herdr service off \(--no-herdr-service\): remotly-bridge-herdr\.service written but disabled; it keeps running until:  systemctl --user stop remotly-bridge-herdr\.service; on:  systemctl --user enable --now remotly-bridge-herdr\.service/);
  assert.deepEqual(running.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user disable ${HERDR_UNIT}`]);

  // The opt-out that could not be recorded says so: an enabled unit stays enabled (and is said to), a fresh one is taken back.
  const stuck = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), [`systemctl --user disable ${HERDR_UNIT}`]: failRun('Failed to disable unit: Access denied') } });
  stuck.touchHerdr();
  assert.equal(await runSetup(stuck.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(stuck.out.join('\n'), /⚠ --no-herdr-service: remotly-bridge-herdr\.service could not be written disabled \(systemctl --user disable remotly-bridge-herdr\.service failed \(1\): Failed to disable unit: Access denied\); it stays enabled\n\s+✔ herdr 0\.8\.0/);
  assert.ok(fs.existsSync(stuck.unitPath));
  const freshStuck = herdrDeps({ script: { ...herdrDown(), [`systemctl --user disable ${HERDR_UNIT}`]: failRun('Failed to disable unit: Access denied') } });
  freshStuck.touchHerdr();
  assert.equal(await runSetup(freshStuck.deps, { ...OPTS, herdrService: false }), 0);
  assert.match(freshStuck.out.join('\n'), /⚠ --no-herdr-service: remotly-bridge-herdr\.service could not be written disabled \(.*Access denied\); nothing was installed/);
  assert.equal(fs.existsSync(freshStuck.unitPath), false, 'a unit nobody disabled would start at the next boot: taken back');
  assert.equal(freshStuck.calls.filter((c) => c === 'systemctl --user daemon-reload').length, 3, 'reloaded after taking it back');
});

test('herdr service: --keep-stopped (what `update` passes) leaves a stopped unit stopped with the start line, starts a fresh one, and restarts a failed one after reset-failed', async () => {
  const stopped = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), 'herdr --version': okRun('herdr 0.8.0') } });
  assert.equal(await runSetup(stopped.deps, { ...OPTS, keepStopped: true, wait: false }), 1, 'herdr stays down: the herdr check stops setup');
  assert.match(stopped.out.join('\n'), /· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) installed, but it is inactive: left stopped \(--keep-stopped\);  systemctl --user start remotly-bridge-herdr\.service\n\s+✖ herdr is not running/);
  assert.deepEqual(stopped.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);

  const fresh = herdrDeps({ script: herdrDown() });
  fresh.startsHerdr();
  assert.equal(await runSetup(fresh.deps, { ...OPTS, keepStopped: true }), 0);
  assert.match(fresh.out.join('\n'), /✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) started/, 'nobody stopped a unit that did not exist');
  assert.ok(fresh.calls.includes(`systemctl --user start ${HERDR_UNIT}`));

  const failed = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'failed', 'failed', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n') } });
  failed.startsHerdr();
  assert.equal(await runSetup(failed.deps, { ...OPTS, keepStopped: true }), 0);
  assert.match(failed.out.join('\n'), /✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) started/);
  assert.deepEqual(failed.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`, `systemctl --user reset-failed ${HERDR_UNIT}`, `systemctl --user restart ${HERDR_UNIT}`]);
});

test('herdr service: a start that does not bring herdr up within the wait is a warning with the journal line, and the herdr check takes it from there', async () => {
  const m = herdrDeps({ script: { ...herdrDown(), 'herdr --version': okRun('herdr 0.8.0') } });
  const t0 = m.deps.now();
  assert.equal(await runSetup(m.deps, { ...OPTS, wait: false }), 1);
  const text = m.out.join('\n');
  assert.match(text, new RegExp(`⚠ herdr service remotly-bridge-herdr\\.service \\(/usr/local/bin/herdr\\) started, but herdr does not answer yet at ${m.sock}:  journalctl --user -u remotly-bridge-herdr\\.service -n 30\\n\\s+✖ herdr is not running`));
  assert.ok(m.deps.now() - t0 >= 15_000, 'waited for herdr');
  assert.ok(m.deps.now() - t0 < 20_000);
});

test('herdr service: without a `herdr` to run, nothing is written — a running herdr is noted; one installed while setup waits gets its service at once', async () => {
  const byHand = herdrDeps({ herdrBinary: () => null });
  byHand.touchHerdr();
  assert.equal(await runSetup(byHand.deps, OPTS), 0);
  assert.match(byHand.out.join('\n'), /· no herdr service: herdr is running, but there is no `herdr` on PATH \(or under ~\/\.local\/bin\) to start it from at boot\n\s+✔ herdr 0\.8\.0/);
  assert.equal(fs.existsSync(byHand.unitPath), false);
  assert.deepEqual(byHand.herdrCalls(), []);

  // herdr is neither running nor installed: the herdr check says so (the install line), and setup waits. Installed on
  // the second poll, it is set up as a service and started, and the wait ends.
  let asked = 0;
  const later = herdrDeps({ script: { ...herdrDown(), 'herdr --version': failRun('not found', 127) }, herdrBinary: () => (++asked >= 3 ? HERDR_BIN : null) });
  later.startsHerdr();
  assert.equal(await runSetup(later.deps, OPTS), 0);
  const text = later.out.join('\n');
  assert.equal(text.match(/✖ herdr is not running/g)?.length, 1);
  assert.match(text, new RegExp(`install it:  ${HERDR_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /waiting — setup continues by itself[\s\S]*✔ herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) started\n\s+✔ herdr 0\.8\.0/);
  assert.ok(fs.existsSync(later.unitPath));
  assert.ok(asked >= 3);

  // Installed and started by the user between two polls (the printed instructions say to): the socket is there, and the
  // service is still installed — enabled for the next boot, not started over the herdr the user just started.
  let ready = false;
  const both = herdrDeps({ script: { ...herdrDown(), 'herdr --version': failRun('not found', 127) }, herdrBinary: () => (ready ? HERDR_BIN : null) });
  const bothSleep = both.deps.sleep;
  both.deps.sleep = async (ms) => {
    await bothSleep(ms);
    ready = true;
    both.touchHerdr();
  };
  assert.equal(await runSetup(both.deps, OPTS), 0);
  assert.match(both.out.join('\n'), /✖ herdr is not running[\s\S]*· herdr service remotly-bridge-herdr\.service \(\/usr\/local\/bin\/herdr\) installed: herdr is running outside it now[\s\S]*✔ herdr 0\.8\.0/);
  assert.ok(fs.existsSync(both.unitPath));
  assert.deepEqual(both.herdrCalls(), [`systemctl --user is-enabled ${HERDR_UNIT}`, `systemctl --user enable ${HERDR_UNIT}`]);
});

test('herdr service: when it cannot be installed, setup goes on with the herdr at hand — a unit this setup created is taken back, one that existed is left', async () => {
  const m = herdrDeps({ script: { ...herdrDown(), [`systemctl --user enable ${HERDR_UNIT}`]: failRun('Failed to enable unit: Access denied') } });
  m.touchHerdr();
  assert.equal(await runSetup(m.deps, OPTS), 0);
  const text = m.out.join('\n');
  assert.match(text, /⚠ could not install the herdr service remotly-bridge-herdr\.service: systemctl --user enable remotly-bridge-herdr\.service failed \(1\): Failed to enable unit: Access denied — start herdr yourself after a reboot \(run `herdr`\)\n\s+✔ herdr 0\.8\.0/);
  assert.match(text, /setup complete$/);
  assert.equal(fs.existsSync(m.unitPath), false, 'no half-installed unit: the next setup tries again instead of reading it as the user\'s');
  assert.equal(m.calls.filter((c) => c === 'systemctl --user daemon-reload').length, 3, 'reloaded after taking it back');

  const existing = herdrDeps({ script: { [`${SHOW} ${HERDR_UNIT}`]: unitShow('loaded', 'inactive', 'dead', 0), [`systemctl --user is-enabled ${HERDR_UNIT}`]: okRun('enabled\n'), [`systemctl --user enable ${HERDR_UNIT}`]: failRun('Failed to enable unit: Access denied') } });
  existing.touchHerdr();
  assert.equal(await runSetup(existing.deps, OPTS), 0);
  assert.match(existing.out.join('\n'), /⚠ could not install the herdr service/);
  assert.ok(fs.existsSync(existing.unitPath), 'the user\'s unit, rewritten, stays');

  // A start that fails is the same warning; the unit stays (enabled: it was accepted) for the next boot.
  const noStart = herdrDeps({ script: { ...herdrDown(), [`systemctl --user start ${HERDR_UNIT}`]: failRun('Job for remotly-bridge-herdr.service failed.'), 'herdr --version': okRun('herdr 0.8.0') } });
  assert.equal(await runSetup(noStart.deps, { ...OPTS, wait: false }), 1);
  assert.match(noStart.out.join('\n'), /⚠ could not install the herdr service remotly-bridge-herdr\.service: systemctl --user start remotly-bridge-herdr\.service failed \(1\): Job for remotly-bridge-herdr\.service failed\. — start herdr yourself after a reboot/);
  assert.ok(fs.existsSync(noStart.unitPath));
});

test('herdr service: a socket that is not a herdr session under ~/.config/herdr gets no service, with a line that says why', async () => {
  const { deps, out, touchSocket, sock } = makeDeps({ script: { ...tsScript(), ...lingerYes }, home: path.join(dir, 'home'), herdrBinary: () => HERDR_BIN });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 0);
  assert.match(out.join('\n'), new RegExp(`· no herdr service: the bridge follows ${sock}, which is not a herdr session under ${path.join(dir, 'home', '.config', 'herdr')} — start that herdr yourself after a reboot\\n\\s+✔ herdr 0\\.8\\.0`));
  assert.equal(fs.existsSync(path.join(deps.unitDir, HERDR_UNIT)), false);
});

test('macOS: the herdr service is a launch agent — plist written and enabled; herdr down: bootstrapped and waited for; herdr by hand: left for the next login; no systemctl anywhere', async () => {
  const label = 'dev.remotly.remotly-bridge-herdr';
  const herdrNotLoaded: ExecResult = { code: 113, stdout: '', stderr: `Could not find service "${label}" in domain for user gui: 1000` };
  let answered = 0;
  const m = macDeps({
    script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING], [`launchctl print gui/1000/${label}`]: herdrNotLoaded },
    status: async () => {
      if (answered++ < 2) throw new Error('ENOENT');
      return STATUS;
    },
    herdrSocket: path.join(dir, '.config', 'herdr', 'herdr.sock'),
    herdrBinary: () => '/opt/homebrew/bin/herdr',
  });
  m.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(m.deps.herdrSocket), { recursive: true });
  const plist = path.join(m.deps.unitDir, `${label}.plist`);
  // herdr comes up when its agent is bootstrapped (the manager macDeps built holds the exec, so it is built again over the hook).
  const base = m.deps.exec;
  m.deps.exec = async (cmd, args, o) => {
    if (`${cmd} ${args.join(' ')}` === `launchctl bootstrap gui/1000 ${plist}`) fs.writeFileSync(m.deps.herdrSocket, '');
    return base(cmd, args, o);
  };
  m.deps.service = launchdManager({ exec: m.deps.exec, unitDir: m.deps.unitDir, user: 'alice', uid: 1000, home: m.home, updateMinute: 17, sleep: async () => undefined });
  assert.equal(await runSetup(m.deps, OPTS), 0, m.out.join('\n'));
  const text = m.out.join('\n');
  assert.match(text, /✔ herdr service dev\.remotly\.remotly-bridge-herdr \(\/opt\/homebrew\/bin\/herdr\) started\n\s+✔ herdr 0\.8\.0/);
  assert.equal(text.includes('✖'), false);
  assert.equal(text.includes('⚠'), false);
  assert.equal(text.includes('systemd'), false);
  assert.equal(m.calls.some((c) => c.startsWith('systemctl')), false);
  const agent = fs.readFileSync(plist, 'utf8');
  assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
  assert.match(agent, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/usr\/bin\/env<\/string>\n\s*<string>-u<\/string>\n\s*<string>HERDR_SESSION<\/string>\n\s*<string>-u<\/string>\n\s*<string>HERDR_SOCKET_PATH<\/string>\n\s*<string>XDG_CONFIG_HOME=[^<]+\/\.config<\/string>\n\s*<string>\/opt\/homebrew\/bin\/herdr<\/string>\n\s*<string>server<\/string>\n\s*<\/array>/);
  assert.match(agent, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.deepEqual(
    m.launchctl().filter((c) => c.includes('-herdr')),
    [`launchctl print gui/1000/${label}`, `launchctl enable gui/1000/${label}`, `launchctl print gui/1000/${label}`, `launchctl bootstrap gui/1000 ${plist}`],
    'state (not loaded, the plist is there: inactive) before the write; enabled; start: not loaded, so bootstrapped — no bootout, no kickstart -k',
  );

  // herdr started from a terminal: the agent is installed for the next login, not bootstrapped over it.
  let answered2 = 0;
  const byHand = macDeps(
    {
      script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING], [`launchctl print gui/1000/${label}`]: herdrNotLoaded },
      status: async () => {
        if (answered2++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'sessions', 'work', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-2',
  );
  byHand.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(byHand.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(byHand.deps.herdrSocket, '');
  assert.equal(await runSetup(byHand.deps, OPTS), 0, byHand.out.join('\n'));
  const plist2 = path.join(byHand.deps.unitDir, `${label}.plist`);
  assert.match(byHand.out.join('\n'), new RegExp(`· herdr service dev\\.remotly\\.remotly-bridge-herdr \\(/opt/homebrew/bin/herdr, session work\\) installed: herdr is running outside it now \\(from a terminal\\), so it takes over at the next login — or now:  env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\\S+/\\.config \\S*herdr --session work server stop; launchctl bootstrap gui/1000 ${plist2}`));
  assert.deepEqual(byHand.launchctl().filter((c) => c.includes('-herdr')), [`launchctl print gui/1000/${label}`, `launchctl enable gui/1000/${label}`]);
  assert.match(fs.readFileSync(plist2, 'utf8'), /<string>--session<\/string>\n\s*<string>work<\/string>\n\s*<string>server<\/string>/);

  // --no-herdr-service whose `launchctl disable` fails: a plist launchd was not told to skip would start at login, so a fresh one is taken back.
  let answered3 = 0;
  const optOut = macDeps(
    {
      script: { ...tsScript(), 'launchctl print gui/1000/dev.remotly.remotly-bridge': [MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_NOT_LOADED, MAC_PRINT_RUNNING], [`launchctl print gui/1000/${label}`]: herdrNotLoaded, [`launchctl disable gui/1000/${label}`]: failRun('Could not disable service: 5: Input/output error', 5) },
      status: async () => {
        if (answered3++ < 2) throw new Error('ENOENT');
        return STATUS;
      },
      herdrSocket: path.join(dir, '.config', 'herdr', 'sessions', 'three', 'herdr.sock'),
      herdrBinary: () => '/opt/homebrew/bin/herdr',
    },
    'LaunchAgents-3',
  );
  optOut.deps.env = { REMOTLY_TAILSCALE: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
  fs.mkdirSync(path.dirname(optOut.deps.herdrSocket), { recursive: true });
  fs.writeFileSync(optOut.deps.herdrSocket, '');
  assert.equal(await runSetup(optOut.deps, { ...OPTS, herdrService: false }), 0, optOut.out.join('\n'));
  assert.match(optOut.out.join('\n'), /⚠ --no-herdr-service: dev\.remotly\.remotly-bridge-herdr could not be written disabled \(launchctl disable gui\/1000\/dev\.remotly\.remotly-bridge-herdr failed \(5\): Could not disable service: 5: Input\/output error\); nothing was installed/);
  assert.equal(fs.existsSync(path.join(optOut.deps.unitDir, `${label}.plist`)), false);
  assert.deepEqual(optOut.launchctl().filter((c) => c.includes('-herdr')), [`launchctl print gui/1000/${label}`, `launchctl disable gui/1000/${label}`], 'state before the write, then the disable; nothing else');
});

test('herdr service: the herdr that answers, by its socket and its cgroup — the listener\'s inode in /proc/net/unix, the user service in the cgroup path (desktop apps\' transient units and scopes are a terminal\'s)', async () => {
  const table = 'Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 79832 /home/a/.config/herdr/herdr.sock\n0000000000000000: 00000003 00000000 00000000 0001 03 66280 /home/a/.config/herdr/herdr.sock\n0000000000000000: 00000002 00000000 00010000 0001 01 1234 /run/user/1000/bus\n';
  assert.deepEqual([...listenerInodes(table, '/home/a/.config/herdr/herdr.sock')], ['79832'], 'the listener, not a connection on the same path');
  assert.deepEqual([...listenerInodes(table, '/nowhere')], []);
  const spaced = 'Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 555 /home/a b/.config/herdr/herdr.sock \n';
  assert.deepEqual([...listenerInodes(spaced, '/home/a b/.config/herdr/herdr.sock')], ['555'], 'a path with a space: the columns before it are fixed, the rest is the path');
  const lsof = 'p100\nf3\nn/Users/a/.config/herdr/herdr.sock\np200\nf5\nn->0x1234\nf6\nn/Users/a/.config/herdr/herdr.sock\np300\nf7\nn/Users/a/other.sock\n';
  assert.deepEqual(pidsFromLsof(lsof, '/Users/a/.config/herdr/herdr.sock'), [100, 200], 'every process lsof names on the path, once each');
  assert.deepEqual(pidsFromLsof(lsof, '/nowhere'), []);
  const list = 'PID\tStatus\tLabel\n-\t0\tcom.apple.Finder\n4242\t0\tcom.example.herdr\n77\t0\tdev.remotly.remotly-bridge\n88\t0\tapplication.com.apple.Terminal.1.2\n';
  assert.equal(labelFromLaunchctlList(list, 4242), 'com.example.herdr');
  assert.equal(labelFromLaunchctlList(list, 4243), null, 'not a job\'s main process');
  // macOS: lsof names the pids on the path; several (a client of herdr's shows it too), and the herdr server is the one running `herdr … server`.
  const macExec = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(' ')}`;
    if (line === 'lsof -U -F pn') return okRun(lsof);
    if (line === 'launchctl list') return okRun(list);
    if (line === 'ps -o comm= -p 100') return okRun('/usr/local/bin/node\n');
    if (line === 'ps -o comm= -p 200') return okRun('/Users/a b/bin/herdr\n');
    if (line === 'ps -o args= -p 100') return okRun('node /app/bridge/src/main.ts serve\n');
    if (line === 'ps -o args= -p 200') return okRun('/Users/a b/bin/herdr --session work server\n');
    if (line === 'ps -o ppid= -p 4243') return okRun(' 4242\n'); // herdr, child of a job's wrapper shell
    if (line === 'ps -o ppid= -p 4244') return okRun('88\n'); // a shell under Terminal.app
    if (line === 'ps -o ppid= -p 4245') return okRun('1\n'); // launchd's own child, no job of the user's
    return { code: 1, stdout: '', stderr: 'no' };
  };
  assert.equal(await pidListeningOn('/Users/a/.config/herdr/herdr.sock', 'darwin', macExec), 200, 'the herdr among the processes on the path, by its executable\'s name (a path with a space: `args=` would lose it)');
  const twoHerdrs = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(' ')}`;
    if (line === 'ps -o comm= -p 100' || line === 'ps -o comm= -p 200') return okRun('/opt/homebrew/bin/herdr\n');
    if (line === 'ps -o args= -p 100') return okRun('/opt/homebrew/bin/herdr --session work attach\n');
    if (line === 'ps -o args= -p 200') return okRun('/opt/homebrew/bin/herdr --session work server\n');
    return macExec(cmd, args);
  };
  assert.equal(await pidListeningOn('/Users/a/.config/herdr/herdr.sock', 'darwin', twoHerdrs), 200, 'two herdrs on the path (a client of herdr\'s own): the server by its arguments');
  const spacedPair = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(' ')}`;
    if (line === 'ps -o comm= -p 100' || line === 'ps -o comm= -p 200') return okRun('/Users/a b/bin/herdr\n');
    if (line === 'ps -o args= -p 100') return okRun('/Users/a b/bin/herdr --session work attach\n');
    if (line === 'ps -o args= -p 200') return okRun('/Users/a b/bin/herdr --session work server\n');
    return macExec(cmd, args);
  };
  assert.equal(await pidListeningOn('/Users/a/.config/herdr/herdr.sock', 'darwin', spacedPair), 200, 'neither parses (the path splits): the server by its last word');
  const untold = async (cmd: string, args: string[]) => (args.join(' ') === '-o args= -p 200' ? okRun('/Users/a b/bin/herdr --session work attach\n') : spacedPair(cmd, args));
  assert.equal(await pidListeningOn('/Users/a/.config/herdr/herdr.sock', 'darwin', untold), null, 'two herdrs, neither a server by its words: not told, rather than the first');
  assert.equal(await pidListeningOn('/Users/a/other.sock', 'darwin', macExec), 300, 'one process on the path: it');
  assert.equal(await pidListeningOn('/nowhere', 'darwin', macExec), null);
  assert.equal(await readProcessUnit(4242, 'darwin', macExec), 'com.example.herdr');
  assert.equal(await readProcessUnit(4243, 'darwin', macExec), 'com.example.herdr', 'a job whose main process is a wrapper: found up the ancestry');
  assert.equal(await readProcessUnit(4244, 'darwin', macExec), null, 'under Terminal.app (an application.… label): a terminal\'s');
  assert.equal(await readProcessUnit(4245, 'darwin', macExec), null);
  const mute = async () => ({ code: 1, stdout: '', stderr: 'lsof: not found' });
  assert.equal(await pidListeningOn('/Users/a/other.sock', 'darwin', mute), null, 'lsof failing: not told');
  assert.equal(await readProcessUnit(4242, 'darwin', mute), null);
  assert.equal(unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr.service\n'), 'herdr.service');
  assert.equal(unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-22446.scope\n'), null, 'a terminal: a scope');
  assert.equal(unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.kde.konsole@abc.service\n'), 'app-org.kde.konsole@abc.service', 'a desktop app under KDE: a transient service — whether it supervises herdr is the manager\'s word (Restart=), asked next');
  assert.equal(unitOfCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u123.service\n'), 'run-u123.service', 'systemd-run: a transient unit with whatever Restart= it was given — stopped as one');
  assert.equal(unitOfCgroup('0::/system.slice/herdr.service\n'), null, 'not under the user manager');
  assert.equal(unitOfCgroup('0::/user.slice/user-1000.slice/session-2.scope\n'), null);
  assert.equal(unitOfCgroup(''), null);
  assert.equal(await readProcessUnit(process.pid, 'freebsd', mute), null);
  assert.equal(await pidListeningOn('/nowhere/herdr.sock', 'freebsd', mute), null);
  if (process.platform === 'linux') {
    const sockPath = path.join(dir, 'listen.sock');
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(sockPath, r));
    try {
      assert.equal(await pidListeningOn(sockPath, 'linux', mute), process.pid, 'the listener is this process');
    } finally {
      srv.close();
    }
    assert.equal(await pidListeningOn(path.join(dir, 'none.sock'), 'linux', mute), null);
    // Two listeners under one path (the first's socket keeps its address after the path is unlinked and bound anew): which answers is not told.
    const twice = path.join(dir, 'twice.sock');
    const older = net.createServer();
    await new Promise<void>((r) => older.listen(twice, r));
    fs.unlinkSync(twice);
    const newer = net.createServer();
    await new Promise<void>((r) => newer.listen(twice, r));
    try {
      assert.equal(listenerInodes(fs.readFileSync('/proc/net/unix', 'utf8'), twice).size, 2, 'both listed');
      assert.equal(await pidListeningOn(twice, 'linux', mute), null, 'not told, rather than either');
    } finally {
      older.close();
      newer.close();
    }
  }
});

test('herdr service: one setup per session at a time — a kernel lock (flock) held by a child: the second setup waits for the first to let go, or gives up with the error', async () => {
  const lock = path.join(dir, 'lock-test.lock');
  const first = await lockSession(lock, { waitMs: 200 });
  assert.notEqual(first, null, 'flock is there');
  assert.equal(first!.held(), true);
  let second: SessionLock | null = null;
  const waiting = lockSession(lock, { waitMs: 5000 }).then((u) => {
    second = u;
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(second, null, 'held: the second waits');
  await assert.rejects(lockSession(lock, { waitMs: 100 }), /another setup holds .*lock-test\.lock \(a setup is running for this session; wait for it\)/, 'a third, out of patience');
  first!.release();
  await waiting;
  assert.notEqual(second, null, 'let go: the second has it');
  assert.equal((second as unknown as SessionLock).held(), true);
  for (let i = 0; i < 40 && first!.held(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(first!.held(), false, 'the first\'s child is gone');
  (second as unknown as SessionLock).release();
  // perl's flock, the macOS way, on the same file: the same lock (flock(2) under both).
  const viaPerl = await lockSession(lock, { platform: 'darwin', waitMs: 200 });
  assert.notEqual(viaPerl, null, 'perl is there');
  await assert.rejects(lockSession(lock, { waitMs: 100 }), /another setup holds/, 'held through perl, seen through flock(1)');
  viaPerl!.release();
  assert.match(sessionLockPath('/home/a', '/home/a/.config', 'work'), /^\/home\/a\/\.local\/state\/remotly\/locks\/herdr-[0-9a-f]{16}\.lock$/, 'under the home, whatever TMPDIR a setup runs with');
  assert.notEqual(sessionLockPath('/home/a', '/home/a/.config', 'work'), sessionLockPath('/home/a', '/home/a/.config', undefined), 'per session');
  assert.notEqual(sessionLockPath('/home/a', '/home/a/.config', 'work'), sessionLockPath('/home/a', '/srv/elsewhere/.config', 'work'), 'per directory');
  const lockOf = (m: ReturnType<typeof herdrDeps>, session: string) => sessionLockPath(m.home, path.join(m.home, '.config'), session);
  const locked = herdrDeps({ script: herdrDown() }, 'work');
  locked.touchHerdr();
  assert.equal(await runSetup(locked.deps, OPTS), 0);
  assert.ok(fs.existsSync(lockOf(locked, 'work')), 'the lock file, under the home');
  const lockHeld = await lockSession(lockOf(locked, 'work'), { waitMs: 200 });
  locked.out.length = 0;
  assert.equal(await runSetup(locked.deps, { ...OPTS, wait: false }), 0, 'a setup that cannot get the lock: the herdr service step fails, nothing else');
  assert.match(locked.out.join('\n'), /⚠ could not install the herdr service remotly-bridge-herdr\.service: another setup holds \S+herdr-[0-9a-f]{16}\.lock \(a setup is running for this session; wait for it\) — start herdr yourself after a reboot/);
  lockHeld!.release();
});
