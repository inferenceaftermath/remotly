// Regenerates shared/fixtures/frames/<name>.frame.json and <name>.txt from every
// shared/fixtures/reads/<name>.ansi, then reports the 200x50 pipeline benchmark.
// Usage (from bridge/): node scripts/gen-frames.ts
import fs from 'node:fs';
import path from 'node:path';
import { parseScreen, plainText } from '../src/terminal/ansi.ts';
import type { Frame } from '../src/terminal/types.ts';
import { FRAMES_DIR, benchmark, fixtureNames, goldenFrame, loadFixture } from '../test/terminal/fixtures.ts';

// One line per row keeps diffs of the goldens reviewable.
function formatFrame(f: Frame): string {
  const head = (['t', 'pane', 'rev', 'cols', 'rows', 'full'] as const).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(f[k])}`).join(',\n');
  const lines = f.lines.map((l) => `    ${JSON.stringify(l)}`).join(',\n');
  const styles = Object.entries(f.styles)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n');
  return `{\n${head},\n  "lines": [\n${lines}\n  ],\n  "styles": {${styles === '' ? '' : `\n${styles}\n  `}}\n}\n`;
}

fs.mkdirSync(FRAMES_DIR, { recursive: true });
for (const name of fixtureNames()) {
  const f = loadFixture(name);
  const rows = parseScreen(f.ansi);
  const frame = goldenFrame(f, rows);
  fs.writeFileSync(path.join(FRAMES_DIR, `${name}.frame.json`), formatFrame(frame));
  fs.writeFileSync(path.join(FRAMES_DIR, `${name}.txt`), `${plainText(rows)}\n`);
  const runs = frame.lines.reduce((n, l) => n + l.runs.length, 0);
  console.log(`${name}: ${rows.length}/${f.rows} rows, ${runs} runs, ${Object.keys(frame.styles).length} styles, ${JSON.stringify(frame).length} bytes`);
}
const b = benchmark();
console.log(`benchmark 200x50 parse+diff+full encode: median ${b.median.toFixed(2)} ms, max ${b.max.toFixed(2)} ms`);
