// What `setup` sets in the coding agents of this host so that everything they print stays in the pane's scrollback,
// where herdr and then the bridge keep it for the phones (protocol §4 `scrollback`). A program drawing on the terminal's
// alternate screen leaves no scrollback behind: Claude Code's full-screen renderer and Codex's default do. Claude Code
// has a classic renderer (`"tui": "default"` in its settings.json) and Codex an inline mode (`[tui] alternate_screen =
// "never"` in config.toml); pi always draws inline. Only agents installed here are touched, and only that one key.
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

/** Apply `edit` to `file` (through a symlink to the file it points at), keeping its mode. A link to nothing is left alone. */
function rewrite(file: string, edit: (text: string | null) => Edit): Edit {
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
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileAtomic(target, result.text, mode);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  return result;
}

/** Set both agents up (those installed here) and say what changed. */
export function applyAgentSettings(deps: { dirs: AgentDirs; env: NodeJS.ProcessEnv; home: string; out: (line: string) => void }): void {
  const shown = (p: string): string => (p === deps.home || p.startsWith(deps.home + path.sep) ? `~${p.slice(deps.home.length)}` : p);
  if (fs.existsSync(deps.dirs.claude) || onPath(deps.env, 'claude')) {
    const file = path.join(deps.dirs.claude, 'settings.json');
    const r = rewrite(file, withClaudeTui);
    if (r.kind === 'kept') deps.out(`  ✔ Claude Code: "tui": "default" in ${shown(file)}`);
    else if (r.kind === 'set') {
      deps.out(`  ✔ Claude Code: "tui": "default" set in ${shown(file)}${r.was ? ` (was ${r.was})` : ''}, so its output stays in the scrollback the phones show`);
      deps.out('    a Claude Code session already running redraws badly after this change: in each, /exit, then claude --resume');
    } else deps.out(`  ⚠ Claude Code: could not set "tui": "default" in ${shown(file)} (${r.message}); set it by hand for its full scrollback on the phones`);
  }
  if (fs.existsSync(deps.dirs.codex) || onPath(deps.env, 'codex')) {
    const file = path.join(deps.dirs.codex, 'config.toml');
    const r = rewrite(file, withCodexAltScreen);
    if (r.kind === 'kept') deps.out(`  ✔ Codex: [tui] alternate_screen = "never" in ${shown(file)}`);
    else if (r.kind === 'set') deps.out(`  ✔ Codex: [tui] alternate_screen = "never" set in ${shown(file)}${r.was ? ` (was ${r.was})` : ''}: sessions started from now on keep their output in the scrollback`);
    else deps.out(`  ⚠ Codex: could not set [tui] alternate_screen = "never" in ${shown(file)} (${r.message}); set it by hand for its full scrollback on the phones`);
  }
}
