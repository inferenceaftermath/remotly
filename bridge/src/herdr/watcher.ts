import { performance } from 'node:perf_hooks';
import type { HerdrClient } from './client.ts';
import type { PaneReadResult } from './types.ts';

/**
 * Output-change signal (docs/herdr-findings.md §1): herdr exposes no event that fires on pane output,
 * so a watched pane is polled with `pane.read source=visible format=ansi`. A read costs ~0.4 ms at idle
 * and ~40 ms under heavy output, so the poll interval self-limits the frame rate under load.
 * Change detection compares the returned text; `revision` does not track output.
 */
/**
 * Poll interval right after the phone forwarded a scroll (`boost`): the program redraws within a few
 * ms of the wheel report, and the frame should follow it as closely, so the phone can slide the picture.
 */
export const BOOST_INTERVAL_MS = 12;

export interface PaneWatcherOptions {
  client: HerdrClient;
  paneId: string;
  intervalMs?: number;
  onScreen: (read: PaneReadResult) => void;
  onError: (err: Error) => void;
}

export class PaneWatcher {
  readonly paneId: string;
  private readonly client: HerdrClient;
  private readonly intervalMs: number;
  private readonly onScreen: (read: PaneReadResult) => void;
  private readonly onError: (err: Error) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastText: string | null = null;
  private stopped = false;
  private inFlight = false;
  private boostUntil = 0;
  /** Observes every scheduling decision (interval chosen, boosted or not); tests use it instead of wall-clock timing. */
  onSchedule?: (intervalMs: number, boosted: boolean) => void;

  constructor(opts: PaneWatcherOptions) {
    this.client = opts.client;
    this.paneId = opts.paneId;
    this.intervalMs = opts.intervalMs ?? 40;
    this.onScreen = opts.onScreen;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
  }

  /** Forget the last screen so the next read is delivered even if identical (used for full-frame refreshes). */
  invalidate(): void {
    this.lastText = null;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Poll every BOOST_INTERVAL_MS for the next `ms` (a forwarded scroll is about to change the screen). */
  boost(ms: number): void {
    const until = performance.now() + ms;
    if (until <= this.boostUntil) return;
    this.boostUntil = until;
    if (this.timer && !this.inFlight && !this.stopped) {
      clearTimeout(this.timer); // the pending poll was scheduled at the slow cadence
      this.onSchedule?.(BOOST_INTERVAL_MS, true);
      this.timer = setTimeout(() => void this.tick(), BOOST_INTERVAL_MS);
    }
  }

  get boosted(): boolean {
    return performance.now() < this.boostUntil;
  }

  private schedule(elapsedMs: number): void {
    if (this.stopped) return;
    const boosted = this.boosted;
    const interval = boosted ? Math.min(BOOST_INTERVAL_MS, this.intervalMs) : this.intervalMs;
    this.onSchedule?.(interval, boosted);
    const delay = Math.max(2, interval - elapsedMs);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    const t0 = performance.now();
    try {
      const { read } = await this.client.request<{ read: PaneReadResult }>('pane.read', {
        pane_id: this.paneId,
        source: 'visible',
        format: 'ansi',
        strip_ansi: false,
      });
      if (!this.stopped && read.text !== this.lastText) {
        this.lastText = read.text;
        this.onScreen(read);
      }
    } catch (err) {
      if (!this.stopped) this.onError(err as Error);
    } finally {
      this.inFlight = false;
      this.schedule(performance.now() - t0);
    }
  }
}
