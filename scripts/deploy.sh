#!/usr/bin/env bash
# Deploy the bridge from a checkout on the Linux host, driven from another machine over ssh:
#   scripts/deploy.sh user@host [--unit remotly-bridge] [--repo ~/remotly] [--branch main]
# Steps on the host: git pull --ff-only, npm ci --omit=dev in bridge/, systemctl --user restart <unit>, health check.
set -euo pipefail
host="${1:?usage: scripts/deploy.sh user@host [--unit NAME] [--repo PATH] [--branch NAME]}"; shift
# shellcheck disable=SC2088  # the tilde is expanded on the remote host (eval below), not here
unit=remotly-bridge; repo='~/remotly'; branch=main
while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit) unit="$2"; shift 2;;
    --repo) repo="$2"; shift 2;;
    --branch) branch="$2"; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
ssh "$host" bash -s -- "$repo" "$branch" "$unit" <<'REMOTE'
set -euo pipefail
repo="$1"; branch="$2"; unit="$3"
eval repo="$repo"
export PATH="${REMOTLY_NODE_BIN:-$HOME/.local/share/fnm/aliases/default/bin}:$PATH"
cd "$repo"
git fetch --quiet origin "$branch"
git checkout --quiet "$branch"
git pull --ff-only --quiet origin "$branch"
cd bridge
npm ci --omit=dev --no-audit --no-fund --silent
systemctl --user restart "$unit"
sleep 1.5
systemctl --user --no-pager --lines=5 status "$unit" | sed -n '1,6p'
port="$(node -e 'const c=require(process.env.REMOTLY_CONFIG_DIR||process.env.HOME+"/.config/remotly")+"/config.json";try{console.log(JSON.parse(require("fs").readFileSync(c,"utf8")).listen?.port??7460)}catch{console.log(7460)}' 2>/dev/null || echo 7460)"
curl -fsk --max-time 5 "https://127.0.0.1:${port}/health" && echo || echo "health check on 127.0.0.1:${port} failed (listener may be bound to the Tailscale IP only)"
REMOTE
