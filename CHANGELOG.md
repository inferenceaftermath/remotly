# Changelog

Bridge releases are GitHub Releases tagged `bridge-vX.Y.Z`, made when a bump of `bridge/package.json` reaches `main`
(`release.yml`; the notes are this file's `### Bridge X.Y.Z` section), which is what `install.sh` installs. The apps
ship through TestFlight and Play internal testing from pushes to `main` that touch them (`ci/plan.sh` picks the lanes;
`docs/DELIVERY.md`).

## Unreleased

### Phone apps — local demo

- Android, iPhone and iPad can explore sample terminal sessions without a bridge or Tailscale: **Try demo** on
  pairing or Settings, a persistent sample-data banner, and **Exit demo** to return to the saved host.
- Approvals, questions, input, scrollback and sample terminal creation/closing use the real app controls with local
  simulated responses. Commands never execute; photos and notifications require a real host. See `docs/DEMO.md`
  for store-review access and verification.
- iOS includes the required-reason privacy manifest for its own saved preferences (`UserDefaults`, `CA92.1`).
- Entering demo cancels pending real-host notification actions before they can send, including a delayed connection.

### Android — build toolchain

- Gradle 9.7.1, Android Gradle Plugin 9.4.0 (its built-in Kotlin replaces the `kotlin-android` plugin; `:core` keeps the
  Kotlin Gradle plugin, which sets Kotlin 2.4.20 for the whole build), JUnit 6.1.3, Firebase Messaging 25.1.3 and the
  current androidx.core, coroutines, serialization, Google Services and ZXing releases. Nothing changes for users; the
  FCM registration token that Firebase now deprecates stays in use until the installation-id move (`docs/BACKLOG.md`).

### Delivery

- Store builds come from GitHub-hosted runners (`ubuntu-latest`, `macos-26`) with the credentials in the
  repository's Actions secrets (`docs/DELIVERY.md`, "Secrets"); the two self-hosted runners and their installers
  (`ci/setup-*-runner.sh`, `ci/android-env.sh`) are retired.
- Pull requests compile the iOS app on the lane's Xcode (26.6, signing disabled) besides the FlowKit tests: the first
  hosted iOS delivery failed on a Swift concurrency diagnostic the Mac's Xcode 26.3 had not raised (`AppModel`
  ending Live Activities from a task).
- `promote.yml` takes the builds to production by hand (`workflow_dispatch`): Play internal testing → production as
  a staged rollout (`store/play-promote.mjs`, the Android Publisher API in one edit), and the newest TestFlight build
  → an App Store version submitted to review with What's New (`store/asc-submit.mjs`, the App Store Connect API);
  both scripts have a dry run and tests against a fake API (`docs/DELIVERY.md`, "Promotion").
- The push relay is a third lane of `deliver.yml`: a push to `main` that changes `relay/` runs its typecheck and
  tests, `wrangler deploy` with the `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable, and asks the
  deployed `/health` for `ok`, `apns` and `fcm` (marker `refs/delivered/relay`); the Worker's four secrets are
  declared `secrets.required` in `relay/wrangler.jsonc`, so a deploy fails when one is missing instead of the relay
  answering 503 `not_configured`. `npm run deploy` by hand remains (`relay/README.md`).
- Bridge releases on merge: `release.yml` runs on every push to `main` (and on `gh workflow run release.yml`) and
  releases when `bridge/package.json` names a version without a GitHub Release, from the commit that introduced the
  version — it creates the tag there itself, so nothing is tagged by hand any more, and a merge whose message skips CI
  is released by the next run. A version released after a higher one is not marked latest.
  `bridge/scripts/release-prep.sh X.Y.Z` prepares the bump pull request and checks the notes under `### Bridge X.Y.Z`
  here, which become the release notes.

### Bridge 0.2.0

- `remotly-bridge update` and a daily `remotly-bridge-update.timer` (installed by `setup`; `--no-auto-update` or
  `systemctl --user disable --now` turns it off): the host installs each new release by itself — nothing when current,
  otherwise that release's installer with the first install's settings (mirror, launcher directory, runtime); done
  when the new daemon has answered steadily, otherwise a best-effort rollback: the previous copy goes back when it can
  be verified as the one that ran before, else the output prints the by-hand line with this install's settings. One
  run at a time; a run stopped half-way is finished by the next; a stopped bridge is left stopped (`setup
  --keep-stopped`, which the update passes), a failed one (crash loop) is updated; both units repair a missing `app/`
  (or `node/`) before they start. `status` shows the daemon's version.
- The bridge is no longer delivered from `main`: the reference host installs releases like every other host (the
  installer over its repository deploy once, then the timer), and the CI lane that rsynced the checkout onto it is gone
  with its scripts. A `bridge-vX.Y.Z` tag releases (`release.yml`); a push touching only `bridge/` delivers nothing.

### Bridge 0.1.0 — first public release

- `remotly-bridge setup` and `curl -fsSL https://remotly.dev/install.sh | sh`: one command installs the bridge (with a
  private Node 24 when the host has none), checks herdr and Tailscale and waits while you fix what is missing, requests
  the Tailscale certificate, installs the systemd user unit with linger, waits for health and prints one pairing QR for
  all your phones. Re-running the same line upgrades. `--lan` for a host without Tailscale (Android phones only).
- Push relay at `relay.remotly.dev` (Cloudflare Worker): hosts no longer need an APNs key or a Firebase service account.
- Prepared for publication: Apache-2.0 licence, documentation values instead of the author's identifiers, fixtures from
  the author's own sessions removed, community files, pull-request checks on GitHub-hosted runners.
- Hardening before the first public build: `push.include_excerpt: false` now keeps every piece of pane text out of
  notifications (session titles and approval summaries included; the host name stands in); at boot the bridge waits for
  Tailscale when it is installed but not up, then exits for systemd to retry, instead of starting on every interface with
  the tailnet gate off; ceilings on open WebSockets per peer and in total, a per-minute pairing budget for the whole
  bridge, and request timeouts; `info` logs no longer carry error-reply text, tab labels or per-connection TLS handshakes;
  a message whose type names an `Object.prototype` member (`{"t":"constructor"}`) is `unsupported` instead of a crash.

### Before the changelog (2026-09-01 → 2026-09-16, internal builds)

herdr link and pane watcher; terminal pipeline with golden frames shared by the three code bases; TLS with a Tailscale
certificate or a pinned self-signed one; pairing behind the tailnet gate; approvals verified against dialog signatures;
push (APNs and FCM, "finished" alerts with reply, Live Activity / ongoing notification); photo uploads; scrollback
modes and fit-to-phone; both apps on the shared design system; delivery to TestFlight and Play on push.
