# Remotly for iOS

Native iPhone client for the Remotly bridge (`bridge/`): live herdr panes, keys and prompts, approval
bar, lock-screen Approve / Deny via APNs, and a Live Activity while an agent works. Built and tested by
CI on macOS (`docs/DELIVERY.md`); `NOTES.md` records the design decisions.

```
ios/
  project.yml            XcodeGen spec (app target Remotly + local package FlowKit)
  Remotly/                  SwiftUI app (one UIKit view for the terminal grid)
  FlowKit/               Swift package: protocol codecs, grid, pairing, connection, keychain, push
  README.md  NOTES.md
```

Requirements: macOS with Xcode 26 (Swift 6 toolchain), Homebrew, an iPhone on iOS 17+, and the bridge
running on a host you can reach (`ONBOARDING.md`). Bundle id `com.inferenceaftermath.remotly`; the Apple
team is `DEVELOPMENT_TEAM` in `project.yml` — a fork sets its own team and bundle ids there
(`docs/DELIVERY.md`).

## One-time steps

1. Xcode → Settings → Accounts: sign in with an Apple ID of the team in `project.yml`.
   Automatic signing then creates the App ID and a development profile.
2. iPhone: Settings → Privacy & Security → Developer Mode → on (restart). Connect over USB, tap Trust.
3. Push: after the first successful signed build, check https://developer.apple.com/account →
   Identifiers → `com.inferenceaftermath.remotly` has **Push Notifications** and **Time Sensitive Notifications**
   enabled (Xcode normally adds them because of `Remotly/Remotly.entitlements`). Push needs no
   credentials on the host when the app owner's relay is used; a fork holds its own APNs key
   (`ONBOARDING.md` §2, `relay/README.md`).
4. On the phone allow notifications when asked (Settings → Notifications in the app), including
   Time Sensitive.

## Build and install

```bash
brew install xcodegen
cd ios && xcodegen generate

# Build for a device (first run creates the provisioning profile; needs the Apple ID signed in)
xcodebuild -project Remotly.xcodeproj -scheme Remotly -configuration Debug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build

# Find the phone and install the .app produced above
xcrun devicectl list devices
xcrun devicectl device install app --device <udid> \
  "$(xcodebuild -project Remotly.xcodeproj -scheme Remotly -configuration Debug -destination 'generic/platform=iOS' -showBuildSettings \
     | awk '/ TARGET_BUILD_DIR =/{d=$3} / FULL_PRODUCT_NAME =/{n=$3} END{print d"/"n}')"
```

Or open `Remotly.xcodeproj`, pick the phone as the run destination and press Run. If iOS says
"Untrusted Developer": Settings → General → VPN & Device Management → trust the profile.

## Tests

```bash
# FlowKit unit tests (protocol decoding, golden frames from shared/fixtures/frames, grid, QR, pinning, push)
cd ios/FlowKit && swift test                       # macOS host toolchain
# or through Xcode / a simulator
cd ios && xcodebuild test -project Remotly.xcodeproj -scheme FlowKitTests \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

The golden-frame test locates `shared/fixtures/frames` relative to its own source file and skips
(`XCTSkip`) when the directory is missing.

## Using the app

1. On the host: `remotly-bridge pair` prints a QR code (and the URL, code and fingerprint for manual
   entry). Scan it in the app, or switch to "Enter manually".
2. The pane list groups panes by workspace › tab; blocked panes float to the top with Approve /
   Deny buttons. Pull down to reconnect.
3. Open a pane: the terminal mirrors the desktop at the desktop's size (pinch to change the font,
   pan horizontally if it is wider than the phone). The clock button loads 500 lines of scrollback
   ("Older" fetches up to 999, herdr's cap); "Jump to live" returns. The key row sends Esc, Tab,
   arrows, Enter, Backspace, Home/End/PgUp/PgDn, Shift+Tab, Del and ^C; Ctrl is sticky for one
   key. The composer sends the whole (multi-line) text as one `prompt`; the menu's "Raw text mode"
   sends `text` verbatim instead. With "Zoom on desktop while viewing" (Settings, default on) the
   bridge zooms the pane on the desktop while it is open here and restores the split when you leave;
   the menu's "Zoom on desktop" toggles it by hand.
4. While the pane is blocked an approval bar offers Approve / Approve for session / Deny / Deny with feedback /
   Interrupt and shows the `approval.result` outcome; after `signature_mismatch` a "Send anyway"
   button repeats the action with `force:true`.
5. Notifications: the bridge pushes when an agent blocks and no connected device is viewing that
   pane. Long-press the banner → Approve or Deny runs in the background (device authentication
   required) and posts an outcome notification; tapping the banner opens the pane. Delivered
   banners whose prompt is no longer live are cleared when the app connects.

Settings shows the host URL and pinned fingerprint, bridge and herdr versions, notification
permission, font-size reset and "Forget this host" (removes the Keychain token; pair again).

## Known limitations

- Self-signed certificates (LAN mode) are refused by iOS even when pinned (`docs/OPERATIONS.md` "Self-signed
  certificate and iPhones"); iPhones need the Tailscale certificate.
- Alt as a modifier is not offered; Home/End/PgUp/PgDn go through the bridge's key translation.

Design decisions and the notes from the first Mac builds: `NOTES.md`.
