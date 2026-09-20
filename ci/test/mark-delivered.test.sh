#!/usr/bin/env bash
# ci/mark-delivered.sh against a throwaway origin with both markers seeded: `record` moves one lane's marker to HEAD
# (forward, and back over a rewritten history) and leaves the others; `forget` removes one marker (and is fine without
# one); bad arguments are errors. Run: bash ci/test/mark-delivered.test.sh
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
git commit -q --allow-empty -m three && three="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/main
marker() { git ls-remote origin "refs/delivered/$1" | cut -f1; }
markers() { echo "android=$(marker android) ios=$(marker ios)"; }
mark() { bash "$here/ci/mark-delivered.sh" "$@"; }
git push -q origin "$one:refs/delivered/android" "$two:refs/delivered/ios"
mark record android > "$tmp/log"
check "record: android at HEAD, the other as it was" "android=$three ios=$two" "$(markers)"
grep -q "refs/delivered/android → $three" "$tmp/log" || fail "no confirmation: $(cat "$tmp/log")"
git checkout -q "$one"
mark record android > /dev/null
check "record moves backwards too (it states what was delivered)" "android=$one ios=$two" "$(markers)"
git checkout -q --orphan other && git commit -q --allow-empty -m other && other="$(git rev-parse HEAD)"
mark record ios > /dev/null
check "record onto a rewritten history" "android=$one ios=$other" "$(markers)"
mark forget ios > "$tmp/log"
check "forget: the ios marker is gone, the other stays" "android=$one ios=" "$(markers)"
grep -q "refs/delivered/ios forgotten" "$tmp/log" || fail "no confirmation: $(cat "$tmp/log")"
mark forget ios > "$tmp/log"
check "forget without a marker is fine" "android=$one ios=" "$(markers)"
grep -q "no marker yet" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
mark record ios > /dev/null
check "record after forget" "android=$one ios=$other" "$(markers)"
for bad in "record relay" "record bridge" "start ios" "record" "ios" ""; do
  # shellcheck disable=SC2086
  if mark $bad 2>/dev/null; then fail "[$bad] must be an error"; fi
done
echo "ok   bad arguments are errors"
git remote set-url origin "$tmp/nowhere.git"
if mark forget ios 2>/dev/null; then fail "an unreadable origin must be an error"; fi
echo "ok   an unreadable origin is an error"
echo "mark-delivered.test.sh: all cases passed"
