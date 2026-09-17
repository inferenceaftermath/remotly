import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { DeviceStore } from '../../src/auth/devices.ts';
import { defaultConfig } from '../../src/config.ts';
import { silentLogger } from '../../src/log.ts';
import { CONNECTIONS_CHECK_MS, HEADERS_TIMEOUT_MS, MAX_BODY_BYTES, MIN_UPLOAD_BYTES_PER_SEC, REQUEST_TIMEOUT_MS, applyTimeouts, createHandlers, parsePairBody, requestTimeoutFor, resolveListenHost, routeBudgetFor, serverOptions, type HttpHandlerDeps } from '../../src/server/http.ts';
import net from 'node:net';
import { PairingManager } from '../../src/server/pairing.ts';
import { UploadStore } from '../../src/server/uploads.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-http-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Harness {
  base: string;
  wsUrl: string;
  devices: DeviceStore;
  pairing: PairingManager;
  sockets: Array<{ ws: WebSocket; ip: string }>;
  clientCount(): number;
  close(): Promise<void>;
}

/** Plain http server driving the same handlers the https listener uses. */
async function start(overrides: Partial<HttpHandlerDeps> = {}): Promise<Harness> {
  const devices = new DeviceStore(path.join(dir, 'devices.json')).load();
  const pairing = new PairingManager();
  const sockets: Harness['sockets'] = [];
  const handlers = createHandlers({
    config: defaultConfig(),
    devices,
    pairing,
    gate: async () => true,
    onWebSocket: (ws, ip) => {
      sockets.push({ ws, ip });
      ws.on('message', (m) => ws.send(m));
    },
    log: silentLogger,
    herdrState: () => 'up',
    version: '0.1.0-test',
    hostName: 'testhost',
    ...overrides,
  });
  const server = http.createServer(handlers.onRequest);
  server.on('upgrade', handlers.onUpgrade);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    devices,
    pairing,
    sockets,
    clientCount: handlers.clientCount,
    close: () =>
      new Promise<void>((r) => {
        handlers.closeClients();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const post = (base: string, body: string | object, extra: RequestInit = {}) =>
  fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });

const device = { name: 'iPhone', platform: 'ios', app_version: '1.0' };

test('GET /health reports herdr state, version and protocol', async () => {
  let herdr: 'up' | 'down' = 'up';
  const h = await start({ herdrState: () => herdr });
  try {
    const r = await fetch(`${h.base}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(await r.json(), { ok: true, herdr: 'up', version: '0.1.0-test', protocol: 1 });
    herdr = 'down';
    assert.equal(((await (await fetch(`${h.base}/health`)).json()) as { herdr: string }).herdr, 'down');
  } finally {
    await h.close();
  }
});

test('unknown routes and methods are 404', async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`${h.base}/nope`)).status, 404);
    assert.equal((await fetch(`${h.base}/pair`)).status, 404, 'GET /pair');
    assert.equal((await fetch(`${h.base}/health`, { method: 'POST' })).status, 404);
    assert.deepEqual(await (await fetch(`${h.base}/`)).json(), { error: 'not_found' });
  } finally {
    await h.close();
  }
});

test('POST /pair with a live code issues a token that authenticates', async () => {
  const h = await start();
  try {
    const { code } = h.pairing.create();
    const r = await post(h.base, { code: code.toLowerCase(), device });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { token: string; device_id: string; host_name: string };
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.host_name, 'testhost');
    const dev = h.devices.authenticate(body.token);
    assert.equal(dev?.id, body.device_id);
    assert.equal(dev?.name, 'iPhone');
    assert.equal(dev?.platform, 'ios');
    assert.equal((await post(h.base, { code, device })).status, 403, 'code is single-use');
  } finally {
    await h.close();
  }
});

test('POST /pair: bad code 403, malformed 400, oversized 413, lockout 429', async () => {
  const h = await start();
  try {
    let r = await post(h.base, { code: 'AAAAAAAA', device });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'bad_code' });

    for (const bad of ['{not json', '[]', JSON.stringify({ code: 'X' }), JSON.stringify({ code: 'ABCDEFGH', device: { name: 'x', platform: 'windows' } }), JSON.stringify({ code: 'ABCDEFGH', device: { name: '', platform: 'ios' } })]) {
      r = await post(h.base, bad);
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: 'bad_request' });
    }

    r = await post(h.base, JSON.stringify({ code: 'ABCDEFGH', device: { ...device, name: 'x'.repeat(MAX_BODY_BYTES) } }));
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'too_large' });

    // three more failures (one bad_code above, malformed bodies do not count) → locked
    for (let i = 0; i < 3; i++) assert.equal((await post(h.base, { code: 'BBBBBBBB', device })).status, 403);
    r = await post(h.base, { code: 'BBBBBBBB', device });
    assert.equal(r.status, 429);
    const locked = (await r.json()) as { error: string; retry_after_ms: number };
    assert.equal(locked.error, 'locked_out');
    assert.ok(locked.retry_after_ms > 14 * 60_000);
    const live = h.pairing.create().code;
    assert.equal((await post(h.base, { code: live, device })).status, 429, 'valid code refused during lockout');
    assert.equal(h.devices.list().length, 0);
  } finally {
    await h.close();
  }
});

test('tailnet gate denies /pair before the code is checked', async () => {
  const seen: string[] = [];
  const h = await start({
    gate: async (ip) => {
      seen.push(ip);
      return false;
    },
  });
  try {
    const { code } = h.pairing.create();
    const r = await post(h.base, { code, device });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
    assert.deepEqual(seen, ['127.0.0.1']);
    assert.equal(h.pairing.outstanding(), 1, 'code not consumed');
    assert.equal((await fetch(`${h.base}/health`)).status, 200, 'health is not gated');
  } finally {
    await h.close();
  }
});

test('parsePairBody trims names and defaults app_version', () => {
  assert.deepEqual(parsePairBody({ code: 'ABCDEFGH', device: { name: '  Pixel 8 ', platform: 'android' } }), {
    code: 'ABCDEFGH',
    device: { name: 'Pixel 8', platform: 'android', app_version: '' },
  });
  assert.equal(parsePairBody({ code: 'ABCDEFGH', device: { name: 'x', platform: 'ios', app_version: 7 } }), null);
  assert.equal(parsePairBody(null), null);
});

/** `localAddress` picks another loopback address (127.0.0.0/8 is all loopback on Linux), so the bridge sees a second peer. */
const openWs = (url: string, localAddress?: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, localAddress ? { localAddress } : {});
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
const closed = (ws: WebSocket) =>
  new Promise<void>((r) => {
    ws.once('close', () => setTimeout(r, 20));
    ws.close();
  });

test('WebSocket upgrade at /ws hands the socket and remote ip to onWebSocket', async () => {
  const h = await start();
  try {
    const ws = await openWs(h.wsUrl);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0]?.ip, '127.0.0.1');
    assert.equal(h.clientCount(), 1);
    const echoed = await new Promise<string>((r) => {
      ws.once('message', (m) => r(m.toString()));
      ws.send('{"t":"hello"}');
    });
    assert.equal(echoed, '{"t":"hello"}');
    ws.close();
    await new Promise((r) => ws.once('close', r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.clientCount(), 0);
  } finally {
    await h.close();
  }
});

test('upgrade is refused on other paths and when the gate denies', async () => {
  const h = await start({ gate: async (ip) => ip !== '127.0.0.1' });
  try {
    await assert.rejects(openWs(h.wsUrl), (e: { status?: number }) => e.status === 403);
    assert.equal(h.sockets.length, 0);
  } finally {
    await h.close();
  }
  const open = await start();
  try {
    await assert.rejects(openWs(open.wsUrl.replace('/ws', '/other')), (e: { status?: number }) => e.status === 404);
  } finally {
    await open.close();
  }
});

test('idle sockets are terminated; pings keep them alive', async () => {
  const h = await start({ idleMs: 150 });
  try {
    const idle = await openWs(h.wsUrl);
    const t0 = Date.now();
    await new Promise((r) => idle.once('close', r));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 100 && elapsed < 1000, `closed after ${elapsed} ms`);

    const busy = await openWs(h.wsUrl);
    let closed = false;
    busy.once('close', () => (closed = true));
    const pinger = setInterval(() => busy.ping(), 50);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(pinger);
    assert.equal(closed, false, 'pinging client must stay connected');
    busy.terminate();
  } finally {
    await h.close();
  }
});

test('connection caps: a peer beyond its share gets 429, the bridge beyond its total 503; closing a socket frees the slot', async () => {
  const h = await start({ limits: { maxClientsPerIp: 2, maxClients: 3 } });
  try {
    const a1 = await openWs(h.wsUrl);
    const a2 = await openWs(h.wsUrl);
    await assert.rejects(openWs(h.wsUrl), (e: { status?: number }) => e.status === 429, 'third socket from one address');
    const b1 = await openWs(h.wsUrl, '127.0.0.2');
    assert.equal(h.clientCount(), 3);
    await assert.rejects(openWs(h.wsUrl, '127.0.0.3'), (e: { status?: number }) => e.status === 503, 'fourth socket overall, from a fresh address');
    await closed(a1);
    const a3 = await openWs(h.wsUrl);
    assert.equal(h.clientCount(), 3, 'the closed socket\'s slot is free again');
    await assert.rejects(openWs(h.wsUrl), (e: { status?: number }) => e.status === 429, 'a peer at its own share hears that first, even when the bridge is full');
    await assert.rejects(openWs(h.wsUrl, '127.0.0.3'), (e: { status?: number }) => e.status === 503, 'the bridge is full');
    for (const ws of [a2, b1, a3]) await closed(ws);
    assert.equal(h.clientCount(), 0);
    assert.equal((await openWs(h.wsUrl)).readyState, WebSocket.OPEN, 'every slot is free again');
  } finally {
    await h.close();
  }
});

test('a refused gate releases the reserved slot: repeated 403s never turn into 429', async () => {
  const h = await start({ limits: { maxClientsPerIp: 1 }, gate: async () => false });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(openWs(h.wsUrl), (e: { status?: number }) => e.status === 403);
  } finally {
    await h.close();
  }
});

test('pairing budget: attempts past the per-minute budget are 429 locked_out with retry_after_ms; the window renews; gated peers do not spend it', async () => {
  let t = 1_800_000_000_000;
  let allow = false;
  const h = await start({ limits: { pairPerMinute: 2 }, now: () => t, gate: async () => allow });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(h.base, { code: 'ABCDEFGH', device })).status, 403, 'off-tailnet: forbidden, not counted');
    allow = true;
    assert.deepEqual(await (await post(h.base, { code: 'ABCDEFGH', device })).json(), { error: 'bad_code' });
    assert.deepEqual(await (await post(h.base, { code: 'ABCDEFGH', device })).json(), { error: 'bad_code' });
    t += 10_000;
    const r = await post(h.base, { code: 'ABCDEFGH', device });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'locked_out', retry_after_ms: 50_000 }, 'the phones show "try again in a minute"');
    t += 50_000;
    const { code } = h.pairing.create();
    assert.equal((await post(h.base, { code, device })).status, 200, 'a new window, and a right code pairs');
  } finally {
    await h.close();
  }
});

test('applyTimeouts: headers within 15 s; the request deadline grows with the upload limit so a slow photo still gets through', () => {
  const s = http.createServer();
  applyTimeouts(s, MAX_BODY_BYTES);
  assert.equal(s.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.equal(s.requestTimeout, REQUEST_TIMEOUT_MS, 'small bodies: the floor');
  applyTimeouts(s, 20 * 1024 * 1024);
  assert.equal(s.requestTimeout, requestTimeoutFor(20 * 1024 * 1024));
  const secondsFor20MiB = Math.ceil((20 * 1024 * 1024) / MIN_UPLOAD_BYTES_PER_SEC);
  assert.equal(s.requestTimeout, secondsFor20MiB * 1000 + HEADERS_TIMEOUT_MS + CONNECTIONS_CHECK_MS, '20 MiB at 32 KiB/s plus the header allowance');
  assert.ok(requestTimeoutFor(200 * 1024 * 1024) > requestTimeoutFor(20 * 1024 * 1024), 'uploads.max_mb 200 → a longer deadline');
  assert.ok(HEADERS_TIMEOUT_MS < REQUEST_TIMEOUT_MS);
  // The route budgets add up to the documented whole-request ceilings.
  assert.equal(routeBudgetFor(REQUEST_TIMEOUT_MS) + HEADERS_TIMEOUT_MS + CONNECTIONS_CHECK_MS, REQUEST_TIMEOUT_MS, '/pair: 120 s from the first header byte');
  assert.equal(routeBudgetFor(requestTimeoutFor(20 * 1024 * 1024)), secondsFor20MiB * 1000, 'an upload gets exactly its bytes at 32 KiB/s after the headers');
  assert.equal(routeBudgetFor(requestTimeoutFor(MAX_BODY_BYTES)), routeBudgetFor(REQUEST_TIMEOUT_MS), 'small ceilings: the same floor as /pair');
  assert.ok(routeBudgetFor(REQUEST_TIMEOUT_MS) >= 100_000, 'the header allowance is a small part of the ceiling');
  // The listener sweeps expired requests often enough for the 15 s header ceiling to mean 15 s, not 15–45 s.
  const o = serverOptions({ key: Buffer.from('k'), cert: Buffer.from('c') });
  assert.equal(o.connectionsCheckingInterval, CONNECTIONS_CHECK_MS);
  assert.ok(CONNECTIONS_CHECK_MS * 10 <= HEADERS_TIMEOUT_MS);
  assert.equal(o.minVersion, 'TLSv1.2');
  s.close();
});

/** Opens a raw connection, sends half of a request head and never finishes it; resolves when the server closes the
 *  connection (with the status line it sent) or with `null` if it is still open after `capMs`. */
function halfHeaders(port: number, capMs: number): Promise<{ closedAfter: number; first: string } | null> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let got = '';
    const sock = net.connect(port, '127.0.0.1', () => sock.write('POST /pair HTTP/1.1\r\nHost: x\r\n'));
    // Read what the server sends: a socket nobody reads never reaches end-of-stream, so it would never report close.
    sock.on('data', (d: Buffer) => (got += d.toString()));
    sock.on('error', reject);
    const cap = setTimeout(() => {
      sock.removeAllListeners('close');
      sock.destroy();
      resolve(null);
    }, capMs);
    sock.on('close', () => {
      clearTimeout(cap);
      resolve({ closedAfter: Date.now() - t0, first: got.split('\r\n')[0] ?? '' });
    });
  });
}

test('half-sent headers are cut at headersTimeout plus one sweep — the sweep interval is what makes the ceiling bite (Node\'s default is 30 s)', async () => {
  const listen = async (s: http.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as { port: number }).port;
  };
  // Our configuration: a short sweep, so a 200 ms headersTimeout ends the connection at about 200 ms plus one sweep.
  const ours = http.createServer({ connectionsCheckingInterval: 50 }, () => assert.fail('no request should complete'));
  ours.headersTimeout = 200;
  // Control: the same headersTimeout with Node's default sweep (30 s) leaves the half-sent request hanging well past it.
  const control = http.createServer(() => assert.fail('no request should complete'));
  control.headersTimeout = 200;
  try {
    const [cut, kept] = await Promise.all([halfHeaders(await listen(ours), 3000), halfHeaders(await listen(control), 800)]);
    assert.ok(cut, 'our server closed the half-sent request');
    assert.equal(cut.first, 'HTTP/1.1 408 Request Timeout');
    assert.ok(cut.closedAfter >= 150 && cut.closedAfter < 700, `closed ${cut.closedAfter} ms after connecting: headersTimeout 200 + a 50 ms sweep, not 30 s`);
    assert.equal(kept, null, 'with the default sweep the same request is still open 800 ms later');
  } finally {
    await Promise.all([ours, control].map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
});

/** A request whose body arrives in `chunks` with `gapMs` between them; resolves with the status and whether the server closed the connection. */
function trickle(base: string, headers: Record<string, string>, chunks: Buffer[], gapMs: number, hangAfter: boolean, route = '/upload'): Promise<{ status: number; body: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${route}`);
    const total = chunks.reduce((n, c) => n + c.length, 0) + (hangAfter ? 1 : 0);
    const req = http.request({ host: url.hostname, port: url.port, path: route, method: 'POST', headers: { ...headers, 'content-length': String(total) } });
    req.on('error', reject);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      let closed = false;
      req.socket?.once('close', () => (closed = true));
      res.on('end', () => setTimeout(() => resolve({ status: res.statusCode ?? 0, body, closed }), 50));
    });
    let i = 0;
    const next = () => {
      if (i < chunks.length) {
        req.write(chunks[i++]);
        setTimeout(next, gapMs);
      } else if (!hangAfter) req.end();
      // hangAfter: one byte still owed, never sent — the server has to give up on its own
    };
    next();
  });
}

test('/pair keeps its own 120 s-class deadline even when the upload ceiling stretches the server deadline: a steady trickle past it gets 408, an upload of the same pace is served', async () => {
  // A 200 MiB ceiling gives the server a requestTimeout of about 1.8 h; /pair must not inherit that.
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 200 * 1024 * 1024 });
  const h = await start({ uploads, bodyStallMs: 400, bodyMaxMs: { pair: 300 } });
  try {
    const json = Buffer.from(JSON.stringify({ code: 'ABCDEFGH', device: { name: 'phone', platform: 'ios', app_version: '1.0' } }));
    const chunks = Array.from({ length: 6 }, (_, i) => json.subarray(Math.floor((i * json.length) / 6), Math.floor(((i + 1) * json.length) / 6)));
    const t0 = Date.now();
    // 6 chunks 100 ms apart: every gap under the 400 ms stall window, the whole body 500 ms — past the 300 ms deadline.
    const slowPair = await trickle(h.base, { 'content-type': 'application/json' }, chunks, 100, false, '/pair');
    assert.equal(slowPair.status, 408, slowPair.body);
    assert.deepEqual(JSON.parse(slowPair.body), { error: 'timeout' });
    assert.equal(slowPair.closed, true);
    assert.ok(Date.now() - t0 < 1500, 'cut at the pair deadline, not at the stall or the server deadline');
    // The same body in one go is judged on its content (a code nobody created), not on time.
    const quickPair = await trickle(h.base, { 'content-type': 'application/json' }, [json], 0, false, '/pair');
    assert.equal(quickPair.status, 403, `unknown code → bad_code, got ${quickPair.status} ${quickPair.body}`);
    // An upload at the same pace, longer than the pair deadline, still gets through: its deadline is the upload-sized one.
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const upload = await trickle(h.base, { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` }, Array.from({ length: 6 }, () => Buffer.alloc(100, 3)), 100, false);
    assert.equal(upload.status, 200, upload.body);
  } finally {
    await h.close();
  }
});

test('the route budget runs from the request\'s arrival: a slow tailnet gate decision comes out of it, for /pair and /upload alike', async () => {
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 64 * 1024 });
  const gateMs = 200;
  const h = await start({ uploads, bodyStallMs: 1000, bodyMaxMs: { pair: 300, upload: 300 }, gate: () => new Promise((r) => setTimeout(() => r(true), gateMs)) });
  try {
    const json = Buffer.from(JSON.stringify({ code: 'ABCDEFGH', device: { name: 'phone', platform: 'ios', app_version: '1.0' } }));
    const halves = [json.subarray(0, 10), json.subarray(10)];
    // The first half is on the wire at once, the second 400 ms after it: the body is complete 400 ms after arrival (the
    // content-length is met, the client's end() is not needed). Counted from arrival the 300 ms budget is over by then,
    // so 408 at about 300 ms; counted from the gate's answer (200 ms) it would not be, and the body would be judged on
    // its content (403 bad_code).
    let t0 = Date.now();
    const pair = await trickle(h.base, { 'content-type': 'application/json' }, halves, 400, false, '/pair');
    assert.equal(pair.status, 408, pair.body);
    assert.ok(Date.now() - t0 < gateMs + 300 + 100, `cut about 300 ms after arrival, not 300 ms after the gate: ${Date.now() - t0} ms`);
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const auth = { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` };
    t0 = Date.now();
    const upload = await trickle(h.base, auth, [Buffer.alloc(100, 1), Buffer.alloc(100, 2)], 400, false);
    assert.equal(upload.status, 408, upload.body);
    assert.ok(Date.now() - t0 < gateMs + 300 + 100, `upload cut on the same clock: ${Date.now() - t0} ms`);
    // Within the budget even with the gate's 200 ms counted: served.
    const quick = await trickle(h.base, auth, [Buffer.alloc(100, 1), Buffer.alloc(100, 2)], 20, false);
    assert.equal(quick.status, 200, quick.body);
  } finally {
    await h.close();
  }
});

test('silence is counted from the request: a byte sent before a slow gate and nothing after it is cut 30 s-class after arrival, not after the gate', async () => {
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 64 * 1024 });
  const gateMs = 200;
  const stallMs = 400;
  const h = await start({ uploads, bodyStallMs: stallMs, bodyMaxMs: { pair: 5000, upload: 5000 }, gate: () => new Promise((r) => setTimeout(() => r(true), gateMs)) });
  try {
    // /pair: ten bytes on the wire at once, then silence. Counted from arrival the 400 ms stall window ends at 400 ms;
    // a window armed when the reader attaches (after the gate) would have ended at 600 ms.
    let t0 = Date.now();
    const pair = await trickle(h.base, { 'content-type': 'application/json' }, [Buffer.from('{"code":"AB')], 0, true, '/pair');
    assert.equal(pair.status, 408, pair.body);
    let took = Date.now() - t0;
    assert.ok(took < gateMs + stallMs - 50, `cut about ${stallMs} ms after arrival: ${took} ms`);
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const auth = { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` };
    t0 = Date.now();
    const upload = await trickle(h.base, auth, [Buffer.alloc(100, 1)], 0, true);
    assert.equal(upload.status, 408, upload.body);
    took = Date.now() - t0;
    assert.ok(took < gateMs + stallMs - 50, `upload cut on the same clock: ${took} ms`);
    // A peer that keeps sending is fine: the chunks sent during the gate (0, 100, 200 ms) are delivered together when the
    // reader attaches and keep the shortened first window (ends at 400 ms); the one at 300 ms arrives live and renews it.
    const steady = await trickle(h.base, auth, Array.from({ length: 5 }, () => Buffer.alloc(100, 2)), 100, false);
    assert.equal(steady.status, 200, steady.body);
  } finally {
    await h.close();
  }
});

test('a budget the gate alone used up ends in 408 even when the whole body is already buffered', async () => {
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 64 * 1024 });
  const h = await start({ uploads, bodyMaxMs: { pair: 50, upload: 50 }, gate: () => new Promise((r) => setTimeout(() => r(true), 120)) });
  try {
    const json = Buffer.from(JSON.stringify({ code: 'ABCDEFGH', device: { name: 'phone', platform: 'ios', app_version: '1.0' } }));
    const pair = await trickle(h.base, { 'content-type': 'application/json' }, [json], 0, false, '/pair');
    assert.equal(pair.status, 408, `not judged on its content (403 bad_code): ${pair.status} ${pair.body}`);
    assert.deepEqual(JSON.parse(pair.body), { error: 'timeout' });
    assert.equal(pair.closed, true);
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const upload = await trickle(h.base, { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` }, [Buffer.alloc(300, 1)], 0, false);
    assert.equal(upload.status, 408, `not stored: ${upload.status} ${upload.body}`);
    assert.equal(upload.closed, true);
  } finally {
    await h.close();
  }
});

test('a request body that goes silent is dropped with 408 and the connection closed; a slow but steady one is served', async () => {
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 64 * 1024 });
  const h = await start({ uploads, bodyStallMs: 150 });
  try {
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const headers = { 'content-type': 'image/jpeg', authorization: `Bearer ${token}` };
    const t0 = Date.now();
    const stalled = await trickle(h.base, headers, [Buffer.alloc(1000, 1)], 0, true);
    assert.equal(stalled.status, 408);
    assert.deepEqual(JSON.parse(stalled.body), { error: 'timeout' });
    assert.equal(stalled.closed, true, 'the half-sent body cannot be reused: the server closes the connection');
    assert.ok(Date.now() - t0 < 2000, 'gave up on the stall, not on a request deadline');
    // Five chunks 60 ms apart: 300 ms in total, longer than the 150 ms stall window, and every gap shorter than it.
    const steady = await trickle(h.base, headers, Array.from({ length: 5 }, () => Buffer.alloc(200, 2)), 60, false);
    assert.equal(steady.status, 200, steady.body);
    assert.equal((JSON.parse(steady.body) as { bytes: number }).bytes, 1000);
  } finally {
    await h.close();
  }
});

test('resolveListenHost: explicit host wins; auto → tailscale ip or 0.0.0.0', async () => {
  const cfg = defaultConfig();
  cfg.listen.host = '127.0.0.1';
  assert.equal(await resolveListenHost(cfg, async () => ({ code: 0, stdout: '100.101.102.103\n', stderr: '' })), '127.0.0.1');
  cfg.listen.host = 'auto';
  assert.equal(await resolveListenHost(cfg, async () => ({ code: 0, stdout: '100.101.102.103\n', stderr: '' })), '100.101.102.103');
  assert.equal(await resolveListenHost(cfg, async () => ({ code: null, stdout: '', stderr: 'ENOENT' })), '0.0.0.0');
  assert.equal(await resolveListenHost(cfg, async () => ({ code: 0, stdout: 'garbage', stderr: '' })), '0.0.0.0');
  // Tailscale was up at start-up: no address now is an error, not a silent switch to every interface
  await assert.rejects(resolveListenHost(cfg, async () => ({ code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' }), { tailscaleUp: true }), /Tailscale was up at start-up.*not falling back to every interface/);
  assert.equal(await resolveListenHost(cfg, async () => ({ code: 0, stdout: '100.101.102.103\n', stderr: '' }), { tailscaleUp: true }), '100.101.102.103');
  cfg.listen.host = '0.0.0.0';
  assert.equal(await resolveListenHost(cfg, async () => ({ code: 1, stdout: '', stderr: '' }), { tailscaleUp: true }), '0.0.0.0', 'an explicit host is never questioned');
});

const uploadTo = (base: string, body: Buffer, headers: Record<string, string>) => fetch(`${base}/upload`, { method: 'POST', headers, body });

test('POST /upload stores a paired device\'s photo and answers with its path; bad token, type and size are refused', async () => {
  const uploads = new UploadStore({ dir: path.join(dir, 'uploads'), keepDays: 7, maxBytes: 64 * 1024 });
  const h = await start({ uploads });
  try {
    const { token } = h.devices.issueToken({ name: 'iPhone', platform: 'ios' });
    const auth = `Bearer ${token}`;
    const bytes = Buffer.alloc(1000, 7);
    const r = await uploadTo(h.base, bytes, { 'content-type': 'image/jpeg', authorization: auth });
    assert.equal(r.status, 200);
    const saved = (await r.json()) as { path: string; bytes: number };
    assert.equal(saved.bytes, 1000);
    assert.ok(saved.path.startsWith(path.join(dir, 'uploads') + path.sep), saved.path);
    assert.match(saved.path, /\.jpg$/);
    assert.deepEqual(fs.readFileSync(saved.path), bytes);
    const png = await uploadTo(h.base, Buffer.from([0x89, 0x50]), { 'content-type': 'image/png; charset=binary', authorization: auth });
    assert.equal(png.status, 200);
    assert.match(((await png.json()) as { path: string }).path, /\.png$/);

    assert.equal((await uploadTo(h.base, bytes, { 'content-type': 'image/jpeg', authorization: 'Bearer nope' })).status, 401);
    assert.equal((await uploadTo(h.base, bytes, { 'content-type': 'image/jpeg' })).status, 401);
    assert.equal((await uploadTo(h.base, bytes, { 'content-type': 'text/plain', authorization: auth })).status, 415);
    const big = await uploadTo(h.base, Buffer.alloc(70 * 1024), { 'content-type': 'image/jpeg', authorization: auth });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: 'too_large', max_bytes: 64 * 1024 });
    assert.equal((await uploadTo(h.base, Buffer.alloc(0), { 'content-type': 'image/jpeg', authorization: auth })).status, 400);
    assert.equal(fs.readdirSync(path.dirname(saved.path)).length, 2, 'only the two accepted files were written');
  } finally {
    await h.close();
  }
});

test('POST /upload is 404 without an upload store and 403 for a peer off the tailnet', async () => {
  const none = await start();
  try {
    assert.equal((await uploadTo(none.base, Buffer.alloc(1), { 'content-type': 'image/jpeg' })).status, 404);
  } finally {
    await none.close();
  }
  const gated = await start({ uploads: new UploadStore({ dir: path.join(dir, 'u'), keepDays: 7, maxBytes: 1024 }), gate: async () => false });
  try {
    const r = await uploadTo(gated.base, Buffer.alloc(1), { 'content-type': 'image/jpeg', authorization: 'Bearer x' });
    assert.equal(r.status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'u')), false);
  } finally {
    await gated.close();
  }
});
