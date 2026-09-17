import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemeWidth, segmentGraphemes } from '../../src/terminal/wcwidth.ts';

const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';

test('segmentGraphemes keeps clusters together', () => {
  assert.deepEqual(segmentGraphemes(`e\u{301}${FAMILY}${FLAG_JP}a`), ['e\u{301}', FAMILY, FLAG_JP, 'a']);
  assert.deepEqual(segmentGraphemes(''), []);
});

test('graphemeWidth', () => {
  const cases: Array<[string, number, string]> = [
    ['a', 1, 'ascii'],
    [' ', 1, 'space'],
    ['\u{E9}', 1, 'precomposed e-acute'],
    ['e\u{301}', 1, 'e + combining acute'],
    ['\u{FC}', 1, 'u-umlaut'],
    ['\u{65E5}', 2, 'CJK ideograph'],
    ['\u{D55C}', 2, 'Hangul syllable'],
    ['\u{30A2}', 2, 'Katakana'],
    ['\u{FF46}', 2, 'fullwidth f'],
    ['\u{3002}', 2, 'ideographic full stop'],
    ['\u{3000}', 2, 'ideographic space'],
    ['\u{FFE5}', 2, 'fullwidth yen'],
    ['\u{2000B}', 2, 'CJK Ext B'],
    ['\u{1F680}', 2, 'rocket'],
    ['\u{1F389}', 2, 'party popper'],
    [FAMILY, 2, 'ZWJ family'],
    [FLAG_JP, 2, 'flag'],
    ['\u{2764}\u{FE0F}', 2, 'red heart with VS16'],
    ['\u{2764}', 1, 'heart, text presentation'],
    ['#\u{FE0F}\u{20E3}', 2, 'keycap #'],
    ['1\u{20E3}', 2, 'keycap without VS16'],
    ['\u{1F44D}\u{1F3FD}', 2, 'thumbs up + skin tone'],
    ['\u{2705}', 2, 'check mark button'],
    ['\u{2714}', 1, 'heavy check mark (text default)'],
    ['\u{2192}', 1, 'arrow'],
    ['\u{2B50}', 2, 'star'],
    ['\u{2500}', 1, 'box drawing horizontal'],
    ['\u{250C}', 1, 'box drawing corner'],
    ['\u{2502}', 1, 'box drawing vertical'],
    ['\u{2588}', 1, 'full block'],
    ['\u{25B6}', 1, 'black right-pointing triangle'],
    ['\u{280B}', 1, 'braille spinner glyph'],
    ['\u{28FF}', 1, 'braille full'],
    ['\u{E0B0}', 1, 'powerline arrow'],
    ['\u{E0A0}', 1, 'powerline branch'],
    ['\u{E0D4}', 1, 'powerline range end'],
    ['\u{301}', 0, 'lone combining mark'],
    ['\u{200D}', 0, 'ZWJ'],
    ['\u{200B}', 0, 'ZWSP'],
    ['\u{FE0F}', 0, 'VS16 alone'],
    ['\u{2060}', 0, 'word joiner'],
    ['\u{E0100}', 0, 'variation selector supplement'],
    ['\u{AD}', 0, 'soft hyphen (Cf)'],
    ['\x07', 0, 'BEL'],
    ['\x1b', 0, 'ESC'],
    ['\x7f', 0, 'DEL'],
    ['\x9b', 0, 'C1 CSI'],
    ['\t', 0, 'tab'],
  ];
  for (const [g, w, what] of cases) assert.equal(graphemeWidth(g), w, `${what}: ${JSON.stringify(g)}`);
});
