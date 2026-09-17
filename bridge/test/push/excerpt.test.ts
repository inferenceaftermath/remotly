import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { finishedExcerpt } from '../../src/push/excerpt.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../shared/fixtures/reads/${name}.txt`, import.meta.url), 'utf8');

// Screens below are typed in, shaped like the real ones (a Claude Code turn, a running tool, a pi turn, `top`),
// so the tests carry no captured session content.
const CLAUDE_CHROME = [
  '',
  '──────────────────────────────────────────────────',
  '❯',
  '──────────────────────────────────────────────────',
  '  [Sonnet 5 · medium] 4% | $0.15 | 14s | +6 -1',
  '  user/remotly/bridge | main',
  '  ⏵⏵ auto mode on · 1 shell · ← for agents',
].join('\n');

test('finished excerpt: Claude Code, the last paragraph of the agent’s message, not the status line under it', () => {
  const screen = [
    '❯ run the suite once more',
    '',
    '⏺ Bash(npm test)',
    '  ⎿  321 passing',
    '',
    '⏺ Right, that was a gap: nothing re-ran the suite after the wiring change. Fixed on both platforms.',
    '',
    '  - Opening a pane now clears its notifications the moment its screen appears.',
    '  - Stuck Live Activities end on their own while the app is open.',
    '',
    '  Build 134 with the token handoff is already on TestFlight from run 34. Run 35 will produce iOS 135 and Android 135 with the',
    '  clearing fix; once 135 processes, both phones update themselves and the stale banners from this morning disappear on the next connect.',
    '',
    '✻ Crunched for 3m 4s · done 8:56 PM · 1 shell still running',
    CLAUDE_CHROME,
  ].join('\n');
  const body = finishedExcerpt(screen);
  assert.ok(body, 'has a body');
  assert.ok(body.startsWith('Build 134 with the token handoff is already on TestFlight from run 34.'), body);
  assert.ok(body.length <= 200 && body.endsWith('…'), 'capped at 200 chars on a word boundary');
  for (const chrome of ['auto mode', '[Sonnet', 'Crunched', '❯', '| main']) assert.ok(!body.includes(chrome), `no "${chrome}" in ${body}`);
});

test('finished excerpt: while a tool runs, the running step’s description (spinner, tip and tool lines dropped)', () => {
  const screen = [
    '⏺ The bridge closed the connection normally, so the crash happened in the app afterwards.',
    '',
    '  Running the bridge test suite after the wiring change',
    "  ⎿  $ node --test 'test/**/*.test.ts' 2>&1 | tail -n 3",
    '  ⎿  Read ../ios/Remotly/Views/PaneView.swift (202 lines)',
    '  ⎿  Read ../ios/FlowKit/Sources/FlowKit/Protocol/ClientMessages.swift (208 lines)',
    '',
    '✽ Transmuting… (8m 8s · ↓ 23.4k tokens)',
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    CLAUDE_CHROME,
  ].join('\n');
  assert.equal(finishedExcerpt(screen), 'Running the bridge test suite after the wiring change');
});

test('finished excerpt: pi turn ends with a one-word answer under the command echo', () => {
  const screen = [
    '$ touch /tmp/marker.txt',
    ' (no output)',
    '',
    ' Took 0.0s',
    '',
    '',
    ' Done.',
    '',
    '──────────────────────────────────────────────────',
    '',
    '──────────────────────────────────────────────────',
    '/tmp/scratch',
    '↑3.2k ↓88 0.2%/1.0M (auto)                                              (provider) provider/model • high',
  ].join('\n');
  assert.equal(finishedExcerpt(screen), 'Done.');
});

test('finished excerpt: a full-screen process table is read from its end', () => {
  const screen = [
    'top - 00:15:47 up 11 days,  6:19,  1 user,  load average: 0.50, 0.57, 0.30',
    'Tasks: 200 total,   1 running, 199 sleeping,   0 stopped,   0 zombie',
    '%Cpu(s):  2.3 us,  0.4 sy,  0.0 ni, 89.8 id,  7.4 wa,  0.0 hi,  0.0 si,  0.0 st',
    'MiB Mem :  16000.0 total,   3500.0 free,   8000.0 used,   4500.0 buff/cache',
    'MiB Swap:   8192.0 total,   8192.0 free,      0.0 used.   7000.0 avail Mem',
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    '   1234 user      20   0 5413184 160792  38472 S  12.7   0.3   0:57.35 node',
    '   2345 user      20   0  276392  42764   9464 S   9.1   0.1   1:05.49 herdr',
    '   3456 user      20   0 5642660 593252  68748 S   9.1   0.9   0:14.57 claude',
    '   4567 user      20   0   14984   5764   3476 R   9.1   0.0   0:00.01 top',
  ].join('\n');
  const body = finishedExcerpt(screen)!;
  assert.ok(body.startsWith('…') && body.endsWith('0:00.01 top') && body.length <= 200, body);
});

test('finished excerpt: a turn that ended without prose falls back to the last tool result', () => {
  assert.equal(finishedExcerpt(fixture('claude-after-deny-esc')), 'Interrupted · What should Claude do instead?');
});

test('finished excerpt: Codex screen', () => {
  assert.ok(finishedExcerpt(fixture('codex-after-deny-esc'))!.startsWith('Conversation interrupted - tell the model what to do differently.'));
});

test('finished excerpt: raw shell output is read from its end and the prompt line is dropped', () => {
  const body = finishedExcerpt(fixture('shell-ls-color'))!;
  assert.ok(body.startsWith('…') && body.endsWith('media proc sbin srv tmp'), body);
  assert.ok(!body.includes('user@host'), body);
  assert.ok(body.length <= 200);
});

test('finished excerpt: idle screens never surface the status/help line', () => {
  for (const name of ['claude-idle', 'codex-idle']) {
    const body = finishedExcerpt(fixture(name));
    assert.ok(body === null || !/manual mode|\[Sonnet|\/effort$|Ask Codex|• high$|Context \d+% used/.test(body), `${name}: ${body}`);
  }
});

test('finished excerpt: edge cases', () => {
  assert.equal(finishedExcerpt(''), null);
  assert.equal(finishedExcerpt('\n\n──────\n❯\n──────\n  [Sonnet 5 · medium] 0% | $0.00\n  /tmp/x |\n  ⏸ manual mode on · ← for agents\n'), null, 'only chrome');
  assert.equal(finishedExcerpt('⏺ Earlier answer.\n\n❯ my new question\n\n──────\n❯\n──────\n'), null, 'the user just asked: nothing from this turn yet');
  assert.equal(finishedExcerpt('⏺ Wrote **excerpt.ts** and\n  wired it up.\n\n⏺ Bash(npm test)\n  ⎿  197 passing\n\n✻ Baked for 2s · done 6:12 AM\n'), 'Wrote excerpt.ts and wired it up.');
  const long = '⏺ ' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const cut = finishedExcerpt(long, 80)!;
  assert.ok(cut.length <= 80 && cut.endsWith('…') && !cut.includes('word1…'), cut);
  assert.equal(finishedExcerpt('┌────────┐\n│ hello  │\n│ world  │\n└────────┘\n'), 'hello world', 'box contents without the border');
});
