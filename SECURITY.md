# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
<https://github.com/inferenceaftermath/remotly>. Do not open a public issue. Reports are acknowledged as they come in and
fixed in the next bridge release or app build; there is no bounty programme. Only the latest bridge release
(`bridge-vX.Y.Z`) and the current app builds are supported.

## Threat model — read before pairing a phone

- **A paired phone is a shell on your host, as you.** A device token can type into any pane (`keys`, `text`, `prompt`),
  approve or deny agent prompts, open a new terminal running an arbitrary command (`pane.create`), close panes (which
  ends their processes) and upload files into `~/.local/share/remotly/uploads`. There is no view-only mode. Tokens do
  not expire; revoke a lost phone with `remotly-bridge devices revoke <id>`: its next connection is refused (close code
  4401) and the app shows the host as unpaired and stops reconnecting. The phone keeps the host entry and the now
  useless token until its user removes the host or pairs again.
- **The perimeter is your tailnet plus TLS.** With Tailscale present (`security.require_tailnet: auto` resolves to on),
  `/pair` and WebSocket upgrades are accepted only from peers that `tailscale whois` attributes to the same tailnet user,
  judged on the TCP peer address, never on headers, so do not put a reverse proxy in front of the bridge. The listener
  binds the Tailscale IPv4 by default. `/health` (ok, herdr up/down, version) is not gated. At start-up the bridge
  waits for Tailscale when it is installed but not up yet (boot order) and exits for systemd to retry rather than
  starting with the gate off; once it has seen Tailscale up, the `auto` gate stays on for the life of the process and an
  `auto` listener without a Tailscale address is an error, so a Tailscale that stops later makes peers fail closed
  instead of opening the host up. Only a host with no Tailscale at all starts without it: `auto` settings fall back to
  every interface, a self-signed certificate and no gate (the journal lists what each setting resolved to), an explicit
  `require_tailnet: true` denies every request and `tls.mode: tailscale` stops at the certificate. `setup` insists on a
  working Tailscale whenever a setting needs it — a Tailscale certificate (`tls.mode` `auto` or `tailscale`),
  `require_tailnet: true`, or an `auto` gate on a host where the binary is installed — and `doctor` reports those as
  failures. Two hand-written states are accepted without Tailscale, as `setup --lan` is: `tls.mode: selfsigned` with
  `require_tailnet: false` (whatever `listen.host` says; `doctor` then describes what an `auto` listener binds), and
  `tls.mode: selfsigned` with an `auto` gate on a host with no binary, where both print a warning that the gate is off
  and carry on.
- **LAN mode (`setup --lan`) has no peer gate.** The bridge listens on every interface with a self-signed certificate
  whose fingerprint the QR carries and the Android app pins. Anyone on that network can attempt pairing: codes are 8
  characters from a 32-symbol alphabet, single use, valid 5 minutes, at most three outstanding, five wrong codes lock
  the address out for 15 minutes and thirty attempts a minute from everyone together pause pairing. Each address may
  hold 8 WebSockets and the bridge 64; headers must arrive within 15 s, a body silent for 30 s (counted from the
  request's arrival, gate time included) is dropped, and a whole request must finish within 120 s from its first header
  byte (`/pair` always; photo uploads get long enough for `uploads.max_mb` at 32 KiB/s after the headers). Use LAN mode only
  on a network you trust.
- **Codes and tokens.** Pairing codes and the 256-bit device tokens come from the CSPRNG; tokens are stored as SHA-256
  hashes in `devices.json` (mode 0600) and compared in constant time. The code `setup` prints is reusable until it
  expires (default 10 minutes) so several phones can pair; `pair` codes are single use.
- **What leaves the host.** Push notifications go to Apple and Google, through the app owner's relay
  (`relay.remotly.dev`, `relay/README.md`) unless the host holds its own credentials. They carry the pane id, host name,
  agent kind, status and dialog kind, and, while `push.include_excerpt` is on (the default), pane text: the parsed dialog
  or a screen excerpt, the session title (pane title or directory name) and the one-line approval summary
  (`bridge/README.md` lists the fields). With it off, the host name stands in for the session title and no pane text is
  sent. Nothing else leaves the host; there is no telemetry.
- **Logs.** One JSON line per event in the journal. `info` never contains tokens or pane text (screen contents, titles,
  labels, typed text, error messages that quote the client); pane and device ids do appear at `info`. `debug` adds the
  text of error replies and per-connection TLS handshakes, never tokens.
- **On the phones.** The token is stored in the iOS Keychain / Android app-private storage; the apps register no URL
  scheme (QR payloads come only from the camera or paste), allow no cleartext traffic and export only the main activity.

## Out of scope

Anyone with a login on the host has the same access as a paired phone: the control socket and `devices.json` are
user-private files. Securing the host itself, the Tailscale account and the phones' lock screens is up to you.
