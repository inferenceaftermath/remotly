#!/usr/bin/env bash
# Decide whether this run releases the bridge, and as which tag (first job of release.yml). Inputs (env): GITHUB_REF
# (refs/heads/main or refs/tags/bridge-vX.Y.Z), GITHUB_SHA, GITHUB_OUTPUT, GITHUB_REPOSITORY; the `origin` remote for the
# tag; `gh` for the release (RELEASE_EXISTS=true|false stands in for it in tests). Outputs: version, tag, release
# (true|false), verify_tag (true when the tag exists already and the release must use it).
#   A push to main releases when bridge/package.json names a version with no GitHub Release yet — the merge of a version
#   bump (bridge/scripts/release-prep.sh). The tag is created with the release, or is already at this commit. A tag at
#   another commit without a release cannot be released from here (the tag ruleset forbids moving it): the plan fails
#   until the version is bumped. A tag pushed by hand releases when it matches package.json and is not released yet.
# Test: ci/test/release-plan.test.sh.
set -euo pipefail
: "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_OUTPUT:?}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ver=$(node -p "require('$root/bridge/package.json').version")
tag="bridge-v$ver"
out() { # out <release> <verify_tag>
  { echo "version=$ver"; echo "tag=$tag"; echo "release=$1"; echo "verify_tag=$2"; } >> "$GITHUB_OUTPUT"
  echo "release plan: $tag release=$1 verify_tag=$2"
}
release_exists() {
  case "${RELEASE_EXISTS:-}" in true) return 0 ;; false) return 1 ;; esac
  local said
  if said=$(gh release view "$tag" --repo "${GITHUB_REPOSITORY:?}" 2>&1 >/dev/null); then return 0; fi
  case "$said" in *"not found"*|*"Not Found"*) return 1 ;; esac
  echo "cannot tell whether $tag is released: $said" >&2; exit 1   # an unreadable GitHub fails the plan rather than guess
}
case "$GITHUB_REF" in
  refs/tags/*)
    pushed=${GITHUB_REF#refs/tags/}
    [ "$pushed" = "$tag" ] || { echo "tag $pushed does not match bridge/package.json version $ver" >&2; exit 1; }
    if release_exists; then echo "$tag is released already"; out false true; else out true true; fi ;;
  refs/heads/main)
    if release_exists; then echo "$tag is released already"; out false false; exit 0; fi
    # The tag's commit: the peeled line for an annotated tag, the plain one otherwise.
    at=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | awk '/\^\{\}$/ { peeled = $1 } !/\^\{\}$/ { plain = $1 } END { print (peeled != "" ? peeled : plain) }')
    if [ -z "$at" ]; then
      echo "$ver has no release and no tag: releasing from this commit"; out true false
    elif [ "$at" = "$GITHUB_SHA" ]; then
      echo "$tag is at this commit without a release: releasing"; out true true
    else
      echo "$tag exists at $at, not at this commit, and has no release; the tag ruleset forbids moving it — bump bridge/package.json to a new version (bridge/README.md, Releases)" >&2; exit 1
    fi ;;
  *) echo "neither main nor a bridge tag: $GITHUB_REF"; out false false ;;
esac
