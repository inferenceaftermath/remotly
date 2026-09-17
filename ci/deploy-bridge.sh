#!/usr/bin/env bash
# Redeploy the bridge on this host from the runner's checkout (a host that follows `main`; hosts that
# install releases use install.sh instead). The production copy lives in its own directory
# (~/.local/share/remotly/app, never a developer checkout): the runner's workspace is synced there,
# production dependencies installed, then the bridge's own `setup` re-renders the user unit (ExecStart at
# this copy), restarts it and waits for health — `--no-wait` fails instead of polling when herdr or
# Tailscale is not ready, `--no-pair` skips the pairing QR, `--keep-mode` leaves a host's network mode (LAN or Tailscale)
# as config.json has it — an ordinary `setup` would switch a LAN host back to Tailscale. A failed deploy puts the
# previous copy back and restarts the unit on it.
set -euo pipefail
src="${GITHUB_WORKSPACE:-$(pwd)}"
deploy="${REMOTLY_DEPLOY_DIR:-$HOME/.local/share/remotly/app}"
unit="${REMOTLY_BRIDGE_UNIT:-remotly-bridge}"
export PATH="${REMOTLY_NODE_BIN:-$HOME/.local/share/fnm/aliases/default/bin}:$PATH"

prev="$deploy.prev"
mkdir -p "$deploy"

healthy() {
  systemctl --user is-active --quiet "$unit" \
    && out=$(node "$deploy/bridge/src/main.ts" status 2>/dev/null) && grep -q '^herdr:' <<< "$out" && echo "$out"
}

# Put the previous copy back and point the unit at it again. Every failure after the snapshot below goes through here.
rollback() {
  if [ ! -f "$prev/DEPLOYED_SHA" ]; then echo "deploy: nothing to roll back to" >&2; return 1; fi
  echo "deploy: rolling back to $(cat "$prev/DEPLOYED_SHA")" >&2
  # Called as `rollback || true`, which switches `set -e` off in here: every step is checked by hand.
  if ! { rm -rf "$deploy.bad" && mv "$deploy" "$deploy.bad" && mv "$prev" "$deploy"; }; then
    echo "deploy: could not put the previous copy back — the unit was not touched; look at $deploy, $prev and $deploy.bad by hand" >&2
    return 1
  fi
  # Restart the unit on the restored files, with systemctl rather than the restored copy's own `setup`: an older release
  # may not know this deploy's setup flags, and the unit file already points at $deploy (setup renders ExecStart there,
  # whichever copy rendered it). A `healthy` answer before the restart could come from the process the failed deploy
  # started, which still runs the new code.
  if ! systemctl --user daemon-reload || ! systemctl --user restart "$unit"; then
    echo "deploy: restart on the restored copy failed — files are back at $(cat "$deploy/DEPLOYED_SHA"), but the unit is not running them; check: systemctl --user status $unit" >&2
    return 1
  fi
  for _ in $(seq 1 20); do sleep 1; if healthy >/dev/null; then echo "deploy: rollback healthy" >&2; return 0; fi; done
  echo "deploy: rollback did not report healthy" >&2
  return 1
}

# Sync the new tree in and install its dependencies. One `&&` chain: `set -e` does not apply inside an `if` condition.
install_new() {
  rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude '.gradle' --exclude 'android/*/build' "$src/" "$deploy/" \
    && printf '%s\n' "${TARGET_SHA:-$(git -C "$src" rev-parse HEAD)}" > "$deploy/DEPLOYED_SHA" \
    && mkdir -p "$HOME/.local/bin" && ln -sfn "$deploy/bridge/bin/remotly-bridge" "$HOME/.local/bin/remotly-bridge" \
    && (cd "$deploy/bridge" && npm ci --omit=dev --no-audit --no-fund --silent)
}

# Keep the last good deploy for rollback (the bridge is the phone's only way in when the user is remote).
if [ -f "$deploy/DEPLOYED_SHA" ]; then rm -rf "$prev"; cp -a "$deploy" "$prev"; fi
if ! install_new; then
  echo "deploy: sync or npm ci failed" >&2
  rollback || true
  exit 1
fi

if [ "${REMOTLY_DEPLOY_DRY_RUN:-0}" = 1 ]; then echo "dry run: synced to $deploy, not touching $unit"; exit 0; fi

# Renders ExecStart=<node> <deploy>/bridge/src/main.ts serve, daemon-reload, enable, restart, then setup's own PID-checked
# health wait. `--no-wait` turns a failing herdr / Tailscale / certificate check into a failure here instead of polling.
if ! node "$deploy/bridge/src/main.ts" setup --no-pair --no-wait --keep-mode --unit "$unit"; then
  echo "deploy: setup failed" >&2
  journalctl --user -u "$unit" -n 30 --no-pager >&2 || true
  rollback || true
  exit 1
fi

for _ in $(seq 1 20); do
  sleep 1
  if healthy; then echo "deploy: $unit healthy at $(cat "$deploy/DEPLOYED_SHA")"; exit 0; fi
done
echo "deploy: $unit did not report healthy" >&2
journalctl --user -u "$unit" -n 30 --no-pager >&2 || true
rollback || true
exit 1
