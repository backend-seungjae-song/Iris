import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/connection_screen.dart';

import 'design_fixture.dart';

Widget _app(Widget home) => MaterialApp(
  theme: designTestTheme(Brightness.dark),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: true),
    child: child!,
  ),
  home: home,
);

AgentHomeView _home({
  required List<RemoteAgent> agents,
  List<RemoteRequest> requests = const [],
  ValueChanged<RemoteAgent>? onOpenAgent,
}) => AgentHomeView(
  agents: agents,
  requests: requests,
  connectionName: 'Mac',
  onOpenAgent: onOpenAgent ?? (_) {},
  onAnswerPermission: (_, _) async =>
      const RequestAnswerResult(rid: 'x', result: 'delivered'),
  onAnswerQuestion: (_, _, _) async =>
      const RequestAnswerResult(rid: 'x', result: 'delivered'),
  onOpenRequest: (_, _) async {},
  onSettings: () {},
);

void main() {
  setUpAll(loadDesignReferenceFont);

  testWidgets('홈에는 하단 내비게이터가 없다', (tester) async {
    await tester.pumpWidget(_app(_home(agents: const [])));
    expect(find.byKey(const Key('nav-home')), findsNothing);
    expect(find.byKey(const Key('nav-terminal')), findsNothing);
    expect(find.byKey(const Key('nav-browser')), findsNothing);
  });

  testWidgets('질문이 없으면 질문 0과 빈 상태, 있으면 건수 배지', (tester) async {
    await tester.pumpWidget(_app(designHome(withRequests: false)));
    expect(find.text('질문이 없습니다'), findsOneWidget);
    expect(find.byKey(const Key('home-needed-count')), findsNothing);
    await tester.pumpWidget(_app(designHome(extended: false)));
    expect(find.byKey(const Key('home-needed-count')), findsOneWidget);
    expect(find.text('답할 것'), findsNothing);
  });

  testWidgets('연결 끊김 화면은 이름·칩·다시 연결을 보인다', (tester) async {
    var connected = 0;
    await tester.pumpWidget(
      _app(
        DisconnectedView(
          busy: false,
          status: '연결이 끊겼습니다.',
          name: 'MacBook',
          onConnect: () => connected++,
          onUnregister: () {},
        ),
      ),
    );
    expect(find.text('MacBook'), findsOneWidget);
    expect(find.text('연결 끊김'), findsOneWidget);
    await tester.tap(find.text('다시 연결'));
    expect(connected, 1);
  });
}
