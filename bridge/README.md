# remotly-bridge

The host-side daemon of Remotly: it watches a [herdr](https://herdr.dev) session over its Unix socket and serves
paired phones over TLS WebSockets — pane list, live terminal frames, input, approvals and push notifications.
Node 24 runs the TypeScript sources directly; there is no build step.

Normative protocol: [`../shared/protocol/remotly-protocol.md`](../shared/protocol/remotly-protocol.md).
herdr behaviour this code relies on: [`../docs/herdr-findings.md`](../docs/herdr-findings.md).

## Requirements

- Linux host with systemd running herdr 0.8.x (protocol 19), Node ≥ 24 (`install.sh` brings its own when missing). macOS hosts
  (launchd) are not supported yet.
- Tailscale on the host and phones: required, except in LAN mode (`setup --lan`, for a host without Tailscale), where the bridge
  listens on all interfaces with a self-signed certificate that the Android app pins — iPhones refuse it.
- Notifications need no credentials on the host: by default they go through the app owner's push relay
  (`../relay/README.md`). Hosts that hold the APNs key / Firebase service account themselves send directly.
- `openssl` (self-signed mode), `stty` (exact PTY size probe), `systemd --user` for the service.

## Install (Linux host)

```sh
curl -fsSL https://remotly.dev/install.sh | sh
```

`install.sh` (repository root) puts the latest release under `~/.local/share/remotly/app`, a private Node 24 under
`~/.local/share/remotly/node` unless a distribution package ≥ 24 exists (the private one is refreshed from nodejs.org on
later runs, and a distribution package installed later takes over), a launcher at `~/.local/bin/remotly-bridge`,
and runs `remotly-bridge setup`: herdr and Tailscale checks (each failing check prints its fix and waits until it is
done), the Tailscale certificate, the systemd user unit with linger, a health wait, one pairing QR for all your phones.
Re-running the same line upgrades; config and devices stay. LAN mode for a host without Tailscale:
`curl -fsSL https://remotly.dev/install.sh | sh -s -- --lan`.

From a checkout (development, or the owner's CI deploy): `npm ci --omit=dev`, then `node src/main.ts setup` does the
same with the checkout's own path in the unit. Several instances on one host: a config dir, port and unit name each.

```sh
mkdir -p ~/.config/remotly-dev && echo '{"listen":{"port":7461}}' > ~/.config/remotly-dev/config.json
node src/main.ts setup --unit remotly-dev --config-dir ~/.config/remotly-dev
REMOTLY_CONFIG_DIR=~/.config/remotly-dev node src/main.ts status
```

Releases: tag `bridge-vX.Y.Z` (matching `package.json`) → `.github/workflows/release.yml` builds
`remotly-bridge-X.Y.Z.tar.gz` (sources + production dependencies, `scripts/package.sh`), `SHA256SUMS` and `install.sh`
into a GitHub Release; `install.sh` resolves `/releases/latest`, so only bridge releases may be GitHub Releases.

## CLI

`remotly-bridge <command>` (`bin/remotly-bridge`, or `node src/main.ts <command>`):

| Command | Purpose |
|---|---|
| `setup [--ttl 600] [--no-pair] [--no-wait] [--lan] [--keep-mode] [--unit NAME] [--config-dir DIR] [--herdr-session NAME] [--herdr-socket PATH]` | What `install.sh` runs: herdr socket + protocol, Tailscale (installed, logged in, MagicDNS, HTTPS Certificates — with `tls.mode: selfsigned` only "installed and logged in", and only while the gate is `true` or `auto` with the binary present; a host without the binary and an `auto` gate is warned about, not stopped), `tailscale cert` (on "access denied" it prints `sudo tailscale set --operator=$USER` and waits), the user unit (`ExecStart=<node> <this main.ts> serve`, enabled, restarted) with linger, a health wait, then one pairing code valid for every phone until it expires. `--no-wait` stops at the first failing check instead of polling. `--lan` skips the Tailscale checks and writes `tls.mode: selfsigned`, `listen.host: 0.0.0.0`, `security.require_tailnet: false` into config.json so the daemon behaves the same whether or not Tailscale is installed (the QR then carries a LAN address); an ordinary `setup` later removes exactly those three keys again, while `--keep-mode` (for unattended re-runs: the CI deploy, an upgrade script) leaves the mode as config.json has it — a LAN host stays LAN with no Tailscale checks, any other host is set up as usual. A hand-set `tls.mode: selfsigned` skips only the certificate: the tailnet gate (`security.require_tailnet` true, or `auto` with tailscaled answering) still needs a logged-in Tailscale. With `tls.mode: tailscale` a certificate failure is fatal (no fallback). `--unit` accepts `name` or `name.service` (a doubled suffix is refused); `--config-dir` / `--herdr-socket` are made absolute before they go into the unit, an explicit `--herdr-session` overrides a `HERDR_SOCKET_PATH` inherited from a herdr pane, a `herdr.socket`/`herdr.session` already in config.json wins over both (the flags are then refused, since `serve` would ignore them), and the unit goes to `$XDG_CONFIG_HOME/systemd/user`. A unit that is running for another config dir is never repointed (stop it first, or pick another `--unit`), one that is starting, stopping or in its restart delay is left alone until it has settled, the check is repeated right before the unit file is written, and the health check accepts only a daemon whose pid is the unit's main pid. |
| `serve` | Run the daemon (used by systemd). When `tls.mode` or `security.require_tailnet` depends on Tailscale (`auto`, `tailscale`, `true`; `listen.host: auto` then follows) and Tailscale is installed but not up yet — boot order: a user unit cannot wait for the system `tailscaled.service` — it waits up to 60 s (`tailscale.waiting` in the journal) and then exits (`tailscale.not_up`) so systemd retries, instead of starting on every interface with a self-signed certificate and the gate off. Once it has seen Tailscale up, the listener and the gate hold on to that: `listen.host: auto` without a Tailscale address is then an error (exit, systemd retries) and `require_tailnet: auto` is on for the life of the process — a Tailscale that stops later makes peers fail closed, it cannot open the host up; only the certificate may still fall back to self-signed. A host without Tailscale at all starts at once (`tailscale.absent` in the journal lists what each setting resolves to): `auto` settings fall back — every interface, self-signed certificate, gate off — while an explicit `tls.mode: tailscale` stops at the certificate and `security.require_tailnet: true` denies every request. |
| `pair [--manual] [--ttl 300]` | Create a single-use pairing code and print the QR (plus the manual fields). Talks to the running daemon over `<config dir>/remotly.sock`. |
| `devices list` / `devices revoke <id>` | Paired devices. |
| `status` | herdr connectivity, listener, certificate mode/expiry, devices, push readiness per platform (`direct` / `relay` / off), connected clients. |
| `push-test <device_id>` | Send a synthetic approval notification to one device. |
| `doctor` | Node version, herdr socket + protocol, Tailscale (running, MagicDNS, HTTPS Certificates — or just running when only the tailnet gate needs it; hard whenever `tls.mode` is `tailscale`), the certificate pair the daemon actually uses (key present and matching), push (local secrets at 0600, or the relay's `/health`), systemd unit and whether the answering daemon is its process, linger, daemon reachability. Every failing line is followed by `fix: …`. |

Environment: `REMOTLY_CONFIG_DIR` (default `~/.config/remotly`), `REMOTLY_LOG_LEVEL` (`debug|info|warn|error`, default `info`),
`REMOTLY_SYSTEMD_UNIT` (the unit `setup` installs — same as `--unit` — and `doctor` checks, default `remotly-bridge`), `HERDR_SOCKET_PATH` / `HERDR_SESSION`
(fallbacks when `herdr.socket` / `herdr.session` are null).

## Configuration — `<config dir>/config.json`

Created with defaults by `setup` (or the first `serve`). Every key:

| Key | Default | Meaning |
|---|---|---|
| `listen.host` | `"auto"` | `auto` → the Tailscale IPv4 when `tailscale ip -4` works, else `0.0.0.0`. Or an explicit IP. |
| `listen.port` | `7460` | HTTPS/WebSocket port. |
| `tls.mode` | `"auto"` | `auto` → `tailscale cert` for the MagicDNS name, falling back to self-signed; `tailscale` → fail if no Tailscale cert; `selfsigned` → always self-signed (800-day cert under `<config dir>/tls/` — Apple rejects longer ones — fingerprint pinned by the app and shown in the QR; what `setup --lan` sets). Tailscale certs are renewed daily when < 14 days remain. |
| `security.require_tailnet` | `"auto"` | `auto` → true iff Tailscale is present. When true, `/pair` and WebSocket upgrades are only accepted from peers that `tailscale whois` attributes to the same tailnet user. `/health` is never gated. |
| `herdr.socket` | `null` | Path to herdr's socket. `null` → `$HERDR_SOCKET_PATH`, else the session path, else `~/.config/herdr/herdr.sock`. |
| `herdr.session` | `null` | Named herdr session (`~/.config/herdr/sessions/<name>/herdr.sock`). |
| `push.include_excerpt` | `true` | Put pane text in notifications: the parsed dialog or the last visible lines as the body, the session title (pane title, else the directory name) as the subtitle and Live Activity title, and the one-line approval summary as the Live Activity / status detail. `false` → bodies are "Approval needed" / "Finished", the host name stands in for the session title, no `approval` object and no detail: only ids, the host name, the agent kind, the status and the dialog kind leave the host. |
| `push.debounce_ms` | `2500` | A prompt must stay `blocked` this long, with no connected device viewing the pane, before a push is sent. |
| `push.apns.team_id` | `""` | Apple developer team id. Direct APNs needs `team_id`, `key_id`, `bundle_id` and the key file; otherwise iOS notifications go through `push.relay_url` (or nowhere when that is `""`). |
| `push.apns.key_id` | `""` | APNs auth key id. |
| `push.apns.p8_path` | `<config dir>/secrets/AuthKey.p8` | APNs auth key (mode 0600). |
| `push.apns.bundle_id` | `""` | iOS bundle id (`apns-topic`). |
| `push.fcm.project_id` | `""` | Firebase project id. Direct FCM needs it and the service-account file; otherwise Android notifications go through `push.relay_url` (or nowhere when that is `""`). |
| `push.fcm.service_account_path` | `<config dir>/secrets/fcm-service-account.json` | Firebase service account with `firebase.messaging` scope (mode 0600). |
| `push.relay_url` | `"https://relay.remotly.dev"` | Push relay (`../relay/README.md`) used for each platform whose local credentials above are not configured: the bridge posts the notification there and the relay, which holds the app's APNs key and Firebase service account, forwards it. `""` disables it (no push for platforms without local secrets). |
| `approvals.strict_verify` | `true` | Before sending approval keys, read the pane and require the agent's dialog signature (`src/approvals/agents.json`) to match. The app can override per action with `force`. |

State files: `devices.json` (0600; token hashes only), `tls/` (key, cert, fingerprint), `remotly.sock` (control socket).

## Pairing

1. `remotly-bridge pair` prints a QR (`remotly://pair?u=…&fp=…&c=…&n=…`) and the manual fields. Codes are 8 characters
   from `A-Z2-9`, valid 5 minutes, single use; five wrong codes lock pairing for 15 minutes.
2. The app `POST`s `/pair` and receives a bearer token that it sends in `hello` on every WebSocket connection.
3. `remotly-bridge devices list` / `revoke` manage the tokens.

## How it works

- `herdr/link.ts` keeps one structural event subscription (workspace/tab/pane/layout kinds) and one
  `pane.agent_status_changed` subscription listing every pane (herdr requires a pane id per entry), refreshing the
  snapshot with a 200 ms debounce. All plain requests open a fresh connection (herdr answers exactly one request per connection).
- herdr emits no event on terminal output, so `herdr/watcher.ts` polls `pane.read visible/ansi` every 40 ms for the
  watched pane (≈ 0.4 ms per read at idle). `terminal/ansi.ts` parses SGR into styled runs with correct cell widths,
  `differ.ts` finds changed rows, `encode.ts` emits frames with a per-connection style table. Frames are coalesced to
  ≤ 1 per 33 ms; a full frame is sent on watch start, on resize and every 10 s.
- The exact grid comes from the pane's PTY (`pane.process_info` → `/proc/<pid>/fd/0` → `stty size`); herdr's layout
  rectangle is the fallback.
- Approvals (`approvals/approve.ts`): `pane.get` must still be `blocked` with the same `prompt_id`
  (`<pane>@<state_change_seq>`), the visible text must match the agent's dialog signature, then the mapped keys are
  sent 40 ms apart. Outcomes: `sent | stale | not_blocked | signature_mismatch | failed`.
- Push (`push/notify.ts`): a pane entering `blocked` starts the debounce; if it is still blocked and nobody is viewing
  it, every device with a push registration gets an APNs alert (`node:http2`, ES256 JWT) or a data-only FCM message,
  collapse key = pane id. Dead tokens (`410`, `BadDeviceToken`, `UNREGISTERED`) are dropped.

## Development

```sh
npm test            # node --test (unit tests; fixtures under ../shared/fixtures)
npm run typecheck   # tsc --noEmit
node scripts/tui-client.ts --url wss://<host>:<port> --pair <CODE> [--fp <fingerprint>]   # terminal client for manual verification
node scripts/spike.ts      # herdr measurements (needs a herdr session; see docs/herdr-findings.md)
node scripts/capture.ts    # refresh shared/fixtures/reads from a scratch herdr session
node scripts/gen-frames.ts # regenerate golden frames from the reads
```

Never point the spike or capture scripts at a herdr session you care about: they create tabs and type into panes.

## Logging and security notes

- One JSON line per event on stdout (journal). `info` never contains tokens or pane text (screen contents, titles, labels,
  typed text, error messages that quote the client); pane and device ids do appear at `info`. `REMOTLY_LOG_LEVEL=debug`
  adds per-connection TLS handshakes, the text of error replies and screen-reading detail — turn it on only while debugging.
- Tokens are stored as SHA-256 hashes; pairing codes are single use, except the one `setup` prints, which pairs any number of
  devices until it expires (`--ttl`, default 10 minutes); the tailnet gate runs before the pairing code is checked so
  off-tailnet peers cannot trigger the lockout.
- Ceilings (`server/http.ts`, not configurable): 8 open WebSockets per peer address (further upgrades `429`), 64 in total
  (`503`), 30 `POST /pair` attempts per minute for the whole bridge on top of the per-address lockout (`429 locked_out`
  with `retry_after_ms`), request headers within 15 s (Node sweeps for expired requests every second, so the ceilings bind within a second of their value), a request body that sends nothing for 30 s is dropped (408; silence is counted from the request's arrival, so bytes that waited on the tailnet gate do not buy time), whole
  requests within 120 s — 15 s of headers (plus the sweep second) and a 104 s route budget from the moment the headers are in; `/pair` keeps that whatever the upload ceiling — stretched for photo uploads so that `uploads.max_mb` gets through at 32 KiB/s after the headers (20 MiB → a 640 s body budget, 656 s in all) —
  16 KiB `/pair` bodies, 256 KiB WebSocket messages, `uploads.max_mb` for photos. Refusals are `ws.refused` / `pair.busy`
  in the journal.
- Deploy from a dev machine with `../scripts/deploy.sh user@host [--unit remotly-bridge]` (git pull, `npm ci --omit=dev`, restart, health check).
