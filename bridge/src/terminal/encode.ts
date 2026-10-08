// Row[] → §5.3 wire frames with a per-connection style table.
import { styleKey } from './types.ts';
import { parseScreen } from './ansi.ts';
import { graphemeWidth, segmentGraphemes } from './wcwidth.ts';
import type { Frame, HistoryMessage, Row, Run, ScrollbackMessage, Style, WireLine, WireRun } from './types.ts';

/** Per connection. Id 0 is the default style and is never reported; `takeNew` drains ids assigned since the last call. */
export class StyleTable {
  private readonly ids = new Map<string, number>();
  private fresh: Record<string, Style> = {};
  private nextId = 1;

  idFor(style: Style): number {
    if (style.fg === 'd' && style.bg === 'd' && style.a === 0) return 0;
    const key = styleKey(style);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(key, id);
      this.fresh[String(id)] = { fg: style.fg, bg: style.bg, a: style.a };
    }
    return id;
  }

  /** The style already has an id (the default style always has: 0). */
  has(style: Style): boolean {
    return (style.fg === 'd' && style.bg === 'd' && style.a === 0) || this.ids.has(styleKey(style));
  }

  takeNew(): Record<string, Style> {
    const out = this.fresh;
    this.fresh = {};
    return out;
  }
}

function encodeRuns(row: Row | undefined, table: StyleTable): WireRun[] {
  if (row === undefined) return [];
  return row.runs.map((r) => ({ c: r.c, w: r.w, s: table.idFor(r.style), t: r.t }));
}

export interface FrameOptions {
  pane: string;
  rev: number;
  cols: number;
  rows: number;
  full: boolean;
  /** parsed rows (unpadded); rows at index ≥ length are blank */
  rows_: Row[];
  /** row indices to send when not full */
  changed: number[];
  table: StyleTable;
  /** alternate-screen program in the foreground (see `Frame.alt`); omitted when unknown */
  alt?: boolean | null;
}

export function encodeFrame(o: FrameOptions): Frame {
  const lines: WireLine[] = [];
  if (o.full) for (let y = 0; y < o.rows; y++) lines.push({ y, runs: encodeRuns(o.rows_[y], o.table) });
  else for (const y of o.changed) lines.push({ y, runs: encodeRuns(o.rows_[y], o.table) });
  // styles last: ids are assigned while encoding the lines above
  const frame: Frame = { t: 'frame', pane: o.pane, rev: o.rev, cols: o.cols, rows: o.rows, full: o.full, lines, styles: o.table.takeNew() };
  if (typeof o.alt === 'boolean') frame.alt = o.alt;
  return frame;
}

export function encodeHistory(o: { id: string; pane: string; rows_: Row[]; has_more: boolean; scrollback?: number | null; table: StyleTable }): HistoryMessage {
  const lines = o.rows_.map((row) => ({ runs: encodeRuns(row, o.table) }));
  const msg: HistoryMessage = { t: 'history', id: o.id, pane: o.pane, lines, styles: o.table.takeNew(), has_more: o.has_more };
  if (typeof o.scrollback === 'number') msg.scrollback = o.scrollback;
  return msg;
}

/** Bytes of JSON per `scrollback` message, well under the iOS app's 1 MiB WebSocket message limit. */
export const SCROLLBACK_CHUNK_BYTES = 192 * 1024;
/** A logical line is cut after this many cells (a minified file printed whole): 200 rows on a 50-column phone. */
export const SCROLLBACK_LINE_CELLS = 10_000;

/** The first characters of `t` (whole graphemes) that fit in `cells` cells and `bytes` bytes of JSON string. */
function cutText(t: string, cells: number, bytes = Infinity): { t: string; w: number } {
  let out = '';
  let w = 0;
  let size = 0;
  for (const g of segmentGraphemes(t)) {
    const gw = graphemeWidth(g);
    const gb = Buffer.byteLength(JSON.stringify(g)) - 2;
    if (w + gw > cells || size + gb > bytes) break;
    out += g;
    w += gw;
    size += gb;
  }
  return { t: out, w };
}

/** The row's first `cells` cells; a run that crosses the edge keeps the graphemes that fit. */
function clipRow(row: Row | undefined, cells: number): Row | undefined {
  if (!row || row.runs.every((r) => r.c + r.w <= cells)) return row;
  const runs: Run[] = [];
  for (const r of row.runs) {
    if (r.c + r.w <= cells) {
      runs.push(r);
      continue;
    }
    const cut = r.c < cells ? cutText(r.t, cells - r.c) : null;
    if (cut && cut.t !== '') runs.push({ ...r, ...cut });
    break;
  }
  return { runs };
}

/** JSON bytes of a run on the wire, at most (its `c`, `w` and `s` written out at their widest). */
const RUN_BYTES = 40;
/** JSON bytes of one entry in `styles`, at most (`"123456":{"fg":"#rrggbb","bg":"#rrggbb","a":127}`). */
const STYLE_BYTES = 64;
/** JSON bytes of a line around its runs (`{"runs":[]},`). */
const LINE_BYTES = 12;

/** JSON bytes `runs` add to a message whose new styles so far are `fresh` (style keys). */
function runsBytes(runs: Run[], table: StyleTable, fresh: Set<string>): number {
  let bytes = LINE_BYTES;
  const added = new Set<string>();
  for (const r of runs) {
    bytes += RUN_BYTES + Buffer.byteLength(JSON.stringify(r.t));
    if (table.has(r.style)) continue;
    const key = styleKey(r.style);
    if (!fresh.has(key) && !added.has(key)) {
      added.add(key);
      bytes += STYLE_BYTES;
    }
  }
  return bytes;
}

/**
 * Scrollback lines (ANSI, one logical line each) as one or more `scrollback` messages of at most `maxBytes` of JSON,
 * in order; only the first carries `reset`. Each message reports the style ids its own lines introduced. A line too
 * large for one message keeps its first runs (a style change every few cells), or the start of its one run. Messages
 * are made as they are taken, so a large answer is never held whole.
 */
export function* encodeScrollback(o: { pane: string; epoch: string; start: number; lines: string[]; reset: boolean; table: StyleTable; maxBytes?: number }): Generator<ScrollbackMessage> {
  const max = o.maxBytes ?? SCROLLBACK_CHUNK_BYTES;
  const envelope = 160 + Buffer.byteLength(JSON.stringify(o.pane)) + Buffer.byteLength(JSON.stringify(o.epoch));
  let lines: Array<{ runs: WireRun[] }> = [];
  let fresh = new Set<string>();
  let bytes = envelope;
  let start = o.start;
  let first = true;
  const close = (): ScrollbackMessage => {
    const msg: ScrollbackMessage = { t: 'scrollback', pane: o.pane, epoch: o.epoch, start, lines, styles: o.table.takeNew() };
    if (o.reset && first) msg.reset = true;
    first = false;
    start += lines.length;
    lines = [];
    fresh = new Set();
    bytes = envelope;
    return msg;
  };
  for (const text of o.lines) {
    let runs = clipRow(parseScreen(text)[0], SCROLLBACK_LINE_CELLS)?.runs ?? [];
    let size = runsBytes(runs, o.table, fresh);
    if (lines.length > 0 && bytes + size > max) {
      yield close();
      size = runsBytes(runs, o.table, fresh);
    }
    while (bytes + size > max && runs.length > 1) {
      runs = runs.slice(0, Math.ceil(runs.length / 2));
      size = runsBytes(runs, o.table, fresh);
    }
    if (bytes + size > max && runs.length === 1) {
      const r = runs[0]!;
      runs = [{ ...r, ...cutText(r.t, r.w, Math.max(0, max - bytes - LINE_BYTES - RUN_BYTES - STYLE_BYTES - 2)) }];
      size = runsBytes(runs, o.table, fresh);
    }
    for (const r of runs) if (!o.table.has(r.style)) fresh.add(styleKey(r.style));
    lines.push({ runs: encodeRuns({ runs }, o.table) });
    bytes += size;
  }
  if (lines.length > 0 || first) yield close();
}
