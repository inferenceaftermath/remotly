// :core — pure Kotlin/JVM: protocol codecs, terminal grid, pairing, connection, push payload.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

sourceSets.main { resources.srcDir("../../shared/demo") }

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    api(libs.okhttp)

    testImplementation(kotlin("test"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation("com.squareup.okhttp3:mockwebserver:${libs.versions.okhttp.get()}")
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // Golden frames shared with the bridge and iOS; the suite skips cleanly when the dir is missing.
    systemProperty("flow.fixtures", rootProject.file("../shared/fixtures/frames").absolutePath)
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = false
    }
}
