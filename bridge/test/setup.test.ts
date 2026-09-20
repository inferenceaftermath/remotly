import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ControlStatus, PairInfo } from '../src/control.ts';
import {
  HERDR_INSTALL,
  LAN_CONFIG,
  TAILSCALE_DNS_ADMIN,
  TAILSCALE_INSTALL,
  classifyCertFailure,
  classifyTailnet,
  disableLanMode,
  enableLanMode,
  nodeMajor,
  parseSetupArgs,
  reconcileHerdrEnv,
  renderUnit,
  installerEnv,
  renderRepairScript,
  renderUpdateUnits,
  repairScriptPath,
  timerMarkerPath,
  runSetup,
  stableNodePath,
  systemdUserDir,
  unitFile,
  updateUnitNames,
  type SetupConfigView,
  type SetupDeps,
  type SetupOptions,
} from '../src/setup.ts';
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
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'script')),
  };
  return { deps, out, calls, sock, touchSocket: () => fs.writeFileSync(sock, '') };
}

const OPTS: SetupOptions = { unit: 'remotly-bridge', lan: false, wait: true, pair: true, ttlSec: 600 };
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
  const full = renderUnit({ nodePath: '/usr/bin/node', mainPath: '/x/main.ts', configDir: '/home/a/.config/remotly-2', herdrSession: 'main', herdrSocket: '/run/100%/herdr.sock' });
  assert.match(full, /^Environment="REMOTLY_CONFIG_DIR=\/home\/a\/.config\/remotly-2"$/m);
  assert.match(full, /^Environment="HERDR_SESSION=main"$/m);
  assert.match(full, /^Environment="HERDR_SOCKET_PATH=\/run\/100%%\/herdr.sock"$/m, 'a literal % is %% in a unit file');
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
  assert.equal(calls.some((c) => (c.startsWith('systemctl') && !c.includes('MainPID')) || c.startsWith('tailscale')), false);
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
  assert.equal(noOpenssl.calls.some((c) => c.startsWith('systemctl') && !c.includes('MainPID')), false, 'stops before touching the unit');
});

test('a Tailscale certificate failure that falls back to self-signed also checks openssl', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), 'tailscale cert': failRun('acme: rate limited'), 'openssl version': missing(), ...lingerYes } });
  touchSocket();
  assert.equal(await runSetup(deps, OPTS), 1);
  assert.match(out.join('\n'), /continuing without it[\s\S]*✖ openssl not found/);
  assert.equal(calls.some((c) => c.startsWith('systemctl') && !c.includes('MainPID')), false);
});

test('unit options land in the unit file and env; linger is enabled when off', async () => {
  const { deps, out, calls, touchSocket } = makeDeps({ script: { ...tsScript(), 'loginctl show-user': [okRun('no\n'), okRun('yes\n')] } });
  touchSocket();
  const code = await runSetup(deps, { ...OPTS, unit: 'remotly-dev', configDir: '/home/alice/.config/remotly-dev', herdrSession: 'dev', pair: false });
  assert.equal(code, 0);
  const unit = fs.readFileSync(path.join(deps.unitDir, 'remotly-dev.service'), 'utf8');
  assert.match(unit, /^Environment="REMOTLY_CONFIG_DIR=\/home\/alice\/.config\/remotly-dev"$/m);
  assert.match(unit, /^Environment="HERDR_SESSION=dev"$/m);
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
  fs.writeFileSync(path.join(disabled.deps.unitDir, UPDATE_TIMER), '# old timer\n');
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
  fs.writeFileSync(path.join(maskedService.deps.unitDir, UPDATE_TIMER), '# old timer\n');
  maskedService.touchSocket();
  assert.equal(await runSetup(maskedService.deps, OPTS), 0);
  assert.match(maskedService.out.join('\n'), /· auto-update off: remotly-bridge-update\.service is masked \(systemctl --user unmask remotly-bridge-update\.service, then setup again, turns it on\)/);
  assert.equal(fs.readFileSync(path.join(maskedService.deps.unitDir, UPDATE_TIMER), 'utf8'), '# old timer\n', 'not rewritten');

  // Enabled until the next boot only (`enable --runtime`): made permanent like a fresh one.
  const runtime = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: okRun('enabled-runtime\n') } });
  runtime.deps.unitDir = path.join(dir, 'systemd-runtime');
  asRelease(runtime.deps);
  fs.mkdirSync(runtime.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.deps.unitDir, UPDATE_TIMER), '# old timer\n');
  runtime.touchSocket();
  assert.equal(await runSetup(runtime.deps, OPTS), 0);
  assert.ok(runtime.calls.includes(`systemctl --user enable ${UPDATE_TIMER}`));
  assert.match(runtime.out.join('\n'), /✔ daily update remotly-bridge-update\.timer/);

  // Started by hand but never enabled: stays the user's business, with a word on what that means.
  const started = makeDeps({ script: { ...tsScript(), ...lingerYes, [`systemctl --user is-enabled ${UPDATE_TIMER}`]: { code: 1, stdout: 'disabled\n', stderr: '' }, [`systemctl --user is-active ${UPDATE_TIMER}`]: okRun('active\n') } });
  started.deps.unitDir = path.join(dir, 'systemd-started');
  asRelease(started.deps);
  fs.mkdirSync(started.deps.unitDir, { recursive: true });
  fs.writeFileSync(path.join(started.deps.unitDir, UPDATE_TIMER), '# old timer\n');
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
  fs.writeFileSync(path.join(interrupted.deps.unitDir, UPDATE_TIMER), '# written, never enabled\n');
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
  fs.writeFileSync(path.join(partial.deps.unitDir, 'remotly-bridge-update.service'), '# half written\n');
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
  fs.writeFileSync(path.join(existing.deps.unitDir, UPDATE_TIMER), '# old timer\n');
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
  fs.writeFileSync(path.join(enabledMarker.deps.unitDir, UPDATE_TIMER), '# enabled timer\n');
  const emHome = path.dirname(path.dirname(path.dirname(enabledMarker.deps.mainPath)));
  fs.writeFileSync(timerMarkerPath(emHome, 'remotly-bridge'), '');
  enabledMarker.touchSocket();
  assert.equal(await runSetup(enabledMarker.deps, OPTS), 0);
  assert.match(enabledMarker.out.join('\n'), /⚠ could not install the update timer/);
  assert.ok(fs.existsSync(path.join(enabledMarker.deps.unitDir, UPDATE_TIMER)), 'an enabled timer is never taken back');
  assert.ok(fs.existsSync(path.join(enabledMarker.deps.unitDir, 'remotly-bridge-update.service')));
  assert.ok(fs.existsSync(timerMarkerPath(emHome, 'remotly-bridge')), 'the marker stays for the next setup, which enables again');
});
