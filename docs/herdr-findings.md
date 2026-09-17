# herdr findings (measured 2026-09-02/03 against herdr 0.8.0, protocol 19, schema_version 1)

Host: a Linux workstation, isolated named session `remotly-dev` hosted by a 140×42 TUI client in a private tmux server (`tmux -L remotly -f /dev/null new-session -d -s herdr -x 140 -y 42 'herdr --session remotly-dev'`). Measured with `bridge/scripts/spike.ts`; fixtures by `bridge/scripts/capture.ts`. Logs kept in the session scratchpad; numbers below are copied from them.

These findings amended the herdr section (§4) of the original build brief, which is not part of the repository; where the two disagreed, these won. The `§4.x` labels below keep that numbering.

## 0. Connection model (amends §4.1 framing) — important

- **One request per connection.** Every plain request gets exactly one response line and then the server closes the Unix socket. A second request on the same connection is met with EPIPE / reset.
- **`params` is mandatory** on every request, including `ping` and `session.snapshot` (`{}`); omitting it yields `{"id":"","error":{"code":"invalid_request","message":"missing field `params`"}}` and the connection is closed.
- **Subscriptions are stream-only connections.** A connection whose first request is `events.subscribe` receives `{"id":…,"result":{"type":"subscription_started"}}` and then `{"event":"<kind>","data":{…}}` lines until closed. Sending any further request on it resets the connection. Right after `subscription_started` the server replays the current structural state as a burst of `pane_created` / `pane_updated` / `layout_updated` / `pane_focused` events (10–20 events in ≤ 400 ms) — consumers must debounce.
- **Subscribers receive the session's event history first.** A new subscription replays *every* past event of the requested kinds (73 events for a session that had seen 13 tabs, including `tab_created`/`pane_created`/`pane_agent_detected` for panes that no longer exist), paced at ~30 events per 100 ms tick, with **no timestamps or sequence numbers** in the payloads. Consequences for the bridge: structural events only trigger a debounced `session.snapshot` refresh (the snapshot is the truth), and `pane.agent_status_changed` events are treated as hints that are verified with `agent.get`/`pane.get` before anything is announced or pushed. Never act on a replayed status directly.
- **Results are wrapped:** `{"type":"<result_type>", <payload key>: …}`. Payload keys used by Remotly: `session_snapshot.snapshot`, `pane_read.read`, `pane_info.pane`, `pane_list.panes`, `agent_list.agents`, `agent_info.agent`, `tab_created.{tab,root_pane}`, `pane_zoom.zoom`, `pane_layout.layout`, `agent_started.{agent,argv}`, `agent_prompted.agent`, `wait_matched.event`, `ok`.
- **Latency:** requests are answered in 0.1–0.5 ms when the server loop is awake and otherwise on the next **100 ms tick**. Distribution over 20 sequential requests per method: min 0.1–0.4 ms, median 0.2–0.5 ms (some idle runs: median ≈ 100 ms), p90 ≈ 100 ms, max ≈ 101–104 ms. Plan for a worst case of one tick (≈ 100 ms) per request; never chain requests on the hot path.
- Error codes seen: `invalid_request`, `invalid_key` (bad key name; not `invalid_params` as the brief says), `not_found`, `unsupported_event_wait_match`, `timeout`.
- `HERDR_SOCKET_PATH` (inherited inside every herdr pane) takes precedence over `HERDR_SESSION`; the bridge resolves socket → `HERDR_SOCKET_PATH` → session → default, and the systemd unit must not inherit a pane environment.

## 1. Output-change signal (§4.2 item 1) — decision: poll `pane.read`

| Candidate | Result |
|---|---|
| (a) `pane.updated` subscription | Does **not** fire on terminal output. Fires on metadata changes only (cwd / foreground_cwd change → yes, with `revision` bump; OSC title change → no event observed; foreground process change → no). Payload is a full `PaneInfo` (includes `agent_status`). `PaneInfo.revision` did **not** change after printing 1,500 lines (stayed 1); it is a metadata revision, not an output counter. `PaneReadResult.revision` was 0 throughout. |
| (b) `pane.output_matched` catch-all (`regex "."` / `substring ""`, sources visible / recent lines=1 / detection / recent_unwrapped) | **Edge-triggered.** One event when the subscription starts (if the screen matches), then nothing for later output — 0 events after `printf`, 0–1 events during a 3 s / 1,500-line burst. Unusable as a change signal. Payload does carry `read` (the matching read, `format` as requested) and `matched_line`. |
| (c) `pane.wait_for_output` long-poll | Returns immediately when the match already succeeds; no "changed since" semantics. Not usable. |
| (d) `events.wait {match_event:{event:"pane_output_changed", …}}` | Rejected: `unsupported_event_wait_match` — "events.wait currently supports pane agent status matches". `pane_output_changed` exists only in the render-client event schema; it is not exposed to API subscribers. |
| (e) **Polling `pane.read source=visible format=ansi strip_ansi=false`** | Works. A full 114×41 read costs **0.2–0.5 ms** at idle (median), ≈ 38 ms average / 103 ms max while the pane receives ~500 lines/s. Polling every 50 ms during a 3.2 s burst: 35 reads, 35 distinct screens. `yes \| head -100000` completes in ≈ 100 ms and the pane stays responsive. Change detection must compare the returned text (or a hash), not `revision`. |

**PaneWatcher design:** while a pane is watched, read `visible/ansi` on a 40 ms timer (≈ 25 fps ceiling, below the 30 fps cap), skip unchanged text, parse/diff/send on change. Idle cost ≈ 25 × 0.4 ms ≈ 1 % of a core per watched pane. Under bursts the read itself takes ≈ 40 ms so the effective frame rate self-limits to ≈ 12–20 fps. `pane.updated` / `pane.agent_status_changed` remain the signal for metadata and agent state.

## 2. ANSI shape of `pane.read format=ansi strip_ansi=false` (§4.2 item 2)

- Herdr re-serialises its cell grid: **SGR only**. No cursor movement, no erase sequences, no OSC, no charset selects observed (0 non-SGR CSI, 0 OSC in every capture).
- Every styled run is prefixed by a reset: `ESC[0m` then attributes, e.g. `ESC[0m ESC[1m ESC[38;5;2m text ESC[0m`. Colours are emitted as **256-palette** (`38;5;n` / `48;5;n`) even for the basic 16 (red → `38;5;1`), and as **truecolour** `38;2;r;g;b` when the source was RGB. Attributes seen: `1` bold, `2` dim, `3` italic, `4` underline, `7` inverse, `9` strike.
- Rows are separated by `\n`; in ANSI mode each row except the last ends with **`\r`** (`…\r\n`); in text mode there is no `\r`. Tabs are already expanded to spaces. **Trailing spaces are preserved in ANSI mode** ("trailing   \r"), trimmed in text mode. Wide characters are plain UTF-8 (no padding cells).
- **Trailing blank rows are trimmed:** after `clear; echo X` the visible read has 3 lines although the pane has 41 rows. `rows` must therefore come from the layout/PTY, not from the read; missing rows are blank.
- `lines` on `visible` returns the **last N** rows (`truncated:true`). `recent`/`recent_unwrapped lines=N` return N−1 lines, capped at 999 (`lines=5000` → 999, `truncated:true`); default without `lines` ≈ 80. `strip_ansi:true` with `format:"ansi"` strips SGR but keeps `\r`. GNU `clear` (E3) wipes herdr's scrollback too.

## 3. Pane dimensions (§4.2 item 3)

- `session.snapshot.layouts[].panes[].rect {x,y,width,height}` and `pane.layout` report cell rectangles, **also for background tabs**, and `layout_updated` events carry the new layout after `pane.split` (e.g. 114 → 57 + 57).
- `rect.height` == PTY rows == `scroll.viewport_rows` (41 for a 42-row client).
- `rect.width` is **not** the PTY column count: a single 114-wide pane wrapped at 113 columns, a 57-wide split pane at 54; when zoomed the rects still show the unzoomed layout while the PTY grew to ≈ 111–113. Borders/gutters differ by layout, so no constant offset works.
- **Decision:** exact columns come from the PTY itself: `pane.process_info` → `shell_pid` → `readlink /proc/<pid>/fd/0` → `stty -F <tty> size` (host-side, non-intrusive, Linux/macOS). Fallback when unavailable: `rect.width − 1` clamped by the widest line seen. Re-query on `layout_updated` for the pane's tab and after `pane.zoom`.

## 4. Agent identifiers (§4.2 item 4)

`PaneInfo.agent` / `AgentInfo.agent` are exactly **`claude`**, **`codex`**, **`pi`** (live default session inspection + `agent.start --kind`). `display_agent`, `title`, `label`, `state_labels`, `tokens` are omitted when unset. pi panes report `screen_detection_skipped: true` (authoritative state from the pi integration). `AgentInfo` additionally has `name`, `state_change_seq`, `interactive_ready`, `launch_pending`. See §7 for measured status transitions and `capture-events.log`.

## 5. Headless start (§4.2 item 5)

`herdr server` is the documented headless mode ("Run as headless server … for supervised or service-style setups"); `capabilities.detached_server_daemon: true`. The user's production herdr already runs as the default session on this host and survives independently of clients, so no extra systemd unit for herdr is needed for M1–M7. If a boot-time start is wanted later: a user unit running `herdr server` (default session) is the supported form; the tmux form `tmux new-session -d -x 200 -y 50 herdr` is only needed to give panes a definite size when no TUI client ever attaches.

## 6. Key names (§4.2 item 6)

Accepted by `pane.send_keys`: `enter`, `tab`, `esc`/`escape`, `backspace`, `left/right/up/down`, `space`, `shift+enter`, `shift+tab`, `f1`…`f12`, `ctrl+<x>` (also `C-x`/`c-x` aliases, `control+x`), `alt+<x>`, `ctrl+shift+<x>`, `super+<x>`, `minus`, `plus`, `backtick`, single printable characters.
**Rejected** (`invalid_key`, "unsupported key …"): `home`, `end`, `pageup`, `pagedown`, `page_up`, `pgup`, `delete`, `del`, `insert`.
**Workaround (verified with `cat -v`):** `pane.send_text` passes raw bytes through unmodified, so Remotly sends `\x1b[H` (Home), `\x1b[F` (End), `\x1b[5~` (PgUp), `\x1b[6~` (PgDn), `\x1b[3~` (Delete), `\x1b[2~` (Insert) as text. The bridge maps these six key names itself (`bridge/src/herdr/keys.ts`); everything else goes through `send_keys`.

## 7. Agents: `agent.prompt`, `send_text` newlines, status transitions (§4.2 item 7)

Measured with `bridge/scripts/capture.ts` in a scratch directory (`/tmp/flow-capture-*`); screens in `shared/fixtures/reads/{claude,codex}-*.{ansi,txt,json}` (the pi captures were not kept: `shared/fixtures/frames/README.md`), event timeline in `shared/fixtures/reads/capture-events.log`. Versions: Claude Code (Sonnet 5), Codex CLI v0.152.1, pi 2026.x.

**Startup dialogs (all three report `idle` while a dialog is up):**
- Claude Code in an untrusted directory shows the workspace-trust dialog; the **default highlighted option is "No, exit"**, so `enter` quits Claude. `down`,`enter` accepts. Fixture `claude-trust-dialog`.
- Codex shows "Do you trust the contents of this directory?" with **"1. Yes, continue" highlighted**; `enter` accepts. Fixture `codex-trust-dialog`. Typing text into this dialog terminates Codex (observed: the pane fell back to the shell and typed text ran as shell commands).
- pi starts straight into its composer.

**Submitting a prompt:**
- `agent.prompt {target:<name or pane id>, text}` works once the agent is `interactive_ready` and no longer `launch_pending` (`agent.get` reports both). Claude: `agent.prompt` right after the trust dialog succeeded and the text arrived as one message. Codex and pi were still `launch_pending:true` ≈ 2 s after `idle` and `agent.prompt` failed with "not an active named agent"; the bridge therefore falls back to `pane.send_text` + `pane.send_keys ["enter"]`. Codex additionally dropped text typed within ≈ 1 s of becoming idle (first attempt not visible in the composer, second attempt 2 s later visible) — the bridge's `prompt` fallback is the phone's responsibility to retry if the text did not land.
- `pane.send_text` with embedded `\n` produces a multi-line composer entry in Claude Code (fixture `claude-composer-multiline`: three lines, not submitted), so newline-preserving prompts need no Shift+Enter handling on the phone.

**Permission prompts and herdr status:**
- Claude Code `Bash` permission dialog → herdr `working → blocked` (blocked ≈ 2.6 s after the prompt was submitted, fixture `claude-permission-prompt`, `agent.state_change_seq` 47). Dialog text: `Do you want to proceed? ❯ 1. Yes / 2. Yes, and always allow access to /tmp from this project / 3. Yes, and switch to auto mode / 4. No · Esc to cancel · Tab to amend`. `esc` → `idle` within 2 s (fixture `claude-after-deny-esc`; Claude returns to the composer, so "deny with feedback" is Esc followed by the feedback as the next prompt). §9's "3. No, and tell Claude what to do differently" option no longer exists in this version — `agents.json` uses `1`, `2`, `esc`.
- Codex only asks when a command needs to escape its sandbox (a `touch` under `/tmp` ran unprompted: `working → idle` in 6 s). With a path outside the sandbox: `working → blocked` ≈ 6.5 s after the prompt, dialog `Would you like to run the following command? … › 1. Yes, proceed (y) / 2. Yes, and don't ask again for commands that start with … (p) / 3. No, and tell Codex what to do differently (esc) · Press enter to confirm or esc to cancel` (fixture `codex-permission-prompt`). `esc` → `idle`. `agents.json`: `y`, `p`, `esc` (§9 said `a` for "always"; the real key is `p`).
- pi executed the shell command **without any approval prompt** under the user's current pi settings (`working → idle` in 5.7 s; capture not kept); no `blocked` state was observed for pi. pi's `/model` picker (capture not kept) is reported as `idle`, not `blocked`. The §9 mapping for pi is kept but unverified against a real approval dialog.

**Events (see `capture-events.log`):** `pane.agent_status_changed` (per-pane subscription) fired for every transition (`idle → working → blocked → idle`, then `unknown` when the agent exits). `pane.updated` fired only for some of them (it carries `agent_status` but is a metadata event), and `pane.agent_detected` fires on start and, with `final_status`/`released:true`, on exit. Exiting: Claude `/exit`, Codex `ctrl+c` twice, pi `/exit` — all return the pane to a plain shell with `agent_status:"unknown"`.

**Excerpt for push bodies:** the last visible lines of a blocked pane read as plain text are the dialog itself (command + question), which is exactly what the notification should show; the bridge strips box-drawing characters and joins the last three non-empty lines.

## 8. Other facts worth knowing

- `pane.split` takes `target_pane_id` (not `pane_id`); omitting it splits the focused pane of the calling client.
- `pane.zoom {pane_id, mode}` on a single-pane tab returns `changed:true, zoomed:false, reason:"single_pane"`; on a multi-pane tab it toggles `zoomed` and emits `layout_updated`.
- `tab.create {workspace_id?, cwd?, env?, label?, focus?}` returns `{tab, root_pane}`; `pane.close` on a pane whose shell exited is unnecessary (herdr closes the pane and its tab when the last pane dies, logging `PaneDied for unknown pane`).
- `pane.agent_status_changed` subscriptions **require `pane_id`** (one subscription entry per pane). `pane.updated` misses some status transitions (§7), so the bridge keeps one structural subscription plus one status subscription listing every pane, re-opened whenever the pane set changes.
- `agent.get {target}` accepts an agent name or a pane id and returns `state_change_seq` (monotonic per agent); Remotly's `prompt_id` is `<pane_id>@<state_change_seq>` captured when the pane is `blocked`, which stays stable across bridge restarts.
- `pane.zoom` params are `{pane_id, mode: "toggle"|"on"|"off"}`; `pane.process_info` returns `shell_pid` (and foreground process info) used for the PTY size probe.
- A newer herdr (0.8.2) is available; the user's installation is 0.8.0 on purpose (not upgraded by the agent).
- `pane.get` → `scroll {offset_from_bottom, max_offset_from_bottom, viewport_rows}` is herdr's own scrollback state; `max_offset_from_bottom` is the number of lines above the screen and is **0 for every Claude Code / Codex pane** (they run in the alternate screen, `[?1049h`), so `pane.read source=recent` returns just the visible rows for them. Shell and pi panes have thousands. Remotly's `history` reply passes it through as `scrollback`.
- Claude Code 2.1.x enables mouse tracking (`[?1000h`, `[?1006h`): SGR wheel reports written via `pane.send_text` scroll its transcript, which is what Remotly's `scroll mode=wheel` relies on.
- `pane.resize {pane_id, direction: left|right|up|down}` exists but moves a split boundary by one step (it changed the pane from 197 to 180 columns and was reversed with the opposite direction); it is not a PTY-size call. Rows-fit from the phone still needs an upstream addition.
