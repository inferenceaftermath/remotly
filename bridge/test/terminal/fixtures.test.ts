import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseScreen, parseStats, plainText, rowWidth } from '../../src/terminal/ansi.ts';
import { diffRows } from '../../src/terminal/differ.ts';
import { StyleTable, encodeFrame } from '../../src/terminal/encode.ts';
import { FRAMES_DIR, benchmark, fixtureNames, goldenFrame, loadFixture } from './fixtures.ts';

// herdr's text read trims trailing spaces and trailing blank rows; so does our comparison.
const normalise = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

const names = fixtureNames();

test('read fixtures exist', () => assert.ok(names.length > 0));

for (const name of names) {
  test(`fixture ${name}`, () => {
    const f = loadFixture(name);
    parseStats.unknownSequences = 0;
    const rows = parseScreen(f.ansi);
    assert.equal(parseStats.unknownSequences, 0, 'herdr reads are SGR-only (findings §2)');

    // (a) matches herdr's own plain-text rendering of the same screen
    assert.equal(normalise(plainText(rows)), normalise(f.txt));

    // (b) nothing wider than the PTY, no more rows than the PTY
    for (const [y, row] of rows.entries()) assert.ok(rowWidth(row) <= f.cols, `row ${y} width ${rowWidth(row)} > cols ${f.cols}`);
    assert.ok(rows.length <= f.rows, `read has ${rows.length} rows > pty rows ${f.rows}`);

    // (c) re-parsing/re-encoding is stable and a second full frame on the same table reports no new styles
    const frame = goldenFrame(f, rows);
    assert.deepEqual(goldenFrame(f, parseScreen(f.ansi)), frame);
    const table = new StyleTable();
    encodeFrame({ pane: f.name, rev: 1, cols: f.cols, rows: f.rows, full: true, rows_: rows, changed: [], table });
    const again = encodeFrame({ pane: f.name, rev: 2, cols: f.cols, rows: f.rows, full: true, rows_: rows, changed: [], table });
    assert.deepEqual(again.styles, {});
    assert.deepEqual(again.lines, frame.lines);
    assert.deepEqual(diffRows(rows, parseScreen(f.ansi), f.rows).changed, []);

    // goldens shared with the iOS/Android suites; regenerate with `node scripts/gen-frames.ts`
    const goldenPath = path.join(FRAMES_DIR, `${name}.frame.json`);
    assert.ok(fs.existsSync(goldenPath), `missing ${goldenPath}: run node scripts/gen-frames.ts`);
    assert.deepEqual(frame, JSON.parse(fs.readFileSync(goldenPath, 'utf8')));
    assert.equal(`${plainText(rows)}\n`, fs.readFileSync(path.join(FRAMES_DIR, `${name}.txt`), 'utf8'));
  });
}

test('no stale golden frames', () => {
  const stale = fs
    .readdirSync(FRAMES_DIR)
    .filter((f) => f.endsWith('.frame.json'))
    .map((f) => f.slice(0, -'.frame.json'.length))
    .filter((n) => !names.includes(n));
  assert.deepEqual(stale, []);
});

test('benchmark: 200x50 styled screen, parse + diff + full encode', (t) => {
  const b = benchmark();
  t.diagnostic(`200x50 parse+diff+encode: median ${b.median.toFixed(2)} ms, max ${b.max.toFixed(2)} ms (budget 20 ms)`);
});
