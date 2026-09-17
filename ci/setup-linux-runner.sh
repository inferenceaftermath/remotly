#!/usr/bin/env bash
# Install the GitHub Actions runner for inferenceaftermath/remotly on this Linux host, as the current user,
# managed by a *user* systemd unit (no sudo; it sits beside the other runners in ~/actions-runner).
# Registering needs admin on the repository (REMOTLY_REPO, default inferenceaftermath/remotly):
#   GH_TOKEN=$(gh auth token) ci/setup-linux-runner.sh
# Idempotent: an already-configured runner is left alone; the unit is (re)written, reloaded and enabled.
set -euo pipefail
REPO=${REMOTLY_REPO:-inferenceaftermath/remotly}
NAME=${RUNNER_NAME:-remotly-linux}
DIR=${RUNNER_DIR:-$HOME/actions-runner/remotly-linux}
UNIT_NAME=${RUNNER_UNIT:-github-runner-remotly}
UNIT="$HOME/.config/systemd/user/$UNIT_NAME.service"
VERSION=${RUNNER_VERSION:-$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')}

mkdir -p "$DIR"
cd "$DIR"
if [ ! -x ./config.sh ]; then
  tarball="actions-runner-linux-x64-${VERSION}.tar.gz"
  echo "downloading $tarball"
  curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v${VERSION}/${tarball}"
  tar xzf "$tarball" && rm -f "$tarball"
fi
if [ ! -f .runner ]; then
  token=$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)
  ./config.sh --unattended --url "https://github.com/${REPO}" --token "$token" \
    --name "$NAME" --labels remotly --work _work --replace
else
  echo "runner already configured: $(python3 -c 'import json;print(json.load(open(".runner"))["agentName"])')"
fi

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=GitHub Actions runner ($NAME) for $REPO
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$DIR/run.sh
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
sleep 2
systemctl --user --no-pager --lines=3 status "$UNIT_NAME" || true
echo "runner $NAME registered to $REPO; user unit $UNIT_NAME enabled (linger is already on for this user)"
