import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FitUnavailableError, PaneFitter, parseFitSize } from '../../src/herdr/fit.ts';
import { silentLogger } from '../../src/log.ts';

function harness(opts: { ttys?: Record<string, string | null> } = {}) {
  const ttys: Record<string, string | null> = opts.ttys ?? { 'w1:pA': '/dev/pts/7', 'w1:pB': '/dev/pts/8' };
  const sizes: Record<string, string> = { '/dev/pts/7': '41 113', '/dev/pts/8': '41 56' };
  const writes: string[] = [];
  const control = { failNextWrite: false }; // set true to make the next size-setting stty throw (a live PTY write failure)
  const fitter = new PaneFitter({
    ttyOf: async (pane) => ttys[pane] ?? null,
    stty: async (tty, args) => {
      if (args[0] === 'size') return sizes[tty] ?? '';
      if (control.failNextWrite) {
        control.failNextWrite = false;
        throw new Error('stty: Input/output error');
      }
      sizes[tty] = `${args[1]} ${args[3]}`;
      writes.push(`${tty} ${args[1]}x${args[3]}`);
      return '';
    },
    log: silentLogger,
  });
  const fitted: string[] = [];
  fitter.on('fitted', (pane: string, s: { cols: number; rows: number }) => fitted.push(`${pane} ${s.cols}x${s.rows}`));
  return { fitter, writes, fitted, sizes, ttys, control };
}

test('apply sets the PTY columns and keeps herdr\'s rows; release restores herdr\'s original size', async () => {
  const h = harness();
  const a = {};
  assert.deepEqual(await h.fitter.apply('w1:pA', a, { cols: 60, rows: 30 }), { cols: 60, rows: 41 });
  assert.deepEqual(h.writes, ['/dev/pts/7 41x60']);
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 });
  await h.fitter.release('w1:pA', a);
  assert.deepEqual(h.writes, ['/dev/pts/7 41x60', '/dev/pts/7 41x113']);
  assert.equal(h.fitter.active('w1:pA'), null);
  assert.deepEqual(h.fitted, ['w1:pA 60x41', 'w1:pA 113x41']);
});

test('a phone re-sending the same columns with different rows (keyboard shown/hidden) writes nothing', async () => {
  const h = harness();
  const phone = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 18 });
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  assert.deepEqual(h.writes, ['/dev/pts/7 41x60']);
  await h.fitter.apply('w1:pA', phone, { cols: 58, rows: 30 }); // rotated / font changed
  assert.deepEqual(h.writes, ['/dev/pts/7 41x60', '/dev/pts/7 41x58']);
});

test('most recent viewer wins; releasing it falls back to the other viewer, then to herdr', async () => {
  const h = harness();
  const phone = {};
  const tablet = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pA', tablet, { cols: 100, rows: 50 });
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 100, rows: 41 });
  await h.fitter.release('w1:pA', tablet);
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 }, 'phone\'s fit is back');
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.sizes['/dev/pts/7'], '41 113', 'original restored once nobody looks');
});

test('re-applying for the same owner replaces its fit without stacking', async () => {
  const h = harness();
  const phone = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pA', phone, { cols: 58, rows: 28 }); // rotated / font changed
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.fitter.active('w1:pA'), null);
  assert.equal(h.sizes['/dev/pts/7'], '41 113');
});

test('layout change: herdr\'s new native size is captured as the restore value and the fit re-applied', async () => {
  const h = harness();
  const phone = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  h.sizes['/dev/pts/7'] = '39 54'; // herdr split the tab and resized the PTY itself
  await h.fitter.onLayoutChanged();
  assert.equal(h.sizes['/dev/pts/7'], '39 60', 'fit put back with herdr\'s new row count');
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.sizes['/dev/pts/7'], '39 54', 'restored to the post-split size, not the stale one');
});

test('layout change with nothing to do writes nothing', async () => {
  const h = harness();
  await h.fitter.apply('w1:pA', {}, { cols: 60, rows: 30 });
  const before = h.writes.length;
  await h.fitter.onLayoutChanged();
  assert.equal(h.writes.length, before);
});

test('releaseAll drops every pane of one owner and leaves other owners alone', async () => {
  const h = harness();
  const phone = {};
  const tablet = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pB', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pB', tablet, { cols: 90, rows: 40 });
  await h.fitter.releaseAll(phone);
  assert.deepEqual(h.fitter.panesOf(phone), []);
  assert.equal(h.fitter.active('w1:pA'), null);
  assert.deepEqual(h.fitter.active('w1:pB'), { cols: 90, rows: 41 });
});

test('no tty → FitUnavailableError; pane vanishing during a layout change forgets the record', async () => {
  const h = harness({ ttys: { 'w1:pA': '/dev/pts/7', 'w1:gone': null } });
  await assert.rejects(h.fitter.apply('w1:gone', {}, { cols: 60, rows: 30 }), FitUnavailableError);
  const phone = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  h.ttys['w1:pA'] = null;
  await h.fitter.onLayoutChanged();
  assert.equal(h.fitter.active('w1:pA'), null);
});

test('parseFitSize enforces the limits', () => {
  assert.deepEqual(parseFitSize({ cols: 60, rows: 30 }), { cols: 60, rows: 30 });
  assert.match(String(parseFitSize({ cols: 10, rows: 30 })), /cols/);
  assert.match(String(parseFitSize({ cols: 60, rows: 2 })), /rows/);
  assert.match(String(parseFitSize({ cols: '60', rows: 30 })), /cols/);
  assert.match(String(parseFitSize({ cols: 60.5, rows: 30 })), /cols/);
});

test('restoreAll (bridge shutdown) gives every fitted pane its original size back and forgets them all', async () => {
  const h = harness();
  const a = {};
  const b = {};
  await h.fitter.apply('w1:pA', a, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pB', b, { cols: 50, rows: 30 });
  await h.fitter.restoreAll();
  assert.deepEqual(h.writes.slice(2).sort(), ['/dev/pts/7 41x113', '/dev/pts/8 41x56']);
  assert.equal(h.fitter.active('w1:pA'), null);
  assert.equal(h.fitter.active('w1:pB'), null);
  await h.fitter.release('w1:pA', a); // nothing left to release: no further write
  assert.equal(h.writes.length, 4);
});

test('restoreAll with nothing fitted writes nothing', async () => {
  const h = harness();
  await h.fitter.restoreAll();
  assert.deepEqual(h.writes, []);
});

test('a live fit whose PTY write fails leaves no ghost fit: the fresh record is dropped', async () => {
  // First fit for a pane with no prior record. The stty write fails while the session is still
  // connected (not disposed), so Session.fit will surface fit_unavailable but not release. If apply
  // recorded the owner before the write, a ghost fit would remain that layout reconcile could later
  // resurrect. The record must be rolled all the way back.
  const h = harness();
  const phone = {};
  h.control.failNextWrite = true;
  await assert.rejects(h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 }), FitUnavailableError);
  assert.deepEqual(h.writes, [], 'the failed write never took');
  assert.equal(h.fitter.active('w1:pA'), null, 'no size is imposed');
  assert.deepEqual(h.fitter.panesOf(phone), [], 'the owner holds no ghost fit');
  // A later successful fit on the same pane must behave as a first fit: herdr re-laid out meanwhile, and only a
  // genuinely fresh record re-reads that as the original — a leftover empty record would keep the stale 113.
  h.sizes['/dev/pts/7'] = '41 120';
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 });
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.sizes['/dev/pts/7'], '41 120', 'restored to the native size read at the retry, not a stale original');
});

test('a live re-fit whose PTY write fails keeps the owner\'s previous fit, not the failed size', async () => {
  const h = harness();
  const phone = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 });
  h.control.failNextWrite = true;
  await assert.rejects(h.fitter.apply('w1:pA', phone, { cols: 90, rows: 30 }), FitUnavailableError);
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 }, 'the prior fit survives the failed re-fit');
  assert.deepEqual(h.fitter.panesOf(phone), ['w1:pA'], 'the owner still fits the pane');
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.fitter.active('w1:pA'), null);
  assert.equal(h.sizes['/dev/pts/7'], '41 113', 'clean restore: no ghost 90-col fit resurrected');
});

test('a failed re-fit while another viewer is newest keeps that viewer newest (rollback preserves precedence)', async () => {
  const h = harness();
  const phone = {};
  const tablet = {};
  await h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 });
  await h.fitter.apply('w1:pA', tablet, { cols: 100, rows: 50 });
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 100, rows: 41 });
  h.control.failNextWrite = true;
  await assert.rejects(h.fitter.apply('w1:pA', phone, { cols: 90, rows: 30 }), FitUnavailableError);
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 100, rows: 41 }, 'the tablet is still the newest viewer');
  assert.deepEqual(h.fitted, ['w1:pA 60x41', 'w1:pA 100x41'], 'no fitted event: the failed write committed nothing');
  // Re-sending the current winner must find the PTY already at that size: `applied` was not touched by the rollback.
  const writesBefore = h.writes.length;
  await h.fitter.apply('w1:pA', tablet, { cols: 100, rows: 50 });
  assert.equal(h.writes.length, writesBefore, 'applied still records 100 columns: nothing to write');
  // A layout check with nothing changed must not mistake the tablet's 100 columns for herdr's native size.
  const before = h.writes.length;
  await h.fitter.onLayoutChanged();
  assert.equal(h.writes.length, before, 'nothing to reconcile');
  await h.fitter.release('w1:pA', tablet);
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 }, 'the phone\'s untouched 60-col fit takes over');
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.sizes['/dev/pts/7'], '41 113', 'herdr\'s real original restored, not a captured 100');
});

test('a write that commits but whose fitted listener throws is not rolled back: the PTY changed, so the record stands', async () => {
  const h = harness();
  const phone = {};
  let armed = true;
  h.fitter.on('fitted', () => {
    if (!armed) return;
    armed = false;
    throw new Error('listener bug');
  });
  await assert.rejects(h.fitter.apply('w1:pA', phone, { cols: 60, rows: 30 }), /listener bug/);
  assert.deepEqual(h.writes, ['/dev/pts/7 41x60'], 'the stty write took');
  assert.deepEqual(h.fitter.active('w1:pA'), { cols: 60, rows: 41 }, 'the record matches the resized PTY');
  assert.deepEqual(h.fitter.panesOf(phone), ['w1:pA']);
  await h.fitter.release('w1:pA', phone);
  assert.equal(h.sizes['/dev/pts/7'], '41 113', 'and it can still be restored');
});
