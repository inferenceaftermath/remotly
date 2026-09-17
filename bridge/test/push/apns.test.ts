import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type http2 from 'node:http2';
import { test } from 'node:test';
import { createLogger, type LogFields } from '../../src/log.ts';
import { ApnsClient, buildApnsJwt } from '../../src/push/apns.ts';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const decode = (seg: string): unknown => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

function capture() {
  const lines: LogFields[] = [];
  return { lines, log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) }) };
}

interface Sent {
  headers: http2.OutgoingHttpHeaders;
  body: string;
}
interface Reply {
  status: number;
  body?: string;
  /** Never answer (timeout test). */
  hang?: boolean;
}

/** Fake ClientHttp2Session: records requests, answers from a queue on the next tick. */
function fakeSession(replies: Reply[] = []) {
  const sent: Sent[] = [];
  const em = new EventEmitter();
  const s = Object.assign(em, {
    closed: false,
    destroyed: false,
    close() {
      s.closed = true;
      em.emit('close');
    },
    destroy() {
      s.destroyed = true;
      em.emit('close');
    },
    request(headers: http2.OutgoingHttpHeaders) {
      const stream = new EventEmitter();
      const rec: Sent = { headers, body: '' };
      return Object.assign(stream, {
        close() {},
        end(chunk?: string | Buffer) {
          if (chunk) rec.body += chunk.toString();
          sent.push(rec);
          const reply = replies.shift() ?? { status: 200 };
          if (reply.hang) return;
          setImmediate(() => {
            stream.emit('response', { ':status': reply.status });
            if (reply.body) stream.emit('data', Buffer.from(reply.body));
            stream.emit('end');
          });
        },
      });
    },
  });
  return { session: s as unknown as http2.ClientHttp2Session, sent, raw: s };
}

function client(replies: Reply[], opts: { now?: () => number; timeout?: number } = {}) {
  const { log, lines } = capture();
  const authorities: string[] = [];
  let current = fakeSession(replies);
  const sessions = [current];
  const c = new ApnsClient({
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    p8,
    bundleId: 'com.example.flow',
    log,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.timeout !== undefined ? { requestTimeoutMs: opts.timeout } : {}),
    connect: (authority) => {
      authorities.push(authority);
      if (authorities.length > 1) {
        current = fakeSession(replies);
        sessions.push(current);
      }
      return current.session;
    },
  });
  return { c, lines, authorities, sessions, sent: () => sessions.flatMap((x) => x.sent) };
}

test('buildApnsJwt: ES256 header, {iss, iat} claims, ieee-p1363 signature verifies', () => {
  const jwt = buildApnsJwt({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: p8, iat: 1_700_000_000 });
  const [h, c, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.deepEqual(decode(c), { iss: 'TEAM123456', iat: 1_700_000_000 });
  const sig = Buffer.from(s, 'base64url');
  assert.equal(sig.length, 64, 'r||s, not DER');
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), true);
  // KeyObject and Buffer inputs are accepted too
  assert.equal(buildApnsJwt({ teamId: 'T', keyId: 'K', key: privateKey, iat: 1 }).split('.').length, 3);
  assert.equal(buildApnsJwt({ teamId: 'T', keyId: 'K', key: Buffer.from(p8), iat: 1 }).split('.').length, 3);
});

test('send: exact headers, path, body and host per env', async () => {
  const t0 = 1_800_000_000_000;
  const { c, authorities, sent } = client([{ status: 200 }, { status: 200 }], { now: () => t0 });
  const payload = { aps: { alert: { title: 'x' } } };
  assert.deepEqual(await c.send({ token: 'abc123', env: 'production', collapseId: 'w1:p1', payload }), { ok: true });
  assert.deepEqual(authorities, ['https://api.push.apple.com']);
  const [req] = sent();
  assert.ok(req);
  assert.equal(req.body, JSON.stringify(payload));
  const auth = req.headers['authorization'];
  assert.match(String(auth), /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const claims = decode(String(auth).split('.')[1]!) as { iss: string; iat: number };
  assert.deepEqual(claims, { iss: 'TEAM123456', iat: t0 / 1000 });
  assert.deepEqual(
    { ...req.headers, authorization: undefined },
    {
      ':method': 'POST',
      ':path': '/3/device/abc123',
      authorization: undefined,
      'apns-topic': 'com.example.flow',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(t0 / 1000 + 600),
      'apns-collapse-id': 'w1:p1',
      'content-type': 'application/json',
    },
  );
  await c.send({ token: 'def', env: 'sandbox', collapseId: 'w1:p2', payload });
  assert.deepEqual(authorities, ['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']);
  c.close();
});

test('JWT is cached for 50 minutes, then re-issued', async () => {
  let t = 1_800_000_000_000;
  const { c, sent } = client([{ status: 200 }, { status: 200 }, { status: 200 }], { now: () => t });
  const send = () => c.send({ token: 'a', env: 'production', collapseId: 'p', payload: {} });
  await send();
  t += 49 * 60_000;
  await send();
  t += 60_000; // 50 min since issue
  await send();
  const iats = sent().map((r) => (decode(String(r.headers['authorization']).split('.')[1]!) as { iat: number }).iat);
  assert.equal(iats[0], iats[1], 'reused within 50 min');
  assert.equal(iats[2], t / 1000, 'fresh JWT at 50 min');
});

test('one session per host, recreated after it closes', async () => {
  const { c, authorities, sessions } = client([{ status: 200 }, { status: 200 }, { status: 200 }]);
  const send = () => c.send({ token: 'a', env: 'production', collapseId: 'p', payload: {} });
  await send();
  await send();
  assert.equal(authorities.length, 1);
  sessions[0]!.raw.close();
  await send();
  assert.equal(authorities.length, 2);
  assert.equal(sessions[1]!.sent.length, 1);
});

test('410 Unregistered and 400 BadDeviceToken drop the token; other errors do not', async () => {
  const { c, lines } = client([
    { status: 410, body: '{"reason":"Unregistered","timestamp":1700000000000}' },
    { status: 400, body: '{"reason":"BadDeviceToken"}' },
    { status: 429, body: '{"reason":"TooManyRequests"}' },
    { status: 500, body: 'not json' },
  ]);
  const send = () => c.send({ token: 'a', env: 'production', collapseId: 'p', payload: {} });
  assert.deepEqual(await send(), { ok: false, status: 410, reason: 'Unregistered', dropToken: true });
  assert.deepEqual(await send(), { ok: false, status: 400, reason: 'BadDeviceToken', dropToken: true });
  assert.deepEqual(await send(), { ok: false, status: 429, reason: 'TooManyRequests', dropToken: false });
  assert.deepEqual(await send(), { ok: false, status: 500, reason: 'HTTP_500', dropToken: false });
  assert.equal(lines.some((l) => l['event'] === 'apns.config_error'), false);
  assert.equal(JSON.stringify(lines).includes('"a"'), false, 'token never logged');
});

test('403 InvalidProviderToken logs apns.config_error and invalidates the JWT cache', async () => {
  let t = 1_800_000_000_000;
  const { c, lines, sent } = client([{ status: 403, body: '{"reason":"InvalidProviderToken"}' }, { status: 200 }], { now: () => t });
  const send = () => c.send({ token: 'a', env: 'production', collapseId: 'p', payload: {} });
  assert.deepEqual(await send(), { ok: false, status: 403, reason: 'InvalidProviderToken', dropToken: false });
  const err = lines.find((l) => l['event'] === 'apns.config_error');
  assert.ok(err);
  assert.equal(err['level'], 'error');
  assert.equal(err['reason'], 'InvalidProviderToken');
  t += 1000; // well inside the 50 min window: only a cache invalidation explains a new iat
  await send();
  const iats = sent().map((r) => (decode(String(r.headers['authorization']).split('.')[1]!) as { iat: number }).iat);
  assert.notEqual(iats[0], iats[1]);
  assert.equal(iats[1], t / 1000);
});

test('a hung request is retried once on a fresh session (the old one is destroyed)', async () => {
  const { c, lines, authorities, sessions } = client([{ status: 200, hang: true }], { timeout: 20 });
  const r = await c.send({ token: 'abc', env: 'production', collapseId: 'x', payload: { aps: {} } });
  assert.deepEqual(r, { ok: true });
  assert.equal(authorities.length, 2, 'second attempt connected anew');
  assert.equal(sessions[0]!.raw.destroyed, true, 'the dead session is destroyed');
  assert.equal(sessions[1]!.raw.destroyed, false);
  const warn = lines.filter((l) => l['event'] === 'apns.transport_error');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!['retry'], true);
});

test('two transport failures in a row yield a transport failure without dropping the token', async () => {
  const { c, lines, authorities, sessions } = client([{ status: 200, hang: true }, { status: 200, hang: true }], { timeout: 20 });
  const r = await c.send({ token: 'abc', env: 'production', collapseId: 'x', payload: { aps: {} } });
  assert.deepEqual(r, { ok: false, status: 0, reason: 'timeout', dropToken: false });
  assert.equal(authorities.length, 2);
  assert.ok(sessions.every((x) => x.raw.destroyed));
  assert.deepEqual(lines.filter((l) => l['event'] === 'apns.transport_error').map((l) => l['retry']), [true, false]);
  assert.equal(c.send.length, 1);
});
