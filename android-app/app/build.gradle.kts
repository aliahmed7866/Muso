plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}
val prepareCore by tasks.registering(Sync::class) {
    from("../..") { include("app.py", "importer.py", "discovery.py", "backup.py") }
    into(layout.buildDirectory.dir("generated/python"))
}
val prepareWeb by tasks.registering(Sync::class) {
    from("../..") { include("static/**", "templates/**") }
    from("../../backup.py") { into("transfer"); rename { "Muso-transfer.py" } }
    into(layout.buildDirectory.dir("generated/assets/web"))
}
android {
    namespace = "app.muso.player"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.muso.player"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/assets"))
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs.useLegacyPackaging = false }
}
chaquopy {
    defaultConfig {
        version = "3.13"
        pip {
            install("Flask==3.1.2")
            install("mutagen==1.47.0")
            install("yt-dlp-ejs==0.8.0")
            install("yt-dlp==2026.10.26")
        }
    }
    sourceSets.getByName("main").srcDir(layout.buildDirectory.dir("generated/python"))
}
tasks.configureEach {
    if (name.endsWith("PythonSources")) dependsOn(prepareCore)
    if (name.startsWith("merge") && name.endsWith("Assets")) dependsOn(prepareWeb)
}
tasks.named("preBuild") { dependsOn(prepareCore, prepareWeb) }
dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.javascriptengine:javascriptengine:1.0.0")
    implementation("androidx.media3:media3-exoplayer:1.6.1")
    implementation("androidx.media3:media3-session:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-web:3.6.1")
}
