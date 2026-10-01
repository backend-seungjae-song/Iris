import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/code_screen.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/screens/qr_scanner_screen.dart';
import 'package:iris_remote/screens/start_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

import 'design_fixture.dart';

const _screenSize = Size(394, 854);
const _safeTop = 54.0;
const _goldenKey = Key('golden-scene');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadDesignReferenceFont);

  for (final brightness in Brightness.values) {
    final tone = brightness.name;

    testWidgets('$tone H 홈', (tester) async {
      await _pumpScene(tester, designHome(), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-h.png'),
      );
    });

    testWidgets('$tone Sa 세션', (tester) async {
      await _pumpScene(tester, designSession(), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-sa.png'),
      );
    });

    testWidgets('$tone Sb 허용 시트', (tester) async {
      await _pumpScene(tester, designPermissionScene(), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-sb.png'),
      );
    });

    testWidgets('$tone Sc 선택 질문 시트', (tester) async {
      await _pumpScene(tester, designQuestionScene(), brightness);
      await tester.tap(find.byKey(const Key('question-option-first')));
      await tester.pumpAndSettle();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-sc.png'),
      );
    });

    testWidgets('$tone Sd 사람 차례 시트', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designHumanScene(remote)),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-sd.png'),
      );
    });

    testWidgets('$tone Ba AI 조작 중 브라우저', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-ba.png'),
      );
    });

    testWidgets('$tone Bb 요소 선택해 요청', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
        brightness,
      );
      await tester.tap(find.text('요소 선택'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('browser-frame')));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('browser-element-input')),
        '버튼 문구를 “결제하기”로 바꿔 줘',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-bb.png'),
      );
    });

    testWidgets('$tone Bc 직접 조작 중', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designBrowserScene(remote, human: true),
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-bc.png'),
      );
    });

    testWidgets('$tone Bd 조작 기록', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
        brightness,
      );
      await tester.tap(find.text('조작 기록'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-bd.png'),
      );
    });

    testWidgets('$tone Be 스케치', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
        brightness,
      );
      await tester.tap(find.text('스케치'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, '그림과 함께 보낼 글'),
        '결제 버튼을 더 크게, 테두리 부분 강조',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      final rect = tester.getRect(find.byKey(const Key('browser-frame')));
      final gesture = await tester.startGesture(
        Offset(rect.left + 30, rect.bottom - 140),
      );
      await gesture.moveTo(Offset(rect.right - 30, rect.bottom - 130));
      await gesture.up();
      await tester.pumpAndSettle();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-be.png'),
      );
    });

    testWidgets('$tone Bf 더보기', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designBrowserScene(remote, frame: 'more'),
        ),
        brightness,
      );
      await _openBrowserMore(tester);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-bf.png'),
      );
    });

    testWidgets('$tone Bg 데스크톱 보기', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
        brightness,
      );
      await _openBrowserMore(tester);
      await tester.tap(find.text('데스크톱 보기'));
      for (var index = 0; index < 8; index += 1) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.pumpAndSettle();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-bg.png'),
      );
    });

    testWidgets('$tone Ta 터미널', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designTerminalScene(remote)),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-ta.png'),
      );
    });

    testWidgets('$tone Tb 키 설정', (tester) async {
      await _pumpScene(tester, designKeySettings(), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-tb.png'),
      );
    });

    testWidgets('$tone Tc 키 추가 시트', (tester) async {
      await _pumpScene(tester, designKeyEditorScene(), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-tc.png'),
      );
    });

    testWidgets('$tone Ga 변경과 PR 시트', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designSourceControlScene(remote),
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-ga.png'),
      );
    });

    testWidgets('$tone Gb diff 줄 의견', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(builder: (_, remote) => designDiffScene(remote)),
        brightness,
      );
      await tester.tap(find.text('+ row.append(text(pr.label));'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('diff-comment-input')),
        '이름이 길면 PR 글자가 잘립니다. 이름 쪽을 줄이고 PR 글자는 남겨 주세요.',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-gb.png'),
      );
    });

    testWidgets('$tone Gc 검사 실패 로그', (tester) async {
      await _pumpScene(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designCheckFailureScene(remote),
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-gc.png'),
      );
    });

    testWidgets('$tone 시작', (tester) async {
      await _pumpScene(tester, StartScreen(onScan: () {}), brightness);
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-start.png'),
      );
    });

    testWidgets('$tone QR 스캔', (tester) async {
      await _pumpScene(
        tester,
        QrScannerView(
          onBack: () {},
          camera: const ColoredBox(color: Color(0xff1b2c38)),
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-qr.png'),
      );
    });

    testWidgets('$tone 확인 코드', (tester) async {
      await _pumpScene(
        tester,
        CodeScreen(
          pending: const PendingPairing(
            settings: PairingSettings(
              address: '100.64.0.1',
              port: 9494,
              certHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              deviceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            ),
            code: '482913',
          ),
          onConfirm: () async {},
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-code.png'),
      );
    });

    testWidgets('$tone 연결 끊김', (tester) async {
      await _pumpScene(
        tester,
        DisconnectedView(
          busy: false,
          status: 'Mac과 연결이 끊겼습니다.',
          onConnect: () {},
          onUnregister: () {},
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-disconnected.png'),
      );
    });

    testWidgets('$tone 잠금 해제 대기', (tester) async {
      await _pumpScene(
        tester,
        DisconnectedView(
          busy: true,
          status: '폰 잠금을 확인한 뒤 Mac에 연결합니다.',
          onConnect: () {},
          onUnregister: () {},
        ),
        brightness,
      );
      await expectLater(
        find.byKey(_goldenKey),
        matchesGoldenFile('goldens/$tone-unlock.png'),
      );
    });
  }
}

Future<void> _openBrowserMore(WidgetTester tester) async {
  await tester.tap(find.text('더보기'));
  for (var index = 0; index < 8; index += 1) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 80)),
  );
  for (final element in find.byType(Image).evaluate()) {
    final image = element.widget as Image;
    await tester.runAsync(() => precacheImage(image.image, element));
  }
  await tester.pumpAndSettle();
}

Future<void> _pumpScene(
  WidgetTester tester,
  Widget scene,
  Brightness brightness,
) async {
  tester.view.physicalSize = _screenSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: designTestTheme(brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: const EdgeInsets.only(top: _safeTop, bottom: 34),
          viewPadding: const EdgeInsets.only(top: _safeTop, bottom: 34),
          textScaler: TextScaler.noScaling,
        ),
        child: RepaintBoundary(key: _goldenKey, child: child!),
      ),
      home: scene,
    ),
  );
  for (var index = 0; index < 8; index += 1) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
