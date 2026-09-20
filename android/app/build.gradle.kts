import java.util.Properties

plugins {
    alias(libs.plugins.android.application) // built-in Kotlin: no org.jetbrains.kotlin.android since AGP 9
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Firebase is optional at build time: the Google Services plugin (which needs google-services.json,
// see docs/DELIVERY.md) is applied only once the file has been dropped into app/.
// CI keeps the file outside the checkout (~/.config/remotly/secrets/google-services.json, named by
// REMOTLY_GOOGLE_SERVICES_JSON from ci/android-env.sh); it is copied into app/ here before the plugin looks for it.
System.getenv("REMOTLY_GOOGLE_SERVICES_JSON")?.takeIf { it.isNotBlank() }?.let { File(expandHome(it)) }?.takeIf { it.isFile }?.let { src ->
    val dst = file("google-services.json")
    if (!dst.exists() || dst.readText() != src.readText()) src.copyTo(dst, overwrite = true)
}
val hasGoogleServices = file("google-services.json").exists()
if (hasGoogleServices) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.lifecycle("flow: app/google-services.json not found — building without Firebase configuration (push disabled at runtime)")
}

// Release signing (docs/DELIVERY.md): the Remotly upload key never lives in
// the repo. Each value is looked up first in the properties file named by the REMOTLY_KEYSTORE_PROPERTIES
// environment variable (e.g. ~/.config/remotly/secrets/keystore.properties — an explicit pointer wins so
// several checkouts on one machine cannot pick up each other's key), then in an environment variable of
// the same name, then as a Gradle property (-P / ~/.gradle/gradle.properties).
// Without a complete set the release build type stays unsigned (CI compile checks still work).
val keystoreProps = Properties().apply {
    System.getenv("REMOTLY_KEYSTORE_PROPERTIES")?.takeIf { it.isNotBlank() }?.let { path ->
        val f = File(expandHome(path))
        if (f.isFile) f.inputStream().use { load(it) }
        else logger.warn("flow: REMOTLY_KEYSTORE_PROPERTIES=$path does not exist — release build will be unsigned")
    }
}

fun expandHome(path: String): String =
    if (path == "~" || path.startsWith("~/")) System.getProperty("user.home") + path.substring(1) else path

fun signingValue(name: String): String? =
    keystoreProps.getProperty(name)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }
        ?: (project.findProperty(name) as? String)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("REMOTLY_STORE_FILE")?.let(::expandHome)
val hasReleaseSigning = releaseStoreFile != null &&
    signingValue("REMOTLY_STORE_PASSWORD") != null &&
    signingValue("REMOTLY_KEY_ALIAS") != null

// Play requires a strictly increasing versionCode per upload; CI passes its run number.
val flowVersionCode = signingValue("REMOTLY_VERSION_CODE")?.toIntOrNull() ?: 1
val flowVersionName = signingValue("REMOTLY_VERSION_NAME") ?: "0.1.0"

android {
    namespace = "com.inferenceaftermath.remotly"
    compileSdk = 37 // androidx.core 1.19 compiles against API 37 or later; targetSdk (runtime behaviour) stays 36

    defaultConfig {
        // Package name registered with Firebase / Play (a fork changes it here, in deliver.yml and in the Kotlin package dirs).
        applicationId = "com.inferenceaftermath.remotly"
        minSdk = 26
        targetSdk = 36
        versionCode = flowVersionCode
        versionName = flowVersionName
    }

    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = File(releaseStoreFile!!)
                storePassword = signingValue("REMOTLY_STORE_PASSWORD")
                keyAlias = signingValue("REMOTLY_KEY_ALIAS")
                keyPassword = signingValue("REMOTLY_KEY_PASSWORD") ?: signingValue("REMOTLY_STORE_PASSWORD")
            }
        }
    } else {
        logger.lifecycle("flow: no upload key configured (REMOTLY_STORE_FILE/REMOTLY_STORE_PASSWORD/REMOTLY_KEY_ALIAS) — release build type is unsigned")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
    }

    // Built-in Kotlin takes its jvmTarget from targetCompatibility.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.datastore.preferences)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)
    implementation(libs.firebase.messaging)
}
