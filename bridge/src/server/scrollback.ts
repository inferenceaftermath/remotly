// Keeps the bridge's copy of every pane's scrollback (terminal/scrollback.ts) up to date, phone or no phone, so a pane
// opened on the phone has all of its history at once. herdr has no output event (docs/herdr-findings.md §1), so the
// keeper asks `pane.list` twice a second how many rows each pane holds above its screen, and reads a pane only when
// that number moved (or, every so often, to catch a pane whose scrollback is full and no longer grows). A pane with
// nothing above its screen is either running a full-screen program (alternate screen), whose exit brings herdr's history
// back — the copy stays as it was and continues then — or its shell wiped the history (`clear`, `reset`): with the shell
// in the foreground (`pane.process_info`) the copy starts over, empty, under a new epoch.
import { EventEmitter } from 'node:events';
import type { PaneInfo, PaneReadResult } from '../herdr/types.ts';
import type { Logger } from '../log.ts';
import { historyWindow, ScrollbackCopy, splitLines, type MergeResult, type RowGrowth } from '../terminal/scrollback.ts';

export const SCROLLBACK_TICK_MS = 500;
/** A pane whose row count stands still is still read this often (herdr's scrollback is capped by bytes, so a full one scrolls without growing). */
export const SCROLLBACK_RECHECK_MS = 10_000;
/** After a phone-visible screen change, how soon the watched pane is read. */
export const SCROLLBACK_POKE_MS = 120;
/** A screen change with herdr's row count unchanged (a spinner, a redraw, or a full scrollback) is read at most this often. */
export const SCROLLBACK_POKE_RECHECK_MS = 1000;
/**
 * A pane with nothing above its screen but lines in its copy is asked whether its shell has the terminal (a `clear`)
 * this soon; each answer that finds no wipe doubles the wait, up to SCROLLBACK_CLEAR_CHECK_MAX_MS, until the pane has
 * rows above its screen again or its screen changes while watched. A phone asking for the copy checks at once.
 */
export const SCROLLBACK_CLEAR_CHECK_MS = 2000;
export const SCROLLBACK_CLEAR_CHECK_MAX_MS = 30_000;
/** herdr's cap for one `pane.read` (docs/herdr-findings.md §2). */
const MAX_READ_ROWS = 999;
/** Rows read above what is known to be new, so the copy's last lines are in the read to line up with. */
const READ_SLACK_ROWS = 64;

export interface ScrollbackUpdate extends MergeResult {
  pane: string;
  epoch: string;
}

interface Entry {
  pane: string;
  terminalId: string | null;
  copy: ScrollbackCopy;
  /** herdr's rows above the screen at the last read (null before the first). */
  rowsAbove: number | null;
  /** herdr's rows above the screen just before and just after the last read's requests: the read saw a count between,
   *  most likely the later (the count before can be a tick old, the one after is a moment after the read). */
  rowsSeen: [number, number] | null;
  readAt: number;
  /** When the pane was last asked whether nothing above its screen means a wiped history, and how long until the next. */
  clearCheckAt: number;
  clearCheckEvery: number;
  syncing: Promise<void> | null;
  /** A read waiting for the running one to finish (asked for while it ran: it may have read too early). */
  queued: Promise<void> | null;
  /** The newest `pane.list`/`pane.get` entry for the pane, for the queued read. */
  info: PaneInfo;
  /** The last read failed or did not fit together: read on the next tick. */
  again: boolean;
  pokeTimer: NodeJS.Timeout | null;
}

export interface ScrollbackKeeperDeps {
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  isUp: () => boolean;
  log: Logger;
  maxLines: number;
  now?: () => number;
}

/** Emits `update` (ScrollbackUpdate) whenever a pane's copy gains lines or restarts. */
export class ScrollbackKeeper extends EventEmitter {
  private readonly deps: ScrollbackKeeperDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: ScrollbackKeeperDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SCROLLBACK_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const e of this.entries.values()) if (e.pokeTimer) clearTimeout(e.pokeTimer);
  }

  /** One round over every pane (exported for tests; the interval calls it). */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.isUp()) return;
    this.ticking = true;
    try {
      const { panes } = await this.deps.request<{ panes: PaneInfo[] }>('pane.list', {});
      const seen = new Set<string>();
      const work: Promise<void>[] = [];
      for (const p of panes) {
        seen.add(p.pane_id);
        const e = this.entry(p);
        const above = p.scroll?.max_offset_from_bottom ?? null;
        if (above === null) continue;
        if (above > 0) e.clearCheckEvery = SCROLLBACK_CLEAR_CHECK_MS;
        if (above === 0) {
          // nothing above the screen: a full-screen program, a fresh shell, or a wiped history (`clear`)
          if (this.clearCheckDue(e)) work.push(this.sync(e));
          else this.nothingAbove(e);
          continue;
        }
        if (above !== e.rowsAbove || e.again || this.now() - e.readAt >= SCROLLBACK_RECHECK_MS) work.push(this.sync(e));
      }
      for (const [pane, e] of this.entries) {
        if (seen.has(pane)) continue;
        if (e.pokeTimer) clearTimeout(e.pokeTimer);
        this.entries.delete(pane);
      }
      await Promise.all(work);
    } catch (err) {
      if (this.deps.isUp()) this.deps.log.debug('scrollback.tick_failed', { error: (err as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  /** The watched pane's screen changed: read it soon, so lines that scrolled off reach the phone right behind the frame. */
  poke(pane: string): void {
    const e = this.entries.get(pane);
    if (!e) return;
    e.clearCheckEvery = SCROLLBACK_CLEAR_CHECK_MS; // something happened on it: a `clear` is noticed soon
    if (e.pokeTimer) return;
    e.pokeTimer = setTimeout(() => {
      e.pokeTimer = null;
      void this.refresh(pane, false).catch(() => {});
    }, SCROLLBACK_POKE_MS);
  }

  /** Bring the pane's copy up to date now and return it (a phone asked for it). Null when herdr does not know the pane. */
  async current(pane: string): Promise<ScrollbackCopy | null> {
    await this.refresh(pane, true);
    return this.entries.get(pane)?.copy ?? null;
  }

  /** The copy as it stands, without reading (null for a pane never seen). */
  copyOf(pane: string): ScrollbackCopy | null {
    return this.entries.get(pane)?.copy ?? null;
  }

  private async refresh(pane: string, force: boolean): Promise<void> {
    const { pane: info } = await this.deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: pane });
    const e = this.entry(info);
    const above = info.scroll?.max_offset_from_bottom ?? null;
    if (above === null && !force) return; // herdr without scroll info: read only when a phone asks
    if (above === 0 && !(e.copy.lines.length > 0 && (force || this.clearCheckDue(e)))) {
      this.nothingAbove(e);
      return;
    }
    if (!force && above === e.rowsAbove && !e.again && this.now() - e.readAt < SCROLLBACK_POKE_RECHECK_MS) return;
    await this.sync(e);
  }

  /** herdr holds nothing above the pane's screen: the next read has no count to go by. */
  private nothingAbove(e: Entry): void {
    e.rowsAbove = 0;
    e.rowsSeen = null;
  }

  private clearCheckDue(e: Entry): boolean {
    return e.copy.lines.length > 0 && this.now() - e.clearCheckAt >= e.clearCheckEvery;
  }

  private entry(p: PaneInfo): Entry {
    let e = this.entries.get(p.pane_id);
    const terminalId = p.terminal_id ?? null;
    let replaced = false;
    if (e && terminalId && e.terminalId && e.terminalId !== terminalId) {
      // the same id now names another terminal (herdr restarted): its history is not this one's
      if (e.pokeTimer) clearTimeout(e.pokeTimer);
      replaced = e.copy.next > 0 || e.copy.lines.length > 0;
      e = undefined;
    }
    if (!e) {
      e = { pane: p.pane_id, terminalId, copy: new ScrollbackCopy(this.deps.maxLines), rowsAbove: null, rowsSeen: null, readAt: 0, clearCheckAt: 0, clearCheckEvery: SCROLLBACK_CLEAR_CHECK_MS, syncing: null, queued: null, info: p, again: false, pokeTimer: null };
      this.entries.set(p.pane_id, e);
      if (replaced) {
        // phones on the pane drop the old terminal's lines now, not when the new one first has history
        const update: ScrollbackUpdate = { reset: true, start: 0, lines: [], gap: false, pane: e.pane, epoch: e.copy.epoch };
        this.emit('update', update);
      }
    } else if (!e.terminalId && terminalId) e.terminalId = terminalId;
    e.info = p;
    return e;
  }

  /** One read of the pane folded into its copy. A read already running is followed by one more (shared by every caller
   *  that asks meanwhile), so a caller never resolves on a read that started before it asked. */
  private sync(e: Entry): Promise<void> {
    if (e.queued) return e.queued;
    if (e.syncing) {
      e.queued = e.syncing.then(() => {
        e.queued = null;
        return this.sync(e);
      });
      return e.queued;
    }
    e.again = false;
    e.syncing = (async () => {
      try {
        await this.read(e, e.info);
      } catch (err) {
        e.again = true; // try again on the next tick
        if (this.deps.isUp()) this.deps.log.debug('scrollback.read_failed', { pane: e.pane, error: (err as Error).message });
      } finally {
        e.syncing = null;
      }
    })();
    return e.syncing;
  }

  private async read(e: Entry, info: PaneInfo): Promise<void> {
    const above = info.scroll?.max_offset_from_bottom ?? 0;
    if (info.scroll && above === 0) return this.checkCleared(e);
    const screen = info.scroll?.viewport_rows ?? 0;
    const known = e.copy.lines.length > 0 && e.rowsAbove !== null && e.rowsAbove > 0;
    // rows that are new since the last read (when herdr's count grew), the screen, and some already known to line up with
    let rows = known ? Math.min(MAX_READ_ROWS, Math.max(0, above - (e.rowsAbove ?? 0)) + screen + READ_SLACK_ROWS) : MAX_READ_ROWS;
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = historyWindow({ ...(await this.reads(e.pane, rows)), requested: rows, screenRows: screen });
      if (!w) continue; // output arrived between the reads
      // herdr's count again: with output arriving, the read saw one between `above` and this
      const { pane: now } = await this.deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: e.pane });
      // the pane id went to another terminal meanwhile: these reads may be either's (the next tick starts its copy)
      if (this.entries.get(e.pane) !== e || ((now.terminal_id ?? null) !== null && e.terminalId !== null && now.terminal_id !== e.terminalId)) return;
      const later = Math.max(above, now.scroll?.max_offset_from_bottom ?? above);
      const seen = e.rowsSeen;
      const grown: RowGrowth | null =
        known && seen ? { least: Math.max(0, above - seen[1]), most: Math.max(0, later - seen[0]), likely: Math.max(0, later - seen[1]) } : null;
      const result = e.copy.merge(w, rows < MAX_READ_ROWS, grown);
      if (result === 'wider') {
        rows = MAX_READ_ROWS;
        continue;
      }
      e.rowsAbove = above;
      e.rowsSeen = [above, later];
      e.readAt = this.now();
      if (result) {
        if (result.gap) this.deps.log.info('scrollback.gap', { pane: e.pane, appended: result.lines.length });
        if (result.reset) this.deps.log.debug('scrollback.reset', { pane: e.pane, lines: result.lines.length });
        const update: ScrollbackUpdate = { ...result, pane: e.pane, epoch: e.copy.epoch };
        this.emit('update', update);
      }
      return;
    }
    e.again = true;
  }

  /**
   * Nothing above the pane's screen, lines in its copy: a full-screen program has the alternate screen (herdr's history
   * comes back when it exits: keep the copy), or the shell wiped the history (`clear`, `reset`): start the copy over.
   * The shell is asked first and herdr's count after, so a program that exits in between (its history back) is not
   * taken for a wipe; nor is a history a wider pane pulled back onto its screen (the copy's last lines are on it).
   */
  private async checkCleared(e: Entry): Promise<void> {
    this.nothingAbove(e);
    e.clearCheckAt = this.now();
    if (e.copy.lines.length === 0) return;
    // not a wipe, as most checks find: ask less often until something changes (set back below on a wipe)
    e.clearCheckEvery = Math.min(SCROLLBACK_CLEAR_CHECK_MAX_MS, e.clearCheckEvery * 2);
    const { process_info: p } = await this.deps.request<{ process_info: { shell_pid?: number | null; foreground_process_group_id?: number | null } }>(
      'pane.process_info',
      { pane_id: e.pane },
    );
    if (p?.shell_pid == null || p.foreground_process_group_id !== p.shell_pid) return; // a program has the terminal
    const { pane: now } = await this.deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: e.pane });
    if (now.scroll?.max_offset_from_bottom !== 0 || (now.terminal_id ?? null) !== e.terminalId) return;
    // a pane made wider re-wraps into fewer rows and can pull all of its history back onto the screen: not a wipe
    const { read: screen } = await this.deps.request<{ read: PaneReadResult }>('pane.read', {
      pane_id: e.pane,
      source: 'recent_unwrapped',
      format: 'ansi',
      strip_ansi: false,
      lines: MAX_READ_ROWS,
    });
    if (e.copy.endsAmong(splitLines(screen.text)) || this.entries.get(e.pane) !== e) return;
    // a program that took the terminal while the screen was read (vim, less) put its own screen in the read: not a wipe
    const { process_info: q } = await this.deps.request<{ process_info: { shell_pid?: number | null; foreground_process_group_id?: number | null } }>(
      'pane.process_info',
      { pane_id: e.pane },
    );
    if (q?.shell_pid == null || q.foreground_process_group_id !== q.shell_pid || this.entries.get(e.pane) !== e) return;
    // output that scrolled while the screen was read put other lines in the read: not a wipe either (the next read
    // lines it up)
    const { pane: after } = await this.deps.request<{ pane: PaneInfo }>('pane.get', { pane_id: e.pane });
    if (after.scroll?.max_offset_from_bottom !== 0 || (after.terminal_id ?? null) !== e.terminalId || this.entries.get(e.pane) !== e) return;
    e.clearCheckEvery = SCROLLBACK_CLEAR_CHECK_MS;
    e.copy.restart();
    this.deps.log.debug('scrollback.cleared', { pane: e.pane });
    const update: ScrollbackUpdate = { reset: true, start: 0, lines: [], gap: false, pane: e.pane, epoch: e.copy.epoch };
    this.emit('update', update);
  }

  private async reads(pane: string, rows: number): Promise<{ visible: string[]; recent: string[]; unwrapped: string[]; truncated: boolean }> {
    const read = (source: string, lines?: number) =>
      this.deps.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source, format: 'ansi', strip_ansi: false, ...(lines ? { lines } : {}) });
    const [visible, recent, unwrapped] = await Promise.all([read('visible'), read('recent', rows), read('recent_unwrapped', rows)]);
    return {
      visible: splitLines(visible.read.text),
      recent: splitLines(recent.read.text),
      unwrapped: splitLines(unwrapped.read.text),
      truncated: recent.read.truncated,
    };
  }
}
