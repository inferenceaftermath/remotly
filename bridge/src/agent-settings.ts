// What `setup` sets in the coding agents of this host so that everything they print stays in the pane's scrollback,
// where herdr and then the bridge keep it for the phones (protocol §4 `scrollback`). A program drawing on the terminal's
// alternate screen leaves no scrollback behind: Claude Code's full-screen renderer and Codex's default do. Claude Code
// has a classic renderer (`"tui": "default"` in its settings.json) and Codex an inline mode (`[tui] alternate_screen =
// "never"` in config.toml); pi always draws inline. Only agents installed here are touched, and only that one key.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './auth/devices.ts';

export interface AgentDirs {
  /** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claude: string;
  /** Codex's: `$CODEX_HOME`, else `~/.codex`. */
  codex: string;
}

export function agentDirs(env: NodeJS.ProcessEnv, home: string): AgentDirs {
  return {
    claude: env['CLAUDE_CONFIG_DIR'] || path.join(home, '.claude'),
    codex: env['CODEX_HOME'] || path.join(home, '.codex'),
  };
}

export type Edit = { kind: 'set'; text: string; was: string | null } | { kind: 'kept' } | { kind: 'error'; message: string };

/** Claude Code's settings.json (null: no file yet) with `"tui": "default"`; every other key as it was. */
export function withClaudeTui(text: string | null): Edit {
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'error', message: 'it is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'error', message: 'it is not a JSON object' };
    settings = parsed as Record<string, unknown>;
  }
  if (settings['tui'] === 'default') return { kind: 'kept' };
  const was = settings['tui'] === undefined ? null : JSON.stringify(settings['tui']);
  settings['tui'] = 'default';
  return { kind: 'set', text: `${JSON.stringify(settings, null, 2)}\n`, was };
}

const NEVER = 'alternate_screen = "never"';

// TOML keys: bare, "basic" or 'literal', dotted with optional blanks around the dots.
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const DOTTED = String.raw`${KEY_PART}(?:\s*\.\s*${KEY_PART})*`;
const HEADER = new RegExp(String.raw`^\s*\[\s*(${DOTTED})\s*\]\s*(?:#.*)?$`);
const ARRAY_HEADER = new RegExp(String.raw`^\s*\[\[\s*(${DOTTED})\s*\]\]\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^(\s*)(${DOTTED})\s*=`);

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** A "basic" TOML string's characters (escapes decoded); null for an escape TOML does not have. */
function basicString(quoted: string): string | null {
  let out = '';
  for (let i = 1; i < quoted.length - 1; i++) {
    const c = quoted[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = quoted[++i]!;
    if (e in ESCAPES) out += ESCAPES[e];
    else if (e === 'u' || e === 'U') {
      const hex = quoted.slice(i + 1, i + 1 + (e === 'u' ? 4 : 8));
      const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === (e === 'u' ? 4 : 8) ? parseInt(hex, 16) : NaN;
      if (!(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += String.fromCodePoint(code);
      i += hex.length;
    } else return null;
  }
  return out;
}

/** A dotted key's parts, unquoted (`"tui" . 'alternate_screen'` → tui, alternate_screen); null for a bad escape. */
function keyParts(dotted: string): string[] | null {
  const parts: string[] = [];
  for (const p of dotted.match(new RegExp(KEY_PART, 'g')) ?? []) {
    const part = p.startsWith('"') ? basicString(p) : p.startsWith("'") ? p.slice(1, -1) : p;
    if (part === null) return null;
    parts.push(part);
  }
  return parts;
}

const samePath = (a: readonly string[] | null, b: readonly string[]): boolean => a !== null && a.length === b.length && a.every((p, i) => p === b[i]);
const startsPath = (a: readonly string[], b: readonly string[]): boolean => a.length >= b.length && b.every((p, i) => p === a[i]);

interface TomlLine {
  /** `[name]` on this line: the table's path. */
  header?: string[];
  /** `[[name]]` on this line: the array of tables' path. */
  arrayHeader?: string[];
  /** `key = value` starts on this line: the key's path, the table it is in (null: the root; `[[…]]` tables are marked
   *  by `inArray`), where its value ends. */
  key?: { path: string[]; table: string[] | null; inArray: boolean; indent: string; written: string; value: string; endLine: number };
}

/**
 * What each line of a TOML file is, as far as setting one key needs: table headers and key lines, never mistaking the
 * inside of a multi-line string, array or inline table for either. Null when the file ends inside one (not valid TOML).
 */
function scanToml(lines: string[]): TomlLine[] | null {
  const out: TomlLine[] = [];
  let ml: string | null = null; // inside a multi-line string: its delimiter
  let depth = 0; // open [ / { of a value
  let table: string[] | null = null;
  let inArray = false;
  let open: TomlLine['key'] | null = null; // the key whose value is still open
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.replace(/\r$/, '');
    const info: TomlLine = {};
    out.push(info);
    let from = 0;
    if (ml === null && depth === 0) {
      open = null;
      const h = HEADER.exec(line);
      const a = h ? null : ARRAY_HEADER.exec(line);
      const k = h || a ? null : KEY_LINE.exec(line);
      if (h || a) {
        const parts = keyParts((h ?? a)![1]!);
        if (!parts) return null;
        table = parts;
        inArray = a !== null;
        if (h) info.header = parts;
        else info.arrayHeader = parts;
        continue;
      }
      if (!k) continue; // blank, comment
      const parts = keyParts(k[2]!);
      if (!parts) return null;
      from = k[0].length;
      info.key = { path: parts, table, inArray, indent: k[1]!, written: k[2]!, value: line.slice(from).trim(), endLine: n };
      open = info.key;
    }
    for (let i = from; i < line.length; i++) {
      const rest = line.slice(i);
      if (ml !== null) {
        if (ml === '"""' && line[i] === '\\') i++;
        else if (rest.startsWith(ml)) {
          // up to two quotes may come just before the closing three (`"""a""""`): the run's last three close it
          let run = 3;
          while (run < 5 && line[i + run] === ml[0]) run++;
          ml = null;
          i += run - 1;
        }
      } else if (line[i] === '#') break;
      else if (rest.startsWith('"""') || rest.startsWith("'''")) {
        ml = rest.slice(0, 3);
        i += 2;
      } else if (line[i] === '"' || line[i] === "'") {
        const q = line[i]!;
        for (i++; i < line.length && line[i] !== q; i++) if (q === '"' && line[i] === '\\') i++;
      } else if (line[i] === '[' || line[i] === '{') depth++;
      else if (line[i] === ']' || line[i] === '}') depth--;
    }
    if (open) open.endLine = n;
  }
  return ml === null && depth === 0 ? out : null;
}

/** The `alternate_screen` settings of the root `tui` table (`[tui]` or dotted `tui.` keys at the root). */
function altScreenKeys(scan: TomlLine[]): NonNullable<TomlLine['key']>[] {
  return scan.flatMap((l) => {
    const k = l.key;
    if (!k || k.inArray) return [];
    const full = k.table === null ? k.path : [...k.table, ...k.path];
    return samePath(full, ['tui', 'alternate_screen']) ? [k] : [];
  });
}
const isNever = (value: string): boolean => /^(["'])never\1\s*(?:#.*)?$/.test(value);

/**
 * Codex's config.toml (null: no file yet) with `alternate_screen = "never"` in its `tui` table: the value replaced where
 * the key is set, else the key added to a `[tui]` table that is there, as a dotted `tui.` key where the root already
 * spells the table that way, or in a `[tui]` table added at the end. Line by line, so comments and layout stay. Anything
 * it cannot edit with certainty (the key set twice or across lines, an inline `tui = { … }`, a file that does not scan)
 * is refused, and the result is scanned again before it is written.
 */
export function withCodexAltScreen(text: string | null): Edit {
  const src = text ?? '';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split('\n');
  const scan = scanToml(lines);
  if (!scan) return { kind: 'error', message: 'it does not read as TOML (it ends inside a string or an array, or has a bad escape)' };
  if (scan.some((l) => l.arrayHeader && l.arrayHeader[0] === 'tui')) return { kind: 'error', message: 'it has [[tui]] array tables' };
  const found = altScreenKeys(scan);
  if (found.length > 1) return { kind: 'error', message: 'it sets tui.alternate_screen more than once' };
  const cr = eol === '\r\n' ? '\r' : '';
  let out: string;
  let was: string | null = null;
  if (found.length === 1) {
    const k = found[0]!;
    if (isNever(k.value)) return { kind: 'kept' };
    const at = scan.findIndex((l) => l.key === k);
    if (k.endLine !== at) return { kind: 'error', message: 'its tui.alternate_screen value spans several lines' };
    was = k.value.replace(/\s*#.*$/, '');
    lines[at] = `${k.indent}${k.written} = "never"${cr}`;
    out = lines.join('\n');
  } else {
    if (scan.some((l) => l.key && l.key.table === null && samePath(l.key.path, ['tui']))) return { kind: 'error', message: 'its tui table is written inline (tui = { … })' };
    const nested = (l: TomlLine): boolean =>
      (!!l.header && startsPath(l.header, ['tui', 'alternate_screen'])) ||
      (!!l.key && !l.key.inArray && startsPath(l.key.table === null ? l.key.path : [...l.key.table, ...l.key.path], ['tui', 'alternate_screen']));
    if (scan.some(nested)) return { kind: 'error', message: 'it has a tui.alternate_screen table' };
    const tui = scan.findIndex((l) => samePath(l.header ?? null, ['tui']));
    const dotted = scan.flatMap((l) => (l.key && l.key.table === null && l.key.path.length > 1 && l.key.path[0] === 'tui' ? [l.key] : []));
    if (tui >= 0) {
      lines.splice(tui + 1, 0, `${NEVER}${cr}`);
      out = lines.join('\n');
    } else if (dotted.length > 0) {
      // the root defines the tui table through dotted keys: a `[tui]` header would define it twice
      lines.splice(dotted[dotted.length - 1]!.endLine + 1, 0, `tui.${NEVER}${cr}`);
      out = lines.join('\n');
    } else {
      out = src;
      if (out.length > 0 && !out.endsWith('\n')) out += eol;
      if (out.trim().length > 0) out += eol;
      out += `[tui]${eol}${NEVER}${eol}`;
    }
  }
  const check = scanToml(out.split('\n'));
  const after = check ? altScreenKeys(check) : [];
  if (after.length !== 1 || !isNever(after[0]!.value)) return { kind: 'error', message: 'the edit could not be verified' };
  return { kind: 'set', text: out, was };
}

/** An executable called `name` in one of `$PATH`'s directories. */
function onPath(env: NodeJS.ProcessEnv, name: string): boolean {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/**
 * Apply `edit` to `file` (through a symlink to the file it points at), keeping its mode. A link to nothing is left alone.
 * `mayWrite`, asked right before a changed file is written (and not when nothing changes), can hold the write back.
 */
function rewrite(file: string, edit: (text: string | null) => Edit, mayWrite?: () => boolean): Edit | { kind: 'blocked' } {
  let target = file;
  let text: string | null = null;
  let mode = 0o600;
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'error', message: (err as Error).message };
    exists = false;
  }
  if (exists) {
    try {
      target = fs.realpathSync(file);
    } catch (err) {
      // writing here would replace the link with a file and leave the file it means missing
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'error', message: 'it is a link to a file that does not exist' };
      return { kind: 'error', message: (err as Error).message };
    }
    try {
      text = fs.readFileSync(target, 'utf8');
      mode = fs.statSync(target).mode & 0o777;
    } catch (err) {
      return { kind: 'error', message: (err as Error).message };
    }
  }
  let result: Edit;
  try {
    result = edit(text);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  if (result.kind !== 'set') return result;
  if (mayWrite && !mayWrite()) return { kind: 'blocked' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileAtomic(target, result.text, mode);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  return result;
}

export interface AgentOut {
  dirs: AgentDirs;
  env: NodeJS.ProcessEnv;
  home: string;
  out: (line: string) => void;
}

/** What became of one agent's setting: not installed here, set (or already so), not set (said why), held back. */
export type AgentOutcome = 'absent' | 'done' | 'error' | 'blocked';

const shownPath = (home: string, p: string): string => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

function claudeInstalled(d: AgentOut): boolean {
  return fs.existsSync(d.dirs.claude) || onPath(d.env, 'claude');
}

/** Claude Code's setting (when it is installed here), and what changed said; `mayWrite` as `rewrite`'s, said by the caller. */
function applyClaude(d: AgentOut, mayWrite?: () => boolean): AgentOutcome {
  if (!claudeInstalled(d)) return 'absent';
  const file = path.join(d.dirs.claude, 'settings.json');
  const r = rewrite(file, withClaudeTui, mayWrite);
  if (r.kind === 'blocked') return 'blocked';
  if (r.kind === 'kept') d.out(`  ✔ Claude Code: "tui": "default" in ${shownPath(d.home, file)}`);
  else if (r.kind === 'set') {
    d.out(`  ✔ Claude Code: "tui": "default" set in ${shownPath(d.home, file)}${r.was ? ` (was ${r.was})` : ''}, so its output stays in the scrollback the phones show`);
    d.out('    a Claude Code session already running redraws badly after this change: in each, /exit, then claude --resume');
  } else {
    d.out(`  ⚠ Claude Code: could not set "tui": "default" in ${shownPath(d.home, file)} (${r.message}); set it by hand for its full scrollback on the phones`);
    return 'error';
  }
  return 'done';
}

/** Codex's setting (when it is installed here), and what changed said. Codex reads it when a session starts. */
function applyCodex(d: AgentOut): AgentOutcome {
  if (!(fs.existsSync(d.dirs.codex) || onPath(d.env, 'codex'))) return 'absent';
  const file = path.join(d.dirs.codex, 'config.toml');
  const r = rewrite(file, withCodexAltScreen);
  if (r.kind === 'kept') d.out(`  ✔ Codex: [tui] alternate_screen = "never" in ${shownPath(d.home, file)}`);
  else if (r.kind === 'set') d.out(`  ✔ Codex: [tui] alternate_screen = "never" set in ${shownPath(d.home, file)}${r.was ? ` (was ${r.was})` : ''}: sessions started from now on keep their output in the scrollback`);
  else {
    d.out(`  ⚠ Codex: could not set [tui] alternate_screen = "never" in ${shownPath(d.home, file)} (${r.kind === 'error' ? r.message : 'held back'}); set it by hand for its full scrollback on the phones`);
    return 'error';
  }
  return 'done';
}

/** Set both agents up (those installed here) and say what changed. */
export function applyAgentSettings(d: AgentOut): void {
  applyClaude(d);
  applyCodex(d);
}

// ---- once per install: what became of these settings ------------------------------------------------------------

/**
 * What became of the agents' settings on this install: `<config dir>/agent-settings.json`. No file: never decided — an
 * install from before setup made them, whose next unattended update makes them once.
 */
export interface AgentSettingsRecord {
  /** `off`: the last setup run by hand had `--no-agent-settings`, and unattended runs leave the agents alone as well. */
  choice: 'on' | 'off';
  /**
   * Settings still to be made (`on` only), per agent with the directory the run that left them used (the daemon's
   * environment may not name it): Claude Code's while a session of it was running (a running session redraws badly
   * when its settings change), either one after an edit that failed. The daemon makes them (`applyPendingAgents`).
   */
  pending?: { claude?: string; codex?: string };
}

export const AGENT_SETTINGS_RECORD = 'agent-settings.json';

/** The record; null when there is none. One that cannot be read counts as `off`: whatever the user chose stands. */
export function readAgentRecord(file: string): AgentSettingsRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : { choice: 'off' };
  }
  try {
    const v = JSON.parse(text) as { choice?: unknown; pending?: unknown };
    if (v.choice === 'off') return { choice: 'off' };
    if (v.choice === 'on') {
      const p = v.pending !== null && typeof v.pending === 'object' ? (v.pending as Record<string, unknown>) : {};
      const pending: NonNullable<AgentSettingsRecord['pending']> = {};
      for (const agent of ['claude', 'codex'] as const) {
        const dir = p[agent];
        if (typeof dir === 'string' && path.isAbsolute(dir)) pending[agent] = dir;
      }
      return Object.keys(pending).length > 0 ? { choice: 'on', pending } : { choice: 'on' };
    }
  } catch {
    /* not JSON */
  }
  return { choice: 'off' };
}

function writeAgentRecord(file: string, record: AgentSettingsRecord, out: (line: string) => void): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600);
  } catch (err) {
    out(`  ⚠ could not write ${file} (${(err as Error).message}): the agents' settings may be looked at again by the next update`);
  }
}

const onRecord = (pending: NonNullable<AgentSettingsRecord['pending']>): AgentSettingsRecord =>
  Object.keys(pending).length > 0 ? { choice: 'on', pending } : { choice: 'on' };

const CLAUDE_RUNNING = '  ⚠ Claude Code is running: "tui": "default" is set once no session of it is (a running session redraws badly when it changes); `remotly-bridge setup` sets it now';

export interface AgentStepDeps extends AgentOut {
  /** The record's path (`<config dir>/agent-settings.json`). */
  record: string;
  /** Whether a Claude Code process of this user runs (`claudeRunning`). */
  claudeRunning: () => boolean;
}

/**
 * setup's step. Run by hand: both agents are set up now (the user reads what changed and what to restart), or with
 * `--no-agent-settings` left alone, and the choice is recorded. Unattended (`update`): only an install with no record
 * (one from before this step) is set up, once — Codex now (it reads its settings when a session starts), Claude Code
 * now unless it is running (a running session redraws badly when its settings change under it; looked at again right
 * before the write), and what is left (a running Claude Code, a failed edit) is left to the daemon. With a record, an
 * unattended run changes nothing: the user's own edits since stand.
 */
export function agentSettingsStep(d: AgentStepDeps, opts: { unattended: boolean; skip: boolean }): void {
  if (opts.skip) {
    writeAgentRecord(d.record, { choice: 'off' }, d.out);
    return;
  }
  if (!opts.unattended) {
    applyAgentSettings(d);
    writeAgentRecord(d.record, { choice: 'on' }, d.out);
    return;
  }
  if (readAgentRecord(d.record) !== null) return;
  const pending: NonNullable<AgentSettingsRecord['pending']> = {};
  if (applyCodex(d) === 'error') pending.codex = d.dirs.codex;
  const claude = applyClaude(d, () => !d.claudeRunning());
  if (claude === 'blocked') d.out(CLAUDE_RUNNING);
  if (claude === 'blocked' || claude === 'error') pending.claude = d.dirs.claude;
  writeAgentRecord(d.record, onRecord(pending), d.out);
}

/**
 * The daemon's part: the settings an unattended run left to be made (`pending`), in the directories it used. Claude
 * Code's only while no session of it runs. `waiting` while one does, `failed` while an edit still fails (both: look
 * again later), `done` when all are made, `none` when nothing is pending (any more). A setup run meanwhile, which
 * rewrites the record, has the last word: the record is read again before each agent and before it is written.
 */
export function applyPendingAgents(d: Omit<AgentStepDeps, 'dirs'>): 'none' | 'waiting' | 'failed' | 'done' {
  const record = readAgentRecord(d.record);
  if (record?.choice !== 'on' || !record.pending) return 'none';
  const seen = JSON.stringify(record);
  const unchanged = (): boolean => JSON.stringify(readAgentRecord(d.record)) === seen;
  const left = { ...record.pending };
  const a: AgentOut = { ...d, dirs: { claude: left.claude ?? '', codex: left.codex ?? '' } };
  let waiting = false;
  if (left.codex !== undefined) {
    if (!unchanged()) return 'none';
    if (applyCodex(a) !== 'error') delete left.codex;
  }
  if (left.claude !== undefined) {
    if (!unchanged()) return 'none';
    const r = applyClaude(a, () => !d.claudeRunning());
    if (r === 'blocked') waiting = true;
    else if (r !== 'error') delete left.claude;
  }
  if (!unchanged()) return 'none';
  writeAgentRecord(d.record, onRecord(left), d.out);
  if (waiting) return 'waiting';
  return Object.keys(left).length > 0 ? 'failed' : 'done';
}

// ---- is Claude Code running? ------------------------------------------------------------------------------------

/** A command line that is Claude Code's CLI: run as `claude` (native, or a link to it), by node, or from its package. */
export function isClaudeCommand(argv: string[]): boolean {
  const [first = '', second = ''] = argv;
  const named = (arg: string): boolean => /(^|\/)claude$/.test(arg);
  return named(first) || first.includes('/claude/versions/') || named(second) || argv.some((a) => a.includes('@anthropic-ai/claude-code'));
}

/** A process that ended between the listing and the look (anything else about it is not known). */
const gone = (err: unknown): boolean => ['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '');

/**
 * Whether a Claude Code process of user `uid` runs: `/proc` where there is one (Linux), `ps` otherwise (macOS). Whatever
 * cannot be read counts as yes (a process whose owner or command line is hidden, no listing at all): the setting then
 * waits rather than garble a session.
 */
export function claudeRunning(uid: number, deps: { procDir?: string; ps?: () => string } = {}): boolean {
  const proc = deps.procDir ?? '/proc';
  let pids: string[] | null = null;
  try {
    pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    pids = null;
  }
  if (pids !== null && pids.length > 0) {
    for (const pid of pids) {
      let owner: number;
      try {
        owner = fs.statSync(path.join(proc, pid)).uid;
      } catch (err) {
        if (gone(err)) continue;
        return true;
      }
      if (owner !== uid) continue;
      let argv: string[];
      try {
        argv = fs.readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').split('\0');
      } catch (err) {
        if (gone(err)) continue;
        return true;
      }
      if (isClaudeCommand(argv)) return true;
    }
    return false;
  }
  try {
    const listing = deps.ps ? deps.ps() : execFileSync('ps', ['-A', '-o', 'uid=,args='], { encoding: 'utf8', timeout: 5000 });
    for (const line of listing.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[1]) === uid && isClaudeCommand(m[2]!.trim().split(/\s+/))) return true;
    }
    return false;
  } catch {
    return true;
  }
}
