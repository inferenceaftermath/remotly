// Root build: plugins are declared here (apply false) so both modules share one version.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    // Applied by :app only when app/google-services.json exists (see app/build.gradle.kts).
    alias(libs.plugins.google.services) apply false
}
