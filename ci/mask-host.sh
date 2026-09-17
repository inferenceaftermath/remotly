#!/usr/bin/env bash
# Hide the host's Tailscale identity in the public Actions log. ci/deploy-bridge.sh keeps everything the bridge's own
# tooling prints (setup, status, the unit's journal) in a log file on the host, so this is the second layer: it
# registers the host's current MagicDNS name, its first label, the tailnet suffix and every Tailscale address as log
# masks (::add-mask::) right after checkout, in case any of them is printed anyway. The workflow masks $HOME itself,
# before checkout. A host without Tailscale (LAN mode) has nothing to mask here. A host with Tailscale whose identity
# cannot be read completely fails the step: a deploy skipped is better than an unmasked log. The machine name in the
# job banner is printed before any step runs and cannot be masked, so give runner machines a neutral hostname
# (docs/DELIVERY.md).
# Test: bash ci/test/mask-host.test.sh
set -euo pipefail
ts="${TAILSCALE_BIN:-$(command -v tailscale || true)}"
if [ -z "$ts" ] || [ ! -x "$ts" ]; then exit 0; fi
# node parses the status JSON; the runner may have it only where ci/deploy-bridge.sh looks for it.
export PATH="${REMOTLY_NODE_BIN:-$HOME/.local/share/fnm/aliases/default/bin}:$PATH"
for tool in timeout node; do
  if ! command -v "$tool" >/dev/null; then echo "mask-host: needs '$tool' on PATH. Refusing to deploy with an unmasked log." >&2; exit 1; fi
done
# --peers=false: only this machine's block, a few KB whatever the tailnet's size. -k: a CLI that ignores TERM is killed.
if ! json=$(timeout -k "${MASK_HOST_KILL_AFTER:-5}" "${MASK_HOST_TIMEOUT:-20}" "$ts" status --peers=false --json 2>/dev/null); then
  echo "mask-host: 'tailscale status' failed or hung: is tailscaled running? Refusing to deploy with an unmasked log." >&2
  exit 1
fi
# node's stderr is dropped: an uncaught parse error would echo the input, identity included, before any mask exists.
if ! values=$(node -e '
  let j; try { j = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(1); }
  if (!j || typeof j !== "object") process.exit(1);
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const self = j.Self && typeof j.Self === "object" ? j.Self : {};
  const name = str(self.DNSName).replace(/\.$/, "");
  const ips = [...list(self.TailscaleIPs), ...list(j.TailscaleIPs)];
  if (!name || ips.length === 0) process.exit(1);                        // logged out, or a partial identity
  const out = new Set([name, name.split(".")[0], ...ips]);
  for (const s of [str(j.MagicDNSSuffix), str(j.CurrentTailnet && j.CurrentTailnet.MagicDNSSuffix)]) if (s) out.add(s);
  process.stdout.write([...out].join("\n") + "\n");
' <<< "$json" 2>/dev/null); then
  echo "mask-host: 'tailscale status --json' has no complete identity (Self.DNSName plus TailscaleIPs): is this machine logged in? Refusing to deploy with an unmasked log." >&2
  exit 1
fi
while IFS= read -r v; do printf '::add-mask::%s\n' "$v"; done <<< "$values"
