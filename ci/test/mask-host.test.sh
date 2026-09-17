#!/usr/bin/env bash
# Exercises ci/mask-host.sh with a stand-in tailscale: no binary → nothing to mask, exit 0; `status` failing, hanging,
# malformed, wrongly typed or showing no complete identity → exit 1, no masks and no echo of the input (fail closed); pretty or compact
# status JSON → masks for the host's MagicDNS name, its first label, the tailnet suffix and every Tailscale address,
# never a peer's name.
# Run: bash ci/test/mask-host.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$here/ci/mask-host.sh"; fake="$tmp/tailscale"; fails=0
cat > "$tmp/pretty.json" <<'JSON'
{
  "Version": "1.90.0",
  "BackendState": "Running",
  "TailscaleIPs": [
    "100.64.0.9",
    "fd7a:115c:a1e0::9"
  ],
  "Self": {
    "HostName": "box",
    "DNSName": "box.tailabcd.ts.net.",
    "TailscaleIPs": [
      "100.64.0.9",
      "fd7a:115c:a1e0::9"
    ]
  },
  "MagicDNSSuffix": "tailabcd.ts.net",
  "CurrentTailnet": {
    "MagicDNSSuffix": "tailabcd.ts.net"
  },
  "Peer": {
    "nodekey:1": {
      "HostName": "phone",
      "DNSName": "phone.tailabcd.ts.net."
    }
  }
}
JSON
node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8"))))' < "$tmp/pretty.json" > "$tmp/compact.json"
printf '{"BackendState":"NeedsLogin","Self":{"DNSName":""},"Peer":{"nodekey:1":{"DNSName":"phone.tailabcd.ts.net."}}}' > "$tmp/loggedout.json"
printf '{"BackendState":"Running","Self":{"DNSName":"box.tailabcd.ts.net."}}' > "$tmp/partial.json"
head -c 200 "$tmp/compact.json" > "$tmp/truncated.json"   # cut inside the JSON: still names the host
printf '{"Self":{"DNSName":{"x":1},"TailscaleIPs":"100.64.0.9"},"TailscaleIPs":[""]}' > "$tmp/badtypes.json"

# run <fake body> → "rc=<n> out=<sorted stdout lines joined by |>"; stderr lands in $tmp/err.
run() {
  printf '#!/usr/bin/env bash\n%s\n' "$1" > "$fake"; chmod +x "$fake"
  local out rc=0
  out=$(TAILSCALE_BIN="$fake" MASK_HOST_TIMEOUT=1 MASK_HOST_KILL_AFTER=1 bash "$script" 2>"$tmp/err") || rc=$?
  printf 'rc=%s out=%s' "$rc" "$(printf '%s\n' "$out" | sed '/^$/d' | sort | paste -sd'|' -)"
}
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3"; echo "     expected: $2"; echo "     got:      $1"; fails=$((fails + 1)); fi; }
want='::add-mask::100.64.0.9|::add-mask::box|::add-mask::box.tailabcd.ts.net|::add-mask::fd7a:115c:a1e0::9|::add-mask::tailabcd.ts.net'

out=$(TAILSCALE_BIN="$tmp/absent" bash "$script") && rc=0 || rc=$?
check "rc=$rc out=$out" "rc=0 out=" "no tailscale binary: nothing to mask, exit 0"
check "$(run 'exit 1')" "rc=1 out=" "status fails: exit 1, no masks"
if grep -q "is tailscaled running" "$tmp/err"; then echo "ok   status fails: says why"; else echo "FAIL status fails: no explanation on stderr"; fails=$((fails + 1)); fi
check "$(run 'sleep 5')" "rc=1 out=" "status hangs: cut by the timeout, exit 1, no masks"
if grep -q "failed or hung" "$tmp/err"; then echo "ok   status hangs: says why"; else echo "FAIL status hangs: no explanation on stderr"; fails=$((fails + 1)); fi
check "$(run 'trap "" TERM; sleep 5')" "rc=1 out=" "status hangs and ignores TERM: killed after the grace period, exit 1, no masks"
check "$(run "cat '$tmp/loggedout.json'")" "rc=1 out=" "logged out (no Self.DNSName): exit 1, no masks"
if grep -q "logged in" "$tmp/err"; then echo "ok   logged out: says why"; else echo "FAIL logged out: no explanation on stderr"; fails=$((fails + 1)); fi
check "$(run "cat '$tmp/partial.json'")" "rc=1 out=" "DNS name without addresses: partial identity, exit 1, no masks"
if grep -q "complete identity" "$tmp/err"; then echo "ok   partial identity: says why"; else echo "FAIL partial identity: no explanation on stderr"; fails=$((fails + 1)); fi
check "$(run "cat '$tmp/badtypes.json'")" "rc=1 out=" "wrongly typed fields: exit 1, no masks"
check "$(run "cat '$tmp/truncated.json'")" "rc=1 out=" "truncated JSON: exit 1, no masks"
if grep -q "tailabcd" "$tmp/err"; then echo "FAIL truncated JSON: the input was echoed to stderr"; fails=$((fails + 1)); else echo "ok   truncated JSON: nothing of the input on stderr"; fi
check "$(run "cat '$tmp/pretty.json'")" "rc=0 out=$want" "pretty JSON: host name, label, suffix, both addresses; no peer"
check "$(run "cat '$tmp/compact.json'")" "rc=0 out=$want" "compact JSON: same masks"

if [ "$fails" -eq 0 ]; then echo "all mask-host tests passed"; else echo "$fails mask-host test(s) failed"; exit 1; fi
