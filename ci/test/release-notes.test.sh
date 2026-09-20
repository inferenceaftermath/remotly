#!/usr/bin/env bash
# bridge/scripts/release-notes.sh against a small changelog: the section of a version, with or without a heading suffix,
# ends at the next heading; blank lines around it are dropped; a missing heading and an empty section are errors.
# Run: bash ci/test/release-notes.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else fail "$1: expected [$2], got [$3]"; fi; }
notes() { bash "$here/bridge/scripts/release-notes.sh" "$1" "$tmp/CHANGELOG.md"; }
cat > "$tmp/CHANGELOG.md" <<'MD'
# Changelog

## Unreleased

### Phone apps

- an app change

### Bridge 0.3.0

- first note
- second note, with `code`

  a continuation paragraph

### Bridge 0.2.0-rc.1


### Bridge 0.2.0

- the 0.2.0 note
#### a fourth-level heading inside stays
- and after it

### Bridge 0.1.0 — first public release

- the first release

## Older
MD
# shellcheck disable=SC2016 # the backticks are Markdown in the expected text
check "a section" "$(printf -- '- first note\n- second note, with `code`\n\n  a continuation paragraph')" "$(notes 0.3.0)"
check "ends at the next heading, keeps deeper ones" "$(printf -- '- the 0.2.0 note\n#### a fourth-level heading inside stays\n- and after it')" "$(notes 0.2.0)"
check "a heading with a suffix" "- the first release" "$(notes 0.1.0)"
if notes 0.2.0-rc.1 > /dev/null 2> "$tmp/err"; then fail "an empty section must be an error"; fi
grep -q "is empty" "$tmp/err" || fail "no message for the empty section: $(cat "$tmp/err")"
echo "ok   an empty section is an error"
if notes 9.9.9 > /dev/null 2> "$tmp/err"; then fail "a missing heading must be an error"; fi
grep -q "no '### Bridge 9.9.9' section" "$tmp/err" || fail "no message for the missing heading: $(cat "$tmp/err")"
echo "ok   a missing heading is an error"
# 0.2.0 is not a prefix match for 0.2.0-rc.1 (and the reverse): the heading is matched whole, or with a space after it.
check "no prefix confusion" "$(printf -- '- the 0.2.0 note\n#### a fourth-level heading inside stays\n- and after it')" "$(notes 0.2.0)"
if bash "$here/bridge/scripts/release-notes.sh" > /dev/null 2>&1; then fail "a missing version must be an error"; fi
echo "ok   a missing version is an error"
echo "release-notes.test.sh: all cases passed"
