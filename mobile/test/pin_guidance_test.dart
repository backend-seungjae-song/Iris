import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/code_screen.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/screens/pin_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

Widget app(Widget home) =>
    MaterialApp(theme: irisTheme(Brightness.light), home: home);

void main() {
  testWidgets('PIN 입력 화면은 Mac에서 정하고 바꾸는 곳을 알려 준다', (tester) async {
    await tester.pumpWidget(app(const AccessPinScreen()));
    expect(find.text('컴퓨터의 Iris 원격 화면 → 접속 PIN에서 정하고 바꿉니다.'), findsOneWidget);
  });

  testWidgets('재연결 화면은 PIN 대기 초를 표시하고 연결을 막는다', (tester) async {
    await tester.pumpWidget(
      app(
        DisconnectedView(
          busy: false,
          status: 'PIN이 올바르지 않습니다. · 3초 후 다시 시도하세요.',
          retrySeconds: 3,
          onConnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    expect(find.text('3초 후 다시 시도'), findsOneWidget);
    expect(find.byKey(const Key('connection-pin-input')), findsNothing);
  });

  testWidgets('연결 버튼은 PIN 시트를 열고 틀린 PIN이면 시트 안에 사유를 둔다', (tester) async {
    final submitted = <String>[];
    var fail = true;
    await tester.pumpWidget(
      app(
        Builder(
          builder: (context) => DisconnectedView(
            busy: false,
            status: 'Mac과 연결이 끊겼습니다.',
            onConnect: () => showIrisSheet<void>(
              context: context,
              builder: (_) => ConnectPinSheet(
                retrySeconds: () => 0,
                onSubmit: (pin) async {
                  submitted.add(pin);
                  return fail ? 'PIN이 올바르지 않습니다.' : null;
                },
              ),
            ),
            onUnregister: () {},
          ),
        ),
      ),
    );
    await tester.tap(find.text('컴퓨터에 연결'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('connect-pin-sheet')), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('connection-pin-input')),
      '123456',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('connect-pin-submit')));
    await tester.pumpAndSettle();
    expect(find.text('PIN이 올바르지 않습니다.'), findsOneWidget);
    expect(find.byKey(const Key('connect-pin-sheet')), findsOneWidget);
    fail = false;
    await tester.enterText(
      find.byKey(const Key('connection-pin-input')),
      '654321',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('connect-pin-submit')));
    await tester.pumpAndSettle();
    expect(submitted, ['123456', '654321']);
    expect(find.byKey(const Key('connect-pin-sheet')), findsNothing);
  });

  testWidgets('등록 중 PIN 오류도 남은 대기 시간을 표시한다', (tester) async {
    const pending = PendingPairing(
      settings: PairingSettings(
        address: '100.64.1.2',
        port: 4292,
        certHash:
            '2222222222222222222222222222222222222222222222222222222222222222',
        deviceId: '33333333333333333333333333333333',
      ),
      code: '123456',
    );
    await tester.pumpWidget(
      app(
        CodeScreen(
          pending: pending,
          onConfirm: () async {
            throw const RemoteFailure(
              'PIN이 올바르지 않습니다.',
              retryAfter: Duration(seconds: 2),
            );
          },
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('code-confirm')));
    await tester.pump();
    expect(find.textContaining('PIN이 올바르지 않습니다. · 2초 후'), findsOneWidget);
    expect(find.text('2초 후 다시 시도'), findsOneWidget);
  });
}
