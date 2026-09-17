import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { HerdrClient, HerdrError, type HerdrSubscription } from './client.ts';
import type { HerdrEvent, PaneAgentStatusChangedEvent, PaneInfo, PaneLayoutSnapshot, SessionSnapshot } from './types.ts';

/**
 * HerdrLink supervises the bridge's relationship with one herdr server:
 *  - `up`/`down` state with a 2 s retry loop while the socket is absent or refuses connections;
 *  - one structural subscription connection (workspace/tab/pane/layout kinds); any event there
 *    refreshes the snapshot after a 200 ms debounce and emits 'snapshot';
 *  - one agent-status subscription connection listing every known pane (herdr requires a pane_id per
 *    entry, docs/herdr-findings.md §8), re-opened whenever the pane set changes; emits 'pane.status'.
 * Plain requests go through `request()` on fresh connections (one request per connection).
 */

const STRUCTURAL_KINDS = [
  'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed', 'workspace.moved',
  'workspace.reordered', 'workspace.closed', 'workspace.focused',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved', 'pane.exited', 'pane.agent_detected',
  'layout.updated',
] as const;

export interface HerdrLinkOptions {
  socketPath: string;
  log: { info(event: string, fields?: Record<string, unknown>): void; debug(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void; readonly debugEnabled: boolean };
  retryMs?: number;
  snapshotDebounceMs?: number;
}

export interface HerdrHostInfo {
  version: string;
  protocol: number;
}

export class HerdrLink extends EventEmitter {
  readonly client: HerdrClient;
  private readonly log: HerdrLinkOptions['log'];
  private readonly retryMs: number;
  private readonly snapshotDebounceMs: number;
  private state: 'up' | 'down' = 'down';
  private snapshot: SessionSnapshot | null = null;
  private host: HerdrHostInfo | null = null;
  private structural: HerdrSubscription | null = null;
  private agentStatus: HerdrSubscription | null = null;
  private agentStatusPanes = '';
  private snapshotTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;

  constructor(opts: HerdrLinkOptions) {
    super();
    this.client = new HerdrClient({ socketPath: opts.socketPath });
    this.log = opts.log;
    this.retryMs = opts.retryMs ?? 2000;
    this.snapshotDebounceMs = opts.snapshotDebounceMs ?? 200;
  }

  get isUp(): boolean {
    return this.state === 'up';
  }

  get currentSnapshot(): SessionSnapshot | null {
    return this.snapshot;
  }

  get hostInfo(): HerdrHostInfo | null {
    return this.host;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.structural?.close();
    this.agentStatus?.close();
    this.structural = null;
    this.agentStatus = null;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.client.request<T>(method, params, timeoutMs);
  }

  pane(paneId: string): PaneInfo | undefined {
    return this.snapshot?.panes.find((p) => p.pane_id === paneId);
  }

  /**
   * The pane, refreshing the snapshot on demand when it is not in it yet. A pane herdr just created
   * (`tab.create`) reaches the debounced snapshot ~200 ms after herdr's event, and a phone that opens
   * it at once must not be told `unknown_pane`. Polls every 100 ms until `timeoutMs`; undefined if the
   * pane never shows up (closed, or herdr down).
   */
  async ensurePane(paneId: string, timeoutMs = 1500): Promise<PaneInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const known = this.pane(paneId);
      if (known || !this.isUp) return known;
      try {
        await this.refreshSnapshot();
      } catch (err) {
        this.log.debug('herdr.snapshot_refresh_failed', { error: (err as Error).message });
      }
      const again = this.pane(paneId);
      if (again || Date.now() >= deadline) return again;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  layoutFor(paneId: string): { layout: PaneLayoutSnapshot; rect: { width: number; height: number } } | undefined {
    const pane = this.pane(paneId);
    if (!pane) return undefined;
    const layout = this.snapshot?.layouts.find((l) => l.tab_id === pane.tab_id);
    const rect = layout?.panes.find((p) => p.pane_id === paneId)?.rect;
    return layout && rect ? { layout, rect } : undefined;
  }

  /**
   * Exact PTY size of a pane (rows, cols) read from the pane's shell tty (docs/herdr-findings.md §3):
   * pane.process_info → shell_pid → /proc/<pid>/fd/0 → `stty size`. Returns null when unavailable.
   */
  async ptySize(paneId: string): Promise<{ rows: number; cols: number } | null> {
    try {
      const tty = await this.ttyOf(paneId);
      if (!tty) return null;
      const out = await new Promise<string>((resolve, reject) =>
        execFile('stty', ['-F', tty, 'size'], { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      );
      const [rows, cols] = out.trim().split(/\s+/).map(Number);
      if (!rows || !cols) return null;
      return { rows, cols };
    } catch {
      return null;
    }
  }

  /** The pane's tty (`/dev/pts/N`) via pane.process_info → shell_pid → /proc/<pid>/fd/0; null when unavailable. */
  async ttyOf(paneId: string): Promise<string | null> {
    try {
      const { process_info } = await this.request<{ process_info: { shell_pid: number } }>('pane.process_info', { pane_id: paneId });
      const tty = fs.readlinkSync(`/proc/${process_info.shell_pid}/fd/0`);
      return tty.startsWith('/dev/') ? tty : null;
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const pong = await this.client.request<{ version: string; protocol: number }>('ping', {}, 3000);
      this.host = { version: pong.version, protocol: pong.protocol };
      await this.refreshSnapshot();
      await this.openStructural();
      await this.syncAgentStatusSubscription();
      this.setState('up');
    } catch (err) {
      this.setState('down');
      this.log.debug('herdr.connect_failed', { error: (err as Error).message });
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
  }

  private setState(next: 'up' | 'down'): void {
    if (this.state === next) return;
    this.state = next;
    this.log.info('herdr.state', { state: next, version: this.host?.version, protocol: this.host?.protocol });
    this.emit('state', next);
  }

  private onLost(reason: string): void {
    if (this.stopped) return;
    this.structural?.close();
    this.agentStatus?.close();
    this.structural = null;
    this.agentStatus = null;
    this.agentStatusPanes = '';
    this.setState('down');
    this.log.debug('herdr.lost', { reason });
    this.scheduleRetry();
  }

  private async openStructural(): Promise<void> {
    this.structural?.close();
    const sub = await this.client.subscribe(
      STRUCTURAL_KINDS.map((type) => ({ type })),
      (ev) => this.onStructuralEvent(ev),
    );
    this.structural = sub;
    void sub.closed.then((err) => {
      if (this.structural === sub) this.onLost(err ? `structural stream error: ${err.message}` : 'structural stream closed');
    });
  }

  private onStructuralEvent(ev: HerdrEvent): void {
    this.emit('structural', ev);
    if (this.log.debugEnabled) this.log.debug('herdr.event', { kind: ev.event });
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.refreshSnapshot()
        .then(() => this.syncAgentStatusSubscription())
        .catch((err: Error) => this.log.debug('herdr.snapshot_refresh_failed', { error: err.message }));
    }, this.snapshotDebounceMs);
  }

  private async refreshSnapshot(): Promise<void> {
    const { snapshot } = await this.client.request<{ snapshot: SessionSnapshot }>('session.snapshot');
    this.snapshot = snapshot;
    this.emit('snapshot', snapshot);
  }

  private async syncAgentStatusSubscription(): Promise<void> {
    const panes = (this.snapshot?.panes ?? []).map((p) => p.pane_id).sort();
    const key = panes.join(',');
    if (key === this.agentStatusPanes && this.agentStatus) return;
    const previous = this.agentStatus;
    if (panes.length === 0) {
      previous?.close();
      this.agentStatus = null;
      this.agentStatusPanes = key;
      return;
    }
    const sub = await this.client.subscribe(
      panes.map((pane_id) => ({ type: 'pane.agent_status_changed' as const, pane_id })),
      (ev) => this.onAgentStatusEvent(ev),
    );
    this.agentStatus = sub;
    this.agentStatusPanes = key;
    previous?.close();
    void sub.closed.then((err) => {
      if (this.agentStatus === sub) this.onLost(err ? `status stream error: ${err.message}` : 'status stream closed');
    });
  }

  /**
   * Raw status events. herdr replays the session's event history to every new subscriber
   * (docs/herdr-findings.md §0), so consumers must verify against herdr before acting; the hub does.
   */
  private onAgentStatusEvent(ev: HerdrEvent): void {
    if (ev.event !== 'pane.agent_status_changed') return;
    this.emit('pane.status', ev.data as unknown as PaneAgentStatusChangedEvent);
  }
}

export { HerdrError };
