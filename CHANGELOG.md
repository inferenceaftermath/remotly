# Changelog

Bridge releases are GitHub Releases tagged `bridge-vX.Y.Z`, made when a bump of `bridge/package.json` reaches `main`
(`release.yml`; the notes are this file's `### Bridge X.Y.Z` section), which is what `install.sh` installs. The apps
go to TestFlight and Play internal testing from pushes to `main` that touch them (`ci/plan.sh` picks the lanes) and from
there to the App Store and Google Play by hand (`promote.yml`; `docs/DELIVERY.md`).

## Unreleased

### Bridge 0.5.0 — herdr as a service

- `setup` (what the install command and every update run) installs a user service for herdr beside the bridge's:
  `remotly-bridge-herdr.service` on Linux, the agent `dev.remotly.remotly-bridge-herdr` on macOS — `herdr server` (behind
  `env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=~/.config`, so the manager's environment cannot move it to another session or directory) for the
  session the bridge follows, with the `herdr` found on PATH or in the usual places (`~/.local/bin`, …) — so a host reboot (on a Mac, the login after it) brings
  herdr back, with its saved workspaces and panes (and the agents in them when herdr's `resume_agents_on_restore` says
  so), without anyone opening a terminal. Before, the bridge came back after a reboot but herdr did not, and the phones
  showed `herdr: down` until someone ran `herdr`. Started at once when herdr is not running (setup waits for it before
  the herdr check); a herdr started from a terminal keeps running — the unit is never restarted over it, since that
  ends every pane — and the service takes over at the next boot or login. Enabled on its first install, afterwards left
  as you have it (`disabled` or masked stays so, and a unit setup did not write — `linked`, `static`, a file of another shape or changed since setup wrote it, one with a drop-in of its own, on a Mac a label another plist declares — is not touched);
  `--no-herdr-service` writes it disabled. A service that cannot be installed is a warning, not a failed setup. A new bridge is not
  given a `--unit` ending in `-herdr` or `-update` — the names setup derives for a bridge's herdr service and updater
  (bridge `alpha-herdr` and bridge `alpha`'s herdr unit would be one file) — and a unit of setup's of either kind is never
  written over as a bridge, nor a file under such a name that is not a bridge unit setup can tell; a bridge installed under such
  a name before keeps working. Two bridges following one session share one herdr service (the first bridge's); a second installs
  none while it exists, and `doctor` names it. `doctor` says when the `herdr` the service's file starts is not there any more. Every stop line printed is pane-proof (the unit's own prefix, and the `herdr` the unit runs, by its path: `env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=~/.config /path/to/herdr [--session NAME] server stop`), a restart printed while the wanted session runs outside the unit stops that herdr first, and on a Mac the restart printed after a rewrite is bootout + bootstrap (the one that loads the new plist). A second herdr service for one session is told to be disabled from the next boot, nothing stopped now. `doctor` follows config.json's herdr selection over a pane's environment, as `serve` does, and names the unit running the herdr that answers only once herdr has answered. Turning a disabled herdr unit on beside another bridge's gets a hand-over line (theirs off, ours on) rather than a second provider; a unit the manager loaded from no file (`systemd-run`, `launchctl submit`) is not setup's; launchd hint paths are shell-quoted; a first install on systemd interrupted before `enable` is finished by the next setup (a `.pending` file beside the unit says so) — unless another bridge's service took the session meanwhile: then the unit stays disabled, with the hand-over line. setup and `doctor` report two (or more) enabled herdr services for one session (setup's own among them) with the line that keeps one, and every start or restart of setup's own unit they print beside the others turns each of them off first (their `Restart=always` would bring their herdr back against ours); for a disabled unit of setup's beside one, that line is the full hand-over (theirs off, ours enabled and restarted), and `doctor`'s line for turning on a disabled unit while herdr runs outside it stops that herdr first. Another bridge's unit that runs the session without being its provider (disabled without `--now`) is stopped through the manager in those lines, and so is a unit of the user's own found running the herdr that answers, when the manager would bring herdr back (`Restart=` other than `no`; launchd's KeepAlive taken as yes) or may start it at boot (Linux reads the socket's listener from `/proc/net/unix` and its unit — `herdr.service`, a `systemd-run` one, a desktop app's under KDE — from the process's cgroup, a terminal under GNOME being a scope; macOS asks `lsof -U`, picks the herdr executable among several processes on the socket and the server among several herdrs — or none, when they cannot be told apart — and `launchctl list` for the job the process or an ancestor is the main process of, a GUI app's `application.…` label being a terminal's) — a `herdr server stop` alone would have either's `Restart=` bring it back, and the lines say the unit is stopped as a whole; only a unit that neither restarts herdr nor may start it at boot, and has herdr for its main process (a plain `systemd-run`) or is a desktop app's transient `app-…` unit whose main process is a terminal emulator (konsole's under KDE), is a terminal's kind — a wrapper that may start herdr again is stopped as a unit however `Restart=` reads and whatever its name; two listeners under one socket path (an old socket keeping its address) and nothing is claimed; such a unit is reported as a second starter at boot with the line that keeps one (naming the setup-owned units that start the session: this bridge's, another bridge's provider, or both) when it is enabled, and as a possible one when whether it starts at boot is its own arrangement (`static`, pulled in or triggered by a unit of the user's — a timer, a socket — started when another of theirs fails, an agent's `RunAtLoad`) — in neither case is setup's unit said to take over at boot; only one that does not start at boot (`disabled`, `enabled-runtime`, `transient`, with nothing of the user's starting it) is stopped and taken over from; no line printed claims more than it does: what triggers or upholds such a unit (a timer, a socket; `TriggeredBy`, `UpheldBy`) is stopped with it — stopped alone, the timer would start it again — and named among what the line ends, a trigger's own triggers followed as far as they go, as is what the manager stops along with it or with a trigger of it (a unit that requires it — `Requires=`, `Requisite=` — or is bound to it, a part of it, what it propagates its stop to, "and whatever depends on those"; a masked unit that still runs included), and what the manager stops along with setup's own unit when it stops or restarts (a unit of the user's with `PartOf=` or `Requires=` on it) or when it starts (`Conflicts=`) is named in every line that starts, restarts or stops ours; what is enabled among them is disabled in the same line (`disable --now herdr.timer herdr.service`), what is not only stopped; the keep-one line disables only what is enabled, and when nothing is (a `static` unit; a disabled one a target of the user's wants, its own enablement link under `~/.config/systemd/user/<target>.wants/` told apart from a `Wants=` elsewhere and from a link under any other persistent load path (`/etc/systemd/user` from a global enablement, a vendor's `/usr/lib/systemd/user`), which a user-level `disable` leaves, beside a local link or alone; one started when a unit of theirs fails; a trigger of its own arrangement, or what pulls a trigger in) says so instead of printing a `disable` that would not hold; a masked unit starts nowhere; the same for another bridge's provider, and another bridge's unit for the session that is not enabled but a timer or target of the user's may start (on a Mac: whose label another plist declares too) is a possible starter at boot: turned off in the hand-over lines as far as a line can, said with a keep-one line of its own, and no take-over at boot is claimed beside it; names of the user's units are quoted for the shell. One setup at a time per session: a kernel lock (`flock`, held by a child process — `flock(1)` on Linux, perl's flock on a Mac and on a Linux without `flock(1)`, as the update lock — and let go by the kernel should setup die; no stale lock to judge or take over) on `~/.local/state/remotly/locks/herdr-<key>.lock` (under the home: one file for every setup of the user's, whatever its `TMPDIR`), waited for up to a minute, so two first installs at once do not both become the session's provider; without `flock`/`perl` setups go unserialised, said. A masked herdr unit name whose mask hides a unit file in another of the manager's load paths (`UnitPath`, read as `show` prints lists: a path with a space quoted) is reported as a unit setup did not write, without the unmask line that would expose it; a mask over nothing is the user's choice, with the unmask line, in `doctor` as in setup. The e2e names its unit and stand-in session per run and makes the session directory in one step. On a Mac, `--no-herdr-service` disables the label before the plist exists; on systemd an opt-out writes no `.pending` marker, so one cut short reads as the opt-out. A unit rewritten from one session to another says that a bridge which shared it for the old session has no service until its own setup runs again. The line that turns a disabled unit on restarts it when it is running another session (`enable --now` would leave it so; launchd's `bootstrap` fails on a loaded agent), and stops a herdr running outside the unit for the session first. `--no-herdr-service` beside another bridge's herdr service still writes this bridge's unit, disabled, so the choice lasts.
- `doctor` says whether herdr comes back after a reboot: the service is enabled — running, or waiting to take over at
  the next boot (login on a Mac) from a herdr running outside it, with the line that hands over now — or not: no service,
  a unit that is not enabled, one enabled but failing (soft failures; a service you disabled or masked is noted as your
  choice; a unit that runs another session than the bridge follows, or one under the service's name that setup did not
  write, is said so, not taken for the service). Its "start herdr" fixes name the service when there is one, in the
  form its state calls for.

### Phone apps — smooth scrolling

- iPhone: scrolling the terminal moves rows that are already drawn (in strips about a third of a screen tall, kept for
  what is on screen and a strip above and below it), where it used to draw every row on screen again at every step of
  the scroll; it keeps up with the display now, 120 Hz on ProMotion iPhones. Box drawing, arrows, Greek, Cyrillic and
  other characters the font draws exactly a cell wide are drawn a stretch at a time instead of one by one.
- Both apps: a fling keeps its speed when output arrives meanwhile. Lines added below the view, or dropped above it,
  used to stop the fling on the iPhone and pull it back on Android.

### Bridge 0.4.0 — scrollback in one piece

- The bridge keeps its own copy of every pane's scrollback, whether a phone is connected or not: twice a second it asks
  herdr (`pane.list`) which panes gained rows above the screen and folds the lines that left the screen into the copy —
  as logical lines, lined up with the ones it already has, so a resize or reflow adds nothing twice — up to
  `scrollback.max_lines` per pane (default 10 000; herdr itself hands out only the last 999 rows). A pane cleared with
  `clear` starts a new copy.
- New request `scrollback` (protocol §4/§6): a phone gets the whole copy when it opens a pane and then every new line as
  it scrolls off; after a reconnect, only what it missed. Over a slow link the lines go out as fast as it takes them,
  without holding up the live screen or a switch to another pane. `history` stays for older apps, and
  the apps below fall back to it against an older bridge.
- `setup` (what the install command runs) sets Claude Code to its classic renderer (`"tui": "default"` in
  `~/.claude/settings.json`) and Codex to stay out of the alternate screen (`[tui] alternate_screen = "never"` in
  `~/.codex/config.toml`) when they are installed, so their output lands in the scrollback too; it says what it changed,
  and that Claude Code sessions already running need `/exit` and `claude --resume`. `--no-agent-settings` skips it.
- Hosts installed before 0.4.0 get the same settings once, from the update that brings 0.4.0: Codex at once (it reads
  them when a session starts), Claude Code at once unless a session of it is running — a running session redraws badly
  when they change — in which case the bridge sets it as soon as none is (it looks every 15 minutes; `remotly-bridge
  setup` sets it now); an edit that fails is tried again the same way. After that the settings are the user's: later
  updates leave them alone, and a `setup --no-agent-settings` keeps them out of updates too
  (`<config dir>/agent-settings.json` records which). The service does not see a `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
  set in a shell: with those, run `remotly-bridge setup` from that shell.

### Phone apps — scrollback in one piece

- The apps show the history and the live screen as one continuous scroll, wrapped to the phone's width, with everything
  on the phone from the start: no loading at the top, no frozen copy, the live screen keeps updating while you read
  above it, and "Live ↓" brings you back. Against an older bridge they read one 999-line `history` instead.

### Bridge 0.3.0

- macOS hosts. `install.sh` installs on a Mac (Darwin Node tarballs from nodejs.org when there is no node ≥ 24; a
  Homebrew node is used by its link, which brew repoints on upgrade), and `setup` installs the bridge as a launchd user
  agent — `dev.remotly.<unit>` under `~/Library/LaunchAgents`, `KeepAlive` so it comes back after a crash, started at
  login, logging to `~/Library/Logs/remotly/` — with the daily update as the agent `dev.remotly.<unit>-update` (a minute
  past midnight chosen per install). launchd never settles a crash loop (`spawn scheduled` after an exit, forever):
  `setup` and `update` read that as `failed`, as a systemd unit past its start-rate limit, and restart it. `doctor`, `update`, every message and every fix line speak launchctl on a Mac and
  systemctl on Linux (`bridge/src/platform/service.ts`); the Tailscale fixes name the Tailscale app, which is the
  daemon there (no `--operator`), and the CLI is found inside the app bundle when it is not on PATH
  (`REMOTLY_TAILSCALE` overrides, and `setup` carries it into the units). One update at a time stays a kernel lock: perl's `flock` stands in for flock(1) and
  `/proc`, the descriptor's number travels in `REMOTLY_UPDATE_LOCK_FD` and is believed only when fstat says it is the
  lock file. The PTY size probe uses BSD stty (`-f`) and `ps` for a pane's tty where there is no `/proc`. Nothing
  changes on Linux: the same units, the same commands, the same messages — only the help text names both hosts now.
- CI runs the bridge on both hosts (`ubuntu-latest`, `macos-26`): the unit tests, an install from the packaged tarball
  the way a user does, and the service brought up under the host's own manager and checked end to end — status,
  doctor, a second setup over a running service, and a restart after a kill (`ci/e2e/bridge-service.sh`, with a
  stand-in for herdr's socket). The release waits for the macOS run before it tags; the delivery gate runs the bridge
  tests on both hosts.

### Phone apps — local demo

- Android, iPhone and iPad can explore sample terminal sessions without a bridge or Tailscale: **Try demo** on
  pairing or Settings, a persistent sample-data banner, and **Exit demo** to return to the saved host.
- Approvals, questions, input, scrollback and sample terminal creation/closing use the real app controls with local
  simulated responses. Commands never execute; photos and notifications require a real host. See `docs/DEMO.md`
  for store-review access and verification.
- iOS includes the required-reason privacy manifest for its own saved preferences (`UserDefaults`, `CA92.1`).
- Entering demo cancels pending real-host notification actions before they can send, including a delayed connection.

### Phone apps — themes

- Settings › Appearance › Theme on iOS and Android: **Dark** (the default, unchanged), **Light** — a white screen with
  near-black text for reading in sunlight — and **Catppuccin Mocha**. The choice recolours the app, the terminal and its
  ANSI palette at once, follows to the system controls, menus, Copy / Paste toolbar and status bar (and to the keyboard
  on iOS; Android's keyboard app keeps its own look), and is remembered (also across Forget this host). The Live
  Activity and Dynamic Island stay dark. Tokens per theme: `shared/design/DESIGN.md` §1.
- Android's primary buttons (Try demo, Pair, Create) now label in `onInteractive` as DESIGN.md §4.8 and iOS have it;
  Material's `labelLarge` had drawn them in `fg`, the one change to how Dark looks.
- On Light, terminal text that a program coloured for a dark terminal (Claude Code's white text and grey hints) is
  darkened to 4.5 : 1 against its background, keeping its hue (FlowKit / `:core` `Contrast`, unit-tested on both).

### Android — build toolchain

- Gradle 9.7.1, Android Gradle Plugin 9.4.0 (its built-in Kotlin replaces the `kotlin-android` plugin; `:core` keeps the
  Kotlin Gradle plugin, which sets Kotlin 2.4.20 for the whole build), JUnit 6.1.3, Firebase Messaging 25.1.3 and the
  current androidx.core, coroutines, serialization, Google Services and ZXing releases. Nothing changes for users; the
  FCM registration token that Firebase now deprecates stays in use until the installation-id move (`docs/BACKLOG.md`).

### Delivery

- App version 0.1.1 on both platforms (`MARKETING_VERSION` in `ios/project.yml`, `versionName` in
  `android/app/build.gradle.kts`): App Store Connect closes a version's train once that version is approved, so the
  TestFlight lane refused every 0.1.0 build after the App Store release; `promote.yml` submits 0.1.1 from here on.
- The apps are on the App Store and Google Play: `README.md` and `ONBOARDING.md` link to the stores instead of asking
  for an internal-testing invite.
- Store builds come from GitHub-hosted runners (`ubuntu-latest`, `macos-26`) with the credentials in the
  repository's Actions secrets (`docs/DELIVERY.md`, "Secrets"); the two self-hosted runners and their installers
  (`ci/setup-*-runner.sh`, `ci/android-env.sh`) are retired.
- Pull requests compile the iOS app on the lane's Xcode (26.6, signing disabled) besides the FlowKit tests: the first
  hosted iOS delivery failed on a Swift concurrency diagnostic the Mac's Xcode 26.3 had not raised (`AppModel`
  ending Live Activities from a task).
- `promote.yml` takes delivered builds to production by hand (`workflow_dispatch`, from `main` only, each build named
  by number and the inputs checked first): Play internal testing → production as a staged rollout raised in place on
  later runs (`store/play-promote.mjs`, the Android Publisher API in one edit that keeps the completed release and
  never cancels a review), and the TestFlight build → an App Store version submitted to review with What's New
  (`store/asc-submit.mjs`, the App Store Connect API); both scripts have a dry run and tests against a fake API
  (`docs/DELIVERY.md`, "Promotion").
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
