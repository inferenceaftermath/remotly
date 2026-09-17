// Body of the "finished" alert: the agent's closing words, not the bottom of its screen. Terminal agents draw an
// input box, rules and a status/help line under the transcript, so the naive "last three lines" reads as
// "[Sonnet 5 · medium] 4% | $0.15 · /tmp/flow-capture · ⏸ manual mode on". This strips that chrome from the bottom
// up, then takes the last paragraph that reads like prose (skipping tool calls, their results and the user's own
// message). Pure; tested against shared/fixtures/reads.

/** A rule or box border (any length, tolerating a clipped last cell), or nothing at all. */
const DECOR = /^[\s│┃║╭╮╰╯┌┐└┘├┤┬┴┼─━═╌┄╍┅▎▏▕▐▌░▒▓■□▪▫•·⋯…\-�]*$/;

/** Lines that are UI, not transcript: rules, boxes, the input box, spinners, status and help lines. */
const CHROME: RegExp[] = [
  DECOR,
  /^\s*[❯›▌>$]\s*$/, // an empty input box or shell prompt (with text it is the user's message: see USER_ECHO)
  /^\S+@\S+:.*[$#]\s*$/, // user@host:path$
  /^\s*[✻✽✢✶✳*·]\s+\S/, // Claude Code spinner / turn summary: "✻ Crunched for 3m 4s · done 8:56 PM", "✽ Transmuting… (8m · ↑ 23k tokens)"
  /^\s*(?:⎿\s*)?Tip:/i,
  /^\s*[\w.~-]*(?:\/[\w.~-]*)+\s*(?:\|.*)?$/, // the cwd line: "/tmp/flow-capture |", "user/remotly/bridge | main"
  /^\s*\[[^\]]+\]\s*\d+%\s*\|/, // Claude Code "[Sonnet 5 · medium] 4% | $0.15 | 14s"
  /\b(?:auto|manual|plan) mode (?:on|off)\b/i,
  /\?\s*for shortcuts/i,
  /esc to interrupt/i,
  /shift\+tab/i,
  /ctrl\+\w to /i,
  /accept edits/i,
  /bypass(?:ing)? permissions/i,
  /←\s*for agents/i,
  /Context \d+% used/i,
  /Context left/i,
  /\/model to change/i,
  /\/effort\s*$/i,
  /tmux detected/i,
  /scroll with PgUp/i,
  /auto-?update/i,
  /Update installed/i,
  /Restart to update/i,
  /Ask Codex to do anything/i,
  /^\s*Press (?:enter|esc|return)\b/i, // dialog hints
  /\b(?:Esc|Enter|Tab|Return)\b.*\bto (?:cancel|confirm|amend|select|continue|go back|edit|exit|quit|accept)\b/,
  /^\s*↑\S+\s+↓\S+/, // pi token counters
  /%\/\d+(?:\.\d+)?[MK]\b/, // pi context usage "0.2%/1.0M (auto)"
  /•\s*(?:low|medium|high|xhigh|max)\s*$/i, // pi "(provider) provider/model • high"
  /^\s*Took \d+(?:\.\d+)?s\s*$/i,
  /^\s*(?:└\s*)?\(no output\)\s*$/,
];

/** Paragraphs that are a tool call, its result, a typed command or the user's own message, not the agent's words. */
const NOT_PROSE: RegExp[] = [
  /^\s*[⏺•]\s*[A-Z][A-Za-z]*\(/, // Claude Code tool call: ⏺ Bash(npm test)
  /^\s*[⏺•]\s*(?:Ran|Explored|Edited|Read|Searched|Listed|Added|Updated|Deleted)\b/, // Codex tool lines
  /^\s{1,4}(?:Ran|Read|Listed|Searched|Explored|Edited|Wrote|Updated|Created|Fetched)\b/, // collapsed tool summary: "  Ran 2 shell commands"
  /^\s*[⎿└├]/, // tool results
  /^\s*\$\s/, // command echo (pi)
  /^\s*[❯›>]\s/, // the user's message echoed in the transcript
  /^\s*(?:⎿\s*)?Tip:/i,
];

/** The user's own message echoed in the transcript: the boundary of the current turn. */
const USER_ECHO = /^\s*[❯›>]\s/;
const TOOL_LINE = /^\s*[⎿└├]\s*/;
const MAX_PARAGRAPHS = 12;

export function finishedExcerpt(screen: string, maxChars = 200): string | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  let end = lines.length;
  while (end > 0 && isChrome(lines[end - 1]!)) end--;
  // Paragraphs of the current turn, bottom-up, stopping at the user's message.
  const paragraphs: string[][] = [];
  let i = end - 1;
  while (i >= 0 && paragraphs.length < MAX_PARAGRAPHS) {
    while (i >= 0 && lines[i]!.trim() === '') i--;
    if (i < 0) break;
    const para: string[] = [];
    while (i >= 0 && lines[i]!.trim() !== '') {
      para.unshift(lines[i]!);
      i--;
    }
    if (USER_ECHO.test(para[0]!)) break;
    paragraphs.push(para);
  }
  if (paragraphs.length === 0) return null;
  const prose = paragraphs.find((p) => !NOT_PROSE.some((re) => re.test(p[0]!)));
  if (prose) {
    // Long raw output (a listing, a log) is read from its end; an agent's paragraph from its start.
    const rawOutput = prose.length > 3 && !/^\s*[⏺•■✗]/.test(prose[0]!);
    const text = rawOutput ? tail(prose, maxChars) : clean(prose);
    return text ? truncate(text, maxChars) : null;
  }
  // A turn that ended without prose: the last tool result says what happened ("Interrupted · What should Claude do instead?").
  const last = paragraphs[0]!;
  const tools = last.filter((l) => TOOL_LINE.test(l)).map((l) => l.replace(TOOL_LINE, ''));
  const text = clean(tools.length > 0 ? tools : last);
  return text ? truncate(text, maxChars) : null;
}

function isChrome(line: string): boolean {
  return CHROME.some((re) => re.test(line));
}

/** One line of text from a paragraph: decoration and tool-detail lines dropped, markers and emphasis stripped. */
function clean(para: string[]): string {
  return para
    .filter((l) => !DECOR.test(l) && !/^\s*[⎿└├]/.test(l))
    .map((l) => l.replace(/^\s*[⏺•▎│┃║■]\s?/, '').replace(/\s*[│┃║]\s*$/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last lines of raw output that fit, marked as cut when they do not all fit. */
function tail(para: string[], maxChars: number): string {
  let kept: string[] = [];
  for (let i = para.length - 1; i >= 0; i--) {
    const next = [para[i]!, ...kept];
    if (clean(next).length > maxChars - 1 && kept.length > 0) return '…' + clean(kept);
    kept = next;
  }
  return clean(kept);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  return (space > maxChars * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·—-]+$/, '') + '…';
}
