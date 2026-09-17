# Remotly for Android

Phone client for herdr terminal panes over the Remotly bridge (`../bridge`). Kotlin, Jetpack Compose,
two Gradle modules: `:core` (pure JVM protocol/grid/pairing/connection, unit-tested against
`../shared/fixtures/frames`) and `:app`.

## Build

Requirements: Android SDK with platform 36 (`compileSdk`; AGP downloads what is missing), JDK 17,
network access for Maven on the first build. The Gradle wrapper (8.12) is committed.

```sh
cd android
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk   # or write sdk.dir=… into android/local.properties (gitignored)

./gradlew :core:test :app:assembleDebug   # unit tests + debug APK
./gradlew :app:lintDebug                  # lint report under app/build/reports/
```

The debug APK lands in `app/build/outputs/apk/debug/app-debug.apk`. It is signed with the standard
debug key; there is no release keystore in this repo (release signing: `docs/DELIVERY.md`).

## Unit tests

`./gradlew :core:test` runs the JUnit 5 suite: every message decoded from the protocol examples,
`TerminalGrid` painted from each golden `*.frame.json` and compared row by row with the `*.txt`
rendering, partial-frame application, QR parsing, certificate fingerprint pinning, push payload parsing.
The golden-frame tests skip (with an assumption) when `shared/fixtures/frames` is not present; the path
is passed as the `flow.fixtures` system property from `core/build.gradle.kts`.

## Install a debug build on a phone

1. Phone: Settings → About phone → tap **Build number** seven times → Developer options → **USB debugging**
   (or **Wireless debugging**). Connect over USB and accept the RSA prompt.
2. `adb devices` must list the phone (`$ANDROID_HOME/platform-tools/adb devices`).
3. `./gradlew :app:installDebug` (or `adb install -r app/build/outputs/apk/debug/app-debug.apk`).
4. On the phone: install the Tailscale app, log in, and enable **Always-on VPN** so the host is
   reachable when a notification action runs.
5. Open Remotly, allow notifications (Android 13+), run `remotly-bridge pair` on the host and scan the QR.

Wireless debugging: pair once with `adb pair <ip>:<pairing-port>` then `adb connect <ip>:<port>`.

## Push notifications (Firebase)

The build succeeds without Firebase. To enable push:

1. In the Firebase console register an Android app with the package name (`com.inferenceaftermath.remotly` upstream;
   your own in a fork) in your Firebase project and download `google-services.json`.
2. Drop it at `android/app/google-services.json`. `app/build.gradle.kts` applies the Google Services
   plugin only when this file exists.
3. Rebuild and reinstall. Settings → Notifications → "Push (Firebase)" shows *Configured*. The app
   sends `push.register {platform:"android", token}` after every connect and on token rotation.
4. Give the bridge the service-account JSON and project id (`bridge/README.md` "Configuration", `push.fcm.*`), or leave
   them empty and let notifications go through the push relay (`relay/README.md`).

Without the file all push code paths are compiled but no-op (`FirebaseApp.getApps(context).isEmpty()`).

## Storage

Host URL, device token, certificate fingerprint and settings live in a Preferences DataStore in
app-private storage (`EncryptedSharedPreferences` is deprecated). Android app sandboxing plus the
device lock protect them; "Forget this host" in Settings wipes them and sends `push.unregister`.

## Layout

```
android/
  settings.gradle.kts, build.gradle.kts, gradle.properties, gradle/libs.versions.toml
  core/  src/main/kotlin/com/inferenceaftermath/remotly/core/{protocol,terminal,pairing,connection,push}
         src/test/kotlin/com/inferenceaftermath/remotly/core/*Test.kt
  app/   src/main/kotlin/com/inferenceaftermath/remotly/{MainActivity,FlowApplication}.kt
         src/main/kotlin/com/inferenceaftermath/remotly/{data,session,ui,push}
         src/main/res/font/jetbrains_mono_{regular,bold}.ttf, assets/JetBrainsMono-OFL.txt
```

See `NOTES.md` for design decisions and deferred items.
