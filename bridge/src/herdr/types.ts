// Hand-written subset of herdr's socket API (protocol 19, schema_version 1).
// Source of truth: herdr's bundled API schema (`herdr api schema --output herdr-schema.json`; herdr 0.8.0, protocol 19).
// The file is not redistributed here; only what Remotly uses is typed.

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';
export type ReadFormat = 'text' | 'ansi';

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  revision: number;
  scroll?: PaneScrollInfo | null;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

export interface PaneLayoutRect { x: number; y: number; width: number; height: number }
export interface PaneLayoutPane { pane_id: string; focused: boolean; rect: PaneLayoutRect }
export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: PaneInfo[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: ReadSource;
  format: ReadFormat;
  text: string;
  revision: number;
  truncated: boolean;
}

export interface PaneZoomResult {
  changed: boolean;
  zoom_changed: boolean;
  focus_changed: boolean;
  pane_id: string;
  focused_pane_id: string;
  zoomed: boolean;
  layout: PaneLayoutSnapshot;
  reason?: string | null;
}

export type OutputMatch = { type: 'substring'; value: string } | { type: 'regex'; value: string };

export type Subscription =
  | { type: `workspace.${string}` | `tab.${string}` | `worktree.${string}` | 'layout.updated' }
  | { type: 'pane.created' | 'pane.closed' | 'pane.updated' | 'pane.focused' | 'pane.moved' | 'pane.exited' | 'pane.agent_detected' }
  | { type: 'pane.agent_status_changed'; pane_id?: string; agent_status?: AgentStatus }
  | { type: 'pane.output_matched'; pane_id: string; source: ReadSource; match: OutputMatch; lines?: number; strip_ansi?: boolean }
  | { type: 'pane.scroll_changed'; pane_id: string };

export interface PaneAgentStatusChangedEvent {
  pane_id: string;
  workspace_id: string;
  agent?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  title?: string | null;
  state_labels?: Record<string, string>;
}

export interface PaneOutputMatchedEvent {
  pane_id: string;
  matched_line: string;
  read: PaneReadResult;
}

export interface PaneOutputChangedEvent {
  pane_id: string;
  workspace_id: string;
  revision: number;
}

/** Server-initiated message: `{"event": kind, "data": {...}}`. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface HerdrErrorBody {
  code: string;
  message: string;
}

/** `tab.create` → the new tab and its single shell pane. */
export interface TabCreateResult {
  tab: TabInfo;
  root_pane: PaneInfo;
}
