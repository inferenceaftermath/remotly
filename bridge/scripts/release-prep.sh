#!/usr/bin/env bash
# Prepare a bridge release: bridge/package.json and its lock go to <version>, CHANGELOG.md must hold the notes under
# `### Bridge <version>`, and a pull request is opened whose merge releases (release.yml plans from the version).
# Run at the root of a clean checkout of main, with npm and a `gh` allowed to push and open pull requests.
# Usage: bridge/scripts/release-prep.sh X.Y.Z[-rc.1]
set -euo pipefail
ver=${1:?usage: bridge/scripts/release-prep.sh X.Y.Z[-rc.1]}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$root"
case "$ver" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "not a version: $ver (X.Y.Z, optionally -rc.1)" >&2; exit 2 ;; esac
[ -z "$(git status --porcelain)" ] || { echo "the checkout has uncommitted changes; commit or stash them first" >&2; exit 1; }
current=$(node -p "require('./bridge/package.json').version")
[ "$current" != "$ver" ] || { echo "bridge/package.json is $ver already" >&2; exit 1; }
heading="### Bridge $ver"
if ! grep -qxF -e "$heading" CHANGELOG.md && ! grep -qF -e "$heading " CHANGELOG.md; then
  awk -v h="$heading" '{ print } /^## Unreleased$/ { print ""; print h; print ""; print "- (release notes)" }' CHANGELOG.md > CHANGELOG.md.new
  mv CHANGELOG.md.new CHANGELOG.md
  echo "CHANGELOG.md: '$heading' added under Unreleased — write the notes there (replace the placeholder), then run this again" >&2; exit 1
fi
notes=$(bridge/scripts/release-notes.sh "$ver")   # fails when the section is empty
case "$notes" in *"(release notes)"*) echo "CHANGELOG.md: the '$heading' section still holds the placeholder — write the notes" >&2; exit 1 ;; esac
(cd bridge && npm version "$ver" --no-git-tag-version > /dev/null)
branch="release/bridge-$ver"
git checkout -q -b "$branch"
git add bridge/package.json bridge/package-lock.json CHANGELOG.md
git commit -q -m "Bridge $ver" -m "$notes"
git push -q -u origin "$branch"
body=$(printf 'Merging releases bridge-v%s: release.yml runs the tests, packages, checks the installer, then creates the tag and the GitHub Release with these notes.\n\n%s' "$ver" "$notes")
gh pr create --base main --head "$branch" --title "Bridge $ver" --body "$body"
