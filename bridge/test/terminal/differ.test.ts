import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, rowsEqual } from '../../src/terminal/differ.ts';
import { parseScreen } from '../../src/terminal/ansi.ts';

test('no previous screen: full frame listing every grid row', () => {
  assert.deepEqual(diffRows(null, parseScreen('a\nb'), 4), { changed: [0, 1, 2, 3], full: true });
});

test('identical screens: nothing changed', () => {
  const a = parseScreen('\x1b[31ma\x1b[0m\nb\n\nc');
  const b = parseScreen('\x1b[31ma\x1b[0m\nb\n\nc');
  assert.deepEqual(diffRows(a, b, 10), { changed: [], full: false });
});

test('changed rows: text, style, position, attached marks', () => {
  const prev = parseScreen('a\nb\nc\nd');
  assert.deepEqual(diffRows(prev, parseScreen('a\nB\nc\nd'), 4).changed, [1]);
  assert.deepEqual(diffRows(prev, parseScreen('a\n\x1b[1mb\x1b[0m\nc\nd'), 4).changed, [1]);
  assert.deepEqual(diffRows(prev, parseScreen('a\n b\nc\nd'), 4).changed, [1]);
  assert.deepEqual(diffRows(prev, parseScreen('a\nb\u{301}\nc\nd'), 4).changed, [1]);
  assert.deepEqual(diffRows(prev, parseScreen('A\nb\nc\nD'), 4).changed, [0, 3]);
});

test('missing rows are blank; a different row count alone is not a full frame', () => {
  assert.deepEqual(diffRows(parseScreen('a\nb\nc'), parseScreen('a\nb'), 5), { changed: [2], full: false });
  assert.deepEqual(diffRows(parseScreen('a\nb'), parseScreen('a\nb\nc'), 5), { changed: [2], full: false });
  assert.deepEqual(diffRows(parseScreen('a\nb\n'), parseScreen('a\nb'), 5), { changed: [], full: false });
  assert.deepEqual(diffRows(parseScreen('a\nb\n   '), parseScreen('a\nb'), 5), { changed: [], full: false });
});

test('rows beyond the grid are ignored', () => {
  assert.deepEqual(diffRows(parseScreen('a\nb\nc'), parseScreen('a\nb\nX'), 2), { changed: [], full: false });
});

test('rowsEqual compares runs structurally', () => {
  const s = { fg: 'p1', bg: 'd', a: 1 };
  const row = { runs: [{ c: 0, w: 1, t: 'a', style: s }] };
  assert.ok(rowsEqual(row, { runs: [{ c: 0, w: 1, t: 'a', style: { ...s } }] }));
  assert.ok(!rowsEqual(row, { runs: [{ c: 0, w: 1, t: 'a', style: { ...s, a: 0 } }] }));
  assert.ok(!rowsEqual(row, { runs: [{ c: 1, w: 1, t: 'a', style: s }] }));
  assert.ok(!rowsEqual(row, { runs: [{ c: 0, w: 2, t: 'a', style: s }] }));
  assert.ok(!rowsEqual(row, { runs: [...row.runs, { c: 1, w: 1, t: 'b', style: s }] }));
});
