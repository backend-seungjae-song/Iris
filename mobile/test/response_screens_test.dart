import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/response_kit.dart';

import 'design_fixture.dart';

RemoteRequest _perm(String tool, String input) => RemoteRequest(
  ref: 'r1',
  agent: 'a1',
  kind: 'permission',
  createdAt: DateTime.now().millisecondsSinceEpoch,
  expiresAt: DateTime.now().millisecondsSinceEpoch + 600000,
  body: PermissionRequestBody(tool: tool, description: '설명', input: input),
);

Finder get _primary => find
    .descendant(
      of: find.byType(IrisActionBar),
      matching: find.byType(TextButton),
    )
    .last;

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(412, 892);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(theme: designTestTheme(Brightness.dark), home: home),
  );
  await tester.pumpAndSettle();
}

PermissionRequestSheet _sheet(
  RemoteRequest request,
  Future<RequestAnswerResult> Function(bool) onAnswer, {
  ResponseNav? nav,
}) => PermissionRequestSheet(
  request: request,
  agentName: '세션',
  agentKind: 'claude',
  space: 'iris',
  nav: nav,
  onAnswer: onAnswer,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadDesignReferenceFont);

  testWidgets('승인은 답을 고른 뒤 보내기를 눌러야 전달되고 거절은 true 로 닫힌다', (tester) async {
    final answers = <bool>[];
    bool? popped;
    await _pump(
      tester,
      Builder(
        builder: (context) => TextButton(
          onPressed: () async => popped = await Navigator.of(context)
              .push<bool>(
                MaterialPageRoute(
                  builder: (_) => _sheet(_perm('Bash', 'ls'), (allow) async {
                    answers.add(allow);
                    return const RequestAnswerResult(
                      rid: 'x',
                      result: 'delivered',
                    );
                  }),
                ),
              ),
          child: const Text('열기'),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextButton>(_primary).onPressed, isNull);

    await tester.tap(find.byKey(const Key('permission-option-2')));
    await tester.pumpAndSettle();
    expect(answers, isEmpty);
    expect(find.text('‘거절’ 보내기'), findsOneWidget);

    await tester.tap(_primary);
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(answers, [false]);
    expect(popped, isTrue);
  });

  testWidgets('이미 답한 결과는 이미 답함 화면과 홈으로 버튼을 보인다', (tester) async {
    await _pump(
      tester,
      _sheet(
        _perm('Bash', 'ls'),
        (_) async =>
            const RequestAnswerResult(rid: 'x', result: 'already-answered'),
      ),
    );
    await tester.tap(find.byKey(const Key('permission-option-1')));
    await tester.pumpAndSettle();
    await tester.tap(_primary);
    await tester.pumpAndSettle();
    expect(find.text('이미 답했습니다'), findsOneWidget);
    expect(find.text('홈으로'), findsOneWidget);
  });

  testWidgets('파일 수정 승인은 diff 를 접어 보이고 명령 승인은 diff 가 없다', (tester) async {
    const diff = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n d\n e\n f\n g\n h\n i\n j\n k';
    await _pump(
      tester,
      _sheet(_perm('Edit', diff), (_) async => throw StateError('no')),
    );
    expect(find.byKey(const Key('response-diff')), findsOneWidget);
    expect(find.textContaining('나머지 변경'), findsOneWidget);
    await tester.tap(find.byKey(const Key('response-diff-more')));
    await tester.pumpAndSettle();
    expect(find.text('접기'), findsOneWidget);

    await _pump(
      tester,
      _sheet(_perm('Bash', diff), (_) async => throw StateError('no')),
    );
    expect(find.byKey(const Key('response-diff')), findsNothing);
  });

  testWidgets('위아래 이동 버튼은 이전·다음 요청 동작을 부르고 없으면 눌리지 않는다', (tester) async {
    var prev = 0, next = 0;
    await _pump(
      tester,
      _sheet(
        _perm('Bash', 'ls'),
        (_) async => throw StateError('no'),
        nav: ResponseNav(index: 1, count: 3, onPrev: () => prev++),
      ),
    );
    expect(find.text('2 / 3'), findsOneWidget);
    await tester.tap(find.byKey(const Key('response-prev')));
    await tester.tap(find.byKey(const Key('response-next')));
    expect([prev, next], [1, 0]);
  });

  testWidgets('사람 차례는 미리보기를 누르면 확대 뷰가 열리고 닫기로 돌아온다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(builder: (_, remote) => designHumanScene(remote)),
    );
    expect(find.text('탭 열기'), findsNothing);
    expect(find.text('그 탭 열어보기'), findsNothing);
    await tester.tap(find.byKey(const Key('human-turn-frame')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('human-turn-zoom')), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    await tester.tap(find.byKey(const Key('human-turn-zoom-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('human-turn-zoom')), findsNothing);
    expect(find.byKey(const Key('human-turn-frame')), findsOneWidget);
  });
}
