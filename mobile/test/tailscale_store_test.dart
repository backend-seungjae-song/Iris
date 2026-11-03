import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/tailscale_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('스토어 이름은 플랫폼별', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(TailscaleStore.storeName, 'App Store');
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(TailscaleStore.storeName, 'Play 스토어');
  });

  test('설치 QR 판정은 서버가 만든 Play 주소를 iOS 에서도 인식', () {
    const qr =
        'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
    expect(TailscaleStore.isInstallQr(qr), isTrue);
    expect(TailscaleStore.isInstallQr('{"t":"iris"}'), isFalse);
  });

  group('Tailscale 켜기 요청', () {
    const channel = MethodChannel('iris.remote/tailscale-store');
    final calls = <String>[];

    setUp(() {
      calls.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call.method);
            return true;
          });
    });

    test('Android 에서 켜기와 끄기를 채널로 보냄', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      await const TailscaleStore().setActive(true);
      await const TailscaleStore().setActive(false);
      expect(calls, ['connect', 'disconnect']);
    });

    test('Android 에서 완전 종료는 exit 를 보내고 iOS 에서는 보내지 않음', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      expect(await const TailscaleStore().exitApp(), isTrue);
      expect(calls, ['exit']);
      calls.clear();
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      expect(await const TailscaleStore().exitApp(), isFalse);
      expect(calls, isEmpty);
    });

    test('iOS 에서는 채널을 부르지 않음', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      await const TailscaleStore().setActive(true);
      expect(calls, isEmpty);
    });
  });
}
