# Delivery — how builds reach the phones, and how to run your own lane

`.github/workflows/deliver.yml` runs on every push to `main` and delivers what the push touched: `ci/plan.sh` compares the
changed paths and schedules a Play internal-testing release for `android/`, a TestFlight build for `ios/`, a Worker
deployment for `relay/` (the push relay, `relay/README.md`), the two app lanes for `shared/` (its non-Markdown files:
protocol fixtures, design assets), all three for the pipeline itself (`.github/workflows/deliver.yml`, the `ci/` scripts),
and nothing for what is in no build: documentation, repository paperwork (licence, templates, CODEOWNERS,
Dependabot), the bridge (`bridge/` reaches hosts as a release: `release.yml` when a version bump merges, `install.sh`,
`remotly-bridge update`), the release path itself (`install.sh`, `release.yml`, `bridge/scripts/package.sh`), and the pull-request
workflow and the tests (`ci/test/`, `bridge/test/`, `relay/test/`, `ios/FlowKit/Tests/`, `android/*/src/test/`). Inside the apps' own trees (`android/*/src/main/`, `ios/Remotly/`, `ios/Shared/`,
`ios/FlowActivity/`, `ios/FlowKit/Sources/`) every file delivers, whatever its name. Each lane is diffed from the
commit it last delivered, not from the push's parent: a lane's last step (`ci/mark-delivered.sh record`) moves its
marker `refs/delivered/<lane>` on the repository to the commit whose bundle, build or Worker just reached Play,
TestFlight or Cloudflare (`git ls-remote origin 'refs/delivered/*'` shows all three). A lane forgets its marker right
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
push delivers it. The relay lane has no such constraint: a deploy is repeatable, and the lane ends by asking the deployed
Worker's `/health` for `ok`, `apns` and `fcm`. Every run waits its turn (`concurrency.queue: max`, up to
GitHub's 100 waiting runs; the next accepted push delivers everything pending), so a manual dispatch never displaces a
waiting push. `ci/test/plan.test.sh`, `ci/test/lane-guard.test.sh` and `ci/test/mark-delivered.test.sh` pin that;
`gh workflow run deliver.yml -f ios=true …` forces a lane. It runs only in the upstream repository (a
job-level guard checks `github.repository`), on GitHub-hosted runners, with the store and Cloudflare credentials in the repository's
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
does not know delivers everything. Build number and `versionCode` are the run number; the relay has no build number
(`/health` reports the version constant in `relay/src/relay.ts`).

| Job | Runner | Steps |
|---|---|---|
| `plan` | `ubuntu-latest` | `ci/plan.sh` |
| `bridge-test` | `ubuntu-latest` | `npm ci`, `tsc --noEmit`, `npm test`; gates the two app lanes (the apps speak the protocol the bridge tests pin), not the relay |
| `android` | `ubuntu-latest` (JDK 17 from `setup-java`, the image's Android SDK) | the upload key and `google-services.json` written from the secrets into the runner's temp dir, `:core:test :app:lintRelease :app:bundleRelease` signed with the upload key, then `r0adkll/upload-google-play` to track `internal` |
| `ios` | `macos-26` (Xcode 26; `brew install xcodegen`) | `swift test` in `ios/FlowKit`, then `ios/scripts/testflight.sh`: from the App Store Connect API key alone, the archive signed with an Apple Development certificate Xcode creates for the runner, the export signed with the team's cloud-managed distribution certificate and uploaded (`destination=upload`); nothing is imported into a keychain |
| `relay` | `ubuntu-latest` | in `relay/`: `npm ci`, `npm run typecheck`, `npm test`, then `npm run deploy` (`wrangler deploy` with the Cloudflare API token and account id), then `GET /health` on `REMOTLY_RELAY_HOST` until it answers with `ok`, `apns` and `fcm` all true (up to two minutes; `ok` alone would pass a Worker without its secrets) |

## Promotion

`.github/workflows/promote.yml` (`workflow_dispatch` only) takes builds the lanes put on Play internal testing and
TestFlight to production; nothing is built or uploaded by it, and it runs only in the upstream repository, from `main`.
A first job checks the inputs (a platform's build missing, an input for a platform whose action is off, `ios_submit`
without a well-formed `ios_version`, `notes` over a store's limit, or nothing to do at all fails the run) — everything
the scripts would refuse on sight, checked before either store is touched, because the two platforms are independent
jobs and what one store refuses at run time does not undo the other (run the refused platform again on its own).
Dispatches queue with the deliveries and run one at a time.

- **`play_build`, `ios_build`**: the build the action is for, as its delivery's build number — the Play version code
  and the TestFlight build number are that number (the delivery run's summary and the stores show it; one number for
  both when a delivery ran both lanes, different ones when a change touched one app only, since the lanes deliver
  independently). Required with the platform's action, never "the newest": a dispatch queues behind the deliveries,
  and by the time it runs a later merge may have uploaded a newer build; a promotion takes the build that was tested.
- **Play** (`store/play-promote.mjs`): `play_rollout` = the share of users (5, 10, 25, 50 or 100 %) `play_build` is
  rolled out to on the production track, in one edit of the Android Publisher API (insert, read the tracks, write
  production, validate, commit). Below 100 the release is `inProgress` with that `userFraction` beside the completed
  release, which stays as Play's fallback; a later run with a higher share, or 100 (`completed`), raises the same
  release in place (its retained version codes, notes, country targeting and update priority kept; new `notes` replace
  the old), and
  completing it supersedes the previous completed release (Play allows one); a run with a newer code replaces a
  staged or halted rollout. Refused: a code at or below production's completed release, a code below a rollout under
  way (a rollout is raised by its newest code and replaced only by a newer build), lowering a rollout, a halted
  release (both are Play Console matters), and `notes` over Play's 500 characters. The commit fails rather than
  cancel changes the console has in review. Two Play facts to know: a commit is sent for review together with every
  change waiting in the Play Console's Publishing overview (as the console's own button sends them all, and as every
  `deliver.yml` upload does) — the log says so each time, so keep that page empty or expect its changes to go too;
  and a new edit by the service account invalidates the edit a delivery has open, so `promote.yml` queues in
  `deliver.yml`'s concurrency group and never runs beside an upload. Play's rule: the API can only write production
  once a production release was made through the console (done for 0.1.0).
- **iOS** (`store/asc-submit.mjs`): `ios_submit` with `ios_version` (the App Store version string) attaches TestFlight
  build `ios_build` — processed, and of that marketing version (`MARKETING_VERSION` in `ios/project.yml`, so bump it
  before the lane uploads the build to submit; a build of another version is refused) — to that version (reused when
  it exists and is still editable, created otherwise), sets `ios_release` (release when approved, or
  manual), puts `notes` into What's New of the primary locale, and submits one review submission with the version.
  Apple requires What's New on an update (every version after the first that passed review): `notes`, or the What's
  New the reused version already has, else the run refuses before changing anything; the app's first version has no
  What's New (given `notes` are noted in the log and skipped). A version string that is past editing, or any version
  waiting for or in review, is refused: Apple takes one submission at a time; so is a new version while the current
  one is approved but not out yet (release it in App Store Connect first). The review submission is exactly the one
  for the version: the open one holding it (a rejected item is marked resolved, Apple's step before a resubmission),
  an empty open one, or a new one; an open submission holding anything else (an in-app event, a product page) is
  left alone and named — and, like every other check, before the run changes anything, so a dry run reports it too;
  the items are read once more right before the submission goes (a submission goes whole), and anything added to it
  meanwhile stops the run. A version an earlier run left `READY_FOR_REVIEW` (in a submission that was never sent) is
  submitted as it stands — with the build it has, its release type (which must be this run's `ios_release`; refused
  otherwise) and, when its What's New is missing, the `notes` of this run.
- `notes` is What's New on both platforms; `dry_run` stops after the checks and changes nothing — the log shows what
  a real run would do.
  `gh workflow run promote.yml -f play_rollout=10 -f play_build=37 -f ios_submit=true -f ios_version=0.1.1 -f ios_build=37 -f notes='…'`.
- Tests: `store/test/*.test.mjs` against a fake API (run by `ci.yml`). The two scripts have no dependencies; both
  sign their own API tokens (Google RS256 from the service account, Apple ES256 from the App Store Connect key).

## Secrets

The credentials are the repository's Actions secrets (Settings → Secrets and variables → Actions), read by `deliver.yml`
and `promote.yml` only; `ci.yml`, which pull requests run, has none. `gh secret set NAME --repo <owner>/remotly < file` creates one without
echoing it. The jobs write the files into the runner's temp directory and pass paths or values to Gradle and xcodebuild
through the environment; a lane whose secret is missing fails at that step with the secret's name.

| Secret | Content |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | the Play upload keystore, `base64 -w0 upload.jks` |
| `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | its store password, key alias and key password (Gradle reads them as `REMOTLY_STORE_PASSWORD`, `REMOTLY_KEY_ALIAS`, `REMOTLY_KEY_PASSWORD`; `android/app/build.gradle.kts`) |
| `ANDROID_GOOGLE_SERVICES_JSON` | the Firebase `google-services.json` of the Android app |
| `PLAY_SERVICE_ACCOUNT_JSON` | a Google service account key (JSON) with release rights on the Play app (the lane's upload and `promote.yml`) |
| `ASC_API_KEY_P8` | the App Store Connect API key (`AuthKey_<id>.p8`): a team key with the Admin role, or App Manager with "Access to Cloud Managed Distribution Certificate" — cloud-managed signing needs that permission; `promote.yml` submits to review with it |
| `CLOUDFLARE_API_TOKEN` | a Cloudflare API token that can deploy the relay's Worker: My Profile → API Tokens → Create Token → the "Edit Cloudflare Workers" template, Account Resources limited to the account that owns the Worker, Zone Resources to the relay's zone (`remotly.dev`; the custom domain of `relay/wrangler.jsonc` lives there). The Worker's own secrets (APNs key, Firebase service account) are set once with `wrangler secret put` and are not touched by a deploy |

Three repository variables go with them (Settings → Secrets and variables → Actions → Variables): `ASC_KEY_ID` and
`ASC_ISSUER_ID`, the App Store Connect API key id and issuer id; `CLOUDFLARE_ACCOUNT_ID`, the Cloudflare account id
(Workers & Pages → the sidebar; `npx wrangler whoami` prints it too).

## Running your own lane

1. **Records.** App Store Connect: an app for your bundle id, TestFlight internal group. Play Console: an app for your
   package name; the first release of a new app must be uploaded through the console UI, the API works from the second
   (`play_status: draft` in `workflow_dispatch` for a brand-new app that has never been rolled out). Firebase: a project
   with an Android app for your package name (`google-services.json`) and, for push, a service account; Apple: an APNs
   auth key for your team. If your hosts should send push without credentials, run your own relay (`relay/README.md`): a
   Cloudflare account with the zone of its host name, the Worker's secrets set once by hand, then the `relay` lane deploys it.
2. **Identifiers to change in the tree.** Android `applicationId`/namespace (`android/app/build.gradle.kts`,
   `deliver.yml` `REMOTLY_PACKAGE`, `bridge/scripts/firebase-android-app.ts`, the Kotlin package directories); iOS
   bundle ids (`ios/project.yml`, `HostStore.swift`, `AppInfo.swift`); Apple team id (`ios/project.yml`
   `DEVELOPMENT_TEAM`, `ios/ExportOptions-testflight.plist`, `APPLE_TEAM_ID` in `ios/scripts/testflight.sh`); the
   relay's name, route and vars (`relay/wrangler.jsonc`), its host in `deliver.yml` (`REMOTLY_RELAY_HOST`) and the
   bridge's default for it (`DEFAULT_RELAY_URL` in `bridge/src/config.ts`, `bridge/test/config/config.test.ts`,
   `bridge/README.md` `push.relay_url`; a bridge already installed keeps sending to the upstream relay until its
   `push.relay_url` is set); the repository name in the guard of `deliver.yml`.
3. **Secrets and variables** as in "Secrets" above, in your repository's settings.
4. **Workflow hygiene.** The secrets are only as safe as the workflows that can read them: keep `deliver.yml` on `push`
   to `main` and `workflow_dispatch` only, never on `pull_request`; require approval for outside collaborators'
   workflows; restrict allowed actions and require SHA pinning (Settings → Actions → General); protect `main` (a
   ruleset that requires pull requests).

## Operations

- `gh run list --workflow deliver.yml` shows runs; `gh workflow run deliver.yml -f android=true -f ios=false -f relay=false`
  re-delivers one lane (every checkbox defaults to on). Production is `promote.yml` ("Promotion" above); try
  `-f dry_run=true` first.
- Triage: a lane failing with "the repository secret behind … is not set" → that secret is missing or empty; Android
  upload 403 → the service account lacks Play access or the Google Play Android Developer API is off in its project;
  iOS provisioning errors → the API key, `ASC_KEY_ID` and `ASC_ISSUER_ID` do not belong together, the key's role lacks
  cloud-managed distribution ("Secrets"), or the App ID lacks a capability (`ios/NOTES.md`, "Signing"); a message about
  an Apple Development certificate for "this machine" or a certificate limit → each hosted run creates one, revoke the
  stale ones under Certificates in the developer portal; `wrangler deploy` refused (authentication, "unable to select an
  account") → `CLOUDFLARE_API_TOKEN` is missing, expired or not scoped to the account `CLOUDFLARE_ACCOUNT_ID` names, or that
  variable is unset; a custom-domain error → the token lacks the relay's zone; "did not answer with ok, apns and fcm all
  true" after a deploy → the Worker is up but a platform's secrets are unusable (`relay/README.md` "Deploy") or it is
  failing, read its logs (Workers & Pages → remotly-relay → Logs, or `npx wrangler tail` in `relay/`).
- Apple Developer membership renews yearly; if it lapses, TestFlight installs and APNs pushes stop. TestFlight builds
  expire after 90 days: a push to `main` that `ci/plan.sh` classifies for iOS (see above: `ios/` or `shared/` code, `deliver.yml`, a `ci/` script) uploads a fresh one, or
  dispatch the iOS lane by hand.
