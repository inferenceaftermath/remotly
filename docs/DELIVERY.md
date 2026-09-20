# Delivery — how builds reach the phones, and how to run your own lane

`.github/workflows/deliver.yml` runs on every push to `main` and delivers what the push touched: `ci/plan.sh` compares the
changed paths and schedules a Play internal-testing release for `android/`, a TestFlight build for `ios/`, both for
`shared/` (its non-Markdown files: protocol fixtures, design assets) and for the pipeline itself (`.github/workflows/deliver.yml`,
the `ci/` scripts), and nothing for what is in no build: documentation, repository paperwork (licence, templates, CODEOWNERS,
Dependabot), the bridge (`bridge/` reaches hosts as a release: `release.yml` on a `bridge-vX.Y.Z` tag, `install.sh`,
`remotly-bridge update`), the release path itself (`install.sh`, `release.yml`, `bridge/scripts/package.sh`), the pull-request
workflow and the tests (`ci/test/`, `bridge/test/`, `ios/FlowKit/Tests/`, `android/*/src/test/`) and the relay (deployed by hand). Inside the apps' own trees (`android/*/src/main/`, `ios/Remotly/`, `ios/Shared/`,
`ios/FlowActivity/`, `ios/FlowKit/Sources/`) every file delivers, whatever its name. Each lane is diffed from the
commit it last delivered, not from the push's parent: a lane's last step (`ci/mark-delivered.sh record`) moves its
marker `refs/delivered/<lane>` on the repository to the commit whose bundle or build just reached Play or
TestFlight (`git ls-remote origin 'refs/delivered/*'` shows both). A lane forgets its marker right
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
job-level guard checks `github.repository`), on GitHub-hosted runners, with the store credentials in the repository's
Actions secrets; pull requests are checked by `ci.yml`, which has no secrets. A fork that wants its own lane needs its own
records, secrets and identifiers, listed here.

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
| `plan` | `ubuntu-latest` | `ci/plan.sh` |
| `bridge-test` | `ubuntu-latest` | `npm ci`, `tsc --noEmit`, `npm test`; gates both deliveries (the apps speak the protocol the bridge tests pin) |
| `android` | `ubuntu-latest` (JDK 17 from `setup-java`, the image's Android SDK) | the upload key and `google-services.json` written from the secrets into the runner's temp dir, `:core:test :app:lintRelease :app:bundleRelease` signed with the upload key, then `r0adkll/upload-google-play` to track `internal` |
| `ios` | `macos-26` (Xcode 26; `brew install xcodegen`) | `swift test` in `ios/FlowKit`, then `ios/scripts/testflight.sh`: from the App Store Connect API key alone, the archive signed with an Apple Development certificate Xcode creates for the runner, the export signed with the team's cloud-managed distribution certificate and uploaded (`destination=upload`); nothing is imported into a keychain |

## Secrets

The credentials are the repository's Actions secrets (Settings → Secrets and variables → Actions), read by `deliver.yml`
only; `ci.yml`, which pull requests run, has none. `gh secret set NAME --repo <owner>/remotly < file` creates one without
echoing it. The jobs write the files into the runner's temp directory and pass paths or values to Gradle and xcodebuild
through the environment; a lane whose secret is missing fails at that step with the secret's name.

| Secret | Content |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | the Play upload keystore, `base64 -w0 upload.jks` |
| `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | its store password, key alias and key password (Gradle reads them as `REMOTLY_STORE_PASSWORD`, `REMOTLY_KEY_ALIAS`, `REMOTLY_KEY_PASSWORD`; `android/app/build.gradle.kts`) |
| `ANDROID_GOOGLE_SERVICES_JSON` | the Firebase `google-services.json` of the Android app |
| `PLAY_SERVICE_ACCOUNT_JSON` | a Google service account key (JSON) with release rights on the Play app |
| `ASC_API_KEY_P8` | the App Store Connect API key (`AuthKey_<id>.p8`): a team key with the Admin role, or App Manager with "Access to Cloud Managed Distribution Certificate" — cloud-managed signing needs that permission |

Two repository variables go with them (Settings → Secrets and variables → Actions → Variables): `ASC_KEY_ID` and
`ASC_ISSUER_ID`, the App Store Connect API key id and issuer id.

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
   repository name in the guard of `deliver.yml`.
3. **Secrets and variables** as in "Secrets" above, in your repository's settings.
4. **Workflow hygiene.** The secrets are only as safe as the workflows that can read them: keep `deliver.yml` on `push`
   to `main` and `workflow_dispatch` only, never on `pull_request`; require approval for outside collaborators'
   workflows; restrict allowed actions and require SHA pinning (Settings → Actions → General); protect `main` (a
   ruleset that requires pull requests).

## Operations

- `gh run list --workflow deliver.yml` shows runs; `gh workflow run deliver.yml -f android=true -f ios=false`
  re-delivers one lane.
- Triage: a lane failing with "the repository secret behind … is not set" → that secret is missing or empty; Android
  upload 403 → the service account lacks Play access or the Google Play Android Developer API is off in its project;
  iOS provisioning errors → the API key, `ASC_KEY_ID` and `ASC_ISSUER_ID` do not belong together, the key's role lacks
  cloud-managed distribution ("Secrets"), or the App ID lacks a capability (`ios/NOTES.md`, "Signing"); a message about
  an Apple Development certificate for "this machine" or a certificate limit → each hosted run creates one, revoke the
  stale ones under Certificates in the developer portal.
- Apple Developer membership renews yearly; if it lapses, TestFlight installs and APNs pushes stop. TestFlight builds
  expire after 90 days: a push to `main` that `ci/plan.sh` classifies for iOS (see above: `ios/` or `shared/` code, `deliver.yml`, a `ci/` script) uploads a fresh one, or
  dispatch the iOS lane by hand.
