import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createRelay, parsePush, type RelayEnv } from '../src/relay.ts';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SA = JSON.stringify({ client_email: 'relay@proj.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const decode = (seg: string): unknown => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = 'dGVzdA:APA91bFakeRegistrationToken_0123456789-abcdefghijklmnopqrstuvwxyz';
const APNS_URL = `https://api.push.apple.com/3/device/${APNS_TOKEN}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://fcm.googleapis.com/v1/projects/proj/messages:send';

interface Call {
  url: string;
  init: RequestInit;
}
type Handler = (url: string, init: RequestInit, n: number) => { status: number; body?: unknown } | 'throw' | 'bodyError';

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {}, calls.length);
    if (r === 'throw') throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    if (r === 'bodyError') {
      // Headers arrived (200), then the body stream fails: the peer may have accepted the message.
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new TypeError('terminated'));
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const allow = { limit: async () => ({ success: true }) };

function env(overrides: Partial<RelayEnv> = {}): RelayEnv {
  return {
    APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567', APNS_P8: P8, APNS_BUNDLE_ID: 'com.example.remotly',
    FCM_PROJECT_ID: 'proj', FCM_PACKAGE_NAME: 'com.example.remotly', FCM_SERVICE_ACCOUNT: SA,
    RL_IP: allow, RL_TOKEN: allow,
    ...overrides,
  };
}

/** `env()` minus some keys (exactOptionalPropertyTypes forbids `key: undefined`). */
function envWithout(...keys: (keyof RelayEnv)[]): RelayEnv {
  const e = env();
  for (const k of keys) delete e[k];
  return e;
}

function make(handler: Handler, opts: { now?: () => number } = {}) {
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const { fetchImpl, calls } = fakeFetch(handler);
  const relay = createRelay({ fetchImpl, log: (event, fields) => logs.push({ event, fields }), ...(opts.now ? { now: opts.now } : {}) });
  return { relay, calls, logs };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://relay.example/v1/push', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const iosBody = (extra: Record<string, unknown> = {}) => ({ platform: 'ios', token: APNS_TOKEN, env: 'production', collapse_id: 'w1:p1', payload: { aps: { alert: { title: 'Approval needed' } }, remotly: { pane: 'w1:p1' } }, ...extra });
const androidBody = (extra: Record<string, unknown> = {}) => ({ platform: 'android', token: FCM_TOKEN, collapse_key: 'w1:p1', ttl_sec: 600, data: { type: 'approval', pane: 'w1:p1' }, ...extra });

const tokenOk = { status: 200, body: { access_token: 'ya29.token', expires_in: 3600, token_type: 'Bearer' } };

// ---- routing --------------------------------------------------------------------------------------

test('health reports version and which platforms are configured', async () => {
  const { relay } = make(() => ({ status: 200 }));
  const res = await relay.fetch(new Request('https://relay.example/health'), envWithout('FCM_SERVICE_ACCOUNT'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: '0.1.0', apns: true, fcm: false });
});

test('health is behind the per-address limiter too, and fails closed without it', async () => {
  const { relay } = make(() => ({ status: 200 }));
  const deny = { limit: async () => ({ success: false }) };
  assert.equal((await relay.fetch(new Request('https://relay.example/health'), env({ RL_IP: deny }))).status, 429);
  const res = await relay.fetch(new Request('https://relay.example/health'), envWithout('RL_IP'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'rate_limiter_unavailable' });
});

test('unknown path is 404, wrong method is 405', async () => {
  const { relay } = make(() => ({ status: 200 }));
  assert.equal((await relay.fetch(new Request('https://relay.example/'), env())).status, 404);
  assert.equal((await relay.fetch(new Request('https://relay.example/v1/push'), env())).status, 405);
  assert.equal((await relay.fetch(new Request('https://relay.example/health', { method: 'POST' }), env())).status, 405);
});

test('oversized bodies are refused before parsing (declared and undeclared length)', async () => {
  const { relay, calls } = make(() => ({ status: 200 }));
  const big = JSON.stringify({ platform: 'ios', pad: 'x'.repeat(17_000) });
  assert.equal((await relay.fetch(post(big), env())).status, 413);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(big));
      c.close();
    },
  });
  const undeclared = new Request('https://relay.example/v1/push', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await relay.fetch(undeclared, env())).status, 413);
  assert.equal(calls.length, 0);
});

test('bad requests name the field and never reach upstream', async () => {
  const { relay, calls } = make(() => ({ status: 200 }));
  const detail = async (body: unknown): Promise<string> => {
    const res = await relay.fetch(post(body), env());
    assert.equal(res.status, 400);
    return ((await res.json()) as { detail: string }).detail;
  };
  assert.match(await detail('{not json'), /JSON/);
  assert.match(await detail([]), /object/);
  assert.match(await detail({ platform: 'web' }), /platform/);
  assert.match(await detail(iosBody({ token: 'zz' })), /token/);
  assert.match(await detail(iosBody({ env: 'staging' })), /env/);
  assert.match(await detail(iosBody({ push_type: 'background' })), /push_type/);
  assert.match(await detail(iosBody({ priority: 1 })), /priority/);
  assert.match(await detail(iosBody({ collapse_id: 'x'.repeat(65) })), /collapse_id/);
  assert.match(await detail(iosBody({ collapse_id: 'w1:p1\r\napns-topic: other' })), /collapse_id/, 'no header injection via collapse id');
  assert.match(await detail(iosBody({ collapse_id: 'w1 p1' })), /collapse_id/);
  assert.match(await detail(iosBody({ payload: { big: 'x'.repeat(5000) } })), /payload/);
  assert.match(await detail(iosBody({ payload: 'string' })), /payload/);
  assert.match(await detail(iosBody({ ttl_sec: 1e9 })), /ttl_sec/);
  assert.match(await detail(androidBody({ data: { n: 1 } })), /data/);
  assert.match(await detail(androidBody({ token: 'a b' })), /token/);
  assert.match(await detail(androidBody({ collapse_key: '' })), /collapse_key/);
  assert.equal(calls.length, 0);
});

test('parsePush defaults: production, alert, priority 10, ttl 600 (60 for liveactivity)', () => {
  const a = parsePush(JSON.stringify(iosBody()));
  assert.equal(a.platform, 'ios');
  if (a.platform === 'ios') {
    assert.equal(a.env, 'production');
    assert.equal(a.pushType, 'alert');
    assert.equal(a.priority, 10);
    assert.equal(a.ttlSec, 600);
  }
  const b = parsePush(JSON.stringify(iosBody({ push_type: 'liveactivity', priority: 5 })));
  if (b.platform === 'ios') {
    assert.equal(b.ttlSec, 60);
    assert.equal(b.priority, 5);
  }
});

test('rate limiter: IP scope before the body is read, token scope after parsing (lower-cased APNs token)', async () => {
  const { relay, calls } = make(() => ({ status: 200 }));
  const keys: string[] = [];
  const deny = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
  const record = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };

  let res = await relay.fetch(post(iosBody(), { 'cf-connecting-ip': '203.0.113.9' }), env({ RL_IP: deny }));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate_limited', scope: 'ip' });
  assert.deepEqual(keys, ['203.0.113.9']);

  keys.length = 0;
  res = await relay.fetch(post(iosBody({ token: APNS_TOKEN.toUpperCase() })), env({ RL_IP: record, RL_TOKEN: deny }));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate_limited', scope: 'token' });
  assert.deepEqual(keys, ['unknown', `ios:${APNS_TOKEN}`], 'casing does not open a second bucket');
  assert.equal(calls.length, 0);
});

test('rate limiter: a missing or throwing binding fails closed with 503, nothing is forwarded', async () => {
  const { relay, calls, logs } = make(() => ({ status: 200 }));
  const broken = { limit: async () => Promise.reject(new Error('limiter down')) };
  for (const e of [envWithout('RL_IP'), envWithout('RL_TOKEN'), env({ RL_IP: broken }), env({ RL_TOKEN: broken })]) {
    const res = await relay.fetch(post(iosBody()), e);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'rate_limiter_unavailable' });
  }
  assert.equal(calls.length, 0);
  assert.equal(logs.filter((l) => l.event === 'ratelimit.error').length, 4);
});

test('a platform without credentials answers 503 not_configured', async () => {
  const { relay, calls } = make(() => ({ status: 200 }));
  const res = await relay.fetch(post(iosBody()), envWithout('APNS_P8'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'not_configured', platform: 'ios' });
  const res2 = await relay.fetch(post(androidBody()), env({ FCM_SERVICE_ACCOUNT: '{"client_email":1}' }));
  assert.equal(res2.status, 503);
  const { relay: r3 } = make(() => ({ status: 200 }));
  assert.equal((await r3.fetch(post(androidBody()), envWithout('FCM_PACKAGE_NAME'))).status, 503, 'no package restriction, no FCM');
  assert.equal(calls.length, 0);
});

// ---- APNs -----------------------------------------------------------------------------------------

test('ios: forwards to APNs with pinned topic, computed expiration, caller headers; jwt cached across pushes', async () => {
  let t = 1_700_000_000_000;
  const { relay, calls, logs } = make(() => ({ status: 200 }), { now: () => t });
  const res = await relay.fetch(post(iosBody()), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, APNS_URL);
  const h = new Headers(c.init.headers);
  assert.equal(h.get('apns-topic'), 'com.example.remotly');
  assert.equal(h.get('apns-push-type'), 'alert');
  assert.equal(h.get('apns-priority'), '10');
  assert.equal(h.get('apns-collapse-id'), 'w1:p1');
  assert.equal(h.get('apns-expiration'), String(1_700_000_000 + 600));
  assert.equal(h.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(c.init.body as string), iosBody().payload);
  const jwt1 = h.get('authorization')!.replace(/^bearer /, '');
  const [jh, jc] = jwt1.split('.') as [string, string];
  assert.deepEqual(decode(jh), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.deepEqual(decode(jc), { iss: 'TEAM123456', iat: 1_700_000_000 });

  t += 10 * 60_000;
  await relay.fetch(post(iosBody({ push_type: 'liveactivity', priority: 5 })), env());
  const h2 = new Headers(calls[1]!.init.headers);
  assert.equal(h2.get('authorization'), `bearer ${jwt1}`, 'jwt reused within 50 min');
  assert.equal(h2.get('apns-topic'), 'com.example.remotly.push-type.liveactivity');
  assert.equal(h2.get('apns-push-type'), 'liveactivity');
  assert.equal(h2.get('apns-priority'), '5');
  assert.equal(h2.get('apns-expiration'), String(1_700_000_600 + 60));

  t += 41 * 60_000;
  await relay.fetch(post(iosBody()), env());
  assert.notEqual(new Headers(calls[2]!.init.headers).get('authorization'), `bearer ${jwt1}`, 'jwt re-minted after 50 min');

  const serialised = JSON.stringify(logs);
  assert.ok(!serialised.includes(APNS_TOKEN), 'logs never contain the device token');
  assert.ok(!serialised.includes('Approval needed'), 'logs never contain payload text');
  assert.equal(logs.filter((l) => l.event === 'push').length, 3);
});

test('ios: dead-token statuses set drop_token; other failures do not', async () => {
  const replies: { status: number; body: unknown }[] = [
    { status: 410, body: { reason: 'Unregistered', timestamp: 1 } },
    { status: 400, body: { reason: 'BadDeviceToken' } },
    { status: 429, body: { reason: 'TooManyRequests' } },
    { status: 500, body: 'oops' },
  ];
  const { relay } = make(() => replies.shift()!);
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await (await relay.fetch(post(iosBody()), env())).json());
  assert.deepEqual(results, [
    { ok: false, status: 410, reason: 'Unregistered', drop_token: true },
    { ok: false, status: 400, reason: 'BadDeviceToken', drop_token: true },
    { ok: false, status: 429, reason: 'TooManyRequests', drop_token: false },
    { ok: false, status: 500, reason: 'HTTP_500', drop_token: false },
  ]);
});

test('ios: InvalidProviderToken clears the cached jwt and logs a config error', async () => {
  let n = 0;
  const { relay, calls, logs } = make(() => (++n === 1 ? { status: 403, body: { reason: 'InvalidProviderToken' } } : { status: 200 }), { now: () => 1_700_000_000_000 });
  await relay.fetch(post(iosBody()), env());
  await relay.fetch(post(iosBody()), env());
  const a1 = new Headers(calls[0]!.init.headers).get('authorization');
  const a2 = new Headers(calls[1]!.init.headers).get('authorization');
  assert.notEqual(a1, a2, 'a fresh jwt after the rejection');
  assert.ok(logs.some((l) => l.event === 'apns.config_error' && l.fields['reason'] === 'InvalidProviderToken'));
});

test('ios: a rejected fetch is retried once, then reported as status 0; the token is forwarded lower-case', async () => {
  const { relay, calls } = make(() => 'throw');
  const res = await relay.fetch(post(iosBody({ token: APNS_TOKEN.toUpperCase() })), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'ECONNRESET', drop_token: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, APNS_URL);
});

test('ios: a failure while reading the response body is never retried (the push may have been accepted)', async () => {
  const { relay, calls } = make(() => 'bodyError');
  const res = await relay.fetch(post(iosBody()), env());
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'response_body_error', drop_token: false });
  assert.equal(calls.length, 1);
});

test('ios: an unusable .p8 is a config error, not a crash', async () => {
  const { relay, logs } = make(() => ({ status: 200 }));
  const res = await relay.fetch(post(iosBody()), env({ APNS_P8: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'provider_key_invalid', drop_token: false });
  assert.ok(logs.some((l) => l.event === 'apns.config_error'));
});

// ---- FCM ------------------------------------------------------------------------------------------

test('android: exchanges the service-account jwt once, then sends the data-only envelope', async () => {
  const { relay, calls } = make((url) => (url === TOKEN_URL ? tokenOk : { status: 200, body: { name: 'projects/proj/messages/1' } }), { now: () => 1_700_000_000_000 });
  const res = await relay.fetch(post(androidBody()), env());
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, TOKEN_URL);
  const form = new URLSearchParams(calls[0]!.init.body as string);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [, claims] = form.get('assertion')!.split('.') as [string, string];
  assert.deepEqual(decode(claims), {
    iss: 'relay@proj.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: TOKEN_URL,
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  assert.equal(calls[1]!.url, SEND_URL);
  assert.equal(new Headers(calls[1]!.init.headers).get('authorization'), 'Bearer ya29.token');
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
    message: {
      token: FCM_TOKEN,
      android: { priority: 'HIGH', ttl: '600s', collapse_key: 'w1:p1', restricted_package_name: 'com.example.remotly' },
      data: { type: 'approval', pane: 'w1:p1' },
    },
  });

  await relay.fetch(post(androidBody()), env());
  assert.equal(calls.length, 3, 'access token reused');
  assert.equal(calls[2]!.url, SEND_URL);
});

test('android: UNREGISTERED and invalid registration tokens are dropped; 401 clears the access token', async () => {
  const replies: { status: number; body: unknown }[] = [
    { status: 404, body: { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } },
    { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } } },
    { status: 401, body: { error: { status: 'UNAUTHENTICATED', message: 'bad' } } },
  ];
  const { relay, calls, logs } = make((url) => (url === TOKEN_URL ? tokenOk : replies.shift()!));
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await (await relay.fetch(post(androidBody()), env())).json());
  assert.deepEqual(results, [
    { ok: false, status: 404, reason: 'UNREGISTERED', drop_token: true },
    { ok: false, status: 400, reason: 'INVALID_ARGUMENT', drop_token: true },
    { ok: false, status: 401, reason: 'UNAUTHENTICATED', drop_token: false },
  ]);
  assert.ok(logs.some((l) => l.event === 'fcm.config_error'));
  await relay.fetch(post(androidBody()), env());
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 2, 'token exchanged again after the 401');
});

test('android: a failed token exchange is token_exchange_failed, nothing sent', async () => {
  const { relay, calls } = make((url) => (url === TOKEN_URL ? { status: 400, body: { error: 'invalid_grant' } } : { status: 200 }));
  const res = await relay.fetch(post(androidBody()), env());
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'token_exchange_failed', drop_token: false });
  assert.equal(calls.filter((c) => c.url === SEND_URL).length, 0);
});

test('android: the send is a single attempt (parity with the direct client); the token exchange may retry once', async () => {
  const { relay, calls } = make((url) => (url === TOKEN_URL ? tokenOk : 'throw'));
  const res = await relay.fetch(post(androidBody()), env());
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'ECONNRESET', drop_token: false });
  assert.equal(calls.filter((c) => c.url === SEND_URL).length, 1);

  let n = 0;
  const { relay: r2, calls: c2 } = make((url) => (url === TOKEN_URL ? (++n === 1 ? 'throw' : tokenOk) : { status: 200, body: {} }));
  assert.deepEqual(await (await r2.fetch(post(androidBody()), env())).json(), { ok: true });
  assert.equal(c2.filter((c) => c.url === TOKEN_URL).length, 2);
  assert.equal(c2.filter((c) => c.url === SEND_URL).length, 1);
});

test('budget: a slow first attempt leaves no room for the retry; the retry is skipped instead of overrunning the bridge', async () => {
  let t = 1_700_000_000_000;
  // The first attempt stalls for 19 s of the 20 s budget (a wedged connection), then rejects.
  const { relay, calls } = make(() => ((t += 19_000), 'throw'), { now: () => t });
  const res = await relay.fetch(post(iosBody()), env());
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'ECONNRESET', drop_token: false });
  assert.equal(calls.length, 1, 'no second attempt with < 1.5 s of the 20 s budget left');

  let t1 = 1_700_000_000_000;
  const { relay: r1, calls: c1 } = make(() => ((t1 += 10_000), 'throw'), { now: () => t1 });
  await r1.fetch(post(iosBody()), env());
  assert.equal(c1.length, 2, 'two full 10 s attempts fit the 20 s budget exactly');

  let t2 = 1_700_000_000_000;
  const { relay: r2, calls: c2 } = make(() => ((t2 += 5_000), 'throw'), { now: () => t2 });
  await r2.fetch(post(iosBody()), env());
  assert.equal(c2.length, 2, 'a quick failure leaves room for the retry');
});

test('budget: a cold FCM path (exchange + send) is bounded as one; an exhausted budget is deadline_exceeded', async () => {
  let t = 1_700_000_000_000;
  const { relay, calls } = make((url) => {
    t += 10_000; // exchange takes 10 s …
    return url === TOKEN_URL ? tokenOk : { status: 200, body: {} };
  }, { now: () => t });
  // … leaving 10 s for the send: still allowed.
  assert.deepEqual(await (await relay.fetch(post(androidBody()), env())).json(), { ok: true });
  assert.equal(calls.length, 2);

  let t3 = 1_700_000_000_000;
  const { relay: r3, calls: c3 } = make((url) => {
    t3 += 19_000;
    return url === TOKEN_URL ? tokenOk : { status: 200, body: {} };
  }, { now: () => t3 });
  const res = await r3.fetch(post(androidBody()), env());
  assert.deepEqual(await res.json(), { ok: false, status: 0, reason: 'deadline_exceeded', drop_token: false });
  assert.equal(c3.filter((c) => c.url === SEND_URL).length, 0, 'the send was never attempted');
});
