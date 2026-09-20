#!/usr/bin/env bash
# The delivery marker of a lane, refs/delivered/<lane> on origin: the commit whose bundle or build last reached Play or
# TestFlight — what ci/plan.sh diffs that lane from next time.
#   forget <lane>  first step of a lane after the guard: removes the marker, so a delivery whose `record` never lands (the
#                  push fails after a successful upload) leaves no marker, and the next push delivers the lane in full —
#                  a stale marker would let a later revert look like "nothing changed" and stay undelivered for good.
#   record <lane>  last step, once the side effect succeeded: the marker is this commit (--force: a rewritten history is
#                  not a fast-forward). Needs `contents: write`. Test: ci/test/mark-delivered.test.sh.
set -euo pipefail
usage() { echo "usage: ci/mark-delivered.sh forget|record android|ios" >&2; exit 2; }
[ $# -eq 2 ] || usage
op=$1 lane=$2
case "$lane" in android|ios) ;; *) usage ;; esac
ref="refs/delivered/$lane"
case "$op" in
  forget)
    existing=$(git ls-remote origin "$ref" | cut -f1) # its own statement: an unreadable origin fails here (set -e)
    if [ -n "$existing" ]; then
      git push --quiet --delete origin "$ref"
      echo "$ref forgotten until this delivery is done"
    else
      echo "$ref: no marker yet"
    fi ;;
  record)
    git push --force --quiet origin "HEAD:$ref"
    echo "$ref → $(git rev-parse HEAD)" ;;
  *) usage ;;
esac
