#!/usr/bin/env bash
# Decide whether this run releases the bridge, from which commit, and as which tag (first job of release.yml). Inputs
# (env): GITHUB_REF, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_REPOSITORY; main's full history and the `origin` remote for the
# tag; `gh` for the releases (RELEASES, lines of "<tag> <prerelease>", stands in for it in tests). Outputs: version, tag,
# sha (the commit to release), release (true|false), latest (true|false: whether /releases/latest will point at it).
#   A run on main (a push, or `gh workflow run release.yml`) releases when bridge/package.json names a version with no
#   GitHub Release yet — the merge of a version bump (bridge/scripts/release-prep.sh). The commit released is the one
#   that introduced the version, found by walking main's first parents back from this run's commit: later merges under
#   the same version are not what the version names, and a bump whose merge got no run (skip-ci marker) or whose run
#   failed is released at its own commit by any later run. The tag is created by the release job at that commit, or is
#   already there. A tag at another commit without a release cannot be released from here (the tag ruleset forbids
#   moving it): the plan fails until the version is bumped. Any other ref releases nothing. A version below one released
#   already (runs may finish out of order) is released without becoming /releases/latest.
# Test: ci/test/release-plan.test.sh.
set -euo pipefail
: "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_OUTPUT:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
ver=$(node -p "require('$here/../package.json').version")
tag="bridge-v$ver"
sha="$GITHUB_SHA"; latest=false
out() { # out <release>
  { echo "version=$ver"; echo "tag=$tag"; echo "sha=$sha"; echo "release=$1"; echo "latest=$latest"; } >> "$GITHUB_OUTPUT"
  echo "release plan: $tag release=$1 sha=$sha latest=$latest"
}
version_at() { # version_at <commit>: bridge/package.json's version there, or nothing
  git -C "$root" show "$1:bridge/package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" 2>/dev/null || true
}
[ "$GITHUB_REF" = refs/heads/main ] || { echo "not main: $GITHUB_REF"; out false; exit 0; }
# The releases, one line each: "<tag> <prerelease>". An unreadable GitHub fails the plan rather than guess.
if [ -n "${RELEASES+x}" ]; then releases="$RELEASES"
else
  releases=$(gh api --paginate "repos/${GITHUB_REPOSITORY:?}/releases?per_page=100" --jq '.[] | select(.draft | not) | "\(.tag_name) \(.prerelease)"') \
    || { echo "cannot list the releases of $GITHUB_REPOSITORY" >&2; exit 1; }
fi
if awk -v t="$tag" '$1 == t { found = 1 } END { exit !found }' <<< "$releases"; then echo "$tag is released already"; out false; exit 0; fi
case "$ver" in
  *-*) latest=false ;; # a prerelease is never /releases/latest
  *) top=$({ awk '$2 == "false" { print $1 }' <<< "$releases" | sed -n 's/^bridge-v//p'; echo "$ver"; } | sort -V | tail -1)
     if [ "$top" = "$ver" ]; then latest=true; else latest=false; echo "$top is released already and stays /releases/latest; $ver is released below it"; fi ;;
esac
# The commit that introduced the version: back along the first parents while the version is the same.
[ "$(git -C "$root" rev-parse --is-shallow-repository)" = false ] || { echo "the plan needs main's full history (actions/checkout with fetch-depth: 0)" >&2; exit 1; }
while parent=$(git -C "$root" rev-parse -q --verify "$sha^1" 2>/dev/null) && [ "$(version_at "$parent")" = "$ver" ]; do sha=$parent; done
[ "$sha" = "$GITHUB_SHA" ] || echo "$ver was introduced at $sha; this run's commit $GITHUB_SHA is later under the same version"
at=$("$here/tag-commit.sh" "$tag")
if [ -z "$at" ]; then
  echo "$ver has no release and no tag: releasing $sha"; out true
elif [ "$at" = "$sha" ]; then
  echo "$tag is at $sha without a release: releasing"; out true
else
  echo "$tag exists at $at, not at $sha where $ver was introduced, and has no release; the tag ruleset forbids moving it — bump bridge/package.json to a new version (bridge/README.md, Releases)" >&2; exit 1
fi
