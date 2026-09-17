#!/usr/bin/env bash
# Exercises ci/deploy-bridge.sh with stand-ins for node, npm, systemctl and journalctl: a good deploy installs the new
# copy; a deploy whose `setup`, `npm ci` or health check fails puts the previous copy back, restarts the unit on it and
# exits 1; a rollback whose file moves or restart fail says so and never claims health. Run: bash ci/test/deploy-bridge.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
export HOME="$tmp/home" REMOTLY_DEPLOY_DIR="$tmp/app" REMOTLY_BRIDGE_UNIT=test-unit REMOTLY_NODE_BIN="$tmp/bin" GITHUB_WORKSPACE="$tmp/src"
mkdir -p "$tmp/bin" "$tmp/src/bridge/bin" "$tmp/src/bridge/src" "$HOME"
# The fake node: `setup` fails when the copy it runs from (its DEPLOYED_SHA) is listed in $tmp/setup-fail-shas, and
# records "<sha> <main path>" plus its arguments for every call; the copy `old-sha` stands for a release from before
# `--keep-mode` existed and rejects it, as the real one would. `status` answers like a healthy daemon unless the copy's
# DEPLOYED_SHA is listed in $tmp/health-fail-shas.
cat > "$tmp/bin/node" <<'NODE'
#!/usr/bin/env bash
main="$1"; shift
case "${1:-}" in
  setup)
    sha="$(cat "$(dirname "$main")/../../DEPLOYED_SHA")"
    echo "$sha $main" >> "${TMPDIR_TEST}/setup-calls"
    echo "$*" >> "${TMPDIR_TEST}/setup-args"
    if [ "$sha" = old-sha ]; then case " $* " in *" --keep-mode "*) echo 'unknown setup option "--keep-mode"' >&2; exit 2;; esac; fi
    grep -qx "$sha" "${TMPDIR_TEST}/setup-fail-shas" && exit 1
    exit 0;;
  status)
    sha="$(cat "$(dirname "$main")/../../DEPLOYED_SHA")"
    grep -qx "$sha" "${TMPDIR_TEST}/health-fail-shas" && exit 1
    echo "herdr: up"; exit 0;;
  *) exit 2;;
esac
NODE
# The deploy's health loops `sleep 1` twenty times; here sleeping is free.
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/sleep"
printf '#!/usr/bin/env bash\nexit "$(cat "${TMPDIR_TEST}/npm-exit")"\n' > "$tmp/bin/npm"
# The fake systemctl records every call; `restart` exits as $tmp/systemctl-restart-exit says (0 unless a case sets it).
cat > "$tmp/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
echo "$*" >> "${TMPDIR_TEST}/systemctl-calls"
[ "$2" = restart ] && exit "$(cat "${TMPDIR_TEST}/systemctl-restart-exit")"
exit 0
SYSTEMCTL
printf '#!/usr/bin/env bash\necho "(journal)"\n' > "$tmp/bin/journalctl"
chmod +x "$tmp/bin/"*
export TMPDIR_TEST="$tmp"
echo 'launcher' > "$tmp/src/bridge/bin/remotly-bridge"; echo '// main' > "$tmp/src/bridge/src/main.ts"
# An earlier deploy is in place: a release from before this deploy script (its setup has no --keep-mode).
mkdir -p "$tmp/app/bridge/src"; echo old-sha > "$tmp/app/DEPLOYED_SHA"; echo '// old main' > "$tmp/app/bridge/src/main.ts"

fail() { echo "FAIL: $*" >&2; exit 1; }
# `setup-args` is never truncated: the flag check at the end sees every setup call of every case.
reset() { echo 0 > "$tmp/npm-exit"; echo 0 > "$tmp/systemctl-restart-exit"; : > "$tmp/setup-fail-shas"; : > "$tmp/health-fail-shas"; : > "$tmp/setup-calls"; : > "$tmp/systemctl-calls"; rm -rf "$tmp/app.bad"; }
: > "$tmp/setup-args"
main="$tmp/app/bridge/src/main.ts"

# 1. The first deploy of this script over a pre-feature release fails in setup: the old copy comes back and is restarted
#    with systemctl — its own setup would have rejected --keep-mode.
reset; echo bad-sha > "$tmp/setup-fail-shas"
if TARGET_SHA=bad-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out0" 2>&1; then fail "a failing setup must fail the deploy"; fi
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = old-sha ] || fail "pre-feature copy not restored (DEPLOYED_SHA = $(cat "$tmp/app/DEPLOYED_SHA"))"
[ "$(cat "$tmp/app.bad/DEPLOYED_SHA")" = bad-sha ] || fail "bad copy not kept aside"
grep -q "rolling back to old-sha" "$tmp/out0" && grep -q "rollback healthy" "$tmp/out0" || fail "rollback not reported: $(cat "$tmp/out0")"
[ "$(cat "$tmp/setup-calls")" = "bad-sha $main" ] || fail "setup must run on the new copy only, never on the restored one: $(cat "$tmp/setup-calls")"
grep -q "^--user restart test-unit$" "$tmp/systemctl-calls" || fail "the unit was not restarted on the restored copy: $(cat "$tmp/systemctl-calls")"

# 2. A good deploy.
reset
TARGET_SHA=new-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out1" 2>&1 || fail "good deploy exited $? — $(cat "$tmp/out1")"
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = new-sha ] || fail "new copy not in place"
[ "$(cat "$tmp/setup-calls")" = "new-sha $main" ] || fail "setup was not run once from the deployed copy: $(cat "$tmp/setup-calls")"
grep -q "healthy at new-sha" "$tmp/out1" || fail "no healthy line: $(cat "$tmp/out1")"
[ "$(readlink "$HOME/.local/bin/remotly-bridge")" = "$tmp/app/bridge/bin/remotly-bridge" ] || fail "launcher symlink"
grep -q "restart" "$tmp/systemctl-calls" && fail "a good deploy restarts through setup, not through the script: $(cat "$tmp/systemctl-calls")"

# 3. Setup fails on the new copy: the previous copy comes back, the unit is restarted on it, and only then is health real.
reset; echo bad-sha > "$tmp/setup-fail-shas"
if TARGET_SHA=bad-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out2" 2>&1; then fail "a failing setup must fail the deploy"; fi
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = new-sha ] || fail "previous copy not restored (DEPLOYED_SHA = $(cat "$tmp/app/DEPLOYED_SHA"))"
[ "$(cat "$tmp/app.bad/DEPLOYED_SHA")" = bad-sha ] || fail "bad copy not kept aside"
grep -q "deploy: setup failed" "$tmp/out2" && grep -q "rolling back to new-sha" "$tmp/out2" && grep -q "rollback healthy" "$tmp/out2" || fail "rollback not reported: $(cat "$tmp/out2")"
[ "$(cat "$tmp/setup-calls")" = "bad-sha $main" ] || fail "setup should run on the new copy only: $(cat "$tmp/setup-calls")"
[ "$(grep -c "^--user restart test-unit$" "$tmp/systemctl-calls")" = 1 ] || fail "exactly one restart for the rollback: $(cat "$tmp/systemctl-calls")"

# 3b. Setup succeeds but the new copy never reports healthy: after the health loop the previous copy comes back.
reset; echo unhealthy-sha > "$tmp/health-fail-shas"
if TARGET_SHA=unhealthy-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out6" 2>&1; then fail "a deploy that never gets healthy must fail"; fi
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = new-sha ] || fail "previous copy not restored after the health failure (DEPLOYED_SHA = $(cat "$tmp/app/DEPLOYED_SHA"))"
[ "$(cat "$tmp/app.bad/DEPLOYED_SHA")" = unhealthy-sha ] || fail "unhealthy copy not kept aside"
grep -q "did not report healthy" "$tmp/out6" && grep -q "rolling back to new-sha" "$tmp/out6" && grep -q "rollback healthy" "$tmp/out6" || fail "health failure not reported: $(cat "$tmp/out6")"
[ "$(cat "$tmp/setup-calls")" = "unhealthy-sha $main" ] || fail "setup should have run once, on the new copy: $(cat "$tmp/setup-calls")"
[ "$(grep -c "^--user restart test-unit$" "$tmp/systemctl-calls")" = 1 ] || fail "exactly one restart for the rollback: $(cat "$tmp/systemctl-calls")"

# 4. Setup fails on the new copy AND the restart of the restored one fails: no "rollback healthy".
reset; echo worst-sha > "$tmp/setup-fail-shas"; echo 1 > "$tmp/systemctl-restart-exit"
if TARGET_SHA=worst-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out4" 2>&1; then fail "must fail when the rollback restart fails"; fi
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = new-sha ] || fail "files not restored after the double failure"
grep -q "restart on the restored copy failed" "$tmp/out4" || fail "double failure not reported: $(cat "$tmp/out4")"
grep -q "rollback healthy" "$tmp/out4" && fail "must not claim rollback healthy when the restart failed: $(cat "$tmp/out4")"

# 5. A failure before setup (npm ci here) rolls back too, without ever running setup.
reset; echo 1 > "$tmp/npm-exit"
if TARGET_SHA=worse-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out3" 2>&1; then fail "a failing npm ci must fail the deploy"; fi
[ "$(cat "$tmp/app/DEPLOYED_SHA")" = new-sha ] || fail "previous copy not restored after npm failure (DEPLOYED_SHA = $(cat "$tmp/app/DEPLOYED_SHA"))"
[ "$(cat "$tmp/app.bad/DEPLOYED_SHA")" = worse-sha ] || fail "bad copy not kept aside after npm failure"
grep -q "sync or npm ci failed" "$tmp/out3" && grep -q "rolling back to new-sha" "$tmp/out3" && grep -q "rollback healthy" "$tmp/out3" || fail "npm failure not reported: $(cat "$tmp/out3")"
[ ! -s "$tmp/setup-calls" ] || fail "setup must not run at all when npm ci fails: $(cat "$tmp/setup-calls")"
grep -q "^--user restart test-unit$" "$tmp/systemctl-calls" || fail "the unit was not restarted on the restored copy: $(cat "$tmp/systemctl-calls")"

# 6. The rollback's own file moves fail (a leftover $deploy.bad that cannot be removed): it stops there — no restart,
#    no health claim — and says what to look at. Permissions do not bind root, so this case needs an ordinary user.
if [ "$(id -u)" != 0 ]; then
  reset; echo bad-sha > "$tmp/setup-fail-shas"
  mkdir -p "$tmp/app.bad/locked"; : > "$tmp/app.bad/locked/f"; chmod 555 "$tmp/app.bad/locked"
  if TARGET_SHA=bad-sha bash "$here/ci/deploy-bridge.sh" >"$tmp/out5" 2>&1; then fail "must fail when the rollback cannot move files"; fi
  grep -q "could not put the previous copy back" "$tmp/out5" || fail "move failure not reported: $(cat "$tmp/out5")"
  grep -q "rollback healthy" "$tmp/out5" && fail "must not claim rollback healthy when the files were not restored: $(cat "$tmp/out5")"
  grep -q "restart" "$tmp/systemctl-calls" && fail "must not restart the unit when the files were not restored: $(cat "$tmp/systemctl-calls")"
  [ "$(cat "$tmp/app.prev/DEPLOYED_SHA")" = new-sha ] || fail "the previous copy must survive a failed rollback"
  chmod 755 "$tmp/app.bad/locked"; rm -rf "$tmp/app.bad" "$tmp/app"; mv "$tmp/app.prev" "$tmp/app"
else
  echo "deploy-bridge.test.sh: case 6 (unremovable \$deploy.bad) skipped: running as root"
fi

# Every setup the deploy ran, in every case above (1, 2, 3, 3b, 4, 6 — case 5 fails before setup), kept the host's
# network mode and stayed unattended.
expected_setups=6; [ "$(id -u)" = 0 ] && expected_setups=5
[ "$(wc -l < "$tmp/setup-args")" = "$expected_setups" ] || fail "expected $expected_setups setup calls across the cases, saw: $(cat "$tmp/setup-args")"
while IFS= read -r args; do
  for flag in --keep-mode --no-wait --no-pair; do
    case " $args " in *" $flag "*) ;; *) fail "a setup run lacked $flag: $args";; esac
  done
done < "$tmp/setup-args"
echo "deploy-bridge.test.sh: ok"
