#!/usr/bin/env bash
# End-to-end: the bridge installed from a package the way a user would, then `setup` putting it under the host's
# service manager — a systemd user unit on Linux, a launchd agent on macOS — and the service answering. herdr is a
# stand-in (fake-herdr.mjs): the service, the self-signed certificate (LAN mode, so no Tailscale), the control socket,
# `status` and `doctor` are the real thing. Runs on GitHub's Linux and macOS runners (ci.yml); needs the bridge
# package in bridge/dist (bridge/scripts/package.sh) and node 24 on PATH.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ver="$(node -p "require('$root/bridge/package.json').version")"
tag="bridge-v$ver"
work="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/remotly-e2e.XXXXXX")}"
unit="remotly-e2e-$$" # this run's own name: a session of the host's own, or another run, never shares it
os="$(uname -s)"

export REMOTLY_HOME="$work/home" REMOTLY_BIN_DIR="$work/bin" REMOTLY_CONFIG_DIR="$work/config" REMOTLY_SYSTEMD_UNIT="$unit"
# The stand-in herdr listens where herdr keeps a named session's socket: only such a socket gets a herdr service from
# `setup` (`herdrSessionFor`), so the session is named after the unit and its directory is made — and removed — here.
session_dir="$HOME/.config/herdr/sessions/$unit"
sock="$session_dir/herdr.sock"
made_session_dir=
hu_ours= # set once the preflight found the herdr unit's name free: only then is that unit this run's to take down
port="${E2E_PORT:-7460}" # another port on a host that already runs a bridge (a developer's machine)
log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nE2E FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
    rc=$?
    set +e
    log "cleanup"
    if [ -x "$REMOTLY_BIN_DIR/remotly-bridge" ]; then
        case "$os" in
            Linux)
                systemctl --user disable --now "$unit.service" "$unit-update.timer" 2>/dev/null
                rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit.service" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit-update."*
                # The herdr unit only when setup wrote it (its marker line): one of the host's own under the name is not this run's to take down.
                if [ -n "$hu_ours" ] && grep -qs "^# written by remotly-bridge setup:" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit-herdr.service"; then
                    systemctl --user disable --now "$unit-herdr.service" 2>/dev/null
                    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit-herdr.service"
                fi
                systemctl --user daemon-reload 2>/dev/null
                ;;
            Darwin)
                launchctl bootout "gui/$(id -u)/dev.remotly.$unit" 2>/dev/null
                launchctl bootout "gui/$(id -u)/dev.remotly.$unit-update" 2>/dev/null
                rm -f "$HOME/Library/LaunchAgents/dev.remotly.$unit.plist" "$HOME/Library/LaunchAgents/dev.remotly.$unit-update.plist"
                if [ -n "$hu_ours" ] && grep -qs "^<!-- written by remotly-bridge setup:" "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist"; then
                    launchctl bootout "gui/$(id -u)/dev.remotly.$unit-herdr" 2>/dev/null
                    rm -f "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist"
                fi
                ;;
        esac
    fi
    [ -z "${herdr_pid:-}" ] || kill "$herdr_pid" 2>/dev/null
    [ -z "$made_session_dir" ] || rm -rf "$session_dir"
    if [ -n "${KEEP_WORK:-}" ]; then echo "work dir kept: $work"; else rm -rf "$work"; fi
    exit "$rc"
}
trap cleanup EXIT
# The stand-in's session directory is this run's alone, made here in one step (mkdir fails on one that exists — a herdr
# session of the host's own under the name is never touched) and removed in cleanup.
mkdir -p "$(dirname "$session_dir")"
mkdir "$session_dir" 2>/dev/null || fail "a herdr session named $unit exists on this host ($session_dir): not touching it"
made_session_dir=1

# The service's main pid as its manager has it (macOS ships bash 3.2: no `case` inside a command substitution).
main_pid() {
    if [ "$os" = Linux ]; then systemctl --user show -p MainPID --value "$unit.service"
    else launchctl print "gui/$(id -u)/dev.remotly.$unit" | awk '/^[[:space:]]*pid = / { print $3 }'
    fi
}

log "host: $os $(uname -m), node $(node --version), work dir $work"
case "$os" in
    Linux)
        # GitHub's runner user has no user manager running until something asks for one; linger starts it.
        if ! systemctl --user show-environment >/dev/null 2>&1; then
            sudo loginctl enable-linger "$(id -un)"
            XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR
            for _ in $(seq 1 20); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 0.5; done
        fi
        systemctl --user show-environment >/dev/null || fail "no systemd user session for $(id -un)"
        ;;
    Darwin)
        launchctl print "gui/$(id -u)" >/dev/null || fail "no launchd gui session for $(id -un)"
        ;;
    *) fail "unsupported OS $os" ;;
esac

log "install from the package, like a user (REMOTLY_RELEASE_URL=file://…)"
mkdir -p "$work/releases/download/$tag"
cp "$root"/bridge/dist/* "$work/releases/download/$tag/"
REMOTLY_NO_SETUP=1 REMOTLY_VERSION="$ver" REMOTLY_RELEASE_URL="file://$work/releases" sh "$root/install.sh"
bridge="$REMOTLY_BIN_DIR/remotly-bridge"
test "$("$bridge" --version)" = "$ver" || fail "launcher runs $("$bridge" --version), expected $ver"

log "a stand-in herdr on $sock"
# A herdr unit under the test's name that setup did not write (no marker line) is the host's own: not this run's to write over, nor to take down in cleanup.
hu_file=; marker=
case "$os" in
    Linux) hu_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit-herdr.service"; marker="^# written by remotly-bridge setup:" ;;
    Darwin) hu_file="$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist"; marker="^<!-- written by remotly-bridge setup:" ;;
esac
if [ -n "$hu_file" ] && [ -e "$hu_file" ]; then
    if grep -qs "$marker" "$hu_file"; then fail "$hu_file is in the way: a herdr unit under the test's name, left by an earlier run that did not clean up — take it down by hand (disable/bootout, then remove the file) and run again"; fi
    fail "$hu_file is in the way: a herdr unit under the test's name that setup did not write"
fi
hu_ours=1
node "$root/ci/e2e/fake-herdr.mjs" "$sock" &
herdr_pid=$!
for _ in $(seq 1 20); do [ -S "$sock" ] && break; sleep 0.25; done
[ -S "$sock" ] || fail "fake herdr did not come up"
# `setup` finds `herdr` on PATH for the herdr service it installs (and asks `herdr --version` when the socket is
# missing); a shim stands in. The service is enabled but never started here: the stand-in already answers on the socket.
mkdir -p "$work/shim"; printf '#!/bin/sh\necho herdr 0.8.0-fake\n' > "$work/shim/herdr"; chmod 755 "$work/shim/herdr"
export PATH="$work/shim:$PATH"
export HERDR_SOCKET_PATH="$sock" # `status` and `doctor` from this shell look at the stand-in, not a herdr of the host's own

log "setup --lan --no-pair --no-wait (LAN mode: no Tailscale on a runner; the service manager, certificate and health wait are real)"
mkdir -p "$REMOTLY_CONFIG_DIR"; printf '{ "listen": { "port": %s } }\n' "$port" > "$REMOTLY_CONFIG_DIR/config.json"
"$bridge" setup --lan --no-pair --no-wait --unit "$unit" --config-dir "$REMOTLY_CONFIG_DIR" --herdr-socket "$sock" | tee "$work/setup.log"
grep -q 'setup complete' "$work/setup.log" || fail "setup did not complete"
grep -q "✔ service $unit installed" "$work/setup.log" || fail "the service was not installed"
grep -q '✔ bridge running' "$work/setup.log" || fail "the bridge did not come up under the service manager"
grep -q "herdr service .*$unit-herdr.* installed: herdr is running outside it now" "$work/setup.log" || fail "the herdr service was not installed, or was started over the running stand-in"
! grep -q '✖' "$work/setup.log" || fail "setup reported a failure"

log "the service manager's view"
case "$os" in
    Linux)
        systemctl --user is-active "$unit.service" || fail "unit not active"
        systemctl --user is-enabled "$unit.service" || fail "unit not enabled"
        systemctl --user cat "$unit.service"
        # The update timer: an installed release gets one, enabled.
        systemctl --user is-enabled "$unit-update.timer" || fail "update timer not enabled"
        systemctl --user is-active "$unit-update.timer" || fail "update timer not active"
        # The herdr service: written for the shim and enabled, not started (herdr — the stand-in — already answers).
        systemctl --user cat "$unit-herdr.service"
        systemctl --user cat "$unit-herdr.service" | grep -q "^ExecStart=\"/usr/bin/env\" -u HERDR_SESSION -u HERDR_SOCKET_PATH \"XDG_CONFIG_HOME=$HOME/.config\" \"$work/shim/herdr\" --session \"$unit\" server$" || fail "the herdr service does not run the herdr found on PATH, for the session the bridge follows, with the manager's HERDR_* dropped"
        systemctl --user cat "$unit-herdr.service" | grep -q "^# written by remotly-bridge setup" || fail "the herdr service lacks the line setup tells its own unit by"
        systemctl --user is-enabled "$unit-herdr.service" || fail "herdr service not enabled"
        ! systemctl --user is-active --quiet "$unit-herdr.service" || fail "the herdr service was started over a running herdr"
        ;;
    Darwin)
        launchctl print "gui/$(id -u)/dev.remotly.$unit" | grep -E 'state = |pid = '
        launchctl print "gui/$(id -u)/dev.remotly.$unit" | grep -q 'state = running' || fail "agent not running"
        cat "$HOME/Library/LaunchAgents/dev.remotly.$unit.plist"
        launchctl print "gui/$(id -u)/dev.remotly.$unit-update" >/dev/null || fail "update agent not loaded"
        if launchctl print-disabled "gui/$(id -u)" | grep -Eq "\"dev.remotly.$unit-update\" => (disabled|true)"; then fail "update agent disabled"; fi
        # The herdr agent: written for the shim and enabled, not bootstrapped (herdr — the stand-in — already answers).
        cat "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist"
        grep -q "<string>$work/shim/herdr</string>" "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist" || fail "the herdr agent does not run the herdr found on PATH"
        grep -q "<string>$unit</string>" "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist" || fail "the herdr agent is not for the session the bridge follows"
        grep -q "<string>XDG_CONFIG_HOME=$HOME/.config</string>" "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist" || fail "the herdr agent does not pin herdr's directory"
        grep -q "<!-- written by remotly-bridge setup" "$HOME/Library/LaunchAgents/dev.remotly.$unit-herdr.plist" || fail "the herdr agent lacks the line setup tells its own unit by"
        if launchctl print-disabled "gui/$(id -u)" | grep -Eq "\"dev.remotly.$unit-herdr\" => (disabled|true)"; then fail "herdr agent disabled"; fi
        if launchctl print "gui/$(id -u)/dev.remotly.$unit-herdr" >/dev/null 2>&1; then fail "the herdr agent was bootstrapped over a running herdr"; fi
        ;;
esac

log "status and doctor over the control socket"
"$bridge" status | tee "$work/status.log"
grep -qE '^herdr:    (up|down)$' "$work/status.log" || fail "status: no herdr line" # `down`: the stand-in answers ping only; the link keeps retrying"
grep -q '^tls:      selfsigned' "$work/status.log" || fail "status: expected a self-signed certificate in LAN mode"
grep -q "^listen:   0.0.0.0:$port" "$work/status.log" || fail "status: LAN mode listens on every interface, on the configured port"
"$bridge" doctor | tee "$work/doctor.log" || true
grep -q 'doctor: no hard failures' "$work/doctor.log" || fail "doctor found hard failures"
grep -qE "herdr runs outside the herdr service .*$unit-herdr.*, which is enabled and takes over at the next (boot|login)" "$work/doctor.log" || fail "doctor does not tell the stand-in herdr from the service's"
grep -qE "unit $unit(\.service)? active|agent dev\.remotly\.$unit active" "$work/doctor.log" || fail "doctor does not see the service active"

log "a second setup over a running service is idempotent (re-renders the unit, restarts, stays healthy)"
"$bridge" setup --lan --no-pair --no-wait --unit "$unit" --config-dir "$REMOTLY_CONFIG_DIR" --herdr-socket "$sock" | tee "$work/setup2.log"
grep -q 'setup complete' "$work/setup2.log" || fail "second setup did not complete"

log "the service survives a kill: the manager restarts it"
pid="$(main_pid)"
if [ -z "$pid" ] || [ "$pid" = 0 ]; then fail "no main pid"; fi
kill "$pid"
# The killed daemon may still answer while it shuts down: wait for the manager to show another pid, then for that one to answer.
new=""
for _ in $(seq 1 60); do
    new="$(main_pid)"
    if [ -n "$new" ] && [ "$new" != 0 ] && [ "$new" != "$pid" ]; then break; fi
    new=""; sleep 0.5
done
[ -n "$new" ] || fail "the manager started no new process after the kill (pid $pid)"
for _ in $(seq 1 40); do "$bridge" status >/dev/null 2>&1 && break; sleep 0.5; done
"$bridge" status >/dev/null || fail "the new process (pid $new) does not answer after the kill"
echo "back after a kill (pid $pid → $new)"

log "E2E OK on $os"
