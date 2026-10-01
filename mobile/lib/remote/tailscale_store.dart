import 'package:flutter/services.dart';

// Mac 원격 화면의 휴대폰 Tailscale 설치 QR 처리
class TailscaleStore {
  const TailscaleStore();

  static const MethodChannel _channel = MethodChannel(
    'iris.remote/tailscale-store',
  );

  static bool isInstallQr(String text) =>
      Uri.tryParse(text)?.queryParameters['id'] == 'com.tailscale.ipn';

  Future<bool> open() async {
    try {
      return await _channel.invokeMethod<bool>('open') ?? false;
    } on PlatformException {
      return false;
    }
  }
}
