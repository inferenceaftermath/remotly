// Shared terminal grid model for the bridge (see shared/protocol/remotly-protocol.md §7).

/** Colour: "d" default, "p<n>" palette 0–255, or "#rrggbb". */
export type Color = string;

/** Attribute bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough, 64 blink. */
export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;
export const ATTR_INVERSE = 16;
export const ATTR_STRIKE = 32;
export const ATTR_BLINK = 64;

export interface Style {
  fg: Color;
  bg: Color;
  a: number;
}

export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({ fg: 'd', bg: 'd', a: 0 });

/** Stable string key for a style, used for de-duplication and per-connection style ids. */
export function styleKey(s: Style): string {
  return `${s.fg}|${s.bg}|${s.a}`;
}

/**
 * A run of cells sharing one style. Either narrow characters (one cell each, `w === t.length` in
 * grapheme count) or exactly one wide grapheme (`w === 2`). Zero-width/combining characters stay
 * attached to the preceding character and do not add width.
 */
export interface Run {
  /** start column (0-based) */
  c: number;
  /** width in cells */
  w: number;
  /** text */
  t: string;
  style: Style;
}

export interface Row {
  runs: Run[];
}

/** Wire form of a run: style replaced by a per-connection style id. */
export interface WireRun {
  c: number;
  w: number;
  s: number;
  t: string;
}

export interface WireLine {
  y: number;
  runs: WireRun[];
}

export interface Frame {
  t: 'frame';
  pane: string;
  rev: number;
  cols: number;
  rows: number;
  full: boolean;
  lines: WireLine[];
  styles: Record<string, Style>;
  /**
   * True while a program other than the shell is in the foreground and herdr holds no scrollback for
   * the pane — i.e. an alternate-screen program (Claude Code, vim, tmux, less). Phones in "auto" scroll
   * mode forward wheel steps then and scroll their own history otherwise. Present when known.
   */
  alt?: boolean;
}

export interface HistoryMessage {
  t: 'history';
  id: string;
  pane: string;
  lines: Array<{ runs: WireRun[] }>;
  styles: Record<string, Style>;
  has_more: boolean;
  /** Lines herdr holds above the screen for this pane; 0 → nothing older exists (alternate-screen program or a fresh shell). */
  scrollback?: number;
}
