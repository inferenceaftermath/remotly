# Remotly — operations runbook

Everything here is user-scoped on the Linux host; no root is needed. Defaults: config dir `~/.config/remotly`, port
`7460`, unit `remotly-bridge.service`, the bridge under `~/.local/share/remotly/app`, the CLI at `~/.local/bin/remotly-bridge`.
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
