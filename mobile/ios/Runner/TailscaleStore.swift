import Flutter
import UIKit

// App Store 의 Tailscale 페이지만 여는 채널. QR 내용으로 임의 주소를 열지 않음
final class TailscaleStore {
    private static let storeUrl = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!

    func register(messenger: FlutterBinaryMessenger) {
        let channel = FlutterMethodChannel(name: "iris.remote/tailscale-store", binaryMessenger: messenger)
        channel.setMethodCallHandler { call, result in
            guard call.method == "open" else {
                result(FlutterMethodNotImplemented)
                return
            }
            UIApplication.shared.open(Self.storeUrl, options: [:]) { opened in
                result(opened)
            }
        }
    }
}
