// ANSI → Row[] for one herdr `pane.read format=ansi` (the SGR/OSC subset is pinned down by test/terminal and docs/herdr-findings.md). herdr emits
// SGR only (docs/herdr-findings.md §2), but the parser tolerates a real terminal stream: \r and \t
// move the cursor and later text overwrites, every non-SGR sequence is stripped.
import { ATTR_BLINK, ATTR_BOLD, ATTR_DIM, ATTR_INVERSE, ATTR_ITALIC, ATTR_STRIKE, ATTR_UNDERLINE, DEFAULT_STYLE } from './types.ts';
import type { Color, Row, Run, Style } from './types.ts';
import { graphemeWidth, segmentGraphemes } from './wcwidth.ts';

/** Sequences that are neither SGR nor OSC, since the caller last zeroed the counter (debug logging). */
export const parseStats = { unknownSequences: 0 };

interface Cell {
  t: string;
  w: number;
  style: Style;
}
/** Occupies the second column of a wide glyph. */
const TAIL: Cell = { t: '', w: 0, style: DEFAULT_STYLE };
/** A column never written to; indistinguishable from a default-styled space. */
const BLANK: Cell = { t: ' ', w: 1, style: DEFAULT_STYLE };

const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const SGR_PARAMS = /^[0-9;:]*$/;

function sameStyle(a: Style, b: Style): boolean {
  return a === b || (a.fg === b.fg && a.bg === b.bg && a.a === b.a);
}

class Grid {
  readonly rows: Array<Array<Cell | undefined>> = [];
  private line: Array<Cell | undefined> = [];
  private col = 0;
  private style: Style = DEFAULT_STYLE;

  constructor() {
    this.rows.push(this.line);
  }

  text(s: string): void {
    let from = 0;
    CONTROL.lastIndex = 0;
    for (let m = CONTROL.exec(s); m !== null; m = CONTROL.exec(s)) {
      if (m.index > from) this.print(s.slice(from, m.index));
      from = m.index + 1;
      switch (m[0]) {
        case '\n':
          this.line = [];
          this.rows.push(this.line);
          this.col = 0;
          break;
        case '\r':
          this.col = 0;
          break;
        case '\t':
          this.col = (this.col | 7) + 1;
          break;
        default:
          break; // other C0/C1 controls are dropped
      }
    }
    if (from < s.length) this.print(s.slice(from));
  }

  private print(s: string): void {
    for (const g of segmentGraphemes(s)) {
      const w = graphemeWidth(g);
      if (w === 0) this.attach(g);
      else this.put(g, w);
    }
  }

  private put(t: string, w: number): void {
    const line = this.line;
    while (line.length < this.col + w) line.push(undefined);
    this.erase(this.col);
    if (w === 2) {
      this.erase(this.col + 1);
      line[this.col + 1] = TAIL;
    }
    line[this.col] = { t, w, style: this.style };
    this.col += w;
  }

  // Overwriting either half of a wide glyph blanks the other half, as a terminal does.
  private erase(i: number): void {
    const c = this.line[i];
    if (c === TAIL) this.line[i - 1] = undefined;
    else if (c !== undefined && c.w === 2) this.line[i + 1] = undefined;
    this.line[i] = undefined;
  }

  // Zero-width graphemes join the glyph left of the cursor; with nothing there they are dropped.
  private attach(t: string): void {
    let i = this.col - 1;
    if (i > 0 && this.line[i] === TAIL) i--;
    const c = i >= 0 ? this.line[i] : undefined;
    if (c !== undefined) c.t += t;
  }

  sgr(params: string): void {
    let { fg, bg, a } = this.style;
    const parts = params.split(';');
    for (let i = 0; i < parts.length; i++) {
      const sub = parts[i]!.split(':');
      const n = sub[0] === '' ? 0 : Number(sub[0]);
      switch (n) {
        case 0: fg = 'd'; bg = 'd'; a = 0; break;
        case 1: a |= ATTR_BOLD; break;
        case 2: a |= ATTR_DIM; break;
        case 3: a |= ATTR_ITALIC; break;
        case 4: a = sub[1] === '0' ? a & ~ATTR_UNDERLINE : a | ATTR_UNDERLINE; break; // 4:x styles collapse to on/off
        case 5: a |= ATTR_BLINK; break;
        case 7: a |= ATTR_INVERSE; break;
        case 9: a |= ATTR_STRIKE; break;
        case 22: a &= ~(ATTR_BOLD | ATTR_DIM); break;
        case 23: a &= ~ATTR_ITALIC; break;
        case 24: a &= ~ATTR_UNDERLINE; break;
        case 25: a &= ~ATTR_BLINK; break;
        case 27: a &= ~ATTR_INVERSE; break;
        case 29: a &= ~ATTR_STRIKE; break;
        case 39: fg = 'd'; break;
        case 49: bg = 'd'; break;
        case 38:
        case 48:
        case 58: {
          // Extended colour: `38;5;n`, `38;2;r;g;b`, or colon forms `38:5:n`, `38:2:r:g:b`,
          // `38:2::r:g:b`. 58 (underline colour) is consumed so its arguments are not misread as
          // attributes, but it has no wire representation.
          let args: string[];
          if (sub.length > 1) args = sub.slice(1);
          else {
            args = parts.slice(i + 1, i + 1 + (parts[i + 1] === '2' ? 4 : 2));
            i += args.length;
          }
          const color = extendedColor(args);
          if (color !== undefined) {
            if (n === 38) fg = color;
            else if (n === 48) bg = color;
          }
          break;
        }
        default:
          if (n >= 30 && n <= 37) fg = `p${n - 30}`;
          else if (n >= 40 && n <= 47) bg = `p${n - 40}`;
          else if (n >= 90 && n <= 97) fg = `p${n - 82}`;
          else if (n >= 100 && n <= 107) bg = `p${n - 92}`;
      }
    }
    this.style = fg === 'd' && bg === 'd' && a === 0 ? DEFAULT_STYLE : { fg, bg, a };
  }
}

function extendedColor(args: string[]): Color | undefined {
  if (args[0] === '5') return palette(args[1]);
  if (args[0] !== '2') return undefined;
  // ISO 8613-6 puts a colour-space id before the components (`2::r:g:b`); the common form omits it.
  const [r, g, b] = args.length >= 5 ? args.slice(2, 5) : args.slice(1, 4);
  const rr = channel(r);
  const gg = channel(g);
  const bb = channel(b);
  return rr === undefined || gg === undefined || bb === undefined ? undefined : `#${rr}${gg}${bb}`;
}

function byte(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
}

function palette(s: string | undefined): Color | undefined {
  const n = byte(s);
  return n === undefined ? undefined : `p${n}`;
}

function channel(s: string | undefined): string | undefined {
  return byte(s)?.toString(16).padStart(2, '0');
}

/** Consumes the escape sequence whose ESC is at `i`; returns the index just after it. */
function escape(text: string, i: number, grid: Grid): number {
  const n = text.length;
  const kind = text.charCodeAt(i + 1);
  if (Number.isNaN(kind)) return n;
  if (kind === 0x5b) {
    // CSI: parameter bytes, intermediate bytes, one final byte.
    let j = i + 2;
    while (j < n && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
    const paramsEnd = j;
    while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
    if (j >= n) return n;
    const params = text.slice(i + 2, paramsEnd);
    if (text.charCodeAt(j) === 0x6d && paramsEnd === j && SGR_PARAMS.test(params)) grid.sgr(params);
    else parseStats.unknownSequences++;
    return j + 1;
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    // OSC / DCS / SOS / PM / APC: a string terminated by BEL or ST (ESC \).
    if (kind !== 0x5d) parseStats.unknownSequences++;
    const bel = text.indexOf('\x07', i + 2);
    const st = text.indexOf('\x1b\\', i + 2);
    if (bel === -1 && st === -1) return n;
    if (st === -1 || (bel !== -1 && bel < st)) return bel + 1;
    return st + 2;
  }
  // Two-byte escapes (ESC =, ESC 7, …) and designators with intermediates (ESC ( B, ESC # 8).
  let j = i + 1;
  while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  parseStats.unknownSequences++;
  return Math.min(j + 1, n);
}

function isDefaultBlank(c: Cell | undefined): boolean {
  return c === undefined || (c.t === ' ' && sameStyle(c.style, DEFAULT_STYLE));
}

function toRow(line: Array<Cell | undefined>): Row {
  let end = line.length;
  while (end > 0 && isDefaultBlank(line[end - 1])) end--;
  const runs: Run[] = [];
  let run: Run | undefined;
  for (let i = 0; i < end; i++) {
    const cell = line[i] ?? BLANK;
    if (cell === TAIL) continue;
    if (cell.w === 2) {
      runs.push({ c: i, w: 2, t: cell.t, style: cell.style });
      run = undefined;
    } else if (run !== undefined && sameStyle(run.style, cell.style)) {
      run.t += cell.t;
      run.w++;
    } else {
      run = { c: i, w: 1, t: cell.t, style: cell.style };
      runs.push(run);
    }
  }
  return { runs };
}

/** One visible read → rows of runs. Rows are not padded to the pane height; trailing default blanks are trimmed. */
export function parseScreen(text: string): Row[] {
  const grid = new Grid();
  let i = 0;
  while (i < text.length) {
    const esc = text.indexOf('\x1b', i);
    if (esc === -1) {
      grid.text(text.slice(i));
      break;
    }
    if (esc > i) grid.text(text.slice(i, esc));
    i = escape(text, esc, grid);
  }
  return grid.rows.map(toRow);
}

/** Columns occupied by the row (end of its last run). */
export function rowWidth(row: Row): number {
  const last = row.runs[row.runs.length - 1];
  return last === undefined ? 0 : last.c + last.w;
}

/** Text rendering for tests and the TUI: gaps become spaces, trailing spaces trimmed, rows joined by \n. */
export function plainText(rows: Row[]): string {
  return rows
    .map((row) => {
      let s = '';
      let col = 0;
      for (const r of row.runs) {
        s += ' '.repeat(r.c - col) + r.t;
        col = r.c + r.w;
      }
      return s.replace(/ +$/, '');
    })
    .join('\n');
}
