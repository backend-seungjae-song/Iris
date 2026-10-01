package app.iris.iris_remote

import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterFragmentActivity() {
    private lateinit var keepAliveChannel: KeepAliveChannel

    override fun onCreate(savedInstanceState: Bundle?) {
        // 첫 화면 그리기 전 적용
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
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
