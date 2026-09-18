# Local demo and store-review access

Both apps have **Try demo** at the top of the pairing screen and in Settings for an already paired phone.
No account, bridge, camera permission, notification permission or Tailscale connection is needed.

## Review steps (Android, iPhone and iPad)

1. Launch Remotly and tap **Try demo**. The screen says **Demo mode · Sample data** and
   **Local simulation · no host connected**.
2. Open **Review a change**. Try **Approve**, **Approve for session**, **Deny**, or **Deny with feedback…**.
   An accepted sample request moves through working to done; denial returns it to idle.
3. Open **Choose an approach** and choose one of its answers (or **Something else…**).
4. Open **Sample terminal**. Send a message, switch to raw text mode, use the key row, change text size,
   select/copy terminal output, or browse scrollback after enough sample output accumulates.
   Responses are fixed simulations; typed commands are never executed.
5. Use **New terminal** to create another sample, then **More → Close terminal** to remove it.
6. Tap **Exit demo**. The original pairing screen or saved host returns. Entering again starts fresh samples.

Notifications, Live Activities / ongoing status, photo uploads, desktop zoom and actual agent execution require
pairing with a real bridge. Demo mode does not register push tokens, send uploads, execute commands or open a
network connection to a bridge. A platform SDK may independently perform its usual startup work; demo is not a
claim that the entire app process never uses the network.

Demo sessions and input live only in memory. Backgrounding pauses the local peer and foregrounding restores it;
exiting demo or restarting the app discards samples. Demo never writes fake credentials over the saved host.
Ordinary display preferences (such as font size) remain user preferences. Sample scroll modes and pane navigation
are not saved as real-host state. Notification taps cannot open a real pane while demo is active.
Entering demo also cancels real-host connections, including notification approvals/replies still waiting to connect.
Those pending actions cannot be sent by a delayed welcome or revived when demo exits. A request already sent to a
host before entering demo cannot be recalled.

## Implementation and verification

`DemoBridge` is a local protocol peer inside Android `:core` and iOS `FlowKit`. Existing terminal rendering,
request/reply handling, approval cards, pane creation and input controls consume its normal protocol messages.
There is no server, shell, upload client or credential in the peer. Each `FlowConnection` chooses its transport
once at construction; demo is never inferred from a saved host URL.

`shared/demo/demo.json` is the canonical sample scenario. Android packages it as a core resource. SwiftPM bundles
`ios/FlowKit/Sources/FlowKit/Resources/demo.json`; the iOS test checks it byte-for-byte against the canonical file.
When changing samples, update both files together. Do not alter the protocol's golden terminal fixtures.

- Android: `cd android && ./gradlew :core:test :app:assembleDebug :app:lintDebug`.
- iOS core: `cd ios/FlowKit && swift test` on macOS.
- Both core suites use a local WebSocket test peer to delay welcome messages and verify that demo entry cancels
  pending Approve/Reply sends, while a fresh real-host connection still works after demo exits.
- iOS UI: generate the project with `cd ios && xcodegen generate`, then run the `RemotlyDemoUITests` scheme on a
  dedicated, clean iPhone/iPad simulator. The tests exercise entry without permission prompts, approvals, choices,
  background/resume, reset, creation/closing and disabled photo uploads. Successful tests attach genuine app
  screenshots labelled as demo data.
- On an already paired Android phone/emulator, enter from Settings, interact with samples, exit, and confirm the
  original host reconnects. Verify its stored pairing was not replaced. Repeat after background/foreground.

The demo is present in release builds and discoverable to every user; it is not a hidden reviewer-only feature.

The iOS app bundles `Remotly/PrivacyInfo.xcprivacy`, declaring `UserDefaults` reason `CA92.1` for its own saved
display and notification preferences. Demo scroll modes remain in memory. This required-reason declaration is
separate from the App Store privacy labels and the published privacy policy.
