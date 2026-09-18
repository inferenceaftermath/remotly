#!/bin/sh
trap 'echo "install.sh: the script arrived incomplete (download cut short); nothing was done — run the command again" >&2; exit 1' EXIT
# ^ `curl … | sh` runs whatever arrives: were the download cut short between two functions, the shell would run only
#   definitions and exit 0 as if it had installed. Armed on the first line; nothing runs before `main`, whose first
#   statement disarms it.
#
# Remotly bridge installer — https://remotly.dev/install.sh
#
#   curl -fsSL https://remotly.dev/install.sh | sh
#
# Installs or upgrades the bridge under ~/.local/share/remotly/app, a private Node 24 runtime beside it when the
# system has none, a `remotly-bridge` launcher in ~/.local/bin, then runs `remotly-bridge setup` (herdr and Tailscale
# checks, certificate, systemd user service, pairing QR). Re-running upgrades in place; config and paired devices stay.
# Arguments go to setup: `sh -s -- --lan`, `sh -s -- --no-pair`.
#
# Environment: REMOTLY_VERSION=0.1.0 (default: latest release)   REMOTLY_HOME (default ~/.local/share/remotly)
#              REMOTLY_BIN_DIR (default ~/.local/bin)             REMOTLY_NODE=/path/to/node (use this runtime)
#              REMOTLY_NO_SETUP=1 (install only)                  REMOTLY_RELEASE_URL (release base, for mirrors/tests)
set -eu

RELEASES="${REMOTLY_RELEASE_URL:-https://github.com/inferenceaftermath/remotly/releases}"
NODE_DIST="${REMOTLY_NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
REMOTLY_HOME="${REMOTLY_HOME:-$HOME/.local/share/remotly}"
BIN_DIR="${REMOTLY_BIN_DIR:-$HOME/.local/bin}"
APP="$REMOTLY_HOME/app"
# --max-time caps every request (a server that accepts and then stays silent must not hang the installer); the two
# large downloads below raise it to 600 s (the last --max-time wins in curl).
CURL="curl -fsSL --retry 3 --connect-timeout 10 --max-time 60"

main() {
    trap - EXIT
    echo ""
    echo "  remotly-bridge installer — remotly.dev"
    echo ""

    [ "$(id -u)" -ne 0 ] || err "run this as the user who runs herdr, not as root (the service is a per-user systemd unit)"
    case "$(uname -s)" in
        Linux) ;;
        Darwin) err "macOS hosts are not supported yet (no launchd service). Linux only for now." ;;
        *) err "unsupported OS: $(uname -s)" ;;
    esac
    need curl; need tar; need awk; need sed
    command -v systemctl >/dev/null 2>&1 || err "systemctl not found — the bridge runs as a systemd user service"
    pick_sha_tool
    check_paths

    TMP="$(mktemp -d)"
    trap 'cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    take_lock
    recover_interrupted

    find_node
    resolve_version
    install_app
    write_launcher

    case ":${PATH}:" in
        *":${BIN_DIR}:"*) ;;
        *)
            warn "${BIN_DIR} is not in your PATH; add to your shell config:"
            echo "        export PATH=\"${BIN_DIR}:\$PATH\""
            ;;
    esac

    if [ "${REMOTLY_NO_SETUP:-0}" = 1 ]; then
        log "installed. next:  $BIN_DIR/remotly-bridge setup"
        exit 0
    fi
    echo ""
    cleanup   # exec skips the EXIT trap
    exec "$BIN_DIR/remotly-bridge" setup "$@"
}

# Temp files go; a swap interrupted between its two renames is undone.
cleanup() {
    rm -rf "${TMP:-}"
    recover_interrupted
}

# One install or update of this home at a time: `remotly-bridge update` (the daily timer) and a hand-run installer must
# not move app/ under each other. The lock is flock(1)'s on update.lock, held by this shell (and by the `setup` it execs
# into) until it exits, however it exits. Started by `update`, this shell inherits update's own lock descriptor (the
# links under /proc/self/fd name the files): a lock is per open file, so `flock -n` on that descriptor confirms the lock
# it holds (an open descriptor alone proves nothing) and a second one would only conflict with it.
take_lock() {
    lock="$REMOTLY_HOME/update.lock"
    command -v flock >/dev/null 2>&1 || { warn "flock not found (util-linux): installing without a lock against a concurrent remotly-bridge update"; return; }
    want="$(readlink -f "$lock" 2>/dev/null || echo "$lock")"
    for fd in /proc/self/fd/*; do
        [ "$(readlink "$fd" 2>/dev/null)" = "$want" ] || continue
        flock -n "${fd##*/}" || err "a descriptor on $lock was inherited, but another install or update of $REMOTLY_HOME holds the lock; try again in a minute"
        log "running under remotly-bridge update's lock"
        return
    done
    mkdir -p "$REMOTLY_HOME"
    exec 9>"$lock"
    flock -n 9 || err "another install or update of $REMOTLY_HOME is running (remotly-bridge update, or its daily timer); try again in a minute"
}

# After an interrupted or killed run, app/ or node/ may be missing while the previous copy sits beside it: put it back.
recover_interrupted() {
    if [ ! -d "$APP" ] && [ -d "$APP.prev" ]; then mv "$APP.prev" "$APP"; fi
    if [ ! -d "$REMOTLY_HOME/node" ] && [ -d "$REMOTLY_HOME/node.old" ]; then mv "$REMOTLY_HOME/node.old" "$REMOTLY_HOME/node"; fi
}

# Single-quote for a generated shell script: ' → '\'' ; the paths went through check_paths, so no newline can be inside.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The same characters `remotly-bridge setup` refuses in a unit file, checked before anything is downloaded or replaced.
check_paths() {
    nl="$(printf '\n.')"; nl="${nl%.}"
    for v in "$REMOTLY_HOME" "$BIN_DIR" "${REMOTLY_NODE:-}"; do
        case "$v" in *"$nl"*|*'$'*|*'"'*|*\\*) err "install paths must not contain a newline, \$, \" or \\ (got: $v)" ;; esac
    done
    case "$REMOTLY_HOME" in /*) ;; *) err "REMOTLY_HOME must be an absolute path (got $REMOTLY_HOME)" ;; esac
    case "$BIN_DIR" in /*) ;; *) err "REMOTLY_BIN_DIR must be an absolute path (got $BIN_DIR)" ;; esac
    case "${REMOTLY_NODE:-/}" in /*) ;; *) err "REMOTLY_NODE must be an absolute path (got $REMOTLY_NODE): the launcher and the service run from any directory" ;; esac
}

# ---- node -------------------------------------------------------------------------------------

node_ok() {
    [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
}

# NODE: a runtime whose path stays valid for the systemd unit. Version-manager shims (fnm, nvm, volta, mise) are
# per-shell, so only a distribution package under /usr, /opt, /bin or /snap counts — any such directory on PATH, then
# the usual fixed locations. Without one, a private Node 24 lives under $REMOTLY_HOME/node and is refreshed from
# nodejs.org on later runs; a distribution package installed later takes over from it.
find_node() {
    if [ -n "${REMOTLY_NODE:-}" ]; then
        node_ok "$REMOTLY_NODE" || err "REMOTLY_NODE=$REMOTLY_NODE is not Node 24 or newer"
        NODE="$REMOTLY_NODE"; log "using node $NODE"; return
    fi
    private="$REMOTLY_HOME/node/bin/node"
    if sys="$(find_system_node)" && [ -n "$sys" ]; then
        NODE="$sys"; log "using system node $("$NODE" --version) at $NODE"
        if [ -x "$private" ]; then log "the private runtime under $REMOTLY_HOME/node is no longer needed (remove it after the next setup: rm -r $(sq "$REMOTLY_HOME/node"))"; fi
        return 0
    fi
    if node_ok "$private"; then
        refresh_private_node
        NODE="$private"; log "using node $("$NODE" --version) at $NODE"; return
    fi
    arch="$(node_arch)" || err "no Node 24 or newer on this system and nodejs.org has no build for $(uname -m): install Node 24 from your distribution, or set REMOTLY_NODE=/path/to/node"
    log "no Node 24 or newer on this system; fetching the release list from nodejs.org..."
    node_latest_line "$arch" || err "cannot reach $NODE_DIST (or it lists no Node 24 tarball for linux-$arch)"
    download_node
    NODE="$private"
}

find_system_node() {
    old_ifs="$IFS"; IFS=:
    for d in $PATH /usr/local/bin /usr/bin /snap/bin /opt/node/bin; do
        case "$d" in
            /usr/*|/bin|/bin/*|/opt/*|/snap/*) if node_ok "$d/node"; then IFS="$old_ifs"; printf '%s' "$d/node"; return 0; fi ;;
        esac
    done
    IFS="$old_ifs"
    return 1
}

# The architectures nodejs.org builds for; any other Linux runs the bridge on its own Node 24 (REMOTLY_NODE or a package).
node_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo x64 ;;
        aarch64|arm64) echo arm64 ;;
        *) return 1 ;;
    esac
}

# LINE="<sha256>  node-v24.x.y-linux-<arch>.tar.gz" for the newest 24.x on nodejs.org; fails when unreachable.
node_latest_line() {
    sums="$($CURL "$NODE_DIST/SHASUMS256.txt")" || return 1
    LINE="$(printf '%s\n' "$sums" | awk -v want="-linux-$1.tar.gz" 'index($2, "node-v24.") == 1 && substr($2, length($2) - length(want) + 1) == want { print; exit }')"
    [ -n "$LINE" ]
}

# A private runtime is only as current as its last download: when nodejs.org lists a newer 24.x, swap it in; when
# nodejs.org cannot be reached, keep the one that works.
refresh_private_node() {
    arch="$(node_arch)" || return 0
    have="$("$private" --version)"
    if ! node_latest_line "$arch"; then warn "cannot reach $NODE_DIST to check for a newer Node 24; keeping $have"; return 0; fi
    latest="${LINE##* }"; latest="${latest#node-}"; latest="${latest%-linux-*}"
    [ "$latest" = "$have" ] && return 0
    log "node $have is behind $latest; updating the private runtime"
    download_node
}

download_node() {   # needs LINE from node_latest_line
    sum="${LINE%% *}"; file="${LINE##* }"
    log "downloading $file..."
    $CURL --max-time 600 -o "$TMP/$file" "$NODE_DIST/$file" || err "download failed: $NODE_DIST/$file"
    verify "$TMP/$file" "$sum"
    rm -rf "$REMOTLY_HOME/node.new"; mkdir -p "$REMOTLY_HOME/node.new"
    tar -xzf "$TMP/$file" -C "$REMOTLY_HOME/node.new" --strip-components=1 || err "could not extract $file"
    node_ok "$REMOTLY_HOME/node.new/bin/node" || err "the downloaded node does not run on this machine"
    # The bridge needs bin/node and lib alone: drop headers, docs and the bundled npm/corepack (~90 MB).
    rm -rf "$REMOTLY_HOME/node.new/include" "$REMOTLY_HOME/node.new/share" "$REMOTLY_HOME/node.new/lib/node_modules" \
        "$REMOTLY_HOME/node.new/bin/npm" "$REMOTLY_HOME/node.new/bin/npx" "$REMOTLY_HOME/node.new/bin/corepack"
    # Two renames; `recover_interrupted` puts node.old back if the second one never happens (also on the next run).
    rm -rf "$REMOTLY_HOME/node.old"
    [ -d "$REMOTLY_HOME/node" ] && mv "$REMOTLY_HOME/node" "$REMOTLY_HOME/node.old"
    mv "$REMOTLY_HOME/node.new" "$REMOTLY_HOME/node"
    rm -rf "$REMOTLY_HOME/node.old"
    log "node $("$REMOTLY_HOME/node/bin/node" --version) installed under $REMOTLY_HOME/node"
}

# ---- bridge -----------------------------------------------------------------------------------

resolve_version() {
    if [ -n "${REMOTLY_VERSION:-}" ]; then
        VERSION="${REMOTLY_VERSION#bridge-v}"; VERSION="${VERSION#v}"; return
    fi
    # GitHub answers /releases/latest with a redirect to the tag; only bridge releases are GitHub Releases.
    loc="$(curl -fsSI --retry 3 --connect-timeout 10 --max-time 60 -o /dev/null -w '%{redirect_url}' "$RELEASES/latest")" \
        || err "cannot reach $RELEASES/latest (no release yet, or offline); pin one with REMOTLY_VERSION=0.1.0"
    case "$loc" in
        */releases/tag/bridge-v*) VERSION="${loc##*/releases/tag/bridge-v}" ;;
        *) err "could not read the latest release from '$loc'; pin one with REMOTLY_VERSION=0.1.0" ;;
    esac
}

installed_version() {
    [ -f "$APP/package.json" ] && awk -F'"' '/"version":/ { print $4; exit }' "$APP/package.json"
}

install_app() {
    # A repository checkout deployed by ci/deploy-bridge.sh has the bridge under app/bridge/; replacing it here would
    # leave that pipeline and this installer fighting over the directory and the launcher.
    if [ -f "$APP/bridge/src/main.ts" ] && [ "${REMOTLY_FORCE:-0}" != 1 ]; then
        err "$APP holds a repository deploy (bridge/ inside it), not an installed release; stop that pipeline and set REMOTLY_FORCE=1 to replace it"
    fi
    if [ "$(installed_version)" = "$VERSION" ] && [ -f "$APP/src/main.ts" ] && [ "${REMOTLY_FORCE:-0}" != 1 ]; then
        log "remotly-bridge $VERSION is already installed in $APP"
        return
    fi
    base="$RELEASES/download/bridge-v$VERSION"; file="remotly-bridge-$VERSION.tar.gz"
    log "downloading remotly-bridge $VERSION..."
    sums="$($CURL "$base/SHA256SUMS")" || err "no SHA256SUMS at $base (is bridge-v$VERSION a published release?)"
    sum="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }')"
    [ -n "$sum" ] || err "SHA256SUMS of bridge-v$VERSION does not list $file"
    $CURL --max-time 600 -o "$TMP/$file" "$base/$file" || err "download failed: $base/$file"
    verify "$TMP/$file" "$sum"
    rm -rf "$APP.new"; mkdir -p "$APP.new"
    tar -xzf "$TMP/$file" -C "$APP.new" --strip-components=1 || err "could not extract $file"
    { [ -f "$APP.new/src/main.ts" ] && [ -d "$APP.new/node_modules" ]; } || err "unexpected tarball layout"
    # Keep the previous copy in app.prev (`remotly-bridge update` rolls back onto it; by hand, this installer pinned to
    # that version puts it back — never `mv` over a present app/, which nests); the one before that goes.
    # Two renames; `recover_interrupted` puts app.prev back if the second one never happens — from the trap when this
    # run is interrupted, or at the start of the next run after a power loss (the unit and launcher point at app/).
    rm -rf "$APP.prev"
    [ -d "$APP" ] && mv "$APP" "$APP.prev"
    mv "$APP.new" "$APP"
    log "remotly-bridge $VERSION installed in $APP"
}

write_launcher() {
    mkdir -p "$BIN_DIR"
    printf '#!/bin/sh\nexec %s %s "$@"\n' "$(sq "$NODE")" "$(sq "$APP/src/main.ts")" > "$BIN_DIR/remotly-bridge.tmp"
    chmod 755 "$BIN_DIR/remotly-bridge.tmp"
    mv -f "$BIN_DIR/remotly-bridge.tmp" "$BIN_DIR/remotly-bridge"
    log "launcher $BIN_DIR/remotly-bridge"
}

# ---- helpers ----------------------------------------------------------------------------------

pick_sha_tool() {
    if command -v sha256sum >/dev/null 2>&1; then SHA=sha256sum
    elif command -v shasum >/dev/null 2>&1; then SHA=shasum
    elif command -v openssl >/dev/null 2>&1; then SHA=openssl
    else err "SHA-256 verification needs sha256sum, shasum or openssl"
    fi
}

verify() {
    want="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
    printf '%s\n' "$want" | awk 'length($0) != 64 || /[^0-9a-f]/ { exit 1 }' || err "malformed checksum for $(basename "$1")"
    case "$SHA" in
        sha256sum) got="$(sha256sum < "$1" | awk '{ print $1 }')" ;;
        shasum) got="$(shasum -a 256 < "$1" | awk '{ print $1 }')" ;;
        openssl) got="$(openssl dgst -sha256 < "$1" | awk '{ print $NF }')" ;;
    esac
    [ "$got" = "$want" ] || err "checksum mismatch for $(basename "$1") — not installed"
}

need() { command -v "$1" >/dev/null 2>&1 || err "requires '$1'; install it first"; }
log()  { printf '  \033[32m>\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
err()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

main "$@"
