package app.iris.iris_remote

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class KeepAliveChannel(private val activity: MainActivity) : MethodChannel.MethodCallHandler {
    private val permissionRequestCode = 4102
    private lateinit var channel: MethodChannel
    private var responsesReady = false
    private var pendingStart: MethodChannel.Result? = null

    fun register(messenger: BinaryMessenger) {
        channel = MethodChannel(messenger, "iris.remote/keepalive")
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "takeOpenResponses" -> {
                responsesReady = true
                result.success(activity.takeOpenResponses())
            }
            "start" -> start(result)
            "update" -> update(call, result)
            "stop" -> stop(result)
            else -> result.notImplemented()
        }
    }

    fun openResponses() {
        if (responsesReady && activity.takeOpenResponses()) {
            channel.invokeMethod("openResponses", null)
        }
    }

    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != permissionRequestCode) return
        val result = pendingStart ?: return
        pendingStart = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            launchService(result)
        } else {
            result.error("notification-denied", "알림 권한이 필요합니다.", null)
        }
    }

    private fun start(result: MethodChannel.Result) {
        if (pendingStart != null) {
            result.error("permission-pending", "알림 권한 확인이 진행 중입니다.", null)
            return
        }
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingStart = result
            activity.requestPermissions(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                permissionRequestCode,
            )
            return
        }
        launchService(result)
    }

    private fun launchService(result: MethodChannel.Result) {
        try {
            activity.startForegroundService(
                Intent(activity, KeepAliveService::class.java).setAction(KeepAliveService.ACTION_START),
            )
            result.success(null)
        } catch (error: Exception) {
            result.error("start-failed", error.message, null)
        }
    }

    private fun update(call: MethodCall, result: MethodChannel.Result) {
        val requestCount = call.argument<Int>("requestCount")
        if (requestCount == null || requestCount < 0) {
            result.error("invalid-arguments", "요청 수가 올바르지 않습니다.", null)
            return
        }
        try {
            activity.startService(
                Intent(activity, KeepAliveService::class.java)
                    .setAction(KeepAliveService.ACTION_UPDATE)
                    .putExtra(KeepAliveService.EXTRA_REQUEST_COUNT, requestCount)
                    .putExtra(KeepAliveService.EXTRA_ALERT, call.argument<Boolean>("alert") ?: false),
            )
            result.success(null)
        } catch (error: Exception) {
            result.error("update-failed", error.message, null)
        }
    }

    private fun stop(result: MethodChannel.Result) {
        try {
            activity.startService(
                Intent(activity, KeepAliveService::class.java)
                    .setAction(KeepAliveService.ACTION_STOP),
            )
            result.success(null)
        } catch (error: Exception) {
            result.error("stop-failed", error.message, null)
        }
    }
}
