package app.iris.iris_remote

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

// Play 스토어의 Tailscale 페이지만 여는 채널. QR 내용으로 임의 주소를 열지 않음
class TailscaleStore(private val activity: Activity) {
    fun register(messenger: BinaryMessenger) {
        MethodChannel(messenger, "iris.remote/tailscale-store").setMethodCallHandler { call, result ->
            if (call.method != "open") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            result.success(open("market://details?id=$PACKAGE") || open("https://play.google.com/store/apps/details?id=$PACKAGE"))
        }
    }

    private fun open(uri: String): Boolean = try {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    private companion object {
        const val PACKAGE = "com.tailscale.ipn"
    }
}
