// Answer a dialog by moving its cursor (protocol §4 `choose`): check that the pane is still blocked on the same
// prompt and that the tapped option still reads what the phone showed, press up/down from the marked (❯) choice
// until the marker sits on the tapped one — reading the screen back after each step — then Enter. Nothing here is
// agent-specific: any dialog that draws a numbered menu with a marker works (permission prompts, Claude's
// AskUserQuestion, pickers). When the cursor does not land, nothing is sent and the phone hears why.
import type { PaneInfo, PaneReadResult } from '../herdr/types.ts';
import { KEY_GAP_MS, STATUS_AFTER_DELAY_MS, type ApprovalResult, type ApproveDeps } from './approve.ts';
import { parseApprovalDialog, type ApprovalDetails } from './dialog.ts';

export interface ChoiceRequest {
  pane: string;
  promptId: string;
  /** 1-based, as numbered on screen. */
  option: number;
  /** The option's text as the phone showed it; the screen must still say the same. */
  label: string;
}

/** How long the program gets to redraw the marker after the arrow keys. */
export const CURSOR_POLL_MS = 60;
export const CURSOR_POLL_TRIES = 10;
export const MAX_CURSOR_STEPS = 20;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const sameOptions = (a: ApprovalDetails, b: ApprovalDetails) => a.options.length === b.options.length && a.options.every((o, i) => norm(o) === norm(b.options[i]!));

export async function performChoice(deps: ApproveDeps, req: ChoiceRequest): Promise<ApprovalResult> {
  const sleep = deps.sleep ?? wait;
  const read = async (): Promise<ApprovalDetails | null> => {
    const { read } = await deps.request<{ read: PaneReadResult }>('pane.read', { pane_id: req.pane, source: 'visible', format: 'text' });
    return parseApprovalDialog(read.text);
  };

  let pane: PaneInfo;
  try {
    pane = (await deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: req.pane })).pane;
  } catch (err) {
    return { outcome: 'failed', detail: `pane.get: ${(err as Error).message}` };
  }
  if (pane.agent_status !== 'blocked') return { outcome: 'not_blocked', status_after: pane.agent_status };
  const current = await deps.currentPromptId(req.pane);
  if (current !== req.promptId) return { outcome: 'stale', detail: current ? `current prompt is ${current}` : 'pane no longer blocked' };

  let dialog: ApprovalDetails | null;
  try {
    dialog = await read();
  } catch (err) {
    return { outcome: 'failed', detail: `pane.read: ${(err as Error).message}` };
  }
  if (!dialog) return { outcome: 'dialog_changed', detail: 'no menu on screen' };
  const shown = dialog.options[req.option - 1];
  if (shown === undefined) return { outcome: 'dialog_changed', detail: `the menu has ${dialog.options.length} options now` };
  if (norm(shown) !== norm(req.label)) return { outcome: 'dialog_changed', detail: `option ${req.option} now reads "${shown}"` };
  if (dialog.selected === null) return { outcome: 'failed', detail: 'cannot see which option is selected; use the arrow keys' };
  const delta = req.option - dialog.selected;
  if (Math.abs(delta) > MAX_CURSOR_STEPS) return { outcome: 'failed', detail: `cursor is ${Math.abs(delta)} steps away` };

  try {
    if (delta !== 0) {
      const key = delta > 0 ? 'down' : 'up';
      for (let i = 0; i < Math.abs(delta); i++) {
        if (i > 0) await sleep(KEY_GAP_MS);
        await deps.request('pane.send_keys', { pane_id: req.pane, keys: [key] });
      }
      // The program redraws asynchronously: wait until the marker sits on the tapped option before confirming.
      let landed = false;
      let last: ApprovalDetails | null = null;
      for (let t = 0; t < CURSOR_POLL_TRIES && !landed; t++) {
        await sleep(CURSOR_POLL_MS);
        const now = await read();
        if (!now) continue;
        if (!sameOptions(now, dialog)) return { outcome: 'dialog_changed', detail: 'the menu changed while the cursor moved; nothing confirmed' };
        last = now;
        landed = now.selected === req.option;
      }
      if (!landed) {
        const at = last?.selected;
        return { outcome: 'failed', detail: at ? `cursor is on option ${at}, not ${req.option}; nothing confirmed` : 'cursor did not move; nothing confirmed' };
      }
    }
    await deps.request('pane.send_keys', { pane_id: req.pane, keys: ['enter'] });
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
