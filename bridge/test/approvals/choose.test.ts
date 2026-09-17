import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performChoice } from '../../src/approvals/choose.ts';

/** A Claude-style menu with the marker on `selected`. */
function menu(selected: number | null, labels = ['Alpha', 'Beta', 'Other']): string {
  const rows = labels.map((l, i) => `${selected === i + 1 ? ' ❯' : '  '} ${i + 1}. ${l}`);
  return ['', ' Which library should we use?', '', ...rows, '', ' Enter to select · Esc to cancel'].join('\n');
}

interface FakeOpts {
  status?: string;
  promptId?: string | null;
  /** Screens returned by successive pane.read calls; the last one repeats. */
  screens: string[];
}

function fake(opts: FakeOpts) {
  const keys: string[] = [];
  let reads = 0;
  const deps = {
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      switch (method) {
        case 'pane.get':
          return { pane: { pane_id: 'p', agent: 'claude', agent_status: opts.status ?? 'blocked' } } as T;
        case 'pane.read': {
          const text = opts.screens[Math.min(reads, opts.screens.length - 1)]!;
          reads++;
          return { read: { text } } as T;
        }
        case 'pane.send_keys':
          keys.push(...((params?.['keys'] as string[]) ?? []));
          return {} as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    currentPromptId: async () => (opts.promptId === undefined ? 'p@7' : opts.promptId),
    strictVerify: true,
    sleep: async () => undefined,
  };
  return { deps, keys, reads: () => reads };
}

test('moves the cursor down to the tapped option, confirms it landed, then presses Enter', async () => {
  const f = fake({ screens: [menu(1), menu(1), menu(3)] });
  const r = await performChoice(f.deps, { pane: 'p', promptId: 'p@7', option: 3, label: 'Other' });
  assert.equal(r.outcome, 'sent');
  assert.deepEqual(f.keys, ['down', 'down', 'enter']);
});

test('moves up when the marker is below the tapped option', async () => {
  const f = fake({ screens: [menu(3), menu(1)] });
  const r = await performChoice(f.deps, { pane: 'p', promptId: 'p@7', option: 1, label: 'alpha' });
  assert.equal(r.outcome, 'sent', 'labels compare case- and space-insensitively');
  assert.deepEqual(f.keys, ['up', 'up', 'enter']);
});

test('the already-selected option needs only Enter', async () => {
  const f = fake({ screens: [menu(2)] });
  const r = await performChoice(f.deps, { pane: 'p', promptId: 'p@7', option: 2, label: 'Beta' });
  assert.equal(r.outcome, 'sent');
  assert.deepEqual(f.keys, ['enter']);
  assert.equal(f.reads(), 1, 'no read-back when the cursor did not have to move');
});

test('a label that no longer matches, a shorter menu or no menu at all → dialog_changed, nothing sent', async () => {
  assert.equal((await performChoice(fake({ screens: [menu(1)] }).deps, { pane: 'p', promptId: 'p@7', option: 2, label: 'Gamma' })).outcome, 'dialog_changed');
  assert.equal((await performChoice(fake({ screens: [menu(1)] }).deps, { pane: 'p', promptId: 'p@7', option: 4, label: 'Delta' })).outcome, 'dialog_changed');
  const gone = fake({ screens: ['$ '] });
  assert.equal((await performChoice(gone.deps, { pane: 'p', promptId: 'p@7', option: 1, label: 'Alpha' })).outcome, 'dialog_changed');
  assert.deepEqual(gone.keys, []);
});

test('the cursor not landing means nothing is confirmed', async () => {
  const stuck = fake({ screens: [menu(1)] });
  const r = await performChoice(stuck.deps, { pane: 'p', promptId: 'p@7', option: 2, label: 'Beta' });
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail ?? '', /cursor is on option 1, not 2/);
  assert.deepEqual(stuck.keys, ['down'], 'the arrow went out, Enter did not');
  const swapped = fake({ screens: [menu(1), menu(2, ['Alpha', 'Beta', 'Gamma', 'Delta'])] });
  assert.equal((await performChoice(swapped.deps, { pane: 'p', promptId: 'p@7', option: 2, label: 'Beta' })).outcome, 'dialog_changed');
  assert.deepEqual(swapped.keys, ['down']);
});

test('no marker on screen → failed without keys; not blocked / stale prompt are reported as such', async () => {
  const blind = fake({ screens: [menu(null)] });
  const r = await performChoice(blind.deps, { pane: 'p', promptId: 'p@7', option: 2, label: 'Beta' });
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail ?? '', /cannot see/);
  assert.deepEqual(blind.keys, []);
  assert.equal((await performChoice(fake({ screens: [menu(1)], status: 'working' }).deps, { pane: 'p', promptId: 'p@7', option: 1, label: 'Alpha' })).outcome, 'not_blocked');
  assert.equal((await performChoice(fake({ screens: [menu(1)], promptId: 'p@9' }).deps, { pane: 'p', promptId: 'p@7', option: 1, label: 'Alpha' })).outcome, 'stale');
});
