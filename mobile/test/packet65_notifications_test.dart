import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/keepalive.dart' as remote_keepalive;
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/response_notifications.dart';
import 'package:iris_remote/screens/notification_navigation.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';

RemoteAgent agent(
  String ref, {
  String kind = 'codex',
  String status = 'idle',
  bool question = false,
}) => RemoteAgent(
  ref: ref,
  name: ref,
  kind: kind,
  status: status,
  question: question,
  space: 'space',
  spaceRef: 'space',
  spaceOrder: 0,
  sessionOrder: 0,
  parent: null,
  lastActivityAt: null,
  can: const AgentPermissions(stop: false, message: false),
);
RemoteRequest request(
  String ref,
  String owner, {
  String kind = 'claude-question',
}) => RemoteRequest(
  ref: ref,
  agent: owner,
  kind: kind,
  createdAt: 1,
  expiresAt: 2,
  body: const QuestionRequestBody([]),
);

void main() {
  test('요청·보관 질문·대기 에이전트 집합과 중복 제거', () {
    final items = responseItems(
      requests: [
        request('permission', 'a', kind: 'claude-permission'),
        request('browser', 'b', kind: 'browser-user'),
      ],
      terminalQuestions: [request('question', 'c'), request('question', 'c')],
      agents: [
        agent('a', question: true),
        agent('b', status: 'blocked'),
        agent('c', question: true),
        agent('d', question: true),
        agent('e', status: 'blocked'),
        agent('f', kind: 'terminal', question: true),
        agent('g'),
      ],
    );
    expect(items, {
      'request:permission': 'a',
      'request:browser': 'b',
      'request:question': 'c',
      'agent:d:idle:true': 'd',
      'agent:e:blocked:false': 'e',
    });
    final both = responseItems(
      requests: [request('question', 'c')],
      terminalQuestions: [request('question', 'c')],
      agents: [],
    );
    expect(both.length, 1);
  });

  test('식별자 교체·해결·0건·재등장·상태 변경', () {
    final notifications = ResponseNotifications();
    expect(notifications.update({'one': 'a'}, foreground: false).alert, true);
    expect(notifications.update({'one': 'a'}, foreground: false).alert, false);
    final replaced = notifications.update({'two': 'a'}, foreground: false);
    expect(replaced.count, 1);
    expect(replaced.alert, true);
    final empty = notifications.update({}, foreground: false);
    expect(empty.remove, true);
    expect(empty.alert, false);
    expect(notifications.update({'two': 'a'}, foreground: false).alert, true);
    expect(
      notifications.update({'two': 'a', 'three': 'b'}, foreground: false).alert,
      true,
    );
    expect(
      notifications.update({'three': 'b'}, foreground: false).alert,
      false,
    );
    final first = responseItems(
      requests: [],
      terminalQuestions: [],
      agents: [agent('a', question: true)],
    );
    final second = responseItems(
      requests: [],
      terminalQuestions: [],
      agents: [agent('a', status: 'blocked')],
    );
    notifications.update(first, foreground: false);
    expect(notifications.update(second, foreground: false).alert, true);
  });

  test('같은 요청이 상태 항목과 요청 항목으로 번갈아 나타나도 한 번만 울림', () {
    final notifications = ResponseNotifications();
    expect(
      notifications.update({
        'agent:a:blocked:false': 'a',
      }, foreground: false).alert,
      true,
    );
    final arrived = notifications.update({
      'request:r1': 'a',
    }, foreground: false);
    expect(arrived.count, 1);
    expect(arrived.alert, false);
    final resolved = notifications.update({
      'agent:a:blocked:false': 'a',
    }, foreground: false);
    expect(resolved.count, 1);
    expect(resolved.alert, false);
    expect(notifications.update({}, foreground: false).remove, true);
    expect(
      notifications.update({'request:r2': 'a'}, foreground: false).alert,
      true,
    );
  });

  test('전면 해당 에이전트만 억제, 다른 화면·백그라운드·혼합 도착 알림', () {
    final notifications = ResponseNotifications();
    expect(
      notifications
          .update({'one': 'a'}, foreground: true, visibleAgent: 'a')
          .alert,
      false,
    );
    expect(
      notifications
          .update({'one': 'a'}, foreground: false, visibleAgent: 'a')
          .alert,
      false,
    );
    expect(
      notifications
          .update({'two': 'a'}, foreground: false, visibleAgent: 'a')
          .alert,
      true,
    );
    expect(
      notifications
          .update({'three': 'a'}, foreground: true, visibleAgent: 'b')
          .alert,
      true,
    );
    expect(notifications.update({'four': 'a'}, foreground: true).alert, true);
    expect(
      notifications
          .update(
            {'five': 'a', 'six': 'b'},
            foreground: true,
            visibleAgent: 'a',
          )
          .alert,
      true,
    );
  });

  testWidgets('현재 화면 헤더의 선택 에이전트, 시트·브라우저 억제 제외, 클릭 홈 이동', (tester) async {
    final navigation = NotificationNavigation();
    final key = GlobalKey<NavigatorState>();
    Widget screen(String ref, SessionMode mode) => Scaffold(
      body: IrisSessionHeader(
        title: ref,
        subtitle: 'space',
        mode: mode,
        tabs: [
          IrisAgentTab(agent: agent(ref), selected: true, onPressed: () {}),
        ],
        onBack: () {},
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        navigatorKey: key,
        navigatorObservers: [navigation],
        home: const Scaffold(body: Text('home')),
      ),
    );
    key.currentState!.push(
      MaterialPageRoute<void>(builder: (_) => screen('a', SessionMode.chat)),
    );
    await tester.pumpAndSettle();
    expect(navigation.visibleAgent, 'a');
    showModalBottomSheet<void>(
      context: key.currentContext!,
      builder: (_) => const Text('sheet'),
    );
    await tester.pumpAndSettle();
    expect(navigation.visibleAgent, isNull);
    key.currentState!.pop();
    await tester.pumpAndSettle();
    expect(navigation.visibleAgent, 'a');
    key.currentState!.pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => screen('b', SessionMode.terminal),
      ),
    );
    await tester.pumpAndSettle();
    expect(navigation.visibleAgent, 'b');
    key.currentState!.push(
      MaterialPageRoute<void>(builder: (_) => screen('b', SessionMode.browser)),
    );
    await tester.pumpAndSettle();
    expect(navigation.visibleAgent, isNull);
    navigation.openResponses();
    await tester.pumpAndSettle();
    expect(find.text('home'), findsOneWidget);
    expect(navigation.visibleAgent, isNull);
  });

  testWidgets('홈 알림 클릭은 스크롤한 응답 대기 목록의 처음으로 이동', (tester) async {
    Widget home(int focus) => AgentHomeView(
      responseFocus: focus,
      agents: [for (var i = 0; i < 30; i++) agent('$i')],
      requests: const [],
      connectionName: 'Mac',
      onOpenAgent: (_) {},
      onOpenRequest: (_, _) async {},
      onAnswerPermission: (_, _) async =>
          const RequestAnswerResult(rid: 'x', result: 'delivered'),
      onAnswerQuestion: (_, _, _) async =>
          const RequestAnswerResult(rid: 'x', result: 'delivered'),
      onSettings: () {},
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: home(0),
      ),
    );
    await tester.drag(
      find.byKey(const Key('home-scroll')),
      const Offset(0, -700),
    );
    await tester.pumpAndSettle();
    final scroll = tester.state<ScrollableState>(
      find
          .descendant(
            of: find.byKey(const Key('home-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(scroll.position.pixels, greaterThan(0));
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: home(1),
      ),
    );
    await tester.pumpAndSettle();
    expect(scroll.position.pixels, 0);
  });

  test('Android 채널에 개수·울림 전달, 클릭 수신과 초기 클릭 소비', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('iris.remote/keepalive');
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return call.method == 'takeOpenResponses' ? true : null;
    });
    const keepAlive = remote_keepalive.KeepAlive();
    await keepAlive.update(1, alert: true);
    await keepAlive.update(0);
    expect(calls[0].arguments, {'requestCount': 1, 'alert': true});
    expect(calls[1].arguments, {'requestCount': 0, 'alert': false});
    expect(await keepAlive.takeOpenResponses(), true);
    var opened = false;
    keepAlive.onOpenResponses(() => opened = true);
    await messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('openResponses'),
      ),
      (_) {},
    );
    expect(opened, true);
    keepAlive.onOpenResponses(null);
    messenger.setMockMethodCallHandler(channel, null);
  });
}
