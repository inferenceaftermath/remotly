#!/usr/bin/env bash
# bridge/scripts/release-plan.sh (and tag-commit.sh) against a throwaway repository and origin: a run on main releases a
# version without a release at the commit that introduced it (no tag yet, or a tag already at that commit), does nothing
# for a released one, fails for a tag at another commit, and marks the release latest unless a higher version is
# released; any other ref releases nothing. RELEASES (lines of "<tag> <prerelease>") stands in for `gh api`.
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
echo '{"name":"remotly-bridge","version":"0.2.0"}' > bridge/package.json
git add -A && git commit -q -m "bridge 0.2.0"
echo '{"name":"remotly-bridge","version":"0.3.0"}' > bridge/package.json
git commit -qam "bridge 0.3.0" && bump="$(git rev-parse HEAD)"
git commit -q --allow-empty -m "later" && later="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/main
# plan <ref> <sha> <RELEASES>: the outputs on one line, or "error"
plan() {
  : > "$tmp/output"
  if env GITHUB_REF="$1" GITHUB_SHA="$2" GITHUB_OUTPUT="$tmp/output" RELEASES="$3" bash bridge/scripts/release-plan.sh > "$tmp/log" 2>&1; then paste -sd' ' "$tmp/output"; else echo "error"; fi
}
tagc() { bash bridge/scripts/tag-commit.sh "$1"; }
v3="version=0.3.0 tag=bridge-v0.3.0"
check "tag-commit: no tag → nothing"                          "" "$(tagc bridge-v0.3.0)"
check "main, no tag, no release: release at the bump commit"  "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$later" "")"
grep -q "no release and no tag" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
grep -q "was introduced at $bump" "$tmp/log" || fail "no note about the bump commit: $(cat "$tmp/log")"
check "main at the bump commit itself: release there"         "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$bump" "")"
check "main, released already: nothing"                       "$v3 sha=$later release=false latest=false" "$(plan refs/heads/main "$later" "bridge-v0.3.0 false")"
grep -q "released already" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
check "released as a prerelease already: nothing"             "$v3 sha=$later release=false latest=false" "$(plan refs/heads/main "$later" "bridge-v0.3.0 true")"
check "a lower version released: release, latest"             "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$later" "bridge-v0.2.0 false")"
check "a higher version released: release, not latest"        "$v3 sha=$bump release=true latest=false" "$(plan refs/heads/main "$later" $'bridge-v0.2.0 false\nbridge-v0.4.0 false')"
grep -q "0.4.0 is released already and stays /releases/latest" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
check "a higher prerelease only: release, latest"             "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$later" "bridge-v0.4.0-rc.1 true")"
check "a higher two-digit version: sorted as versions"        "$v3 sha=$bump release=true latest=false" "$(plan refs/heads/main "$later" "bridge-v0.10.0 false")"
git push -q origin "$bump:refs/tags/bridge-v0.3.0"
check "tag-commit: a lightweight tag"                         "$bump" "$(tagc bridge-v0.3.0)"
check "main, a lightweight tag at the bump commit: release"   "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$later" "")"
grep -q "at $bump without a release" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
git push -q --delete origin refs/tags/bridge-v0.3.0
git push -q origin "$later:refs/tags/bridge-v0.3.0"
check "main, the tag at a later commit: an error"             "error" "$(plan refs/heads/main "$later" "")"
grep -q "bump bridge/package.json" "$tmp/log" || fail "no advice: $(cat "$tmp/log")"
check "main, the tag at another commit: an error"             "error" "$(plan refs/heads/main "$bump" "")"
git push -q --delete origin refs/tags/bridge-v0.3.0
git tag -a -m "release" bridge-v0.3.0 "$bump" && git push -q origin refs/tags/bridge-v0.3.0
check "tag-commit: an annotated tag is peeled"                "$bump" "$(tagc bridge-v0.3.0)"
check "main, an annotated tag at the bump commit: release"    "$v3 sha=$bump release=true latest=true" "$(plan refs/heads/main "$later" "")"
check "a tag ref: nothing (tags are not pushed by hand)"      "$v3 sha=$later release=false latest=false" "$(plan refs/tags/bridge-v0.3.0 "$later" "")"
check "another branch: nothing"                               "$v3 sha=$later release=false latest=false" "$(plan refs/heads/feature "$later" "")"
# A prerelease version is a version like any other here (release.yml marks the release as a prerelease), never latest.
echo '{"name":"remotly-bridge","version":"0.4.0-rc.1"}' > bridge/package.json && git commit -qam "rc" && rc="$(git rev-parse HEAD)"
check "a prerelease version: release, not latest"             "version=0.4.0-rc.1 tag=bridge-v0.4.0-rc.1 sha=$rc release=true latest=false" "$(plan refs/heads/main "$rc" "")"
# The version taken back to a released one releases nothing; bumped again, the new bump commit is the one released.
echo '{"name":"remotly-bridge","version":"0.2.0"}' > bridge/package.json && git commit -qam "back" && back="$(git rev-parse HEAD)"
check "the version taken back to a released one: nothing"     "version=0.2.0 tag=bridge-v0.2.0 sha=$back release=false latest=false" "$(plan refs/heads/main "$back" "bridge-v0.2.0 false")"
echo '{"name":"remotly-bridge","version":"0.5.0"}' > bridge/package.json && git commit -qam "bridge 0.5.0" && bump5="$(git rev-parse HEAD)"
git commit -q --allow-empty -m "later again" && later5="$(git rev-parse HEAD)"
check "bumped again: the new bump commit is released"         "version=0.5.0 tag=bridge-v0.5.0 sha=$bump5 release=true latest=true" "$(plan refs/heads/main "$later5" "bridge-v0.2.0 false")"
git remote set-url origin "$tmp/nowhere.git"
if tagc bridge-v0.3.0 > /dev/null 2>&1; then fail "tag-commit: an unreadable origin must be an error"; fi
check "an unreadable origin fails the plan"                   "error" "$(plan refs/heads/main "$later5" "")"
git remote set-url origin "$tmp/origin.git"
# Without RELEASES the script asks `gh`; one that cannot reach GitHub fails the plan.
mkdir -p "$tmp/stub" && printf '#!/bin/sh\necho "gh: connection refused" >&2; exit 1\n' > "$tmp/stub/gh" && chmod +x "$tmp/stub/gh"
check "unreadable releases (gh fails) fail the plan"          "error" "$( : > "$tmp/output"; if env PATH="$tmp/stub:$PATH" GITHUB_REF=refs/heads/main GITHUB_SHA="$later5" GITHUB_OUTPUT="$tmp/output" GITHUB_REPOSITORY=o/r bash bridge/scripts/release-plan.sh > "$tmp/log" 2>&1; then paste -sd' ' "$tmp/output"; else echo error; fi)"
grep -q "cannot list the releases" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
# A shallow checkout cannot find the bump commit: the plan refuses rather than tag the wrong commit.
git push -q -f origin HEAD:refs/heads/main
git clone -q --depth 1 --branch main "file://$tmp/origin.git" "$tmp/shallow" 2>/dev/null
( cd "$tmp/shallow" && : > "$tmp/output" && if env GITHUB_REF=refs/heads/main GITHUB_SHA="$later5" GITHUB_OUTPUT="$tmp/output" RELEASES="" bash bridge/scripts/release-plan.sh > "$tmp/log" 2>&1; then fail "a shallow checkout must be an error"; fi )
grep -q "full history" "$tmp/log" || fail "no note: $(cat "$tmp/log")"
echo "ok   a shallow checkout is an error"
if env GITHUB_REF=refs/heads/main GITHUB_SHA="$later5" bash bridge/scripts/release-plan.sh > /dev/null 2>&1; then fail "a missing GITHUB_OUTPUT must be an error"; fi
echo "ok   a missing GITHUB_OUTPUT is an error"
echo "release-plan.test.sh: all cases passed"
