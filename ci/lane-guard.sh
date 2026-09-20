#!/usr/bin/env bash
# First step of every delivery lane: deliver only while this run's commit is main's tip. A run started behind a newer
# push (the queue is not ordered), a rerun of an old run's lane, a dispatch from another branch: all skip, and the tip's
# own run delivers whatever the lanes still need (ci/plan.sh diffs each lane from what it last delivered). A stale
# DISPATCH asked for this lane by name, though: its marker is forgotten (ci/mark-delivered.sh forget), so the tip's run
# delivers the lane in full instead of finding nothing changed for it. Prints `deliver=true|false` to $GITHUB_OUTPUT;
# the lane's other steps run on `deliver == 'true'`. Usage: ci/lane-guard.sh <lane>, EVENT=push|workflow_dispatch.
# Test: ci/test/lane-guard.test.sh.
set -euo pipefail
: "${GITHUB_OUTPUT:?}"
lane=${1:?usage: ci/lane-guard.sh android|ios}
case "$lane" in android|ios) ;; *) echo "unknown lane: $lane" >&2; exit 2 ;; esac
head=$(git rev-parse HEAD)
tip=$(git ls-remote --exit-code origin refs/heads/main | cut -f1)
if [ "$tip" = "$head" ]; then
  echo "deliver=true" >> "$GITHUB_OUTPUT"
  echo "$head is main's tip: delivering $lane"
else
  echo "deliver=false" >> "$GITHUB_OUTPUT"
  echo "main has moved on to $tip since this run's $head: nothing to deliver from here (the tip's run does)"
  if [ "${EVENT:-push}" = workflow_dispatch ]; then
    echo "this dispatch asked for $lane: forgetting its marker, so the tip's run delivers it in full"
    "$(dirname "${BASH_SOURCE[0]}")/mark-delivered.sh" forget "$lane"
  fi
fi
