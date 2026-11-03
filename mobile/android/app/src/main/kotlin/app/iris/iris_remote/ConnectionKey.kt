package app.iris.iris_remote

import android.app.KeyguardManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.spec.ECGenParameterSpec

class ConnectionKey(private val activity: MainActivity) : MethodChannel.MethodCallHandler {
    // v2 키는 서명할 때 폰 잠금 해제를 요구하지 않는다. 키 설정은 만든 뒤 바꿀 수 없어 이전 키를 지우고 새로 만든다
    private val keyAlias = "iris.remote.connection-key.v2"
    private val legacyAlias = "iris.remote.connection-key"
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun register(messenger: BinaryMessenger) {
        MethodChannel(messenger, "iris.remote/connection_key").setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "publicKey" -> publicKey(result)
            "hasKey" -> hasKey(result)
            "unlock" -> result.success(null)
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
        val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        if (strongBox) builder.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    // 이전 버전의 잠금 해제 요구 키는 지우고, 이 기기에 새 키가 있는지 알려 준다
    private fun hasKey(result: MethodChannel.Result) {
        try {
            if (keyStore.containsAlias(legacyAlias)) keyStore.deleteEntry(legacyAlias)
            result.success(keyStore.containsAlias(keyAlias))
        } catch (error: Exception) {
            result.error("key-unavailable", error.message, null)
        }
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
