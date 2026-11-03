import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

// Mac 원격 화면의 휴대폰 Tailscale 설치 QR 처리
class TailscaleStore {
  const TailscaleStore();

  static const MethodChannel _channel = MethodChannel(
    'iris.remote/tailscale-store',
  );

  static bool isInstallQr(String text) =>
      Uri.tryParse(text)?.queryParameters['id'] == 'com.tailscale.ipn';

  // 설치 안내 문구용 스토어 이름
  static String get storeName =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'App Store' : 'Play 스토어';

  // Android 에서 Iris 가 앞으로 올 때 Tailscale VPN 을 켬. 끄기는 앱 종료 때 MainActivity 가 보냄
  Future<void> setActive(bool active) async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    try {
      await _channel.invokeMethod<bool>(active ? 'connect' : 'disconnect');
    } on PlatformException {
      // Tailscale 앱이 직접 켜고 끄는 방식으로 되돌아감
    }
  }

  // 앱을 완전히 종료. Android 에서 Tailscale 끄기와 작업 종료를 함께 요청
  Future<bool> exitApp() async {
    if (defaultTargetPlatform != TargetPlatform.android) return false;
    try {
      return await _channel.invokeMethod<bool>('exit') ?? false;
    } on PlatformException {
      return false;
    }
  }

  Future<bool> open() async {
    try {
      return await _channel.invokeMethod<bool>('open') ?? false;
    } on PlatformException {
      return false;
    }
  }
}
