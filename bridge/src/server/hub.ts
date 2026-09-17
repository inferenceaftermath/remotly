// Shared state behind every phone connection: the herdr link, the snapshot in protocol form,
// prompt ids for blocked panes, "who is viewing what", and fan-out of snapshot/status/herdr events.
import { EventEmitter } from 'node:events';
import { finishedExcerpt } from '../push/excerpt.ts';
import { parseApprovalDialog, type ApprovalDetails } from '../approvals/dialog.ts';
import { PaneFitter } from '../herdr/fit.ts';
import { PaneZoomer } from '../herdr/zoom.ts';
import type { HerdrLink } from '../herdr/link.ts';
import type { AgentStatus, PaneAgentStatusChangedEvent, PaneInfo, PaneReadResult, SessionSnapshot } from '../herdr/types.ts';
import type { Logger } from '../log.ts';
import type { PaneStatusMessage, SnapshotMessage, SnapshotPane } from './protocol.ts';

export interface HubDeps {
  link: HerdrLink;
  log: Logger;
  hostName: string;
  version: string;
  /** Override for tests; default drives `stty` on the pane's tty. */
  fitter?: PaneFitter;
  /** Override for tests; default drives herdr `pane.zoom`. */
  zoomer?: PaneZoomer;
}

export interface Viewer {
  viewing: string | null;
  /** Paired device behind the connection (null before `hello`). */
  deviceId: string | null;
  send(msg: object): void;
}

export interface PaneState {
  agent_status: AgentStatus;
  agent: string | null;
  display_agent: string | null;
  title: string;
  cwd: string | null;
  prompt_id: string | null;
  /** Parsed dialog while blocked, null otherwise or when the screen did not parse. */
  approval: ApprovalDetails | null;
}

interface AgentSeq {
  pane_id: string;
  agent_status: AgentStatus;
  state_change_seq: number;
}

/**
 * Leading glyphs an agent puts in front of its terminal title and herdr leaves in place: Claude Code's ✳ and its
 * spinner frames (✢ ✶ ✻ ✽ ◐ ◓ ◑ ◒ ·), bullets and braille spinners, with the whitespace after them.
 */
const TITLE_GLYPHS = /^[\s\u2733\u273B\u273D\u2736\u2722\u2726\u2727\u25D0-\u25D3\u25CF\u25CB\u25C9\u25CE\u25CC\u23FA\u00B7\u2022\u2800-\u28FF]+/u;

/** The title without its leading status glyph; empty when it was nothing but glyphs (the apps then show the cwd or id). */
export function cleanTitle(raw: string): string {
  return raw.replace(TITLE_GLYPHS, '').trim();
}

/** The pane's title as the apps and pushes show it (protocol §6 `title`): herdr's own title or label, else the terminal title. */
export function paneTitle(p: PaneInfo): string {
  return cleanTitle(p.title ?? p.label ?? p.terminal_title_stripped ?? p.terminal_title ?? p.pane_id);
}

export function stateLabel(p: PaneInfo): string | null {
  const labels = p.state_labels ?? {};
  const own = p.agent ? labels[p.agent] : undefined;
  return own ?? Object.values(labels)[0] ?? null;
}

export class Hub extends EventEmitter {
  readonly link: HerdrLink;
  /** PTY sizes imposed by viewing phones (`fit`). */
  readonly fitter: PaneFitter;
  /** Desktop zooms held for viewing phones (`watch {zoom:true}`). */
  readonly zoomer: PaneZoomer;
  readonly hostName: string;
  readonly version: string;
  private readonly log: Logger;
  private readonly viewers = new Set<Viewer>();
  /** pane id → prompt id, only while the pane is blocked */
  private readonly promptIds = new Map<string, string>();
  /** pane id → parsed approval dialog, only while the pane is blocked and the screen parsed */
  private readonly approvals = new Map<string, ApprovalDetails>();
  /** JSON of the last snapshot broadcast, so metadata churn that changes nothing visible is not re-sent */
  private lastSnapshotJson = '';
  /** pane id → last agent status announced to clients (dedupes replayed / duplicate events) */
  private readonly known = new Map<string, AgentStatus>();
  /** pane id → when its agent began the current stretch of work (ms), only while working / blocked */
  private readonly since = new Map<string, number>();
  /**
   * pane id → title in the last snapshot. A rename while the status stands still refreshes the glanceable surfaces
   * (`pane.title`); and since a herdr outage clears `known` but not this, panes that vanished meanwhile still leave as `pane.gone`.
   */
  private readonly titles = new Map<string, string>();
  /** pane id → pending verification timer (coalesces event bursts per pane) */
  private readonly pendingVerify = new Map<string, NodeJS.Timeout>();
  /**
   * Snapshot reconciliation awaits herdr (`agent.list`, dialog reads). Runs are serialised, every snapshot is processed (a
   * removal in one must not be lost to the next), and a run that resumes after a newer snapshot or an outage stops short:
   * announcing from stale data would revive a pane the newer snapshot saw leave.
   */
  private snapshotChain: Promise<void> = Promise.resolve();
  /** Arrival counter: a run whose snapshot is no longer the latest stops at its next await. */
  private snapshotGen = 0;
  /** herdr outages seen: a run queued before one never starts (its state is history; the first snapshot after `up` reconciles). */
  private outages = 0;

  constructor(deps: HubDeps) {
    super();
    this.link = deps.link;
    this.log = deps.log;
    this.hostName = deps.hostName;
    this.version = deps.version;
    this.fitter = deps.fitter ?? new PaneFitter({ ttyOf: (pane) => this.link.ttyOf(pane), log: this.log });
    this.zoomer = deps.zoomer ?? new PaneZoomer({ request: (method, params) => this.link.request(method, params), log: this.log });
    this.link.on('snapshot', (snap: SessionSnapshot) => {
      this.queueSnapshot(snap);
      void this.fitter.onLayoutChanged();
    });
    this.link.on('pane.status', (ev: PaneAgentStatusChangedEvent) => this.scheduleVerify(ev.pane_id));
    this.link.on('state', (state: 'up' | 'down') => {
      if (state === 'down') {
        this.fitter.reset();
        this.zoomer.reset();
        this.promptIds.clear();
        this.approvals.clear();
        this.known.clear();
        this.snapshotGen++; // reconciliations in flight stop: their data predates the outage
        this.outages++; // and those still queued never start
        // `since` is kept: a herdr blip must not restart the phones' elapsed clocks for a turn that never stopped;
        // the next snapshot prunes panes that are gone and `trackSince` drops the ones that went idle meanwhile.
        for (const t of this.pendingVerify.values()) clearTimeout(t);
        this.pendingVerify.clear();
      }
      this.broadcast({ t: 'herdr', state });
    });
  }

  addViewer(v: Viewer): void {
    this.viewers.add(v);
  }

  removeViewer(v: Viewer): void {
    this.viewers.delete(v);
  }

  get clientCount(): number {
    return this.viewers.size;
  }

  /** Is anyone (or, with `deviceId`, that device) looking at the pane right now? */
  isViewed(pane: string, deviceId?: string): boolean {
    for (const v of this.viewers) if (v.viewing === pane && (deviceId === undefined || v.deviceId === deviceId)) return true;
    return false;
  }

  broadcast(msg: object): void {
    for (const v of this.viewers) v.send(msg);
  }

  /** Every connection of one device. */
  broadcastTo(deviceId: string, msg: object): void {
    for (const v of this.viewers) if (v.deviceId === deviceId) v.send(msg);
  }

  promptIdFor(pane: string): string | null {
    return this.promptIds.get(pane) ?? null;
  }

  /** Re-derive the prompt id from herdr (`<pane>@<state_change_seq>` while blocked, else null). */
  async refreshPromptId(pane: string): Promise<string | null> {
    try {
      const { agent } = await this.link.request<{ agent: AgentSeq }>('agent.get', { target: pane });
      return this.setPromptId(pane, agent.agent_status, agent.state_change_seq);
    } catch {
      const info = this.link.pane(pane);
      if (info?.agent_status !== 'blocked') this.promptIds.delete(pane);
      return this.promptIds.get(pane) ?? null;
    }
  }

  private setPromptId(pane: string, status: AgentStatus, seq: number): string | null {
    if (status !== 'blocked') {
      this.promptIds.delete(pane);
      return null;
    }
    const id = `${pane}@${seq}`;
    this.promptIds.set(pane, id);
    return id;
  }

  paneState(pane: string): PaneState | undefined {
    const p = this.link.pane(pane);
    if (!p) return undefined;
    return {
      agent_status: p.agent_status,
      agent: p.agent ?? null,
      display_agent: p.display_agent ?? null,
      title: paneTitle(p),
      cwd: p.cwd ?? p.foreground_cwd ?? null,
      prompt_id: this.promptIds.get(pane) ?? null,
      approval: p.agent_status === 'blocked' ? (this.approvals.get(pane) ?? null) : null,
    };
  }

  /**
   * Read the screen and parse the approval dialog of a blocked pane (approvals/dialog.ts). Called before a
   * `blocked` status is announced and again by the notifier when the push goes out (the dialog may have
   * finished drawing meanwhile); a changed result is re-broadcast as `pane.status` so open apps update their card.
   */
  async readApproval(pane: string): Promise<ApprovalDetails | null> {
    const changed = await this.refreshApproval(pane);
    const p = this.link.pane(pane);
    if (changed && p && p.agent_status === 'blocked') this.broadcast(this.statusMessage(p));
    return this.approvals.get(pane) ?? null;
  }

  /** Update the approval cache for `pane`; true when the cached value changed. */
  private async refreshApproval(pane: string): Promise<boolean> {
    const p = this.link.pane(pane);
    const before = this.approvals.get(pane);
    if (!p || p.agent_status !== 'blocked') {
      this.approvals.delete(pane);
      return before !== undefined;
    }
    let parsed: ApprovalDetails | null = null;
    try {
      const { read } = await this.link.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
      parsed = parseApprovalDialog(read.text);
    } catch (err) {
      this.log.debug('hub.approval_read_failed', { pane, error: (err as Error).message });
      return false;
    }
    if (JSON.stringify(parsed) === JSON.stringify(before ?? null)) return false;
    if (parsed) this.approvals.set(pane, parsed);
    else this.approvals.delete(pane);
    return true;
  }

  /** Last few non-blank visible lines, for push bodies. */
  async excerpt(pane: string, maxLines = 3, maxChars = 160): Promise<string | null> {
    try {
      const { read } = await this.link.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
      const lines = read.text
        .split('\n')
        .map((l) => l.replace(/[│─╭╮╰╯┃┏┓┗┛▎❯›>]+/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((l) => l.length > 0);
      const tail = lines.slice(-maxLines).join(' · ');
      return tail.length > maxChars ? tail.slice(0, maxChars - 1) + '…' : tail || null;
    } catch {
      return null;
    }
  }

  /** The agent's closing words for the "finished" alert (screen chrome stripped, last prose paragraph). */
  async finishedExcerpt(pane: string, maxChars = 200): Promise<string | null> {
    try {
      const { read } = await this.link.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
      return finishedExcerpt(read.text, maxChars);
    } catch {
      return null;
    }
  }

  snapshotMessage(): SnapshotMessage | null {
    const snap = this.link.currentSnapshot;
    if (!snap) return null;
    const panes: SnapshotPane[] = snap.panes.map((p) => {
      this.trackSince(p.pane_id, p.agent_status); // a pane already working when the bridge first sees it counts from now
      const out: SnapshotPane = {
        id: p.pane_id,
        tab_id: p.tab_id,
        workspace_id: p.workspace_id,
        title: paneTitle(p),
        agent: p.agent ?? null,
        display_agent: p.display_agent ?? null,
        agent_status: p.agent_status,
        state_label: stateLabel(p),
        cwd: p.cwd ?? p.foreground_cwd ?? null,
        focused: p.focused,
        since: this.since.get(p.pane_id) ?? null,
      };
      const promptId = this.promptIds.get(p.pane_id);
      if (promptId && p.agent_status === 'blocked') out.prompt_id = promptId;
      const approval = this.approvals.get(p.pane_id);
      if (approval && p.agent_status === 'blocked') out.approval = approval;
      return out;
    });
    return {
      t: 'snapshot',
      workspaces: snap.workspaces.map((w) => ({ id: w.workspace_id, name: w.label })),
      tabs: snap.tabs.map((t) => ({ id: t.tab_id, workspace_id: t.workspace_id, name: t.label })),
      panes,
      focused_pane_id: snap.focused_pane_id ?? null,
    };
  }

  private queueSnapshot(snap: SessionSnapshot): void {
    const gen = ++this.snapshotGen;
    const outage = this.outages;
    this.snapshotChain = this.snapshotChain
      .then(() => this.onSnapshot(snap, gen, outage))
      .catch((err) => this.log.warn('hub.snapshot_failed', { error: (err as Error).message }));
  }

  /** `gen` is this snapshot's arrival number (after every await the run checks it is still the latest); `outage` the outage count at arrival. */
  private async onSnapshot(snap: SessionSnapshot, gen: number, outage: number): Promise<void> {
    if (outage !== this.outages) return; // queued before an outage: herdr's state then is history
    const ids = new Set(snap.panes.map((p) => p.pane_id));
    for (const pane of new Set([...this.known.keys(), ...this.titles.keys()])) {
      if (ids.has(pane)) continue;
      this.known.delete(pane);
      this.approvals.delete(pane);
      this.since.delete(pane);
      this.titles.delete(pane);
      this.emit('pane.gone', pane);
    }
    for (const pane of [...this.promptIds.keys()]) if (!ids.has(pane)) this.promptIds.delete(pane);
    for (const pane of [...this.since.keys()]) if (!ids.has(pane)) this.since.delete(pane); // `known` may have been cleared by a herdr outage
    // Prompt ids for panes that are blocked right now (also covers bridge restarts).
    const blockedMissing = snap.panes.filter((p) => p.agent_status === 'blocked' && !this.promptIds.has(p.pane_id));
    if (blockedMissing.length > 0) {
      try {
        const { agents } = await this.link.request<{ agents: AgentSeq[] }>('agent.list');
        if (gen !== this.snapshotGen) return; // superseded while waiting: the newer run reconciles (and asks herdr itself)
        for (const a of agents) if (blockedMissing.some((p) => p.pane_id === a.pane_id)) this.setPromptId(a.pane_id, a.agent_status, a.state_change_seq);
      } catch (err) {
        this.log.debug('hub.agent_list_failed', { error: (err as Error).message });
      }
      if (gen !== this.snapshotGen) return; // superseded while waiting: the newer run reconciles
    }
    for (const p of snap.panes) {
      if (p.agent_status !== 'blocked') {
        this.promptIds.delete(p.pane_id);
        this.approvals.delete(p.pane_id);
      } else if (this.known.get(p.pane_id) !== 'blocked') {
        await this.refreshApproval(p.pane_id);
        if (gen !== this.snapshotGen) return;
      }
      // Claude names the session a moment after it starts working: a title change with the status unchanged reaches the
      // apps in the snapshot below, and the notifier (Live Activity, Android status notification) through `pane.title`.
      const title = paneTitle(p);
      if (this.known.get(p.pane_id) !== p.agent_status) this.announce(p);
      else if (this.titles.has(p.pane_id) && this.titles.get(p.pane_id) !== title && (p.agent_status === 'working' || p.agent_status === 'blocked')) {
        this.emit('pane.title', p.pane_id, title);
      }
      this.titles.set(p.pane_id, title);
    }
    const msg = this.snapshotMessage();
    if (!msg) return;
    const json = JSON.stringify(msg);
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    this.broadcast(msg);
  }

  /** Status events are hints: herdr replays history to new subscribers, so verify before announcing. */
  private scheduleVerify(pane: string): void {
    if (this.pendingVerify.has(pane)) return;
    this.pendingVerify.set(
      pane,
      setTimeout(() => {
        this.pendingVerify.delete(pane);
        void this.verifyPane(pane);
      }, 30),
    );
  }

  private async verifyPane(pane: string): Promise<void> {
    if (!this.link.pane(pane)) return; // closed or replayed for a pane that no longer exists
    const gen = this.snapshotGen; // a snapshot that lands while we ask herdr carries the pane's current state itself
    let status: AgentStatus;
    const fresh: Partial<PaneInfo> = {};
    try {
      const { agent } = await this.link.request<{ agent: AgentSeq & Partial<PaneInfo> }>('agent.get', { target: pane });
      status = agent.agent_status;
      this.setPromptId(pane, status, agent.state_change_seq);
      if (agent.agent !== undefined) fresh.agent = agent.agent;
      if (agent.display_agent !== undefined) fresh.display_agent = agent.display_agent;
      if (agent.title !== undefined) fresh.title = agent.title;
      if (agent.state_labels !== undefined) fresh.state_labels = agent.state_labels;
    } catch {
      try {
        const { pane: info } = await this.link.request<{ pane: PaneInfo }>('pane.get', { pane_id: pane });
        status = info.agent_status;
        fresh.agent = info.agent ?? null;
        fresh.display_agent = info.display_agent ?? null;
        if (info.title !== undefined) fresh.title = info.title;
        if (status !== 'blocked') this.promptIds.delete(pane);
      } catch (err) {
        this.log.debug('hub.verify_failed', { error: (err as Error).message });
        return;
      }
    }
    // A snapshot that arrived meanwhile has reconciled the pane from herdr's current state (or seen it leave): applying an
    // older answer over it would roll the pane back. Otherwise re-read the pane, in case the object was replaced.
    if (gen !== this.snapshotGen) return;
    let cached = this.link.pane(pane);
    if (!cached) return;
    Object.assign(cached, fresh);
    cached.agent_status = status;
    // Parse the dialog before the phones hear "blocked", so the first pane.status already carries the card.
    const approvalChanged = status === 'blocked' ? await this.refreshApproval(pane) : (this.approvals.delete(pane), false);
    if (gen !== this.snapshotGen) return;
    cached = this.link.pane(pane);
    if (!cached) return;
    if (this.known.get(pane) !== cached.agent_status) this.announce(cached);
    else if (approvalChanged) this.broadcast(this.statusMessage(cached));
  }

  private statusMessage(p: PaneInfo): PaneStatusMessage {
    this.trackSince(p.pane_id, p.agent_status);
    const msg: PaneStatusMessage = {
      t: 'pane.status',
      pane: p.pane_id,
      agent_status: p.agent_status,
      agent: p.agent ?? null,
      display_agent: p.display_agent ?? null,
      title: paneTitle(p),
      state_label: stateLabel(p),
      since: this.since.get(p.pane_id) ?? null,
    };
    if (p.agent_status === 'blocked') {
      const promptId = this.promptIds.get(p.pane_id);
      if (promptId) msg.prompt_id = promptId;
      const approval = this.approvals.get(p.pane_id);
      if (approval) msg.approval = approval;
    }
    return msg;
  }

  /** The elapsed-time clock the phones show: starts when work starts, survives `blocked`, ends with the turn. */
  private trackSince(pane: string, status: AgentStatus): void {
    if (status === 'working' || status === 'blocked') {
      if (!this.since.has(pane)) this.since.set(pane, Date.now());
    } else {
      this.since.delete(pane);
    }
  }

  private announce(p: PaneInfo): void {
    this.trackSince(p.pane_id, p.agent_status);
    this.known.set(p.pane_id, p.agent_status);
    this.broadcast(this.statusMessage(p));
    this.emit('pane.status', p.pane_id, p.agent_status);
    // invalidate the snapshot dedupe so the next refresh reflects the new status
    this.lastSnapshotJson = '';
  }
}
