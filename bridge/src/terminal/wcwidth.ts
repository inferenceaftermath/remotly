// Cell widths for grapheme clusters (shared/protocol/remotly-protocol.md §7: clients need no width tables). The bridge decides widths once and ships
// `w` per run so the phone clients need no wcwidth tables of their own.

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function segmentGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

// ECMAScript has no East_Asian_Width property escape, so Wide/Fullwidth blocks are listed here.
// Emoji blocks are deliberately absent: they are width 2 only with Emoji_Presentation (see below).
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo (leading consonants)
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic description, CJK symbols/punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat Jamo, enclosed CJK, compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Ext A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff01, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x17000, 0x18aff], // Tangut, Khitan
  [0x1b000, 0x1b2ff], // Kana supplement/extended, Nushu
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x2fffd], // CJK Ext B–F
  [0x30000, 0x3fffd], // CJK Ext G–H
];

function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true;
  return false;
}

// Combining marks, format characters, ZWSP..RLM, word joiner, variation selectors.
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u{200B}-\u{200F}\u{2060}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}/u;

/** Width in cells of one grapheme cluster: 0 (attaches to the previous cell or is dropped), 1 or 2. */
export function graphemeWidth(g: string): 0 | 1 | 2 {
  const cp = g.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (g.length === 1) {
    if (cp < 0x7f) return 1;
  } else if (g.includes('\u{FE0F}') || g.includes('\u{20E3}') || (g.includes('\u{200D}') && EXTENDED_PICTOGRAPHIC.test(g))) {
    // VS16 requests emoji presentation; keycaps and ZWJ-joined pictographs render as one emoji glyph.
    return 2;
  }
  if (ZERO_WIDTH.test(g)) return 0;
  if (EMOJI_PRESENTATION.test(g)) return 2;
  return isWide(cp) ? 2 : 1;
}
