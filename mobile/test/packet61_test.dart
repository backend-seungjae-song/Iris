import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/browser_groups.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const s = '11111111111111111111111111111111';
const t = '22222222222222222222222222222222';
RemoteAgent agent(String ref, String kind, int order, {String space = s}) =>
    RemoteAgent(
      ref: ref,
      name: ref == a ? '세션 A' : '세션 B',
      kind: kind,
      status: 'idle',
      question: false,
      space: space == s ? '하나' : '둘',
      spaceRef: space,
      spaceOrder: space == s ? 0 : 1,
      sessionOrder: order,
      parent: null,
      lastActivityAt: null,
      can: const AgentPermissions(stop: false, message: false),
    );
BrowserTab tab(String ref, String space, List<String> sessions) => BrowserTab(
  ref: ref,
  space: space,
  title: ref,
  url: 'https://example.test',
  profile: '기본',
  aiControlled: sessions.isNotEmpty,
  controlling: const [],
  sessions: sessions,
  active: false,
  sleeping: true,
);

void main() {
  testWidgets('스페이스·세션·사용자 탭 순서와 소속', (tester) async {
    final agents = [agent(b, 'codex', 1), agent(a, 'codex', 0)];
    final spaces = [
      const BrowserSpace(ref: t, name: '둘'),
      const BrowserSpace(ref: s, name: '하나'),
    ];
    final tabs = [
      tab(a, s, [a]),
      tab(b, s, [b]),
      tab(s, s, []),
      tab(t, t, []),
    ];
    final groups = browserGroups(spaces, tabs, agents);
    expect(groups.map((g) => '${g.space.name}/${g.name}'), [
      '하나/세션 A',
      '하나/세션 B',
      '하나/사용자 탭',
      '둘/사용자 탭',
    ]);
    expect(groups[0].tabs.map((item) => item.ref), [a]);
    await tester.pumpWidget(
      app(
        AgentHomeView(
          agents: agents,
          requests: const [],
          connectionName: 'Mac',
          browserSpaces: spaces,
          browserTabs: tabs,
          onOpenAgent: (_) {},
          onOpenRequest: (_, _) async {},
          onAnswerPermission: (_, _) async =>
              const RequestAnswerResult(rid: 'x', result: 'delivered'),
          onAnswerQuestion: (_, _, _) async =>
              const RequestAnswerResult(rid: 'x', result: 'delivered'),
          onOpenBrowserTab: (_) {},
          onSettings: () {},
        ),
      ),
    );
    await tester.scrollUntilVisible(find.text('하나 · 세션 A'), 250);
    expect(find.text('하나 · 세션 A'), findsOneWidget);
    expect(find.text('하나 · 사용자 탭'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('하나 · 세션 A')).dy,
      lessThan(tester.getTopLeft(find.text('하나 · 세션 B')).dy),
    );
  });

  testWidgets('일반 터미널을 홈에서 열고 입력', (tester) async {
    final remote = setup('terminal');
    await remote.state.initialize();
    await tester.pumpWidget(
      app(
        AgentListScreen(
          state: remote.state,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('하나 · 터미널'), findsOneWidget);
    await tester.tap(
      find.byKey(const Key('agent-row-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
    );
    await tester.pumpAndSettle();
    expect(find.byType(TerminalScreen), findsOneWidget);
    expect(
      remote.connection.sent.any(
        (v) => v['type'] == 'terminal.watch' && v['agent'] == a,
      ),
      true,
    );
    await tester.enterText(find.byKey(const Key('terminal-input')), 'pwd');
    await tester.tap(find.byTooltip('보내기'));
    await tester.pumpAndSettle();
    expect(
      remote.connection.sent
          .where((v) => v['type'] == 'terminal.input')
          .single['text'],
      'pwd',
    );
    await tester.pumpWidget(const SizedBox());
    remote.state.dispose();
    await remote.session.disconnect();
  });

  testWidgets('채팅 링크 확인 뒤 Mac 새 탭 요청과 성공 안내', (tester) async {
    final remote = setup('codex');
    await remote.state.initialize();
    await tester.pumpWidget(app(AgentScreen(state: remote.state, agentRef: a)));
    await tester.pumpAndSettle();
    expect(
      remote.connection.sent.where((v) => v['type'] == 'browser.tab.new'),
      isEmpty,
    );
    await tester.tap(find.text('문서', findRichText: true));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('markdown-link-mac')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final request = remote.connection.sent
        .where((v) => v['type'] == 'browser.tab.new')
        .single;
    expect(request['url'], 'https://example.test/doc.pdf');
    expect(request['agent'], a);
    expect(request['space'], s);
    expect(find.text('Mac 브라우저에서 열었습니다'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    remote.state.dispose();
    await remote.session.disconnect();
  });
  for (final owned in [true, false]) {
    testWidgets('세션 브라우저 버튼 ${owned ? '소유 탭 우선' : '스페이스 탭 대체'}', (
      tester,
    ) async {
      final remote = setup('codex', browser: true);
      remote.connection.owned = owned;
      await remote.state.initialize();
      await tester.pumpWidget(
        app(AgentScreen(state: remote.state, agentRef: a)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-browser')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        remote.connection.sent
            .where((v) => v['type'] == 'browser.frame.watch')
            .last['tab'],
        owned ? t : b,
      );
      await tester.pumpWidget(const SizedBox());
      remote.state.dispose();
      await remote.session.disconnect();
    });
  }
  for (final kind in ['file', 'unsafe', 'failure', 'plain']) {
    testWidgets('채팅 링크 $kind 요청·거부·실패 안내', (tester) async {
      final remote = setup('codex');
      remote.connection.text = switch (kind) {
        'file' => '[문서](iris-media:$b)',
        'unsafe' => '[문서](javascript:alert)',
        'plain' => 'https://example.test/doc.pdf',
        _ => '[문서](https://example.test/doc.pdf)',
      };
      remote.connection.failOpen = kind == 'failure';
      await remote.state.initialize();
      await tester.pumpWidget(
        app(AgentScreen(state: remote.state, agentRef: a)),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.text(
          kind == 'plain' ? 'https://example.test/doc.pdf' : '문서',
          findRichText: true,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('markdown-link-mac')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      final requests = remote.connection.sent.where(
        (v) => v['type'] == 'browser.tab.new',
      );
      if (kind == 'unsafe') {
        expect(requests, isEmpty);
        expect(find.text('이 주소는 Mac 브라우저에서 열 수 없습니다.'), findsOneWidget);
      } else if (kind == 'file') {
        expect(requests.single['media'], b);
        expect(requests.single.containsKey('url'), false);
      } else if (kind == 'failure') {
        expect(
          find.text('Mac에서 이 항목을 더 이상 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 선택하세요.'),
          findsOneWidget,
        );
      } else {
        expect(requests.single['url'], 'https://example.test/doc.pdf');
      }
      await tester.pumpWidget(const SizedBox());
      remote.state.dispose();
      await remote.session.disconnect();
    });
  }
}

Widget app(Widget child) => MaterialApp(
  theme: ThemeData(extensions: [IrisColors.dark]),
  home: child,
);
({RemoteState state, ActiveRemoteSession session, Wire connection}) setup(
  String kind, {
  bool browser = false,
}) {
  final connection = Wire(kind);
  final session = ActiveRemoteSession.attach(
    macName: 'Mac',
    capabilities: [
      if (browser) ...['browser.tabs', 'browser.frame.watch'],
      'watch',
      'terminal.watch',
      'terminal.input',
      'transcript.page',
      'transcript.watch',
      'browser.tab.new',
    ],
    connection: connection,
    pingInterval: const Duration(days: 1),
  );
  return (
    state: RemoteState(session),
    session: session,
    connection: connection,
  );
}

class Wire implements RemoteConnection {
  Wire(this.kind);
  final String kind;
  bool owned = true;
  bool failOpen = false;
  String text = '[문서](https://example.test/doc.pdf)';
  final stream = StreamController<String>();
  late final iterator = StreamIterator<String>(stream.stream);
  final done = Completer<void>();
  final sent = <Map<String, Object>>[];
  void emit(Map<String, Object?> value) => stream.add(jsonEncode(value));
  @override
  Future<void> get closed => done.future;
  @override
  Future<String> receive() async {
    if (await iterator.moveNext()) return iterator.current;
    throw StateError('closed');
  }

  @override
  void sendJson(Map<String, Object> message) {
    sent.add(message);
    final rid = message['rid'];
    if (message['type'] == 'watch') {
      final value = agent(a, kind, 0);
      emit({
        'type': 'agents',
        'agents': [
          {
            'ref': a,
            'name': value.name,
            'kind': kind,
            'status': 'idle',
            'question': false,
            'space': value.space,
            'spaceRef': s,
            'spaceOrder': 0,
            'sessionOrder': 0,
            'parent': null,
            'lastActivityAt': null,
            'can': {'stop': false, 'message': false},
          },
        ],
      });
      emit({'type': 'requests', 'requests': []});
    } else if (message['type'] == 'terminal.watch') {
      emit({
        'type': 'terminal.watch.result',
        'rid': rid,
        'agent': a,
        'revision': 1,
        'text': '\$ ',
        'truncated': false,
      });
    } else if (message['type'] == 'transcript.page') {
      emit({
        'type': 'transcript',
        'rid': rid,
        'agent': a,
        'items': [
          {'role': 'assistant', 'text': text},
        ],
        'before': null,
      });
    } else if (message['type'] == 'browser.tabs') {
      emit({
        'type': 'browser.tabs.result',
        'rid': rid,
        'spaces': [
          {'ref': s, 'name': '하나'},
        ],
        'tabs': [
          for (final ref in [b, t])
            {
              'ref': ref,
              'space': s,
              'title': ref,
              'url': 'https://example.test',
              'profile': '기본',
              'aiControlled': owned && ref == t,
              'controlling': <String>[],
              'sessions': owned && ref == t ? [a] : <String>[],
              'active': ref == b,
              'sleeping': true,
            },
        ],
      });
    } else if (message['type'] == 'browser.frame.watch') {
      emit({
        'type': 'browser.frame.watch.result',
        'rid': rid,
        'tab': message['tab'],
        'watching': true,
      });
    } else if (message['type'] == 'browser.tab.new' && failOpen) {
      emit({
        'type': 'error',
        'rid': rid,
        'error': {'code': 'forbidden'},
      });
    } else if (message['type'] == 'terminal.input' ||
        message['type'] == 'browser.tab.new') {
      emit({'type': 'remote.action.result', 'rid': rid, 'result': 'done'});
    }
  }

  @override
  Future<void> close() async {
    if (!done.isCompleted) done.complete();
    unawaited(iterator.cancel());
    unawaited(stream.close());
  }
}
