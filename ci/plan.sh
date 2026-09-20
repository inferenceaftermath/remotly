#!/usr/bin/env bash
# Decide which delivery lanes a run needs and emit them as step outputs.
# Inputs (env): EVENT (push|workflow_dispatch), IN_ANDROID/IN_IOS/IN_RELAY (dispatch inputs), GITHUB_RUN_NUMBER,
# GITHUB_OUTPUT; the `origin` remote: main's tip, and one marker per lane — refs/delivered/<lane>, moved by
# ci/mark-delivered.sh to the commit a lane last delivered — which is what each lane's diff is taken from.
# Test: ci/test/plan.test.sh.
set -euo pipefail
android=false ios=false relay=false

# ancestor <a> <b>: 0 when a is an ancestor of b, 1 when not; git failing for any other reason fails the plan.
ancestor() {
  local s=0
  git merge-base --is-ancestor "$1" "$2" || s=$?
  [ "$s" -le 1 ] || { echo "git merge-base --is-ancestor $1 $2 failed ($s)" >&2; exit "$s"; }
  return "$s"
}

# set_lane <lane> <true|false>
set_lane() { case "$1" in android) android=$2 ;; ios) ios=$2 ;; relay) relay=$2 ;; esac; }
# classified <lane>: what classify decided for the lane.
classified() { case "$1" in android) echo "$c_android" ;; ios) echo "$c_ios" ;; relay) echo "$c_relay" ;; esac; }
# classify <base>: sets c_android / c_ios / c_relay from the paths changed between <base> and HEAD.
classify() {
  c_android=false c_ios=false c_relay=false
  local changed f
  # --no-renames: a file moved across lanes shows as a deletion plus an addition, so both lanes deliver (a rename would
  # show only its new name, and an app file moved under docs/ would deliver nothing).
  changed=$(git diff --no-renames --name-only "$1" HEAD)
  echo "changed since $1:"
  while IFS= read -r f; do
    echo "  $f"
    case "$f" in
      "") ;;                                                                # nothing changed: nothing to deliver
      android/*/src/main/*) c_android=true ;;                                # the apps' own trees deliver whatever the file is
      ios/Remotly/*|ios/FlowActivity/*|ios/Shared/*|ios/FlowKit/Sources/*) c_ios=true ;;  # (an asset .md, a fixture .json)
      docs/*|*.md|.gitignore|.gitattributes|.editorconfig|scratchpad/*) ;;  # never triggers a delivery
      LICENSE|NOTICE|.github/CODEOWNERS|.github/ISSUE_TEMPLATE/*|.github/dependabot.yml) ;;  # paperwork (templates in .md: above)
      install.sh|.github/workflows/release.yml|bridge/scripts/package.sh) ;; # the release path: release.yml on a bridge-v* tag, never deliver.yml
      .github/workflows/ci.yml|ci/test/*|bridge/test/*|relay/test/*|ios/FlowKit/Tests/*|android/*/src/test/*) ;;  # PR checks and tests: in no build, not run by the host
      relay/*) c_relay=true ;;                                              # the push relay: its Worker is deployed (relay/README.md "Deploy")
      bridge/*) ;;                                                          # the bridge is released by a tag (release.yml), never delivered from main
      .github/*|ci/*) c_android=true c_ios=true c_relay=true ;;             # the pipeline itself changed → deliver all
      shared/*) c_android=true c_ios=true ;;                                # protocol and fixtures shared by the apps (the relay uses none)
      android/*) c_android=true ;;
      ios/*) c_ios=true ;;
      *) c_android=true c_ios=true c_relay=true ;;                          # anything unclassified → be safe
    esac
  done <<< "$changed"
}

if [ "${EVENT:-push}" = "workflow_dispatch" ]; then
  android=${IN_ANDROID:-false}; ios=${IN_IOS:-false}; relay=${IN_RELAY:-false}
else
  head=$(git rev-parse HEAD)
  # Only main's tip delivers. A run started behind a newer push (the queue is not ordered) does nothing; the newer push's
  # run diffs each lane from what that lane last delivered, so nothing is skipped. An origin that cannot be read fails
  # the plan (the next push retries) rather than guess.
  tip=$(git ls-remote --exit-code origin refs/heads/main | cut -f1)
  if [ "$tip" != "$head" ]; then
    echo "main has moved on to $tip since this push ($head); that push's run delivers — nothing to do here"
  else
    for lane in android ios relay; do
      marker=$(git ls-remote origin "refs/delivered/$lane" | cut -f1)
      if [ -z "$marker" ]; then
        echo "$lane: never delivered → deliver"; set_lane "$lane" true
      elif [ "$marker" = "$head" ]; then
        echo "$lane: this commit is what was last delivered → nothing"
      elif ! git cat-file -e "$marker^{commit}" 2>/dev/null || ! ancestor "$marker" HEAD; then
        echo "$lane: the delivered $marker is not in this history (rewritten?) → deliver"; set_lane "$lane" true
      else
        [ "${classified_base:-}" = "$marker" ] || { classify "$marker"; classified_base=$marker; }
        set_lane "$lane" "$(classified "$lane")"
        echo "$lane: delivered at $marker → $(classified "$lane")"
      fi
    done
  fi
fi
build_number=$GITHUB_RUN_NUMBER
{ echo "android=$android"; echo "ios=$ios"; echo "relay=$relay"; echo "build_number=$build_number"; } >> "$GITHUB_OUTPUT"
echo "plan: android=$android ios=$ios relay=$relay build_number=$build_number"
