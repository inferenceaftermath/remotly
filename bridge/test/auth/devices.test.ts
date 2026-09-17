import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { activityToken, createTailnetGate, DeviceStore, hashToken, tailnetGate } from '../../src/auth/devices.ts';
import { createLogger } from '../../src/log.ts';
import { defaultConfig, type FlowConfig } from '../../src/config.ts';
import type { ExecFn, ExecResult } from '../../src/tailscale.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dev-'));
  file = path.join(dir, 'devices.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('issueToken returns a 32-byte base64url token and stores only its sha256', () => {
  const store = new DeviceStore(file).load();
  const { token, device } = store.issueToken({ name: 'Pixel', platform: 'android' });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(device.token_sha256, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(device.token_sha256, hashToken(token));
  assert.equal(device.last_seen, null);
  assert.ok(!Number.isNaN(Date.parse(device.created_at)));
  assert.equal(fs.readFileSync(file, 'utf8').includes(token), false, 'plaintext token must never hit disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['devices.json'], 'atomic write leaves no temp files');
});

test('authenticate: timing-safe hash compare, null for unknown/empty/revoked', () => {
  const store = new DeviceStore(file).load();
  const a = store.issueToken({ name: 'iPhone', platform: 'ios' });
  const b = store.issueToken({ name: 'Pixel', platform: 'android' });
  assert.equal(store.authenticate(a.token)?.id, a.device.id);
  assert.equal(store.authenticate(b.token)?.id, b.device.id);
  assert.equal(store.authenticate(a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(store.authenticate(''), null);
  assert.equal(store.authenticate(a.device.token_sha256), null, 'the stored hash is not a valid token');
  assert.equal(store.revoke(a.device.id), true);
  assert.equal(store.revoke(a.device.id), false);
  assert.equal(store.authenticate(a.token), null);
  assert.equal(store.list().length, 1);
});

test('persists across loads; list/get return copies', () => {
  const store = new DeviceStore(file).load();
  const { device } = store.issueToken({ name: 'iPhone', platform: 'ios' });
  store.list()[0]!.name = 'mutated';
  assert.equal(store.get(device.id)?.name, 'iPhone');
  const again = new DeviceStore(file).load();
  assert.deepEqual(again.list(), store.list());
  assert.equal(new DeviceStore(path.join(dir, 'missing.json')).load().list().length, 0);
});

test('setPush stores and clears the push registration', () => {
  const store = new DeviceStore(file).load();
  const { device } = store.issueToken({ name: 'iPhone', platform: 'ios' });
  assert.equal(store.setPush(device.id, { platform: 'ios', token: 'apns-hex', env: 'sandbox' }), true);
  assert.deepEqual(new DeviceStore(file).load().get(device.id)?.push, { platform: 'ios', token: 'apns-hex', env: 'sandbox' });
  assert.equal(store.setPush(device.id, null), true);
  assert.equal('push' in (new DeviceStore(file).load().get(device.id) ?? {}), false);
  assert.equal(store.setPush('nope', null), false);
});

test('notify_done arming and Live Activity tokens persist per device', () => {
  const store = new DeviceStore(file).load();
  const a = store.issueToken({ name: 'iPhone', platform: 'ios' }).device;
  const b = store.issueToken({ name: 'Pixel', platform: 'android' }).device;
  assert.equal(store.setNotifyDone(a.id, 'w1:p1', true), true);
  assert.equal(store.setNotifyDone(a.id, 'w1:p1', true), false, 'already armed');
  assert.equal(store.setNotifyDone(b.id, 'w1:p2', true), true);
  assert.equal(store.setNotifyDone('nope', 'w1:p1', true), false);
  assert.deepEqual(store.notifyDone(a.id), ['w1:p1']);
  assert.deepEqual(store.armedFor('w1:p1').map((d) => d.id), [a.id]);
  assert.deepEqual(new DeviceStore(file).load().notifyDone(b.id), ['w1:p2']);
  assert.equal(store.setNotifyDone(a.id, 'w1:p1', false), true);
  assert.equal(store.get(a.id)?.notify_done, undefined, 'empty list is dropped');

  assert.equal(store.updatePush(a.id, { activity: true }), null, 'no registration yet');
  assert.equal(store.setActivityToken(a.id, 'w1:p1', 'tok'), false);
  store.setPush(a.id, { platform: 'ios', token: 't', env: 'sandbox' });
  assert.deepEqual(store.updatePush(a.id, { activity: true, la_start: 's' }), { platform: 'ios', token: 't', env: 'sandbox', activity: true, la_start: 's' });
  assert.equal(store.setActivityToken(a.id, 'w1:p1', 'u1'), true);
  store.setActivityToken(a.id, 'w1:p2', 'u2');
  store.setActivityToken(a.id, 'w1:p1', null);
  assert.deepEqual(new DeviceStore(file).load().get(a.id)?.push?.la_panes, { 'w1:p2': 'u2' });
  store.setActivityToken(a.id, 'w1:p2', null);
  assert.equal(store.get(a.id)?.push?.la_panes, undefined);
  assert.deepEqual(store.updatePush(a.id, { la_start: undefined, activity: false }), { platform: 'ios', token: 't', env: 'sandbox', activity: false });
});

test('Live Activity tokens for panes named like Object.prototype members are stored as keys, read back, and cleared', () => {
  const store = new DeviceStore(file).load();
  const a = store.issueToken({ name: 'iPhone', platform: 'ios' }).device;
  store.setPush(a.id, { platform: 'ios', token: 't', env: 'sandbox' });
  for (const pane of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    assert.equal(activityToken(store.get(a.id)?.push, pane), undefined, `${pane}: nothing before it is set`);
    assert.equal(store.setActivityToken(a.id, pane, `tok-${pane}`), true);
    assert.equal(activityToken(store.get(a.id)?.push, pane), `tok-${pane}`, `${pane}: read back in memory`);
    const reloaded = new DeviceStore(file).load().get(a.id)?.push;
    assert.equal(activityToken(reloaded, pane), `tok-${pane}`, `${pane}: read back after a reload`);
    assert.deepEqual(Object.keys(reloaded?.la_panes ?? {}), [pane], `${pane}: the only key`);
    assert.equal(Object.getPrototypeOf(store.get(a.id)?.push?.la_panes), Object.prototype, `${pane}: prototype untouched`);
    assert.deepEqual(store.get(a.id)?.push?.la_panes, JSON.parse(JSON.stringify({ [pane]: `tok-${pane}` })), `${pane}: a plain map`);
    assert.equal(store.setActivityToken(a.id, pane, null), true);
    assert.equal(store.get(a.id)?.push?.la_panes, undefined, `${pane}: cleared`);
    assert.equal(activityToken(new DeviceStore(file).load().get(a.id)?.push, pane), undefined, `${pane}: cleared on disk`);
  }
  assert.equal(activityToken({ la_panes: { 'w1:p1': 'x' } }, 'constructor'), undefined, 'inherited members never count');
  assert.equal(activityToken(undefined, 'w1:p1'), undefined);
});

test('touch updates last_seen in memory and writes debounced; flush writes now', async () => {
  const t0 = new Date('2026-09-03T10:00:00.000Z');
  let now = t0;
  const store = new DeviceStore(file, { now: () => now, touchDebounceMs: 30 }).load();
  const { device } = store.issueToken({ name: 'iPhone', platform: 'ios' });
  now = new Date(t0.getTime() + 1000);
  store.touch(device.id);
  store.touch(device.id);
  assert.equal(store.get(device.id)?.last_seen, now.toISOString());
  assert.equal(new DeviceStore(file).load().get(device.id)?.last_seen, null, 'not yet written');
  await sleep(80);
  assert.equal(new DeviceStore(file).load().get(device.id)?.last_seen, now.toISOString());

  now = new Date(t0.getTime() + 5000);
  store.touch(device.id);
  store.flush();
  assert.equal(new DeviceStore(file).load().get(device.id)?.last_seen, now.toISOString());
  store.touch('unknown-id'); // no-op
});

test('corrupt devices.json throws instead of wiping devices', () => {
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => new DeviceStore(file).load(), /devices\.json: not valid JSON/);
  fs.writeFileSync(file, '{}');
  assert.throws(() => new DeviceStore(file).load(), /expected a JSON array/);
});

// ------------------------------------------------------------------ tailnet gate

const SELF_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'host.tailnet-example.ts.net.', UserID: 123456789012345 },
  User: { '123456789012345': { ID: 123456789012345, LoginName: 'owner@example.com' } },
  CurrentTailnet: { MagicDNSEnabled: true },
});
const whoisFor = (id: number, login: string) => JSON.stringify({ Node: { Name: 'phone.tailnet-example.ts.net.', User: id }, UserProfile: { ID: id, LoginName: login } });
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const missing: ExecResult = { code: null, stdout: '', stderr: 'spawn tailscale ENOENT' };

/** exec mock: records calls, answers from a table keyed by the joined argv. */
function mockExec(table: Record<string, ExecResult>, fallback: ExecResult = { code: 1, stdout: '', stderr: 'peer not found' }) {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    return table[key] ?? fallback;
  };
  return { exec, calls };
}

function cfg(requireTailnet: 'auto' | boolean): FlowConfig {
  const c = defaultConfig();
  c.security.require_tailnet = requireTailnet;
  return c;
}

test('gate allows peers owned by the same tailnet user and denies everyone else', async () => {
  const { exec, calls } = mockExec({
    'tailscale status --json': ok(SELF_STATUS),
    'tailscale whois --json 100.101.102.104': ok(whoisFor(123456789012345, 'owner@example.com')),
    'tailscale whois --json 100.99.1.1': ok(whoisFor(1, 'stranger@example.com')),
  });
  const gate = createTailnetGate(cfg('auto'), { exec });
  assert.equal(await gate.enabled(), true);
  assert.deepEqual(await gate.check('100.101.102.104'), { allowed: true, reason: 'same_user' });
  assert.deepEqual(await gate.check('::ffff:100.101.102.104'), { allowed: true, reason: 'same_user' });
  assert.deepEqual(await gate.check('100.99.1.1'), { allowed: false, reason: 'other_user' });
  assert.deepEqual(await gate.check('127.0.0.1'), { allowed: false, reason: 'not_on_tailnet' });
  assert.deepEqual(await gate.check('192.168.0.50'), { allowed: false, reason: 'not_on_tailnet' });
  assert.equal(await gate.allow('100.101.102.104'), true);
  // decisions are cached per peer: one whois per address
  assert.equal(calls.filter((c) => c.includes('whois --json 100.101.102.104')).length, 1);
  assert.equal(calls.filter((c) => c.startsWith('tailscale status')).length, 1);
});

test('gate compares login names when the numeric id is missing', async () => {
  const status = JSON.stringify({ Self: { UserID: 5 }, User: { '5': { ID: 5, LoginName: 'me@example.com' } } });
  const { exec } = mockExec({
    'tailscale status --json': ok(status),
    'tailscale whois --json 100.1.1.1': ok(JSON.stringify({ UserProfile: { LoginName: 'me@example.com' } })),
  });
  assert.equal((await tailnetGate('100.1.1.1', cfg(true), { exec })).allowed, true);
});

test('require_tailnet auto → off when tailscale is absent; explicit true fails closed', async () => {
  const absent = mockExec({}, missing);
  const gateAuto = createTailnetGate(cfg('auto'), { exec: absent.exec });
  assert.equal(await gateAuto.enabled(), false);
  assert.deepEqual(await gateAuto.check('192.168.0.50'), { allowed: true, reason: 'gate_off' });
  assert.equal(absent.calls.some((c) => c.includes('whois')), false);

  const strict = createTailnetGate(cfg(true), { exec: mockExec({}, missing).exec });
  assert.equal(await strict.enabled(), true);
  assert.deepEqual(await strict.check('100.101.102.104'), { allowed: false, reason: 'self_unknown' });
});

test('require_tailnet auto with Tailscale seen up at start-up stays on even if tailscale status fails when the first peer arrives: decisions fail closed', async () => {
  const gone = mockExec({}, { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' });
  const lines: string[] = [];
  const gate = createTailnetGate(cfg('auto'), { exec: gone.exec, tailscaleUp: true, log: createLogger({ level: 'info', write: (l) => lines.push(l) }) });
  assert.equal(await gate.enabled(), true, 'latched on: the start-up check is what counts');
  assert.deepEqual(await gate.check('192.168.0.50'), { allowed: false, reason: 'self_unknown' });
  assert.deepEqual(await gate.check('100.101.102.104'), { allowed: false, reason: 'self_unknown' });
  assert.equal(gone.calls.some((c) => c.includes('whois')), false, 'nobody is identified without Self');
  assert.match(lines.join('\n'), /"event":"tailnet_gate".*"require_tailnet":true.*"tailscale_up_at_start":true/);

  // without the latch the same failure reads as "absent" → gate off (the fallback for a host without Tailscale)
  const plain = createTailnetGate(cfg('auto'), { exec: mockExec({}, { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' }).exec });
  assert.equal(await plain.enabled(), false);

  // once Tailscale answers again, peers are judged normally
  const back = mockExec({ 'tailscale status --json': ok(SELF_STATUS), 'tailscale whois --json 100.101.102.104': ok(whoisFor(123456789012345, 'owner@example.com')) }, { code: 1, stdout: '', stderr: '' });
  const recovering = createTailnetGate(cfg('auto'), { exec: back.exec, tailscaleUp: true });
  assert.deepEqual(await recovering.check('100.101.102.104'), { allowed: true, reason: 'same_user' });
});

test('require_tailnet false never spawns anything', async () => {
  const { exec, calls } = mockExec({});
  const gate = createTailnetGate(cfg(false), { exec });
  assert.deepEqual(await gate.check('127.0.0.1'), { allowed: true, reason: 'gate_off' });
  assert.equal(calls.length, 0);
});

test('cached decisions expire', async () => {
  let t = 0;
  const { exec, calls } = mockExec({
    'tailscale status --json': ok(SELF_STATUS),
    'tailscale whois --json 100.101.102.104': ok(whoisFor(123456789012345, 'owner@example.com')),
  });
  const gate = createTailnetGate(cfg('auto'), { exec, now: () => t, cacheMs: 1000 });
  await gate.check('100.101.102.104');
  t = 999;
  await gate.check('100.101.102.104');
  assert.equal(calls.filter((c) => c.includes('whois')).length, 1);
  t = 1000;
  await gate.check('100.101.102.104');
  assert.equal(calls.filter((c) => c.includes('whois')).length, 2);
});
