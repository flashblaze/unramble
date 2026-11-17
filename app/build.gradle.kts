import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Worker endpoint and bearer token live in the gitignored local.properties (see PLAN.md).
val localProperties = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use(::load)
}

android {
    namespace = "dev.flashblaze.unramble"
    compileSdk = 37 // current Compose requires it; runtime behavior follows targetSdk

    defaultConfig {
        applicationId = "dev.flashblaze.unramble"
        minSdk = 30 // Wear OS 3: Galaxy Watch4 and newer
        targetSdk = 36 // Wear OS 6 (Galaxy Watch8)
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "WORKER_URL", "\"${localProperties.getProperty("unramble.workerUrl", "")}\"")
        buildConfigField("String", "APP_TOKEN", "\"${localProperties.getProperty("unramble.appToken", "")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.wear.compose.material3)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.ui.tooling)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.wear.ongoing)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
