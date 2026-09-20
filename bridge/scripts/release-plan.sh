#!/usr/bin/env bash
# Decide whether this run releases the bridge, and as which tag (first job of release.yml). Inputs (env): GITHUB_REF,
# GITHUB_SHA, GITHUB_OUTPUT, GITHUB_REPOSITORY; the `origin` remote for the tag; `gh` for the release (RELEASE_EXISTS=
# true|false stands in for it in tests). Outputs: version, tag, release (true|false).
#   A run on main (a push, or `gh workflow run release.yml`) releases when bridge/package.json names a version with no
#   GitHub Release yet — the merge of a version bump (bridge/scripts/release-prep.sh). The tag is created by the release
#   job at this commit, or is already there. A tag at another commit without a release cannot be released from here
#   (the tag ruleset forbids moving it): the plan fails until the version is bumped. Any other ref releases nothing.
# Test: ci/test/release-plan.test.sh.
set -euo pipefail
: "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_OUTPUT:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ver=$(node -p "require('$here/../package.json').version")
tag="bridge-v$ver"
out() { # out <release>
  { echo "version=$ver"; echo "tag=$tag"; echo "release=$1"; } >> "$GITHUB_OUTPUT"
  echo "release plan: $tag release=$1"
}
release_exists() {
  case "${RELEASE_EXISTS:-}" in true) return 0 ;; false) return 1 ;; esac
  local said
  if said=$(gh release view "$tag" --repo "${GITHUB_REPOSITORY:?}" 2>&1 >/dev/null); then return 0; fi
  case "$said" in *"not found"*|*"Not Found"*) return 1 ;; esac
  echo "cannot tell whether $tag is released: $said" >&2; exit 1   # an unreadable GitHub fails the plan rather than guess
}
[ "$GITHUB_REF" = refs/heads/main ] || { echo "not main: $GITHUB_REF"; out false; exit 0; }
if release_exists; then echo "$tag is released already"; out false; exit 0; fi
at=$("$here/tag-commit.sh" "$tag")
if [ -z "$at" ]; then
  echo "$ver has no release and no tag: releasing from this commit"; out true
elif [ "$at" = "$GITHUB_SHA" ]; then
  echo "$tag is at this commit without a release: releasing"; out true
else
  echo "$tag exists at $at, not at this commit, and has no release; the tag ruleset forbids moving it — bump bridge/package.json to a new version (bridge/README.md, Releases)" >&2; exit 1
fi
