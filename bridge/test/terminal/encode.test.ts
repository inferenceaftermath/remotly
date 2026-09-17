import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StyleTable, encodeFrame, encodeHistory } from '../../src/terminal/encode.ts';
import { parseScreen } from '../../src/terminal/ansi.ts';
import { diffRows } from '../../src/terminal/differ.ts';

test('StyleTable: 0 is the default, ids are stable, only new ids are reported', () => {
  const t = new StyleTable();
  assert.equal(t.idFor({ fg: 'd', bg: 'd', a: 0 }), 0);
  assert.equal(t.idFor({ fg: 'p1', bg: 'd', a: 0 }), 1);
  assert.equal(t.idFor({ fg: 'd', bg: 'd', a: 1 }), 2);
  assert.equal(t.idFor({ fg: 'p1', bg: 'd', a: 0 }), 1, 'same style, same id');
  assert.deepEqual(t.takeNew(), { '1': { fg: 'p1', bg: 'd', a: 0 }, '2': { fg: 'd', bg: 'd', a: 1 } });
  assert.deepEqual(t.takeNew(), {}, 'drained');
  assert.equal(t.idFor({ fg: 'p1', bg: 'd', a: 0 }), 1);
  assert.equal(t.idFor({ fg: 'd', bg: '#010203', a: 0 }), 3);
  assert.deepEqual(t.takeNew(), { '3': { fg: 'd', bg: '#010203', a: 0 } });
  assert.deepEqual(Object.keys(new StyleTable().takeNew()), []);
});

test('full frame carries every grid row, blank rows as empty runs', () => {
  const rows = parseScreen('\x1b[1mhi\x1b[0m there\n\n\u{65E5}');
  const table = new StyleTable();
  const f = encodeFrame({ pane: 'p1', rev: 7, cols: 80, rows: 5, full: true, rows_: rows, changed: [], table });
  assert.deepEqual(f, {
    t: 'frame',
    pane: 'p1',
    rev: 7,
    cols: 80,
    rows: 5,
    full: true,
    lines: [
      { y: 0, runs: [{ c: 0, w: 2, s: 1, t: 'hi' }, { c: 2, w: 6, s: 0, t: ' there' }] },
      { y: 1, runs: [] },
      { y: 2, runs: [{ c: 0, w: 2, s: 0, t: '\u{65E5}' }] },
      { y: 3, runs: [] },
      { y: 4, runs: [] },
    ],
    styles: { '1': { fg: 'd', bg: 'd', a: 1 } },
  });
  assert.deepEqual(Object.keys(f.lines[0]!.runs[0]!), ['c', 'w', 's', 't'], 'wire run key order');
  assert.deepEqual(Object.keys(f.styles['1']!), ['fg', 'bg', 'a']);
  assert.deepEqual(Object.keys(f), ['t', 'pane', 'rev', 'cols', 'rows', 'full', 'lines', 'styles']);
});

test('delta frame carries only changed rows and only new styles', () => {
  const table = new StyleTable();
  const prev = parseScreen('\x1b[1ma\x1b[0m\nb\nc');
  encodeFrame({ pane: 'p', rev: 1, cols: 10, rows: 3, full: true, rows_: prev, changed: [], table });
  const next = parseScreen('\x1b[1ma\x1b[0m\n\x1b[1mB\x1b[0m\n');
  const d = diffRows(prev, next, 3);
  const f = encodeFrame({ pane: 'p', rev: 2, cols: 10, rows: 3, full: d.full, rows_: next, changed: d.changed, table });
  assert.deepEqual(f, {
    t: 'frame',
    pane: 'p',
    rev: 2,
    cols: 10,
    rows: 3,
    full: false,
    lines: [{ y: 1, runs: [{ c: 0, w: 1, s: 1, t: 'B' }] }, { y: 2, runs: [] }],
    styles: {},
  });
  const next2 = parseScreen('\x1b[1ma\x1b[0m\n\x1b[1mB\x1b[0m\n\x1b[31mc');
  const d2 = diffRows(next, next2, 3);
  const f2 = encodeFrame({ pane: 'p', rev: 3, cols: 10, rows: 3, full: d2.full, rows_: next2, changed: d2.changed, table });
  assert.deepEqual(f2.lines, [{ y: 2, runs: [{ c: 0, w: 1, s: 2, t: 'c' }] }]);
  assert.deepEqual(f2.styles, { '2': { fg: 'p1', bg: 'd', a: 0 } });
});

test('encodeHistory: lines without y', () => {
  const table = new StyleTable();
  const h = encodeHistory({ id: 'r1', pane: 'p', rows_: parseScreen('\x1b[2mold\x1b[0m\n\nnew'), has_more: true, table });
  assert.deepEqual(h, {
    t: 'history',
    id: 'r1',
    pane: 'p',
    lines: [{ runs: [{ c: 0, w: 3, s: 1, t: 'old' }] }, { runs: [] }, { runs: [{ c: 0, w: 3, s: 0, t: 'new' }] }],
    styles: { '1': { fg: 'd', bg: 'd', a: 2 } },
    has_more: true,
  });
});
