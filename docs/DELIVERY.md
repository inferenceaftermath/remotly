# Delivery — how builds reach the phones, and how to run your own lane

`.github/workflows/deliver.yml` runs on every push to `main` and delivers what the push touched: `ci/plan.sh` compares the
changed paths and schedules a Play internal-testing release for `android/`, a TestFlight build for `ios/`, a redeploy of
the bridge on the herdr host for `bridge/`, all three for `shared/` (its non-Markdown files: protocol fixtures, design assets) and for the pipeline itself (`.github/workflows/deliver.yml`,
the `ci/` scripts), and nothing for what is in no build and not run by the host (the bridge deploy copies the whole
checkout, but these are never executed there): documentation, repository paperwork (licence, templates, CODEOWNERS,
Dependabot), the release path (`install.sh`, `release.yml`, `bridge/scripts/package.sh`), the pull-request workflow and
the tests (`ci/test/`, `bridge/test/`, `ios/FlowKit/Tests/`, `android/*/src/test/`), the runner installers `ci/setup-*`
and the relay (deployed by hand). Inside the apps' own trees (`android/*/src/main/`, `ios/Remotly/`, `ios/Shared/`,
`ios/FlowActivity/`, `ios/FlowKit/Sources/`) every file delivers, whatever its name. Each lane is diffed from the
commit it last delivered, not from the push's parent: a lane's last step (`ci/mark-delivered.sh record`) moves its
marker `refs/delivered/<lane>` on the repository to the commit whose bundle, build or code just reached Play,
TestFlight or the host (`git ls-remote origin 'refs/delivered/*'` shows the three). A lane forgets its marker right
before its work (`ci/mark-delivered.sh forget`): a lane that fails before that keeps its old marker and the next push
retries its changes from there; one that fails after it — a test, the upload, the marker push itself — leaves none,
and the next push delivers that lane in full (a stale marker would let a later revert look like "nothing changed").
Only main's tip delivers: a run started behind a newer push (queued runs are not ordered), a rerun of an old run's
lane, a dispatch from another branch — `ci/lane-guard.sh`, the first step of every lane, finds that its commit is no
longer the tip and the lane's other steps are skipped; the tip's run delivers whatever the lanes still need, and a
dispatch overtaken this way forgets the lane it asked for, so that run delivers it in full. A marker outside the current history (main rewritten) makes that lane
deliver everything; an origin that cannot be read fails the plan rather than guess. Two things the workflow cannot
guard against, since GitHub runs the workflow file of the ref a run belongs to: a dispatch given another ref (`gh
workflow run --ref`) runs that ref's own deliver.yml — dispatch from `main` only — and re-running a run from before
these markers existed replays its old workflow; push instead. A lane whose upload succeeded but whose marker push
failed is not re-run either (Play and TestFlight refuse the same build number twice): the marker is gone, so the next
push delivers it. Every run waits its turn (`concurrency.queue: max`, up to
GitHub's 100 waiting runs; the next accepted push delivers everything pending), so a manual dispatch never displaces a
waiting push. `ci/test/plan.test.sh`, `ci/test/lane-guard.test.sh` and `ci/test/mark-delivered.test.sh` pin that;
`gh workflow run deliver.yml -f ios=true …` forces a lane. It runs only in the upstream repository (a
job-level guard checks `github.repository`) and only on two self-hosted runners labelled `remotly`; pull requests are
checked by `ci.yml` on GitHub-hosted runners instead. A fork that wants its own lane needs its own records, runners and identifiers, listed here.

## Channels

| Platform | Channel | How a tester gets builds |
|---|---|---|
| iOS | TestFlight internal testing | App Store Connect users added to the app's internal group; every processed upload appears in the TestFlight app. No Beta App Review. Builds expire 90 days after upload. |
| Android | Play Console internal testing track | Testers by e-mail; each phone opens the opt-in link once, then Play updates the app like any other. Internal testing needs no store listing, content rating or review; releases do not expire. |

TestFlight builds carry `aps-environment = production`; the app reads it from its provisioning profile and registers
push tokens with `env: production`, Xcode debug installs with `sandbox`. The bridge routes each token by its `env`.
FCM has a single environment.

## What the workflow does

`ci/plan.sh` decides from the changed paths (`workflow_dispatch` has one checkbox per lane), as listed above; a path it
does not know delivers everything. Build number and `versionCode` are the run number.

| Job | Runner | Steps |
|---|---|---|
| `bridge-test` | Linux | `npm ci`, `tsc --noEmit`, `npm test`; gates every delivery |
| `android` | Linux | `:core:test :app:lintRelease :app:bundleRelease` signed with the upload key, then `r0adkll/upload-google-play` to track `internal` |
| `ios` | Mac | `swift test` in `ios/FlowKit`, then `ios/scripts/testflight.sh` (archive with cloud-managed signing, export with `destination=upload`) |
| `bridge-deploy` | Linux | `ci/deploy-bridge.sh`: rsync the workspace to `~/.local/share/remotly/app`, `npm ci --omit=dev`, re-render and restart the user unit through `setup --no-pair --no-wait --keep-mode` (the host's LAN or Tailscale mode stays as configured), check `status`, roll back on failure |

Secrets never enter GitHub. Each runner reads them from `~/.config/remotly` on its own machine; the only values in
GitHub are two repository variables (Settings → Secrets and variables → Actions → Variables): `ASC_KEY_ID` and
`ASC_ISSUER_ID`, the App Store Connect API key id and issuer id (the `.p8` stays on the Mac). Log output masks the
runners' home directories (`::add-mask::`). On the bridge lane everything the bridge's own tooling prints (`setup`,
`status`, on failure the unit's journal) goes to `$XDG_STATE_HOME/remotly/deploy.log` on the host (default
`~/.local/state/remotly/deploy.log`, one deploy at a time), never into the public log: masks cover today's identity, a
journal can hold yesterday's. As a second layer `ci/mask-host.sh` masks the host's current Tailscale name and addresses
and fails the deploy when Tailscale is present but its identity cannot be read completely. The machine name in each
job's banner is printed before any step can mask it, so give runner machines a neutral hostname.

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
  rolls back to the previous deploy; setup's output and the unit's journal are in `~/.local/state/remotly/deploy.log`
  on the host (never in the public log).
- Re-registering a runner: delete it in GitHub → Settings → Actions → Runners, remove the `.runner` file, rerun the setup script.
- Apple Developer membership renews yearly; if it lapses, TestFlight installs and APNs pushes stop. TestFlight builds
  expire after 90 days: a push to `main` that `ci/plan.sh` classifies for iOS (see above: `ios/` or `shared/` code, `deliver.yml`, a `ci/` script) uploads a fresh one, or
  dispatch the iOS lane by hand.
