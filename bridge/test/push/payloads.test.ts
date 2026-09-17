import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApprovalDetails } from '../../src/approvals/dialog.ts';
import {
  ACTIVITY_DISMISS_SEC,
  approvalSummary,
  approvalTitle,
  buildApnsDonePayload,
  buildApnsPayload,
  buildFcmData,
  buildFcmDoneData,
  buildFcmEnvelope,
  buildFcmMessage,
  buildFcmStatusData,
  buildLiveActivityPayload,
  type ApprovalNotice,
  type DoneNotice,
  type StatusNotice,
} from '../../src/push/payloads.ts';

const notice: ApprovalNotice = {
  host: 'example-host',
  pane: 'w1:p1',
  promptId: 'w1:p1@4212',
  agent: 'claude',
  displayAgent: 'Claude',
  subtitle: '~/Desktop/remotly',
  body: 'Allow Bash(npm test)?',
};

test('APNs payload matches Appendix B', () => {
  assert.deepEqual(buildApnsPayload(notice), {
    aps: {
      alert: { title: 'Claude · Waiting for approval', subtitle: '~/Desktop/remotly', body: 'Allow Bash(npm test)?' },
      sound: 'default',
      category: 'REMOTLY_APPROVAL',
      'thread-id': 'w1:p1',
      'interruption-level': 'time-sensitive',
    },
    flow: { v: 1, type: 'approval', host: 'example-host', pane: 'w1:p1', prompt_id: 'w1:p1@4212', agent: 'claude' },
  });
});

const approval: ApprovalDetails = { tool: 'Bash', command: 'npm test', path: null, description: 'Run the tests', question: 'Do you want to proceed?', options: ['Yes', 'Yes, and always allow npm from this project', 'No'], selected: 1, kind: 'permission' };

test('a parsed dialog rides along as flow.approval (APNs) and as JSON text in FCM data', () => {
  const n = { ...notice, body: approvalSummary(approval), approval };
  const aps = buildApnsPayload(n) as { aps: { alert: { body: string } }; flow: { approval: unknown } };
  assert.equal(aps.aps.alert.body, 'Bash · npm test — Run the tests');
  assert.deepEqual(aps.flow.approval, approval);
  const data = buildFcmData(n);
  assert.equal(data['approval'], JSON.stringify(approval));
  assert.equal(JSON.stringify(Object.keys(data).slice(0, 9)), JSON.stringify(['v', 'type', 'host', 'pane', 'prompt_id', 'agent', 'title', 'subtitle', 'body']), 'approval is appended, order of the rest is stable');
  assert.equal(approvalSummary({ ...approval, tool: null, command: null, description: null }), 'Do you want to proceed?');
  assert.equal(approvalSummary({ ...approval, command: null, path: 'src/a.ts', description: null }), 'Bash · src/a.ts');
  assert.equal(approvalSummary({ ...approval, command: 'x'.repeat(300) }).length, 200);
});

test('a question menu (kind choice) is announced as a question: title, body, APNs category, no key-map buttons', () => {
  const question: ApprovalDetails = { tool: null, command: null, path: null, description: null, question: 'Which database should the service use?', options: ['Postgres', 'SQLite', 'Other'], selected: 2, kind: 'choice' };
  const n = { ...notice, body: approvalSummary(question), approval: question };
  assert.equal(approvalTitle(n), 'Claude · Has a question');
  assert.equal(approvalSummary(question), 'Which database should the service use? — 1. Postgres · 2. SQLite · 3. Other');
  const aps = buildApnsPayload(n) as { aps: { category: string; alert: { title: string } }; flow: { approval: ApprovalDetails } };
  assert.equal(aps.aps.category, 'REMOTLY_QUESTION');
  assert.equal(aps.aps.alert.title, 'Claude · Has a question');
  assert.equal(aps.flow.approval.kind, 'choice');
  assert.equal(buildFcmData(n)['title'], 'Claude · Has a question');
  assert.equal(approvalTitle({ ...notice, approval }), 'Claude · Waiting for approval');
});

const done: DoneNotice = { host: 'example-host', pane: 'w1:p1', agent: 'claude', displayAgent: 'Claude', subtitle: 'Remotly bridge', body: 'All 179 tests pass.' };

test('done alert: category REMOTLY_DONE, active interruption level, flow.type done; FCM type done', () => {
  assert.deepEqual(buildApnsDonePayload(done), {
    aps: {
      alert: { title: 'Claude · finished its turn', subtitle: 'Remotly bridge', body: 'All 179 tests pass.' },
      sound: 'default',
      category: 'REMOTLY_DONE',
      'thread-id': 'w1:p1',
      'interruption-level': 'active',
    },
    flow: { v: 1, type: 'done', host: 'example-host', pane: 'w1:p1', agent: 'claude' },
  });
  assert.deepEqual(buildFcmDoneData(done), {
    v: '1',
    type: 'done',
    host: 'example-host',
    pane: 'w1:p1',
    agent: 'claude',
    title: 'Claude · finished its turn',
    subtitle: 'Remotly bridge',
    body: 'All 179 tests pass.',
  });
});

const status: StatusNotice = { host: 'example-host', pane: 'w1:p1', agent: 'claude', displayAgent: 'Claude', title: 'Remotly bridge', status: 'blocked', sinceMs: 1_800_000_000_123, promptId: 'w1:p1@4212', detail: 'Bash: npm test' };

test('status data: strings only, prompt_id and detail only when present', () => {
  assert.deepEqual(buildFcmStatusData(status), {
    v: '1',
    type: 'status',
    host: 'example-host',
    pane: 'w1:p1',
    agent: 'claude',
    display_agent: 'Claude',
    title: 'Remotly bridge',
    status: 'blocked',
    since: '1800000000123',
    prompt_id: 'w1:p1@4212',
    detail: 'Bash: npm test',
  });
  const working = buildFcmStatusData({ ...status, status: 'working', promptId: null, detail: null });
  assert.equal('prompt_id' in working || 'detail' in working || 'kind' in working, false);
  for (const v of Object.values(working)) assert.equal(typeof v, 'string');
  assert.equal(buildFcmStatusData({ ...status, kind: 'choice' })['kind'], 'choice', 'the ongoing notification says "Has a question" for a menu');
});

test('Live Activity payloads: start carries attributes, end a dismissal date, all share the content state', () => {
  const now = 1_800_000_060_500;
  assert.deepEqual(buildLiveActivityPayload(status, 'start', now), {
    aps: {
      timestamp: 1_800_000_060,
      event: 'start',
      'content-state': { status: 'blocked', since: 1_800_000_000, title: 'Remotly bridge', promptId: 'w1:p1@4212', detail: 'Bash: npm test' },
      'attributes-type': 'FlowActivityAttributes',
      attributes: { pane: 'w1:p1', host: 'example-host', agent: 'claude', displayAgent: 'Claude' },
      alert: { title: 'Claude · Waiting for approval', body: 'Remotly bridge · Bash: npm test' },
      'input-push-token': 1,
    },
  });
  const workingStart = buildLiveActivityPayload({ ...status, status: 'working', promptId: null, detail: null }, 'start', now) as { aps: { alert: object } };
  assert.deepEqual(workingStart.aps.alert, { title: 'Claude · Working', body: 'Remotly bridge' });
  const update = buildLiveActivityPayload({ ...status, status: 'working', promptId: null, detail: null }, 'update', now) as { aps: Record<string, unknown> };
  assert.deepEqual(Object.keys(update.aps), ['timestamp', 'event', 'content-state']);
  assert.deepEqual(update.aps['content-state'], { status: 'working', since: 1_800_000_000, title: 'Remotly bridge', promptId: null, detail: null });
  const question = buildLiveActivityPayload({ ...status, detail: 'Which database? — 1. Postgres · 2. SQLite', kind: 'choice' }, 'start', now) as { aps: { alert: { title: string }; 'content-state': Record<string, unknown> } };
  assert.equal(question.aps.alert.title, 'Claude · Has a question');
  assert.equal(question.aps['content-state']['kind'], 'choice', 'the widget hides Approve / Deny for a menu');
  const end = buildLiveActivityPayload({ ...status, status: 'idle', promptId: null, detail: null }, 'end', now) as { aps: Record<string, unknown> };
  assert.equal(end.aps['event'], 'end');
  assert.equal(end.aps['dismissal-date'], 1_800_000_060 + ACTIVITY_DISMISS_SEC);
});

test('FCM message matches Appendix B and every data value is a string', () => {
  const msg = buildFcmMessage('fcm-token-xyz', notice, 600);
  assert.deepEqual(msg, {
    message: {
      token: 'fcm-token-xyz',
      android: { priority: 'HIGH', ttl: '600s', collapse_key: 'w1:p1' },
      data: {
        v: '1',
        type: 'approval',
        host: 'example-host',
        pane: 'w1:p1',
        prompt_id: 'w1:p1@4212',
        agent: 'claude',
        title: 'Claude · Waiting for approval',
        subtitle: '~/Desktop/remotly',
        body: 'Allow Bash(npm test)?',
      },
    },
  });
  assert.equal('approval' in (msg as { message: { data: Record<string, string> } }).message.data, false, 'no approval key without a parsed dialog');
  const data = (msg as { message: { data: Record<string, unknown> } }).message.data;
  for (const [k, v] of Object.entries(data)) assert.equal(typeof v, 'string', k);
  // envelope + data compose to the same bytes the client sends
  assert.equal(JSON.stringify(buildFcmEnvelope('fcm-token-xyz', notice.pane, 600, buildFcmData(notice))), JSON.stringify(msg));
});

test('title follows the display agent; default body passes through', () => {
  const n = { ...notice, displayAgent: 'pi', agent: 'pi', body: 'Approval needed' };
  const aps = (buildApnsPayload(n) as { aps: { alert: { title: string; body: string } } }).aps;
  assert.equal(aps.alert.title, 'pi · Waiting for approval');
  assert.equal(aps.alert.body, 'Approval needed');
  assert.equal(buildFcmData(n)['title'], 'pi · Waiting for approval');
});
