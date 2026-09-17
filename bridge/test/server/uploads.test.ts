import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { UploadStore, uploadType } from '../../src/server/uploads.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-uploads-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('save writes a 0600 file into today\'s folder and prunes only day folders past keepDays', async () => {
  const now = new Date(2026, 8, 7, 14, 5, 9);
  const yesterday = day(new Date(2026, 8, 6));
  for (const name of ['2001-01-01', yesterday, 'notes']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, '2001-01-01', 'old.jpg'), 'old');
  const store = new UploadStore({ dir, keepDays: 7, maxBytes: 1024, now: () => now });
  const saved = await store.save(Buffer.from('jpegdata'), 'image/jpeg');
  assert.equal(path.dirname(saved.path), path.join(dir, '2026-09-07'));
  assert.match(path.basename(saved.path), /^140509-[0-9a-f]{6}\.jpg$/);
  assert.equal(saved.bytes, 8);
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'jpegdata');
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(saved.path)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(dir, '2001-01-01')), false, 'stale day folder pruned');
  assert.ok(fs.existsSync(path.join(dir, yesterday)), 'recent day folder kept');
  assert.ok(fs.existsSync(path.join(dir, 'notes')), 'non-day folder untouched');
  const png = await store.save(Buffer.from([1, 2, 3]), 'image/png');
  assert.match(png.path, /\.png$/);
  assert.notEqual(png.path, saved.path);
});

test('prune on a missing dir is a no-op', () => {
  assert.deepEqual(new UploadStore({ dir: path.join(dir, 'nope'), keepDays: 1, maxBytes: 1 }).prune(), []);
});

test('uploadType accepts jpeg and png (with parameters, any case) and rejects the rest', () => {
  assert.equal(uploadType('image/jpeg'), 'image/jpeg');
  assert.equal(uploadType('image/jpg'), 'image/jpeg');
  assert.equal(uploadType('IMAGE/PNG; charset=binary'), 'image/png');
  assert.equal(uploadType(['image/png', 'text/plain']), 'image/png');
  assert.equal(uploadType('image/heic'), null);
  assert.equal(uploadType('text/plain'), null);
  assert.equal(uploadType(undefined), null);
});
