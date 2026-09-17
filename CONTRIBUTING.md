# Contributing to Remotly

Remotly is three code bases and a Worker that must agree on one wire protocol, so a few rules keep them in step.

## Ground rules

- **Both platforms, together.** Anything a user sees on the phone ships on iOS and Android in the same change, with
  identical interactions; `shared/design/DESIGN.md` is the visual system both apps follow. A pull request for one
  platform is welcome as a draft, and merges once the other side exists.
- **The protocol is normative.** `shared/protocol/remotly-protocol.md` is the single source of truth. A wire change
  lands in one commit together with the matching bridge, FlowKit and Android `:core` changes and the document.
- **Golden frames are part of the protocol.** `shared/fixtures/frames/` is generated from `shared/fixtures/reads/` by
  `node scripts/gen-frames.ts` (run in `bridge/`); all three test suites check them. Never edit them by hand; a change
  there is a protocol change and needs the same care.
- **Fixtures come from scratch sessions.** Capture screens (`bridge/scripts/capture.ts`) only in a throwaway directory
  and herdr session, never in your own work, and keep everything personal (paths, host names, account labels) out of
  `shared/fixtures/` (`shared/fixtures/frames/README.md`).
- **No secrets in the tree.** `.gitignore` covers keys, keystores and service accounts; the delivery runners read their
  credentials from `~/.config/remotly` on their own machines (`docs/DELIVERY.md`).
- **herdr behaviour** the code relies on is recorded in `docs/herdr-findings.md` with how it was measured. The bridge
  types only the parts of herdr's socket API it uses (`bridge/src/herdr/types.ts`); the full schema comes from
  `herdr api schema --output herdr-schema.json` and is not redistributed here.

## Build and test

| Part | Needs | Commands |
|---|---|---|
| `bridge/` | Node ≥ 24 (runs TypeScript directly) | `npm ci`, `npm run typecheck`, `npm test` |
| `relay/` | Node ≥ 24 | `npm ci`, `npm run typecheck`, `npm test`; deploying needs a Cloudflare account (`relay/README.md`) |
| `android/` | JDK 17, Android SDK platform 36 | `./gradlew :core:test :app:assembleDebug :app:lintDebug` (`android/README.md`) |
| `ios/` | macOS, Xcode 26, xcodegen | `cd ios/FlowKit && swift test`; the app: `xcodegen generate`, then build (`ios/README.md`) |

`.github/workflows/ci.yml` runs the same checks on GitHub-hosted runners for every pull request. `deliver.yml`
(TestFlight, Play, the bridge redeploy) runs only in the upstream repository on its own runners.

## Pull requests

- One topic per pull request, with the tests that show the behaviour, and a sentence on what a user sees differently.
- Say what you verified by hand, on which phone or host.
- Maintainers run an independent review before merging and may ask for changes.
- Contributions are licensed under the Apache License 2.0 (`LICENSE`, section 5).

Open work: `docs/BACKLOG.md`. Releases: `CHANGELOG.md`. Runbook: `docs/OPERATIONS.md`.
