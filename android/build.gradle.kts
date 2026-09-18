// Root build: plugins are declared here (apply false) so both modules share one version.
// :app compiles Kotlin through AGP's built-in support (AGP 9); the Kotlin Gradle plugin applied to :core is the version
// AGP then uses too, so `kotlin` in the catalog is the one Kotlin for the whole build.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    // Applied by :app only when app/google-services.json exists (see app/build.gradle.kts).
    alias(libs.plugins.google.services) apply false
}
