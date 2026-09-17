// Shared by test/terminal/fixtures.test.ts and scripts/gen-frames.ts so goldens and tests agree.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseScreen } from '../../src/terminal/ansi.ts';
import { diffRows } from '../../src/terminal/differ.ts';
import { StyleTable, encodeFrame } from '../../src/terminal/encode.ts';
import type { Frame, Row } from '../../src/terminal/types.ts';

export const READS_DIR = path.resolve(import.meta.dirname, '../../../shared/fixtures/reads');
export const FRAMES_DIR = path.resolve(import.meta.dirname, '../../../shared/fixtures/frames');

export interface Fixture {
  name: string;
  ansi: string;
  txt: string;
  cols: number;
  rows: number;
}

export function fixtureNames(): string[] {
  return fs
    .readdirSync(READS_DIR)
    .filter((f) => f.endsWith('.ansi'))
    .map((f) => f.slice(0, -'.ansi'.length))
    .sort();
}

export function loadFixture(name: string): Fixture {
  const read = (ext: string) => fs.readFileSync(path.join(READS_DIR, `${name}.${ext}`), 'utf8');
  const meta = JSON.parse(read('json')) as { pty: { rows: number; cols: number } | null; rect: { width: number; height: number } };
  // Exact PTY size when the capture could measure it, else the layout rect (herdr-findings §3).
  const cols = meta.pty?.cols ?? meta.rect.width - 1;
  const rows = meta.pty?.rows ?? meta.rect.height;
  return { name, ansi: read('ansi'), txt: read('txt'), cols, rows };
}

/** The golden full frame: fresh style table, fixture name as pane id, rev 1. */
export function goldenFrame(f: Fixture, rows: Row[]): Frame {
  return encodeFrame({ pane: f.name, rev: 1, cols: f.cols, rows: f.rows, full: true, rows_: rows, changed: [], table: new StyleTable() });
}

/** Worst-case-ish screen: every 10 columns a new colour, some CJK and emoji. `cols` must be a multiple of 10. */
export function syntheticScreen(cols: number, rows: number): string {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols / 10; x++) {
      const k = y * 20 + x;
      const text = k % 4 === 0 ? '\u{65E5}\u{672C}\u{8A9E}\u{1F680} x' : `w${String(k % 1000).padStart(3, '0')} abcd `;
      line += `\x1b[0m\x1b[1m\x1b[38;5;${k % 256}m${text}\x1b[0m`;
    }
    lines.push(line);
  }
  return lines.join('\r\n');
}

/** Parse + diff + full encode (fresh style table) of a 200x50 screen; returns per-iteration ms. */
export function benchmark(iterations = 40): { median: number; max: number } {
  const screen = syntheticScreen(200, 50);
  let prev = parseScreen(screen);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const rows = parseScreen(screen);
    const d = diffRows(prev, rows, 50);
    encodeFrame({ pane: 'bench', rev: i, cols: 200, rows: 50, full: true, rows_: rows, changed: d.changed, table: new StyleTable() });
    samples.push(performance.now() - t0);
    prev = rows;
  }
  samples.sort((a, b) => a - b);
  return { median: samples[iterations >> 1]!, max: samples[iterations - 1]! };
}
