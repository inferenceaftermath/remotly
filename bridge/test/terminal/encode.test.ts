import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCROLLBACK_LINE_CELLS, StyleTable, encodeFrame, encodeHistory, encodeScrollback } from '../../src/terminal/encode.ts';
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

test('encodeScrollback: one line per entry, chunks numbered on, reset and new styles only where they belong', () => {
  const table = new StyleTable();
  const lines = ['\x1b[1mbold\x1b[0m one', 'two', '', '\x1b[31mred\x1b[0m'];
  const one = [...encodeScrollback({ pane: 'p', epoch: 'e1', start: 10, lines, reset: true, table })];
  assert.equal(one.length, 1);
  assert.equal(one[0]!.start, 10);
  assert.equal(one[0]!.reset, true);
  assert.equal(one[0]!.lines.length, 4);
  assert.deepEqual(one[0]!.lines[2], { runs: [] });
  assert.deepEqual(Object.keys(one[0]!.styles).sort(), ['1', '2']);

  const many = [...encodeScrollback({ pane: 'p', epoch: 'e1', start: 0, lines: Array.from({ length: 50 }, (_, i) => `\x1b[3${i % 8}mline ${i}`), reset: true, table: new StyleTable(), maxBytes: 400 })];
  assert.ok(many.length > 3);
  let next = 0;
  for (const [i, m] of many.entries()) {
    assert.equal(m.start, next);
    assert.equal(m.reset, i === 0 ? true : undefined);
    assert.ok(JSON.stringify(m).length < 1200);
    next += m.lines.length;
  }
  assert.equal(next, 50);
  const ids = many.flatMap((m) => Object.keys(m.styles));
  assert.equal(new Set(ids).size, ids.length, 'each style is sent once');

  const empty = [...encodeScrollback({ pane: 'p', epoch: 'e2', start: 7, lines: [], reset: false, table })];
  assert.deepEqual(empty, [{ t: 'scrollback', pane: 'p', epoch: 'e2', start: 7, lines: [], styles: {} }]);
});

test('encodeScrollback: a line longer than any screen is cut at SCROLLBACK_LINE_CELLS, and a style-dense one until it fits a message', () => {
  const long = [...encodeScrollback({ pane: 'p', epoch: 'e', start: 0, lines: ['x'.repeat(50_000)], reset: false, table: new StyleTable() })];
  assert.deepEqual(long[0]!.lines[0]!.runs, [{ c: 0, w: SCROLLBACK_LINE_CELLS, s: 0, t: 'x'.repeat(SCROLLBACK_LINE_CELLS) }]);
  const wide = [...encodeScrollback({ pane: 'p', epoch: 'e', start: 0, lines: ['a'.repeat(SCROLLBACK_LINE_CELLS - 1) + '日本'], reset: false, table: new StyleTable() })];
  assert.deepEqual(wide[0]!.lines[0]!.runs.map((r) => [r.c, r.w]), [[0, SCROLLBACK_LINE_CELLS - 1]], 'a wide character across the edge is dropped');
  const dense = Array.from({ length: 4000 }, (_, i) => `\x1b[38;5;${i % 256}mab`).join('');
  const [msg] = [...encodeScrollback({ pane: 'p', epoch: 'e', start: 0, lines: [dense], reset: false, table: new StyleTable(), maxBytes: 20_000 })];
  assert.ok(JSON.stringify(msg!.lines).length < 20_000);
  assert.ok(msg!.lines[0]!.runs.length > 100);
  assert.equal(msg!.lines[0]!.runs[0]!.c, 0, 'the start of the line is kept');
  // a combining mark in the run across the edge: the run is cut between graphemes, not dropped
  const accent = [...encodeScrollback({ pane: 'p', epoch: 'e', start: 0, lines: ['a'.repeat(SCROLLBACK_LINE_CELLS - 1) + 'e\u0301z'], reset: false, table: new StyleTable() })];
  const run = accent[0]!.lines[0]!.runs[0]!;
  assert.equal(run.w, SCROLLBACK_LINE_CELLS);
  assert.ok(run.t.endsWith('e\u0301'));
});

test('encodeScrollback: every message stays within maxBytes as UTF-8 JSON, styles counted, each style sent with the line that uses it', () => {
  const hex = (i: number) => (i * 2654435761 >>> 8).toString(16).padStart(6, '0').slice(-6);
  // a full-width line, a new true-colour style on every cell
  const rainbow = Array.from({ length: SCROLLBACK_LINE_CELLS }, (_, i) => `\x1b[38;2;${parseInt(hex(i).slice(0, 2), 16)};${parseInt(hex(i).slice(2, 4), 16)};${parseInt(hex(i).slice(4), 16)}mx`).join('');
  const wide = '日本語のテキスト'.repeat(1200);
  const emoji = '👩‍💻'.repeat(4000);
  const table = new StyleTable();
  const msgs = [...encodeScrollback({ pane: 'p', epoch: 'e', start: 0, lines: [rainbow, wide, emoji, rainbow, 'tail'], reset: true, table, maxBytes: 64 * 1024 })];
  const known = new Set<string>(['0']);
  let next = 0;
  for (const m of msgs) {
    assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 64 * 1024, `${Buffer.byteLength(JSON.stringify(m))} bytes`);
    for (const id of Object.keys(m.styles)) known.add(id);
    const used = new Set(m.lines.flatMap((l) => l.runs.map((r) => String(r.s))));
    for (const id of used) assert.ok(known.has(id), `style ${id} defined before use`);
    for (const id of Object.keys(m.styles)) assert.ok(used.has(id), `style ${id} is used by a line of its message`);
    assert.equal(m.start, next);
    next += m.lines.length;
  }
  assert.equal(next, 5, 'every line is sent');
  assert.equal(msgs.at(-1)!.lines.at(-1)!.runs[0]!.t, 'tail');
});
