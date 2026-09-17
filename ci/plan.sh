#!/usr/bin/env bash
# Decide which delivery jobs a push needs and emit them as step outputs.
# Inputs (env): EVENT (push|workflow_dispatch), BEFORE (sha before the push), IN_ANDROID/IN_IOS/IN_BRIDGE
# (dispatch inputs), GITHUB_RUN_NUMBER, GITHUB_OUTPUT.
set -euo pipefail

android=false ios=false bridge=false
if [ "${EVENT:-push}" = "workflow_dispatch" ]; then
  android=${IN_ANDROID:-false}; ios=${IN_IOS:-false}; bridge=${IN_BRIDGE:-false}
elif [ -z "${BEFORE:-}" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
  echo "no usable base commit (${BEFORE:-none}); delivering everything"
  android=true ios=true bridge=true
else
  changed=$(git diff --name-only "$BEFORE" HEAD)
  echo "changed since $BEFORE:"; printf '  %s\n' $changed
  while IFS= read -r f; do
    case "$f" in
      docs/*|*.md|.gitignore|scratchpad/*) ;;                         # never triggers a delivery
      ci/setup-*) ;;                                                  # runner installers: no delivery
      .github/*|ci/*) android=true ios=true bridge=true ;;            # pipeline itself changed → deliver all
      shared/*) android=true ios=true bridge=true ;;                  # protocol shared by all three
      android/*) android=true ;;
      ios/*) ios=true ;;
      bridge/*) bridge=true ;;
      *) android=true ios=true bridge=true ;;                         # anything unclassified → be safe
    esac
  done <<< "$changed"
fi

build_number=$GITHUB_RUN_NUMBER   # fresh app records since the 2026-09-07 move: the run number is the build number
{
  echo "android=$android"; echo "ios=$ios"; echo "bridge=$bridge"; echo "build_number=$build_number"
} >> "$GITHUB_OUTPUT"
echo "plan: android=$android ios=$ios bridge=$bridge build_number=$build_number"
