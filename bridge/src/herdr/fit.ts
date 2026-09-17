// Fit a herdr pane's PTY to the phone that is looking at it (remotly-protocol.md §4 `fit`).
//
// herdr has no resize API, but the PTY size can be set on the pane's tty with `stty` (the same tty
// the bridge already probes for the column count). The foreground program gets SIGWINCH and
// re-renders at the phone's size; herdr only reapplies its own layout size on a layout change,
// which the bridge observes as a snapshot and answers by re-applying the fit (measured 2026-09-04). When the last phone stops looking, the pane goes back to herdr's size.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface FitSize {
  cols: number;
  rows: number;
}

export const FIT_LIMITS = { cols: { min: 20, max: 500 }, rows: { min: 5, max: 300 } } as const;

export interface PaneFitterDeps {
  /** Resolve the pane's tty (`/dev/pts/N`); null when unavailable (pane gone, shell exited). */
  ttyOf: (pane: string) => Promise<string | null>;
  /** `stty -F <tty> <args…>`; injectable for tests. */
  stty?: (tty: string, args: string[]) => Promise<string>;
  log: { info(event: string, fields?: Record<string, unknown>): void; debug(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}

interface Fit {
  owner: object;
  size: FitSize;
}

interface PaneRecord {
  tty: string;
  /** herdr's own size, captured before the first fit and refreshed after each layout change. */
  original: FitSize | null;
  /** Oldest first; the last entry is the size in effect (most recent viewer wins). */
  fits: Fit[];
  /** Last size written to the PTY by the fitter (null before the first write). */
  applied?: FitSize | null;
}

export class FitUnavailableError extends Error {
  constructor(pane: string, reason: string) {
    super(`cannot resize ${pane}: ${reason}`);
    this.name = 'FitUnavailableError';
  }
}

function defaultStty(tty: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('stty', ['-F', tty, ...args], { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

/** Emits `fitted (pane, size)` after every size actually written to a tty (fit, re-fit, restore). */
export class PaneFitter extends EventEmitter {
  private readonly panes = new Map<string, PaneRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ttyOf: PaneFitterDeps['ttyOf'];
  private readonly stty: NonNullable<PaneFitterDeps['stty']>;
  private readonly log: PaneFitterDeps['log'];

  constructor(deps: PaneFitterDeps) {
    super();
    this.ttyOf = deps.ttyOf;
    this.stty = deps.stty ?? defaultStty;
    this.log = deps.log;
  }

  /** The size currently imposed on `pane`, if any viewer fits it. */
  active(pane: string): FitSize | null {
    const rec = this.panes.get(pane);
    const last = rec?.fits.at(-1);
    return rec && last ? this.effective(rec, last.size) : null;
  }

  /**
   * What is actually written for a requested fit: the phone's columns, herdr's rows. herdr's own
   * screen keeps its row count (its API cannot resize a pane), so a PTY shorter than that screen
   * would make the program lay out for rows that spill below the phone's view and never scroll into
   * history. Columns are safe: shorter lines simply use the left of herdr's grid.
   */
  private effective(rec: PaneRecord, requested: FitSize): FitSize {
    return { cols: requested.cols, rows: rec.original?.rows ?? requested.rows };
  }

  /** Panes this owner is currently fitting. */
  panesOf(owner: object): string[] {
    const out: string[] = [];
    for (const [pane, rec] of this.panes) if (rec.fits.some((f) => f.owner === owner)) out.push(pane);
    return out;
  }

  /** Impose `size` on `pane` for `owner` (replacing the owner's previous fit). Resolves to the size written. */
  apply(pane: string, owner: object, size: FitSize): Promise<FitSize> {
    return this.serial(pane, async () => {
      const createdRec = !this.panes.has(pane);
      let rec = this.panes.get(pane);
      if (!rec) {
        const tty = await this.ttyOf(pane);
        if (!tty) throw new FitUnavailableError(pane, 'no tty');
        rec = { tty, original: await this.readSize(tty), fits: [], applied: null };
        this.panes.set(pane, rec);
      }
      const before = rec.fits; // the viewer list as it was, restored whole (precedence included) if the write fails
      rec.fits = [...rec.fits.filter((f) => f.owner !== owner), { owner, size }];
      const target = this.effective(rec, size);
      try {
        // Phones re-send on every keyboard show/hide (rows change); nothing to do when the PTY already has this size.
        if (!rec.applied || rec.applied.cols !== target.cols || rec.applied.rows !== target.rows) await this.write(pane, rec, target);
      } catch (err) {
        // Roll back only if the size was never imposed: `write` records `rec.applied = target` the moment stty
        // succeeds, so anything thrown after that (its log or a `fitted` listener) left the PTY resized and the
        // record must stand. Otherwise put the viewer list back exactly as it was, so this owner is neither left as
        // a ghost nor promoted past a newer viewer — either would mislead the next release/refit/layout reconcile —
        // and drop a record created only for this failed apply.
        if (rec.applied !== target) {
          rec.fits = before;
          if (createdRec) this.panes.delete(pane);
        }
        throw err;
      }
      return target;
    });
  }

  /** Drop `owner`'s fit on `pane`; the next most recent fit takes over, or herdr's size returns. */
  release(pane: string, owner: object): Promise<void> {
    return this.serial(pane, async () => {
      const rec = this.panes.get(pane);
      if (!rec || !rec.fits.some((f) => f.owner === owner)) return;
      rec.fits = rec.fits.filter((f) => f.owner !== owner);
      const next = rec.fits.at(-1);
      if (next) {
        const target = this.effective(rec, next.size);
        if (!rec.applied || rec.applied.cols !== target.cols || rec.applied.rows !== target.rows) await this.write(pane, rec, target);
        return;
      }
      this.panes.delete(pane);
      if (rec.original) await this.write(pane, rec, rec.original, 'restore');
    });
  }

  async releaseAll(owner: object): Promise<void> {
    await Promise.all(this.panesOf(owner).map((pane) => this.release(pane, owner)));
  }

  /**
   * herdr changed the layout and reapplied its own PTY sizes. Capture the new native size as the
   * value to restore later, then put the fit back.
   */
  async onLayoutChanged(): Promise<void> {
    await Promise.all(
      [...this.panes.keys()].map((pane) =>
        this.serial(pane, async () => {
          const rec = this.panes.get(pane);
          const active = rec?.fits.at(-1);
          if (!rec || !active) return;
          const tty = await this.ttyOf(pane);
          if (!tty) {
            this.panes.delete(pane); // pane or shell gone: nothing left to restore
            return;
          }
          rec.tty = tty;
          const now = await this.readSize(tty);
          const current = this.effective(rec, active.size);
          if (!now || (now.cols === current.cols && now.rows === current.rows)) return;
          rec.original = now; // herdr's new native size: restore target, and the row count the fit follows
          await this.write(pane, rec, this.effective(rec, active.size), 'refit');
        }),
      ),
    );
  }

  /** The bridge is stopping: give every fitted pane herdr's size back, whoever holds it, and forget them all. */
  async restoreAll(): Promise<void> {
    await Promise.all(
      [...this.panes.keys()].map((pane) =>
        this.serial(pane, async () => {
          const rec = this.panes.get(pane);
          if (!rec) return;
          this.panes.delete(pane);
          if (!rec.original) return;
          try {
            await this.write(pane, rec, rec.original, 'restore');
          } catch (err) {
            this.log.warn('pane.fit.restore_failed', { pane, error: (err as Error).message });
          }
        }),
      ),
    );
  }

  /** herdr went away: the PTYs will be re-sized by herdr itself when it returns. */
  reset(): void {
    this.panes.clear();
  }

  private async write(pane: string, rec: PaneRecord, size: FitSize, why: 'fit' | 'refit' | 'restore' = 'fit'): Promise<void> {
    try {
      await this.stty(rec.tty, ['rows', String(size.rows), 'cols', String(size.cols)]);
    } catch (err) {
      throw new FitUnavailableError(pane, (err as Error).message);
    }
    rec.applied = size;
    this.log.info('pane.fit', { pane, why, cols: size.cols, rows: size.rows, viewers: rec.fits.length });
    this.emit('fitted', pane, size);
  }

  private async readSize(tty: string): Promise<FitSize | null> {
    try {
      const [rows, cols] = (await this.stty(tty, ['size'])).trim().split(/\s+/).map(Number);
      return rows && cols ? { rows, cols } : null;
    } catch {
      return null;
    }
  }

  /** Per-pane serialisation so apply/release/refit never interleave on one tty. */
  private serial<T>(pane: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(pane) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(pane, next.catch(() => undefined));
    return next;
  }
}

export function parseFitSize(m: Record<string, unknown>): FitSize | string {
  const cols = m['cols'];
  const rows = m['rows'];
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < FIT_LIMITS.cols.min || cols > FIT_LIMITS.cols.max) return `cols must be an integer ${FIT_LIMITS.cols.min}…${FIT_LIMITS.cols.max}`;
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < FIT_LIMITS.rows.min || rows > FIT_LIMITS.rows.max) return `rows must be an integer ${FIT_LIMITS.rows.min}…${FIT_LIMITS.rows.max}`;
  return { cols, rows };
}
