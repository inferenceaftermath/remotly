# ios/ — assumptions and likely build complaints

Decisions taken where the protocol left room, and the spots that needed attention on the first Mac builds. The package
and app have been built and tested by CI on macOS since 2026-09-03.

## Protocol decisions

- Wire contract is `shared/protocol/remotly-protocol.md` (the original brief's §5 was folded into it). Where the
  bridge emits `null` for optional fields (`agent`, `display_agent`, `state_label`, `cwd`,
  `focused_pane_id`, `herdr_version`, `herdr_protocol`) the models use optionals.
- `AgentStatus`, `ApprovalOutcome`, `ErrorCode` are `RawRepresentable` structs, not enums, so a
  newer bridge value never fails decoding. Unknown `t` decodes as `ServerMessage.unknown`.
- Request ids are strings; numeric ids from an older bridge are accepted when decoding replies.
- Grid painting: a run whose grapheme count (`Character`s) equals `w` is one grapheme per cell;
  anything else (a `w:2` wide grapheme, or an unexpected mismatch) keeps the whole text in the
  first cell with `width == w` and marks the rest as continuation cells. This reproduces every
  golden `.txt` (checked with a Python model of the same algorithm against every fixture).
- The `.txt` fixtures may carry trailing blank lines (herdr's plain read); the test compares after
  trimming trailing empty lines on both sides.
- `viewing` is sent as `{"t":"viewing","pane":null}` when leaving a pane and just before the
  socket is closed on backgrounding, so push suppression ends immediately instead of after the
  bridge's 45 s silence timeout.
- Backoff 0.5 s → 10 s doubling; the attempt counter resets after any successful `welcome`.
  Foregrounding calls `resume()` which skips the pending backoff. Close code 4401 or an `error
  auth` without id → `.unpaired`, no retries.
- `push.register` env: `aps-environment` from the embedded provisioning profile when readable,
  else `sandbox` for `DEBUG` builds and `production` otherwise.
- Notification actions use `HostStore` (Keychain, `AfterFirstUnlock`) and a `mode:"action"`
  connection with a 20 s overall deadline; the outcome is posted as a local notification
  (category `REMOTLY_OUTCOME`). The delivered approval banner is removed after `sent`/`stale`/
  `not_blocked` assuming the bridge's `apns-collapse-id` (= pane id) is the notification identifier.
- Key row: Home/End/PgUp/PgDn are sent as `home`/`end`/`pageup`/`pagedown` (bridge translates).
  Ctrl is a sticky modifier revealing letter chips (`ctrl+<x>`). Alt is not offered in v1.

## Build notes from the first Mac builds

1. **XcodeGen `package:` test targets** — only the optional `FlowKitTests` scheme uses
   `test.targets: [{package: FlowKit/FlowKitTests}]`; the `Remotly` build scheme has no test action.
   If your XcodeGen version rejects it, delete the `FlowKitTests` scheme and run the tests with
   `cd FlowKit && swift test` or by selecting the auto-created `FlowKit` package scheme in Xcode.
2. **Info.plist / entitlements** are hand-written and referenced through `INFOPLIST_FILE` /
   `CODE_SIGN_ENTITLEMENTS` with `buildPhase: none` source entries. If XcodeGen warns about them,
   drop the two `buildPhase: none` entries (the build settings alone are enough).
3. **Signing**: automatic signing needs an Apple ID of the team set as `DEVELOPMENT_TEAM` in `project.yml`. The
   `aps-environment` and `com.apple.developer.usernotifications.time-sensitive` entitlements
   require Push Notifications + Time Sensitive Notifications on the App ID; `-allowProvisioningUpdates`
   usually adds them. If provisioning fails, enable them in the developer portal (Identifiers → the App ID → Push Notifications)
   or temporarily remove the time-sensitive key from `Remotly/Remotly.entitlements`.
4. **Swift 6 strict concurrency** hot spots, in the order I would check:
   - `FlowConnection` calls `URLSessionWebSocketTask.receive()/send()` from an actor; this relies
     on `URLSessionTask` and `URLSessionWebSocketTask.Message` being `Sendable` in the SDK (they
     are annotated in recent SDKs). If not, wrap the task in a small `@unchecked Sendable` box.
   - `PinningSessionDelegate` implements the async form of
     `urlSession(_:didReceive:)`; if the compiler wants the completion-handler form, switch to it
     and call the handler synchronously.
   - `NotificationDelegate` is a nonisolated class implementing the async delegate methods; if the
     SDK marks `UNUserNotificationCenterDelegate` `@MainActor`, the class can simply be marked
     `@MainActor` too.
   - `TerminalTheme` / `TerminalMetrics` are `@MainActor` because they hold `UIColor`/`UIFont`.
   - `QRScanner` is `@unchecked Sendable` (owns an `AVCaptureSession` driven from a private queue).
5. **`UNAuthorizationOptions.timeSensitive`** requires the entitlement; without it the request
   still succeeds but banners are not time-sensitive.
6. **Package tools version 6.0** (`swiftLanguageModes: [.v6]`). Xcode 16+ / Swift 6 required. For
   Xcode 15 change to `// swift-tools-version: 5.10` and `swiftLanguageVersions: [.version("6")]`
   or drop the language-mode line.
7. **App icon**: `AppIcon.appiconset` has no image; Xcode warns but builds. Add a 1024×1024 PNG later.
8. **Simulator**: no camera → the pairing screen shows a hint; use "Enter manually". Push does
   not work in the simulator.

## Design pass 2026-09-08

Everything in `shared/design/DESIGN.md` applied without a compiler (Linux, no Swift toolchain). New files:
`Shared/DesignTokens.swift` (tokens, status vocabulary, JetBrains Mono helpers; compiled into the app and the widget)
and `Remotly/Views/Theme.swift` (typed helpers, `StatusPill`, `ConnectionPill`, `SectionLabel`, `ElapsedText`, toast,
button styles, `SegmentedControl`). Rewritten: `PaneListView`, `HostBanner` (now `HostBannerCard`),
`PaneView`, `ApprovalCard`, `KeyRow`, `PairingView`, `SettingsView`, `FlowActivityWidget`. Edited: `AppModel`
(`Notice {text, ok}`, `fitPhase`/`fitting`, `fitCols`, `paneSize`, `since`), `TerminalGridUIView` (colours, fonts,
selection), `QRScannerView` (colours), `Snapshot.swift` (`since` on `Pane`/`PaneStatus`), `Styles.swift` (palette),
`PushPayload.swift` ("Deny with feedback"), `Info.plist` (launch colour), `FlowActivity/Info.plist` (`UIAppFonts`),
`project.yml` (fonts into the widget target).

Things the Mac build may complain about, in the order I would check:

1. **Fonts.** `UIAppFonts` lists bare file names (`JetBrainsMono-Regular.ttf`): XcodeGen adds `Remotly/Fonts` as a
   group, so the files land at the bundle root. If the fonts do not load (`UIFont(name:)` nil; the UI silently falls
   back to the system monospaced font, so check with the font inspector or a breakpoint), either the copy phase put
   them under `Fonts/` (then prefix the plist entries) or the PostScript names differ from `JetBrainsMono-Regular` /
   `JetBrainsMono-Bold` (`fc-scan --format '%{postscriptname}\n' Remotly/Fonts/*.ttf`).
2. **Synthesised italic** (`TerminalMetrics.italicVariant`): uses `UIFontDescriptor.AttributeName.matrix` with a
   skew. If the SDK rejects the attribute name, drop the skew and return `font` (italic then renders upright).
3. **`Text + Text` with `.foregroundStyle`** in `PaneRow.name`: `Text.foregroundStyle(_:)` is iOS 17; if the
   compiler picks the `View` overload, replace with `.foregroundColor(_:)` on each `Text`.
4. **`ForEach(options, id: \.0)`** in `SegmentedControl` (tuple key path). If rejected, switch `options` to an array
   of a small `struct Segment: Identifiable`.
5. **`.toolbarRole(.editor)`** on `PaneView` hides the back button's text; if the title block still collides with the
   chevron on some device, move it to `ToolbarItem(placement: .principal)` with leading alignment.
6. **`Toggle` inside `Menu`** with a `Binding` whose setter spawns a `Task` (`notifyDone`): if Swift 6 complains about
   the closure's isolation, mark the binding getter/setter closures `@MainActor` explicitly.
7. **`ConnectionProblem.Info`** holds a non-Sendable closure in a `@MainActor` context; if a Sendable check fires,
   mark `Info` `@MainActor` or make the closure `@MainActor @Sendable`.
8. **`@Observable` with nested `struct Notice`** and stored `GridSize?` / `FitPhase`: plain value types, but if the
   macro objects to the nested type declaration, move `Notice` to file scope as `AppNotice`.
9. **Widget target**: `Shared/DesignTokens.swift` imports UIKit for `UIFont(name:)`; WidgetKit extensions can link
   UIKit, but if the linker objects, guard `monoUIFont` with `#if canImport(UIKit)`.
10. **`Button(intent:)` with `.buttonStyle(.plain)`** and custom backgrounds in the Live Activity: supported on iOS 17;
    if the buttons render without their fills, remove `.buttonStyle(.plain)` and use `.tint`.
11. **`Text(timerInterval:)` with `.monospacedDigit()`** ordering: `.font(...)` must precede `.monospacedDigit()`.
12. **`ViewThatFits` around `ApprovalCard`** (`PaneView`): two instances of the card are declared, one plain and one in a
    `ScrollView`, capped at 55 % of the `GeometryReader` height; only one is rendered, so the card's `@State` (feedback
    sheet) resets if the dialog grows past the cap while the sheet is open. Acceptable. The `GeometryReader` wraps the
    whole `VStack`; if it changes the keyboard avoidance, move the cap to `UIScreen.main.bounds.height * 0.55`.
13. **Live Activity deep link** (`Shared/DeepLink.swift`): `remotly://pane?id=<pane>` is the `widgetURL` of the Lock
    Screen view and of the `DynamicIsland` (its own `widgetURL(_:)`, which covers the compact, minimal and expanded
    presentations) — one modifier per hierarchy, as WidgetKit documents that several are undefined. `Button(intent:)`
    keeps its taps. `RootView.onOpenURL` routes a pane link to `AppModel.openPane` when paired; `PaneListView` closes
    the Settings / New terminal sheet when the path changes so the pane shows. The `remotly` scheme is NOT registered
    (`CFBundleURLTypes`): WidgetKit delivers the URL to the containing app on its own, and registering it would make the
    system Camera offer to open a `remotly://pair` QR that the app cannot pair from. `forgetHost()` ends every Live
    Activity so none survives into the next pairing (Android cancels its notifications in `unpair`).

Interpretations of DESIGN.md taken here (mirror them on Android if they are kept):

- Key row while Ctrl is armed: `Esc Tab Ctrl ↑ ↓ ← →` stay (the arrows send `ctrl+<arrow>`), the caps from ⏎ onward
  become the letters `C D Z L A E U K R W X B N P F G O [ \`.
- "Swiping up and down" keeps the four existing modes (Automatic · Scrollback on this phone · Mouse wheel · Arrow keys)
  as an inline radio group; the spec's "three modes" would drop Automatic, which the bridge relies on.
- The pane view has no banner; while the connection is not up its header pill shows the connection word instead of
  the pane status (same on Android).
- "Fitting…" clears on the first frame after the `fit` reply, or after 3 s when the program does not redraw.
- Blocked panes appear only under "Needs you", not again in their tab's section.

## Review pass

A second, compiler-less read of every `.swift` file against Swift 6 strict concurrency, iOS 17 and
`shared/protocol/remotly-protocol.md`. One line per decision; each is the reading most likely to compile.

- Wire contract re-checked field by field (`hello`, `approve`, `push.register`, `/pair`, QR `u/fp/c/n`,
  `welcome.host.*`, `snapshot`/`pane.status` keys, `frame`/`history` encoding, 4401): no mismatches found.
- `GridFixtureTests` hard-coded cells verified against `unicode-styles.frame.json` (rows 1, 6, 7; style 10
  is `bg:p4`); no `.txt` fixture has trailing spaces, so `rowText`'s trimming matches the goldens.
- Views whose helpers/computed properties touch `AppModel` outside `body` (`PairingView`, `PaneView`,
  `ApprovalBar`, `HostBanner`, `SettingsView`, plus `RootView`, `PaneListView`, `BlockedPaneRow`,
  `QRScannerView`, `TerminalView`) are now explicitly `@MainActor`: on the iOS 18 SDK `View` is already
  `@MainActor` so this is a no-op; on the iOS 17 SDK it is what makes those members legal. It also
  makes the view structs `Sendable`, which `Binding(get:set:)` closures may require on newer SDKs.
- Bare main-actor method references passed as function values were replaced with closure literals
  (`Button { send() }`, `.map { uiColor($0) }`): converting `@MainActor (T) -> U` to `(T) -> U` can be
  rejected as "loses global actor" in Swift 6.
- `Color(.systemBackground)`-style calls became `Color(uiColor:)` (`Color(_: UIColor)` is deprecated
  since iOS 15 and ambiguous once asset-catalog `ColorResource`s exist).
- `TerminalGrid.init(historyLines:)` reads `cols` into a local before the `&cells[y]` inout access.
- `MessagesTests` reads `` w.`protocol` `` with backticks (a keyword member after `.` is legal but the
  escaped form is unambiguous on every toolchain).
- `project.yml`: the `Remotly` scheme lost its `test:` action; the unverified `package:` test reference is
  confined to the optional `FlowKitTests` scheme (item 1 above). Bundle id, team, iOS 17.0, Swift 6,
  Info.plist/entitlements paths and the local `FlowKit` package reference were checked and left as is.
- Protocol doc now says `herdr {state}` is also sent once right after `welcome`; `AppModel` already
  folds `herdr` events in at any time, so nothing changed.
- Still unverified and left alone (see item 4 above): `URLSessionWebSocketTask` being `Sendable` in the
  SDK, the async form of `urlSession(_:didReceive:)`, `UNUserNotificationCenterDelegate` isolation, and
  `URLSessionWebSocketTask.closeCode.rawValue == 4401` relying on the `@objc` enum carrying an unlisted
  raw value (it does at runtime; if the compiler objects, compare via `closeCode.rawValue` on an `Int`).

## Not implemented (deliberately, v1)

- Long-press key variants, Alt modifier, "copy line" (only "copy screen"), haptics, multiple
  hosts, reader mode. `FlowTests`/`FlowUITests` app-level test targets (FlowKit carries the tests).
- Scrollback is a paged fetch (500, then up to 999 lines) rendered in the same grid view with
  "Older" / "Jump to live" buttons rather than infinite upward scrolling.
