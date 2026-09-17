// Structured view of an agent's approval dialog, parsed from the pane's visible text so the phones can
// show a card (tool, command or path, description, question, offered options) instead of raw screen lines.
// Verified against shared/fixtures/reads/{claude,codex}-permission-prompt.txt; anything unrecognised
// yields null and the apps fall back to the excerpt.

export interface ApprovalDetails {
  /** `Bash`, `Edit`, `Write`, `Read`, … (Claude's dialog header without "command"/"file"); `Shell` for Codex commands. */
  tool: string | null;
  /** The command line about to run. */
  command: string | null;
  /** The file a file tool wants to touch. */
  path: string | null;
  /** Claude's one-line summary or Codex's `Reason:`. */
  description: string | null;
  /** `Do you want to proceed?`, `Would you like to run the following command?`, … */
  question: string;
  /** The numbered choices in dialog order, selection marker removed. */
  options: string[];
  /** 1-based index of the choice carrying the selection marker (❯ / ›), or null when none is visible. */
  selected: number | null;
  /**
   * `permission`: a yes/no gate before a tool runs (the agent's approve/deny key map applies; notifications offer
   * Approve / Deny). `choice`: any other menu (AskUserQuestion, pickers), answered by moving the cursor (`choose`).
   */
  kind: 'permission' | 'choice';
}

/** A dialog needs at least this many numbered choices to count as one. */
const MIN_OPTIONS = 2;
/** How far above the choices the question may be (Codex puts the command and reason in between). */
const QUESTION_REACH = 12;
/** How far above the question a Claude-style rule may be. */
const RULE_REACH = 40;
const MAX_HEAD_LINES = 12;
const MAX_FIELD = 300;

const OPTION = /^\s*(?:([❯›>»])\s*)?(\d+)\.\s+(.*\S)\s*$/;
/** A permission gate: the question asks for consent and the first choice is a plain yes. */
const PERMISSION_QUESTION = /^(do you want to|would you like to|allow\b|approve\b|permission\b)/i;
const YES = /^yes\b/i;
const RULE = /^\s*[─━═╌┄-]{8,}\s*$/;
/** Box borders and their leftovers once the side bars are stripped. */
const BOX_ONLY = /^[\s│┃╭╮╰╯├┤┬┴┼─━═╌┄]*$/;
const PROMPT_ECHO = /^[❯›>•●]\s/;
const TIP = /^\s*Tip:/i;
const TOOL_HEADER = /^(\S+)\s+(command|file)$/i;
const FILE_TOOL = /^(edit|write|read|create|delete|move|rename|notebook\s*edit)$/i;

function clip(s: string): string {
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD - 1) + '…' : s;
}

function stripBox(line: string): string {
  return line.replace(/^\s*[│┃]\s?/, ' ').replace(/\s?[│┃]\s*$/, '');
}

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

interface Options {
  start: number;
  labels: string[];
  /** 1-based index of the marked label, or null. */
  selected: number | null;
}

/** The last run of `1.`, `2.`, … lines (with wrapped continuations), or null. */
function findOptions(lines: string[]): Options | null {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const entries: { n: number; label: string; marked: boolean }[] = [];
  let i = last;
  let start = last;
  for (; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) break;
    const m = OPTION.exec(line);
    if (m) {
      entries.unshift({ n: Number(m[2]), label: m[3]!, marked: m[1] !== undefined });
      start = i;
      if (entries[0]!.n === 1) break;
      continue;
    }
    // wrapped continuation of the option below: indented deeper than an option marker, no number
    if (indent(line) >= 3 && entries.length > 0 && i > 0) {
      // temporarily hold; attached once the owning option is found
      entries.unshift({ n: NaN, label: line.trim(), marked: false });
      continue;
    }
    break;
  }
  // merge continuations (NaN entries) into the option above them
  const labels: string[] = [];
  let selected: number | null = null;
  let pendingTail: string[] = [];
  for (const e of entries) {
    if (Number.isNaN(e.n)) {
      pendingTail.push(e.label);
      continue;
    }
    if (labels.length > 0 && pendingTail.length > 0) labels[labels.length - 1] = [labels[labels.length - 1]!, ...pendingTail].join(' ');
    pendingTail = [];
    labels.push(e.label);
    if (e.marked) selected = labels.length;
  }
  if (pendingTail.length > 0 && labels.length > 0) labels[labels.length - 1] = [labels[labels.length - 1]!, ...pendingTail].join(' ');
  if (labels.length < MIN_OPTIONS) return null;
  if (!/^1\./.test(lines[start]!.replace(/^\s*[❯›>»]?\s*/, ''))) return null;
  return { start, labels: labels.map((l) => clip(l.replace(/\s+/g, ' ').trim())), selected };
}

/** Index of the question line: the nearest line above the options ending in `?`, not a prompt echo. */
function findQuestion(lines: string[], optionsStart: number): number {
  let seen = 0;
  for (let i = optionsStart - 1; i >= 0 && seen < QUESTION_REACH; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    seen++;
    if (PROMPT_ECHO.test(line.trimStart())) continue;
    if (/^\s*(Reason:|Environment:|\$\s)/.test(line)) continue; // Codex's reason may itself end in `?`
    if (/\?\s*$/.test(line)) return i;
  }
  return -1;
}

export function parseApprovalDialog(text: string): ApprovalDetails | null {
  const lines = text.replace(/\r/g, '').split('\n').map(stripBox);
  const options = findOptions(lines);
  if (!options) return null;
  const q = findQuestion(lines, options.start);
  if (q < 0) return null;
  const details: ApprovalDetails = {
    tool: null,
    command: null,
    path: null,
    description: null,
    question: clip(lines[q]!.trim()),
    options: options.labels,
    selected: options.selected,
    kind: 'choice',
  };

  // Codex style: the command and the reason sit between the question and the choices.
  const mid = lines.slice(q + 1, options.start);
  const descriptions: string[] = [];
  for (let i = 0; i < mid.length; i++) {
    const line = mid[i]!;
    if (line.trim().length === 0 || BOX_ONLY.test(line)) continue;
    const cmd = /^\s*\$\s+(.*\S)\s*$/.exec(line);
    if (cmd) {
      let command = cmd[1]!;
      while (i + 1 < mid.length && mid[i + 1]!.trim().length > 0 && indent(mid[i + 1]!) > indent(line) && !/^\s*\$\s/.test(mid[i + 1]!)) command += ' ' + mid[++i]!.trim();
      details.command = clip(command);
      details.tool ??= 'Shell';
      continue;
    }
    const reason = /^\s*Reason:\s*(.*\S)\s*$/.exec(line);
    if (reason) {
      let text = reason[1]!;
      while (i + 1 < mid.length && mid[i + 1]!.trim().length > 0 && indent(mid[i + 1]!) > 2 && !/^\s*(\$\s|Environment:|Reason:)/.test(mid[i + 1]!)) text += ' ' + mid[++i]!.trim();
      descriptions.push(text);
      continue;
    }
    if (/^\s*Environment:/.test(line)) continue;
    descriptions.push(line.trim());
  }

  // Claude style: a rule, a tool header, the command or file, a one-line summary, then the question.
  let rule = -1;
  for (let i = q - 1; i >= 0 && q - i <= RULE_REACH; i--) {
    if (RULE.test(lines[i]!)) {
      rule = i;
      break;
    }
  }
  if (rule >= 0) {
    const head = lines
      .slice(rule + 1, q)
      .filter((l) => l.trim().length > 0 && !BOX_ONLY.test(l) && !TIP.test(l))
      .map((l) => l.trim());
    const header = head[0];
    if (header !== undefined && head.length <= MAX_HEAD_LINES && !PROMPT_ECHO.test(header)) {
      const body = head.slice(1);
      const tool = TOOL_HEADER.exec(header);
      details.tool = clip(tool ? tool[1]! : header);
      const isCommand = tool ? /command/i.test(tool[2]!) : false;
      if (isCommand && body.length > 0) {
        details.command ??= clip(body[0]!);
        if (body.length > 1) descriptions.unshift(body.slice(1).join(' '));
      } else if (tool && FILE_TOOL.test(tool[1]!)) {
        details.path = body.find((l) => /^\S+$/.test(l) && /[/.]/.test(l)) ?? null;
      } else if (body.length > 0) {
        descriptions.unshift(body.slice(0, 3).join(' '));
      }
    }
  }
  if (descriptions.length > 0) details.description = clip(descriptions.join(' ').replace(/\s+/g, ' ').trim());
  if (PERMISSION_QUESTION.test(details.question) && YES.test(details.options[0] ?? '')) details.kind = 'permission';
  return details;
}
