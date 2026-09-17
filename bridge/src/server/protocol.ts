// Wire messages of the Remotly protocol v1 (shared/protocol/remotly-protocol.md). Client messages are
// validated structurally in session.ts; these types document the shapes the bridge emits.
import type { ApprovalDetails } from '../approvals/dialog.ts';
import type { AgentStatus } from '../herdr/types.ts';

export const PROTOCOL = 1;

export interface SnapshotPane {
  id: string;
  tab_id: string;
  workspace_id: string;
  title: string;
  agent: string | null;
  display_agent: string | null;
  agent_status: AgentStatus;
  state_label: string | null;
  cwd: string | null;
  focused: boolean;
  /** When the agent began its current stretch of work (ms since epoch, kept through `blocked`); null when idle/done/unknown. */
  since: number | null;
  prompt_id?: string;
  /** The parsed dialog while `blocked` (absent when the screen did not parse). */
  approval?: ApprovalDetails;
}

export interface SnapshotMessage {
  t: 'snapshot';
  workspaces: { id: string; name: string }[];
  tabs: { id: string; workspace_id: string; name: string }[];
  panes: SnapshotPane[];
  focused_pane_id: string | null;
}

export interface PaneStatusMessage {
  t: 'pane.status';
  pane: string;
  agent_status: AgentStatus;
  agent: string | null;
  display_agent: string | null;
  title: string;
  state_label: string | null;
  since: number | null;
  prompt_id?: string;
  approval?: ApprovalDetails;
}

/** The bridge changed this device's "notify when done" arming itself (the alert fired, or the pane went away). */
export interface NotifyStateMessage {
  t: 'notify.state';
  pane: string;
  done: boolean;
}

export interface WelcomeMessage {
  t: 'welcome';
  protocol: 1;
  host: { name: string; herdr_version: string | null; herdr_protocol: number | null; flow_version: string };
  device: { id: string; name: string };
  snapshot?: SnapshotMessage;
  /** Panes this device asked to be told about when the agent finishes (`mode:"full"` only). */
  notify_done?: string[];
}

export type ErrorCode =
  | 'auth'
  | 'bad_request'
  | 'unknown_pane'
  | 'fit_unavailable'
  | 'not_watching'
  | 'herdr_down'
  | 'herdr_error'
  | 'unsupported_agent'
  | 'invalid_key'
  | 'unsupported';

export interface ErrorMessage {
  t: 'error';
  id?: string;
  code: ErrorCode;
  message: string;
}
