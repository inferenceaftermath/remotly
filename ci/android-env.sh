#!/usr/bin/env bash
# Print the environment the Android job needs on the Linux runner host (appended to $GITHUB_ENV).
# Everything secret lives in ~/.config/remotly/secrets on the runner host, never in GitHub (docs/DELIVERY.md).
set -euo pipefail
secrets="$HOME/.config/remotly/secrets"
props="$secrets/keystore.properties"
sa="$secrets/play-service-account.json"
[ -r "$sa" ] || sa="$secrets/fcm-service-account.json"   # same Google project; reuse when no dedicated key
for f in "$props" "$sa"; do [ -r "$f" ] || { echo "missing $f on the runner host" >&2; exit 1; }; done
echo "JAVA_HOME=${REMOTLY_JAVA_HOME:-$HOME/sdks/jdk-17}"
echo "ANDROID_HOME=${REMOTLY_ANDROID_HOME:-$HOME/sdks/android-sdk}"
echo "REMOTLY_KEYSTORE_PROPERTIES=$props"
echo "PLAY_SERVICE_ACCOUNT_JSON=$sa"
gs="$secrets/google-services.json"
if [ -r "$gs" ]; then echo "REMOTLY_GOOGLE_SERVICES_JSON=$gs"; else echo "warning: $gs missing — the bundle is built without Firebase (no push)" >&2; fi
echo "GRADLE_OPTS=-Dorg.gradle.daemon=false"
