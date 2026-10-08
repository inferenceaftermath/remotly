import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentLogger } from '../../src/log.ts';
import { SCROLLBACK_CLEAR_CHECK_MAX_MS, SCROLLBACK_CLEAR_CHECK_MS, SCROLLBACK_POKE_MS, SCROLLBACK_RECHECK_MS, ScrollbackKeeper, type ScrollbackUpdate } from '../../src/server/scrollback.ts';
import { FakeTerminal } from '../terminal/fake-terminal.ts';
import { SCROLLBACK_GAP_LINE } from '../../src/terminal/scrollback.ts';

const numbered = (from: number, count: number): string[] => Array.from({ length: count }, (_, i) => `L${String(from + i).padStart(4, '0')}`);

function setup(panes: Record<string, FakeTerminal>, maxLines = 10_000) {
  const calls: string[] = [];
  let now = 1_000_000;
  let up = true;
  const keeper = new ScrollbackKeeper({ request: FakeTerminal.request(panes, calls), isUp: () => up, log: silentLogger, maxLines, now: () => now });
  const updates: ScrollbackUpdate[] = [];
  keeper.on('update', (u: ScrollbackUpdate) => updates.push(u));
  return {
    keeper,
    calls,
    updates,
    advance: (ms: number) => (now += ms),
    setUp: (v: boolean) => (up = v),
  };
}

test('keeper: a pane is read when its rows above the screen change, and only the new lines go out', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 50));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  assert.equal(k.updates.length, 1);
  assert.deepEqual(k.updates[0], { pane: 'w1:p1', epoch: k.keeper.copyOf('w1:p1')!.epoch, reset: false, start: 0, lines: numbered(0, 45), gap: false });
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list'], 'nothing moved: no read');
  t.print(...numbered(50, 10));
  await k.keeper.tick();
  assert.equal(k.updates.length, 2);
  assert.equal(k.updates[1]!.start, 45);
  assert.deepEqual(k.updates[1]!.lines, numbered(45, 10));
  // the follow-up read asks for the new rows, the screen and some slack, not herdr's maximum
  assert.ok(k.calls.includes('pane.read:recent:79'), k.calls.join(' '));
  assert.deepEqual(k.keeper.copyOf('w1:p1')!.lines, numbered(0, 55));
});

test('keeper: a pane at rest is read again after a while (a full scrollback scrolls without growing)', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  k.calls.length = 0;
  k.advance(SCROLLBACK_RECHECK_MS);
  await k.keeper.tick();
  assert.ok(k.calls.some((c) => c.startsWith('pane.read:recent:')));
});

test('keeper: nothing above the screen with a full-screen program up leaves the copy as it is; it continues after', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  const epoch = k.keeper.copyOf('w1:p1')!.epoch;
  t.alt = true;
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list', 'pane.process_info'], 'a program has the terminal: not a wipe');
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list'], 'asked again only after a while');
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list', 'pane.list'], 'each check that finds no wipe doubles the wait');
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list', 'pane.list', 'pane.list', 'pane.process_info']);
  assert.equal(k.updates.length, 1);
  t.alt = false;
  t.print(...numbered(20, 3));
  await k.keeper.tick();
  const last = k.updates.at(-1)!;
  assert.equal(last.reset, false);
  assert.equal(last.epoch, epoch);
  assert.deepEqual(last.lines, numbered(15, 3));
});

test('keeper: `clear` at the shell restarts the copy, empty, under a new epoch; new lines continue it', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  const epoch = k.keeper.copyOf('w1:p1')!.epoch;
  t.clear();
  await k.keeper.tick();
  const wiped = k.updates.at(-1)!;
  assert.deepEqual({ ...wiped, epoch: '' }, { pane: 'w1:p1', epoch: '', reset: true, start: 0, lines: [], gap: false });
  assert.notEqual(wiped.epoch, epoch);
  assert.equal(k.keeper.copyOf('w1:p1')!.lines.length, 0);
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list'], 'an empty copy has nothing to wipe');
  t.print(...numbered(900, 12));
  await k.keeper.tick();
  const last = k.updates.at(-1)!;
  assert.deepEqual(last, { pane: 'w1:p1', epoch: wiped.epoch, reset: false, start: 0, lines: numbered(900, 7), gap: false });
});

test('keeper: `clear` then a full-screen program — the copy restarts once the shell is back with nothing above the screen', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  t.clear();
  t.alt = true; // `clear; vim`: vim was up before the keeper looked
  await k.keeper.tick();
  assert.equal(k.updates.length, 1);
  t.alt = false;
  k.advance(SCROLLBACK_CLEAR_CHECK_MAX_MS);
  await k.keeper.tick();
  assert.equal(k.updates.length, 2);
  assert.equal(k.updates[1]!.reset, true);
  // a program that is not full-screen (`clear` itself, still running) is not taken for one that left history behind
  t.print(...numbered(0, 20));
  await k.keeper.tick();
  t.clear();
  t.busy = true;
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  const before = k.updates.length;
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, ['pane.list', 'pane.process_info']);
  assert.equal(k.updates.length, before);
  t.busy = false;
  k.advance(SCROLLBACK_CLEAR_CHECK_MAX_MS);
  await k.keeper.tick();
  assert.equal(k.updates.at(-1)!.reset, true);
});

test('keeper: the wait between checks stops growing at its cap and starts over when the watched screen changes', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  t.alt = true;
  const checks = () => k.calls.filter((c) => c === 'pane.process_info').length;
  await k.keeper.tick(); // the first check, at once
  for (let i = 0; i < 6; i++) {
    k.advance(SCROLLBACK_CLEAR_CHECK_MAX_MS);
    await k.keeper.tick();
  }
  assert.equal(checks(), 7, 'one each time the cap has passed');
  k.calls.length = 0;
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  await k.keeper.tick();
  assert.equal(checks(), 0, 'still the longest wait');
  k.keeper.poke('w1:p1'); // the watched pane's screen changed
  await k.keeper.tick();
  assert.equal(checks(), 1, 'back to the shortest wait');
  await new Promise((r) => setTimeout(r, SCROLLBACK_POKE_MS + 30)); // the poke's own read: nothing due
  assert.equal(checks(), 1);
});

test('keeper: a pane made wider that pulls all of its history back onto the screen is not taken for `clear`', async () => {
  const t = new FakeTerminal(10, 12);
  t.print(...Array.from({ length: 8 }, (_, i) => `line ${i} ${'x'.repeat(12)}`)); // 3 rows each at 10 columns
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  const copy = k.keeper.copyOf('w1:p1')!;
  assert.ok(copy.lines.length > 0);
  const epoch = copy.epoch;
  t.cols = 40; // one row each now: everything fits on the screen
  assert.equal(t.historyRows, 0);
  k.advance(SCROLLBACK_CLEAR_CHECK_MS);
  k.calls.length = 0;
  await k.keeper.tick();
  assert.ok(k.calls.includes('pane.read:recent_unwrapped:999'), k.calls.join(' '));
  assert.equal(k.updates.length, 1);
  assert.equal(k.keeper.copyOf('w1:p1')!.epoch, epoch);
  // and `clear` after it still is one
  t.clear();
  k.advance(SCROLLBACK_CLEAR_CHECK_MAX_MS);
  await k.keeper.tick();
  assert.equal(k.updates.at(-1)!.reset, true);
});

test('keeper: a program that takes the terminal while the clear check reads the screen does not wipe the copy', async () => {
  const t = new FakeTerminal(10, 12);
  t.print(...Array.from({ length: 8 }, (_, i) => `line ${i} ${'x'.repeat(12)}`)); // 3 rows each at 10 columns
  const panes: Record<string, FakeTerminal> = { 'w1:p1': t };
  const base = FakeTerminal.request(panes, []);
  let vimOnRead = false;
  const keeper = new ScrollbackKeeper({
    request: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (vimOnRead && method === 'pane.read' && params?.['source'] === 'recent_unwrapped' && params['lines'] === 999) {
        vimOnRead = false;
        t.busy = true; // vim started between the checks and the read: the read is its screen
        return { read: { pane_id: 'w1:p1', source: 'recent_unwrapped', format: 'ansi', text: '~\r\n~\r\n"notes" 2L', revision: 1, truncated: false } } as T;
      }
      return base<T>(method, params);
    },
    isUp: () => true,
    log: silentLogger,
    maxLines: 10_000,
  });
  const updates: ScrollbackUpdate[] = [];
  keeper.on('update', (x: ScrollbackUpdate) => updates.push(x));
  await keeper.tick();
  const copy = keeper.copyOf('w1:p1')!;
  const lines = [...copy.lines];
  t.cols = 40; // nothing above the screen now, the shell in front
  vimOnRead = true;
  await keeper.current('w1:p1');
  assert.deepEqual(keeper.copyOf('w1:p1')!.lines, lines);
  assert.equal(keeper.copyOf('w1:p1')!.epoch, copy.epoch);
  assert.equal(updates.filter((x) => x.reset).length, 0);
});

test('keeper: output that scrolls while the clear check reads the screen does not wipe the copy', async () => {
  const t = new FakeTerminal(10, 12);
  t.print(...Array.from({ length: 8 }, (_, i) => `line ${i} ${'x'.repeat(12)}`)); // 3 rows each at 10 columns
  const panes: Record<string, FakeTerminal> = { 'w1:p1': t };
  const base = FakeTerminal.request(panes, []);
  let outputOnRead = false;
  const keeper = new ScrollbackKeeper({
    request: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (outputOnRead && method === 'pane.read' && params?.['source'] === 'recent_unwrapped' && params['lines'] === 999) {
        outputOnRead = false;
        t.print(...Array.from({ length: 1200 }, (_, i) => `new ${i}`)); // more than one read holds, the shell in front again after
      }
      return base<T>(method, params);
    },
    isUp: () => true,
    log: silentLogger,
    maxLines: 10_000,
  });
  const updates: ScrollbackUpdate[] = [];
  keeper.on('update', (x: ScrollbackUpdate) => updates.push(x));
  await keeper.tick();
  const copy = keeper.copyOf('w1:p1')!;
  const lines = [...copy.lines];
  t.cols = 40; // nothing above the screen now, the shell in front
  outputOnRead = true;
  await keeper.current('w1:p1');
  assert.equal(updates.filter((x) => x.reset).length, 0);
  assert.equal(keeper.copyOf('w1:p1')!.epoch, copy.epoch);
  assert.deepEqual(keeper.copyOf('w1:p1')!.lines.slice(0, lines.length), lines);
});

test('keeper: a pane id that now names another terminal sends the phones an empty copy at once', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const panes: Record<string, FakeTerminal> = { 'w1:p1': t };
  const k = setup(panes);
  await k.keeper.tick();
  const u = new FakeTerminal(20, 5);
  u.terminalId = 't2';
  panes['w1:p1'] = u; // a fresh shell: nothing above its screen
  await k.keeper.tick();
  const last = k.updates.at(-1)!;
  assert.deepEqual({ ...last, epoch: '' }, { pane: 'w1:p1', epoch: '', reset: true, start: 0, lines: [], gap: false });
  assert.equal(last.epoch, k.keeper.copyOf('w1:p1')!.epoch);
});

test('keeper: a read that the pane id moved to another terminal during is not folded into the old copy', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const panes: Record<string, FakeTerminal> = { 'w1:p1': t };
  const u = new FakeTerminal(20, 5);
  u.terminalId = 't2';
  u.print(...numbered(500, 30));
  let swapOnRead = false;
  const base = FakeTerminal.request(panes, []);
  const keeper = new ScrollbackKeeper({
    request: <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (swapOnRead && method === 'pane.read') {
        swapOnRead = false;
        panes['w1:p1'] = u; // herdr restarted between the count and the reads
      }
      return base<T>(method, params);
    },
    isUp: () => true,
    log: silentLogger,
    maxLines: 10_000,
  });
  const updates: ScrollbackUpdate[] = [];
  keeper.on('update', (x: ScrollbackUpdate) => updates.push(x));
  await keeper.tick();
  const epoch = keeper.copyOf('w1:p1')!.epoch;
  t.print(...numbered(20, 5));
  swapOnRead = true;
  await keeper.tick();
  assert.equal(updates.length, 1, 'nothing from the new terminal under the old epoch');
  assert.deepEqual(keeper.copyOf('w1:p1')!.lines, numbered(0, 15));
  await keeper.tick();
  const reset = updates.find((x) => x.reset);
  assert.ok(reset, 'the next round starts the new terminal over');
  assert.notEqual(reset.epoch, epoch);
  assert.ok(updates.every((x) => x.epoch !== epoch || x.lines.every((l) => !l.startsWith('L05'))));
});

test('keeper: a phone asking for the copy of a pane wiped a moment ago gets the empty restarted copy', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  const first = await k.keeper.current('w1:p1');
  const epoch = first!.epoch;
  t.clear();
  const copy = await k.keeper.current('w1:p1');
  assert.equal(copy!.lines.length, 0);
  assert.notEqual(copy!.epoch, epoch);
});

test('keeper: more lines between two reads than herdr returns → appended after a gap, nothing twice', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  t.print(...numbered(20, 3000));
  await k.keeper.tick();
  const last = k.updates.at(-1)!;
  assert.equal(last.gap, true);
  const lines = k.keeper.copyOf('w1:p1')!.lines;
  assert.equal(new Set(lines).size, lines.length);
  assert.equal(lines.at(-1), 'L3014');
  assert.equal(lines.filter((l) => l === SCROLLBACK_GAP_LINE).length, 1, 'one line says where lines are missing');
});

test('keeper: all of a byte-capped history turning over between two reads goes in after a gap; the copy is not restarted', async () => {
  // herdr's history holds fewer rows than one read covers, so every read is whole; output fills all of it between reads
  const t = new FakeTerminal(20, 5);
  t.historyLimit = 30;
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  await k.keeper.tick();
  const epoch = k.keeper.copyOf('w1:p1')!.epoch;
  t.print(...numbered(20, 100));
  assert.equal(t.read('w1:p1', 'recent', 999).truncated, false);
  await k.keeper.tick();
  const last = k.updates.at(-1)!;
  assert.deepEqual({ reset: last.reset, gap: last.gap, epoch: last.epoch }, { reset: false, gap: true, epoch });
  const lines = k.keeper.copyOf('w1:p1')!.lines;
  assert.deepEqual(lines.slice(0, 16), numbered(0, 15).concat(SCROLLBACK_GAP_LINE), 'the lines held before are kept');
  assert.deepEqual(lines.slice(16), numbered(85, 30));
});

test('keeper: the copy holds maxLines lines, numbered on', async () => {
  const t = new FakeTerminal(20, 5);
  const k = setup({ 'w1:p1': t }, 1000);
  for (let i = 0; i < 6; i++) {
    t.print(...numbered(i * 500, 500));
    await k.keeper.tick();
  }
  const copy = k.keeper.copyOf('w1:p1')!;
  assert.equal(copy.lines.length, 1000);
  assert.equal(copy.next, 2995);
  assert.equal(copy.base, 1995);
  assert.equal(copy.lines[0], 'L1995');
});

test('keeper: a pane id that names a new terminal starts a new copy; a pane that is gone is forgotten', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const panes: Record<string, FakeTerminal> = { 'w1:p1': t };
  const k = setup(panes);
  await k.keeper.tick();
  const before = k.keeper.copyOf('w1:p1')!;
  const u = new FakeTerminal(20, 5);
  u.terminalId = 't2';
  u.print(...numbered(0, 20));
  panes['w1:p1'] = u;
  await k.keeper.tick();
  const after = k.keeper.copyOf('w1:p1')!;
  assert.notEqual(after, before);
  assert.notEqual(after.epoch, before.epoch);
  assert.deepEqual(after.lines, numbered(0, 15));
  delete panes['w1:p1'];
  await k.keeper.tick();
  assert.equal(k.keeper.copyOf('w1:p1'), null);
});

test('keeper: current() reads now; poke() reads soon; herdr down → no ticks', async () => {
  const t = new FakeTerminal(20, 5);
  t.print(...numbered(0, 20));
  const k = setup({ 'w1:p1': t });
  const copy = await k.keeper.current('w1:p1');
  assert.deepEqual(copy?.lines, numbered(0, 15));
  t.print(...numbered(20, 2));
  k.keeper.poke('w1:p1');
  await new Promise((r) => setTimeout(r, SCROLLBACK_POKE_MS + 80));
  assert.deepEqual(k.keeper.copyOf('w1:p1')!.lines, numbered(0, 17));
  await assert.rejects(k.keeper.current('w1:nope'));
  k.setUp(false);
  k.calls.length = 0;
  await k.keeper.tick();
  assert.deepEqual(k.calls, []);
});
