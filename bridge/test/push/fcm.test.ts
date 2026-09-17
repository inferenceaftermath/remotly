import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createLogger, type LogFields } from '../../src/log.ts';
import { FcmClient, buildServiceAccountJwt } from '../../src/push/fcm.ts';
import { buildFcmData, buildFcmMessage, type ApprovalNotice } from '../../src/push/payloads.ts';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'flow@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
const decode = (seg: string): unknown => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://fcm.googleapis.com/v1/projects/proj/messages:send';

const notice: ApprovalNotice = {
  host: 'h',
  pane: 'w1:p1',
  promptId: 'w1:p1@4212',
  agent: 'codex',
  displayAgent: 'Codex',
  subtitle: 'title',
  body: 'body',
};

interface Call {
  url: string;
  init: RequestInit;
}
type Handler = (url: string, init: RequestInit) => { status: number; body: unknown } | Promise<never>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = await handler(url, init ?? {});
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tokenOk = (expires_in = 3600) => ({ status: 200, body: { access_token: 'ya29.token', expires_in, token_type: 'Bearer' } });

function make(handler: Handler, now?: () => number) {
  const lines: LogFields[] = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) });
  const { fetchImpl, calls } = fakeFetch(handler);
  const c = new FcmClient({ projectId: 'proj', serviceAccount: sa, log, fetchImpl, ...(now ? { now } : {}) });
  return { c, calls, lines };
}

const sendInput = (token = 'fcm-tok') => ({ token, collapseKey: notice.pane, ttlSec: 600, data: buildFcmData(notice) });

test('buildServiceAccountJwt: RS256 header, exact claims, signature verifies', () => {
  const jwt = buildServiceAccountJwt(sa, 1_700_000_000);
  const [h, c, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(c), {
    iss: 'flow@proj.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), true);
  const custom = decode(buildServiceAccountJwt({ ...sa, token_uri: 'https://example.test/token' }, 1).split('.')[1]!) as { aud: string };
  assert.equal(custom.aud, 'https://example.test/token');
});

test('token exchange is a form POST, then send body equals buildFcmMessage byte-for-byte', async () => {
  const t0 = 1_800_000_000_000;
  const { c, calls } = make((url) => (url === TOKEN_URL ? tokenOk() : { status: 200, body: { name: 'projects/proj/messages/1' } }), () => t0);
  assert.deepEqual(await c.send(sendInput()), { ok: true });
  assert.equal(calls.length, 2);
  const [ex, send] = calls as [Call, Call];
  assert.equal(ex.url, TOKEN_URL);
  assert.equal(ex.init.method, 'POST');
  assert.equal((ex.init.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(ex.init.body));
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = decode(form.get('assertion')!.split('.')[1]!) as { iss: string; iat: number };
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.iat, t0 / 1000);
  assert.equal(send.url, SEND_URL);
  assert.equal(send.init.method, 'POST');
  assert.deepEqual(send.init.headers, { authorization: 'Bearer ya29.token', 'content-type': 'application/json' });
  assert.equal(send.init.body, JSON.stringify(buildFcmMessage('fcm-tok', notice, 600)));
});

test('access token cached 55 min (or expires_in - 300 s when smaller)', async () => {
  let t = 1_800_000_000_000;
  let expiresIn = 3600;
  const { c, calls } = make((url) => (url === TOKEN_URL ? tokenOk(expiresIn) : { status: 200, body: {} }), () => t);
  const exchanges = () => calls.filter((x) => x.url === TOKEN_URL).length;
  await c.send(sendInput());
  t += 54 * 60_000;
  await c.send(sendInput());
  assert.equal(exchanges(), 1);
  t += 60_000;
  expiresIn = 900; // → cached for 600 s
  await c.send(sendInput());
  assert.equal(exchanges(), 2);
  t += 599_000;
  await c.send(sendInput());
  assert.equal(exchanges(), 2);
  t += 1000;
  await c.send(sendInput());
  assert.equal(exchanges(), 3);
  c.close();
});

test('concurrent sends share one token exchange', async () => {
  const { c, calls } = make((url) => (url === TOKEN_URL ? tokenOk() : { status: 200, body: {} }));
  await Promise.all([c.send(sendInput('a')), c.send(sendInput('b')), c.send(sendInput('c'))]);
  assert.equal(calls.filter((x) => x.url === TOKEN_URL).length, 1);
  assert.equal(calls.filter((x) => x.url === SEND_URL).length, 3);
});

test('dropToken: 404 UNREGISTERED / NOT_FOUND and 400 INVALID_ARGUMENT about the registration token', async () => {
  const replies: { status: number; body: unknown }[] = [
    {
      status: 404,
      body: {
        error: {
          code: 404,
          message: 'Requested entity was not found.',
          status: 'NOT_FOUND',
          details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
        },
      },
    },
    { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } },
    { status: 400, body: { error: { code: 400, message: 'The registration token is not a valid FCM registration token', status: 'INVALID_ARGUMENT' } } },
    { status: 400, body: { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } } },
    { status: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } } },
    { status: 503, body: 'upstream down' },
  ];
  const { c, lines } = make((url) => (url === TOKEN_URL ? tokenOk() : replies.shift()!));
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 404, reason: 'UNREGISTERED', dropToken: true });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 404, reason: 'NOT_FOUND', dropToken: true });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 400, reason: 'INVALID_ARGUMENT', dropToken: true });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 400, reason: 'INVALID_ARGUMENT', dropToken: false });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 429, reason: 'QUOTA_EXCEEDED', dropToken: false });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 503, reason: 'HTTP_503', dropToken: false });
  assert.equal(lines.some((l) => l['event'] === 'fcm.config_error'), false);
});

test('401/403 log fcm.config_error and force a fresh token exchange', async () => {
  let sends = 0;
  const { c, calls, lines } = make((url) => {
    if (url === TOKEN_URL) return tokenOk();
    sends++;
    return sends === 1 ? { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } } : { status: 200, body: {} };
  });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 401, reason: 'UNAUTHENTICATED', dropToken: false });
  const err = lines.find((l) => l['event'] === 'fcm.config_error');
  assert.ok(err);
  assert.equal(err['level'], 'error');
  assert.deepEqual(await c.send(sendInput()), { ok: true });
  assert.equal(calls.filter((x) => x.url === TOKEN_URL).length, 2, 'cache invalidated');
});

test('token exchange rejection (4xx) is a config error; nothing is sent', async () => {
  const { c, calls, lines } = make(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }));
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 0, reason: 'token_exchange_failed', dropToken: false });
  assert.equal(calls.length, 1);
  assert.ok(lines.some((l) => l['event'] === 'fcm.config_error' && l['stage'] === 'token_exchange'));
});

test('network failure on send is a transport error and keeps the token', async () => {
  const { c, lines } = make((url) => {
    if (url === TOKEN_URL) return tokenOk();
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }));
  });
  assert.deepEqual(await c.send(sendInput()), { ok: false, status: 0, reason: 'ECONNRESET', dropToken: false });
  assert.ok(lines.some((l) => l['event'] === 'fcm.transport_error'));
  assert.equal(JSON.stringify(lines).includes('fcm-tok'), false, 'token never logged');
});
