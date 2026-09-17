import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScreen, parseStats, plainText, rowWidth } from '../../src/terminal/ansi.ts';
import { DEFAULT_STYLE } from '../../src/terminal/types.ts';
import type { Style } from '../../src/terminal/types.ts';

const D = DEFAULT_STYLE;
const st = (o: Partial<Style>): Style => ({ fg: 'd', bg: 'd', a: 0, ...o });
const run = (c: number, w: number, t: string, style: Style = D) => ({ c, w, t, style });
const line = (s: string) => parseScreen(s)[0]!.runs;
/** Style that `sgr` leaves in effect for the next character. */
const styleOf = (sgr: string) => line(`${sgr}x`)[0]!.style;
const CJK = '\u{65E5}';

test('SGR attributes', () => {
  assert.deepEqual(styleOf('\x1b[1m'), st({ a: 1 }));
  assert.deepEqual(styleOf('\x1b[2m'), st({ a: 2 }));
  assert.deepEqual(styleOf('\x1b[3m'), st({ a: 4 }));
  assert.deepEqual(styleOf('\x1b[4m'), st({ a: 8 }));
  assert.deepEqual(styleOf('\x1b[4:3m'), st({ a: 8 }), 'curly underline collapses to on');
  assert.deepEqual(styleOf('\x1b[4m\x1b[4:0m'), D, '4:0 turns underline off');
  assert.deepEqual(styleOf('\x1b[5m'), st({ a: 64 }));
  assert.deepEqual(styleOf('\x1b[7m'), st({ a: 16 }));
  assert.deepEqual(styleOf('\x1b[9m'), st({ a: 32 }));
  assert.deepEqual(styleOf('\x1b[1;3;4;5;7;9m'), st({ a: 125 }));
  assert.deepEqual(styleOf('\x1b[1;2m\x1b[22m'), D, '22 clears bold and dim');
  assert.deepEqual(styleOf('\x1b[1;2;3;4;5;7;9m\x1b[23;24;25;27;29m'), st({ a: 3 }));
  assert.deepEqual(styleOf('\x1b[1;31m\x1b[0m'), D);
  assert.deepEqual(styleOf('\x1b[1;31m\x1b[m'), D, 'empty SGR resets');
  assert.deepEqual(styleOf('\x1b[1;31m\x1b[;1m'), st({ a: 1 }), 'empty parameter means 0');
  assert.deepEqual(styleOf('\x1b[21;1m'), st({ a: 1 }), 'unknown attribute ignored');
});

test('SGR colours', () => {
  assert.deepEqual(styleOf('\x1b[30m'), st({ fg: 'p0' }));
  assert.deepEqual(styleOf('\x1b[31m'), st({ fg: 'p1' }));
  assert.deepEqual(styleOf('\x1b[37m'), st({ fg: 'p7' }));
  assert.deepEqual(styleOf('\x1b[90m'), st({ fg: 'p8' }));
  assert.deepEqual(styleOf('\x1b[97m'), st({ fg: 'p15' }));
  assert.deepEqual(styleOf('\x1b[40m'), st({ bg: 'p0' }));
  assert.deepEqual(styleOf('\x1b[44m'), st({ bg: 'p4' }));
  assert.deepEqual(styleOf('\x1b[100m'), st({ bg: 'p8' }));
  assert.deepEqual(styleOf('\x1b[107m'), st({ bg: 'p15' }));
  assert.deepEqual(styleOf('\x1b[38;5;208m'), st({ fg: 'p208' }));
  assert.deepEqual(styleOf('\x1b[48;5;27m'), st({ bg: 'p27' }));
  assert.deepEqual(styleOf('\x1b[38;5;0m'), st({ fg: 'p0' }));
  assert.deepEqual(styleOf('\x1b[38;5;255m'), st({ fg: 'p255' }));
  assert.deepEqual(styleOf('\x1b[38;5;256m'), D, 'palette index out of range is ignored');
  assert.deepEqual(styleOf('\x1b[38;2;10;200;120m'), st({ fg: '#0ac878' }));
  assert.deepEqual(styleOf('\x1b[48;2;0;0;0m'), st({ bg: '#000000' }));
  assert.deepEqual(styleOf('\x1b[38:2::10:200:120m'), st({ fg: '#0ac878' }), 'colon form with colour-space id');
  assert.deepEqual(styleOf('\x1b[38:2:10:200:120m'), st({ fg: '#0ac878' }), 'colon form without colour-space id');
  assert.deepEqual(styleOf('\x1b[48:2::1:2:3m'), st({ bg: '#010203' }));
  assert.deepEqual(styleOf('\x1b[38:5:208m'), st({ fg: 'p208' }));
  assert.deepEqual(styleOf('\x1b[1;38;5;2;48;2;1;2;3;4m'), st({ fg: 'p2', bg: '#010203', a: 9 }), 'extended colours consume their arguments');
  assert.deepEqual(styleOf('\x1b[31;44m\x1b[39m'), st({ bg: 'p4' }));
  assert.deepEqual(styleOf('\x1b[31;44m\x1b[49m'), st({ fg: 'p1' }));
  assert.deepEqual(styleOf('\x1b[31;44m\x1b[39;49m'), D);
  assert.deepEqual(styleOf('\x1b[58;5;3m'), D, 'underline colour is consumed, not misread as attributes');
  assert.deepEqual(styleOf('\x1b[58;2;1;2;3;1m'), st({ a: 1 }));
  assert.deepEqual(styleOf('\x1b[38;2;1;2m'), D, 'truncated truecolour ignored');
});

test('runs merge on identical style and split on style change', () => {
  assert.deepEqual(line('\x1b[1mbold\x1b[0m plain'), [run(0, 4, 'bold', st({ a: 1 })), run(4, 6, ' plain')]);
  // herdr prefixes every styled run with a reset; equal styles from separate SGRs still merge
  assert.deepEqual(line('\x1b[0m\x1b[1mfoo\x1b[0m\x1b[0m\x1b[1mbar'), [run(0, 6, 'foobar', st({ a: 1 }))]);
  assert.deepEqual(line('a\x1b[31mb\x1b[0mc'), [run(0, 1, 'a'), run(1, 1, 'b', st({ fg: 'p1' })), run(2, 1, 'c')]);
  assert.equal(line('\x1b[31m\x1b[39mx')[0]!.style, D, 'style equal to default is the shared DEFAULT_STYLE object');
});

test('style state persists across newlines (terminal semantics)', () => {
  assert.deepEqual(parseScreen('\x1b[31ma\nb')[1]!.runs, [run(0, 1, 'b', st({ fg: 'p1' }))]);
});

test('lines split on \\n; \\r resets the column and later text overwrites', () => {
  assert.deepEqual(parseScreen('ab\r\ncd').map((r) => r.runs), [[run(0, 2, 'ab')], [run(0, 2, 'cd')]]);
  assert.deepEqual(line('hello\rJ'), [run(0, 5, 'Jello')]);
  assert.deepEqual(line('abc\r\x1b[31mX'), [run(0, 1, 'X', st({ fg: 'p1' })), run(1, 2, 'bc')]);
  assert.equal(parseScreen('').length, 1);
  assert.equal(parseScreen('a\n').length, 2, 'a final newline opens an (empty) row');
});

test('tabs advance to the next multiple of 8 without erasing', () => {
  assert.deepEqual(line('a\tb'), [run(0, 9, 'a       b')]);
  assert.deepEqual(line('\t\tx'), [run(0, 17, `${' '.repeat(16)}x`)]);
  assert.deepEqual(line('1234567\tx'), [run(0, 9, '1234567 x')]);
  assert.deepEqual(line('12345678\tx'), [run(0, 17, '12345678        x')]);
  assert.deepEqual(line('abcdefghij\r\tX'), [run(0, 10, 'abcdefghXj')]);
});

test('other C0/C1 controls are dropped', () => {
  assert.deepEqual(line('a\x07b\x00c\x08d\x7fe\x9bf'), [run(0, 6, 'abcdef')]);
});

test('default-styled trailing blanks are trimmed, styled blanks kept', () => {
  assert.deepEqual(line('abc   '), [run(0, 3, 'abc')]);
  assert.deepEqual(line('\x1b[44m   \x1b[0m'), [run(0, 3, '   ', st({ bg: 'p4' }))]);
  assert.deepEqual(line('abc \x1b[44m  \x1b[0m  '), [run(0, 4, 'abc '), run(4, 2, '  ', st({ bg: 'p4' }))]);
  assert.deepEqual(line('\x1b[1m   \x1b[0m'), [run(0, 3, '   ', st({ a: 1 }))], 'bold blanks are styled blanks');
  assert.deepEqual(line('     '), []);
  assert.deepEqual(line(''), []);
  assert.deepEqual(line('\x1b[31m\x1b[0m'), []);
  assert.deepEqual(line('a\t'), [run(0, 1, 'a')], 'gap left by a tab is trimmed');
  assert.deepEqual(line('\u{A0}'), [run(0, 1, '\u{A0}')], 'NBSP is not a blank');
});

test('wide graphemes are their own w:2 runs', () => {
  assert.deepEqual(line(`a${CJK}b`), [run(0, 1, 'a'), run(1, 2, CJK), run(3, 1, 'b')]);
  assert.deepEqual(line(`${CJK}\u{672C}`), [run(0, 2, CJK), run(2, 2, '\u{672C}')]);
  assert.deepEqual(line('\x1b[1m\u{1F680}\x1b[0m!'), [run(0, 2, '\u{1F680}', st({ a: 1 })), run(2, 1, '!')]);
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
  assert.deepEqual(line(`${family}x`), [run(0, 2, family), run(2, 1, 'x')]);
  assert.deepEqual(line('\u{1F1EF}\u{1F1F5} \u{2764}\u{FE0F}'), [run(0, 2, '\u{1F1EF}\u{1F1F5}'), run(2, 1, ' '), run(3, 2, '\u{2764}\u{FE0F}')]);
});

test('zero-width graphemes attach to the previous cell without adding width', () => {
  assert.deepEqual(line('e\u{301}x'), [run(0, 2, 'e\u{301}x')], 'segmenter keeps base + mark together');
  assert.deepEqual(line('e\x1b[1m\u{301}x'), [run(0, 1, 'e\u{301}'), run(1, 1, 'x', st({ a: 1 }))], 'mark split off by an SGR still attaches left');
  assert.deepEqual(line(`${CJK}\x1b[0m\u{301}x`), [run(0, 2, `${CJK}\u{301}`), run(2, 1, 'x')], 'attaches to a wide glyph');
  assert.deepEqual(line('\u{301}x'), [run(0, 1, 'x')], 'nothing to the left: dropped');
  assert.deepEqual(line('a\t\u{301}x'), [run(0, 9, 'a       x')], 'nothing written to the left: dropped');
  assert.deepEqual(line('a\u{200B}b'), [run(0, 2, 'a\u{200B}b')]);
});

test('overwriting either half of a wide glyph clears the whole glyph', () => {
  assert.deepEqual(line(`${CJK}\rx`), [run(0, 1, 'x')]);
  assert.deepEqual(line(`${CJK}\r x`), [run(0, 2, ' x')]);
  assert.deepEqual(line(`ab\r${CJK}`), [run(0, 2, CJK)]);
  assert.deepEqual(line(`abc\r${CJK}`), [run(0, 2, CJK), run(2, 1, 'c')]);
  assert.deepEqual(line(`a${CJK}\r${CJK}`), [run(0, 2, CJK)]);
  assert.deepEqual(line(`${CJK}b\r x`), [run(0, 3, ' xb')]);
});

test('OSC is stripped silently; other sequences are stripped and counted', () => {
  parseStats.unknownSequences = 0;
  assert.deepEqual(line('\x1b]0;title\x07x'), [run(0, 1, 'x')]);
  assert.deepEqual(line('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), [run(0, 4, 'link')]);
  assert.equal(parseStats.unknownSequences, 0);
  assert.deepEqual(line('\x1b[2Jx\x1b[?25h\x1b[1;1Hy'), [run(0, 2, 'xy')]);
  assert.equal(parseStats.unknownSequences, 3);
  assert.deepEqual(line('\x1b(Ba\x1b=b\x1b>c\x1b7d\x1b#8e'), [run(0, 5, 'abcde')]);
  assert.equal(parseStats.unknownSequences, 8);
  assert.deepEqual(line('\x1b[>4;2mx'), [run(0, 1, 'x')], 'private-parameter m is not SGR');
  assert.equal(parseStats.unknownSequences, 9);
  assert.deepEqual(line('\x1bPdcs\x1b\\x\x1b_apc\x07y'), [run(0, 2, 'xy')]);
  assert.equal(parseStats.unknownSequences, 11);
  assert.deepEqual(line('\x1b[38;5;1 mx'), [run(0, 1, 'x')], 'intermediate byte disqualifies SGR');
  assert.equal(parseStats.unknownSequences, 12);
});

test('truncated sequences at end of input are dropped', () => {
  assert.deepEqual(line('abc\x1b['), [run(0, 3, 'abc')]);
  assert.deepEqual(line('abc\x1b[31'), [run(0, 3, 'abc')]);
  assert.deepEqual(line('abc\x1b'), [run(0, 3, 'abc')]);
  assert.deepEqual(line('abc\x1b]0;unterminated'), [run(0, 3, 'abc')]);
});

test('plainText and rowWidth', () => {
  const rows = parseScreen(`a\t${CJK}\r\n\x1b[44m  \x1b[0m  \r\n\r\n\x1b[1mx\x1b[0m y`);
  assert.equal(plainText(rows), `a       ${CJK}\n\n\nx y`);
  assert.deepEqual(rows.map(rowWidth), [10, 2, 0, 3]);
  assert.equal(rowWidth({ runs: [] }), 0);
  assert.equal(plainText([{ runs: [{ c: 3, w: 1, t: 'x', style: D }] }]), '   x');
});
