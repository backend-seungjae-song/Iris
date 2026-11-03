import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

const _settings = PairingSettings(
  address: '100.64.1.2',
  port: 4292,
  certHash: '2222222222222222222222222222222222222222222222222222222222222222',
  deviceId: '33333333333333333333333333333333',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final tailscale = <String>[];
  final keepAlive = <String>[];

  setUp(() {
    tailscale.clear();
    keepAlive.clear();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      const MethodChannel('iris.remote/tailscale-store'),
      (call) async {
        tailscale.add(call.method);
        return true;
      },
    );
    messenger.setMockMethodCallHandler(
      const MethodChannel('iris.remote/keepalive'),
      (call) async {
        keepAlive.add(call.method);
        return call.method == 'takeOpenResponses' ? false : null;
      },
    );
  });

  Future<void> pumpScreen(WidgetTester tester) => tester.pumpWidget(
    MaterialApp(
      theme: irisTheme(Brightness.dark),
      home: ConnectionScreen(
        settings: _settings,
        remoteSession: RemoteSession(),
        onUnregister: (_) async {},
      ),
    ),
  );

  testWidgets('화면을 열면 Tailscale 을 켠다', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await pumpScreen(tester);
    expect(tailscale, contains('connect'));
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('맨 처음 화면에서 뒤로가기는 백그라운드 연결을 끄고 앱을 종료한다', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await pumpScreen(tester);
    tailscale.clear();
    keepAlive.clear();
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(keepAlive, contains('stop'));
    expect(tailscale, ['exit']);
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('홈 키처럼 화면이 가려질 때는 Tailscale 을 끄지 않는다', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await pumpScreen(tester);
    tailscale.clear();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(tailscale, isNot(contains('exit')));
    expect(tailscale, isNot(contains('disconnect')));
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
  });
}
