# Remotly protocol v1 — phone ↔ bridge wire contract

**Normative.** This is the single source of truth for the wire protocol implemented by the bridge (`bridge/`), iOS FlowKit (`ios/`) and Android `:core` (`android/`). Protocol version **1**. A change to this document must land together with the matching changes in all three code bases in one commit.

## 1. Transport

- WebSocket over TLS at `wss://<host>:<port>/ws`. JSON text messages, one object per message, each with a string `t` naming its type. Maximum message size 256 KiB. The upgrade is refused with `403` for a peer the tailnet gate rejects, `429` when that peer address already holds 8 open sockets, `503` when the bridge holds 64 in total; the apps treat all three like a dropped connection and retry with back-off.
- Every client request carries a client-chosen string `id`; the bridge answers `ok` or `error` with the same `id`. `hello` and `viewing` are the exceptions (see §4). Server events (`welcome`, `snapshot`, `pane.status`, `frame`, `approval.result`, `herdr`) have no `id`; `history` is a reply and carries its request `id`.
- Authentication: the first message must be `hello`. An invalid token, or any other message before a successful `hello`, yields `error` `code:"auth"` followed by a close with WebSocket close code **4401**. Clients must not reconnect automatically after 4401; they must re-pair. A socket that has sent no `hello` 5 s after the upgrade is closed with code **4408** and no `error`: a stall, not a rejected token, so clients reconnect as after any other drop.
- Keep-alive: the client sends a WebSocket ping every 15 s; the server closes after 45 s of silence. The client must not rely on its platform to notice a lost connection (iOS reports one minutes later, if at all): a ping without a pong within 5 s, a `hello` without a `welcome` within 3 s, or a connect attempt older than 10 s, means the socket is dead and is replaced.
- Reconnect: backoff 0.5 s → 10 s (doubling); a network change or the app returning to the foreground ends the wait early. Back in the foreground, a socket that has heard nothing for longer than one ping round (15 s + 5 s) is replaced rather than trusted. After `welcome`, the client re-sends `watch` and `fit` (for the pane it was viewing) and `viewing`. Style ids (§6) are per connection and start over on every new socket.

## 2. REST (same TLS listener)

| Method / path | Request body | Responses |
|---|---|---|
| `POST /pair` | `{code, device:{name, platform:"ios"\|"android", app_version}}` | `200 {token, device_id, host_name}` · `400 {error:"bad_request"}` · `403 {error:"bad_code"}` · `403 {error:"forbidden"}` (peer not on the tailnet) · `429 {error:"locked_out", retry_after_ms}` (this address after five wrong codes: 15 min; or the bridge as a whole after 30 pairing attempts within a minute: up to 60 s) · `408 {error:"timeout"}` (no body bytes for 30 s, counted from the request's arrival; or the body not complete 104 s after the headers — 120 s after the request began at the latest; the bridge closes the connection) |
| `POST /upload` | Body: the image bytes; headers `content-type: image/jpeg` \| `image/png` and `authorization: Bearer <device token>`; at most `uploads.max_mb` MiB (default 20) | `200 {path, bytes}` · `400 {error:"bad_request"}` (empty body) · `401 {error:"auth"}` · `403 {error:"forbidden"}` · `408 {error:"timeout"}` (no body bytes for 30 s, counted from the request's arrival; or the body not complete within the upload budget, counted from the end of the headers: `uploads.max_mb` at 32 KiB/s, at least 104 s — 640 s for the default 20 MiB, so with the 16 s header allowance a whole request ends within 656 s; the bridge closes the connection) · `413 {error:"too_large", max_bytes}` · `415 {error:"unsupported_type"}` |
| `GET /health` | — | `200 {ok:true, herdr:"up"\|"down", version, protocol:1}` |

`device.name` is 1–64 characters after trimming; `app_version` at most 32. `code` is normalised before comparison (upper-cased, spaces and dashes removed); codes are single-use with a 5-minute TTL, except the one `remotly-bridge setup` prints, which pairs any number of devices until it expires (10 minutes by default, `--ttl`). Five failures from one peer address lock `/pair` for that address for 15 minutes (other peers are unaffected). The token is an opaque string; store it in the platform keychain/keystore.

**Uploads.** A photo taken or picked on the phone is downscaled there (about 1568 px on the long edge, JPEG, metadata dropped) and posted to `/upload`. The bridge stores it as `<uploads.dir>/<YYYY-MM-DD>/<HHMMSS>-<6 hex>.jpg|png` (default `~/.local/share/remotly/uploads`, files 0600 in 0700 day folders; day folders older than `uploads.keep_days`, default 14, are pruned on the next upload) and answers with the absolute path. The bridge never types the path itself: the app shows the photo as an attachment in its composer and appends the path(s), space-separated, to the text of the next `prompt` (or the raw text), so the program in the pane reads the file — Claude Code, Codex and pi each read a local image whose path appears in the message with their file tools. Uploads are never served back. A pane whose shell is an ssh session on another machine cannot see the file.

## 3. QR payload

`remotly://pair?u=wss://100.101.102.103:7460&fp=<base64url SHA-256 of leaf cert DER>&c=<pairing code>&n=<host name>`

The scheme is `remotly://`; sibling builds of the app on one phone each parse only their own scheme, so a QR shown by one bridge cannot be paired by another build's app. Default listen port 7460.

Values are URL-encoded (`URLSearchParams`); parse with a standard query-string parser.

- `u`: WebSocket origin (scheme, host, port; no path). Clients append `/ws` for the socket and use the same origin over `https://` for REST.
- `fp`: unpadded base64url of SHA-256 over the DER leaf certificate. Present only in self-signed mode; the client pins this fingerprint and skips chain validation. Absent when the certificate is publicly trusted (Tailscale cert): the client performs normal TLS validation and pins nothing.
- `c`: the pairing code, 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0, 1), suitable for manual entry.
- `n`: host name shown to the user before pairing.

## 4. Client → server

| `t` | Fields | Bridge action |
|---|---|---|
| `hello` | `token`, `client:{platform:"ios"\|"android", app_version, device_name}`, `mode:"full"\|"action"` | No `id`; the reply is `welcome`. `full` → `welcome` with `snapshot`, then streaming events. `action` → `welcome` without snapshot (notification actions: one `approve`, wait for `approval.result`, close). Invalid token → `error auth` + close 4401. |
| `watch` | `id`, `pane`, `zoom?:true` | Start output watch. Reply `ok {cols, rows, zoomed?}`, then a `full:true` `frame`. One watched pane per connection; a new `watch` replaces the previous one (implicit unwatch). Unknown pane → `error unknown_pane`. A pane that herdr created a moment ago may not be in the bridge's snapshot yet; the bridge refreshes it on demand and waits up to 1.5 s before answering `unknown_pane` (same for `fit`). With `zoom:true` the bridge zooms the pane on the desktop (herdr `pane.zoom on`, a tab-level zoom) for as long as this device watches it and restores the split when the device unwatches, watches another pane, reports `viewing` elsewhere, closes the pane or disconnects (app backgrounded). Only a zoom the bridge applied itself is undone: `already_zoomed` means the desktop user (or another device) zoomed it and leaving leaves it alone; a single-pane tab cannot zoom (`zoomed:false`); an old herdr without `pane.zoom` omits `zoomed`. |
| `unwatch` | `id`, `pane` | Stop; `ok`. Not currently watching that pane → `error not_watching`. |
| `history` | `id`, `pane`, `lines`, `unwrapped?` | herdr `pane.read source=recent` (`recent_unwrapped` when `unwrapped:true`) `lines=N format=ansi strip_ansi=false` → `history`. `lines` is clamped to 1…999 (herdr's cap). |
| `keys` | `id`, `pane`, `keys:string[]` | Each name is validated and delivered in order (§5). Any unknown name → `error invalid_key` and nothing is sent. |
| `text` | `id`, `pane`, `text` | `pane.send_text` verbatim (bracketed paste; newlines preserved). |
| `scroll` | `id`, `pane`, `direction:"up"\|"down"`, `lines?` (1…50, default 1), `mode?:"wheel"\|"arrows"` (default `wheel`), `col?`, `row?` | Touch scrolling forwarded to the program instead of the phone's own scrollback. `wheel` → `pane.send_text` with `lines` SGR mouse-wheel reports (`ESC [ < 64;col;row M` up / `65` down; `col`/`row` 1-based, default 1) as a real terminal would send them to a program with mouse tracking on (tmux, vim, less …). `arrows` → `pane.send_keys` with `lines` × `up`/`down`. herdr does not say whether the program tracks the mouse, so the app picks the mode per pane (persisted): the default "Automatic" resolves to `wheel` while `frame.alt` is true and to the phone's own scrollback (`history`, which sends nothing) otherwise; a wheel report into a plain shell prompt types junk and into `less` runs commands, which is why wheel is not the blanket default. Reply `ok`. For 600 ms after a `scroll` of the watched pane the bridge polls it every 12 ms and lets frames out every 16 ms (normally 40 / 33), so the redraw the wheel causes reaches the phone as early as possible; the phone slides a frame that is the previous screen shifted by whole rows into place instead of jumping. |
| `prompt` | `id`, `pane`, `text`, `notify?:boolean` | `agent.prompt` when the pane has an agent (herdr appends Enter); otherwise `send_text` followed by `send_keys ["enter"]`. `notify:true` first arms this device's "tell me when it's done" alert for the pane (same as `notify {done:true}`), so a prompt sent from the phone comes back as a push when the agent finishes. Works in `mode:"action"` too (the Reply action of a notification). |
| `approve` | `id`, `pane`, `prompt_id`, `action:"approve"\|"approve_session"\|"deny"\|"deny_feedback"\|"interrupt"`, `feedback?`, `force?:boolean` | Replies `ok` immediately, then `approval.result`. The bridge checks that the pane is still `blocked`, that `prompt_id` matches the current prompt, and that the visible text matches the agent's prompt signature; `force:true` skips the signature check (used to retry after `signature_mismatch`). Pane without a known agent → `error unsupported_agent`. |
| `choose` | `id`, `pane`, `prompt_id`, `option` (1-based, as numbered on screen), `label` (the option's text as shown) | Answers the dialog on screen by moving its cursor, so nothing is agent-specific: the bridge checks the pane is still `blocked` on `prompt_id`, re-reads and parses the screen, checks that option `option` still reads `label`, presses `up`/`down` from the marked (❯) choice until the marker sits on the tapped one — reading the screen back after each step, up to 600 ms — then `enter`. Works for permission dialogs, Claude's AskUserQuestion menus and pickers alike; the apps use it for every parsed dialog (the card mirrors the options as buttons) and keep `approve` for the key-map actions behind notification and Live Activity buttons. Replies `ok` at once, then `approval.result`: `dialog_changed` when the menu no longer matches what the phone showed (nothing sent), `failed` with a detail when the cursor did not land or no marker is visible (the arrows may have gone out, Enter did not). |
| `zoom` | `id`, `pane`, `mode:"toggle"\|"on"\|"off"` | `pane.zoom`; reply `ok {zoomed:boolean}`. |
| `fit` | `id`, `pane`, `cols`, `rows` — or `release:true` | Resize the pane's PTY (`stty` on the pane's tty; herdr has no resize API) so the program on the desktop wraps for the phone. Only `cols` is applied: the bridge keeps herdr's own row count, because herdr's screen cannot be resized and a PTY shorter than it makes the program lay out rows that spill below the phone's view and never reach scrollback. `cols` 20…500, `rows` 5…300 (accepted, ignored). Reply `ok {cols, rows}` with the size actually written (`rows` = herdr's), then a `full:true` `frame` at that size; the phone scrolls within the taller live screen. The most recent viewer's columns win when several phones fit the same pane. The fit is released — herdr's own size restored — on `release:true`, `unwatch`, a `watch` of another pane, `viewing` of another pane or `null`, or when the socket closes. After a herdr layout change (split, close, window resize) the bridge re-applies the active fit. No tty for the pane → `error fit_unavailable`. |
| `pane.create` | `id`, `label?` (≤64 chars), `command?` (≤4 KiB), `cwd?` | herdr `tab.create {label, cwd, focus:false}`: a new tab with one shell pane, opened in the background on the desktop. With `command`, the bridge waits for the shell to draw its prompt (polls `pane.read visible`, up to 5 s) and then sends `pane.send_text` + `send_keys ["enter"]`, so the app can start `claude`, `codex`, `pi` or any shell command in a fresh terminal. Reply `ok {pane, tab}`; the new pane also arrives in the next `snapshot`. The reply is sent only once the new pane is in the bridge's snapshot, so an immediate `watch` / `fit` of it succeeds. |
| `pane.close` | `id`, `pane` | herdr `pane.close {pane_id}`: ends the pane on the desktop (its shell and whatever runs in it; herdr also closes the tab when this was its last pane). Reply `ok`; not in the snapshot → `error unknown_pane`. If this connection was watching the pane, that watch ends first. Every other device watching it gets `error unknown_pane` (no `id`) from its watcher and the next `snapshot` no longer lists the pane, the same as when the user types `exit` in the shell; the apps leave the pane view on either signal. |
| `viewing` | `pane` (string or `null`), `id?` | Marks the pane this device is looking at (push for it is suppressed). Fire-and-forget: no reply unless an `id` is present, in which case the bridge answers `ok`. |
| `push.register` | `id`, `platform:"ios"\|"android"`, `token`, `env:"sandbox"\|"production"` (iOS only) | Stores the push token on the device record; `ok`. |
| `push.unregister` | `id` | Removes it; `ok`. |
| `notify` | `id`, `pane`, `done:boolean` | Arm (`true`) or disarm this device's "tell me when it's done" alert for the pane: once the pane's agent has been `working` and then stays `idle`/`done`/`unknown` for `push.done_settle_ms` (default 3 s, absorbs the idle blip between turns), the bridge sends one `done` push (§9) and disarms. Stored on the device record (survives bridge restarts); dropped when the pane leaves the snapshot. Reply `ok {done}`; `done:true` for a pane not in the snapshot → `error unknown_pane`. |
| `activity.register` | `id`, `token?`, `pane?` | Glanceable status. iOS: `token` is an ActivityKit token — without `pane` the push-to-start token (the bridge may then start a Live Activity for any pane whose agent begins working or blocks), with `pane` the update token of the Live Activity running for that pane (the app reports it as soon as ActivityKit hands it out, over a short `mode:"action"` connection when iOS woke it in the background for a push-to-start; the bridge then sends that activity an `update` with the pane's current state at once, or an `end` if the pane has already stopped). Android: no fields; opts the device's FCM token into `status` data messages (§9) for its ongoing notification. Requires a prior `push.register`. Reply `ok`. |
| `activity.unregister` | `id`, `pane?` | With `pane`: that pane's Live Activity ended on the phone, forget its token. Without: opt out entirely (start token, activity tokens, `status` messages). Reply `ok`. |

## 5. Key names (`keys`)

- Passed through to herdr `pane.send_keys` verbatim: `esc`, `tab`, `enter`, `backspace`, `up`, `down`, `left`, `right`, `space`, `shift+enter`, `shift+tab`, `f1` … `f12`, `ctrl+<x>`, `alt+<x>`, `ctrl+shift+<x>`, `super+<x>`, `minus`, `plus`, `backtick`.
- Translated by the bridge to raw escape sequences via `pane.send_text` because herdr rejects them: `home` `\x1b[H`, `end` `\x1b[F`, `pageup` `\x1b[5~`, `pagedown` `\x1b[6~`, `delete` `\x1b[3~`, `insert` `\x1b[2~`.
- Anything else → `error invalid_key`. Names are case-sensitive and lower-case. Mixed lists keep their order: the bridge splits them into consecutive `send_keys` / `send_text` calls.

## 6. Server → client

| `t` | Fields |
|---|---|
| `welcome` | `protocol:1`, `host:{name, herdr_version, herdr_protocol, flow_version}`, `device:{id, name}`, `snapshot?` (present for `mode:"full"`; same fields as a `snapshot` message, without `t`), `notify_done?:string[]` (`mode:"full"`: panes this device has armed with `notify`) |
| `snapshot` | `workspaces:[{id, name}]`, `tabs:[{id, workspace_id, name}]`, `panes:[{id, tab_id, workspace_id, title, agent, display_agent, agent_status, state_label, cwd, focused, since, prompt_id?, approval?}]`, `focused_pane_id`. Full replacement of client state; sent whenever the workspace/tab/pane set changes. `title` is the pane's title as herdr shows it (herdr's own title or label, else the terminal title) with a leading agent status glyph (Claude Code's ✳ and its spinner frames, bullets, braille spinners) and the whitespace after it removed, so `"◑ Fixing tests"` arrives as `"Fixing tests"` and a title that was only a glyph arrives empty; the apps show it as the session's name and fall back to the cwd basename, then the pane id. `since` is the millisecond epoch time at which the pane's agent began its current stretch of work (set on `working`, kept through `blocked`) and `null` while `idle`/`done`/`unknown`; the apps show it as an elapsed clock (`shared/design/DESIGN.md` §4.3). A bridge that starts while an agent is already working counts from its own start. |
| `pane.status` | `pane`, `agent_status`, `agent`, `display_agent`, `title`, `state_label`, `since` (as in `snapshot`; all six ride on every event, so `agent: null` with `display_agent: null` means the pane is a plain shell now and `title: ""` that the apps fall back to the cwd basename, then the pane id), `prompt_id?` (present only while `agent_status === "blocked"`), `approval?` (see below). Re-sent with the same status when the bridge's reading of the dialog changes (it re-reads the screen when the approval push goes out). |
| `notify.state` | `pane`, `done:boolean`. The bridge changed this device's "tell me when it's done" arming itself: the alert fired (`done:false`). Sent to every connection of that device. |
| `frame` | `pane`, `rev`, `cols`, `rows`, `full:boolean`, `lines:[{y, runs:[{c, w, s, t}]}]`, `styles:{"<id>":{fg, bg, a}}` — §7; `alt?:boolean` — true while an alternate-screen program has the pane (herdr `pane.get scroll.max_offset_from_bottom == 0` and `pane.process_info` shows a foreground process group other than the shell's; probed when the watch starts and at most once a second on screen changes). Present on the first frame after the probe and whenever the value changes (such a frame may carry no `lines`); absent until the bridge knows. Apps use it for the default "Automatic" swipe mode: wheel reports while `alt` is true, the phone's own scrollback otherwise. |
| `history` | `id`, `pane`, `lines:[{runs:[…]}]`, `styles`, `has_more` (`true` when herdr returned the full requested count, i.e. older output probably exists), `scrollback?` (lines herdr holds above the screen, from `pane.get` → `scroll.max_offset_from_bottom`; `0` means nothing older exists — the program draws its own screen (alternate screen: Claude Code, vim, tmux) or the shell is fresh — and `has_more` is then `false`; absent when `pane.get` failed) |
| `approval.result` | `pane`, `prompt_id`, `outcome:"sent"\|"stale"\|"not_blocked"\|"signature_mismatch"\|"dialog_changed"\|"failed"`, `detail?`, `status_after?` (pane `agent_status` shortly after the keys were sent) |
| `herdr` | `state:"up"\|"down"`. While down, pane requests fail with `error herdr_down`; the bridge re-sends `snapshot` when herdr comes back. Sent once right after `welcome` with the current state, then on every change. |
| `ok` | `id`, plus result fields: `watch` → `{cols, rows, zoomed?}`; `zoom` → `{zoomed}`; `notify` → `{done}`; all others none. |
| `error` | `id?` (absent when the failing message had none), `code`, `message` |

`prompt_id` is `"<pane_id>@<state_change_seq>"`, where `state_change_seq` is herdr's pane sequence number at the moment the pane entered `blocked`. The same value appears in `snapshot.panes[].prompt_id`, `pane.status.prompt_id` and push payloads, so a notification action can be matched against the live state; a mismatch yields `approval.result outcome:"stale"`.

`approval` is the bridge's structured reading of the dialog on screen (`bridge/src/approvals/dialog.ts`, verified against `shared/fixtures/reads/{claude,codex}-permission-prompt.txt`), present only while `blocked` and only when the screen parsed: `{tool, command, path, description, question, options:string[]}` — `tool` is Claude's dialog header without "command"/"file" (`Bash`, `Edit`, `Write`, `Read`, …) or `Shell` for a Codex command; `command` the command line about to run; `path` the file a file tool wants to touch; `description` Claude's one-line summary or Codex's `Reason:`; `question` the dialog's question; `options` the numbered choices in dialog order (the apps show them as buttons in the dialog's own words; tapping one sends `choose`); `selected` the 1-based index of the choice carrying the ❯ / › marker, or `null`; `kind` is `permission` when the question starts with "Do you want to", "Would you like to", "Allow" or "Approve" and the first choice starts with "Yes" (a tool about to run: notifications and Live Activities offer Approve / Deny), else `choice` (AskUserQuestion menus, pickers: the phone is told to open the app, the card mirrors the options). Every field but `question`, `options`, `selected` and `kind` may be `null`. Trust dialogs and model pickers do not parse (no `approval`), and the apps fall back to the plain approval bar.

### 6.1 Error codes

| `code` | Meaning |
|---|---|
| `auth` | Missing/invalid token, or a message before `hello`. Socket closes with 4401. |
| `bad_request` | Malformed message: not a JSON object with a string `t`, missing or mistyped field, invalid JSON, a binary frame. |
| `unknown_pane` | `pane` is not in the current snapshot. |
| `fit_unavailable` | The pane's PTY cannot be resized (no tty: shell exited, or the bridge runs on a host without `/proc`). |
| `not_watching` | `unwatch` for a pane this connection is not watching. |
| `herdr_down` | herdr is unreachable; retry after `herdr state:"up"`. |
| `herdr_error` | herdr returned an error; `message` carries herdr's error code (e.g. `invalid_params`). |
| `unsupported_agent` | `approve` on a pane whose agent has no entry in `agents.json` (or no agent). |
| `invalid_key` | A `keys` name outside §5. |
| `unsupported` | Unknown message type `t`, or a feature unavailable on this bridge/herdr build (e.g. push not configured, `zoom` on an old herdr). The socket stays open. |

## 7. Frame encoding

- `cols`, `rows`: the pane grid size. The bridge takes them from the pane's real PTY size when it can probe it, otherwise from herdr's layout rect (`height`, `width - 1`).
- `full:true` frames replace the client grid. Trailing blank rows may be omitted: a row absent from a full frame is blank. `full:false` frames carry only changed rows; a row absent from `lines` is unchanged. A row present with `runs:[]` is blank.
- The bridge sends `full:true` on watch start, whenever `cols`/`rows` change, and every 10 s as a safety net. Frames are coalesced to at most one per 33 ms per connection. `rev` increases with every frame for the watched pane.
- A row is `{y, runs}`. Runs are ordered by `c` (0-based start column). `w` is the run's width in cells, `t` its text, `s` a style id. A run is either narrow characters (one cell each) or exactly one wide grapheme (`w:2`). Zero-width and combining characters stay attached to the preceding character. Default-styled trailing blanks are trimmed; styled blanks (coloured status bars) are kept. Clients therefore need no wcwidth tables.
- Styles: `fg`/`bg` are `"d"` (default), `"p<n>"` (palette 0–255) or `"#rrggbb"`. `a` is a bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough, 64 blink. Style ids are per connection; only ids not yet sent on this connection appear in `styles`, and clients cache them across `frame` and `history` messages. `styles["0"]` is implicitly `{fg:"d", bg:"d", a:0}`.
- Fixtures: `shared/fixtures/frames/` holds input ANSI, the expected JSON frame and the expected plain-text rendering. All three code bases test against them.

## 8. Message examples

```jsonc
// client → server
{"t":"hello","token":"fl_9Xk…","client":{"platform":"ios","app_version":"1.0 (12)","device_name":"Example iPhone"},"mode":"full"}

// server → client
{"t":"welcome","protocol":1,
 "host":{"name":"herdr-linux","herdr_version":"0.9.3","herdr_protocol":4,"flow_version":"0.1.0"},
 "device":{"id":"dev_2f8a","name":"Example iPhone"},
 "snapshot":{"workspaces":[{"id":"ws_1","name":"main"}],
             "tabs":[{"id":"tab_3","workspace_id":"ws_1","name":"flow"}],
             "panes":[{"id":"pane_7","tab_id":"tab_3","workspace_id":"ws_1","title":"claude — bridge","agent":"claude",
                       "display_agent":"Claude Code","agent_status":"blocked","state_label":"Waiting for approval",
                       "cwd":"/home/user/remotly/bridge","focused":true,"since":1757340000000,"prompt_id":"pane_7@4182"}],
             "focused_pane_id":"pane_7"}}

// watch → ok → first (full) frame
{"t":"watch","id":"1","pane":"pane_7"}
{"t":"ok","id":"1","cols":120,"rows":40}
{"t":"frame","pane":"pane_7","rev":1,"cols":120,"rows":40,"full":true,
 "lines":[{"y":0,"runs":[{"c":0,"w":1,"s":1,"t":"$"},{"c":2,"w":10,"s":0,"t":"ls --color"}]},
          {"y":1,"runs":[{"c":0,"w":3,"s":2,"t":"src"},{"c":4,"w":4,"s":2,"t":"test"}]},
          {"y":3,"runs":[{"c":0,"w":2,"s":0,"t":"日"},{"c":2,"w":6,"s":0,"t":"本語 ok"}]}],
 "styles":{"1":{"fg":"p2","bg":"d","a":1},"2":{"fg":"p4","bg":"d","a":1}}}

// pane.status (blocked → prompt_id present)
{"t":"pane.status","pane":"pane_7","agent_status":"blocked","agent":"claude","display_agent":"Claude Code",
 "title":"claude — bridge","state_label":"Waiting for approval","since":1757340000000,"prompt_id":"pane_7@4182"}

// approve → ok → approval.result
{"t":"approve","id":"2","pane":"pane_7","prompt_id":"pane_7@4182","action":"approve"}
{"t":"ok","id":"2"}
{"t":"approval.result","pane":"pane_7","prompt_id":"pane_7@4182","outcome":"sent","status_after":"working"}

// error
{"t":"error","id":"3","code":"invalid_key","message":"unknown key name \"pgup\""}
```

## 9. Push payloads

Sent by the bridge itself (`bridge/src/push/payloads.ts`) straight to Apple / Google; key order is stable so tests compare serialized bodies byte for byte. Three kinds, told apart by `flow.type` (APNs) / `data.type` (FCM): `approval`, `done`, `status` (FCM only; iOS gets a Live Activity push instead). Nothing in a push carries a token, and with `push.include_excerpt:false` no pane text either: bodies fall back to `"Approval needed"` / `"Finished"`, `approval` is omitted, `detail` is omitted from FCM status data and `null` in the Live Activity `content-state` (as when nothing is pending), and the host name stands in for the session title in `subtitle`, status `title` and the Live Activity `content-state.title` / start alert (a pane title or directory name is pane text too).

**Approval** — the pane entered `blocked` and stayed there for `push.debounce_ms` (default 2.5 s) with no connected device viewing it. `title` is `"<display agent> · Waiting for approval"` (`"<display agent> · Has a question"` when `approval.kind` is `choice`; the same words the apps use for status, `shared/design/DESIGN.md` §3), `subtitle` the session title (the pane title, else the cwd basename, else the pane id — the words the apps' list rows use), `body` a one-line summary of the parsed dialog (`Bash · touch /tmp/x — Create marker file`; for a `choice`: the question followed by the numbered options), else the last visible lines of the pane. The APNs category is `REMOTLY_APPROVAL` (Approve / Deny / Deny with feedback actions) or, for a `choice`, `REMOTLY_QUESTION` (no actions: open the app and answer on the card). The collapse key is the pane id, so repeated prompts for one pane replace each other. `prompt_id` is matched against the live state before any key is sent (`approval.result outcome:"stale"` otherwise) and lets the apps clear delivered notifications whose prompt is gone. `approval` is the §6 object (APNs: nested; FCM: JSON text, since data values are strings).

APNs alert push (`apns-push-type: alert`, `apns-priority: 10`, `apns-collapse-id: <pane>`, `apns-topic` = bundle id; sandbox host for tokens registered with `env:"sandbox"`):
```json
{"aps":{"alert":{"title":"Claude · Waiting for approval","subtitle":"<session title>","body":"Bash · npm test — Run the tests"},
        "sound":"default","category":"REMOTLY_APPROVAL","thread-id":"w1:p1","interruption-level":"time-sensitive"},
 "flow":{"v":1,"type":"approval","host":"<host name>","pane":"w1:p1","prompt_id":"w1:p1@4212","agent":"claude",
         "approval":{"tool":"Bash","command":"npm test","path":null,"description":"Run the tests","question":"Do you want to proceed?","options":["Yes","Yes, and always allow npm from this project","No"]}}}
```
The iOS app registers category `REMOTLY_APPROVAL` with the actions `APPROVE`, `DENY` and the text-input action `DENY_FEEDBACK`; `APPROVE` and `DENY_FEEDBACK` require the device to be unlocked unless the user turns "Require unlock to approve" off in Settings (Android mirrors this with `setAuthenticationRequired`). An action opens a `mode:"action"` connection, sends one `approve` and waits for `approval.result`.

FCM data-only message (high priority; the Android app builds the notification and its actions itself; every `data` value is a string):
```json
{"message":{"token":"<fcm token>","android":{"priority":"HIGH","ttl":"600s","collapse_key":"w1:p1"},
            "data":{"v":"1","type":"approval","host":"<host name>","pane":"w1:p1","prompt_id":"w1:p1@4212","agent":"claude",
                    "title":"Claude · Waiting for approval","subtitle":"<pane title>","body":"Bash · npm test — Run the tests",
                    "approval":"{\"tool\":\"Bash\",…}"}}}
```

**Done** — a pane this device armed with `notify` (or `prompt {notify:true}`) has been `working` and then `idle`/`done`/`unknown` for `push.done_settle_ms`. Sent only to the devices that armed it, then disarmed (`notify.state {done:false}` to their open connections). `title` is `"<display agent> · finished its turn"`, `body` the agent's closing words: the last prose paragraph of the current turn on its visible screen, with the input box, rules, spinner and status/help lines stripped (`bridge/src/push/excerpt.ts`); a turn that ended in a tool result uses that result ("Interrupted · What should Claude do instead?"), and raw shell output is read from its end. Collapse key: the pane id (replaces a stale approval alert for the same pane).
```json
{"aps":{"alert":{"title":"Claude · finished its turn","subtitle":"<pane title>","body":"All 184 tests pass."},
        "sound":"default","category":"REMOTLY_DONE","thread-id":"w1:p1","interruption-level":"active"},
 "flow":{"v":1,"type":"done","host":"<host name>","pane":"w1:p1","agent":"claude"}}
```
FCM `data`: `{"v":"1","type":"done","host","pane","agent","title","subtitle","body"}`, same envelope. Both apps give the notification a text-input **Reply** action, which opens a `mode:"action"` connection and sends `prompt {notify:true}` — the reply is typed to the agent and the next finish comes back as another `done` push.

**Status** — every verified agent status change of every pane, and a title change of a `working`/`blocked` pane (Claude names the session a moment after it starts; Android gets the status data again, iOS an `update` only — never a `start`), to devices that opted in with `activity.register`. Silent on both platforms. An activity ended because its pane disappeared keeps the title it had.

Android: FCM `data` `{"v":"1","type":"status","host","pane","agent","display_agent","title","status":"working"|"blocked"|"idle"|"done"|"unknown","since":"<ms since epoch when the work started>","prompt_id"?,"detail"?,"kind"?}` (`kind` while blocked: `permission` | `choice`), collapse key `status:<pane>`, `ttl` 60 s. The app keeps one ongoing, low-importance notification per working pane — title the session title (`title`), text `"<agent> · <status word>"` plus `" · <detail>"` while `blocked` ("Waiting for approval", or "Has a question" for a `choice`), chronometer from `since` — removes it on `idle`/`done`/`unknown`, and leaves it down while the pane's approval alert is showing.

iOS: an APNs Live Activity push (`apns-push-type: liveactivity`, `apns-topic: <bundle id>.push-type.liveactivity`, `apns-collapse-id: la:<pane>`, expiration 60 s): `event:"start"` to the device's push-to-start token when a pane begins `working`/`blocked` and no activity runs for it (priority 10; `attributes` are the app's `FlowActivityAttributes {pane, host, agent, displayAgent}`; the `alert {title, body}` Apple requires for push-to-start, silent, reads "Claude · Working" / "Claude · Waiting for approval" with the pane title; `"input-push-token":1` asks iOS 18+ to hand the activity's update token to the app at once), `event:"update"` to the activity's own token on later changes (priority 5 for `working`, 10 for `blocked`), `event:"end"` with a `dismissal-date` 5 min out on `idle`/`done`/`unknown` (the token is then forgotten). `content-state` decodes as `FlowActivityAttributes.ContentState {status, since (s since epoch), title, promptId?, detail?, kind?}` (`kind` present while blocked: `permission` | `choice`); while `blocked` on a permission the activity shows Approve / Deny buttons (a `choice` shows "Open Remotly to answer" instead) that run an app intent in the app's process (same path as the notification actions).
```json
{"aps":{"timestamp":1800000060,"event":"start",
        "content-state":{"status":"working","since":1800000000,"title":"Remotly bridge","promptId":null,"detail":null},
        "attributes-type":"FlowActivityAttributes","attributes":{"pane":"w1:p1","host":"<host name>","agent":"claude","displayAgent":"Claude"},
        "alert":{"title":"Claude · Working","body":"<pane title>"},"input-push-token":1}}
```
A `410 Unregistered` for a Live Activity token forgets that token only; the device's alert token is untouched. An `end` that APNs refuses for a passing reason keeps the token; the bridge tries the end once more 30 s later and then forgets the token either way. An `update` that finds the activity gone from the phone (`410`) while the pane still works starts a fresh one at once.
