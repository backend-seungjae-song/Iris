plugins {
    id("com.android.application")
    // Android·Kotlin 플러그인 뒤에 적용
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "app.iris.iris_remote"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "app.iris.iris_remote"
        // 연결 키 사용 조건 설정(setUserAuthenticationParameters)이 API 30부터
        minSdk = 30
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation("androidx.biometric:biometric:1.1.0")
}

flutter {
    source = "../.."
}
