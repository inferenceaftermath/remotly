// Row-level diff between two parsed screens (frame rules: shared/protocol/remotly-protocol.md §7).
import type { Row, Run } from './types.ts';

const BLANK: Row = { runs: [] };

function runsEqual(a: Run, b: Run): boolean {
  return a.c === b.c && a.w === b.w && a.t === b.t && a.style.fg === b.style.fg && a.style.bg === b.style.bg && a.style.a === b.style.a;
}

export function rowsEqual(a: Row, b: Row): boolean {
  if (a.runs.length !== b.runs.length) return false;
  for (let i = 0; i < a.runs.length; i++) if (!runsEqual(a.runs[i]!, b.runs[i]!)) return false;
  return true;
}

/**
 * Rows in [0, rows) whose runs differ; indices past either array are blank rows. `full` only when
 * there is no previous screen: herdr trims trailing blank rows from every read, so the parsed row
 * count changes constantly and must not trigger full frames. The caller resets `prev` to null on a
 * grid resize; the encoder owns the 10 s safety-net full frames.
 */
export function diffRows(prev: Row[] | null, next: Row[], rows: number): { changed: number[]; full: boolean } {
  const changed: number[] = [];
  if (prev === null) {
    for (let y = 0; y < rows; y++) changed.push(y);
    return { changed, full: true };
  }
  for (let y = 0; y < rows; y++) {
    if (!rowsEqual(prev[y] ?? BLANK, next[y] ?? BLANK)) changed.push(y);
  }
  return { changed, full: false };
}
