#!/usr/bin/env bash
# The release notes of a bridge version: the body of CHANGELOG.md's `### Bridge <version>` section (the heading alone or
# with a suffix, up to the next heading of level one to three). release.yml puts them on the GitHub Release;
# release-prep.sh checks they exist. Exit 1 with a message when the heading is missing or the section is empty.
# Usage: bridge/scripts/release-notes.sh <version> [changelog]. Test: ci/test/release-notes.test.sh.
set -euo pipefail
ver=${1:?usage: bridge/scripts/release-notes.sh <version> [CHANGELOG.md]}
file=${2:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/CHANGELOG.md"}
heading="### Bridge $ver"
grep -qxF -e "$heading" "$file" || grep -qF -e "$heading " "$file" || { echo "$file has no '$heading' section" >&2; exit 1; }
# From the heading (exclusive) to the next heading (exclusive), leading blank lines dropped; $(…) drops the trailing ones.
notes=$(awk -v h="$heading" '
  !on { if ($0 == h || index($0, h " ") == 1) on = 1; next }
  /^#{1,3} / { exit }
  { print }' "$file" | sed '/./,$!d')
[ -n "$notes" ] || { echo "the '$heading' section of $file is empty" >&2; exit 1; }
printf '%s\n' "$notes"
