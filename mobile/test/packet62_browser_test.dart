import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/browser_screen.dart';

import 'packet61_test.dart' as prior;

import 'package:iris_remote/design/browser_groups.dart';
import 'package:iris_remote/remote/protocol.dart';

const _space = '11111111111111111111111111111111';
BrowserTab _tab(String ref, {String? group}) => BrowserTab(
  ref: ref,
  space: _space,
  title: ref,
  url: 'https://example.test',
  profile: '기본',
  aiControlled: false,
  controlling: const [],
  group: group,
  active: ref == 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sleeping: false,
);

void main() {
  for (final fail in [false, true]) {
    testWidgets('링크 열기 ${fail ? "실패 이동 없음" : "성공 exact tab과 agent로 이동"}', (
      tester,
    ) async {
      final wire = BrowserWire()..failOpen = fail;
      final session = ActiveRemoteSession.attach(
        macName: 'Mac',
        capabilities: [
          'watch',
          'transcript.page',
          'transcript.watch',
          'browser.tabs',
          'browser.tab.new',
          'browser.frame.watch',
        ],
        connection: wire,
        pingInterval: const Duration(days: 1),
      );
      final state = RemoteState(session);
      await state.initialize();
      await tester.pumpWidget(
        prior.app(AgentScreen(state: state, agentRef: prior.a)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('문서', findRichText: true));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const Key('markdown-link-mac')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      if (fail) {
        expect(find.byType(BrowserScreen), findsNothing);
        expect(
          wire.sent.where(
            (request) => request['type'] == 'browser.frame.watch',
          ),
          isEmpty,
        );
      } else {
        final screen = tester.widget<BrowserScreen>(find.byType(BrowserScreen));
        expect(screen.agentRef, prior.a);
        expect(screen.tabRef, prior.b);
        expect(
          wire.sent.lastWhere(
            (request) => request['type'] == 'browser.frame.watch',
          )['tab'],
          prior.b,
        );
      }
      await tester.pumpWidget(const SizedBox());
      state.dispose();
      await session.disconnect();
    });
  }
  testWidgets('서버 접힘 초기값과 폰 펼침·접힘은 선택 탭 구독 유지', (tester) async {
    final wire = BrowserWire();
    final session = ActiveRemoteSession.attach(
      macName: 'Mac',
      capabilities: ['watch', 'browser.tabs', 'browser.frame.watch'],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      prior.app(
        BrowserScreen(state: state, agentRef: prior.a, tabRef: prior.b),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('그룹 탭'), findsNothing);
    expect(find.text('작업 그룹'), findsOneWidget);
    await tester.tap(find.text('작업 그룹'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('그룹 탭'), findsOneWidget);
    await tester.tap(find.text('작업 그룹'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('그룹 탭'), findsNothing);
    expect(
      wire.sent
          .where((request) => request['type'] == 'browser.frame.watch')
          .length,
      1,
    );
    expect(state.browserTabGroups.single.collapsed, true);
    expect(
      wire.sent.any(
        (request) => (request['type'] as String).contains('group.'),
      ),
      false,
    );
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });
  test('탭 그룹은 소속 탭과 접힘 상태를 보존한다', () {
    const group = BrowserTabGroupInfo(
      ref: 'cccccccccccccccccccccccccccccccc',
      space: _space,
      name: '작업',
      collapsed: true,
      color: '#f00',
    );
    final result = browserTabGroups(
      _tab('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', group: group.ref),
      [
        _tab('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', group: group.ref),
        _tab('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      ],
      [group],
    );
    expect(result.first.name, '작업');
    expect(result.first.collapsed, isTrue);
    expect(result.first.color, '#f00');
    expect(result.first.tabs.single.ref, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.last.tabs.single.ref, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
}

class BrowserWire extends prior.Wire {
  BrowserWire() : super('codex');
  @override
  void sendJson(Map<String, Object> message) {
    if (message['type'] == 'browser.tabs') {
      sent.add(message);
      emit({
        'type': 'browser.tabs.result',
        'rid': message['rid'],
        'spaces': [
          {'ref': prior.s, 'name': '하나'},
        ],
        'groups': [
          {
            'ref': 'cccccccccccccccccccccccccccccccc',
            'space': prior.s,
            'name': '작업 그룹',
            'collapsed': true,
            'color': '#ff0000',
          },
        ],
        'tabs': [
          {
            'ref': prior.b,
            'space': prior.s,
            'title': '그룹 탭',
            'url': 'https://example.test',
            'profile': '기본',
            'aiControlled': false,
            'controlling': <String>[],
            'active': true,
            'sleeping': true,
            'sessions': [prior.a],
            'group': 'cccccccccccccccccccccccccccccccc',
          },
        ],
      });
    } else if (message['type'] == 'browser.tab.new' && !failOpen) {
      sent.add(message);
      emit({
        'type': 'remote.action.result',
        'rid': message['rid'],
        'result': 'done',
        'tab': prior.b,
      });
    } else {
      super.sendJson(message);
    }
  }
}
