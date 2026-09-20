#!/usr/bin/env bash
# ci/lane-guard.sh against a throwaway origin: main's tip delivers, anything else does not — and a stale dispatch
# forgets the lane's marker, a stale push keeps it; an origin that cannot be read is an error. Run: bash ci/test/lane-guard.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail() { echo "FAIL: $*" >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else fail "$1: expected [$2], got [$3]"; fi; }
git init -q --bare "$tmp/origin.git"
mkdir "$tmp/repo" && cd "$tmp/repo" && git init -q . && git remote add origin "$tmp/origin.git"
git commit -q --allow-empty -m one && one="$(git rev-parse HEAD)"
git commit -q --allow-empty -m two && two="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/main "$one:refs/delivered/ios" "$one:refs/delivered/android" "$one:refs/delivered/relay"
marker() { git ls-remote origin "refs/delivered/$1" | cut -f1; }
markers() { echo "android=$(marker android) ios=$(marker ios) relay=$(marker relay)"; }
# guard <lane> [EVENT]: the output line
guard() { : > "$tmp/output"; env EVENT="${2:-push}" GITHUB_OUTPUT="$tmp/output" bash "$here/ci/lane-guard.sh" "$1" > "$tmp/log" 2>&1 || return $?; cat "$tmp/output"; }
check "the tip delivers" "deliver=true" "$(guard ios)"
check "the tip delivers a dispatch too" "deliver=true" "$(guard ios workflow_dispatch)"
check "markers untouched" "android=$one ios=$one relay=$one" "$(markers)"
git checkout -q HEAD~1
check "an older commit does not (push)" "deliver=false" "$(guard ios)"
grep -q "main has moved on to $two" "$tmp/log" || fail "no explanation: $(cat "$tmp/log")"
check "a stale push keeps the marker" "android=$one ios=$one relay=$one" "$(markers)"
check "an older commit does not (dispatch)" "deliver=false" "$(guard ios workflow_dispatch)"
grep -q "this dispatch asked for ios: forgetting its marker" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
check "a stale dispatch forgets its lane's marker, the others stay" "android=$one ios= relay=$one" "$(markers)"
check "…and is fine when there is none" "deliver=false" "$(guard ios workflow_dispatch)"
git checkout -q -
git checkout -q --orphan other && git commit -q --allow-empty -m other
check "another history does not" "deliver=false" "$(guard android)"
check "a stale dispatch from another history forgets too" "deliver=false" "$(guard android workflow_dispatch)"
check "android marker gone" "android= ios= relay=$one" "$(markers)"
check "the relay lane is guarded the same" "deliver=false" "$(guard relay workflow_dispatch)"
check "relay marker gone" "android= ios= relay=" "$(markers)"
for bad in bridge web; do if guard "$bad" >/dev/null 2>&1; then fail "an unknown lane ($bad) must be an error"; fi; done
if GITHUB_OUTPUT="$tmp/output" bash "$here/ci/lane-guard.sh" >/dev/null 2>&1; then fail "a missing lane must be an error"; fi
echo "ok   unknown and missing lanes are errors"
git remote set-url origin "$tmp/nowhere.git"
if guard ios >/dev/null 2>&1; then fail "an unreadable origin must be an error"; fi
echo "ok   an unreadable origin is an error"
echo "lane-guard.test.sh: all cases passed"
