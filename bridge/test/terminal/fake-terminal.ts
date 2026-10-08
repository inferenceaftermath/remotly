// A pane as herdr's API shows it, for the scrollback tests: logical lines soft-wrapped at `cols`, the last `screenRows`
// rows on the screen, everything above it history. The reads follow what herdr 0.8 does (docs/herdr-findings.md §2):
// `recent lines=N` is the last N rows of history + the whole screen, the screen's blank bottom rows counted in N but
// not returned; `recent_unwrapped` is the same rows joined back into lines (the first may be cut); rows end in CR LF.
import type { PaneInfo, PaneReadResult } from '../../src/herdr/types.ts';

interface WrappedRow {
  text: string;
  line: number;
}

export class FakeTerminal {
  cols: number;
  readonly screenRows: number;
  /** Every line printed since the last `clear` (blank lines at the end are blank rows at the screen's bottom). */
  lines: string[] = [];
  terminalId = 't1';
  /** A full-screen program is up: herdr reports nothing above the screen. */
  alt = false;
  /** A program other than the shell has the terminal (`pane.process_info`); a full-screen one always does. */
  busy = false;

  constructor(cols: number, screenRows: number) {
    this.cols = cols;
    this.screenRows = screenRows;
  }

  /** herdr's byte cap on its scrollback, as rows: at most this many rows above the screen, the oldest lines go first. */
  historyLimit = Number.POSITIVE_INFINITY;

  print(...lines: string[]): void {
    this.lines.push(...lines);
    while (this.lines.length > 1 && this.historyRows > this.historyLimit) this.lines.shift();
  }

  /** GNU `clear`: screen and scrollback gone. */
  clear(): void {
    this.lines = [];
  }

  private rows(): WrappedRow[] {
    const out: WrappedRow[] = [];
    this.lines.forEach((l, line) => {
      if (l.length === 0) out.push({ text: '', line });
      for (let i = 0; i < l.length; i += this.cols) out.push({ text: l.slice(i, i + this.cols), line });
    });
    while (out.length < this.screenRows) out.push({ text: '', line: -1 });
    return out;
  }

  /** Rows above the screen (`scroll.max_offset_from_bottom`). */
  get historyRows(): number {
    return this.alt ? 0 : Math.max(0, this.rows().length - this.screenRows);
  }

  info(paneId: string): PaneInfo {
    return {
      pane_id: paneId,
      terminal_id: this.terminalId,
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      focused: false,
      agent: null,
      display_agent: null,
      agent_status: 'unknown',
      cwd: '/',
      title: 'bash',
      state_labels: {},
      revision: 1,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: this.historyRows, viewport_rows: this.screenRows },
    } as PaneInfo;
  }

  read(paneId: string, source: string, lines?: number): PaneReadResult {
    const all = this.rows();
    const result = (text: string, truncated: boolean): PaneReadResult =>
      ({ pane_id: paneId, workspace_id: 'w1', tab_id: 'w1:t1', source, format: 'ansi', text, revision: 1, truncated }) as PaneReadResult;
    const trim = (rows: WrappedRow[]): WrappedRow[] => {
      let end = rows.length;
      while (end > 0 && rows[end - 1]!.text === '') end--;
      return rows.slice(0, end);
    };
    if (source === 'visible') return result(trim(all.slice(all.length - this.screenRows)).map((r) => r.text).join('\r\n'), false);
    const n = lines ?? 999;
    const window = trim(all.slice(Math.max(0, all.length - n)));
    const truncated = all.length > n;
    if (source === 'recent') return result(window.map((r) => r.text).join('\r\n'), truncated);
    const joined: string[] = [];
    let last = Number.NaN;
    for (const r of window) {
      if (r.line === last && r.line !== -1) joined[joined.length - 1] += r.text;
      else joined.push(r.text);
      last = r.line;
    }
    return result(joined.join('\r\n'), truncated);
  }

  /** A `request` for ScrollbackKeeper serving this terminal as pane `paneId` (and only it). */
  static request(panes: Record<string, FakeTerminal>, calls?: string[]) {
    return async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls?.push(method === 'pane.read' ? `${method}:${params['source']}:${params['lines'] ?? ''}` : method);
      if (method === 'pane.list') return { panes: Object.entries(panes).map(([id, t]) => t.info(id)) } as T;
      const id = params['pane_id'] as string;
      const t = panes[id];
      if (!t) throw new Error(`pane_not_found ${id}`);
      if (method === 'pane.get') return { pane: t.info(id) } as T;
      if (method === 'pane.read') return { read: t.read(id, params['source'] as string, params['lines'] as number | undefined) } as T;
      if (method === 'pane.process_info') {
        return { process_info: { pane_id: id, shell_pid: 100, foreground_process_group_id: t.alt || t.busy ? 200 : 100, foreground_processes: [] } } as T;
      }
      throw new Error(`unexpected ${method}`);
    };
  }
}
