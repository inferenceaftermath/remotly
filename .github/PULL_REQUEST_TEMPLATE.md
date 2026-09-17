## What changes for the user

## How it was verified

- [ ] `npm run typecheck && npm test` in `bridge/` (and in `relay/` when touched)
- [ ] Android: `./gradlew :core:test :app:assembleDebug :app:lintDebug`
- [ ] iOS: `swift test` in `ios/FlowKit`; built and tried on a phone when the UI changed
- [ ] Phone-facing change: both platforms updated together, identical interactions (`shared/design/DESIGN.md`)
- [ ] Wire change: `shared/protocol/remotly-protocol.md`, the bridge, FlowKit and `:core` updated in this commit; golden frames regenerated
