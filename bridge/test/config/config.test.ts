import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  ConfigError,
  configDir,
  configPath,
  defaultConfig,
  directApns,
  directFcm,
  ensureDirs,
  expandHome,
  loadConfig,
  secretsDir,
  statePath,
  tlsDir,
  validateConfig,
} from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';

let dir: string;
const savedEnv = process.env['REMOTLY_CONFIG_DIR'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cfg-'));
  process.env['REMOTLY_CONFIG_DIR'] = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env['REMOTLY_CONFIG_DIR'];
  else process.env['REMOTLY_CONFIG_DIR'] = savedEnv;
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('REMOTLY_CONFIG_DIR isolates every path; default is ~/.config/remotly', () => {
  assert.equal(configDir(), dir);
  assert.equal(statePath('devices.json'), path.join(dir, 'devices.json'));
  assert.equal(secretsDir(), path.join(dir, 'secrets'));
  assert.equal(tlsDir(), path.join(dir, 'tls'));
  delete process.env['REMOTLY_CONFIG_DIR'];
  assert.equal(configDir(), path.join(os.homedir(), '.config', 'remotly'));
  process.env['REMOTLY_CONFIG_DIR'] = '~/.config/flow-unit-test-nonexistent';
  assert.equal(configDir(), path.join(os.homedir(), '.config', 'flow-unit-test-nonexistent'));
  // defaults keep the spec's `~/…` spelling for the secrets paths (no files are created here)
  assert.equal(defaultConfig().push.apns.p8_path, '~/.config/flow-unit-test-nonexistent/secrets/AuthKey.p8');
});

test('ensureDirs creates config, secrets and tls dirs with mode 0700', () => {
  ensureDirs();
  for (const p of [dir, secretsDir(), tlsDir()]) {
    assert.ok(fs.statSync(p).isDirectory(), p);
    assert.equal(mode(p), 0o700, p);
  }
});

test('first run writes config.json with the §6.2 defaults (mode 0600) and returns them', () => {
  const lines: string[] = [];
  const cfg = loadConfig(createLogger({ level: 'debug', write: (l) => lines.push(l) }));
  assert.ok(fs.existsSync(configPath()));
  assert.equal(mode(configPath()), 0o600);
  const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepEqual(onDisk.listen, { host: 'auto', port: 7460 });
  assert.deepEqual(onDisk.tls, { mode: 'auto' });
  assert.deepEqual(onDisk.security, { require_tailnet: 'auto' });
  assert.deepEqual(onDisk.herdr, { socket: null, session: null });
  assert.equal(onDisk.push.include_excerpt, true);
  assert.equal(onDisk.push.debounce_ms, 2500);
  assert.deepEqual(onDisk.approvals, { strict_verify: true });
  assert.equal(cfg.listen.port, 7460);
  assert.equal(cfg.push.apns.p8_path, path.join(dir, 'secrets', 'AuthKey.p8'));
  assert.equal(cfg.push.fcm.service_account_path, path.join(dir, 'secrets', 'fcm-service-account.json'));
  assert.ok(lines.some((l) => l.includes('config.created')));
});

test('existing config is read and merged over defaults; ~ is expanded', () => {
  ensureDirs();
  fs.writeFileSync(
    configPath(),
    JSON.stringify({
      listen: { port: 7460 },
      security: { require_tailnet: false },
      herdr: { socket: '~/.config/herdr/sessions/dev/herdr.sock' },
      push: { apns: { team_id: 'T1', p8_path: '~/keys/AuthKey.p8' } },
    }),
  );
  const cfg = loadConfig();
  assert.equal(cfg.listen.host, 'auto');
  assert.equal(cfg.listen.port, 7460);
  assert.equal(cfg.security.require_tailnet, false);
  assert.equal(cfg.herdr.socket, path.join(os.homedir(), '.config/herdr/sessions/dev/herdr.sock'));
  assert.equal(cfg.herdr.session, null);
  assert.equal(cfg.push.apns.team_id, 'T1');
  assert.equal(cfg.push.apns.p8_path, path.join(os.homedir(), 'keys/AuthKey.p8'));
  assert.equal(cfg.push.debounce_ms, 2500);
  assert.equal(cfg.push.relay_url, 'https://relay.remotly.dev', 'relay on by default');
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/abs'), '/abs');
});

test('unknown keys warn but do not fail', () => {
  const warnings: string[] = [];
  const cfg = validateConfig({ listen: { port: 1234, hots: 'typo' }, extra: 1, push: { apns: { keyid: 'x' } } }, (m) => warnings.push(m));
  assert.equal(cfg.listen.port, 1234);
  assert.ok(warnings.some((w) => w.includes('listen.hots')));
  assert.ok(warnings.some((w) => w.includes('unknown key extra')));
  assert.ok(warnings.some((w) => w.includes('apns.keyid')));
});

test('validation errors name the key and the offending value', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ listen: { port: 'abc' } }, /listen\.port.*integer 1-65535.*"abc"/],
    [{ listen: { port: 70000 } }, /listen\.port/],
    [{ listen: { host: '' } }, /listen\.host/],
    [{ tls: { mode: 'plain' } }, /mode must be one of auto \| tailscale \| selfsigned/],
    [{ security: { require_tailnet: 'yes' } }, /security\.require_tailnet/],
    [{ herdr: { socket: 42 } }, /socket/],
    [{ herdr: { socket: 'run/herdr.sock' } }, /herdr\.socket must be an absolute path \(or ~\/…\) \(got "run\/herdr\.sock"\)/],
    [{ push: { debounce_ms: -1 } }, /debounce_ms/],
    [{ push: { include_excerpt: 'no' } }, /include_excerpt must be true or false/],
    [{ approvals: 'strict' }, /approvals must be an object/],
    [[], /top level must be a JSON object/],
  ];
  for (const [raw, re] of cases) {
    assert.throws(() => validateConfig(raw), (err: unknown) => err instanceof ConfigError && re.test(err.message), JSON.stringify(raw));
  }
});

test('invalid JSON on disk is a ConfigError pointing at the file', () => {
  ensureDirs();
  fs.writeFileSync(configPath(), '{ not json');
  assert.throws(() => loadConfig(), (err: unknown) => err instanceof ConfigError && /not valid JSON/.test(err.message) && err.message.includes(configPath()));
});

test('push.relay_url: default, normalised, disabled by "", https only (http for loopback), no ?/# at all', () => {
  assert.equal(defaultConfig().push.relay_url, 'https://relay.remotly.dev');
  assert.equal(validateConfig({}).push.relay_url, 'https://relay.remotly.dev');
  assert.equal(validateConfig({ push: { relay_url: 'https://relay.example.org/' } }).push.relay_url, 'https://relay.example.org');
  assert.equal(validateConfig({ push: { relay_url: 'https://relay.example.org/relay/' } }).push.relay_url, 'https://relay.example.org/relay');
  for (const dev of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'http://127.1.2.3:8787']) {
    assert.equal(validateConfig({ push: { relay_url: dev } }).push.relay_url, dev, dev);
  }
  assert.equal(validateConfig({ push: { relay_url: '' } }).push.relay_url, '');
  assert.equal(validateConfig({ push: { relay_url: '   ' } }).push.relay_url, '');
  const rejected = [
    'relay.example.org', 'ftp://relay.example.org', 'http://relay.example.org', 'http://192.168.0.10:8787', 'http://10.0.0.1',
    'https://relay.example.org/?x=1', 'https://relay.example.org/?', 'https://relay.example.org/#', 'https://relay.example.org/#frag',
    'https://u:p@relay.example.org', 'https://u@relay.example.org', 7,
  ];
  for (const bad of rejected) assert.throws(() => validateConfig({ push: { relay_url: bad } }), ConfigError, String(bad));
});

test('directApns / directFcm: ready needs every id and the file; intended = any id set', () => {
  const cfg = validateConfig({ push: { apns: { team_id: 'T', key_id: 'K', bundle_id: 'B', p8_path: path.join(dir, 'k.p8') }, fcm: { project_id: 'P', service_account_path: path.join(dir, 'sa.json') } } });
  assert.deepEqual(directApns(cfg), { intended: true, ready: false, missing: [path.join(dir, 'k.p8')] });
  assert.deepEqual(directFcm(cfg), { intended: true, ready: false, missing: [path.join(dir, 'sa.json')] });
  fs.writeFileSync(path.join(dir, 'k.p8'), 'x');
  fs.writeFileSync(path.join(dir, 'sa.json'), '{}');
  assert.deepEqual(directApns(cfg), { intended: true, ready: true, missing: [] });
  assert.deepEqual(directFcm(cfg), { intended: true, ready: true, missing: [] });
  const partial = validateConfig({ push: { apns: { team_id: 'T', p8_path: path.join(dir, 'k.p8') } } });
  assert.deepEqual(directApns(partial), { intended: true, ready: false, missing: ['push.apns.key_id', 'push.apns.bundle_id'] });
  const none = validateConfig({});
  assert.equal(directApns(none).intended, false);
  assert.equal(directFcm(none).intended, false);
  assert.equal(directApns(none).ready, false);
});
