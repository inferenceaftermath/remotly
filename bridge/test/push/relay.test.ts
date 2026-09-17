import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, type LogFields } from '../../src/log.ts';
import { RelayClient, relayApnsBody, relayFcmBody } from '../../src/push/relay.ts';

const TOKEN = 'ab'.repeat(32);
const RELAY = 'https://relay.example';

interface Call {
  url: string;
  init: RequestInit;
}
type Handler = (url: string, init: RequestInit, n: number) => { status: number; body?: unknown } | 'throw' | 'bodyError';

function make(handler: Handler) {
  const lines: LogFields[] = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) });
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {}, calls.length);
    if (r === 'throw') throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    if (r === 'bodyError') {
      return new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.error(new TypeError('terminated')) }), { status: 200 });
    }
    return new Response(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const c = new RelayClient({ url: `${RELAY}/`, log, version: '0.1.0', fetchImpl });
  return { c, calls, lines };
}

const apnsInput = { token: TOKEN, env: 'production' as const, collapseId: 'w1:p1', payload: { aps: { alert: { title: 'Approval needed' } } } };
const fcmInput = { token: 'fcm-registration-token', collapseKey: 'w1:p1', ttlSec: 600, data: { type: 'approval', pane: 'w1:p1' } };

test('relayApnsBody: defaults alert/10/600, liveactivity gets 60 s like the direct client', () => {
  assert.deepEqual(relayApnsBody(apnsInput), { platform: 'ios', token: TOKEN, env: 'production', collapse_id: 'w1:p1', push_type: 'alert', priority: 10, ttl_sec: 600, payload: apnsInput.payload });
  assert.deepEqual(relayApnsBody({ ...apnsInput, env: 'sandbox', pushType: 'liveactivity', priority: 5 }), {
    platform: 'ios', token: TOKEN, env: 'sandbox', collapse_id: 'w1:p1', push_type: 'liveactivity', priority: 5, ttl_sec: 60, payload: apnsInput.payload,
  });
  assert.deepEqual(relayFcmBody(fcmInput), { platform: 'android', token: 'fcm-registration-token', collapse_key: 'w1:p1', ttl_sec: 600, data: fcmInput.data });
});

test('apns()/fcm() post to /v1/push with the bridge user-agent and map the relay result', async () => {
  const { c, calls } = make(() => ({ status: 200, body: { ok: true } }));
  assert.deepEqual(await c.apns().send(apnsInput), { ok: true });
  assert.deepEqual(await c.fcm().send(fcmInput), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${RELAY}/v1/push`, 'trailing slash on the base url is dropped');
  assert.equal(calls[0]!.init.method, 'POST');
  const h = new Headers(calls[0]!.init.headers);
  assert.equal(h.get('user-agent'), 'remotly-bridge/0.1.0');
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(calls[0]!.init.redirect, 'error', 'a redirect must never re-post the token elsewhere');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), relayApnsBody(apnsInput));
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), relayFcmBody(fcmInput));
  c.apns().close();
  c.fcm().close();
});

test('upstream failures come back as PushResult with dropToken from drop_token', async () => {
  const { c } = make(() => ({ status: 200, body: { ok: false, status: 410, reason: 'Unregistered', drop_token: true } }));
  assert.deepEqual(await c.apns().send(apnsInput), { ok: false, status: 410, reason: 'Unregistered', dropToken: true });
  const { c: c2 } = make(() => ({ status: 200, body: { ok: false, status: 429, reason: 'TooManyRequests', drop_token: false } }));
  assert.deepEqual(await c2.apns().send(apnsInput), { ok: false, status: 429, reason: 'TooManyRequests', dropToken: false });
});

test('relay-level errors never drop the token and are logged without the token or payload', async () => {
  const { c, lines } = make(() => ({ status: 429, body: { error: 'rate_limited', scope: 'token' } }));
  assert.deepEqual(await c.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_rate_limited', dropToken: false });
  const { c: c2, lines: l2 } = make(() => ({ status: 503, body: { error: 'not_configured', platform: 'ios' } }));
  assert.deepEqual(await c2.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_not_configured', dropToken: false });
  assert.ok(l2.some((l) => l['event'] === 'relay.not_configured' && l['level'] === 'error'));
  const { c: c5, lines: l5 } = make(() => ({ status: 503, body: { error: 'rate_limiter_unavailable' } }));
  assert.deepEqual(await c5.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_rate_limiter_unavailable', dropToken: false });
  assert.ok(l5.some((l) => l['event'] === 'relay.unavailable' && l['level'] === 'warn'), 'a fail-closed limiter is not a secrets problem');
  assert.ok(!l5.some((l) => l['event'] === 'relay.not_configured'));
  const { c: c3, lines: l3 } = make(() => ({ status: 502, body: '<html>bad gateway</html>' }));
  assert.deepEqual(await c3.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_HTTP_502', dropToken: false });
  assert.ok(l3.some((l) => l['event'] === 'relay.unavailable'));
  const { c: c4 } = make(() => ({ status: 200, body: { ok: 'maybe' } }));
  assert.deepEqual(await c4.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_bad_response', dropToken: false });
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(TOKEN) && !all.includes('Approval needed'));
  assert.ok(lines.some((l) => l['event'] === 'relay.rejected' && l['status'] === 429));
});

test('a transport failure is never retried (a push is not idempotent): relay_unreachable after one attempt', async () => {
  const { c, calls, lines } = make(() => 'throw');
  assert.deepEqual(await c.fcm().send(fcmInput), { ok: false, status: 0, reason: 'relay_unreachable', dropToken: false });
  assert.equal(calls.length, 1);
  assert.ok(lines.some((l) => l['event'] === 'relay.transport_error' && l['error'] === 'ECONNREFUSED'));
});

test('a failure while reading the reply body is relay_bad_response, not a rejection and not a retry', async () => {
  const { c, calls, lines } = make(() => 'bodyError');
  assert.deepEqual(await c.apns().send(apnsInput), { ok: false, status: 0, reason: 'relay_bad_response', dropToken: false });
  assert.equal(calls.length, 1);
  assert.ok(lines.some((l) => l['event'] === 'relay.transport_error' && l['status'] === 200));
});

test('health(): parsed on success, null on error, non-200 or an unexpected body', async () => {
  const { c, calls } = make(() => ({ status: 200, body: { ok: true, version: '0.1.0', apns: true, fcm: false } }));
  assert.deepEqual(await c.health(), { apns: true, fcm: false, version: '0.1.0' });
  assert.equal(calls[0]!.url, `${RELAY}/health`);
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(await make(() => ({ status: 500 })).c.health(), null);
  assert.equal(await make(() => ({ status: 200, body: { hello: 'world' } })).c.health(), null);
  assert.equal(await make(() => 'throw').c.health(), null);
});
