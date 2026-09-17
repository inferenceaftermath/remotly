// Approval flow (§6.5): verify the pane is still blocked on the same prompt, check the visible text
// against the agent's dialog signature, then send the mapped keys. Key maps live in agents.json.
import agentsJson from './agents.json' with { type: 'json' };
import type { AgentStatus, PaneInfo, PaneReadResult } from '../herdr/types.ts';

export type ApprovalAction = 'approve' | 'approve_session' | 'deny' | 'deny_feedback' | 'interrupt';
export type ApprovalOutcome = 'sent' | 'stale' | 'not_blocked' | 'signature_mismatch' | 'dialog_changed' | 'failed';

export interface AgentKeymap {
  display: string;
  approve: string[];
  approve_session: string[];
  deny: string[];
  deny_feedback: string[] | null;
  feedback_submit: string[];
  interrupt: string[];
  signature: string;
  verified_on: string;
}

const { $comment: _comment, ...maps } = agentsJson as Record<string, unknown> & { $comment: string };
export const AGENTS: Readonly<Record<string, AgentKeymap>> = maps as Record<string, AgentKeymap>;

export function keymapFor(agent: string | null | undefined): AgentKeymap | undefined {
  return agent && Object.hasOwn(AGENTS, agent) ? AGENTS[agent] : undefined;
}

export class UnsupportedAgentError extends Error {
  constructor(agent: string | null | undefined) {
    super(agent ? `no approval key map for agent "${agent}"` : 'pane has no detected agent');
    this.name = 'UnsupportedAgentError';
  }
}

export interface ApprovalRequest {
  pane: string;
  promptId: string;
  action: ApprovalAction;
  feedback?: string;
  force?: boolean;
}

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  detail?: string;
  status_after?: AgentStatus;
}

export interface ApproveDeps {
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** Current prompt id of the pane (`<pane>@<state_change_seq>`), or null when it is not blocked. */
  currentPromptId: (pane: string) => Promise<string | null>;
  strictVerify: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const KEY_GAP_MS = 40;
export const FEEDBACK_TEXT_DELAY_MS = 300;
export const FEEDBACK_SUBMIT_DELAY_MS = 100;
export const STATUS_AFTER_DELAY_MS = 1500;

async function sendKeys(deps: ApproveDeps, pane: string, keys: string[], sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await sleep(KEY_GAP_MS);
    await deps.request('pane.send_keys', { pane_id: pane, keys: [keys[i]] });
  }
}

/**
 * Runs one approval action end to end. Throws UnsupportedAgentError for panes without a known agent;
 * every other failure is reported through `outcome`.
 */
export async function performApproval(deps: ApproveDeps, req: ApprovalRequest): Promise<ApprovalResult> {
  const sleep = deps.sleep ?? wait;
  let pane: PaneInfo;
  try {
    pane = (await deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: req.pane })).pane;
  } catch (err) {
    return { outcome: 'failed', detail: `pane.get: ${(err as Error).message}` };
  }
  const map = keymapFor(pane.agent);
  if (!map) throw new UnsupportedAgentError(pane.agent);

  // `interrupt` targets a running turn, so it is exempt from the blocked/prompt checks.
  if (req.action !== 'interrupt') {
    if (pane.agent_status !== 'blocked') return { outcome: 'not_blocked', status_after: pane.agent_status };
    const current = await deps.currentPromptId(req.pane);
    if (current !== req.promptId) return { outcome: 'stale', detail: current ? `current prompt is ${current}` : 'pane no longer blocked' };
    if (deps.strictVerify && !req.force) {
      let text: string;
      try {
        text = (await deps.request<{ read: PaneReadResult }>('pane.read', { pane_id: req.pane, source: 'visible', format: 'text' })).read.text;
      } catch (err) {
        return { outcome: 'failed', detail: `pane.read: ${(err as Error).message}` };
      }
      if (!new RegExp(map.signature, 'i').test(text)) return { outcome: 'signature_mismatch', detail: `visible text does not match /${map.signature}/i` };
    }
  }

  try {
    if (req.action === 'deny_feedback') {
      const feedback = (req.feedback ?? '').trim();
      await sendKeys(deps, req.pane, map.deny_feedback ?? map.deny, sleep);
      if (feedback) {
        await sleep(FEEDBACK_TEXT_DELAY_MS);
        await deps.request('pane.send_text', { pane_id: req.pane, text: feedback });
        await sleep(FEEDBACK_SUBMIT_DELAY_MS);
        await sendKeys(deps, req.pane, map.feedback_submit, sleep);
      }
    } else {
      await sendKeys(deps, req.pane, map[req.action], sleep);
    }
  } catch (err) {
    return { outcome: 'failed', detail: `send: ${(err as Error).message}` };
  }

  await sleep(STATUS_AFTER_DELAY_MS);
  try {
    const after = (await deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: req.pane })).pane;
    return { outcome: 'sent', status_after: after.agent_status };
  } catch {
    return { outcome: 'sent' };
  }
}
