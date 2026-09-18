# Remotly phone apps — design system

Source of truth for how the iOS and Android apps look and behave. Derived from the product site's phone mockup
(remotly.dev preview, `Story.astro`); when the site and this file disagree, this file wins for the apps and the site
should be updated. Both apps implement every item here identically (`docs/BACKLOG.md` parity rule). Written 2026-09-08.

Sizes are points (iOS) / dp and sp (Android). The site's mockup is drawn at 340 px wide; its pixel values were scaled
by about 1.15 to phone points.

## 1. Tokens

The apps are dark only (iOS forces `UIUserInterfaceStyle` Dark; Android's theme is dark). No system colours: every
surface, text and hairline below comes from this table. Define them once per app (`Theme.swift` / `Theme.kt`) and use
those names everywhere.

| Token | Value | Use |
|---|---|---|
| `bg` | `#0B0C0E` | screen background and terminal background (one colour, the terminal is flush) |
| `panel` | `#141618` | cards: host banner, approval card, fields |
| `panel2` | `#1B1E22` | key caps, composer, option buttons, segmented control |
| `line` | `#262A2F` | hairlines and borders |
| `separator` | `#20242A` | list row separators |
| `pillBg` | `#191C20` | status pill background |
| `raised` | `#2E3238` | option button border, segmented "on" fill |
| `fg` | `#E0E2E5` | primary text |
| `fg2` | `#B4B9C0` | secondary text (status words, hints, banner values) |
| `fg3` | `#6E737B` | faint text (section labels, row folders, placeholders) |
| `titleFg` | `#D5D8DD` | pane title, key cap glyphs |
| `accent` | `#2DD4BF` | teal: tool name, marked option border, Ctrl armed, viewfinder corners, Approve on the lock screen |
| `accentWash` | `#2DD4BF` at 8 % | marked option fill |
| `interactive` | `#7AA2F7` | blue: back chevron, text links, send button, Pair button, the New terminal button, switches on |
| `onInteractive` | `#0B0C0E` | text on `interactive` and on `accent` |
| `blocked` | `#F7768E` | status rose; also destructive text |
| `working` | `#E0AF68` | status amber |
| `idle` | `#7AA2F7` | status blue |
| `done` | `#9ECE6A` | status green; toast ok variant |
| `toastBg` / `toastFg` | `#E0E2E5` / `#0B0C0E` | toast (ok variant: `done` / `#0B0C0E`) |
| `selection` | `#7AA2F7` at 35 % | terminal text selection |

Status colour for an unknown status or a pane without an agent: `fg3`. A pane "has an agent" when herdr names one
(`agent`) or at least shows one (`display_agent`).

**Terminal palette** (ANSI 0–15; 16–231 the standard xterm cube with levels 0, 95, 135, 175, 215, 255; 232–255 greys
8 + 10 n). Default foreground `fg`, default background `bg`.

```
0 #1B2230  1 #F7768E  2 #9ECE6A  3 #E0AF68  4 #7AA2F7  5 #BB9AF7  6 #7DCFFF  7 #A9B1D6
8 #414868  9 #F7768E 10 #9ECE6A 11 #E0AF68 12 #7AA2F7 13 #BB9AF7 14 #7DCFFF 15 #C0CAF5
```

## 2. Typography

- **Sans** = the platform system font (SF Pro / Roboto). Sentences, questions, option labels, hints, settings, buttons
  with words (Pair, Create, Approve).
- **Mono** = JetBrains Mono, bundled in both apps (Regular and Bold; iOS resources `Remotly/Fonts/JetBrainsMono-*.ttf`,
  PostScript names `JetBrainsMono-Regular` / `JetBrainsMono-Bold`; Android `res/font/jetbrains_mono_*`). Anything that
  names a thing or comes from the terminal: host name, pane names, status pill text, key caps, section labels, the
  problem banner, elapsed time, tool name, command block, pane title, toast text, terminal.
- Section label: mono 12, uppercase, letter spacing 0.12 em, `fg3`.
- Status pill: mono 12. Key cap: mono 15 (a single glyph — arrows, ⏎, ⌫, the Ctrl letters — mono 18). Elapsed time:
  mono 14 with tabular digits.
- List row title: mono 15 semibold `fg`; row line 2: mono 13 (folder `fg3`, status word in its colour).
- Pane title: mono 15 `titleFg`, one line.
- Card head: mono 13 (tool semibold `accent`, kind `fg3`); command block: mono 12.5 `fg`; question: sans 15 semibold
  `fg`; description: sans 14 `fg2`; option: sans 14 medium `fg`.
- Composer text: sans 15; placeholder `fg3`. Toast: mono 12.5. Host banner: mono 12.5. Hints: sans 15 `fg2`.
- Nav titles: pairing "Pair with a host" sans 17 semibold centred; pane list title = host name, mono 16 `fg`,
  left-aligned.

Radii: toast and pill full; composer 16; option 10; field 12; key cap 8; command block 8; host banner 14; viewfinder 18;
Pair button 14; segmented control 10 (segments 8). Hairlines are 1 pt `line`. Screen horizontal inset 16.

## 3. Status vocabulary

Pills, list rows and the Live Activity use these fixed words, never herdr's raw status or its `state_label` (the label
is not shown anywhere; the approval card says what the agent waits for). The colour goes on the row's status word and
on the status mark's chevron (§4.12), which replaced the status dot everywhere:

| agent_status | Word | Colour |
|---|---|---|
| `blocked`, `approval.kind == "choice"` | Has a question | `blocked` |
| `blocked` | Waiting for approval | `blocked` |
| `working` | Working | `working` |
| `idle` | Idle | `idle` |
| `done` | Done | `done` |
| `unknown` / no agent | (no word; the mark's chevron in `fg3`) | `fg3` |

Client-side transient words: **Fitting…** (`working` colour) on the pane view pill from the moment a `fit` request is
sent until the first frame after its reply (or 3 s after the reply when no frame comes); connection pill on the list header: **Connected** (`done`), **Connecting…**
and **Reconnecting…** (`working`), **Offline** and **Not paired** (`blocked`).

## 4. Components

### 4.1 Status pill
8 pt dot in the status colour, 6 pt gap, the word in mono 12 in the status colour; background `pillBg`, 1 pt `line`
border, padding 3 × 8, fully rounded.

### 4.2 Toast
One shared component, used for every transient notice on every screen (it replaces the iOS bottom capsule and the
Android Snackbar). Top centre, 8 pt below the navigation bar, fully rounded pill, mono 12.5, padding 6 × 11, max width
88 %. Plain variant `toastBg`/`toastFg`; **ok** variant `done`/`#0B0C0E`. Enters by sliding down 8 pt while fading in
over 250 ms, leaves after 2.4 s. Copy is lowercase, dotted: `fit · pty resized to 54 cols` (ok), `approval.result · sent`
(ok), `copied`, `<title> closed`, `pairing with <host>…`; errors use the plain variant with the error text.

### 4.3 Pane list (home)
- **Header.** Title = host name, mono 16, left-aligned (iOS: the toolbar's principal slot, never `.topBarLeading`, see
  §4.4). Trailing: the connection pill (§3), then a gear icon in `fg2` for Settings. Nothing else: no Arrange button and
  no "+" in the header (the New terminal button floats over the list, below).
- **Problem banner**, under the header only while the connection is not `connected` or herdr is down (the host facts —
  bridge, certificate, device — live in Settings › Host and nowhere else): `panel`, `line` border, radius 14, padding
  10 × 12, one line of mono 12.5 in the status colour with an action under it: "Connecting…", "Reconnecting… · attempt
  <n>" (`working`) and "Offline" (`blocked`) with "Retry now"; "This phone is no longer paired." (`blocked`) with "Forget
  host and pair again"; and, connected but herdr down, "herdr is down on the host · pane actions will fail until it is
  back" (`blocked`, no action). Nothing while everything is up.
- **Sections**, in this order, each omitted when empty. "Needs you": blocked panes with an agent, soonest `since`
  first (a blocked pane appears only there). Then one section per herdr tab in herdr's order, labelled with the tab label
  (prefixed "<workspace> › " when there is more than one workspace), rows working → idle → done → other agents → plain
  shells, then by title; panes whose tab is not in the snapshot go under "Other". Section label style §2, 18 pt above, 6
  below.
- **Row**, two lines, separated by 1 pt `separator` on top, padding 12 × 4: the tool glyph (§4.12, 16 pt, in the tool's
  own colour, still) with a 10 pt gap, then the text block. Line 1, the session title in mono 15 semibold `fg`: the pane `title` (the
  bridge has removed the agent's status glyph; for Claude Code this is the session's topic, "Nightly app delivery
  failures"), else the cwd basename, else the pane id; one line, truncated at the end. Line 2, mono 13, 2 pt below: the
  cwd basename in `fg3` when a cwd is known and its basename is not line 1, then " · <status word>" (§3) in the status
  colour. The agent id is not written anywhere: the glyph says which tool runs in the pane (its accessibility label is
  the tool's display name, "Terminal" for a shell). A plain shell has no word: line 2 is the cwd basename alone, or is
  omitted. Trailing,
  vertically centred: a small bell in `fg3` when "Tell me when it's done" is armed, and the elapsed time in mono 14
  tabular `fg2` for `working` and `blocked` panes (`mm:ss`, `h:mm:ss` past an hour, ticking every second from the
  snapshot's `since`).
- **Row actions.** Two gestures and nothing else: a tap opens the pane; a long press (with the platform's long-press
  haptic) opens the row's menu of exactly one item — "Close terminal", which asks first with the pane overflow's dialog
  ("Close <title>?" · "Ends the shell on the desktop and anything running in it." · Close terminal · Cancel). iOS: the
  system context menu (the row lifts and previews); Android: a menu anchored to the row in the pane overflow's look
  (`panel2`, 1 pt `line` border, radius 12, `Type.body`; Close terminal in `blocked`). No swipe actions, no inline
  buttons: Approve / Deny live on the pane's card, the notification and the Live Activity. Assistive tech gets the item
  as a named action on the row. No pinning and no reordering: the list is herdr's layout and the phone keeps no order of
  its own (both were removed on 2026-09-09 at the owner's request, after the reorder never worked on the iPhone and
  unpinning misbehaved; they are not to come back).
- **New terminal button.** A round 52 pt disc in `interactive` with a "+" in `onInteractive` (iOS SF Symbol `plus`, 22
  semibold; Android `Icons.Default.Add`, 24 dp), at the bottom-right corner of the list, 16 pt from the trailing edge and
  the bottom safe area; it floats over the list and stays put while the list scrolls (the list's bottom content margin,
  92 pt, keeps the last row clear of it). Shown whenever a snapshot exists; 40 % opacity and inert while the connection
  is not `connected` (the banner says why). Opens the New terminal sheet (§4.10). Accessibility label "New terminal".
  Nothing at the end of the list: the button replaced the "+ New terminal" footer row on 2026-09-09.
- **States.** No snapshot yet (the header pill already says Connecting… / Offline / Not paired; no banner, no second
  pill): centred "Waiting for the bridge…" (sans 15 `fg2`) and a "Retry now" text button in `interactive`. Unpaired: "This phone is no longer paired." and "Forget host and pair
  again". Empty snapshot: "No panes open in herdr." centred, the New terminal button in its corner. Pull to refresh reconnects.

### 4.4 Pane view
- **Header.** Back chevron in `interactive` with no text. Title, left-aligned, one line, mono 15 `titleFg` = the session
  title (the pane `title`, else the cwd basename, else the pane id; the same as the list row's line 1); nothing under it
  (no agent, no size, no fit readout, no state label — the card below says what the agent waits for). Trailing: the
  status mark (§4.12, 18 pt, animated while working; replaced by the connection pill of §3 while the connection is not
  `connected`, this screen has no banner, and by a "Fitting…" pill per §3 while a fit is in flight), the A− / A+
  text-size buttons (one step each, `fg2`; iOS draws them with the `textformat.size.smaller` / `.larger` symbols, Android
  as the letters) and one overflow button in `fg2`. A− / A+ are the only text-size control: no pinch, nothing in the
  overflow, nothing in Settings. On iOS the title and the mark sit in the toolbar's principal slot, never in
  `.topBarLeading`: iOS 26 wraps leading items in a glass circle and truncates them.
- **Terminal** flush on `bg`, no border; selection in `selection`.
- **Scrollback:** the "Live ↓" button is a pill in `interactive` / `onInteractive`, bottom right, 12 pt inset. The
  no-scrollback hint is a `panel` card with `line` border, radius 10, at the top: the sentence in sans 14 `fg` and
  "Use mouse wheel" as a text button in `interactive`; tap elsewhere on it dismisses.
- **Overflow menu**, same items and order on both: Copy screen · Raw text mode (checkmark when on) · Tell me when it's
  done (checkmark when armed; only with an agent) · Swiping up and down (the four modes Automatic · Scrollback on this
  phone · Mouse wheel to the program · Arrow keys to the program as a radio group) · separator · Close terminal
  (destructive). Zoom on the desktop is the Settings toggle alone; text size is the header's A− / A+ alone.

### 4.5 Approval card
Sits between the terminal and the key row while the pane is `blocked`.
- **Container:** 1 pt `line` on top, `panel` background, padding 12 × 14, 8 pt vertical gaps. The card takes at most
  about 55 % of the screen's height and scrolls inside when the dialog is longer, so the key row and composer stay
  reachable.
- **Head row:** left the tool name (`approval.tool`; "Question" for a choice without a tool; "Approval" when nothing
  parsed) in mono 13 semibold `accent`; right the kind in mono 13 `fg3`: "permission", "question", or "prompt" when
  nothing parsed. While a request is in flight the right label reads "sending…".
- **Command or path block:** mono 12.5 `fg` on `bg`, `line` border, radius 8, padding 6 × 8, up to 6 lines, selectable.
- **Description** (when present and different from the command): sans 14 `fg2`. **Question:** sans 15 semibold `fg`.
- **Options:** one full-width, left-aligned button per option in the dialog's own words: sans 14 medium `fg`, `panel2`
  fill, 1 pt `raised` border, radius 10, padding 9 × 12, up to 3 lines. The option the desktop currently marks
  (`approval.selected`) has an `accent` border and `accentWash` fill. No visible numbers; the accessibility label is
  "Option N: <text>" plus ", marked on the desktop". Tapping sends `choose`; all options are disabled at 60 % opacity
  while in flight.
- **Quiet action** under the options, left-aligned text button in sans 14 `fg2`: "Deny with feedback…" for a
  permission, "Something else…" for a question. It opens the feedback sheet: title matches the button, one multi-line
  field with placeholder "What should it do instead?", footer "Esc dismisses the dialog first, then your words are typed
  to the agent.", Send button in `interactive`, disabled while the field is blank. Esc itself is on the key row; the card has no Esc button.
- **Nothing parsed** (trust dialogs, unknown layouts): head "Approval" / "prompt"; herdr's state label in sans 14 `fg2`
  when present; then stacked option-style buttons "Approve" (marked style), "Approve for session", "Deny",
  "Interrupt", and the quiet "Deny with feedback…".
- **Result:** on `approval.result outcome:"sent"` the card body is replaced by a head row "✓ Answered from your phone"
  in mono 13 `done` with "sent" on the right in `fg3`, and one line in sans 14 `fg2` with the result summary; the toast
  shows `approval.result · sent` (ok). On any other outcome the head becomes "✕ Not sent" in `blocked` with the reason
  in the right label, the options stay enabled, and a quiet "Send anyway" appears for `signature_mismatch`. The card
  disappears when the pane leaves `blocked`.

### 4.6 Key row
Exactly eight key caps fill the width (cap width = (screen width − 20 − 7 × 6) / 8), 6 pt gaps, 8 pt above, 10 pt sides,
each cap mono 15 `titleFg` on `panel2` with a 1 pt `line` border, radius 8, height 34; a cap that is a single glyph
(the arrows, ⏎, ⌫, and the Ctrl letters) sets it at mono 18, and a label that would overflow its cap shrinks, to 75 % at
most. The strip scrolls horizontally to reveal the rest; the order is fixed on both platforms:

`Esc  Tab  Ctrl  ↑  ↓  ←  →  ⏎   |  Home  End  PgUp  PgDn  ⇧Tab  Del  ⌫  ^C`

(The bar marks where the eight visible caps end; it is not a key.)

Ctrl is sticky for one key: armed, its cap takes the `accent` border, `accentWash` fill and `accent` text;
`Esc Tab Ctrl ↑ ↓ ← →` stay in place (the arrows now send `ctrl+<arrow>`) and the caps from ⏎ onward are replaced by
the letters `C D Z L A E U K R W X B N P F G O [ \` (each sends `ctrl+<x>` and disarms). Tapping Ctrl again disarms.

### 4.7 Composer
Below the key row, 8 pt above and below (bottom to the safe area), 10 pt sides: a `panel2` container with a 1 pt `line`
border and radius 16, padding 8 × 10, containing in one row: a round "+" button (24 pt, `line` fill, "+" in `titleFg`
semibold) opening a menu with "Take photo" and "Choose photos"; the text field (sans 15, `fg`, placeholder `fg3`
"Message the agent…"; in raw text mode "Type raw text…", with Ctrl armed "Ctrl + one key…" in either mode, and the first character typed then goes
out at once as `ctrl+<char>` and disarms Ctrl; grows to 6 lines); and a
round send button (28 pt, `interactive` fill, bold "↑" in `onInteractive`; 40 % opacity when nothing can be sent).
Attachment chips sit above the field inside the container. The raw-mode toggle lives in the overflow menu on both
platforms, nowhere else. The bar behind the composer is `bg`.

### 4.8 Pairing
- Title "Pair with a host" centred; no back button (one host per app for now).
- Segmented control 14 pt below the header: `panel2`, radius 10, 3 pt padding; segments "Scan QR" and "Enter code" in
  sans 14, `fg2`; the selected segment `raised` fill, `fg`, semibold.
- **Scan QR:** the camera preview in a radius-18 viewfinder, 4 : 3, with four `accent` corner brackets (26 pt long, 3 pt
  thick, 12 pt inset, 6 pt outer radius). Below, centred: "Point the camera at the code on your host's screen." in sans
  15 `fg2`, then `$ remotly-bridge pair` in mono 12.5 `fg3`. A valid code pairs at once (toast `pairing with <host>…`);
  a foreign QR shows the plain toast "Not a Remotly pairing code".
- **Enter code:** fields on `panel` with a `line` border, radius 12, padding 12, sans 15 (`fg`, placeholder `fg3`;
  the placeholder stays the field's accessibility label once it holds a value):
  "Host URL (e.g. 100.101.102.103:7460)", "Pairing code (8 characters)" (mono, capitals), "Host name (optional)"; then a
  disclosure row "Self-signed certificate" (chevron, `fg2`) that reveals "Certificate fingerprint (base64url SHA-256)"
  with the footnote "Leave empty when the bridge uses a Tailscale certificate." Then the Pair button: full width, 48 pt,
  `interactive` fill, "Pair" in sans 16 semibold `onInteractive`, radius 14, 40 % opacity while the URL or code is
  empty. Tapping Pair validates before anything is sent, with the same sentences on both: "Enter the host as host:port"
  · "The code is 8 characters from A–Z and 2–9 (no I, O, 0, 1)" · "The fingerprint is 43 base64url characters".
- While pairing: a centred `panel` card "Pairing…" with a spinner. Errors: rose sans 14 under the button (and the plain
  toast in scan mode). After success the app asks for notification permission (existing behaviour).

### 4.9 Settings
Same sections, rows and words on both platforms, footers at most one sentence.
- **Host:** Name · Bridge (mono URL) · Certificate ("From your tailnet" / "Self-signed · pinned <fingerprint>",
  copyable) · This device (name).
- **Notifications:** Permission ("Allowed" / "Not allowed" + "Enable" or "Open system settings") · "Tell me when it's
  done by default" (toggle) · "Require unlock to approve" (toggle) · "Show working agents" (toggle; iOS Live Activity,
  Android ongoing notification, same words). Each toggle carries one sentence in sans 13 `fg3` under its title, the
  same on both: "Every prompt sent from this phone asks for one notification when the agent finishes its turn." ·
  "Approve, Deny with feedback and Reply from a notification work only once the phone is unlocked." · "Each working
  agent stays visible outside the app with a running timer."
- **Terminal:** "Fit pane to this phone" (toggle; "While you view a pane, its width on the desktop follows this
  screen's columns.") · "Zoom on desktop while viewing" (toggle; "The pane fills its desktop tab while you view it; the
  split comes back when you leave."). No text-size row: the pane header's A− / A+ are the only control.
- **About:** App (version · protocol) · Bridge (bridge version · herdr version) · Push (registered / not issued;
  Android adds Firebase configured or not) · Terminal font "JetBrains Mono · OFL 1.1".
- "Forget this host" as a destructive row in `blocked`; the confirmation "Forget <host>?" says "The device token is
  deleted and push registration removed. Pair again with a new code from remotly-bridge pair." with a "Forget" button.
Switches use `interactive` when on. Section labels use the §2 style.

### 4.10 New terminal sheet
Title "New terminal"; each field under a sans 13 `fg2` caption: "Name (optional)" (empty placeholder) and "Command to
run (optional)" (mono, placeholder `claude`); quick
picks `claude` · `codex` · `pi` as `panel2` chips with a `line` border; footer "Opens a new herdr tab on the desktop
and runs the command once the shell is ready."; Create in `interactive`.

### 4.11 Notifications and Live Activity
- Copy comes from the bridge (§5). Action labels: Approve · Deny · Deny with feedback; done alerts: Reply, whose text
  field hints "Your next prompt" on both platforms.
- Android: `setColor(accent)`, small icon = the mark (§4.12), big text "<Tool> · <command>", then the question and the
  numbered options as today. The ongoing status notification: title = the session title (the push's `title`, else the
  pane id), text = "Working", or while blocked "Waiting for approval · <detail>" ("Has a question" for a `choice`),
  sub-text = the host, chronometer from `since`. No agent name: the title names the session.
- iOS Live Activity (Lock Screen): background `bg` at 85 %, eyebrow "REMOTLY" in mono 11 uppercase, letter spacing
  0.08 em, `fg3`; then the row: the status mark (§4.12, 14 pt, with its drawn trail while working), the session title
  (content state `title`) in mono 14 semibold `fg`, one line truncated at the end, and trailing the elapsed time in mono
  14 tabular `fg` ("✓" when done). Second line, sans 13: the status word (§3) in the status colour ("Ended" when the
  activity ends with `unknown`: the pane is gone), then " · <detail>" in `fg2` while blocked. No agent name. Under it, while blocked, the buttons: "Approve" filled
  `accent` with `onInteractive` text, "Deny" filled white at 14 % with `fg` text; a question shows "Open Remotly to
  answer" instead. Dynamic Island: compact leading = the mark, compact trailing = the elapsed time in the status colour,
  minimal = the mark; expanded: leading = the mark (20 pt), trailing = the elapsed time, bottom = the session title
  (mono 14 semibold `fg`, one line), the status word in its colour with " · <detail>" in `fg2` while blocked, then the
  buttons. A tap anywhere on the activity, in any presentation, opens that pane in the app (`remotly://pane?id=<pane
  id>`, the activity's `widgetURL`, handled by the app's `onOpenURL`; a sheet that was open closes) — as a tap on the
  Android status notification does — instead of whatever page was open last. Forgetting the host ends every activity,
  as Android cancels its notifications. (One activity per pane stays as is; a single activity listing every agent is a
  later change.)

### 4.12 Marks
- **App icon:** background `bg`; the chevron in `#6B7078` and the teal phone from the site favicon (64-unit grid:
  chevron `M15.6 19.5 L27.4 32 L15.6 44.5 L10.2 44.5 L22 32 L10.2 19.5 Z`; phone rect x 35, y 14, w 17, h 36, rx 5.4 in
  `accent`; island cut-out x 40.5, y 16.6, w 6, h 2.2, rx 1.1 in `bg`). iOS: `AppIcon-1024.png`, unrounded. Android:
  adaptive icon, background `bg`, foreground vector with the 64-grid content scaled 1.2× around the centre of the 108
  viewport.
- **Notification small icon** (Android): the chevron and phone in white.
- **Tool glyph** (list rows, in place of the status mark, which repeated the app's phone on every row and said nothing
  about the session): which tool runs in the pane, on a 24-unit grid scaled to 16 pt, filled or stroked in the tool's
  own colour — Claude `#D97757` (its terracotta), Codex `fg` (OpenAI's mark is white on dark), Gemini `#4285F4`
  (Google blue), π `fg2`, the prompt `fg3`; the status colour of §3 is on the row's status word, not the glyph. By
  herdr's agent id: `claude` — the spark, eight round-ended spokes 3.4 wide
  from 0.8 to 11.6 units out; `codex` — the knot, six round-ended bars 3 × 11 each lying across a radius 5 units out;
  `gemini` — the sparkle, four points (12, 0.8) (23.2, 12) (12, 23.2) (0.8, 12) joined by quadratic curves whose
  controls sit 1.4 units from the centre; `pi` — π as three 2.6-unit strokes with round caps (bar 4.5–19.5 at y 6.5,
  legs at x 8.5 and 15.5 down to y 19.5); anything else, and a plain shell — the prompt `>_`, a chevron (5, 6.5) (10.5,
  12) (5, 17.5) and a bar 12.5–19.5 at y 17.5, 2.6-unit strokes, round caps and joins. Still, always. Accessibility
  label = the tool's display name ("Claude Code"), else its id, "Terminal" for a shell.
- **Status mark** (the pane header, the Live Activity and Dynamic Island; it replaced the 8 pt dot): the icon's chevron
  and phone on the same 64-unit grid, cropped to x 10–52, y 14–50 (42 × 36 units) and scaled to the slot height: 14 pt
  in the Lock Screen row and the compact / minimal island, 18 pt in the pane header, 20 pt in the expanded island. The phone is always `accent` with the `bg` island
  cut-out; the chevron takes the status colour of §3 (`fg3` for a plain shell). While `working` the chevron moves: in
  the apps it glides toward the phone and fades, a 1.4 s loop with ease-in-out (x from −3 to +7 units of its resting
  place, opacity 1 until two thirds of the way, then to 0, then it starts again), still when the system asks for
  reduced motion and when the row or screen is not visible. In the Live Activity, where the system runs no custom
  animation, the motion is drawn: a second chevron 6 units behind the first at 35 % opacity, only while `working`.
  Every other state is still. Accessibility label = the status word of §3 ("Terminal" for a plain shell).
- iOS `AccentColor` = `interactive`. Launch screen background `bg`.

### 4.13 Motion
Toast 250 ms ease-out; approval card state changes 200 ms cross-fade; segmented control and key row state changes
150 ms. Nothing else animates beyond the platform defaults.

## 5. Copy (identical strings on both platforms)

Status: Waiting for approval · Has a question · Working · Idle · Done · Fitting… · Connected · Connecting… ·
Reconnecting… · Offline · Not paired.

Screens: Needs you · Message the agent… · Type raw text… · Ctrl + one key… · Pair with a host ·
Scan QR · Enter code · Point the camera at the code on your host's screen. · Host URL (e.g. 100.101.102.103:7460) ·
Pairing code (8 characters) · Host name (optional) · Self-signed certificate · Certificate fingerprint (base64url
SHA-256) · Leave empty when the bridge uses a Tailscale certificate. · Pair · Pairing… · Not a Remotly pairing code ·
Deny with feedback… · Something else… · What should it do instead? · Esc dismisses the dialog first, then your words are
typed to the agent. · ✓ Answered from your phone · ✕ Not sent · sent · sending… · Send anyway · Approve · Approve for
session · Deny · Interrupt · Live ↓ · Copy screen · Raw text mode · Tell me when it's done · Swiping up and down ·
Smaller text · Larger text (the A− / A+ accessibility labels) · Close terminal · Ends the shell on the desktop and
anything running in it. · New terminal · Name (optional) · Command to run (optional) · Create · Waiting for
the bridge… · Retry now · This phone is no longer paired. · Forget host and pair again · No panes open in herdr. ·
Waiting for the first frame… · Nothing older here: herdr holds no scrollback for this pane. If a full-screen program is
running, swipes can go to it as mouse-wheel steps. · Use mouse wheel · Forget this host · Tell me when it's done by
default · Require unlock to approve · Show working agents · Fit pane to this phone · Zoom on desktop while viewing ·
Open Remotly to answer. · Your next prompt · Other · Terminal · Options
(the Android row's spoken long-press label).

Toasts: `approval.result · sent` · `copied` · `<title> closed` · `pairing with <host>…`.

## 6. What the bridge provides for this

- `snapshot.panes[].since` and `pane.status.since`: milliseconds since the epoch when the pane's agent began its
  current stretch of work (`working`, carried through `blocked`); `null` when `idle`, `done`, `unknown` or not known.
  Drives the elapsed times in the list and the Live Activity.
- Push copy: approval title "<display agent> · Waiting for approval" or "<display agent> · Has a question"; body
  "<Tool> · <command or path>" followed by " — <description>" when different (a question: the question and its numbered
  options); done title "<display agent> · finished its turn"; Live Activity start alert "<display agent> · Working".
  Action labels are the apps' own (§4.11).


## 5. Local sample demo

Pairing has a **Try demo** button above the scan/code controls; Settings offers the same entry for paired users.
The entry says **Explore local sample sessions. Nothing is sent to a host.** It requires no permissions.
Both platforms reuse the normal list, terminal, approval, choice and input controls for the same three samples.
A persistent top strip says **Demo mode · Sample data**, **Local simulation · no host connected**, and **Exit demo**.
Sheets repeat the label or explicitly describe the local sample action. All output is visibly marked as sample data.

Photo attachment controls are disabled and notification controls omitted in sample sessions; Settings explains that
notifications and photo uploads require a paired host. Creation and closing copy describes a local sample action.
Exiting restores the original saved host or pairing screen. Entering again resets the samples. Full behavior and
reviewer steps: `docs/DEMO.md`.
