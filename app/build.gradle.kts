plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "dev.flashblaze.watchapp"
    compileSdk = 37 // current Compose requires it; runtime behavior follows targetSdk

    defaultConfig {
        applicationId = "dev.flashblaze.watchapp"
        minSdk = 30 // Wear OS 3: Galaxy Watch4 and newer
        targetSdk = 36 // Wear OS 6 (Galaxy Watch8)
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    buildFeatures {
        compose = true
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
    debugImplementation(libs.androidx.ui.tooling)
}
