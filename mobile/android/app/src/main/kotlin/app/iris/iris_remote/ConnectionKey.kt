package app.iris.iris_remote

import android.app.KeyguardManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.spec.ECGenParameterSpec

class ConnectionKey(private val activity: MainActivity) : MethodChannel.MethodCallHandler {
    private val keyAlias = "iris.remote.connection-key"
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private var unlockResult: MethodChannel.Result? = null

    fun register(messenger: BinaryMessenger) {
        MethodChannel(messenger, "iris.remote/connection_key").setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "publicKey" -> publicKey(result)
            "unlock" -> unlock(result)
            "sign" -> sign(call, result)
            "deleteKey" -> deleteKey(result)
            else -> result.notImplemented()
        }
    }

    private fun publicKey(result: MethodChannel.Result) {
        if (!hasLockScreen()) {
            result.error("no-lock-screen", "폰 잠금이 설정되어 있지 않습니다.", null)
            return
        }
        try {
            if (!keyStore.containsAlias(keyAlias)) generateKey()
            val certificate = keyStore.getCertificate(keyAlias)
                ?: return result.error("key-unavailable", "연결 키 인증서를 찾을 수 없습니다.", null)
            result.success(Base64.encodeToString(certificate.publicKey.encoded, Base64.NO_WRAP))
        } catch (error: Exception) {
            result.error("key-unavailable", error.message, null)
        }
    }

    private fun generateKey() {
        try {
            generateKey(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias)
            generateKey(strongBox = false)
        }
    }

    private fun generateKey(strongBox: Boolean) {
        val authenticators = KeyProperties.AUTH_BIOMETRIC_STRONG or
            KeyProperties.AUTH_DEVICE_CREDENTIAL
        val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(300, authenticators)
        if (strongBox) builder.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    private fun unlock(result: MethodChannel.Result) {
        if (unlockResult != null) {
            result.error("unlock-in-progress", "폰 잠금 확인이 이미 열려 있습니다.", null)
            return
        }
        if (!hasLockScreen()) {
            result.error("no-lock-screen", "폰 잠금이 설정되어 있지 않습니다.", null)
            return
        }
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val availability = BiometricManager.from(activity).canAuthenticate(authenticators)
        if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
            result.error("unlock-unavailable", "폰 잠금을 사용할 수 없습니다.", availability)
            return
        }
        unlockResult = result
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    authenticationResult: BiometricPrompt.AuthenticationResult,
                ) {
                    unlockResult?.success(null)
                    unlockResult = null
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    unlockResult?.error("unlock-canceled", errString.toString(), errorCode)
                    unlockResult = null
                }
            },
        )
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Iris 원격 연결")
            .setSubtitle("폰 잠금을 해제해 연결 키를 사용하세요")
            .setAllowedAuthenticators(authenticators)
            .build()
        prompt.authenticate(promptInfo)
    }

    private fun hasLockScreen(): Boolean {
        val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return keyguard.isDeviceSecure
    }

    private fun sign(call: MethodCall, result: MethodChannel.Result) {
        val bytes = call.argument<ByteArray>("bytes")
            ?: return result.error("invalid-arguments", "서명할 바이트가 없습니다.", null)
        try {
            val privateKey = keyStore.getKey(keyAlias, null)
                ?: return result.error("key-unavailable", "연결 키를 찾을 수 없습니다.", null)
            val signature = Signature.getInstance("SHA256withECDSA").apply {
                initSign(privateKey as java.security.PrivateKey)
                update(bytes)
            }
            result.success(Base64.encodeToString(signature.sign(), Base64.NO_WRAP))
        } catch (_: android.security.keystore.UserNotAuthenticatedException) {
            result.error("unlock-required", "폰 잠금 확인이 필요합니다.", null)
        } catch (_: KeyPermanentlyInvalidatedException) {
            result.error("key-invalid", "연결 키를 다시 등록해야 합니다.", null)
        } catch (_: UnrecoverableKeyException) {
            result.error("key-invalid", "연결 키를 다시 등록해야 합니다.", null)
        } catch (error: Exception) {
            result.error("sign-failed", error.message, null)
        }
    }

    private fun deleteKey(result: MethodChannel.Result) {
        try {
            if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias)
            result.success(null)
        } catch (error: Exception) {
            result.error("delete-failed", error.message, null)
        }
    }
}
