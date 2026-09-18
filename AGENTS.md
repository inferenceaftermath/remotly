# Remotly — working rules for Codex

Orientation: `ONBOARDING.md`, then `CHANGELOG.md` (what shipped) and `docs/BACKLOG.md` (what is open); rules for changes in
`CONTRIBUTING.md`. The owner's private notes (progress log, hosts and identifiers) live outside this repository, in the
sibling checkout `../remotly-notes` when present. Visual system for both apps: `shared/design/DESIGN.md`. Wire contract:
`shared/protocol/remotly-protocol.md`. Every feature ships on iOS and Android with identical interactions.

## Review policy (mandatory)

- Work is not considered commit ready until there are 0 major/P0 findings from the review cycle. Every piece of work
  must be independently reviewed by a `codex` agent with the `gpt-5.6-sol` model at `xhigh` reasoning effort before it
  is committed. Do a health-check about 60 s after the codex launch; it sometimes hangs — kill it and relaunch if hung.
  Report to the user if codex is not available on the system.
- A review cycle is only complete when the independent reviewer's findings have been validated (confirmed real, or
  shown to be false positives with the reason). If there are findings, fix them and invoke codex again; repeat until
  there are no major findings. Only then is the work commit ready.
- Reviewers never modify the work: codex is a reviewer, the Codex session is its orchestrator and owns every edit.
