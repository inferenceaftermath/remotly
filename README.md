# Remotly

Your terminal coding agents, on your phone. Remotly mirrors the panes of a [herdr](https://herdr.dev) session running
on your computer to an iOS or Android app over your own [Tailscale](https://tailscale.com) network: the live terminal,
keys and prompts, one-tap approval of Claude Code / Codex / pi permission dialogs, and a notification when an agent is
waiting for you or has finished. Product site: [remotly.dev](https://remotly.dev).

## How it works

- **The bridge** (`bridge/`; Node 24 runs the TypeScript directly, no build step) runs on the host beside herdr as a
  systemd user service. It reads herdr over its Unix socket, serves paired phones over TLS WebSockets on the Tailscale
  interface, and sends push notifications.
- **The apps** (`ios/`: SwiftUI and the `FlowKit` package; `android/`: Kotlin and Compose) pair with the bridge by
  scanning a QR, then show tabs and panes, a terminal grid, key row, composer and approval bar, plus a Live Activity /
  ongoing notification while an agent works.
- **The push relay** (`relay/`, a Cloudflare Worker) holds the apps' APNs key and Firebase service account, so a host
  never needs push credentials. A host that has its own credentials sends directly.
- **Shared** (`shared/`): the normative [wire protocol](shared/protocol/remotly-protocol.md), the
  [design system](shared/design/DESIGN.md) both apps follow, and golden test fixtures all three code bases check.

Pairing a phone gives it shell access on the host as your user; the tailnet and TLS are the perimeter. Read
[SECURITY.md](SECURITY.md) before installing.

## Get started

On a Linux host running herdr and Tailscale:

```sh
curl -fsSL https://remotly.dev/install.sh | sh
```

Then scan the QR it prints from the app. Every step, including LAN mode for a host without Tailscale (Android only), is in
[ONBOARDING.md](ONBOARDING.md). The apps are in internal testing on TestFlight and Google Play; request access on
[remotly.dev](https://remotly.dev), or build them yourself with your own Apple and Google records (`ios/README.md`,
`android/README.md`, `docs/DELIVERY.md`).

## Documentation

| | |
|---|---|
| [`ONBOARDING.md`](ONBOARDING.md) | set up a host, pair phones, daily use |
| [`bridge/README.md`](bridge/README.md) | the daemon: install, CLI, configuration, how it works |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | runbook: upgrades, TLS, pairing, push, troubleshooting |
| [`docs/DELIVERY.md`](docs/DELIVERY.md) | run your own TestFlight / Play delivery lane |
| [`docs/herdr-findings.md`](docs/herdr-findings.md) | measured herdr behaviour the bridge relies on |
| [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/BACKLOG.md`](docs/BACKLOG.md), [`CHANGELOG.md`](CHANGELOG.md) | developing, open work, releases |

## Licence and third-party material

Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). The Android app bundles JetBrains Mono under the SIL Open Font
License 1.1 (`android/app/src/main/assets/JetBrainsMono-OFL.txt`) and receives push through Firebase Cloud Messaging,
which depends on the proprietary Google Play services. The fixtures under `shared/fixtures/` are redacted terminal screen
captures (Claude Code, Codex CLI, shell programs) used for interoperability tests. herdr is a separate product with its own licence; Remotly
only talks to its socket API.

Remotly is a project of [Inference Aftermath](https://inferenceaftermath.com). We're also building
[Entwyn](https://entwyn.ai/): modern matchmaking for people tired of swiping and ready for something serious.
