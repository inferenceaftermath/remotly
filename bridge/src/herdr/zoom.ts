// Zoom a herdr pane on the desktop while a phone is looking at it (remotly-protocol.md §4 `watch {zoom:true}`).
//
// herdr's zoom is per tab: `pane.zoom on` makes the pane fill its tab, `off` restores the split. The
// bridge only ever undoes a zoom it applied itself: when `on` answers `already_zoomed` the desktop user
// (or another phone) zoomed the pane, and leaving must not unzoom it. A single-pane tab cannot zoom
// (`single_pane`); herdr answers `zoomed:false` and there is nothing to restore.
import type { PaneZoomResult } from './types.ts';

export interface PaneZoomerDeps {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  log: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}

export class PaneZoomer {
  /** Panes zoomed by the bridge → the viewers that asked for it. Panes zoomed elsewhere are never listed. */
  private readonly owned = new Map<string, Set<object>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly request: PaneZoomerDeps['request'];
  private readonly log: PaneZoomerDeps['log'];

  constructor(deps: PaneZoomerDeps) {
    this.request = deps.request;
    this.log = deps.log;
  }

  /** Panes this owner is holding zoomed. */
  panesOf(owner: object): string[] {
    const out: string[] = [];
    for (const [pane, owners] of this.owned) if (owners.has(owner)) out.push(pane);
    return out;
  }

  /** True when the bridge zoomed `pane` and has not yet released it. */
  owns(pane: string): boolean {
    return this.owned.has(pane);
  }

  /**
   * Zoom `pane` for `owner`. Resolves to herdr's zoom state afterwards. The zoom is recorded as ours when
   * this call changed it, or when it was already ours (a second phone opening the same pane, or a phone
   * re-watching after a reconnect); a zoom the desktop user made stays theirs.
   */
  apply(pane: string, owner: object): Promise<boolean> {
    return this.serial(pane, async () => {
      const { zoom } = await this.request<{ zoom: PaneZoomResult }>('pane.zoom', { pane_id: pane, mode: 'on' });
      const ours = zoom.zoom_changed || this.owned.has(pane);
      if (ours) {
        const owners = this.owned.get(pane) ?? new Set<object>();
        owners.add(owner);
        this.owned.set(pane, owners);
      }
      this.log.info('pane.zoom', { pane, mode: 'on', changed: zoom.zoom_changed, zoomed: zoom.zoomed, reason: zoom.reason ?? null, ours });
      return zoom.zoomed;
    });
  }

  /** `owner` stopped looking at `pane`: unzoom it when nobody else holds it and the zoom was ours. */
  release(pane: string, owner: object): Promise<void> {
    return this.serial(pane, async () => {
      const owners = this.owned.get(pane);
      if (!owners?.has(owner)) return;
      owners.delete(owner);
      if (owners.size > 0) return;
      this.owned.delete(pane);
      try {
        const { zoom } = await this.request<{ zoom: PaneZoomResult }>('pane.zoom', { pane_id: pane, mode: 'off' });
        this.log.info('pane.zoom', { pane, mode: 'off', changed: zoom.zoom_changed, zoomed: zoom.zoomed, reason: zoom.reason ?? null });
      } catch (err) {
        this.log.warn('pane.zoom.restore_failed', { pane, error: (err as Error).message });
      }
    });
  }

  async releaseAll(owner: object): Promise<void> {
    await Promise.all(this.panesOf(owner).map((pane) => this.release(pane, owner)));
  }

  /** The bridge is stopping: unzoom every pane the bridge zoomed, whoever holds it; zooms made on the desktop stay. */
  async restoreAll(): Promise<void> {
    await Promise.all(
      [...this.owned.keys()].map((pane) =>
        this.serial(pane, async () => {
          if (!this.owned.delete(pane)) return;
          try {
            const { zoom } = await this.request<{ zoom: PaneZoomResult }>('pane.zoom', { pane_id: pane, mode: 'off' });
            this.log.info('pane.zoom', { pane, mode: 'off', changed: zoom.zoom_changed, zoomed: zoom.zoomed, reason: zoom.reason ?? null, why: 'shutdown' });
          } catch (err) {
            this.log.warn('pane.zoom.restore_failed', { pane, error: (err as Error).message });
          }
        }),
      ),
    );
  }

  /** herdr went away: its layouts are gone with it, nothing is ours any more. */
  reset(): void {
    this.owned.clear();
  }

  /** Per-pane serialisation so apply/release never interleave for one pane. */
  private serial<T>(pane: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(pane) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(pane, next.catch(() => undefined));
    return next;
  }
}
