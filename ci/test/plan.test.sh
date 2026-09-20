#!/usr/bin/env bash
# Exercises ci/plan.sh against a throwaway repository: which paths deliver which lane; that documentation, paperwork,
# the bridge (released by a tag, never delivered from main), the pull-request workflow and tests and
# the relay deliver nothing; that a file moved across lanes delivers both; that an unclassified path, a pipeline
# change or an unusable base delivers everything; that workflow_dispatch takes its checkboxes. Run: bash ci/test/plan.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# A private git identity and no user or system configuration: signing or hooks set up on this machine stay out.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=plan-test GIT_AUTHOR_EMAIL=plan-test@example.invalid GIT_COMMITTER_NAME=plan-test GIT_COMMITTER_EMAIL=plan-test@example.invalid
# The repository sits in its own directory: the planner's output and log stay outside it, or `git add -A` would commit them.
mkdir "$tmp/repo" && cd "$tmp/repo" && git init -q .   # no -b: the branch name is irrelevant and -b needs git 2.28

fail() { echo "FAIL: $*" >&2; exit 1; }
# commit <message> <path>...: appends a line to each path (creating its directories) and commits; no path = empty commit.
commit() {
  local msg="$1"; shift
  local p; for p in "$@"; do mkdir -p "$(dirname "$p")"; echo "$msg" >> "$p"; done
  git add -A && git commit -q --allow-empty -m "$msg"
}
# The throwaway `origin`: main's tip and the lanes' markers live there, as they do on GitHub.
git init -q --bare "$tmp/origin.git" && git remote add origin "$tmp/origin.git"
tip() { git push -q --force origin "$1:refs/heads/main"; }                  # tip <rev>
deliver() { git push -q --force origin "$2:refs/delivered/$1"; }            # deliver <lane> <rev>: the lane's marker
undeliver() { git push -q --delete origin "refs/delivered/$1" 2>/dev/null || true; }
# plan [VAR=value ...]: runs the planner for HEAD as deliver.yml does and prints the three outputs on one line.
plan() {
  : > "$tmp/output"
  if ! env EVENT=push GITHUB_RUN_NUMBER=7 GITHUB_OUTPUT="$tmp/output" "$@" bash "$here/ci/plan.sh" > "$tmp/log" 2>&1; then
    cat "$tmp/log" >&2; fail "plan.sh exited non-zero"
  fi
  paste -sd' ' "$tmp/output"
}
check() { # check <case> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else fail "$1: expected [$2], got [$3]"; fi
}
# expect <case> <android> <ios> <path>...: one commit touching the paths, at main's tip, both lanes last delivered at
# its parent.
expect() {
  local name="$1" a="$2" i="$3"; shift 3
  commit "$name" "$@"
  tip HEAD; for l in android ios; do deliver "$l" HEAD~1; done
  check "$name" "android=$a ios=$i build_number=7" "$(plan)"
}

commit "root" README.md
expect "documentation and markdown"     false false docs/DELIVERY.md CHANGELOG.md AGENTS.md shared/protocol/remotly-protocol.md
expect "repository paperwork"           false false LICENSE NOTICE .github/CODEOWNERS .github/ISSUE_TEMPLATE/bug.yml .github/PULL_REQUEST_TEMPLATE.md .github/dependabot.yml .gitattributes .editorconfig
expect "the release path"               false false install.sh .github/workflows/release.yml bridge/scripts/package.sh
expect "pull-request checks and tests"  false false .github/workflows/ci.yml ci/test/plan.test.sh bridge/test/server/http.test.ts ios/FlowKit/Tests/FlowKitTests/GridTests.swift android/core/src/test/kotlin/MessagesTest.kt
expect "the relay"                      false false relay/src/index.ts relay/wrangler.jsonc relay/package.json
# The bridge reaches hosts as a release (release.yml on a bridge-v* tag, install.sh, `remotly-bridge update`), never from a push.
expect "the bridge"                     false false bridge/src/main.ts bridge/bin/remotly-bridge bridge/package.json bridge/package-lock.json bridge/src/approvals/agents.json
expect "a no-change push"               false false
expect "android"                        true  false android/app/build.gradle.kts
expect "ios"                            false true  ios/Remotly/Views/PaneView.swift
expect "android beside the bridge"      true  false android/app/src/main/x.kt bridge/src/y.ts
expect "shared fixtures"                true  true  shared/fixtures/frames/a.json
expect "the delivery workflow"          true  true  .github/workflows/deliver.yml
expect "a ci/ script"                   true  true  ci/lane-guard.sh
expect "a new ci/ script"               true  true  ci/new-step.sh
expect "a new .github/ file"            true  true  .github/workflows/new.yml
expect "an unclassified path"           true  true  tools/new-thing.sh
expect "documentation beside code"      false false docs/OPERATIONS.md bridge/src/config.ts
# Inside the apps' own trees the file name decides nothing: an asset ending in .md or a path with src/test in it ships.
expect "an android asset ending in .md"  true  false android/app/src/main/assets/help.md
expect "src/test inside android main"    true  false android/app/src/main/assets/src/test/config.json
expect "an ios resource ending in .md"   false true  ios/Remotly/Resources/notes.md ios/Shared/Notes.md
expect "a FlowKit source ending in .md"  false true  ios/FlowKit/Sources/FlowKit/README.md
# A file moved across lanes counts for both: its old lane (a deletion) and its new one (an addition) — never only the
# destination, which for docs/ would deliver nothing while the app still shipped the file.
commit "files to move" ios/Remotly/Moved.swift android/app/src/main/Moved.kt
git mv ios/Remotly/Moved.swift android/app/Moved.swift && git commit -q -m "ios file moved to android"
tip HEAD; for l in android ios; do deliver "$l" HEAD~1; done
check "an ios file moved to android"     "android=true ios=true build_number=7"  "$(plan)"
git mv android/app/src/main/Moved.kt docs/Moved.kt && git commit -q -m "android file moved under docs"
tip HEAD; for l in android ios; do deliver "$l" HEAD~1; done
check "an android file moved under docs" "android=true ios=false build_number=7" "$(plan)"
# The bases are per lane: each lane is diffed from the commit its own marker names. The chain from here: X (the move
# above) → I ios step → A android step; main's tip is A.
commit "ios step" ios/Remotly/Step.swift
commit "android step" android/app/src/main/Step.kt
branch="$(git symbolic-ref --short HEAD)"
A="$(git rev-parse HEAD)"; I="$(git rev-parse HEAD~1)"; X="$(git rev-parse HEAD~2)"
tip "$A"
for l in android ios; do undeliver "$l"; done
check "never delivered: everything"       "android=true ios=true build_number=7"   "$(plan)"
for l in android ios; do deliver "$l" "$A"; done
check "already delivered (a rerun)"       "android=false ios=false build_number=7" "$(plan)"
for l in android ios; do deliver "$l" "$I"; done
check "both lanes delivered at the parent" "android=true ios=false build_number=7"  "$(plan)"
deliver ios "$X"; deliver android "$I"
check "each lane from its own marker"     "android=true ios=true build_number=7"   "$(plan)"
deliver ios "$A"; undeliver android
check "one lane never delivered"          "android=true ios=false build_number=7"  "$(plan)"
# A lane that failed before forgetting its marker kept the old one: the next push delivers it from there (its changes
# are retried); the lane that succeeded moved on. Here ios failed at I, and A changed only android.
deliver ios "$X"; deliver android "$A"
check "a lane that failed last time"      "android=false ios=true build_number=7"  "$(plan)"
# A delivery whose marker push failed left no marker (the lane forgets it before the upload): a later revert of that
# lane's change, whose diff from the last marker would be empty, still delivers the lane.
commit "ios change" ios/Remotly/Change.swift
undeliver ios; deliver android HEAD
git revert --no-edit HEAD > /dev/null
tip HEAD
check "a revert after a lost marker"      "android=false ios=true build_number=7"  "$(plan)"
git reset -q --hard "$A"; tip "$A"
# Only main's tip delivers: a run of an older commit (started behind a newer push, or rerun later) does nothing at all,
# even with lanes still to deliver — the tip's run does that.
git checkout -q "$I"
for l in android ios; do deliver "$l" "$X"; done
check "not main's tip"                    "android=false ios=false build_number=7" "$(plan)"
grep -q "main has moved on to $A" "$tmp/log" || fail "no explanation: $(cat "$tmp/log")"
git checkout -q "$branch"
# A marker outside this history (main rewritten): that lane delivers everything it has — a commit from an unrelated line
# this clone knows, or one it never fetched (in another clone, pushed from there).
git checkout -q --orphan unrelated && git commit -q --allow-empty -m unrelated && unrelated="$(git rev-parse HEAD)"
git checkout -q "$branch"
deliver ios "$unrelated"; deliver android "$A"
check "a marker from another history"     "android=false ios=true build_number=7"  "$(plan)"
git clone -q "$tmp/origin.git" "$tmp/other" && git -C "$tmp/other" checkout -q --orphan elsewhere && git -C "$tmp/other" commit -q --allow-empty -m elsewhere
git -C "$tmp/other" push -q --force origin HEAD:refs/delivered/android
deliver ios "$A"
check "a marker this clone does not have" "android=true ios=false build_number=7"  "$(plan)"
deliver android "$A"
# An origin that cannot be read fails the plan rather than guess.
git remote set-url origin "$tmp/nowhere.git"
if env EVENT=push GITHUB_RUN_NUMBER=7 GITHUB_OUTPUT="$tmp/output" bash "$here/ci/plan.sh" >/dev/null 2>&1; then fail "an unreadable origin must fail the plan"; fi
echo "ok   an unreadable origin fails the plan"
git remote set-url origin "$tmp/origin.git"
# workflow_dispatch takes its checkboxes (unticked = false) and ignores the markers (ci/lane-guard.sh still asks for
# main's tip in each lane).
check "dispatch: ios only"  "android=false ios=true build_number=7" "$(plan EVENT=workflow_dispatch IN_IOS=true)"
check "dispatch: both"      "android=true ios=true build_number=7"  "$(plan EVENT=workflow_dispatch IN_ANDROID=true IN_IOS=true)"
check "dispatch: nothing"   "android=false ios=false build_number=7" "$(plan EVENT=workflow_dispatch)"
echo "plan.test.sh: all cases passed"
