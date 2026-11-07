import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/screens/pin_screen.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';

import 'design_fixture.dart';

// 키보드가 열린 작은 폰 화면에서 레이아웃 오버플로우가 없어야 하는 화면 목록
Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  required double keyboard,
  required double scale,
}) async {
  tester.view.physicalSize = const Size(360, 740);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: designTestTheme(Brightness.dark),
      builder: (context, w) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: const EdgeInsets.only(top: 40, bottom: 24),
          viewPadding: const EdgeInsets.only(top: 40, bottom: 24),
          viewInsets: EdgeInsets.only(bottom: keyboard),
          textScaler: TextScaler.linear(scale),
          disableAnimations: true,
        ),
        child: w!,
      ),
      home: child,
    ),
  );
  await tester.pump(const Duration(milliseconds: 500));
}

// 오버플로우를 낸 위젯의 소스 위치를 남긴다
void _report() {
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    final text = details.toString();
    if (text.contains('test/design_fixture.dart')) return;
    final at = RegExp(r'[a-z_/]+\.dart:\d+:\d+').allMatches(text).map((m) => m.group(0)).take(3).join(' ');
    // ignore: avoid_print
    print('OVERFLOW ${details.exceptionAsString().split('\n').first} @ $at');
    previous?.call(details);
  };
  addTearDown(() => FlutterError.onError = previous);
}

// 실제 앱처럼 showIrisSheet 로 시트를 여는 화면
Widget _sheetHost(Widget Function(BuildContext) sheet) => Builder(
  builder: (context) => Scaffold(
    body: Center(
      child: TextButton(
        onPressed: () => showIrisSheet<void>(
          context: context,
          builder: sheet,
        ),
        child: const Text('열기'),
      ),
    ),
  ),
);

void main() {
  setUpAll(loadDesignReferenceFont);
  final scenes = <String, Widget Function()>{
    '대화 입력': () => designSession(),
    '접속 번호 입력': () => const AccessPinScreen(),
    '브라우저': () =>
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
    '터미널': () =>
        DesignRemoteScene(builder: (_, remote) => designTerminalScene(remote)),
    '변경 사항 시트': () => DesignRemoteScene(
      builder: (_, remote) => _sheetHost(
        (_) => SourceControlSheet(
          session: remote.session,
          agent: designAgents().first,
          initialChanges: designGitChanges,
          initialPr: designPr,
          onOpenDiff: (_) {},
        ),
      ),
    ),
    '질문 답하기': () => designQuestionScene(),
    '접속 번호 시트': () => _sheetHost(
      (_) => ConnectPinSheet(onSubmit: (_) async => null, retrySeconds: () => 0),
    ),
    '키 추가 시트': () => _sheetHost((_) => const TerminalKeyEditorSheet()),
  };
  for (final entry in scenes.entries) {
    for (final scale in [1.0, 1.3]) {
      testWidgets('${entry.key} · 키보드 330 · 글자 $scale배', (tester) async {
        _report();
        await _pump(tester, entry.value(), keyboard: 330, scale: scale);
        expect(tester.takeException(), isNull);
        if (find.text('열기').evaluate().isNotEmpty) {
          await tester.tap(find.text('열기'));
          await tester.pump(const Duration(milliseconds: 600));
          expect(tester.takeException(), isNull);
        }
        final fields = find.byType(TextField);
        if (fields.evaluate().isNotEmpty) {
          await tester.tap(fields.first, warnIfMissed: false);
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull);
        }
      });
    }
  }
}
