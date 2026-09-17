// Push payload builders. Shapes are normative (shared/protocol/remotly-protocol.md §9); keep key order stable so
// tests can compare serialized bodies byte-for-byte.
import type { ApprovalDetails } from '../approvals/dialog.ts';
import type { AgentStatus } from '../herdr/types.ts';

export interface ApprovalNotice {
  host: string;
  pane: string;
  promptId: string;
  agent: string;
  /** Human-facing agent name (`Claude`, `Codex`, `pi`); drives the title. */
  displayAgent: string;
  /** Session title: the pane title, else the cwd basename, else the pane id (`sessionTitle` in notify.ts). */
  subtitle: string;
  /** What is being asked (from the parsed dialog), else a screen excerpt or `'Approval needed'`. */
  body: string;
  /** The parsed dialog, when the screen parsed (§9: `flow.approval` / FCM `approval` JSON). */
  approval?: ApprovalDetails | null;
}

/** "Tell me when it's done": the agent in `pane` went idle/done/exited after working. */
export interface DoneNotice {
  host: string;
  pane: string;
  agent: string;
  displayAgent: string;
  subtitle: string;
  /** Last visible lines (the agent's closing words) or `'Finished'`. */
  body: string;
}

/** Glanceable status: iOS Live Activity content state, Android ongoing notification. */
export interface StatusNotice {
  host: string;
  pane: string;
  agent: string;
  displayAgent: string;
  /** Session title (as `ApprovalNotice.subtitle`). */
  title: string;
  status: AgentStatus;
  /** When the agent started this stretch of work (ms since epoch). */
  sinceMs: number;
  /** Present while blocked. */
  promptId: string | null;
  /** One line about the pending approval while blocked (`Bash · npm test`). */
  detail: string | null;
  /** While blocked: what kind of dialog (`permission` → Approve / Deny buttons on the phone; `choice` → open the app). */
  kind?: 'permission' | 'choice' | null;
}

export type ActivityEvent = 'start' | 'update' | 'end';

/** How long an ended Live Activity stays on the lock screen. */
export const ACTIVITY_DISMISS_SEC = 5 * 60;

/** `Claude · Waiting for approval` / `Claude · Has a question`: the agent, then the status word the apps use (shared/design/DESIGN.md §3). */
export function approvalTitle(n: ApprovalNotice): string {
  return n.approval?.kind === 'choice' ? `${n.displayAgent} · Has a question` : `${n.displayAgent} · Waiting for approval`;
}

export function doneTitle(n: DoneNotice): string {
  return `${n.displayAgent} · finished its turn`;
}

/** One line for a notification body / Live Activity: `Bash · npm test — Run the tests`. */
export function approvalSummary(a: ApprovalDetails, maxChars = 200): string {
  const what = a.command ?? a.path ?? a.question;
  const text =
    a.kind === 'choice'
      ? `${a.question}${a.options.length > 0 ? ` — ${a.options.map((o, i) => `${i + 1}. ${o}`).join(' · ')}` : ''}`
      : `${a.tool ? `${a.tool} · ` : ''}${what}${a.description && a.description !== what ? ` — ${a.description}` : ''}`;
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

/** APNs alert push: `aps` for the system banner, `flow` for the app's deep link and stale-clearing. */
export function buildApnsPayload(n: ApprovalNotice): object {
  return {
    aps: {
      alert: { title: approvalTitle(n), subtitle: n.subtitle, body: n.body },
      sound: 'default',
      category: n.approval?.kind === 'choice' ? 'REMOTLY_QUESTION' : 'REMOTLY_APPROVAL',
      'thread-id': n.pane,
      'interruption-level': 'time-sensitive',
    },
    flow: { v: 1, type: 'approval', host: n.host, pane: n.pane, prompt_id: n.promptId, agent: n.agent, ...(n.approval ? { approval: n.approval } : {}) },
  };
}

/** FCM `data` map (all values strings: the Android app renders the notification itself). */
export function buildFcmData(n: ApprovalNotice): Record<string, string> {
  return {
    v: '1',
    type: 'approval',
    host: n.host,
    pane: n.pane,
    prompt_id: n.promptId,
    agent: n.agent,
    title: approvalTitle(n),
    subtitle: n.subtitle,
    body: n.body,
    ...(n.approval ? { approval: JSON.stringify(n.approval) } : {}),
  };
}

/** APNs alert for a finished agent; category `REMOTLY_DONE` carries the "Reply" text action. */
export function buildApnsDonePayload(n: DoneNotice): object {
  return {
    aps: {
      alert: { title: doneTitle(n), subtitle: n.subtitle, body: n.body },
      sound: 'default',
      category: 'REMOTLY_DONE',
      'thread-id': n.pane,
      'interruption-level': 'active',
    },
    flow: { v: 1, type: 'done', host: n.host, pane: n.pane, agent: n.agent },
  };
}

export function buildFcmDoneData(n: DoneNotice): Record<string, string> {
  return {
    v: '1',
    type: 'done',
    host: n.host,
    pane: n.pane,
    agent: n.agent,
    title: doneTitle(n),
    subtitle: n.subtitle,
    body: n.body,
  };
}

/** FCM data for the Android ongoing "working" notification (silent; the app updates or removes it). */
export function buildFcmStatusData(n: StatusNotice): Record<string, string> {
  return {
    v: '1',
    type: 'status',
    host: n.host,
    pane: n.pane,
    agent: n.agent,
    display_agent: n.displayAgent,
    title: n.title,
    status: n.status,
    since: String(n.sinceMs),
    ...(n.promptId ? { prompt_id: n.promptId } : {}),
    ...(n.detail ? { detail: n.detail } : {}),
    ...(n.kind ? { kind: n.kind } : {}),
  };
}

/**
 * APNs `liveactivity` push (`apns-topic: <bundle>.push-type.liveactivity`). `content-state` must decode as the
 * app's `FlowActivityAttributes.ContentState`; `attributes` (start only) as `FlowActivityAttributes`.
 */
function activityAlertTitle(n: StatusNotice): string {
  if (n.status !== 'blocked') return `${n.displayAgent} · Working`;
  return n.kind === 'choice' ? `${n.displayAgent} · Has a question` : `${n.displayAgent} · Waiting for approval`;
}

export function buildLiveActivityPayload(n: StatusNotice, event: ActivityEvent, nowMs: number): object {
  const now = Math.floor(nowMs / 1000);
  return {
    aps: {
      timestamp: now,
      event,
      'content-state': { status: n.status, since: Math.floor(n.sinceMs / 1000), title: n.title, promptId: n.promptId, detail: n.detail, ...(n.kind ? { kind: n.kind } : {}) },
      ...(event === 'start'
        ? {
            'attributes-type': 'FlowActivityAttributes',
            attributes: { pane: n.pane, host: n.host, agent: n.agent, displayAgent: n.displayAgent },
            // Required by push-to-start: the system announces the new activity with this alert (no sound: it is glanceable status).
            alert: { title: activityAlertTitle(n), body: n.detail ? `${n.title} · ${n.detail}` : n.title },
            // iOS 18+: deliver the activity's update token to the app right away (`Activity.pushTokenUpdates`).
            'input-push-token': 1,
          }
        : {}),
      ...(event === 'end' ? { 'dismissal-date': now + ACTIVITY_DISMISS_SEC } : {}),
    },
  };
}

/** FCM v1 request body around an arbitrary data map; `FcmClient.send` uses this directly. */
export function buildFcmEnvelope(token: string, collapseKey: string, ttlSec: number, data: Record<string, string>): object {
  return {
    message: {
      token,
      android: { priority: 'HIGH', ttl: `${ttlSec}s`, collapse_key: collapseKey },
      data,
    },
  };
}

/** FCM data-only high-priority message for an approval notice (collapse key = pane id). */
export function buildFcmMessage(token: string, n: ApprovalNotice, ttlSec: number): object {
  return buildFcmEnvelope(token, n.pane, ttlSec, buildFcmData(n));
}
