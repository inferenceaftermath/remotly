// Row[] → §5.3 wire frames with a per-connection style table.
import { styleKey } from './types.ts';
import type { Frame, HistoryMessage, Row, Style, WireLine, WireRun } from './types.ts';

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
