#!/usr/bin/env bash
# Install the GitHub Actions runner for inferenceaftermath/remotly on the Mac as a launchd LaunchAgent
# (no sudo). Run from another machine with a fresh registration token (needs admin on the repository):
#   TOKEN=$(gh api -X POST repos/<owner>/remotly/actions/runners/registration-token --jq .token)
#   ssh <mac> 'bash -s' -- "$TOKEN" < ci/setup-mac-runner.sh
# Prerequisites on the Mac: Xcode, xcodegen in /opt/homebrew/bin or /usr/local/bin, and
# ~/.config/remotly/{asc-api-key.p8,keychain-pass} (mode 600; docs/DELIVERY.md).
set -euo pipefail
TOKEN=${1:?registration token}
REPO=${REMOTLY_REPO:-inferenceaftermath/remotly}
NAME=${RUNNER_NAME:-remotly-mac}
DIR=${RUNNER_DIR:-$HOME/actions-runner/remotly-mac}
VERSION=${RUNNER_VERSION:-2.337.0}
case "$(uname -m)" in arm64) arch=osx-arm64 ;; *) arch=osx-x64 ;; esac

mkdir -p "$HOME/.config/remotly"; chmod 700 "$HOME/.config/remotly"
for f in asc-api-key.p8 keychain-pass; do
  [ -r "$HOME/.config/remotly/$f" ] || { echo "missing $HOME/.config/remotly/$f (mode 600; see docs/DELIVERY.md)" >&2; exit 1; }
done
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" command -v xcodegen >/dev/null || echo "warning: xcodegen not found; ios/scripts/testflight.sh needs it"

mkdir -p "$DIR"
cd "$DIR"
if [ ! -x ./config.sh ]; then
  tarball="actions-runner-${arch}-${VERSION}.tar.gz"
  echo "downloading $tarball"
  curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v${VERSION}/${tarball}"
  tar xzf "$tarball" && rm -f "$tarball"
fi
if [ ! -f .runner ]; then
  ./config.sh --unattended --url "https://github.com/${REPO}" --token "$TOKEN" \
    --name "$NAME" --labels remotly --work _work --replace
fi
# svc.sh on macOS installs a per-user LaunchAgent (~/Library/LaunchAgents/actions.runner.*.plist).
./svc.sh install || true
./svc.sh start
./svc.sh status
