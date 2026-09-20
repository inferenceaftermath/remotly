#!/usr/bin/env bash
# bridge/scripts/release-plan.sh (and tag-commit.sh) against a throwaway repository and origin: a run on main releases a
# version without a release (no tag yet, or a tag already at this commit), does nothing for a released one, and fails for
# a tag at another commit; any other ref releases nothing. RELEASE_EXISTS stands in for `gh release view`.
# Run: bash ci/test/release-plan.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail() { echo "FAIL: $*" >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else fail "$1: expected [$2], got [$3]"; fi; }
# The script reads bridge/package.json beside itself: a copy of the script in a repository of its own.
mkdir -p "$tmp/repo/bridge/scripts" && cp "$here/bridge/scripts/release-plan.sh" "$here/bridge/scripts/tag-commit.sh" "$tmp/repo/bridge/scripts/"
cd "$tmp/repo" && git init -q . && git init -q --bare "$tmp/origin.git" && git remote add origin "$tmp/origin.git"
echo '{"name":"remotly-bridge","version":"0.3.0"}' > bridge/package.json
git add -A && git commit -q -m "bridge 0.3.0" && head="$(git rev-parse HEAD)"
git commit -q --allow-empty -m "later" && later="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/main
# plan <ref> <sha> <RELEASE_EXISTS>: the three outputs on one line, or "error"
plan() {
  : > "$tmp/output"
  if env GITHUB_REF="$1" GITHUB_SHA="$2" GITHUB_OUTPUT="$tmp/output" RELEASE_EXISTS="$3" bash bridge/scripts/release-plan.sh > "$tmp/log" 2>&1; then paste -sd' ' "$tmp/output"; else echo "error"; fi
}
tagc() { bash bridge/scripts/tag-commit.sh "$1"; }
check "tag-commit: no tag → nothing"                        "" "$(tagc bridge-v0.3.0)"
check "main, no tag, no release: release"                   "version=0.3.0 tag=bridge-v0.3.0 release=true" "$(plan refs/heads/main "$later" false)"
grep -q "no release and no tag" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
check "main, released already: nothing"                     "version=0.3.0 tag=bridge-v0.3.0 release=false" "$(plan refs/heads/main "$later" true)"
grep -q "released already" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
git push -q origin "$later:refs/tags/bridge-v0.3.0"
check "tag-commit: a lightweight tag"                       "$later" "$(tagc bridge-v0.3.0)"
check "main, a lightweight tag at this commit: release"     "version=0.3.0 tag=bridge-v0.3.0 release=true" "$(plan refs/heads/main "$later" false)"
grep -q "at this commit without a release" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
check "main, the tag at another commit: an error"           "error" "$(plan refs/heads/main "$head" false)"
grep -q "bump bridge/package.json" "$tmp/log" || fail "no advice: $(cat "$tmp/log")"
git push -q --delete origin refs/tags/bridge-v0.3.0
git tag -a -m "release" bridge-v0.3.0 "$later" && git push -q origin refs/tags/bridge-v0.3.0
check "tag-commit: an annotated tag is peeled"              "$later" "$(tagc bridge-v0.3.0)"
check "main, an annotated tag at this commit: release"      "version=0.3.0 tag=bridge-v0.3.0 release=true" "$(plan refs/heads/main "$later" false)"
check "a tag ref: nothing (tags are not pushed by hand)"    "version=0.3.0 tag=bridge-v0.3.0 release=false" "$(plan refs/tags/bridge-v0.3.0 "$later" false)"
check "another branch: nothing"                             "version=0.3.0 tag=bridge-v0.3.0 release=false" "$(plan refs/heads/feature "$later" false)"
# A prerelease version is a version like any other here (release.yml marks the release as a prerelease).
echo '{"name":"remotly-bridge","version":"0.4.0-rc.1"}' > bridge/package.json && git commit -qam "rc" && rc="$(git rev-parse HEAD)"
check "a prerelease version"                                "version=0.4.0-rc.1 tag=bridge-v0.4.0-rc.1 release=true" "$(plan refs/heads/main "$rc" false)"
git remote set-url origin "$tmp/nowhere.git"
if tagc bridge-v0.3.0 > /dev/null 2>&1; then fail "tag-commit: an unreadable origin must be an error"; fi
check "an unreadable origin fails the plan"                 "error" "$(plan refs/heads/main "$rc" false)"
git remote set-url origin "$tmp/origin.git"
if env GITHUB_REF=refs/heads/main GITHUB_SHA="$rc" bash bridge/scripts/release-plan.sh > /dev/null 2>&1; then fail "a missing GITHUB_OUTPUT must be an error"; fi
echo "ok   a missing GITHUB_OUTPUT is an error"
echo "release-plan.test.sh: all cases passed"
