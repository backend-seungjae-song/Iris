import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';

import 'packet61_test.dart' as prior;

class GitHubWire extends prior.Wire {
  GitHubWire(this.code) : super('codex');
  final String code;
  @override
  void sendJson(Map<String, Object> message) {
    if (message['type'] == 'git.changes') {
      sent.add(message);
      emit({
        'type': 'git.changes.result',
        'rid': message['rid'],
        'branch': 'feature/diff',
        'ahead': 1,
        'behind': 0,
        'base': 'main',
        'commitCount': 1,
        'additions': 3,
        'deletions': 1,
        'files': [
          {
            'ref': 'f'.padRight(32, 'a'),
            'path': 'lib/changed_file.dart',
            'code': 'M',
            'staged': false,
            'untracked': false,
            'additions': 3,
            'deletions': 1,
          },
        ],
        'bases': <Object>[],
      });
      return;
    }
    if (message['type'] == 'github.pr') {
      sent.add(message);
      emit({
        'type': 'error',
        'rid': message['rid'],
        'error': {'code': code},
      });
      return;
    }
    super.sendJson(message);
  }
}

void main() {
  testWidgets('PR을 못 불러와도 변경 파일 목록은 그대로 보인다', (tester) async {
    final wire = GitHubWire('no_pr');
    final session = ActiveRemoteSession.attach(
      capabilities: const [
        'watch',
        'transcript.page',
        'github.pr',
        'git.changes',
      ],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      prior.app(AgentScreen(state: state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-github')));
    await tester.pumpAndSettle();
    expect(find.textContaining('changed_file.dart'), findsOneWidget);
    expect(find.text('현재 브랜치에 연결된 GitHub PR이 없습니다.'), findsNothing);
    await tester.tap(find.text('PR'));
    await tester.pumpAndSettle();
    expect(find.text('현재 브랜치에 연결된 GitHub PR이 없습니다.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });

  for (final terminal in [false, true]) {
    for (final entry in const {
      'auth_required': 'Mac의 GitHub CLI가 로그인되어 있지 않습니다. gh auth login을 실행하세요.',
      'no_pr': '현재 브랜치에 연결된 GitHub PR이 없습니다.',
    }.entries) {
      testWidgets(
        '${terminal ? "터미널" : "대화"} GitHub 버튼 → 요청 → ${entry.key} 안내',
        (tester) async {
          final wire = GitHubWire(entry.key);
          final session = ActiveRemoteSession.attach(
            capabilities: const [
              'watch',
              'transcript.page',
              'github.pr',
              'terminal.watch',
            ],
            connection: wire,
            pingInterval: const Duration(days: 1),
          );
          final state = RemoteState(session);
          await state.initialize();
          await tester.pumpWidget(
            prior.app(
              terminal
                  ? TerminalScreen(state: state, agentRef: prior.a)
                  : AgentScreen(state: state, agentRef: prior.a),
            ),
          );
          await tester.pumpAndSettle();
          final before = wire.sent
              .where((item) => item['type'] == 'github.pr')
              .length;
          if (terminal) {
            await tester.tap(find.byKey(const Key('terminal-more')));
            await tester.pumpAndSettle();
          }
          await tester.tap(
            find.byKey(
              Key(terminal ? 'terminal-more-github' : 'session-github'),
            ),
          );
          await tester.pumpAndSettle();
          final requests = wire.sent.where(
            (item) => item['type'] == 'github.pr',
          );
          expect(requests.length, before + 1);
          expect(requests.last['agent'], prior.a);
          expect(find.text(entry.value), findsOneWidget);
          expect(find.textContaining('지원하지'), findsNothing);
          await tester.pumpWidget(const SizedBox());
          state.dispose();
          await session.disconnect();
        },
      );
    }
  }
}
