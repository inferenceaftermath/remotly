#!/usr/bin/env bash
# bridge/scripts/release-plan.sh against a throwaway repository and origin: a push to main releases a version without a
# release (creating the tag, or using a tag already at this commit), does nothing for a released one, and fails for a tag
# at another commit; a pushed tag releases when it matches package.json and is not released yet; anything else is an
# error or a no-op. RELEASE_EXISTS stands in for `gh release view`. Run: bash ci/test/release-plan.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail() { echo "FAIL: $*" >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else fail "$1: expected [$2], got [$3]"; fi; }
# The script reads bridge/package.json beside itself: a copy of the script in a repository of its own.
mkdir -p "$tmp/repo/bridge/scripts" && cp "$here/bridge/scripts/release-plan.sh" "$tmp/repo/bridge/scripts/"
cd "$tmp/repo" && git init -q . && git init -q --bare "$tmp/origin.git" && git remote add origin "$tmp/origin.git"
echo '{"name":"remotly-bridge","version":"0.3.0"}' > bridge/package.json
git add -A && git commit -q -m "bridge 0.3.0" && head="$(git rev-parse HEAD)"
git commit -q --allow-empty -m "later" && later="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/main
# plan <ref> <sha> <RELEASE_EXISTS>: the four outputs on one line, or "error"
plan() {
  : > "$tmp/output"
  if env GITHUB_REF="$1" GITHUB_SHA="$2" GITHUB_OUTPUT="$tmp/output" RELEASE_EXISTS="$3" bash bridge/scripts/release-plan.sh > "$tmp/log" 2>&1; then paste -sd' ' "$tmp/output"; else echo "error"; fi
}
check "main, no tag, no release: release, create the tag"  "version=0.3.0 tag=bridge-v0.3.0 release=true verify_tag=false" "$(plan refs/heads/main "$later" false)"
check "main, released already: nothing"                    "version=0.3.0 tag=bridge-v0.3.0 release=false verify_tag=false" "$(plan refs/heads/main "$later" true)"
grep -q "released already" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
git push -q origin "$later:refs/tags/bridge-v0.3.0"
check "main, a lightweight tag at this commit: release with it" "version=0.3.0 tag=bridge-v0.3.0 release=true verify_tag=true" "$(plan refs/heads/main "$later" false)"
check "main, the tag at another commit: an error"           "error" "$(plan refs/heads/main "$head" false)"
grep -q "bump bridge/package.json" "$tmp/log" || fail "no advice: $(cat "$tmp/log")"
git push -q --delete origin refs/tags/bridge-v0.3.0
git tag -a -m "release" bridge-v0.3.0 "$later" && git push -q origin refs/tags/bridge-v0.3.0
check "main, an annotated tag at this commit (peeled)"      "version=0.3.0 tag=bridge-v0.3.0 release=true verify_tag=true" "$(plan refs/heads/main "$later" false)"
check "a pushed tag that matches: release"                  "version=0.3.0 tag=bridge-v0.3.0 release=true verify_tag=true" "$(plan refs/tags/bridge-v0.3.0 "$later" false)"
check "a pushed tag, released already: nothing"             "version=0.3.0 tag=bridge-v0.3.0 release=false verify_tag=true" "$(plan refs/tags/bridge-v0.3.0 "$later" true)"
check "a pushed tag that does not match: an error"          "error" "$(plan refs/tags/bridge-v0.2.9 "$later" false)"
grep -q "does not match bridge/package.json version 0.3.0" "$tmp/log" || fail "no message: $(cat "$tmp/log")"
check "another branch: nothing"                             "version=0.3.0 tag=bridge-v0.3.0 release=false verify_tag=false" "$(plan refs/heads/feature "$later" false)"
# A prerelease version is a version like any other here (release.yml marks the release as a prerelease).
echo '{"name":"remotly-bridge","version":"0.4.0-rc.1"}' > bridge/package.json && git commit -qam "rc" && rc="$(git rev-parse HEAD)"
check "a prerelease version"                                "version=0.4.0-rc.1 tag=bridge-v0.4.0-rc.1 release=true verify_tag=false" "$(plan refs/heads/main "$rc" false)"
if env GITHUB_REF=refs/heads/main GITHUB_SHA="$rc" bash bridge/scripts/release-plan.sh > /dev/null 2>&1; then fail "a missing GITHUB_OUTPUT must be an error"; fi
echo "ok   a missing GITHUB_OUTPUT is an error"
echo "release-plan.test.sh: all cases passed"
