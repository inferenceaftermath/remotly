# Delivery — how builds reach the phones, and how to run your own lane

`.github/workflows/deliver.yml` runs on every push to `main` and delivers what the push touched: `ci/plan.sh` compares the
changed paths and schedules a Play internal-testing release for `android/`, a TestFlight build for `ios/`, a redeploy of
the bridge on the herdr host for `bridge/`, all three for `shared/`, `.github/` or `ci/` (except the runner installers
`ci/setup-*`), and nothing for documentation-only pushes; `gh workflow run deliver.yml -f ios=true …` forces a lane. It runs only in the upstream repository (a job-level guard checks
`github.repository`) and only on two self-hosted runners labelled `remotly`; pull requests are checked by `ci.yml` on
GitHub-hosted runners instead. A fork that wants its own lane needs its own records, runners and identifiers, listed here.

## Channels

| Platform | Channel | How a tester gets builds |
|---|---|---|
| iOS | TestFlight internal testing | App Store Connect users added to the app's internal group; every processed upload appears in the TestFlight app. No Beta App Review. Builds expire 90 days after upload. |
| Android | Play Console internal testing track | Testers by e-mail; each phone opens the opt-in link once, then Play updates the app like any other. Internal testing needs no store listing, content rating or review; releases do not expire. |

TestFlight builds carry `aps-environment = production`; the app reads it from its provisioning profile and registers
push tokens with `env: production`, Xcode debug installs with `sandbox`. The bridge routes each token by its `env`.
FCM has a single environment.

## What the workflow does

`ci/plan.sh` decides from the changed paths (`workflow_dispatch` has one checkbox per lane): docs-only pushes and the
runner installers (`ci/setup-*`) deliver nothing; `shared/`, `.github/` or any other `ci/` file deliver everything. Build number and `versionCode` are the run number.

| Job | Runner | Steps |
|---|---|---|
| `bridge-test` | Linux | `npm ci`, `tsc --noEmit`, `npm test`; gates every delivery |
| `android` | Linux | `:core:test :app:lintRelease :app:bundleRelease` signed with the upload key, then `r0adkll/upload-google-play` to track `internal` |
| `ios` | Mac | `swift test` in `ios/FlowKit`, then `ios/scripts/testflight.sh` (archive with cloud-managed signing, export with `destination=upload`) |
| `bridge-deploy` | Linux | `ci/deploy-bridge.sh`: rsync the workspace to `~/.local/share/remotly/app`, `npm ci --omit=dev`, re-render and restart the user unit through `setup --no-pair --no-wait --keep-mode` (the host's LAN or Tailscale mode stays as configured), check `status`, roll back on failure |

Secrets never enter GitHub. Each runner reads them from `~/.config/remotly` on its own machine; the only values in
GitHub are two repository variables (Settings → Secrets and variables → Actions → Variables): `ASC_KEY_ID` and
`ASC_ISSUER_ID`, the App Store Connect API key id and issuer id (the `.p8` stays on the Mac). Log output masks the
runners' home directories (`::add-mask::`).

## Running your own lane

1. **Records.** App Store Connect: an app for your bundle id, TestFlight internal group. Play Console: an app for your
   package name; the first release of a new app must be uploaded through the console UI, the API works from the second
   (`play_status: draft` in `workflow_dispatch` for a brand-new app that has never been rolled out). Firebase: a project
   with an Android app for your package name (`google-services.json`) and, for push, a service account; Apple: an APNs
   auth key for your team. If your hosts should send push without credentials, deploy your own relay (`relay/README.md`).
2. **Identifiers to change in the tree.** Android `applicationId`/namespace (`android/app/build.gradle.kts`,
   `deliver.yml` `REMOTLY_PACKAGE`, `bridge/scripts/firebase-android-app.ts`, the Kotlin package directories); iOS
   bundle ids (`ios/project.yml`, `HostStore.swift`, `AppInfo.swift`); Apple team id (`ios/project.yml`
   `DEVELOPMENT_TEAM`, `ios/ExportOptions-testflight.plist`, `APPLE_TEAM_ID` in `ios/scripts/testflight.sh`); the
   repository name in the guard of `deliver.yml` and in `ci/setup-*-runner.sh` (`REMOTLY_REPO`).
3. **Linux runner** (on the herdr host, as the user that runs herdr): `ci/setup-linux-runner.sh` registers a runner with
   the `remotly` label and installs a user unit for it. It needs, under `~/.config/remotly/secrets/`:
   `keystore.properties` (+ the upload keystore it names), `play-service-account.json` (or `fcm-service-account.json`
   with release rights on the Play app), `google-services.json`; and Node 24 (fnm default alias, or `REMOTLY_NODE_BIN`),
   JDK 17 and the Android SDK (`REMOTLY_JAVA_HOME`, `REMOTLY_ANDROID_HOME`, defaults `~/sdks/jdk-17`, `~/sdks/android-sdk`).
4. **Mac runner**: `ci/setup-mac-runner.sh` (launchd LaunchAgent, no sudo). It needs Xcode, xcodegen, and under
   `~/.config/remotly/`: `asc-api-key.p8` (the App Store Connect API key) and `keychain-pass` (the login password, so a
   headless session can unlock the keychain for code signing; `errSecInternalComponent` means it is missing).
5. **Runner hygiene.** Both runners run as an interactive user with access to that machine's credentials, the herdr
   socket and the bridge. Keep `deliver.yml` on `push` to `main` and `workflow_dispatch` only, never on
   `pull_request`; require approval for outside collaborators' workflows; restrict allowed actions and require SHA
   pinning (Settings → Actions → General); protect `main`.

## Runner operations

- Runner offline → jobs queue (up to 24 h) and run when it returns. `gh run list` shows runs;
  `gh workflow run deliver.yml -f android=true -f ios=false -f bridge=false` re-delivers one lane.
- Triage: Android upload 403 → the service account lacks Play access or the Google Play Android Developer API is off in
  its project; iOS `errSecInternalComponent` → keychain locked (password file missing); bridge deploy unhealthy → the job
  prints the unit's journal and rolls back to the previous deploy.
- Re-registering a runner: delete it in GitHub → Settings → Actions → Runners, remove the `.runner` file, rerun the setup script.
- Apple Developer membership renews yearly; if it lapses, TestFlight installs and APNs pushes stop. TestFlight builds
  expire after 90 days: a push to `main` that touches `ios/`, `shared/`, `.github/` or `ci/` uploads a fresh one, or
  dispatch the iOS lane by hand.
