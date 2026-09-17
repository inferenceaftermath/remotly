# Changelog

Bridge releases are tagged `bridge-vX.Y.Z` (matching `bridge/package.json`) and published as GitHub Releases, which is
what `install.sh` installs. The apps ship through TestFlight and Play internal testing from pushes to `main` that touch
them (`ci/plan.sh` picks the lanes; `docs/DELIVERY.md`).

## Unreleased

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
