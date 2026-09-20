#!/usr/bin/env bash
# The commit a tag on origin points at (an annotated tag peeled), or nothing when there is no such tag; an unreadable
# origin is an error. Used by release-plan.sh and release.yml. Usage: bridge/scripts/tag-commit.sh <tag>
set -euo pipefail
tag=${1:?usage: bridge/scripts/tag-commit.sh <tag>}
git ls-remote --exit-code origin "refs/tags/$tag" "refs/tags/$tag^{}" 2>/dev/null \
  | awk '/\^\{\}$/ { peeled = $1 } !/\^\{\}$/ { plain = $1 } END { print (peeled != "" ? peeled : plain) }' \
  || { s=$?; [ "$s" -eq 2 ] || { echo "git ls-remote origin refs/tags/$tag failed ($s)" >&2; exit "$s"; }; }
