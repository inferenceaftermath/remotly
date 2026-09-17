import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOST_INTERVAL_MS, PaneWatcher } from '../../src/herdr/watcher.ts';

/** A herdr whose screen changes on every read, so each poll is delivered. */
function harness(intervalMs: number) {
  const polls: number[] = [];
  let n = 0;
  const client = {
    request: async <T>(): Promise<T> => {
      polls.push(performance.now());
      n++;
      return { read: { text: `screen ${n}`, pane_id: 'p', source: 'visible', format: 'ansi', revision: n, truncated: false } } as T;
    },
  };
  const screens: string[] = [];
  const watcher = new PaneWatcher({ client: client as never, paneId: 'p', intervalMs, onScreen: (r) => screens.push(r.text), onError: () => undefined });
  return { watcher, polls, screens };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}


// Cadences are compared against each other (medians of the gaps between polls), not against the clock:
// the suite runs its files in parallel and timers stretch under load.
test('boost schedules polls at the fast cadence for the requested window, then falls back to the normal interval', async (t) => {
  // Deterministic: the watcher reports each scheduling decision (interval chosen, boosted flag) through onSchedule,
  // so the assertions do not depend on how much the timers stretch under CI load.
  const h = harness(60);
  t.after(() => h.watcher.stop()); // a failed assertion must not leave the poll chain alive
  const decisions: { interval: number; boosted: boolean; at: number }[] = [];
  h.watcher.onSchedule = (interval, boosted) => decisions.push({ interval, boosted, at: performance.now() });
  h.watcher.start();
  await sleep(150);
  const beforeBoost = decisions.length;
  assert.ok(beforeBoost >= 1, 'polled at least once before the boost');
  assert.ok(decisions.every((d) => !d.boosted && d.interval === 60), 'normal cadence before the boost');
  assert.equal(h.watcher.boosted, false);
  h.watcher.boost(250);
  assert.equal(h.watcher.boosted, true);
  await sleep(350);
  assert.equal(h.watcher.boosted, false, 'the window has passed');
  const during = decisions.slice(beforeBoost).filter((d) => d.boosted);
  const after = decisions.slice(beforeBoost).filter((d) => !d.boosted);
  assert.ok(during.length >= 1, 'at least one poll was scheduled at the boosted cadence');
  assert.ok(during.every((d) => d.interval === BOOST_INTERVAL_MS), 'boosted polls use BOOST_INTERVAL_MS');
  assert.ok(after.length >= 1 && after.every((d) => d.interval === 60), 'after the window the normal interval returns');
  assert.ok(Math.max(...during.map((d) => d.at)) < Math.min(...after.map((d) => d.at)), 'no boosted decision after a normal one');
  h.watcher.stop();
  assert.equal(h.screens.length, h.polls.length, 'every changed screen was delivered');
});

test('a shorter boost never cuts a longer one short; stop ends polling', async (t) => {
  const h = harness(60);
  t.after(() => h.watcher.stop());
  h.watcher.start();
  h.watcher.boost(300);
  h.watcher.boost(50);
  await sleep(120);
  assert.equal(h.watcher.boosted, true, 'the 300 ms boost still runs');
  h.watcher.stop();
  const n = h.polls.length;
  await sleep(60);
  assert.equal(h.polls.length, n);
});
