package app.iris.iris_remote

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

// Play 스토어의 Tailscale 페이지 열기와 Tailscale 켜기·끄기 요청 채널. QR 내용으로 임의 주소를 열지 않음
class TailscaleStore(private val activity: Activity) {
    fun register(messenger: BinaryMessenger) {
        MethodChannel(messenger, "iris.remote/tailscale-store").setMethodCallHandler { call, result ->
            when (call.method) {
                "open" -> result.success(
                    open("market://details?id=$PACKAGE") || open("https://play.google.com/store/apps/details?id=$PACKAGE"),
                )
                "connect" -> result.success(send("$PACKAGE.CONNECT_VPN"))
                "disconnect" -> result.success(send("$PACKAGE.DISCONNECT_VPN"))
                "exit" -> {
                    disconnect(activity)
                    result.success(true)
                    activity.finishAndRemoveTask()
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun open(uri: String): Boolean = try {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    private fun send(action: String): Boolean = send(activity, action)

    companion object {
        private const val PACKAGE = "com.tailscale.ipn"

        // 앱을 완전히 닫을 때 MainActivity 가 부름
        fun disconnect(context: Context): Boolean = send(context, "$PACKAGE.DISCONNECT_VPN")

        // Tailscale 앱의 IPNReceiver 로 가는 방송. Tailscale 앱이 없으면 받는 쪽이 없어 무시됨
        private fun send(context: Context, action: String): Boolean = try {
            context.sendBroadcast(Intent(action).setPackage(PACKAGE))
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
