// The bridge's own copy of a pane's scrollback (shared/protocol/remotly-protocol.md §4 `scrollback`). herdr's API returns
// at most the last 999 rows of a pane, and re-wraps its rows whenever the pane's width changes (a desktop resize, a split,
// a phone's zoom), so the copy keeps *logical* lines (herdr's `recent_unwrapped`): lines that have left the screen, each
// once, in order, numbered by a sequence that only grows. Phones download the whole copy when they open a pane and then
// only the lines appended after it, and wrap the lines to their own width.
import { randomBytes } from 'node:crypto';

/** One herdr read (`format: "ansi"`) as lines: the CRs herdr puts before each newline dropped, no empty tail. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return lines;
}

// SGR and other CSI sequences, OSC strings, and lone escapes: everything that is not a printed character.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** The printed characters of an ANSI line. */
export function plainOf(line: string): string {
  return line.replace(ESCAPES, '');
}

// Everything but SGR: other CSI sequences, OSC strings (a hyperlink's id may differ between reads), lone escapes.
const NOT_SGR = /\x1b\[[0-?]*[ -/]*[@-ln-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Trailing blanks and the SGR codes among them.
const TRAILING = /(?:\s|\x1b\[[0-?]*[ -/]*m)+$/;

/**
 * What two lines of herdr's `recent_unwrapped` reads are compared by: their printed characters and styles, without
 * trailing blanks. herdr writes each logical line from its cells (a reset, then a code where the style changes, none
 * where the line wraps), so the same line reads the same at any width and from any read; lines that differ only in
 * colour are told apart.
 */
export function lineKey(line: string): string {
  return line.replace(NOT_SGR, '').replace(TRAILING, '');
}

/** What a `recent` row and a `visible` row (another source) are compared by: their printed characters. */
function textKey(line: string): string {
  return plainOf(line).trimEnd();
}

const noSpaces = (s: string): string => s.replace(/\s+/g, '');

export interface PaneReads {
  /** `pane.read source=visible` lines: the screen, trailing blank rows trimmed by herdr. */
  visible: string[];
  /** `pane.read source=recent lines=N`: the last N rows of history + screen. */
  recent: string[];
  /** `pane.read source=recent_unwrapped lines=N`: the same N rows with soft-wrapped rows joined. */
  unwrapped: string[];
  /** herdr said `recent` was cut at N rows (older rows exist above the read). */
  truncated: boolean;
  /** N: the rows asked for. herdr counts the whole screen in them, blank rows at its bottom included. */
  requested: number;
  /** The screen's height in rows (`pane.get` → `scroll.viewport_rows`). */
  screenRows: number;
}

export interface HistoryWindow {
  /** Complete logical lines that lie wholly above the screen, oldest first (ANSI, no CR). */
  lines: string[];
  /** The rows each of `lines` takes in herdr at the pane's current width. */
  rows: number[];
  /** History rows below the last of `lines`: the top of a line still partly on the screen (0 when none is). */
  tailRows: number;
  /** The read reached the top of herdr's scrollback: nothing older exists there. */
  complete: boolean;
}

/**
 * The logical lines of a read that have left the screen, or null when the reads do not fit together (output arrived
 * between them; the caller tries again). A line that is still partly on the screen (soft-wrapped across its top edge)
 * is not history yet, and the first line of a truncated read may have lost its beginning, so it is dropped too.
 */
export function historyWindow(r: PaneReads): HistoryWindow | null {
  const { visible, recent, unwrapped } = r;
  // Where the screen starts in the read. A cut read holds N rows of which the last `screenRows` are the screen (its blank
  // bottom rows counted, though not returned); a whole one ends with the screen as `visible` shows it.
  let historyRows: number;
  if (r.truncated) {
    historyRows = r.requested - r.screenRows;
    if (historyRows < 0 || historyRows > recent.length) return null;
  } else {
    if (recent.length < visible.length) return null;
    for (let i = 0; i < visible.length; i++) {
      if (textKey(recent[recent.length - visible.length + i]!) !== textKey(visible[i]!)) return null;
    }
    historyRows = recent.length - visible.length;
  }
  // Map each unwrapped line onto the rows it was wrapped into: the shortest run of rows that spells it (spaces aside:
  // a wide character that did not fit at a row's end leaves a padding cell herdr may or may not print).
  const lines: string[] = [];
  const rows: number[] = [];
  let row = 0;
  for (let i = 0; i < unwrapped.length; i++) {
    const want = noSpaces(plainOf(unwrapped[i]!));
    let got = '';
    let end = row;
    do {
      if (end >= recent.length) return null;
      got += noSpaces(plainOf(recent[end]!));
      end++;
    } while (got !== want && got.length < want.length);
    if (got !== want) {
      // a blank logical line spells nothing: it is one row
      if (want !== '' || got !== '') return null;
    }
    if (end > historyRows) break; // this line reaches the screen: it and everything after it are not history yet
    if (!(i === 0 && r.truncated)) {
      lines.push(unwrapped[i]!);
      rows.push(end - row);
    }
    row = end;
  }
  return { lines, rows, tailRows: Math.max(0, historyRows - row), complete: !r.truncated };
}

/** A line is kept to this many characters, escapes included (phones show 10 000 cells of it: encode.ts). */
export const SCROLLBACK_STORED_LINE_CHARS = 100_000;
/**
 * Characters per line, escapes included, a pane's copy is sized for: it holds at most `max_lines` × this many, oldest
 * lines dropped first, so only lines longer than this on average are kept fewer than `max_lines` (a bound on memory for
 * very long lines: 4 M characters per pane at the default).
 */
export const SCROLLBACK_AVERAGE_LINE_CHARS = 400;
/**
 * The line put into the copy where lines are missing: more output went by between two reads than herdr hands out
 * (999 rows), and what scrolled past before the read's first row cannot be read any more.
 */
export const SCROLLBACK_GAP_LINE = '\x1b[2m··· lines missing here: output went by faster than it could be read ···\x1b[0m';

// An escape sequence a cut ended inside of.
const CUT_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|)$/;

/** The line as the copy keeps it: at most SCROLLBACK_STORED_LINE_CHARS characters, never ending inside an escape. */
export function storedLine(line: string): string {
  if (line.length <= SCROLLBACK_STORED_LINE_CHARS) return line;
  let cut = line.slice(0, SCROLLBACK_STORED_LINE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // half a surrogate pair
  return cut.replace(CUT_ESCAPE, '');
}

/** How many of the copy's last lines must line up with a read before new lines are appended after them. */
const OVERLAP = 6;
/** How far before its end the copy is searched for a read's last lines (lines a wider pane pulled back onto the screen). */
const PULLBACK = 1000;
/** Keys are kept for the copy's last lines only: a read (999 rows at most) is lined up with the copy's end, and the
 *  search for lines pulled back goes PULLBACK lines further. */
const KEYS_KEPT = 4 * PULLBACK;

/** How many lines from the end of `keys` to compare: OVERLAP, and back to the last one with something printed (blank
 *  lines alone prove nothing). 0 when nothing at all is printed. */
function span(keys: string[]): number {
  let i = keys.length - 1;
  while (i >= 0 && keys[i] === '') i--;
  return i < 0 ? 0 : Math.max(OVERLAP, keys.length - i);
}

/** How far back from `ai` / `bi` the keys of `a` and `b` agree, up to `max`. */
function agreeing(a: string[], ai: number, b: string[], bi: number, max: number): number {
  let k = 0;
  while (k < max && a[ai - k] === b[bi - k]) k++;
  return k;
}

/** The `k` keys of `a` ending at `ai` equal the `k` of `b` ending at `bi`, and at least one of them is printed. */
function sameRun(a: string[], ai: number, b: string[], bi: number, k: number): boolean {
  let inked = false;
  for (let t = 0; t < k; t++) {
    const key = a[ai - t]!;
    if (key !== b[bi - t]) return false;
    if (key !== '') inked = true;
  }
  return inked;
}

/** How many rows herdr's history grew by between two reads: at least, at most, and most likely. */
export interface RowGrowth {
  least: number;
  most: number;
  likely: number;
}

export interface MergeResult {
  /** The copy was replaced (new epoch): the phones drop theirs and take `lines` from `start` 0. */
  reset: boolean;
  /** Sequence number of `lines[0]`. */
  start: number;
  lines: string[];
  /** No overlap was found in a truncated read: lines between the copy and the read were never seen. */
  gap: boolean;
}

/**
 * Line numbers stay within a signed 32-bit integer (the Android app decodes them as `Int`): a copy whose next number
 * would pass it starts numbering again from 0 under a new epoch, keeping its lines, which phones take as a reset.
 */
export const SCROLLBACK_MAX_LINE_NUMBER = 2 ** 31 - 1;

export class ScrollbackCopy {
  epoch = newEpoch();
  /** Sequence number of `lines[0]`; grows as the oldest lines are dropped past `maxLines`. */
  base = 0;
  readonly lines: string[] = [];
  /** `lineKey` of the copy's last lines (at most KEYS_KEPT of them): `keys.at(-1)` is the last line's. */
  private readonly keys: string[] = [];
  readonly maxLines: number;
  private readonly maxChars: number;
  /** Characters held in `lines`. */
  private chars = 0;
  /** Lines after the last SCROLLBACK_GAP_LINE (Infinity with none): only those are lined up with later reads. */
  private sinceGap = Infinity;
  /** `tailRows` of the read the copy's end was last lined up with (null when it was not: see `merge`). */
  private tailRows: number | null = null;

  constructor(maxLines: number, maxChars = maxLines * SCROLLBACK_AVERAGE_LINE_CHARS) {
    this.maxLines = maxLines;
    this.maxChars = maxChars;
  }

  /** Sequence number the next appended line gets. */
  get next(): number {
    return this.base + this.lines.length;
  }

  /**
   * Fold a read of the history into the copy: the lines after the copy's last line are appended. `null` when nothing
   * changed, or when the copy is ahead of the read (see `runsPast`). A read that neither contains the copy's last lines
   * nor ends inside the copy (whole or cut) is appended after a gap line (SCROLLBACK_GAP_LINE): it never restarts the
   * copy (`restart`, on a wipe the caller saw). `canRetryWider` asks the caller to read more rows first. `grown`: how
   * many rows herdr's history grew by since the read before (null when not known), to tell apart places in a read of
   * repeated output.
   */
  merge(window: HistoryWindow, canRetryWider: boolean, grown: RowGrowth | null = null): MergeResult | 'wider' | null {
    const w = { ...window, lines: window.lines.map(storedLine) };
    const tailRows = this.tailRows;
    this.tailRows = null;
    if (this.lines.length === 0) {
      if (w.lines.length === 0) return null;
      this.tailRows = w.tailRows;
      return this.append(w.lines, false, false);
    }
    if (w.lines.length === 0) return null; // nothing wholly above the screen to line up with yet
    const keys = w.lines.map(lineKey);
    // the rows after the copy's last line now: those new since the read before, and the top rows of the line that was
    // then partly on the screen
    const expected: RowGrowth | null =
      grown !== null && tailRows !== null ? { least: grown.least + tailRows, most: grown.most + tailRows, likely: grown.likely + tailRows } : null;
    const { at, short } = this.overlapEnd(keys, w.rows, expected);
    if (short && canRetryWider) {
      this.tailRows = tailRows; // nothing changed: the wider read is lined up as this one would have been
      return 'wider';
    }
    if (at !== null) {
      this.tailRows = w.tailRows;
      const fresh = w.lines.slice(at + 1);
      return fresh.length === 0 ? null : this.append(fresh, false, false);
    }
    // herdr's history grew: output was added, so a read ending with lines the copy has is repeated output, not lines a
    // wider pane pulled back
    if (!(grown !== null && grown.least > 0) && this.runsPast(keys)) return null;
    if (canRetryWider) {
      this.tailRows = tailRows;
      return 'wider';
    }
    this.tailRows = w.tailRows;
    // herdr no longer holds the copy's last lines: more went by than one read holds, or all of herdr's history turned
    // over between two reads (a byte-capped history of fewer rows than a read covers), or a `clear` was refilled before
    // a read saw it empty. What is left of the output follows a line saying lines are missing; later reads are lined up
    // with the lines after it. Only a wipe seen as one restarts the copy (ScrollbackKeeper's clear check: nothing above
    // the screen, the shell in front): the lines it holds are nowhere else.
    return this.append([SCROLLBACK_GAP_LINE, ...w.lines], false, true);
  }

  /**
   * Index in the read of the copy's last line: a place where the copy's last lines (OVERLAP of them at least, or all
   * of a shorter copy) are the read's lines up to it. Repeated output can line up in several places. The likeliest
   * is one where everything in the read before it is also the copy's (the read starts inside the copy, so all of its
   * older part should agree); among several such, the one leaving as many rows after it as herdr's history grew by
   * (`expected`: within its bounds, nearest the likely count); then the latest. With no place agreeing back to the
   * read's start (herdr dropped a line), the longest run wins. `short`: several places fit and the read is too short to
   * hold as many new rows as herdr likely added, so the right place may lie before it (read more rows).
   */
  private overlapEnd(keys: string[], rows: number[], expected: RowGrowth | null): { at: number | null; short: boolean } {
    const own = this.linedUp();
    const n = own.length;
    const need = span(own);
    if (need === 0) {
      // a copy of blank lines only: blank lines are all there is to go by. The blank lines a read starts with agree with
      // it all the way back: among those, herdr's row growth decides as below; else the latest blank line.
      let ink = keys.findIndex((key) => key !== '');
      if (ink < 0) ink = keys.length;
      if (expected !== null && ink > 0) {
        let best = ink - 1;
        let bestScore = Infinity;
        let after = rows.slice(ink).reduce((a, b) => a + b, 0);
        for (let j = ink - 1; j >= 0; j--) {
          const score = Math.max(0, expected.least - after, after - expected.most) * 1e9 + Math.abs(after - expected.likely);
          if (score < bestScore) {
            best = j;
            bestScore = score;
          }
          after += rows[j] ?? 1;
        }
        return { at: best, short: false };
      }
      for (let j = keys.length - 1; j >= 0; j--) if (keys[j] === '') return { at: j, short: false };
      return { at: null, short: false };
    }
    const k = Math.min(need, n);
    let best: number | null = null;
    let bestWhole = false;
    let bestScore = Infinity; // distance from `expected` for whole places, minus the run's length for the others
    let after = 0; // rows after j in the read
    let wholes = 0;
    for (let j = keys.length - 1; j >= k - 1; j--) {
      if (j < keys.length - 1) after += rows[j + 1] ?? 1;
      if (!sameRun(keys, j, own, n - 1, k)) continue;
      const max = Math.min(j + 1, n);
      const run = k + agreeing(keys, j - k, own, n - 1 - k, max - k);
      const whole = run === max;
      if (whole) wholes++;
      let score = -run;
      if (whole) {
        const outside = expected === null ? 0 : Math.max(0, expected.least - after, after - expected.most);
        score = expected === null ? 0 : outside > 0 ? 1e9 + outside : Math.abs(after - expected.likely);
      }
      if (best === null || (whole && !bestWhole) || (whole === bestWhole && score < bestScore)) {
        best = j;
        bestWhole = whole;
        bestScore = score;
      }
    }
    // `after` now counts the rows after the earliest place a read this long can show
    return { at: best, short: wholes > 1 && expected !== null && expected.likely > after };
  }

  /**
   * The read ends with lines the copy holds before its own end: the copy is ahead of herdr. A pane made wider re-wraps
   * into fewer rows and pulls the newest history lines back onto its screen; they leave it again later and are found
   * then. A read with nothing printed in it is no evidence either way and is let be too.
   */
  private runsPast(keys: string[]): boolean {
    const need = span(keys);
    if (need === 0) return true;
    const own = this.linedUp();
    const m = keys.length;
    const n = own.length;
    for (let i = n - 2; i >= Math.max(0, n - 1 - PULLBACK); i--) {
      if (sameRun(own, i, keys, m - 1, Math.min(need, m, i + 1))) return true;
    }
    return false;
  }

  private append(lines: string[], reset: boolean, gap: boolean): MergeResult {
    const start = this.next;
    for (const l of lines) {
      this.lines.push(l);
      this.keys.push(lineKey(l));
      this.chars += l.length;
    }
    this.sinceGap = gap ? lines.length - 1 : this.sinceGap + lines.length;
    // past maxLines lines or maxChars characters the oldest go (the newest line always stays)
    let over = Math.max(0, this.lines.length - this.maxLines);
    let chars = this.chars;
    for (let i = 0; i < over; i++) chars -= this.lines[i]!.length;
    while (chars > this.maxChars && over < this.lines.length - 1) {
      chars -= this.lines[over]!.length;
      over++;
    }
    if (over > 0) {
      this.lines.splice(0, over);
      this.base += over;
      this.chars = chars;
    }
    const keyed = Math.min(this.lines.length, KEYS_KEPT);
    if (this.keys.length > keyed) this.keys.splice(0, this.keys.length - keyed);
    if (this.next > SCROLLBACK_MAX_LINE_NUMBER) {
      this.epoch = newEpoch();
      this.base = 0;
      return { reset: true, start: 0, lines: this.lines.slice(), gap };
    }
    // lines already dropped again (a single read larger than the cap) are not reported
    const skip = Math.max(0, this.base - start);
    return { reset, start: start + skip, lines: lines.slice(skip), gap };
  }

  /** Start over under a new epoch, empty (the pane's history was wiped while nothing was above its screen). */
  restart(): void {
    this.tailRows = null;
    this.epoch = newEpoch();
    this.base = 0;
    this.lines.length = 0;
    this.keys.length = 0;
    this.chars = 0;
    this.sinceGap = Infinity;
  }

  /** The keys later reads are lined up with: the copy's last ones, after its last gap line (herdr never shows that
   *  line, nor the lines before it next to the ones after it). */
  private linedUp(): string[] {
    return this.sinceGap < this.keys.length ? this.keys.slice(this.keys.length - this.sinceGap) : this.keys;
  }

  /**
   * The copy's last lines (OVERLAP of them, or all of a shorter copy) are among `lines` (a pane's screen, as logical
   * lines), in order: a pane made wider pulled its history back onto the screen, which wiped nothing.
   */
  endsAmong(lines: string[]): boolean {
    const own = this.linedUp();
    const n = own.length;
    const need = Math.min(span(own), n);
    if (need === 0) return false;
    const keys = lines.map((l) => lineKey(storedLine(l)));
    for (let j = keys.length - 1; j >= need - 1; j--) if (sameRun(keys, j, own, n - 1, need)) return true;
    return false;
  }

  /** Lines from sequence number `from` on (clamped to what is still held). */
  since(from: number): { start: number; lines: string[] } {
    const start = Math.min(Math.max(from, this.base), this.next);
    return { start, lines: this.lines.slice(start - this.base) };
  }
}

function newEpoch(): string {
  return randomBytes(6).toString('hex');
}
