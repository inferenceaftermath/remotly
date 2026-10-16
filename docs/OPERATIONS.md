# Remotly — operations runbook

Everything here is user-scoped on the host; no root is needed. Defaults: config dir `~/.config/remotly`, port
`7460`, unit `remotly-bridge.service`, the bridge under `~/.local/share/remotly/app`, the CLI at `~/.local/bin/remotly-bridge`.
The commands below are the Linux ones (systemd); on macOS the service is the launchd agent `dev.remotly.remotly-bridge`
in `~/Library/LaunchAgents`, and every `systemctl --user …` has a `launchctl` counterpart that `setup` and `doctor` print
in their messages: `launchctl print gui/$(id -u)/dev.remotly.remotly-bridge` (status), `launchctl kickstart -k …`
(restart), `launchctl bootout …` (stop), `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` (start),
and the log is the file `~/Library/Logs/remotly/<label>.log` instead of the journal. A crash loop shows as
`state = spawn scheduled` with a `last exit code` in `launchctl print` (launchd respawns forever; it has no start-rate
limit), and `setup` or `update` restarts it like a `failed` systemd unit. The daily update is the agent
`dev.remotly.remotly-bridge-update`; `launchctl disable gui/$(id -u)/dev.remotly.remotly-bridge-update` (after a bootout)
turns it off, and the lock is perl's `flock` instead of flock(1).
Setting up a new host from scratch: `ONBOARDING.md` at the repo root. From a checkout, every `remotly-bridge <command>`
below is `node src/main.ts <command>` in `bridge/`.

## Daily commands

```sh
remotly-bridge status              # herdr up/down, listener, cert, devices, push readiness, clients
remotly-bridge doctor              # environment checks; exit 1 on hard failures, a fix printed for each
remotly-bridge pair                # QR + manual code for a new phone (5 min, single use)
remotly-bridge pair --manual       # same, without the QR (from a phone terminal use the manual fields)
remotly-bridge devices list
remotly-bridge devices revoke <device_id>
remotly-bridge push-test <device_id>
systemctl --user status remotly-bridge
journalctl --user -u remotly-bridge -f -o cat      # JSON lines; `| jq` for filtering
systemctl --user status remotly-bridge-herdr       # the herdr service setup installs (herdr itself; see "herdr" below)
```

`REMOTLY_CONFIG_DIR` and `REMOTLY_SYSTEMD_UNIT` select another instance (`bridge/README.md` "Install").

## Install / upgrade

- Install and upgrade are the same line: `curl -fsSL https://remotly.dev/install.sh | sh` (what it does:
  `bridge/README.md` "Install"). Config and devices stay; the unit is re-rendered and restarted. The installer keeps the
  previous copy in `~/.local/share/remotly/app.prev`; after a failed hand-run upgrade, put that version back with the
  installer pinned to it (`curl -fsSL https://remotly.dev/install.sh | REMOTLY_VERSION=X.Y.Z sh`, the version in
  `app.prev/package.json`) — never `mv app.prev app` while `app/` exists, which would nest it inside. After a forced
  install over a repository checkout (`REMOTLY_FORCE=1`), `app.prev` is that checkout, which neither `update rollback` nor
  the pinned installer restores: `mv app app.failed && mv app.prev app`, point `~/.local/bin/remotly-bridge` back at
  `app/bridge/bin/remotly-bridge`, then the checkout's own `setup --no-pair --keep-mode`. From a checkout: `git pull`, `npm ci --omit=dev`, `node src/main.ts setup --no-pair --keep-mode`
  (`--keep-mode` keeps a LAN host in LAN mode; without it `setup` means "Tailscale again").
- Upgrades also arrive by themselves: `setup` installs `remotly-bridge-update.timer` (daily, `systemctl --user
  list-timers`), which runs `remotly-bridge update` — nothing when the running bridge is the latest release, otherwise
  that release's installer with the settings the first install used (mirror, launcher directory, runtime: they are in
  the unit). An update counts as done only when the new daemon has answered steadily for half a minute; when the
  installer fails or the new bridge does not stay up, the previous copy goes back — best effort: only when `app.prev`
  holds the version that ran before, and a bridge that is still up on the old copy is left alone — and the unit is
  restarted on it (`app.failed` keeps the bad one; the reason is in `journalctl --user -u remotly-bridge-update`). One
  run at a time (`update.lock`, a `flock` lock that `install.sh` takes too — or, started by `update`, confirms on the
  descriptor it was handed); a run that was stopped half-way is finished by the next one (`update-pending.json`).
  A stop between an install's or a rollback's two renames (power loss) leaves no `app/`: both units run
  `<home>/repair-app.sh` first, which puts `app.prev` back, and a private `node/` back from `node.old` (not while an
  install holds the lock; two repairs queue on `update.lock.repair`). A stopped bridge (`systemctl --user stop`) is not
  updated — and a stop during the update stands too: the installer's `setup` runs with `--keep-stopped`, and neither it
  nor a run that finishes an earlier one restarts a stopped unit (or one whose state systemd does not tell) — an update
  starts the bridge; a `failed` one (crash loop) is updated, since the update may be what repairs it. Everything else
  is by hand: when a run cannot do something itself it prints the exact line — that release's installer with this
  install's settings (`REMOTLY_HOME`, release base, launcher directory, runtime, unit, herdr selection,
  `--config-dir`); the generic form is `curl -fsSL https://remotly.dev/install.sh |
  REMOTLY_VERSION=X.Y.Z sh` (the variable must reach `sh`, not `curl`) for a default install. Off: `systemctl --user disable --now remotly-bridge-update.timer` (or `setup --no-auto-update`; a masked
  timer or update service is respected too); on demand: `remotly-bridge update`. A checkout gets no timer (`update`
  refuses it; a checkout is updated by git and its own `setup`).
- Config changes (`~/.config/remotly/config.json`) need `systemctl --user restart remotly-bridge`. Invalid config → the
  unit fails fast with a precise message in the journal.
- Photos uploaded from the phones (`POST /upload`) are files under `~/.local/share/remotly/uploads/<YYYY-MM-DD>/` (0600,
  `uploads.dir`); the bridge deletes day folders older than `uploads.keep_days` (14) on the next upload, so there is
  nothing to schedule. Deleting the folder by hand is always safe.

## TLS

- `tls.mode: auto` tries `tailscale cert <magicdns-name>` first and falls back to a self-signed 800-day certificate
  (Apple rejects longer ones) when the tailnet has HTTPS certificates disabled or MagicDNS is off. If `tailscale cert`
  is refused for your user, `sudo tailscale set --operator=$USER` once. Enabling HTTPS certificates in the Tailscale admin
  console and restarting the unit switches to a publicly trusted certificate; phones then re-pair once because the
  pinned fingerprint goes away (the QR carries no `fp` for Tailscale certificates).
- Tailscale certificates are renewed automatically when fewer than 14 days remain (daily check; the listener swaps
  certificates without dropping connections).
- The self-signed key/cert live in `~/.config/remotly/tls/self.{key,crt}`; deleting them and restarting rotates the
  certificate (all phones must re-pair).

## Pairing and access

- `/pair` and WebSocket upgrades are accepted only from the same tailnet user (`security.require_tailnet: auto` → true
  when Tailscale is present). `/health` is open. The threat model is in `SECURITY.md`.
- Five wrong pairing codes from one device address lock that address out for 15 minutes (`pair.locked_out` in the
  journal); other devices can keep pairing. Thirty pairing attempts within a minute from everyone together pause pairing
  until the minute is over (`pair.busy`; the phones show the same "try again" message). Restarting the bridge clears the
  counters. Codes are 8 characters from `A-Z2-9`.
- Each peer address may hold 8 open WebSockets and the bridge 64 in total; further upgrades are refused (`ws.refused` with
  `reason`), which the apps treat as a dropped connection and retry. A phone that keeps hitting the per-address cap has
  connections the bridge has not noticed dying yet: they go after 45 s of silence.
- `pane.fit` journal lines (`why: fit|refit|restore`) show a phone resizing a pane's PTY (app setting "Fit pane to this
  device"); the pane returns to herdr's size when the phone leaves. A pane stuck narrow after a bridge crash gets its
  size back on herdr's next layout change (split/close/resize the window).
- Tokens are stored hashed in `~/.config/remotly/devices.json` (0600). Revoking a device closes its next reconnect with
  4401; the app shows the host as unpaired, stops reconnecting and offers to pair again (it keeps the entry until its
  user removes it).

## Push

- Two ways out of the host, chosen per platform. **Relay** (the default): the platform's `push.*` left empty and
  `push.relay_url` pointing at the app owner's Worker (`relay/README.md`). **Direct** (a host with its own app records):
  `push.apns.{team_id,key_id,bundle_id}` set and the team APNs key at `~/.config/remotly/secrets/AuthKey.p8` (0600);
  `push.fcm.project_id` set and the Firebase service account JSON at `~/.config/remotly/secrets/fcm-service-account.json`
  (0600). `doctor` verifies the secrets' presence and mode, or the relay's `/health`; `status` shows
  `apns=ready (direct|relay)`; `push-test <device_id>` sends a synthetic approval either way.
- Relay journal events: `relay.transport_error` (no answer within 25 s or a broken reply; the bridge never re-sends a
  push — the relay retries a failed APNs connection once and the Google token exchange once, never an FCM send),
  `relay.rejected` (400/413/429 from the relay — a bridge bug or the abuse limits), `relay.unavailable` (5xx: the
  relay's rate limiter is down or the Worker is failing; also what an exhausted free-plan quota looks like),
  `relay.not_configured` (the Worker lacks that platform's secrets).
- A notification is sent when a pane stays `blocked` for `push.debounce_ms` (2.5 s) and no connected phone is viewing
  that pane. Repeated prompts for the same pane collapse (`apns-collapse-id` / `collapse_key` = pane id).
- Dead tokens are dropped automatically (`push.token_dropped` in the journal); the phone re-registers on its next connect.
- `apns.config_error` / `fcm.config_error` in the journal mean the key or service account is wrong or expired — fix the
  secret and restart.

## herdr

- The bridge follows herdr's default socket (`~/.config/herdr/herdr.sock`). If herdr is restarted or upgraded the bridge
  reconnects every 2 s (`herdr.state` events in the journal; phones show a banner). herdr protocol is pinned to 19 in
  `doctor` — after a herdr upgrade run `doctor` and the bridge tests before trusting approvals.
- `setup` (bridge ≥ 0.5.0) installs `remotly-bridge-herdr.service` (macOS: the agent `dev.remotly.remotly-bridge-herdr`),
  `herdr server` for that session (behind `env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=~/.config`: herdr reads the first two
  before its default session and takes its directory from `XDG_CONFIG_HOME`, else `HOME`; a user manager that imported a
  shell's environment, or a drop-in, may carry any of them, so the two are dropped and the directory is pinned to the one
  the bridge looks under), so a reboot — on a Mac,
  the login after it — brings herdr back by itself; `doctor`
  says whether it would. A herdr started from a terminal before the service existed keeps running until then — to hand over now:
  `env -u HERDR_SESSION -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=~/.config /path/to/herdr [--session NAME] server stop; systemctl --user start remotly-bridge-herdr` (setup prints it: from inside a herdr pane a bare `herdr server stop` would follow the pane's `HERDR_SOCKET_PATH` to that pane's own session — `--session NAME` is not fooled — and the pane's `XDG_CONFIG_HOME` to that herdr's directory; the prefix is the unit's own, and the `herdr` is the one the unit runs, by its path: setup may have found it off this shell's PATH). On a Mac the restart that loads a rewritten plist is `launchctl bootout …; sleep 2; launchctl bootstrap …` (a `kickstart -k` respawns the definition launchd loaded), and setup prints that one; a disabled agent launchd would not bootstrap again, so for one the line printed turns it on (`bootout`, then `enable && bootstrap`) and says so. (that ends the panes' processes; herdr restores the
  layout, and the agents with `resume_agents_on_restore`). Stopping or restarting the unit does the same. Under the
  service, skip `herdr update --handoff` (a live upgrade that hands the panes to a new process): the service manager
  sees its process exit and starts the unit again — systemd ends the processes it left behind first. Stop the unit,
  update herdr, start it. `Restart=always`: a `herdr server stop` alone comes back after 2 s. Opt out with
  `setup --no-herdr-service` or `systemctl --user disable --now remotly-bridge-herdr`; later setups respect that. The
  panes' shells inherit the service's environment, not a terminal's: agents under `~/.local/bin` must be on PATH
  through the shell's rc files (or set herdr `shell_mode = "login"`). Two bridge instances following the same session
  (two `--unit`s) share one herdr service: the first bridge's `<unit>-herdr` is the session's, and a second bridge
  following the same session installs none while that unit starts it at boot — enabled, loaded from its file (or, on
  a Mac, standing unbootstrapped until the next login, as setup's own does after a setup over a herdr started by
  hand), no drop-in of its own, its `herdr` there (setup and doctor name it; two already there, each from before the
  other followed the session, are reported with the line that keeps one — by setup and by `doctor`, and every start or
  restart of setup's own unit either prints beside the others turns each of them off first, since their
  `Restart=always` would bring their herdr back against ours; for a disabled unit of setup's that line is the full
  hand-over, theirs off and ours enabled and restarted). Another bridge's unit that runs the session without being
  its provider (disabled without `--now`), and a unit of your own found running the herdr that answers (Linux: the
  listener's process from `/proc/net/unix` — two listeners under one path, an old socket keeping its address, and
  nothing is claimed — its unit from the process's cgroup — `herdr.service`, a `systemd-run` unit, a desktop app's
  transient unit under KDE; a terminal under GNOME is a scope; macOS: `lsof -U` for the
  processes on the socket, the one whose executable is `herdr` among several — and among several herdrs the server
  by its arguments, or none when they cannot be told apart — then `launchctl list` for the job the process or one of
  its ancestors is the main process of; a GUI app's `application.…` label is a terminal's), are stopped through the
  manager in those lines — `herdr server stop` alone could have it back against the unit — and the lines say the
  unit is stopped as a whole ("and whatever else X runs"); only a unit that neither brings herdr back (`Restart=no`;
  launchd's KeepAlive is taken as yes) nor may start it at boot, and either has herdr for its main process (a plain
  `systemd-run`) or is a desktop app's transient `app-…` unit whose main process is a terminal emulator (konsole's
  under KDE), is a terminal's kind, with herdr's own stop line — a wrapper that may start herdr again (a shell loop,
  under whatever unit name) is stopped as a unit however `Restart=` reads. Whether such a unit of your own
  starts herdr at boot too is read from the manager: enabled, it is a second starter, said as such with the line that
  keeps one (naming the setup-owned unit or units that start the session after that run: this bridge's, another
  bridge's provider, or both); `disabled`, `enabled-runtime` (gone with this boot) or `transient` with nothing of
  yours starting it (no `WantedBy`/`RequiredBy`/`UpheldBy`/`BoundBy`/`TriggeredBy`/`OnFailureOf`/`OnSuccessOf` — a
  timer or socket of yours counts; on a Mac the label disabled), it is not; anything else (`static`, wanted or
  triggered by a unit of yours, started when another of yours fails, an agent's own `RunAtLoad`) is its own
  arrangement — setup and doctor then say the race may happen, print the keep-one line, and never claim the unit
  takes over at boot. No line printed claims more than it does: what triggers or upholds such a unit (`TriggeredBy`:
  a timer, a socket, a path; `UpheldBy`) is stopped with it — stopped alone, the timer would start it again — and
  named among what the line ends (a unit is stopped as a whole: "and whatever else herdr.timer and herdr.service
  run"), a trigger's own triggers followed as far as they go, as is what the manager stops along with it or with a
  trigger of it (a unit that requires it — `Requires=`, `Requisite=` — or is bound to it, a part of it, what it
  propagates its stop to: "and desk.service, which the manager stops with it (and whatever depends on those)"; a
  masked unit that still runs included) — and what the manager stops along with setup's own unit when it stops or
  restarts (a unit of yours with `PartOf=` or `Requires=` on it), or when it starts (one with `Conflicts=` on it), is
  named in every line that starts, restarts or stops ours, the "off" line for a unit left from an earlier session
  included;
  what is enabled among them is disabled in the same line (`systemctl --user disable --now herdr.timer
  herdr.service`), what is not is only stopped (a `disable` of a static or transient unit undoes nothing, and may
  fail); the keep-one line disables only what is enabled, and when nothing is — a `static` unit, a disabled one a
  target of yours wants (`Wants=` in a drop-in of `default.target`, say: a disable of the unit does not undo that; its
  own enablement link under `~/.config/systemd/user/default.target.wants/` is what `systemctl --user disable`
  removes, and is told apart; the same link under any other persistent load path — `/etc/systemd/user` from a
  `systemctl --global enable`, a vendor's `/usr/lib/systemd/user` — is not, beside a local one or alone), one started
  when a unit of yours fails, a trigger of its own arrangement, or what pulls a trigger in — it says so instead ("keep X from starting
  yourself (…: no line here turns it off)", "which no line here undoes"). A masked unit of yours starts nowhere. The
  same goes for
  another bridge's herdr unit for the session: its provider's triggers go in the lines that turn it off, and one that
  is not enabled but a timer or target of yours may start (on a Mac: whose label another plist declares too) is a
  possible starter at boot — turned off in the hand-over lines as far as a line can, said with a keep-one line of its
  own, and no take-over at boot is claimed beside it. `doctor` names the unit that runs the herdr answering on the
  socket only once herdr has answered (whatever else might hold the path is not attributed).
  Names of your units in those lines are quoted for the shell where needed. One setup at a time per session: a kernel lock (`flock`, held by a child process — `flock(1)` on
  Linux, perl's flock on a Mac and on a Linux without `flock(1)`, as the update lock — and let go by the kernel should setup die) on
  `~/.local/state/remotly/locks/herdr-<key>.lock` (under the home, so every setup of yours meets the same file
  whatever its `TMPDIR`; the file stays, nothing to clean up), waited for up to a minute, then an error naming it;
  without `flock`/`perl` setups go unserialised, and setup says so. So two first installs at once do not both become
  the session's provider. A masked herdr unit name whose mask hides a unit file in another of the manager's load
  paths (`systemctl --user show -p UnitPath`, read as `show` prints lists — a path with a space in it quoted — or the
  documented set when the manager does not answer: `~/.local/share/systemd/user`, `/etc/xdg/systemd/user`,
  `/etc/systemd/user`, …) is a unit setup did not write: setup and doctor say so and print no unmask line (it would
  expose that unit); a mask over nothing is your choice, with the unmask line. When the first bridge is moved to another
  session, its unit goes with it and the second bridge has no service until its own setup runs again (setup says so
  when it rewrites the unit; the second bridge's doctor says so too). The line that turns a disabled unit on (`on:  …`) stops a herdr running outside
  it for the session first, and restarts the unit when it is running another session — `enable --now` would leave it
  so (a start is nothing to an active unit; launchd's `bootstrap` fails on a loaded agent). A first install on
  systemd stopped between writing the unit and enabling it (a `.pending` file beside the unit marks the gap) is finished by the
  next setup — unless another bridge's service took the session meanwhile: then the unit stays disabled, the marker goes, and the
  hand-over line is printed. A new bridge is not given a `--unit` ending
  in `-herdr` or `-update`: those are the names setup derives for a bridge's herdr service and updater (bridge
  `alpha-herdr` and bridge `alpha`'s herdr unit would be one file, written over by turns), and a unit of setup's of
  either kind is never written over as a bridge, nor is a file under such a name that cannot be read or is not a
  bridge unit setup can tell (the Description and `node main.ts serve` every release has written; on a Mac the unit's
  label and exactly those arguments); a bridge installed under such a name before keeps working. The unit file
  starts with a `written by remotly-bridge setup` line, and setup's own unit is exactly what it writes — that line, its
  one `ExecStart` (the `env` command above), nothing more or less; any other file under the name, edited or not, is
  yours: never rewritten, enabled or disabled. Its own it rewrites on every setup, so an edit to the file does not
  last — and a drop-in of your own on it (`systemctl --user edit remotly-bridge-herdr`, or one in any other load path
  systemd merges) makes the unit yours in setup's eyes, whatever it sets: left alone from then on, doctor says so, and
  it keeps the `herdr`, session and directory it had when you took it (remove the drop-in and run setup again to hand
  it back). Hardly any directive is harmless — a `Nice`, a `Limit*`, a `StandardOutput=file:` can each decide whether the
  start succeeds — so setup vouches for none. The exception is a type-level drop-in under one of the system's load
  paths (`/usr/lib/systemd/user/service.d/*.conf`, `/etc/systemd/user/service.d/`, …: root's to write; Fedora ships
  two for every user service): every service runs under it, the bridge's own included, so it counts only when it is
  more than that baseline — anything but timeouts and failure modes, memory-pressure handling (`ManagedOOM*`, which
  Fedora sets for every user service), scheduling weights (`Nice`, `CPUWeight`, `IOWeight`, `OOMScoreAdjust`), stop
  behaviour and logging (so `Exec*`, `Condition*`, `Environment`, `Restart*` — a `Restart=on-failure` would leave a
  `herdr server stop` down for good — a cap such as `MemoryMax`, `TasksMax`, `CPUQuota` or `Limit*` — the bridge
  fitting under it says nothing of herdr — anything naming a unit such as `Conflicts=`, anything unknown), or a
  specifier that differs per unit (`%n`, `%p`, `%i`, `%c`, …) — or cannot be read. The same file under your own load paths (`~/.config/systemd/user/service.d/`) is yours, and so is the unit
  then. On a Mac the plist
  likewise has to be exactly what setup wrote (a `LimitLoadToSessionType` or a `Disabled` added makes it yours). On a Mac the same goes for a label that another
  plist declares (another file name in `~/Library/LaunchAgents`, or `/Library/LaunchAgents`; XML or binary).
- The bridge only reads and subscribes until a phone sends input; watching a pane costs ≈ 25 reads/s (~1 % of a core).

## Troubleshooting

| Symptom | Check |
|---|---|
| App cannot connect | `curl -k https://<tailscale-ip>:7460/health` from the phone's network (Tailscale up on the phone?); `journalctl … \| grep tailnet_gate.denied` for a peer the gate refused (403), `grep ws.refused` for a connection cap. |
| `error auth` / app says unpaired | Token revoked or `devices.json` replaced. `devices list`, then re-pair. |
| Frames stop but status updates continue | Pane closed, or herdr read failures — those are logged at debug only: restart with `REMOTLY_LOG_LEVEL=debug` in the unit (`systemctl --user edit remotly-bridge`), then `journalctl … \| grep watch.read_failed`. |
| Approve did nothing (`stale` / `not_blocked`) | The prompt was resolved on the desktop first; that is the intended outcome. `signature_mismatch` → the agent's dialog changed; update `bridge/src/approvals/agents.json` (fixtures under `shared/fixtures/reads`). |
| No push | `status` shows `apns=off`/`fcm=off` → secrets/config; phone not registered → `devices list` shows `push=no`; the phone was viewing the pane (suppressed by design). |
| Bridge restarts in a loop | `journalctl … -n 50`: config error, port in use (another instance on 7460), `tls.mode: tailscale` without a certificate, or `tailscale.not_up` — Tailscale is installed but tailscaled is stopped or the node is logged out, and a setting depends on it: `sudo systemctl enable --now tailscaled && sudo tailscale up`, or `remotly-bridge setup --lan` for a host that should not use Tailscale. At boot the bridge waits up to 60 s for Tailscale before giving up (`tailscale.waiting`). A start that saw Tailscale up but then found no Tailscale address for `listen.host: auto` exits too (`listen.host is "auto" and Tailscale was up at start-up` in the journal) rather than listening on every interface. |

## Development instance

A second, throwaway instance for experiments: `REMOTLY_CONFIG_DIR=~/.config/remotly-dev` with
`{"listen":{"host":"127.0.0.1","port":7454},"tls":{"mode":"selfsigned"},"security":{"require_tailnet":false},"herdr":{"socket":"~/.config/herdr/sessions/remotly-dev/herdr.sock"}}`
pointed at an isolated herdr session `remotly-dev` (private tmux server `tmux -L remotly`). `bridge/scripts/integration.ts`
uses this layout automatically. Never point spike/capture/integration scripts at the default herdr session.

## Self-signed certificate and iPhones

iOS 26 refuses the bridge's self-signed certificate even when the app pins and accepts the trust: the pairing alert shows
`URLError -1200, stream -9802` (`errSSLFatalAlert`) and the bridge never sees a request. Android's OkHttp accepts the same
certificate. Changing certificate attributes (validity, EKU, CA flag, key type) made no difference in the Mac probe
(`swift ios/scripts/tlsprobe.swift`) and was not verified on a phone, so treat self-signed mode as Android-only.
Self-signed certificates are still generated for 800 days with `serverAuth`. Rotating one (delete
`~/.config/remotly/tls/self.*`, restart the unit) changes the pinned fingerprint: every paired phone must forget the host
and pair again. `tailscale cert` (publicly trusted, auto-renewed, no pinning) is the supported path for iPhones.

## Recurring chores

- herdr upgraded: run `doctor` (it pins protocol 19) and the bridge tests before trusting approvals.
- A phone factory-reset or revoked: `devices revoke <id>` if the old record should go, then `pair` again.
- Direct push only: an APNs key or Firebase service account rotated → replace the file under `~/.config/remotly/secrets/`
  (mode 600), `systemctl --user restart remotly-bridge`, check `status` shows `apns=ready fcm=ready`.
- Running your own delivery lane (TestFlight expiry, Play, secrets): `docs/DELIVERY.md`.
