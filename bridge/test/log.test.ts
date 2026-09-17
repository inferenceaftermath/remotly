import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, parseLevel } from '../src/log.ts';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const log = createLogger({ level, write: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00.000Z') });
  return { log, lines, last: () => JSON.parse(lines[lines.length - 1] ?? 'null') as Record<string, unknown> };
}

test('emits one JSON line with ts/level/event plus fields', () => {
  const c = capture();
  c.log.info('pair.ok', { device_id: 'd1', platform: 'ios' });
  assert.equal(c.lines.length, 1);
  assert.deepEqual(c.last(), { ts: '2026-09-03T00:00:00.000Z', level: 'info', event: 'pair.ok', device_id: 'd1', platform: 'ios' });
});

test('drops events below the threshold; debugEnabled reflects it', () => {
  const c = capture('info');
  c.log.debug('ws.open', { ip: '1.2.3.4' });
  assert.equal(c.lines.length, 0);
  assert.equal(c.log.debugEnabled, false);
  const d = capture('debug');
  d.log.debug('ws.open');
  assert.equal(d.lines.length, 1);
  assert.equal(d.log.debugEnabled, true);
});

test('flattens Error fields and skips undefined', () => {
  const c = capture();
  const err = Object.assign(new Error('boom'), { code: 'ENOENT' });
  c.log.error('failed', { error: err, missing: undefined });
  const rec = c.last();
  assert.deepEqual(rec['error'], { message: 'boom', name: 'Error', code: 'ENOENT' });
  assert.equal('missing' in rec, false);
});

test('parseLevel accepts case-insensitive names and falls back', () => {
  assert.equal(parseLevel('DEBUG'), 'debug');
  assert.equal(parseLevel(' warn '), 'warn');
  assert.equal(parseLevel('verbose'), 'info');
  assert.equal(parseLevel(undefined, 'error'), 'error');
});
