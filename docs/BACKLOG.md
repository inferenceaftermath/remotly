# Remotly — backlog

Everything still open, in one place. What shipped is in `CHANGELOG.md`; how to run things is in `ONBOARDING.md` and
`docs/OPERATIONS.md`. Items marked "from the brief" come from the original build brief, which is not part of the repository.

## Verification from the brief that nobody has run

- **Approval from a lock-screen notification, end to end.** Phone locked, on LTE, Tailscale on; Claude Code asks
  for permission in a herdr pane → banner within ~3 s of `blocked` plus the 2.5 s debounce → Approve from the lock
  screen → Claude continues → outcome notification. Same for Deny, with the app force-quit, on iOS and Android;
  Android also after 30+ idle minutes (Doze). The progress log records `push-test` deliveries and the
  notification-permission fix, not this scenario.
- **Deny with feedback** delivers the feedback text (Claude: `esc`, then the text as the next prompt).
- **Codex and pi approve/deny on live prompts**, from the app and from a notification. `bridge/src/approvals/agents.json`
  was corrected against captured dialogs (`shared/fixtures/reads`), never exercised live.
- **Stale approval:** resolve a prompt on the desktop, then approve on the phone → `stale` / `not_blocked`, nothing injected.
- **Latency:** keystroke to screen under 150 ms over a direct Tailscale path. Never measured.
- **Landscape** on both apps.
- **Android hardware:** the Android test phone has only run the hand-built version code 4, so fit, swipe modes, selection, new
  terminal, tap-to-dismiss, the scrollback hint and A− / A+ are unseen on Android.

## Hardening

- Host reboot: herdr back, bridge active, phones reconnect, panes restored, no manual steps.
- herdr restart mid-stream (bridge restarts happen on every CI deploy and phones reconnect in about a second; herdr restart is untested).
- Tailscale down/up; LAN mode with the self-signed certificate (Android only: iOS refuses self-signed certificates, see `docs/OPERATIONS.md`).
- Load: `yes | head -1000000` in a watched pane keeps the phone responsive and the desktop unaffected; record bridge CPU.
- Security pass: a peer off the tailnet is refused while `require_tailnet` is true; the per-address `/pair` lockout re-verified; no pane text at info log level.
- **Bridge concurrency notes left open from the sessions-batch review (Codex round 15, 2026-09-08; shipped on the owner's
  call, none destructive).** (a) `hub.ts` `verifyPane` / `refreshApproval` mutate `promptIds` / `approvals` before their
  snapshot-generation checks: an old `agent.get` answer landing after a snapshot or outage can restore an obsolete prompt
  id, which the reconnect snapshot then keeps (approve → `stale`; clears on the next status change). (b) Dropping a
  verification that overlaps a snapshot loses a blocked → working → blocked double transition (the snapshot carries no
  `state_change_seq`, the dedupe compares `agent_status` only): clients keep prompt N while herdr is at N+1 until the
  next status change; no approval push for N+1. Fix idea: carry `state_change_seq` through `known` and compare it, and
  apply the verify result when its seq is newer instead of dropping it. (c) `notify.ts` restart after a dead Live
  Activity token re-reads the registration but not the pane's status: a delayed `working` update answered 410 after the
  pane already ended can start a fresh activity that nothing ends until the next transition. Fix idea: re-read
  `paneState` and start only if still `working`/`blocked`.

- **Reconnect follow-ups (investigation of 2026-09-12; the iOS connection layer was fixed that day).** (a) Android parity for the connection internals: `start()` / `reconnectNow()` return while a
  socket object exists instead of replacing it, so a dead-but-not-yet-failed OkHttp socket survives "Retry now"; on
  `onStart` a socket silent for one ping round should be replaced rather than trusted, a connect attempt hanging for a
  few seconds abandoned, and `hello` given the same 3 s / 10 s deadlines. (b) herdr down → up: after a reconnect made
  while herdr was down the `watch` fails with `herdr_down` and neither app retries it on the `herdr {up:true}` event; the
  open pane stays blank until the user leaves and returns. (c) `unwatch` / `watch` crossing when switching panes —
  **Android parity only; the bridge and iOS were fixed across the 2026-09-12/13 rounds:** the bridge now answers
  `not_watching` for a pane it is not watching (pane-named `unwatch`), and iOS orders unwatch/watch/fit/release through
  a per-connection FIFO with intent versioning; Android's "stop viewing" still uses the remembered pane and does not
  order the unwatch before the next watch. (d) **Resolved (2026-09-12/13 rounds):** `session.ts` no longer
  leaks a lease taken after disposal — `startWatch` re-checks `this.disposed` after each `await` (and explicitly
  `leave`s a zoom that landed on the disposed path), `fit` re-checks `disposed` after `ensurePane`/`apply` and releases
  a half-taken lease in a `finally`, and `inWatchOrder` drops queued watch/fit/viewing turns once disposed so the
  `viewing` cleanup never runs against a dead session. (e) A phone
  that reconnects leaves its previous session on the bridge for up to the 45 s idle timer; a new `hello` from the same
  device (`mode: full`) could close the older full session at once. (f) The pane screen has no "Retry now" while
  Offline; only the list's banner does (UI change: both platforms together). (g) The composer clears the draft before
  the `prompt` / `text` is acknowledged; a request that fails with `closed` loses the text. (h) iOS `approvalInFlight`
  is not cleared when the connection drops mid-approve; reconcile it on the next snapshot. (i) `link.ts` reports `up`
  before the first structural snapshot has been applied, so a watch restarted on `up` can briefly see no panes. (j)
  Android has no connection breadcrumbs (iOS now logs generations, reasons and close codes under
  `com.inferenceaftermath.remotly` / `connection`); a matching `Log.i` trail would make field reports comparable.

## Onboarding programme (decided 2026-09-15; phase 1 delivered)

Goal: `curl -fsSL https://remotly.dev/install.sh | sh` on a host with herdr and a Tailscale login, then scan the QR — and an
open repository. Owner decisions: Apache 2.0; relay at `relay.remotly.dev`; delete the fixtures captured from the owner's
sessions together with the tests that use them; GitHub Releases only (no npm). Tailscale stays required.

1. **Push relay — done and live** (`relay/`, Cloudflare Worker, free plan, deployed 2026-09-16 at `relay.remotly.dev`; bridge
   `push.relay_url`, `RelayClient`, doctor/status modes; `push-test` through the relay verified on all three devices).
   Owner still to do: the two edge rules (WAF custom rule on the user agent, the one free rate-limiting rule on `/v1/push`)
   and a decision on the free plan's 100k/day cap vs Workers Paid ($5/month, no cap) — `relay/README.md` "The free plan's
   daily quota"; a least-privilege Firebase service account (Cloud Messaging API Admin only) before the flip.
   Open from the review (P2, app side, both platforms): a forged `done` / `status` push is applied locally by the apps
   (Android `Session.kt` un-arms the pane, `Notifications.kt` hides the progress notice; iOS ends the Live Activity) —
   treat push data as a hint and reconcile the armed set / activity state with the bridge on the next connect, or have
   the bridge sign push payloads with a per-device key from pairing. Needs a device token to exploit.
   Open (Android, bridge, relay, protocol — one coordinated change): firebase-messaging 25.1 deprecates the registration
   token (`getToken`, `onNewToken`) for the Firebase installation id (`FirebaseMessaging.register()`, `onRegistered`), and
   the FCM HTTP v1 `Message` gained a `fid` target (`token` is deprecated and accepts an installation id during the
   transition). The app still registers by token with the two uses marked; moving means `push.register` carrying the
   installation id, the relay naming the target for what it is and sending `fid` (its token check happens to accept
   an installation id, which is not the same as supporting it), the protocol document, and re-registration of paired
   phones. Tokens keep working until Firebase removes them.
2. **`remotly-bridge setup` + `install.sh` — done 2026-09-16** (`bridge/src/setup.ts`, `install.sh`, `bridge/scripts/package.sh`,
   `.github/workflows/release.yml`; verified on the owner's host with a test unit, and `install.sh` against a local package).
   `remotly.dev` already serves the product site from outside this repository, so there is no Worker for `install.sh`:
   the owner adds a Cloudflare **redirect rule** `remotly.dev/install.sh` → `https://raw.githubusercontent.com/inferenceaftermath/remotly/main/install.sh`
   (works once the repository is public; `curl -fsSL` follows it). First release: tag `bridge-v0.1.0` after the flip.
   `ci/deploy-bridge.sh` (a host that follows `main`) rsyncs the repository into `~/.local/share/remotly/app` (bridge under
   `app/bridge/`) and, since 2026-09-17, renders and restarts the unit with `node bridge/src/main.ts setup --no-pair --no-wait --keep-mode`
   (`install-service.sh` and the unit template are gone). `install.sh` puts a release tarball (bridge at `app/` top level) in
   the same directory and refuses to run over a repository deploy (`REMOTLY_FORCE=1` overrides): a host is either
   CI-deployed from `main` or release-installed, not both. macOS hosts (launchd) deferred.
3. **Open-source readiness** per the open-source audit of 2026-09-07 (owner's notes). **Done 2026-09-17 (scrub and public face):**
   Apache-2.0 `LICENSE`/`NOTICE`, identifiers replaced by documentation values in code, tests, protocol and app placeholders,
   owner documents and scripts moved to the private notes repository, fixtures from the owner's sessions deleted (tests use
   typed-in screens) and the rest redacted, herdr schema dropped (licence unconfirmed; regeneration documented), README /
   ONBOARDING / platform READMEs / OPERATIONS rewritten for strangers, `docs/DELIVERY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
   `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates, CODEOWNERS, Dependabot, `ci.yml` on GitHub-hosted runners,
   `deliver.yml` guarded to the upstream repository with the ASC ids in repository variables and home directories masked.
   **Done 2026-09-17 (bridge code):** B3 dispatcher looks up own handlers only, S1 `include_excerpt` gates every push
   field, S2 `serve` waits for an installed-but-down Tailscale and exits for systemd instead of the gate-off fallback (a
   user unit cannot order after `tailscaled.service`), S4 `info` logs without reply text / tab labels / TLS handshakes, S5
   WebSocket caps per peer and in total, a per-minute pairing budget, header and request timeouts. **Deferred:** S6 token at rest and S7 lint (both apps),
   S11 Flow → Remotly renaming (wire-level `flow_version` + APNs `flow` key need a coordinated bridge+apps release), B2 icon
   artwork (owner), GitHub Actions settings (owner).
4. **Publish**: orphan branch with one squashed commit, full-history scan, owner force-pushes `main`, flips visibility, enables
   protections, tags `bridge-v0.1.0`; host checkout reset; end-to-end install on a clean account; `ONBOARDING.md` §3–4 reduced to
   prerequisites + one command.

## Product ideas not started

- Rows-fit: herdr's `pane.resize` moves split boundaries, not the PTY, so the phone's row count cannot be applied;
  needs a PTY-resize API inside herdr (upstream contribution candidate). Scrollback beyond herdr's 999-line `pane.read`
  cap is unreachable for the same reason.
- Reader mode (`recent_unwrapped` reflowed to the phone width): largely obsolete now that fit makes the program wrap to the phone's columns.
- Multiple hosts in the UI (the data model already stores one host). The site's pairing mock shows a "‹ Hosts" back
  button that promises this; until it exists the mock (not the app) should lose the button.
- Design pass follow-ups (2026-09-08, `shared/design/DESIGN.md`): one Live Activity listing every working agent (the
  site's lock-screen mock) instead of one per pane — a content-state and bridge change; `since` counts from the bridge's
  first sight of a working pane, so after a bridge restart the clocks restart (herdr has no start time to read); verify
  the pass on both phones and on iPad: bundled JetBrains Mono loads (app and widget), the icon, the eight key caps on a
  small phone, swipe/long-press row actions, the toast on every screen.
- A transport for hosts without Tailscale (the brief mentioned iroh).
- From the retired sibling builds (reviewed read-only 2026-09-03): a watcher `kick()` right after input so the echo
  shows sooner; per-device push suppression (only the device viewing the pane is skipped, the others are still notified).

## Chores

- Apple Developer membership renews yearly; if it lapses, TestFlight installs and APNs pushes stop.
- TestFlight builds expire 90 days after upload; a fresh one is uploaded by a push to `main` that touches `ios/`, `shared/`
  or the pipeline (`ci/plan.sh`), or on demand by `gh workflow run deliver.yml -f ios=true -f android=false -f bridge=false`.
  Play internal testing does not expire.

## Design notes parked on 2026-09-06 (user's dump; to be taken one at a time after the scrolling work)

1. **Photos into the tool from the phone** — **done 2026-09-07** (`POST /upload`, attachment chips in both composers). Remaining idea from the note: a "Files" source for non-photo documents.
2. **Approval card → verbatim option mirror** — **done 2026-09-07** (`choose` request: arrows from the ❯ marker, read-back,
   Enter; `approval.selected` / `approval.kind`; one button per option on both cards; questions announced as questions).
   Left from the note: multi-select menus and "Other" free text still go through the key row / composer; later,
   for Claude only, the `PermissionRequest` hook (tool_name + tool_input, allow/deny, default timeout 600 s, no decision →
   normal dialog) and `Notification` hook (`permission_prompt`, `idle_prompt`, `agent_needs_input`…) as a structured source
   that reports and exits; there is no hook for AskUserQuestion.
3. **First page reorganised around attention, not desktop layout** — **partly done 2026-09-08** (design pass, then the
   sessions batch the same day, `shared/design/DESIGN.md` §4.3): blocked panes first under "Needs you", then one section
   per herdr tab (a long press opens Close terminal; the minimalism pass of 2026-09-08 removed Arrange mode and the
   swipe / sheet actions; the phone's "Pinned" section with Pin / Unpin and grip reordering was removed on 2026-09-09 at
   the owner's request — the reorder never worked on the iPhone and unpinning misbehaved; not to come back); two-line row = tool
   glyph (§4.12: the tool's mark in the status colour, `>_` for a shell), session title
   (the pane title with the agent's glyph removed by the bridge), then cwd basename · status word, bell, elapsed clock
   from `since`. Not done from the note: "Working" / "Finished" / collapsed "Terminals"
   sections, the excerpt line, the "2 need you · 3 working" subtitle, recent commands as quick picks. Original note: Sections "Needs you" / "Working" / "Finished" /
   collapsed "Terminals" (plain shells); workspace › tab as a small caption. Row = bold project name from the cwd, agent
   badge, one line from the bridge's excerpt (pending question, last assistant line or running command), status pill +
   relative time, bell when armed; two lines max. Quick actions move to swipe (iOS) / long-press (Android), only for
   recognised permission prompts; tapping a "Needs you" row opens the pane with the option mirror. Optional subtitle
   "2 need you · 3 working"; recent commands as quick picks in New terminal. Same on both platforms.
