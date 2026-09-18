# Android — notes, decisions, deferred work

## Assumptions and protocol readings

- **Package = applicationId.** Kotlin namespace and `applicationId` are both `com.inferenceaftermath.remotly` (the value Firebase and Play match on). It was chosen before any store record or upload existed.
- **Trailing blank rows in golden frames.** `claude-permission-prompt.txt` ends in 13 empty lines
  (herdr returned the blank rows for that read) while every other fixture has them trimmed. A frame
  encodes both as `{"y":n,"runs":[]}`, so a client cannot reproduce the difference. The test therefore
  compares every row of the `rows × cols` grid with the corresponding `.txt` line, padding the golden
  with empty lines — stricter than a whole-text compare and independent of that artefact.
  `TerminalGrid.plainText()` itself mirrors the bridge: gaps as spaces, trailing spaces trimmed,
  trailing rows with no runs dropped (a row of styled blanks is kept as an empty line).
- **Wide vs. two-narrow runs.** `w:2` alone does not identify a wide grapheme (a two-character narrow
  run also has `w:2`). The grid treats a run as wide when `w == 2` and the text is a single grapheme by
  a small segmenter (combining marks, VS15/16, ZWJ sequences, emoji modifiers/tags, regional-indicator
  pairs). This needs no wcwidth table, as the protocol promises.
- **`viewing.pane` null.** The codec drops nulls (`explicitNulls=false`) so optional fields such as
  `feedback`/`force`/`unwrapped` are omitted, but `viewing` must send `"pane":null`; that field is a
  `JsonElement` and `Viewing.of(null)` emits `JsonNull`.
- **`herdr` after welcome.** The connection sets `herdrUp=true` on `welcome`; the bridge follows with
  `herdr state:"down"` when applicable.
- **Style ids per connection.** `FlowConnection` owns the `StyleTable` and clears it on every
  `welcome`, before the first full frame of the new socket arrives.
- **Stale frames.** Frames whose `pane` is not the currently watched pane are ignored (styles are still
  merged), which covers the window between `watch(A)` and `watch(B)`.
- **Reconnect.** OkHttp `pingInterval(15 s)`; on close/failure the backoff is 0.5 s doubling to 10 s;
  `watch` (last watched pane) and `viewing` are re-sent after `welcome`. Close code 4401 or an `error
  auth` without id puts the connection into `Unpaired` and stops retrying; the UI shows a "Re-pair"
  banner that forgets the host.
- **Foreground-only socket.** The live connection exists while an activity is started (`onStart` /
  `onStop`); in the background, approvals arrive by FCM. A default network callback triggers an
  immediate reconnect when connectivity returns.
- **Approval bar.** Result lines are keyed to the current `prompt_id`; "Send anyway" re-sends the last
  action with `force:true` after `signature_mismatch`. A 25 s guard clears the busy state if no
  `approval.result` arrives.
- **Notification actions.** `ApprovalActionReceiver` (PendingIntent.getBroadcast, FLAG_IMMUTABLE)
  updates the notification to "Sending…" and starts `ApprovalActionService`, a plain started service
  (allowed because executing a notification PendingIntent puts the app on the temporary allowlist).
  The service opens a `mode:"action"` connection, sends `approve`, waits ≤ 20 s for `approval.result`
  and rewrites the notification with the outcome. Notification id = `pane.hashCode()`, group = pane,
  `setTimeoutAfter(600 s)`. Stale approvals are cancelled whenever a connected snapshot no longer lists
  their `prompt_id`. WorkManager was not added (dependency budget); a started service is enough here.
- **Ctrl key.** Sticky for the next arrow key (`ctrl+up` …) and, in raw composer mode, for a single
  typed character (`ctrl+x`). `^C` has its own key. Alt is not on the key row (v1).
- **Key names** follow protocol §5 exactly; `home/end/pageup/pagedown` go through `keys` and the bridge
  translates them.
- **Scrollback.** Pulling past the top of the live screen fetches `history lines:300`; reaching the top
  again doubles the request up to herdr's cap of 999 (`has_more` gates it). History rows are shown
  bottom-aligned; "Jump to live" returns to the frame grid. Frames keep flowing meanwhile. The live screen is
  herdr's (taller than the phone: a fit keeps herdr's rows), so the view is a window over it, scrollable down to
  the last row with content and pinned to the bottom while it is there; in wheel / arrow mode a swipe moves the
  window first and only what it cannot spend at an edge becomes steps (a fling that reaches an edge hands the
  rest over as inertia). Never let the `OverScroller` drive Y when it was started with a 0…0 range: that once
  jumped the window to the top of the grid and hid the last rows.
- **Font sizing.** Default "fit to width" (cols × advance = view width, clamped 7–16 sp); pinch sets an
  explicit multiplier of 14 sp that is persisted; non-ASCII cells are drawn one by one at their grid
  position so fallback-font glyphs (CJK, emoji, powerline) stay aligned; wide cells are centred in two
  cells.

## Dependencies (why each)

- Jetpack Compose BOM 2025.01.01 (ui, foundation, material3), activity-compose, lifecycle-runtime-compose,
  core-ktx: UI, `collectAsStateWithLifecycle`, `NotificationCompat`, `enableEdgeToEdge`.
- kotlinx-serialization-json 1.11.0: wire models; sealed-interface polymorphism on `t`.
- kotlinx-coroutines 1.11.0: flows and request/reply.
- OkHttp 4.12.0: WebSocket with ping interval, `/pair`, custom `X509TrustManager` for pinning.
- DataStore Preferences 1.1.7: host/token store (see README on EncryptedSharedPreferences).
- CameraX 1.4.2 + **ZXing core 3.5.4** for the QR scanner. Chosen over ML Kit barcode scanning because
  it is fully offline (ML Kit's unbundled variant downloads a model through Play services, the bundled
  one adds ~3 MB and several transitive artifacts), it is a single small pure-Java jar, and QR is the
  only format we need. `play-services-code-scanner` (the original brief's suggestion) was not used for the same
  Play-services dependency reason and because the manual-entry fallback needs a permission story anyway.
- firebase-messaging 25.1.3: the only Firebase artifact. Google Services plugin 4.5.0 is applied only
  when `app/google-services.json` exists.
- Tests: JUnit (junit-jupiter 6.1.3), kotlin-test, kotlinx-coroutines-test.

No navigation library (three screens, a `when`), no WorkManager, no ViewModel artifact (the
`Session` object on the Application plays that role), no MockWebServer (socket path is exercised on
device; inbound dispatch is unit-tested through `FlowConnection.handle`).

## Toolchain

Gradle 9.7.1 (wrapper), AGP 9.4.0 with its built-in Kotlin (2.4.20, the version the Kotlin Gradle plugin on `:core`
sets for the whole build) and the Compose compiler plugin, compileSdk 37, targetSdk 36, minSdk 26, Java 17. `android/local.properties` (gitignored) points at the SDK.

## Deferred / not in this pass

- Release signing config reading `REMOTLY_STORE_*` from `~/.gradle/gradle.properties` (H7.3): wire when
  the owner creates the keystore; never reuse other projects' keys.
- Haptics, pull-to-refresh on the pane list (material3's PullToRefresh is still experimental in 1.3),
  Alt modifier key, long-press arrows → PgUp/PgDn (dedicated keys exist instead).
- Selection/copy beyond "copy line" (long-press) and "copy screen" (menu).
- On-device verification of the M5/M6 DoD (real phone, real bridge, FCM in Doze) — requires H7/H8.
- Reader mode (`history unwrapped:true` reflowed to phone width) — stretch.

## Design pass 2026-09-08

The UI now follows `shared/design/DESIGN.md` (tokens, type, status words, component anatomy) so iOS and Android match
the site's mockup. `ui/Theme.kt` holds the `Tokens`, the JetBrains Mono `Type` styles, the status vocabulary
(`Status.word/color`, "Fitting…", connection words) and the shared pieces (`StatusPill`, `FlowToast`/`ToastHost`,
`SectionLabel`, `OptionButton`, `FlowField`, `Segmented`, `SettingRow`). One toast (`Session.notify(text, ok)`)
replaced every Snackbar and `Toast.makeText`. The pane list gained the host banner card, "Needs you", `since`-driven
elapsed times and a long-press sheet (no FAB); the pane view a title/meta header and one overflow menu (A−/A+ moved
in); the approval card, key row (eight caps, Ctrl letters), composer (pill, round buttons), pairing (segmented,
viewfinder corners, pairs on scan), settings and the new-terminal dialog were rewritten to the spec. `PaneInfo` and
`PaneStatus` decode the optional `since` (ms since epoch; null from older bridges). Notifications carry
`setColor(accent)` and the "Deny with feedback" label.
