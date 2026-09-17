import assert from 'node:assert/strict';
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
  runSetup,
  stableNodePath,
  systemdUserDir,
  unitFile,
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
const failRun = (stderr: string, code: number | null = 1): ExecResult => ({ code, stdout: '', stderr });
const missing = (): ExecResult => failRun('spawn x ENOENT', null);

/** Scripted exec: `script[key]` is a result or a queue of results consumed in order; anything else succeeds silently. */
function fakeExec(script: Record<string, ExecResult | ExecResult[]>) {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const hit = Object.keys(script).find((k) => key.startsWith(k));
    if (hit === undefined) return okRun();
    const v = script[hit];
    if (Array.isArray(v)) return v.length > 1 ? (v.shift() as ExecResult) : (v[0] as ExecResult);
    return v as ExecResult;
  };
  return { exec, calls };
}

function makeDeps(over: Partial<SetupDeps> & { script?: Record<string, ExecResult | ExecResult[]> } = {}) {
  const out: string[] = [];
  // Unless a test scripts it, the unit is the daemon that STATUS describes: systemd reports its main pid as 4242.
  const { exec: scripted, calls } = fakeExec({ [SHOW]: unitShow('loaded', 'active', 'running', 4242), ...(over.script ?? {}) });
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
  const o = parseSetupArgs(['--unit', 'u2', '--config-dir', '/c', '--herdr-session', 'main', '--herdr-socket', '/s', '--ttl', '120', '--lan', '--no-wait', '--no-pair', '--keep-mode'], {});
  assert.deepEqual(o, { unit: 'u2', configDir: '/c', herdrSession: 'main', herdrSocket: '/s', ttlSec: 120, lan: true, wait: false, pair: false, keepMode: true });
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

test('--keep-mode (the CI deploy, upgrade scripts): a LAN host stays LAN without Tailscale checks; a Tailscale host stays as it is', async () => {
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
