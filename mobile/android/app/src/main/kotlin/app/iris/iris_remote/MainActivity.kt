package app.iris.iris_remote

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.content.Intent
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterFragmentActivity() {
    private lateinit var keepAliveChannel: KeepAliveChannel

    override fun onCreate(savedInstanceState: Bundle?) {
        // 첫 화면 그리기 전 적용, 디버그 빌드는 화면 확인을 위해 캡처 허용
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
    }

    override fun onDestroy() {
        // 뒤로가기로 종료할 때만 끔. 홈 버튼이나 화면 회전으로 닫힐 때는 유지
        if (isFinishing) TailscaleStore.disconnect(this)
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::keepAliveChannel.isInitialized) keepAliveChannel.openResponses()
    }

    fun takeOpenResponses(): Boolean {
        val open = intent?.getBooleanExtra(KeepAliveService.EXTRA_OPEN_RESPONSES, false) ?: false
        intent?.removeExtra(KeepAliveService.EXTRA_OPEN_RESPONSES)
        return open
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        ConnectionKey(this).register(flutterEngine.dartExecutor.binaryMessenger)
        TailscaleStore(this).register(flutterEngine.dartExecutor.binaryMessenger)
        keepAliveChannel = KeepAliveChannel(this).also {
            it.register(flutterEngine.dartExecutor.binaryMessenger)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (::keepAliveChannel.isInitialized) {
            keepAliveChannel.onRequestPermissionsResult(requestCode, grantResults)
        }
    }
}
