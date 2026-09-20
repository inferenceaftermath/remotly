#!/usr/bin/env bash
# Archive Remotly and upload it to TestFlight. Runs on a Mac with Xcode 26 and xcodegen (a developer's, or a
# CI runner). Shape: `xcodebuild archive` + `-exportArchive` with destination=upload, authenticated with an App
# Store Connect API key — no certificates or profiles to install by hand (`-allowProvisioningUpdates` registers
# the App ID, its capabilities, an Apple Development certificate for this machine if it has none, and the team's
# cloud-managed distribution certificate on first use; the archive is signed with the former, the export with the
# latter). On a fresh CI runner that means one new development certificate per run: revoke the stale ones in the
# developer portal now and then.
#
# Required env:
#   ASC_KEY_ID        App Store Connect API key id (team key)
#   ASC_ISSUER_ID     issuer id shown at App Store Connect → Users and Access → Integrations
#   ASC_API_KEY_P8    path to the AuthKey_<id>.p8 file (mode 600)
# Optional env:
#   APPLE_TEAM_ID     default DA2SG9BMQ3
#   REMOTLY_BUILD_NUMBER CFBundleVersion; default = commit count on the current branch (monotonic on main)
#   REMOTLY_MARKETING_VERSION  override MARKETING_VERSION from project.yml
#   REMOTLY_ARCHIVE_ONLY=1     archive but do not upload (compile check)
#   REMOTLY_WORK_DIR     where the archive/export land (default: a fresh mktemp dir, removed on exit);
#                     the full xcodebuild output is kept there as archive.log / export.log
#   REMOTLY_KEYCHAIN_PASSWORD_FILE  file holding the Mac login password (mode 600). Headless ssh sessions
#                     have the login keychain locked and CodeSign fails with errSecInternalComponent;
#                     when this file exists the keychain is unlocked first (the keychain stays
#                     unlocked for the session). Default: ~/.config/remotly/keychain-pass if present.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}" "${ASC_API_KEY_P8:?set ASC_API_KEY_P8 (path to .p8)}"
[ -r "$ASC_API_KEY_P8" ] || { echo "ASC_API_KEY_P8=$ASC_API_KEY_P8 is not readable" >&2; exit 1; }
APPLE_TEAM_ID=${APPLE_TEAM_ID:-DA2SG9BMQ3}
BUILD_NUMBER=${REMOTLY_BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || date -u +%Y%m%d%H%M)}
WORK=${REMOTLY_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/flow-testflight.XXXXXX")}
KEEP_WORK=${REMOTLY_WORK_DIR:+1}
mkdir -p "$WORK"
cleanup() { [ -n "${KEEP_WORK:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT

KEYCHAIN_PW_FILE=${REMOTLY_KEYCHAIN_PASSWORD_FILE:-$HOME/.config/remotly/keychain-pass}
if [ -r "$KEYCHAIN_PW_FILE" ]; then
  if security unlock-keychain -p "$(tr -d '\n' < "$KEYCHAIN_PW_FILE")" "$HOME/Library/Keychains/login.keychain-db"; then
    echo "flow: login keychain unlocked"
  else
    echo "flow: keychain unlock failed (wrong password in $KEYCHAIN_PW_FILE?)" >&2
  fi
  # stay unlocked for the length of the build (default relocks after 5 min of inactivity)
  security set-keychain-settings -t 3600 "$HOME/Library/Keychains/login.keychain-db" || true
else
  echo "flow: no keychain password file ($KEYCHAIN_PW_FILE) — a headless session on a Mac whose login keychain is locked needs it; GUI sessions and fresh CI runners do not"
fi

if command -v xcodegen >/dev/null; then
  xcodegen generate --quiet
elif [ -d Remotly.xcodeproj ]; then
  echo "flow: xcodegen not installed, using the existing Remotly.xcodeproj"
else
  echo "flow: neither xcodegen (brew install xcodegen) nor Remotly.xcodeproj found" >&2; exit 1
fi

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$ASC_API_KEY_P8"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "flow: archiving build $BUILD_NUMBER (team $APPLE_TEAM_ID)"
xcodebuild archive \
  -project Remotly.xcodeproj -scheme Remotly -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK/Remotly.xcarchive" \
  "${AUTH[@]}" \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ${REMOTLY_MARKETING_VERSION:+MARKETING_VERSION="$REMOTLY_MARKETING_VERSION"} \
  > "$WORK/archive.log" 2>&1 || true
grep -E "error:|\*\* ARCHIVE" "$WORK/archive.log" | sort -u | head -40 || true
if [ ! -d "$WORK/Remotly.xcarchive" ]; then
  echo "flow: archive failed — relevant lines from $WORK/archive.log:" >&2
  grep -nE "errSec|CodeSign|codesign|keychain|identity|rovisioning|profile|denied|unable|failed" "$WORK/archive.log" | tail -25 >&2
  exit 1
fi

if [ "${REMOTLY_ARCHIVE_ONLY:-0}" = "1" ]; then
  echo "flow: archive at $WORK/Remotly.xcarchive (REMOTLY_ARCHIVE_ONLY=1, not uploading)"; KEEP_WORK=1; exit 0
fi

echo "flow: uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$WORK/Remotly.xcarchive" \
  -exportOptionsPlist ExportOptions-testflight.plist \
  -exportPath "$WORK/export" \
  "${AUTH[@]}" \
  > "$WORK/export.log" 2>&1 || true
grep -E "error:|Upload succeeded|EXPORT" "$WORK/export.log" | sort -u | head -20 || true
if grep -q "EXPORT SUCCEEDED" "$WORK/export.log"; then
  echo "flow: build $BUILD_NUMBER uploaded — it appears in TestFlight after processing (a few minutes)"
else
  echo "flow: upload failed — relevant lines from $WORK/export.log:" >&2
  grep -nE "error|Error|failed|denied" "$WORK/export.log" | tail -20 >&2
  exit 1
fi
