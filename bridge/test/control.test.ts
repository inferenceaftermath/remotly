import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ControlError, controlRequest, dispatch, startControlServer, type ControlHandlers, type ControlStatus, type PairInfo } from '../src/control.ts';

let dir: string;
let sock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ctl-'));
  sock = path.join(dir, 'remotly.sock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const status: ControlStatus = {
  herdr: 'up',
  listen: { host: '100.101.102.103', port: 7460 },
  tls: { mode: 'selfsigned', not_after: '2036-01-01T00:00:00.000Z', fingerprint: 'abc' },
  devices: 1,
  push: { apns: false, fcm: false, mode: { apns: 'off', fcm: 'off' } },
  clients: 0,
};

function handlers(): ControlHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pair(ttl, reusable) {
      calls.push(`pair:${ttl}${reusable ? ':reusable' : ''}`);
      const info: PairInfo = { code: 'ABCDEFGH', expires_at: 'x', url: 'wss://h:7460', fingerprint: 'abc', host_name: 'h', qr_payload: 'remotly://pair?u=…' };
      return info;
    },
    devices: () => [{ id: 'd1', name: 'iPhone', platform: 'ios', created_at: 'c', last_seen: null, push: false }],
    revoke: (id) => id === 'd1',
    status: async () => status,
    pushTest: async (id) => {
      if (id === 'boom') throw new Error('apns 403 InvalidProviderToken');
      return { sent: true, id };
    },
  };
}

test('server socket is mode 0600 and answers every command', async () => {
  const h = handlers();
  const server = await startControlServer(h, { socketPath: sock });
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    const pair = await controlRequest<PairInfo>({ cmd: 'pair', ttl: 120 }, { socketPath: sock });
    assert.equal(pair.code, 'ABCDEFGH');
    assert.deepEqual(h.calls, ['pair:120']);
    await controlRequest({ cmd: 'pair' }, { socketPath: sock });
    assert.deepEqual(h.calls, ['pair:120', 'pair:undefined']);
    await controlRequest({ cmd: 'pair', ttl: 600, reusable: true }, { socketPath: sock });
    assert.deepEqual(h.calls.at(-1), 'pair:600:reusable', 'setup asks for one code for every phone');
    const devices = await controlRequest<unknown[]>({ cmd: 'devices' }, { socketPath: sock });
    assert.equal(devices.length, 1);
    assert.deepEqual(await controlRequest({ cmd: 'revoke', id: 'd1' }, { socketPath: sock }), { revoked: true, id: 'd1' });
    assert.deepEqual(await controlRequest({ cmd: 'status' }, { socketPath: sock }), status);
    assert.deepEqual(await controlRequest({ cmd: 'push-test', id: 'd1' }, { socketPath: sock }), { sent: true, id: 'd1' });
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(sock), false, 'socket file removed on close');
});

test('daemon-side errors surface as ControlError with a code', async () => {
  const server = await startControlServer(handlers(), { socketPath: sock });
  try {
    await assert.rejects(controlRequest({ cmd: 'revoke', id: 'nope' }, { socketPath: sock }), (e: ControlError) => e.code === 'not_found');
    await assert.rejects(controlRequest({ cmd: 'push-test', id: 'boom' }, { socketPath: sock }), (e: ControlError) => e.code === 'internal' && /InvalidProviderToken/.test(e.message));
    await assert.rejects(controlRequest({ cmd: 'pair', ttl: 5 }, { socketPath: sock }), (e: ControlError) => e.code === 'bad_request');
    await assert.rejects(controlRequest({ cmd: 'pair', reusable: 'yes' } as never, { socketPath: sock }), (e: ControlError) => e.code === 'bad_request');
    await assert.rejects(controlRequest({ cmd: 'frobnicate' } as never, { socketPath: sock }), (e: ControlError) => e.code === 'unknown_cmd');
  } finally {
    await server.close();
  }
});

test('client reports a missing daemon clearly', async () => {
  await assert.rejects(controlRequest({ cmd: 'status' }, { socketPath: sock }), (e: ControlError) => e.code === 'unreachable' && /not running/.test(e.message));
});

test('a stale socket file is reclaimed; a live one is not', async () => {
  fs.writeFileSync(sock, '');
  const server = await startControlServer(handlers(), { socketPath: sock });
  try {
    assert.deepEqual(await controlRequest({ cmd: 'status' }, { socketPath: sock }), status);
    await assert.rejects(startControlServer(handlers(), { socketPath: sock }), /already listening/);
  } finally {
    await server.close();
  }
});

test('dispatch validates the request shape', async () => {
  const h = handlers();
  assert.deepEqual(await dispatch(h, 'nope'), { ok: false, error: 'bad_request', message: 'expected {"cmd": ...}' });
  assert.equal((await dispatch(h, { cmd: 'revoke' })).ok, false);
  assert.deepEqual(await dispatch(h, { cmd: 'devices' }), { ok: true, result: h.devices() });
});
