import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyWindow, lineKey, plainOf, SCROLLBACK_AVERAGE_LINE_CHARS, SCROLLBACK_GAP_LINE, SCROLLBACK_MAX_LINE_NUMBER, SCROLLBACK_STORED_LINE_CHARS, ScrollbackCopy, splitLines, storedLine, type HistoryWindow, type PaneReads, type RowGrowth } from '../../src/terminal/scrollback.ts';
import { FakeTerminal } from './fake-terminal.ts';

/** The three reads the keeper makes, for `n` rows. */
function reads(t: FakeTerminal, n: number): PaneReads {
  return {
    visible: splitLines(t.read('p', 'visible').text),
    recent: splitLines(t.read('p', 'recent', n).text),
    unwrapped: splitLines(t.read('p', 'recent_unwrapped', n).text),
    truncated: t.read('p', 'recent', n).truncated,
    requested: n,
    screenRows: t.screenRows,
  };
}

const numbered = (from: number, count: number, width = 3): string[] => Array.from({ length: count }, (_, i) => `L${String(from + i).padStart(width, '0')}`);

test('splitLines drops the CR before each newline and an empty tail', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\r\n\r\nb\n'), ['a', '', 'b']);
});

test('lineKey compares printed characters and their styles, without trailing blanks or hyperlinks', () => {
  assert.equal(plainOf('\x1b[1;31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07'), 'red link');
  assert.equal(lineKey('\x1b[1mok\x1b[0m   '), '\x1b[1mok');
  assert.equal(lineKey('\x1b[0m\x1b[48;5;4mbg   \x1b[0m'), '\x1b[0m\x1b[48;5;4mbg');
  assert.equal(lineKey('a\x1b]8;id=7;http://x\x07link\x1b]8;;\x07\x1b[K'), 'alink');
  assert.notEqual(lineKey('\x1b[31msame'), lineKey('\x1b[32msame'));
  assert.equal(lineKey('  indented'), '  indented');
});

test('historyWindow: whole lines above the screen; a line soft-wrapped across its top edge waits', () => {
  const t = new FakeTerminal(10, 3);
  t.print('aaaa', 'b'.repeat(15), 'c', 'd', 'e');
  assert.deepEqual(historyWindow(reads(t, 999)), { lines: ['aaaa', 'b'.repeat(15)], rows: [1, 2], tailRows: 0, complete: true });
  const u = new FakeTerminal(10, 3);
  u.print('aaaa', 'b'.repeat(15), 'c', 'd');
  // rows: aaaa | bbbbbbbbbb | bbbbb | c | d — the second row of the b line is on the screen
  assert.deepEqual(historyWindow(reads(u, 999)), { lines: ['aaaa'], rows: [1], tailRows: 1, complete: true });
});

test('historyWindow: a cut read places the screen by the rows asked for and drops its (maybe partial) first line', () => {
  const t = new FakeTerminal(10, 3);
  t.print(...numbered(0, 20));
  assert.deepEqual(historyWindow(reads(t, 8)), { lines: ['L013', 'L014', 'L015', 'L016'], rows: [1, 1, 1, 1], tailRows: 0, complete: false });
  // blank rows at the bottom of the screen count in N though herdr does not return them
  const b = new FakeTerminal(10, 4);
  b.print(...numbered(0, 20), '', '');
  assert.equal(b.read('p', 'visible').text, 'L018\r\nL019');
  assert.deepEqual(historyWindow(reads(b, 8)), { lines: ['L015', 'L016', 'L017'], rows: [1, 1, 1], tailRows: 0, complete: false });
});

test('historyWindow: reads that do not fit together (output between them) → null', () => {
  const t = new FakeTerminal(10, 3);
  t.print(...numbered(0, 10));
  const r = reads(t, 999);
  t.print('new');
  assert.equal(historyWindow({ ...r, visible: splitLines(t.read('p', 'visible').text) }), null);
  assert.equal(historyWindow({ ...r, unwrapped: ['zzz', ...r.unwrapped.slice(1)] }), null);
  assert.equal(historyWindow({ ...r, truncated: true, requested: 2 }), null, 'a screen taller than the read');
});

test('historyWindow: a wide character that did not fit at a row end (padding blank) still maps', () => {
  const r: PaneReads = { visible: ['x', 'y'], recent: ['abcdefghi ', '日本', 'x', 'y'], unwrapped: ['abcdefghi日本', 'x', 'y'], truncated: false, requested: 999, screenRows: 2 };
  assert.deepEqual(historyWindow(r), { lines: ['abcdefghi日本'], rows: [2], tailRows: 0, complete: true });
});

function fold(copy: ScrollbackCopy, t: FakeTerminal, n: number, grown: RowGrowth | null = null) {
  const w = historyWindow(reads(t, n));
  assert.ok(w, 'reads fit together');
  return copy.merge(w, n < 999, grown);
}

/** A window of one-row lines, as a read of a pane wider than all of them gives. */
const win = (lines: string[], complete: boolean): HistoryWindow => ({ lines, rows: lines.map(() => 1), tailRows: 0, complete });

test('merge: the first read is taken whole, later ones append only what is new, a re-read adds nothing', () => {
  const t = new FakeTerminal(10, 3);
  const copy = new ScrollbackCopy(1000);
  t.print(...numbered(0, 10));
  assert.deepEqual(fold(copy, t, 999), { reset: false, start: 0, lines: numbered(0, 7), gap: false });
  assert.equal(fold(copy, t, 999), null);
  t.print(...numbered(10, 5));
  assert.deepEqual(fold(copy, t, 20), { reset: false, start: 7, lines: numbered(7, 5), gap: false });
  assert.deepEqual(copy.lines, numbered(0, 12));
  assert.equal(copy.next, 12);
});

test('merge: width changes re-wrap herdr rows but not the copy lines (narrower pushes lines up, wider pulls them back)', () => {
  const t = new FakeTerminal(12, 4);
  const copy = new ScrollbackCopy(1000);
  const long = (i: number) => `line ${i} ${'x'.repeat(i % 3 === 0 ? 20 : 3)}`;
  t.print(...Array.from({ length: 30 }, (_, i) => long(i)));
  const prefix = () => assert.deepEqual(copy.lines, t.lines.slice(0, copy.lines.length), 'the copy is the start of what was printed');
  fold(copy, t, 999);
  prefix();
  const held = copy.lines.length;
  t.cols = 7;
  fold(copy, t, 999);
  prefix();
  assert.ok(copy.lines.length >= held, 'narrower: more lines are above the screen');
  const narrow = copy.lines.length;
  t.cols = 60;
  assert.equal(fold(copy, t, 999), null, 'wider: lines back on the screen are kept, nothing restarts');
  assert.equal(copy.lines.length, narrow);
  t.print('after 1', 'after 2', 'after 3', 'after 4', 'after 5', 'after 6');
  fold(copy, t, 999);
  prefix();
  assert.ok(copy.lines.includes('after 2'));
  assert.equal(new Set(copy.lines).size, copy.lines.length, 'no line twice');
});

test('merge: no overlap → read wider first, then the read goes in after a gap line, cut or whole; the copy never restarts there', () => {
  const t = new FakeTerminal(10, 3);
  const copy = new ScrollbackCopy(1000);
  t.print(...numbered(0, 10));
  fold(copy, t, 999);
  const epoch = copy.epoch;
  t.print(...numbered(10, 50));
  assert.equal(fold(copy, t, 20), 'wider');
  // more lines than one read holds went by: the read is cut and the copy's end is not in it
  const r = fold(copy, t, 30) as never;
  assert.equal(r, 'wider');
  const w = historyWindow(reads(t, 30))!;
  const gap = copy.merge(w, false);
  assert.ok(gap && gap !== 'wider');
  assert.equal(gap.gap, true);
  assert.equal(gap.start, 7);
  assert.equal(gap.lines[0], SCROLLBACK_GAP_LINE, 'a line says lines are missing');
  assert.equal(gap.lines[1], 'L031');
  assert.equal(copy.epoch, epoch);
  // the reads after it line up with the copy as before
  t.print(...numbered(60, 4));
  assert.deepEqual(fold(copy, t, 999), { reset: false, start: copy.next - 4, lines: numbered(57, 4), gap: false });
  // a whole read without the copy's lines (a `clear` refilled before a read saw it empty, or a byte-capped history
  // that turned over): only the keeper's clear check restarts the copy, so these go in after a gap line too
  t.clear();
  t.print(...numbered(500, 8));
  const next = copy.next;
  const whole = fold(copy, t, 999);
  assert.ok(whole && whole !== 'wider');
  assert.deepEqual(whole, { reset: false, start: next, lines: [SCROLLBACK_GAP_LINE, ...numbered(500, 5)], gap: true });
  assert.equal(copy.epoch, epoch);
});

test('merge: the copy keeps its last maxLines lines and numbers them on', () => {
  const copy = new ScrollbackCopy(5);
  const w = (lines: string[]): HistoryWindow => win(lines, true);
  const r = copy.merge(w(numbered(0, 8)), false);
  assert.deepEqual(r, { reset: false, start: 3, lines: numbered(3, 5), gap: false });
  assert.equal(copy.base, 3);
  const r2 = copy.merge(w(numbered(0, 10)), false);
  assert.deepEqual(r2, { reset: false, start: 8, lines: numbered(8, 2), gap: false });
  assert.equal(copy.base, 5);
  assert.deepEqual(copy.since(0), { start: 5, lines: numbered(5, 5) });
  assert.deepEqual(copy.since(8), { start: 8, lines: numbered(8, 2) });
  assert.deepEqual(copy.since(99), { start: 10, lines: [] });
});

test('merge: blank lines alone are not taken as the place to continue from', () => {
  const copy = new ScrollbackCopy(100);
  const blanks = ['', '', '', '', '', ''];
  copy.merge(win(['a', ...blanks], true), false);
  assert.equal(copy.merge(win(['b', ...blanks, 'c'], false), true), 'wider');
  // with the inked line in reach it lines up
  assert.deepEqual(copy.merge(win(['a', ...blanks, 'c'], true), true), { reset: false, start: 7, lines: ['c'], gap: false });
});

test('merge: repeated output — the place where the whole read agrees with the copy wins, so repeats are not dropped', () => {
  const t = new FakeTerminal(10, 3);
  const copy = new ScrollbackCopy(1000);
  t.print('start', ...Array(13).fill('same'));
  fold(copy, t, 999);
  assert.deepEqual(copy.lines, ['start', ...Array(10).fill('same')]);
  t.print(...Array(5).fill('same'));
  assert.deepEqual(fold(copy, t, 999), { reset: false, start: 11, lines: Array(5).fill('same'), gap: false });
  // the same block printed again (a command run twice): the second one is kept
  const block = ['$ git status', 'On branch main', 'nothing to commit', '', 'x', 'y', 'z'];
  const twice = new ScrollbackCopy(1000);
  twice.merge(win(['start', ...block], true), false);
  assert.deepEqual(twice.merge(win(['start', ...block, ...block], true), false), { reset: false, start: 8, lines: block, gap: false });
});

test('merge: a read all of repeats lines up where the growth of herdr\'s rows says the copy ended', () => {
  const copy = new ScrollbackCopy(1000);
  copy.merge(win(['start', ...Array(40).fill('y')], true), false);
  // the read starts inside the run: every place agrees back to its start; 3 to 7 rows were added since the read before
  // (herdr's counts before and after the two reads' requests), 5 most likely
  const r = copy.merge(win(Array(30).fill('y'), false), false, { least: 3, most: 7, likely: 5 });
  assert.ok(r && r !== 'wider');
  assert.deepEqual(r.lines, Array(5).fill('y'));
  assert.equal(copy.next, 46);
  const g = (n: number): RowGrowth => ({ least: n, most: n, likely: n });
  // no output during the reads: exact
  const r2 = copy.merge(win(Array(30).fill('y'), false), false, g(6));
  assert.ok(r2 && r2 !== 'wider');
  assert.equal(r2.lines.length, 6);
  // without herdr's count the latest place is taken (nothing appended rather than lines twice)
  assert.equal(copy.merge(win(Array(30).fill('y'), false), false, null), null);
  assert.equal(copy.next, 52);
  // a read too short to hold the rows herdr added (it may start after the right place): read more first
  assert.equal(copy.merge(win(Array(10).fill('y'), false), true, g(20)), 'wider');
  const r3 = copy.merge(win(Array(10).fill('y'), false), false, g(20));
  assert.ok(r3 && r3 !== 'wider');
  assert.equal(r3.lines.length, 4, 'with no wider read to come, the most the read can hold');
});

test('merge: lines that differ only in colour line up by their colours, also when herdr\'s rows no longer grow', () => {
  const same = (c: number): string => `\x1b[0m\x1b[38;5;${c}mbuilding\x1b[0m`;
  const colours = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => same(from + i));
  const copy = new ScrollbackCopy(1000);
  copy.merge(win(['start', ...colours(1, 12)], true), false);
  // herdr's scrollback is full: the oldest row went as the new one came, so the count stayed where it was
  const r = copy.merge(win(colours(2, 13), false), false, { least: 0, most: 0, likely: 0 });
  assert.ok(r && r !== 'wider');
  assert.deepEqual(r.lines, [same(13)]);
  assert.equal(r.gap, false);
});

test('merge: blank lines only — herdr\'s row growth says how many are new', () => {
  const copy = new ScrollbackCopy(100);
  copy.merge(win(Array(10).fill(''), true), false);
  const r = copy.merge(win(Array(12).fill(''), false), false, { least: 3, most: 3, likely: 3 });
  assert.ok(r && r !== 'wider');
  assert.equal(r.lines.length, 3);
  assert.equal(copy.next, 13);
});

test('merge: one matching line at the start of a read is not taken for the place to continue from (a prompt after `clear`)', () => {
  const t = new FakeTerminal(20, 3);
  const copy = new ScrollbackCopy(1000);
  t.print('$ make', 'building', 'done', 'ok 1', 'ok 2', 'ok 3', '$ ', 'x', 'y', 'z');
  fold(copy, t, 999);
  const epoch = copy.epoch;
  assert.equal(copy.lines.at(-1), '$ ');
  t.clear();
  t.print('$ ', 'new 1', 'new 2', 'new 3', 'n', 'n2', 'n3');
  const r = fold(copy, t, 999);
  assert.ok(r && r !== 'wider');
  assert.equal(r.reset, false);
  assert.equal(copy.epoch, epoch);
  assert.deepEqual(r.lines, [SCROLLBACK_GAP_LINE, '$ ', 'new 1', 'new 2', 'new 3']);
});

test('the copy keeps a long line to SCROLLBACK_STORED_LINE_CHARS, not ending inside an escape, and drops its oldest lines past its character budget', () => {
  const n = SCROLLBACK_STORED_LINE_CHARS;
  assert.equal(storedLine('x'.repeat(n + 10)).length, n);
  assert.equal(storedLine('x'.repeat(n - 3) + '\x1b[38;5;200mabc'), 'x'.repeat(n - 3), 'a cut CSI goes');
  assert.equal(storedLine('x'.repeat(n - 5) + '\x1b]8;;http://example.com\x07y'), 'x'.repeat(n - 5), 'a cut OSC goes');
  assert.equal(storedLine('x'.repeat(n - 1) + '😀'), 'x'.repeat(n - 1), 'half a surrogate pair goes');
  const copy = new ScrollbackCopy(1000, 100);
  const long = 'a'.repeat(n * 2);
  copy.merge(win(['one', long, 'two'], true), false);
  // 'one' and the long line go over 100 characters (escapes included); the newest stays even alone over it
  assert.deepEqual(copy.lines, ['two']);
  assert.equal(copy.base, 2);
  copy.merge(win(['one', long, 'two', 'b'.repeat(40)], true), false);
  assert.deepEqual(copy.lines, ['two', 'b'.repeat(40)]);
  // the read's long line is compared as kept, so it still lines up
  const big = new ScrollbackCopy(1000);
  big.merge(win(['p', 'q', 'r', 's', 't', long], true), false);
  assert.equal(big.lines.at(-1)!.length, n);
  assert.deepEqual(big.merge(win(['p', 'q', 'r', 's', 't', long, 'next'], true), false), { reset: false, start: 6, lines: ['next'], gap: false });
});

test('copy: a cut read ending with a block the copy has, after herdr history grew, is repeated output: it goes in after a gap line', () => {
  const block = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  const copy = new ScrollbackCopy(1000);
  copy.merge(win(['a', ...block, 'tail'], true), false);
  const grown = { least: 100, most: 120, likely: 110 };
  const r = copy.merge(win(['new-a', 'new-b', ...block], false), false, grown);
  assert.ok(r && r !== 'wider');
  assert.equal(r.gap, true);
  assert.deepEqual(r.lines, [SCROLLBACK_GAP_LINE, 'new-a', 'new-b', ...block]);
  // without growth it may be a wider pane that pulled the copy's last lines back: nothing changes
  const wider = new ScrollbackCopy(1000);
  wider.merge(win(['a', ...block, 'tail'], true), false);
  assert.equal(wider.merge(win(['new-a', 'new-b', ...block], false), false, { least: 0, most: 0, likely: 0 }), null);
  // lines before a gap line are not taken for lines a wider pane pulled back
  const gapped = new ScrollbackCopy(1000);
  gapped.merge(win(['a', ...block, 'tail'], true), false);
  gapped.merge(win(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'], false), false);
  const after = gapped.merge(win(['x', ...block], false), false);
  assert.ok(after && after !== 'wider');
  assert.deepEqual(after.lines, [SCROLLBACK_GAP_LINE, 'x', ...block]);
});

test('copy: before its next number would pass the largest one the copy is numbered from 0 under a new epoch, lines kept', () => {
  const copy = new ScrollbackCopy(1000);
  copy.merge(win(numbered(0, 8), true), false);
  const epoch = copy.epoch;
  copy.base = SCROLLBACK_MAX_LINE_NUMBER - 8; // next: the largest number, which the `ok`'s `next` must still fit in
  assert.deepEqual(copy.merge(win(numbered(0, 9), true), false), { reset: true, start: 0, lines: numbered(0, 9), gap: false });
  assert.notEqual(copy.epoch, epoch);
  assert.equal(copy.base, 0);
  assert.equal(copy.next, 9);
});

test('copy: every cut read that does not line up goes in after a gap line, and later reads line up with the lines after it', () => {
  const copy = new ScrollbackCopy(100_000);
  copy.merge(win(numbered(0, 10), true), false);
  // a cut read of fewer lines than are lined up (a few very long lines): the gap line still goes in
  const short = copy.merge(win(['x1', 'x2', 'x3', 'x4'], false), false);
  assert.ok(short && short !== 'wider');
  assert.equal(short.gap, true);
  assert.deepEqual(short.lines, [SCROLLBACK_GAP_LINE, 'x1', 'x2', 'x3', 'x4']);
  // herdr shows neither the gap line nor the lines before it next to x1: the next read lines up with x1..x4 alone
  assert.deepEqual(copy.merge(win(['lost', 'x1', 'x2', 'x3', 'x4', 'x5'], false), false), { reset: false, start: 15, lines: ['x5'], gap: false });
  // and a widened pane whose screen ends with them is not taken for a wipe
  assert.equal(copy.endsAmong(['x1', 'x2', 'x3', 'x4', 'x5', '$ ']), true);
  // once six lines follow the gap line, they are what is lined up with, as before any gap
  copy.merge(win(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'], false), false);
  assert.deepEqual(copy.merge(win(['x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'], false), false), { reset: false, start: 18, lines: ['x8'], gap: false });
  // 9 000 lines, more than the keys kept, then a read of the last ones and one more
  const many = new ScrollbackCopy(100_000);
  many.merge(win(numbered(0, 9000, 5), true), false);
  assert.deepEqual(many.merge(win(numbered(8100, 901, 5), true), false), { reset: false, start: 9000, lines: numbered(9000, 1, 5), gap: false });
});

test('copy: the character budget follows max_lines (SCROLLBACK_AVERAGE_LINE_CHARS a line), so ordinary lines are all kept', () => {
  const line = (i: number) => `\x1b[38;5;2m${String(i).padStart(6, '0')}\x1b[0m ${'x'.repeat(SCROLLBACK_AVERAGE_LINE_CHARS - 40)}`;
  const copy = new ScrollbackCopy(20_000);
  for (let b = 0; b < 25; b++) {
    const from = Math.max(0, b * 1000 - 10);
    copy.merge(win(Array.from({ length: b * 1000 + 1000 - from }, (_, i) => line(from + i)), true), false);
  }
  assert.equal(copy.lines.length, 20_000, 'max_lines, not the character budget, decides');
  assert.equal(copy.base, 5000);
  // lines longer than that on average: the budget decides, max_lines × SCROLLBACK_AVERAGE_LINE_CHARS characters
  const wide = new ScrollbackCopy(10);
  wide.merge(win(Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(SCROLLBACK_AVERAGE_LINE_CHARS * 2.5, '-')), true), false);
  assert.equal(wide.lines.length, 4);
  assert.equal(wide.lines[0]![0], '6');
});
