import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'packet61_test.dart' as prior;

void main() {
  testWidgets('터미널 브라우저 버튼은 같은 스페이스의 세션 탭으로 이동', (tester) async {
    final remote = prior.setup('codex', browser: true);
    await remote.state.initialize();
    await tester.pumpWidget(
      prior.app(AgentScreen(state: remote.state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-terminal')));
    await tester.pumpAndSettle();
    expect(find.byType(TerminalScreen), findsOneWidget);
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(BrowserScreen), findsOneWidget);
    expect(
      remote.connection.sent.lastWhere(
        (request) => request['type'] == 'browser.frame.watch',
      )['tab'],
      prior.t,
    );
    await tester.pumpWidget(const SizedBox());
    remote.state.dispose();
    await remote.session.disconnect();
  });

  testWidgets('브라우저·터미널 왕복은 같은 세션 탭을 유지', (tester) async {
    final remote = prior.setup('codex', browser: true);
    await remote.state.initialize();
    await tester.pumpWidget(
      prior.app(AgentScreen(state: remote.state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(BrowserScreen), findsOneWidget);
    await tester.tap(find.byKey(const Key('browser-terminal')));
    await tester.pumpAndSettle();
    expect(find.byType(TerminalScreen), findsOneWidget);
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(BrowserScreen), findsOneWidget);
    expect(
      remote.connection.sent.lastWhere(
        (request) => request['type'] == 'browser.frame.watch',
      )['tab'],
      prior.t,
    );
    await tester.pumpWidget(const SizedBox());
    remote.state.dispose();
    await remote.session.disconnect();
  });

  testWidgets('같은 스페이스 탭이 없으면 공유 탭으로 이동하지 않고 안내', (tester) async {
    final empty = EmptyTabsWire();
    final session = ActiveRemoteSession.attach(
      macName: 'Mac',
      capabilities: const [
        'browser.tabs',
        'browser.frame.watch',
        'terminal.watch',
        'watch',
      ],
      connection: empty,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      prior.app(AgentScreen(state: state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-terminal')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(BrowserScreen), findsNothing);
    expect(find.text('이 스페이스에 브라우저 탭이 없습니다'), findsOneWidget);
    expect(
      empty.sent.where((request) => request['type'] == 'browser.frame.watch'),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });
}

class EmptyTabsWire extends prior.Wire {
  EmptyTabsWire() : super('codex');

  @override
  void sendJson(Map<String, Object> message) {
    if (message['type'] == 'browser.tabs') {
      sent.add(message);
      emit({
        'type': 'browser.tabs.result',
        'rid': message['rid'],
        'spaces': [
          {'ref': '99999999999999999999999999999999', 'name': '공유'},
        ],
        'tabs': [
          {
            'ref': prior.b,
            'space': '99999999999999999999999999999999',
            'title': '공유 탭',
            'url': 'https://example.test',
            'profile': '기본',
            'aiControlled': false,
            'controlling': <String>[],
            'sessions': <String>[],
            'active': true,
            'sleeping': true,
          },
        ],
      });
      return;
    }
    super.sendJson(message);
  }
}
