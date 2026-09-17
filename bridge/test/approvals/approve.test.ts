import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENTS, performApproval, UnsupportedAgentError, type ApproveDeps } from '../../src/approvals/approve.ts';
import { planKeys } from '../../src/herdr/keys.ts';

interface Call { method: string; params: Record<string, unknown> | undefined; at: number }

function fakeHerdr(opts: { agent?: string | null; status?: string; statusAfter?: string; screen?: string; promptId?: string | null }) {
  const calls: Call[] = [];
  let clock = 0;
  let gets = 0;
  const deps: ApproveDeps = {
    strictVerify: true,
    currentPromptId: async () => (opts.promptId === undefined ? 'w1:pA@7' : opts.promptId),
    sleep: async (ms) => {
      clock += ms;
    },
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params, at: clock });
      if (method === 'pane.get') {
        gets++;
        const status = gets === 1 ? (opts.status ?? 'blocked') : (opts.statusAfter ?? 'working');
        return { pane: { pane_id: 'w1:pA', agent: opts.agent === undefined ? 'claude' : opts.agent, agent_status: status } } as T;
      }
      if (method === 'pane.read') return { read: { text: opts.screen ?? 'Do you want to proceed?\n ❯ 1. Yes' } } as T;
      return { type: 'ok' } as T;
    },
  };
  return { deps, calls, clock: () => clock };
}

const base = { pane: 'w1:pA', promptId: 'w1:pA@7' } as const;

test('agents.json has every action for every agent', () => {
  for (const [name, map] of Object.entries(AGENTS)) {
    for (const k of ['approve', 'approve_session', 'deny', 'feedback_submit', 'interrupt'] as const) {
      assert.ok(Array.isArray(map[k]) && map[k].length > 0, `${name}.${k}`);
    }
    assert.doesNotThrow(() => new RegExp(map.signature, 'i'), `${name}.signature`);
    assert.ok(map.verified_on.length > 0);
  }
});

test('approve sends the mapped key and reports status_after', async () => {
  const h = fakeHerdr({ statusAfter: 'working' });
  const r = await performApproval(h.deps, { ...base, action: 'approve' });
  assert.deepEqual(r, { outcome: 'sent', status_after: 'working' });
  const keys = h.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params?.['keys']);
  assert.deepEqual(keys, [['1']]);
  assert.equal(h.calls.filter((c) => c.method === 'pane.read').length, 1);
});

test('multi-key actions are sent one key per request, 40 ms apart', async () => {
  const h = fakeHerdr({ agent: 'pi', screen: 'Allow this command?' });
  await performApproval(h.deps, { ...base, action: 'approve_session' });
  const sends = h.calls.filter((c) => c.method === 'pane.send_keys');
  assert.deepEqual(sends.map((c) => c.params?.['keys']), [['down'], ['enter']]);
  assert.equal(sends[1]!.at - sends[0]!.at, 40);
});

test('deny_feedback: deny keys, 300 ms, text, 100 ms, submit keys', async () => {
  const h = fakeHerdr({});
  await performApproval(h.deps, { ...base, action: 'deny_feedback', feedback: '  use ripgrep instead ' });
  const seq = h.calls.filter((c) => c.method.startsWith('pane.send')).map((c) => [c.method, c.params?.['keys'] ?? c.params?.['text'], c.at]);
  assert.deepEqual(seq, [
    ['pane.send_keys', ['esc'], 0],
    ['pane.send_text', 'use ripgrep instead', 300],
    ['pane.send_keys', ['enter'], 400],
  ]);
});

test('deny_feedback without feedback text degrades to a plain deny', async () => {
  const h = fakeHerdr({ agent: 'codex', screen: 'Would you like to run the following command? (y)' });
  await performApproval(h.deps, { ...base, action: 'deny_feedback' });
  const seq = h.calls.filter((c) => c.method.startsWith('pane.send')).map((c) => c.params?.['keys'] ?? c.params?.['text']);
  assert.deepEqual(seq, [['esc']]);
});

test('not blocked → not_blocked with the current status, nothing sent', async () => {
  const h = fakeHerdr({ status: 'working' });
  const r = await performApproval(h.deps, { ...base, action: 'approve' });
  assert.deepEqual(r, { outcome: 'not_blocked', status_after: 'working' });
  assert.equal(h.calls.filter((c) => c.method.startsWith('pane.send')).length, 0);
});

test('prompt id changed → stale', async () => {
  const h = fakeHerdr({ promptId: 'w1:pA@9' });
  const r = await performApproval(h.deps, { ...base, action: 'deny' });
  assert.equal(r.outcome, 'stale');
  assert.equal(h.calls.filter((c) => c.method.startsWith('pane.send')).length, 0);
});

test('signature mismatch blocks sending unless force is set', async () => {
  const h = fakeHerdr({ screen: 'just some regular output' });
  const r = await performApproval(h.deps, { ...base, action: 'approve' });
  assert.equal(r.outcome, 'signature_mismatch');
  const forced = await performApproval(fakeHerdr({ screen: 'just some regular output' }).deps, { ...base, action: 'approve', force: true });
  assert.equal(forced.outcome, 'sent');
});

test('strict_verify off skips the screen read', async () => {
  const h = fakeHerdr({ screen: 'nothing relevant' });
  h.deps.strictVerify = false;
  const r = await performApproval(h.deps, { ...base, action: 'approve' });
  assert.equal(r.outcome, 'sent');
  assert.equal(h.calls.filter((c) => c.method === 'pane.read').length, 0);
});

test('interrupt works while the agent is working and skips prompt checks', async () => {
  const h = fakeHerdr({ status: 'working', promptId: null, statusAfter: 'idle' });
  const r = await performApproval(h.deps, { ...base, promptId: 'anything', action: 'interrupt' });
  assert.deepEqual(r, { outcome: 'sent', status_after: 'idle' });
  assert.deepEqual(h.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params?.['keys']), [['esc']]);
});

test('unknown or missing agent throws UnsupportedAgentError', async () => {
  await assert.rejects(performApproval(fakeHerdr({ agent: 'gemini' }).deps, { ...base, action: 'approve' }), UnsupportedAgentError);
  await assert.rejects(performApproval(fakeHerdr({ agent: null }).deps, { ...base, action: 'approve' }), UnsupportedAgentError);
});

test('herdr send failure → failed with detail', async () => {
  const h = fakeHerdr({});
  const inner = h.deps.request;
  h.deps.request = async <T>(m: string, p?: Record<string, unknown>): Promise<T> => {
    if (m === 'pane.send_keys') throw new Error('pane_not_found');
    return inner<T>(m, p);
  };
  const r = await performApproval(h.deps, { ...base, action: 'approve' });
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail ?? '', /pane_not_found/);
});

test('planKeys splits herdr keys and raw escapes in order', () => {
  assert.deepEqual(planKeys(['ctrl+c', 'Enter']), [{ kind: 'keys', keys: ['ctrl+c', 'enter'] }]);
  assert.deepEqual(planKeys(['home', 'end', 'up', 'pagedown']), [
    { kind: 'text', text: '\x1b[H\x1b[F' },
    { kind: 'keys', keys: ['up'] },
    { kind: 'text', text: '\x1b[6~' },
  ]);
  assert.equal(planKeys(['shift+home']), null);
  assert.equal(planKeys(['bogus']), null);
  assert.deepEqual(planKeys(['1', 'y', 'f5', 'shift+tab', 'ctrl+shift+p']), [{ kind: 'keys', keys: ['1', 'y', 'f5', 'shift+tab', 'ctrl+shift+p'] }]);
});
