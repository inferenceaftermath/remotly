// Key names accepted from phones (§9) and how they reach herdr. herdr rejects the navigation keys
// below with `invalid_key` (docs/herdr-findings.md §6); they are sent as raw escape sequences instead.

export const RAW_KEYS: Readonly<Record<string, string>> = {
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
};

const SIMPLE = new Set(['esc', 'tab', 'enter', 'backspace', 'up', 'down', 'left', 'right', 'space', 'minus', 'plus', 'backtick']);
const MODIFIED = /^(?:ctrl|alt|shift|super|ctrl\+shift|ctrl\+alt|alt\+shift)\+(?:[a-z0-9]|enter|tab|up|down|left|right|esc|backspace|space|f(?:[1-9]|1[0-2]))$/;
const FKEY = /^f(?:[1-9]|1[0-2])$/;
const SINGLE_CHAR = /^[\x21-\x7e]$/;

export function isKnownKey(key: string): boolean {
  // Own keys only: `'constructor' in RAW_KEYS` is true through Object.prototype, and the "escape" would be a function.
  return Object.hasOwn(RAW_KEYS, key) || SIMPLE.has(key) || FKEY.test(key) || MODIFIED.test(key) || SINGLE_CHAR.test(key);
}

export type KeyBatch = { kind: 'keys'; keys: string[] } | { kind: 'text'; text: string };

export type ScrollDirection = 'up' | 'down';

/**
 * One SGR (mode 1006) mouse-wheel report as a program with mouse tracking on would receive it from a
 * real terminal: button 64 = wheel up, 65 = wheel down; `col`/`row` are 1-based and only matter to
 * programs that route the wheel by position (tmux picks the pane under the pointer).
 */
export function wheelReport(direction: ScrollDirection, col: number, row: number): string {
  const c = Math.min(Math.max(Math.floor(col), 1), 9999);
  const r = Math.min(Math.max(Math.floor(row), 1), 9999);
  return `\x1b[<${direction === 'up' ? 64 : 65};${c};${r}M`;
}

/**
 * Split a key list into ordered herdr calls: consecutive herdr-native keys become one `pane.send_keys`,
 * raw-escape keys become `pane.send_text`. Returns null when a key is unknown.
 */
export function planKeys(keys: string[]): KeyBatch[] | null {
  const out: KeyBatch[] = [];
  for (const raw of keys) {
    const key = raw.trim().toLowerCase();
    if (!isKnownKey(key)) return null;
    const escape = Object.hasOwn(RAW_KEYS, key) ? RAW_KEYS[key] : undefined;
    const last = out[out.length - 1];
    if (escape !== undefined) {
      if (last?.kind === 'text') last.text += escape;
      else out.push({ kind: 'text', text: escape });
    } else if (last?.kind === 'keys') last.keys.push(key);
    else out.push({ kind: 'keys', keys: [key] });
  }
  return out;
}
