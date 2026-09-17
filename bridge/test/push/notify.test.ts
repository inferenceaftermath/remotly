import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DeviceStore } from '../../src/auth/devices.ts';
import { defaultConfig } from '../../src/config.ts';
import type { AgentStatus } from '../../src/herdr/types.ts';
import { createLogger, type LogFields } from '../../src/log.ts';
import type { ApnsSendInput } from '../../src/push/apns.ts';
import type { FcmSendInput } from '../../src/push/fcm.ts';
import { Notifier, sessionTitle, type NotifierDeps, type PaneSummary } from '../../src/push/notify.ts';
import { buildApnsPayload, buildFcmData } from '../../src/push/payloads.ts';
import type { PushResult } from '../../src/push/types.ts';

let dir: string;
let devices: DeviceStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-push-test-'));
  devices = new DeviceStore(path.join(dir, 'devices.json')).load();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const DEBOUNCE = 2500;
const SETTLE = 3000;
const flush = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

function fakeTimers() {
  let t = 1_800_000_000_000;
  let id = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      pending.set(++id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    async advance(ms: number) {
      t += ms;
      for (const [h, p] of [...pending]) {
        if (p.at > t) continue;
        pending.delete(h);
        p.fn();
      }
      await flush();
    },
    pending: () => pending.size,
  };
}

function fakeClient<I>(result: PushResult | ((input: I) => PushResult) = { ok: true }) {
  const calls: I[] = [];
  return {
    calls,
    closed: false,
    async send(input: I): Promise<PushResult> {
      calls.push(input);
      return typeof result === 'function' ? result(input) : result;
    },
    close() {
      this.closed = true;
    },
  };
}

const blockedPane = (over: Partial<PaneSummary> = {}): PaneSummary => ({
  agent_status: 'blocked',
  agent: 'claude',
  display_agent: 'Claude',
  title: 'Remotly bridge',
  cwd: '/home/u/flow',
  prompt_id: 'w1:p1@4212',
  ...over,
});

function setup(over: Partial<NotifierDeps> & { includeExcerpt?: boolean } = {}) {
  const timers = fakeTimers();
  const lines: LogFields[] = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) });
  const config = defaultConfig();
  config.push.debounce_ms = DEBOUNCE;
  config.push.done_settle_ms = SETTLE;
  config.push.include_excerpt = over.includeExcerpt ?? true;
  const apns = fakeClient<ApnsSendInput>();
  const fcm = fakeClient<FcmSendInput>();
  const panes = new Map<string, PaneSummary>();
  const viewed = new Set<string>();
  const { includeExcerpt: _omit, ...rest } = over;
  const deps: NotifierDeps = {
    config,
    devices,
    log,
    hostName: 'devbox',
    apns,
    fcm,
    isViewed: (p) => viewed.has(p),
    paneState: (p) => panes.get(p),
    excerpt: async () => 'Allow Bash(npm test)?',
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...rest,
  };
  const n = new Notifier(deps);
  const ios = devices.issueToken({ name: 'iPhone', platform: 'ios' }).device;
  devices.setPush(ios.id, { platform: 'ios', token: 'apns-hex-token', env: 'sandbox' });
  const android = devices.issueToken({ name: 'Pixel', platform: 'android' }).device;
  devices.setPush(android.id, { platform: 'android', token: 'fcm-reg-token', env: 'production' });
  const set = (pane: string, status: AgentStatus, over: Partial<PaneSummary> = {}) => {
    panes.set(pane, blockedPane({ ...over, agent_status: status }));
    n.onStatusChange(pane, status);
  };
  return { n, timers, lines, apns, fcm, panes, viewed, ios, android, set, events: () => lines.map((l) => l['event']) };
}

test('fires once after the debounce with the right payloads, env and ttl', async () => {
  const { n, timers, apns, fcm, set, lines, events } = setup();
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE - 1);
  assert.equal(apns.calls.length + fcm.calls.length, 0);
  await timers.advance(1);
  const notice = {
    host: 'devbox',
    pane: 'w1:p1',
    promptId: 'w1:p1@4212',
    agent: 'claude',
    displayAgent: 'Claude',
    subtitle: 'Remotly bridge',
    body: 'Allow Bash(npm test)?',
  };
  assert.deepEqual(apns.calls, [{ token: 'apns-hex-token', env: 'sandbox', collapseId: 'w1:p1', payload: buildApnsPayload(notice) }]);
  assert.deepEqual(fcm.calls, [{ token: 'fcm-reg-token', collapseKey: 'w1:p1', ttlSec: 600, data: buildFcmData(notice) }]);
  assert.equal(events().filter((e) => e === 'push.sent').length, 2);
  const info = JSON.stringify(lines.filter((l) => l['level'] === 'info'));
  for (const secret of ['apns-hex-token', 'fcm-reg-token', 'Allow Bash', 'w1:p1']) assert.equal(info.includes(secret), false, secret);
  await timers.advance(DEBOUNCE * 2);
  assert.equal(apns.calls.length, 1, 'no repeat without a new blocked event');
  n.close();
  assert.equal(apns.closed && fcm.closed, true);
});

test('leaving blocked before the timer cancels it; re-blocking restarts the debounce', async () => {
  const { timers, apns, fcm, set } = setup();
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE - 1);
  set('w1:p1', 'working');
  assert.equal(timers.pending(), 0);
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length + fcm.calls.length, 0);

  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE - 500);
  set('w1:p1', 'blocked', { prompt_id: 'w1:p1@4300' });
  await timers.advance(600); // old deadline passed, new one has not
  assert.equal(apns.calls.length, 0);
  await timers.advance(DEBOUNCE - 600);
  assert.equal(apns.calls.length, 1);
  assert.equal((apns.calls[0]!.payload as { flow: { prompt_id: string } }).flow.prompt_id, 'w1:p1@4300');
});

test('suppressed when a device is viewing the pane or the pane is no longer blocked at fire time', async () => {
  const { timers, apns, fcm, set, viewed, panes, events } = setup();
  viewed.add('w1:p1');
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length + fcm.calls.length, 0);
  assert.ok(events().includes('push.suppressed'));

  set('w1:p2', 'blocked');
  panes.set('w1:p2', blockedPane({ agent_status: 'idle' })); // status changed without an event reaching us
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length + fcm.calls.length, 0);

  set('w1:p3', 'blocked');
  panes.delete('w1:p3');
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length + fcm.calls.length, 0);
});

test('body falls back to "Approval needed"; subtitle falls back to the cwd basename; agent to unknown', async () => {
  const a = setup({ excerpt: async () => null });
  a.set('w1:p1', 'blocked', { title: '', agent: null, display_agent: null });
  await a.timers.advance(DEBOUNCE);
  const aps = (a.apns.calls[0]!.payload as { aps: { alert: { title: string; subtitle: string; body: string } }; flow: { agent: string } });
  assert.equal(aps.aps.alert.body, 'Approval needed');
  assert.equal(aps.aps.alert.subtitle, 'flow');
  assert.equal(aps.aps.alert.title, 'unknown · Waiting for approval');
  assert.equal(aps.flow.agent, 'unknown');

  let reads = 0;
  const b = setup({ includeExcerpt: false, excerpt: async () => (reads++, 'secret screen') });
  b.set('w1:p1', 'blocked');
  await b.timers.advance(DEBOUNCE);
  assert.equal(reads, 0, 'excerpt not read when include_excerpt is off');
  assert.equal(b.fcm.calls[0]!.data['body'], 'Approval needed');

  const c = setup({ excerpt: async () => { throw new Error('herdr down'); } });
  c.set('w1:p1', 'blocked');
  await c.timers.advance(DEBOUNCE);
  assert.equal(c.fcm.calls[0]!.data['body'], 'Approval needed');
});

test('dropToken results clear the registration and log push.token_dropped', async () => {
  const apns = fakeClient<ApnsSendInput>({ ok: false, status: 410, reason: 'Unregistered', dropToken: true });
  const fcm = fakeClient<FcmSendInput>({ ok: false, status: 429, reason: 'QUOTA_EXCEEDED', dropToken: false });
  const { timers, set, ios, android, events } = setup({ apns, fcm });
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  assert.equal(devices.get(ios.id)?.push, undefined);
  assert.deepEqual(devices.get(android.id)?.push, { platform: 'android', token: 'fcm-reg-token', env: 'production' });
  assert.equal(events().filter((e) => e === 'push.failed').length, 2);
  assert.equal(events().filter((e) => e === 'push.token_dropped').length, 1);
  // persisted
  assert.equal(new DeviceStore(devices.file).load().get(ios.id)?.push, undefined);
  // the dropped device is skipped next time
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length, 1);
  assert.equal(fcm.calls.length, 2);
});

test('platform without a configured client is skipped and warned once; a throwing client is contained', async () => {
  const fcm = fakeClient<FcmSendInput>(() => {
    throw new Error('boom');
  });
  const { timers, set, lines, events } = setup({ apns: null, fcm });
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  const warns = lines.filter((l) => l['event'] === 'push.not_configured');
  assert.equal(warns.length, 1);
  assert.equal(warns[0]!['platform'], 'ios');
  assert.equal(events().filter((e) => e === 'push.failed').length, 2);
});

test('onStatusChange never throws even when a dependency does', async () => {
  const { n, timers } = setup({
    paneState: () => {
      throw new Error('hub gone');
    },
    setTimer: () => {
      throw new Error('no timers');
    },
  });
  assert.doesNotThrow(() => n.onStatusChange('w1:p1', 'blocked'));
  const ok = setup({
    paneState: () => {
      throw new Error('hub gone');
    },
  });
  ok.set('w1:p1', 'blocked');
  await ok.timers.advance(DEBOUNCE);
  assert.ok(ok.events().includes('push.failed'));
  await timers.advance(0);
});

test('pushTest: sends a synthetic notice or throws a precise error', async () => {
  const { n, apns, fcm, ios, android } = setup({ fcm: null });
  await assert.rejects(n.pushTest('nope'), /unknown_device/);
  const bare = devices.issueToken({ name: 'Old', platform: 'ios' }).device;
  await assert.rejects(n.pushTest(bare.id), /no_push_registration/);
  await assert.rejects(n.pushTest(android.id), /push_not_configured/);
  assert.deepEqual(await n.pushTest(ios.id), { ok: true });
  assert.equal(apns.calls.length, 1);
  assert.equal(fcm.calls.length, 0);
  const call = apns.calls[0]!;
  assert.equal(call.token, 'apns-hex-token');
  assert.equal(call.env, 'sandbox');
  const payload = call.payload as { aps: { alert: { title: string } }; flow: { pane: string; host: string } };
  assert.equal(payload.aps.alert.title, 'Remotly · Waiting for approval');
  assert.equal(payload.flow.host, 'devbox');
  assert.equal(payload.flow.pane, call.collapseId);

  const dropping = fakeClient<ApnsSendInput>({ ok: false, status: 400, reason: 'BadDeviceToken', dropToken: true });
  const t = setup({ apns: dropping });
  assert.deepEqual(await t.n.pushTest(t.ios.id), { ok: false, status: 400, reason: 'BadDeviceToken', dropToken: true });
  assert.equal(devices.get(t.ios.id)?.push, undefined, 'push-test also drops dead tokens');
});

test('approval push carries the parsed dialog and a summary body when the hub can parse the screen', async () => {
  const approval = { tool: 'Bash', command: 'npm test', path: null, description: 'Run the tests', question: 'Do you want to proceed?', options: ['Yes', 'No'], selected: 1, kind: 'permission' as const };
  let reads = 0;
  const { timers, apns, fcm, set } = setup({ approval: async () => approval, excerpt: async () => (reads++, 'screen') });
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  const payload = apns.calls[0]!.payload as { aps: { alert: { body: string } }; flow: { approval?: unknown; type: string } };
  assert.equal(payload.aps.alert.body, 'Bash · npm test — Run the tests');
  assert.deepEqual(payload.flow.approval, approval);
  assert.equal(payload.flow.type, 'approval');
  assert.equal(fcm.calls[0]!.data['approval'], JSON.stringify(approval));
  assert.equal(reads, 0, 'no excerpt read when the dialog parsed');

  const off = setup({ includeExcerpt: false, approval: async () => approval });
  off.set('w1:p1', 'blocked');
  await off.timers.advance(DEBOUNCE);
  assert.equal((off.apns.calls[0]!.payload as { flow: { approval?: unknown } }).flow.approval, undefined, 'include_excerpt off keeps dialog text out of pushes');
  assert.equal(off.fcm.calls[0]!.data['body'], 'Approval needed');
});

test('include_excerpt off: no pane text in any push — subtitles and the Live Activity title fall back to the host name, the detail stays empty', async () => {
  const approval = { tool: 'Bash', command: 'rm -rf build', path: null, description: 'Clean the tree', question: 'Do you want to proceed?', options: ['Yes', 'No'], selected: 1, kind: 'permission' as const };
  const paneText = { title: 'Fix the login bug', cwd: '/home/u/secret-project' };
  const { timers, apns, fcm, set, ios, android } = setup({ includeExcerpt: false, approval: async () => approval, excerpt: async () => 'screen text' });
  devices.updatePush(android.id, { activity: true });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  devices.setNotifyDone(ios.id, 'w1:p1', true);

  set('w1:p1', 'working', paneText);
  await timers.advance(0);
  const start = apns.calls[0]!.payload as { aps: { 'content-state': { title: string; detail: string | null }; alert: { body: string } } };
  assert.equal(start.aps['content-state'].title, 'devbox', 'Live Activity title is the host name');
  assert.equal(start.aps.alert.body, 'devbox', 'push-to-start alert names the host, not the session');
  assert.equal(fcm.calls[0]!.data['title'], 'devbox');

  set('w1:p1', 'blocked', { ...paneText, approval });
  await timers.advance(0);
  const blocked = fcm.calls[1]!.data;
  assert.equal(blocked['status'], 'blocked');
  assert.equal(blocked['title'], 'devbox');
  assert.equal(blocked['detail'], undefined, 'the approval summary is pane text');
  assert.equal(blocked['kind'], 'permission', 'the dialog kind is not text: the phone still shows Approve / Deny');
  assert.equal(blocked['prompt_id'], 'w1:p1@4212');
  const upd = apns.calls[1]!.payload as { aps: { 'content-state': { title: string; detail: string | null; kind?: string } } };
  assert.equal(upd.aps['content-state'].title, 'devbox');
  assert.equal(upd.aps['content-state'].detail, null);
  assert.equal(upd.aps['content-state'].kind, 'permission');

  await timers.advance(DEBOUNCE);
  const alert = apns.calls.filter((c) => c.pushType !== 'liveactivity');
  assert.equal(alert.length, 1, 'the approval alert went out');
  const aps = alert[0]!.payload as { aps: { alert: { subtitle: string; body: string } }; flow: { approval?: unknown } };
  assert.equal(aps.aps.alert.subtitle, 'devbox');
  assert.equal(aps.aps.alert.body, 'Approval needed');
  assert.equal(aps.flow.approval, undefined);
  const fcmAlert = fcm.calls.find((c) => c.data['type'] === 'approval')!;
  assert.equal(fcmAlert.data['subtitle'], 'devbox');
  assert.equal(fcmAlert.data['approval'], undefined);

  set('w1:p1', 'idle', paneText);
  await timers.advance(SETTLE);
  const done = apns.calls.filter((c) => c.pushType !== 'liveactivity').at(-1)!.payload as { aps: { alert: { subtitle: string; body: string } }; flow: { type: string } };
  assert.equal(done.flow.type, 'done');
  assert.equal(done.aps.alert.subtitle, 'devbox');
  assert.equal(done.aps.alert.body, 'Finished');

  const everything = JSON.stringify([apns.calls, fcm.calls]);
  for (const word of ['Fix the login bug', 'secret-project', 'rm -rf', 'Clean the tree', 'screen text']) {
    assert.equal(everything.includes(word), false, `${JSON.stringify(word)} left the host`);
  }
});

test('done alert: the body comes from finishedExcerpt (the agent’s closing words), excerpt is only the fallback', async () => {
  let screenReads = 0;
  const a = setup({ finishedExcerpt: async () => 'All 204 tests pass.', excerpt: async () => (screenReads++, 'status line') });
  devices.setNotifyDone(a.ios.id, 'w1:p1', true);
  a.set('w1:p1', 'working');
  a.set('w1:p1', 'idle');
  await a.timers.advance(SETTLE);
  assert.equal((a.apns.calls[0]!.payload as { aps: { alert: { body: string } } }).aps.alert.body, 'All 204 tests pass.');
  assert.equal(screenReads, 0, 'the raw excerpt is not read when finishedExcerpt is wired');

  const b = setup({ finishedExcerpt: async () => null });
  devices.setNotifyDone(b.ios.id, 'w1:p1', true);
  b.set('w1:p1', 'working');
  b.set('w1:p1', 'idle');
  await b.timers.advance(SETTLE);
  assert.equal((b.apns.calls[0]!.payload as { aps: { alert: { body: string } } }).aps.alert.body, 'Finished', 'no prose on screen → "Finished"');

  let reads = 0;
  const c = setup({ includeExcerpt: false, finishedExcerpt: async () => (reads++, 'secret') });
  devices.setNotifyDone(c.ios.id, 'w1:p1', true);
  c.set('w1:p1', 'working');
  c.set('w1:p1', 'idle');
  await c.timers.advance(SETTLE);
  assert.equal(reads, 0, 'include_excerpt off never reads the screen');
  assert.equal((c.apns.calls[0]!.payload as { aps: { alert: { body: string } } }).aps.alert.body, 'Finished');
});

test('done alert: armed devices are told once the agent has stayed idle for the settle time, then disarmed', async () => {
  const armChanges: [string, string, boolean][] = [];
  const { timers, apns, fcm, set, ios } = setup({ onArmChanged: (d, p, done) => armChanges.push([d, p, done]) });
  devices.setNotifyDone(ios.id, 'w1:p1', true);
  set('w1:p1', 'working');
  set('w1:p1', 'idle');
  await timers.advance(SETTLE - 1);
  assert.equal(apns.calls.length, 0);
  await timers.advance(1);
  assert.equal(apns.calls.length, 1);
  assert.equal(fcm.calls.length, 0, 'the Android device did not arm');
  const call = apns.calls[0]!;
  assert.equal(call.collapseId, 'w1:p1');
  assert.equal(call.pushType, undefined, 'a plain alert');
  const payload = call.payload as { aps: { alert: { title: string; body: string }; category: string }; flow: { type: string; pane: string } };
  assert.equal(payload.aps.category, 'REMOTLY_DONE');
  assert.equal(payload.aps.alert.title, 'Claude · finished its turn');
  assert.equal(payload.aps.alert.body, 'Allow Bash(npm test)?');
  assert.equal(payload.flow.type, 'done');
  assert.equal(devices.get(ios.id)?.notify_done, undefined, 'disarmed');
  assert.deepEqual(armChanges, [[ios.id, 'w1:p1', false]]);
  set('w1:p1', 'working');
  set('w1:p1', 'done');
  await timers.advance(SETTLE);
  assert.equal(apns.calls.length, 1, 'no second alert without a new arming');
});

test('done alert: an idle blip between turns does not fire; a viewing device is disarmed silently; a gone pane drops the arm', async () => {
  const { n, timers, apns, set, ios, viewed } = setup();
  devices.setNotifyDone(ios.id, 'w1:p1', true);
  set('w1:p1', 'working');
  set('w1:p1', 'idle');
  await timers.advance(SETTLE / 2);
  set('w1:p1', 'working');
  await timers.advance(SETTLE);
  assert.equal(apns.calls.length, 0);
  assert.deepEqual(devices.get(ios.id)?.notify_done, ['w1:p1'], 'still armed');
  viewed.add('w1:p1');
  set('w1:p1', 'done');
  await timers.advance(SETTLE);
  assert.equal(apns.calls.length, 0);
  assert.equal(devices.get(ios.id)?.notify_done, undefined, 'consumed even though suppressed');

  devices.setNotifyDone(ios.id, 'w1:p2', true);
  n.onPaneGone('w1:p2');
  await timers.advance(SETTLE);
  assert.equal(devices.get(ios.id)?.notify_done, undefined);
  assert.equal(apns.calls.length, 0);
});

test('status feed: Android opt-in gets FCM status data on every change; iOS gets Live Activity start/update/end', async () => {
  const { timers, apns, fcm, set, ios, android } = setup();
  devices.updatePush(android.id, { activity: true });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working');
  await timers.advance(0);
  assert.deepEqual([...fcm.calls], [
    {
      token: 'fcm-reg-token',
      collapseKey: 'status:w1:p1',
      ttlSec: 60,
      data: { v: '1', type: 'status', host: 'devbox', pane: 'w1:p1', agent: 'claude', display_agent: 'Claude', title: 'Remotly bridge', status: 'working', since: String(timers.now()) },
    },
  ]);
  assert.equal(apns.calls.length, 1);
  const start = apns.calls[0]!;
  assert.equal(start.token, 'la-start');
  assert.equal(start.pushType, 'liveactivity');
  assert.equal(start.priority, 10);
  assert.equal(start.collapseId, 'la:w1:p1');
  const startPayload = start.payload as { aps: { event: string; 'attributes-type': string; attributes: object; 'content-state': { status: string; since: number } } };
  assert.equal(startPayload.aps.event, 'start');
  assert.equal(startPayload.aps['attributes-type'], 'FlowActivityAttributes');
  assert.deepEqual(startPayload.aps.attributes, { pane: 'w1:p1', host: 'devbox', agent: 'claude', displayAgent: 'Claude' });

  devices.setActivityToken(ios.id, 'w1:p1', 'la-upd'); // the phone reported the running activity's token
  await timers.advance(1000);
  set('w1:p1', 'blocked');
  await timers.advance(0);
  const upd = apns.calls[1]!;
  assert.equal(upd.token, 'la-upd');
  assert.equal(upd.priority, 10);
  const updPayload = upd.payload as { aps: { event: string; 'content-state': { status: string; promptId: string | null; since: number } } };
  assert.equal(updPayload.aps.event, 'update');
  assert.equal(updPayload.aps['content-state'].status, 'blocked');
  assert.equal(updPayload.aps['content-state'].promptId, 'w1:p1@4212');
  assert.equal(updPayload.aps['content-state'].since, startPayload.aps['content-state'].since, 'since = when the work started');
  assert.equal(fcm.calls[1]!.data['prompt_id'], 'w1:p1@4212');
  assert.equal(fcm.calls[1]!.data['status'], 'blocked');

  set('w1:p1', 'working');
  await timers.advance(0);
  assert.equal(apns.calls[2]!.priority, 5, 'plain working updates do not light the screen');

  set('w1:p1', 'idle');
  await timers.advance(0);
  const end = apns.calls[3]!;
  assert.equal(end.token, 'la-upd');
  assert.equal((end.payload as { aps: { event: string } }).aps.event, 'end');
  assert.equal(devices.get(ios.id)?.push?.la_panes, undefined, 'update token forgotten after end');
  assert.equal(fcm.calls[3]!.data['status'], 'idle');
  assert.equal(apns.calls.length, 4, 'the approval alert was cancelled by the status change');

  set('w1:p1', 'working');
  await timers.advance(0);
  assert.equal((apns.calls[4]!.payload as { aps: { 'content-state': { since: number } } }).aps['content-state'].since, Math.floor(timers.now() / 1000), 'a new stretch starts the clock again');
  assert.equal(apns.calls[4]!.token, 'la-start', 'no activity running → start again');
});

test('status feed: an update token that arrives late brings that activity up to date, or ends it when the pane already stopped', async () => {
  const { n, timers, apns, set, ios, panes, lines } = setup();
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working');
  await timers.advance(0);
  assert.equal(apns.calls.length, 1, 'start pushed');
  const since = (apns.calls[0]!.payload as { aps: { 'content-state': { since: number } } }).aps['content-state'].since;

  // iOS woke the app in the background; it hands the token over while the agent has meanwhile blocked.
  await timers.advance(1000);
  panes.set('w1:p1', blockedPane({ agent_status: 'blocked' }));
  devices.setActivityToken(ios.id, 'w1:p1', 'la-upd');
  n.syncActivity(ios.id, 'w1:p1');
  await timers.advance(0);
  const upd = apns.calls[1]!;
  assert.equal(upd.token, 'la-upd');
  const updPayload = upd.payload as { aps: { event: string; 'content-state': { status: string; since: number; promptId: string | null } } };
  assert.equal(updPayload.aps.event, 'update');
  assert.equal(updPayload.aps['content-state'].status, 'blocked');
  assert.equal(updPayload.aps['content-state'].promptId, 'w1:p1@4212');
  assert.equal(updPayload.aps['content-state'].since, since, 'the clock keeps the start of the stretch');
  assert.equal(lines.filter((l) => l['event'] === 'push.sent' && l['la_event'] === 'update').length, 1, 'push.sent keeps its event name');

  // Token for a pane that has already stopped: end the activity and forget the token.
  set('w1:p2', 'idle');
  devices.setActivityToken(ios.id, 'w1:p2', 'la-late');
  n.syncActivity(ios.id, 'w1:p2');
  await timers.advance(0);
  const end = apns.calls[2]!;
  assert.equal(end.token, 'la-late');
  assert.equal((end.payload as { aps: { event: string } }).aps.event, 'end');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p2'], undefined, 'token forgotten after end');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], 'la-upd', 'the running activity keeps its token');

  // A pane the bridge no longer knows ends too.
  devices.setActivityToken(ios.id, 'w9:p9', 'la-ghost');
  n.syncActivity(ios.id, 'w9:p9');
  await timers.advance(0);
  assert.equal((apns.calls[3]!.payload as { aps: { event: string } }).aps.event, 'end');
  assert.equal(apns.calls.length, 4);
});

test('status feed: dead Live Activity tokens are forgotten without touching the alert token; devices without opt-in get nothing', async () => {
  const apns = fakeClient<ApnsSendInput>((input) => (input.pushType === 'liveactivity' ? { ok: false, status: 410, reason: 'Unregistered', dropToken: true } : { ok: true }));
  const { timers, fcm, set, ios } = setup({ apns });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working');
  await timers.advance(0);
  assert.equal(apns.calls.length, 1);
  assert.equal(fcm.calls.length, 0, 'Android did not opt in');
  const push = devices.get(ios.id)?.push;
  assert.equal(push?.la_start, undefined);
  assert.equal(push?.token, 'apns-hex-token', 'alert token kept');
  assert.equal(push?.activity, true);
  set('w1:p1', 'blocked');
  await timers.advance(DEBOUNCE);
  assert.equal(apns.calls.length, 2, 'no start token left → only the approval alert');
  assert.equal(apns.calls[1]!.pushType, undefined);
});

test('sessionTitle: the pane title, else the cwd basename, else the pane id (the apps\' rule)', () => {
  assert.equal(sessionTitle({ title: 'Fixing tests', cwd: '/home/u/flow' }, 'w1:p1'), 'Fixing tests');
  assert.equal(sessionTitle({ title: '', cwd: '/home/u/flow' }, 'w1:p1'), 'flow');
  assert.equal(sessionTitle({ title: '', cwd: '/home/u/flow/' }, 'w1:p1'), 'flow');
  assert.equal(sessionTitle({ title: '', cwd: '/' }, 'w1:p1'), '/');
  assert.equal(sessionTitle({ title: '', cwd: null }, 'w1:p1'), 'w1:p1');
  assert.equal(sessionTitle(undefined, 'w1:p1'), 'w1:p1');
});

test('a title change while working updates the Live Activity and the Android status notification, never starts one, and is ignored once ended', async () => {
  const { n, timers, apns, fcm, set, panes, ios, android } = setup();
  devices.updatePush(android.id, { activity: true });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working', { title: '' });
  await timers.advance(0);
  assert.equal(apns.calls.length, 1, 'push-to-start');
  assert.equal(fcm.calls[0]!.data['title'], 'flow', 'cwd basename until the session is named');
  // Claude names the session; the activity's update token has not reached us yet → no second start.
  panes.set('w1:p1', blockedPane({ agent_status: 'working', title: 'Fixing tests' }));
  n.onTitleChange('w1:p1');
  await timers.advance(0);
  assert.equal(apns.calls.length, 1, 'a title change never pushes to start');
  assert.equal(fcm.calls.length, 2);
  assert.equal(fcm.calls[1]!.data['title'], 'Fixing tests');
  devices.setActivityToken(ios.id, 'w1:p1', 'la-update');
  panes.set('w1:p1', blockedPane({ agent_status: 'working', title: 'Fixing the flaky tests' }));
  n.onTitleChange('w1:p1');
  await timers.advance(0);
  assert.equal(apns.calls.length, 2);
  const upd = apns.calls[1]!;
  assert.equal(upd.token, 'la-update');
  const updPayload = upd.payload as { aps: { event: string; 'content-state': { title: string; status: string } } };
  assert.equal(updPayload.aps.event, 'update');
  assert.equal(updPayload.aps['content-state'].title, 'Fixing the flaky tests');
  assert.equal(updPayload.aps['content-state'].status, 'working');
  // Once the stretch has ended, a late rename is nothing to show.
  set('w1:p1', 'idle');
  await timers.advance(0);
  const before = apns.calls.length + fcm.calls.length;
  panes.set('w1:p1', blockedPane({ agent_status: 'idle', title: 'Renamed after the fact' }));
  n.onTitleChange('w1:p1');
  await timers.advance(0);
  assert.equal(apns.calls.length + fcm.calls.length, before);
});

test('a pane that disappears ends its Live Activity under the session title it had, not its id', async () => {
  const { n, timers, apns, set, panes, ios } = setup();
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working', { title: 'Nightly delivery failures' });
  await timers.advance(0);
  devices.setActivityToken(ios.id, 'w1:p1', 'la-update');
  panes.delete('w1:p1');
  n.onPaneGone('w1:p1');
  await timers.advance(0);
  const end = apns.calls.at(-1)!;
  assert.equal(end.token, 'la-update');
  const payload = end.payload as { aps: { event: string; 'content-state': { title: string; status: string } } };
  assert.equal(payload.aps.event, 'end');
  assert.equal(payload.aps['content-state'].title, 'Nightly delivery failures');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], undefined, 'update token forgotten');
});

test('an end APNs refuses for a passing reason keeps the activity token and the session identity for the next attempt', async () => {
  let refuseEnds = true;
  const apns = fakeClient<ApnsSendInput>((input) => {
    const event = (input.payload as { aps: { event: string } }).aps.event;
    return refuseEnds && event === 'end' ? { ok: false, status: 500, reason: 'InternalServerError', dropToken: false } : { ok: true };
  });
  const { n, timers, set, panes, ios } = setup({ apns });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working', { title: 'Nightly delivery failures' });
  await timers.advance(0);
  devices.setActivityToken(ios.id, 'w1:p1', 'la-update');
  panes.delete('w1:p1');
  n.onPaneGone('w1:p1');
  await timers.advance(0);
  assert.equal((apns.calls.at(-1)!.payload as { aps: { event: string } }).aps.event, 'end');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], 'la-update', 'token kept after a refused end');
  refuseEnds = false;
  n.syncActivity(ios.id, 'w1:p1'); // the phone reports the token again: the end goes out, still under the session's name
  await timers.advance(0);
  const end = apns.calls.at(-1)!;
  const payload = end.payload as { aps: { event: string; 'content-state': { title: string } } };
  assert.equal(end.token, 'la-update');
  assert.equal(payload.aps.event, 'end');
  assert.equal(payload.aps['content-state'].title, 'Nightly delivery failures');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], undefined, 'token forgotten once the end was delivered');
});

test('a refused end is tried once more after 30 s, still under the session name; then the token goes whatever APNs says', async () => {
  const apns = fakeClient<ApnsSendInput>((input) => ((input.payload as { aps: { event: string } }).aps.event === 'end' ? { ok: false, status: 503, reason: 'ServiceUnavailable', dropToken: false } : { ok: true }));
  const { n, timers, set, panes, ios } = setup({ apns });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working', { title: 'Nightly delivery failures' });
  await timers.advance(0);
  devices.setActivityToken(ios.id, 'w1:p1', 'la-update');
  panes.delete('w1:p1');
  n.onPaneGone('w1:p1');
  await timers.advance(0);
  const ends = () => apns.calls.filter((c) => (c.payload as { aps: { event: string } }).aps.event === 'end');
  assert.equal(ends().length, 1);
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], 'la-update', 'kept for the retry');
  await timers.advance(30_000 - 1);
  assert.equal(ends().length, 1);
  await timers.advance(1);
  assert.equal(ends().length, 2, 'one retry');
  assert.equal((ends()[1]!.payload as { aps: { 'content-state': { title: string } } }).aps['content-state'].title, 'Nightly delivery failures');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], undefined, 'let go after the retry');
  await timers.advance(60_000);
  assert.equal(ends().length, 2, 'no further retries');
});

test('an update to a token the phone no longer holds starts a fresh activity in the same transition', async () => {
  const apns = fakeClient<ApnsSendInput>((input) => (input.token === 'la-dead' ? { ok: false, status: 410, reason: 'Unregistered', dropToken: true } : { ok: true }));
  const { timers, set, ios } = setup({ apns });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  devices.setActivityToken(ios.id, 'w1:p1', 'la-dead');
  set('w1:p1', 'working');
  await timers.advance(0);
  assert.deepEqual(apns.calls.map((c) => [c.token, (c.payload as { aps: { event: string } }).aps.event]), [['la-dead', 'update'], ['la-start', 'start']]);
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], undefined, 'the dead token is gone; the phone reports the new one');
});

test('a late end retry does not clear a token the phone reported for a fresh activity meanwhile', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const apns = {
    calls: [] as ApnsSendInput[],
    closed: false,
    async send(input: ApnsSendInput): Promise<PushResult> {
      this.calls.push(input);
      const ends = this.calls.filter((c) => (c.payload as { aps: { event: string } }).aps.event === 'end').length;
      if ((input.payload as { aps: { event: string } }).aps.event !== 'end') return { ok: true };
      if (ends === 1) return { ok: false, status: 503, reason: 'ServiceUnavailable', dropToken: false };
      await gate; // the retry is in flight while the phone reports a new token
      return { ok: true };
    },
    close() { this.closed = true; },
  };
  const { n, timers, set, panes, ios } = setup({ apns });
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  set('w1:p1', 'working');
  await timers.advance(0);
  devices.setActivityToken(ios.id, 'w1:p1', 'la-old');
  panes.delete('w1:p1');
  n.onPaneGone('w1:p1');
  await timers.advance(0);
  await timers.advance(30_000); // the retry goes out and parks
  devices.setActivityToken(ios.id, 'w1:p1', 'la-new'); // a new pane with this id started an activity meanwhile
  release();
  await timers.advance(0);
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], 'la-new', 'the fresh token survives the old end');
});

test('no push-to-start after a dead update token when the phone reported a fresh token meanwhile', async () => {
  let iosId = '';
  const apns = fakeClient<ApnsSendInput>((input) => {
    if (input.token !== 'la-dead') return { ok: true };
    devices.setActivityToken(iosId, 'w1:p1', 'la-fresh'); // the phone's report races the 410
    return { ok: false, status: 410, reason: 'Unregistered', dropToken: true };
  });
  const { timers, set, ios } = setup({ apns });
  iosId = ios.id;
  devices.updatePush(ios.id, { activity: true, la_start: 'la-start' });
  devices.setActivityToken(ios.id, 'w1:p1', 'la-dead');
  set('w1:p1', 'working');
  await timers.advance(0);
  assert.deepEqual(apns.calls.map((c) => [c.token, (c.payload as { aps: { event: string } }).aps.event]), [['la-dead', 'update']], 'no second activity');
  assert.equal(devices.get(ios.id)?.push?.la_panes?.['w1:p1'], 'la-fresh');
});
