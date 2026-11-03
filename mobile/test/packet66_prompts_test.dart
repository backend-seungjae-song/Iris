import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/remote/response_notifications.dart';
import 'package:iris_remote/screens/terminal_question_card.dart';

import 'packet61_test.dart' as prior;

const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
Map<String, Object?> message() => {
  'type': 'terminal.questions',
  'questions': [
    {
      'ref': prior.b,
      'agent': prior.a,
      'kind': 'terminal-prompt',
      'createdAt': 1,
      'expiresAt': 2,
      'body': {
        'questions': [
          {
            'question': 'Continue?',
            'header': '터미널 질문',
            'multiSelect': false,
            'options': [
              {'label': '› 1. Yes', 'description': ''},
              {'label': '2. Other', 'description': ''},
            ],
          },
        ],
        'screen': {
          'question': 'Continue?',
          'hash': hash,
          'columns': 80,
          'rows': 24,
          'selectedRow': 3,
          'multiSelect': false,
          'options': [
            {'row': 3, 'text': '› 1. Yes', 'selectable': true},
            {'row': 4, 'text': '2. Other', 'selectable': false},
          ],
        },
      },
    },
  ],
};

class Wire extends prior.Wire {
  Wire() : super('codex');
  bool stale = false;
  @override
  void sendJson(Map<String, Object> m) {
    if (m['type'] == 'terminal.select') {
      sent.add(m);
      emit(
        stale
            ? {
                'type': 'error',
                'rid': m['rid'],
                'error': {'code': 'terminal-stale-screen'},
              }
            : {
                'type': 'remote.action.result',
                'rid': m['rid'],
                'result': 'sent',
              },
      );
    } else {
      super.sendJson(m);
    }
  }
}

void main() {
  test('66 파서와 무내용 알림 집합', () {
    final parsed =
        parseServerMessage(jsonEncode(message())) as TerminalQuestionsMessage;
    final q = parsed.questions.single;
    expect(
      (q.body as QuestionRequestBody).screen!.options.last.selectable,
      false,
    );
    expect(responseItems(requests: [], terminalQuestions: [q], agents: []), {
      'prompt:${prior.a}': prior.a,
    });
    // 화면 안 타이머로 ref 가 매초 바뀌어도 같은 에이전트는 알림 식별자가 같음
    final tick = message();
    (tick['questions'] as List).single['ref'] = 'c' * 32;
    final q2 = (parseServerMessage(
      jsonEncode(tick),
    ) as TerminalQuestionsMessage).questions.single;
    expect(
      responseItems(requests: [], terminalQuestions: [q2], agents: []).keys,
      responseItems(requests: [], terminalQuestions: [q], agents: []).keys,
    );
    final invalid = message();
    ((invalid['questions'] as List).single['body']['screen']
            as Map)['columns'] =
        0;
    expect(
      () => parseServerMessage(jsonEncode(invalid)),
      throwsA(isA<ProtocolException>()),
    );
  });
  test('승인 훅의 도구 이름·대상을 파싱하고 잘못된 값은 거부', () {
    final withTool = message();
    final screen =
        (withTool['questions'] as List).single['body']['screen'] as Map;
    screen['tool'] = 'Bash';
    screen['target'] = 'ls -la';
    final parsed = (parseServerMessage(
      jsonEncode(withTool),
    ) as TerminalQuestionsMessage).questions.single;
    final shown = (parsed.body as QuestionRequestBody).screen!;
    expect(shown.tool, 'Bash');
    expect(shown.target, 'ls -la');
    expect(
      (((parseServerMessage(
                jsonEncode(message()),
              ) as TerminalQuestionsMessage).questions.single.body)
              as QuestionRequestBody)
          .screen!
          .tool,
      '',
    );
    screen['tool'] = 3;
    expect(
      () => parseServerMessage(jsonEncode(withTool)),
      throwsA(isA<ProtocolException>()),
    );
  });
  test('66 체크 상태가 있는 옵션도 파싱', () {
    final checked = message();
    final options =
        ((checked['questions'] as List).single['body']['screen']
                as Map)['options']
            as List;
    (options.first as Map)['checked'] = true;
    final q = (parseServerMessage(
      jsonEncode(checked),
    ) as TerminalQuestionsMessage).questions.single;
    expect((q.body as QuestionRequestBody).screen!.options.first.checked, true);
  });
  testWidgets('66 선택 탭은 화면 식별자로 한 번 전송하고 변경 안내 후 재시도', (tester) async {
    var opened = 0;
    final wire = Wire()..stale = true;
    final session = ActiveRemoteSession.attach(
      capabilities: const ['terminal.watch', 'terminal.select'],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final q = (parseServerMessage(
      jsonEncode(message()),
    ) as TerminalQuestionsMessage).questions.single;
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: Scaffold(
          body: TerminalQuestionCard(
            request: q,
            agentName: 'Codex',
            onOpen: () => opened++,
          ),
        ),
      ),
    );
    expect(find.text('예'), findsOneWidget);
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: Scaffold(
          body: TerminalQuestionCard(
            request: q,
            agentName: 'Codex',
            session: session,
            onOpen: () => opened++,
          ),
        ),
      ),
    );
    expect(find.text('Continue?'), findsOneWidget);
    await tester.tap(find.text('Other'));
    await tester.pump();
    expect(opened, 1);
    expect(wire.sent.where((m) => m['type'] == 'terminal.select'), isEmpty);
    await tester.tap(find.text('예'));
    await tester.pumpAndSettle();
    expect(find.text('화면이 바뀌었습니다. 새로 고침하세요.'), findsOneWidget);
    expect(
      wire.sent.where((m) => m['type'] == 'terminal.select').single['hash'],
      hash,
    );
    wire.stale = false;
    await tester.tap(find.text('예'));
    await tester.pumpAndSettle();
    expect(wire.sent.where((m) => m['type'] == 'terminal.select').length, 2);
    await tester.tap(find.text('예'));
    await tester.pumpAndSettle();
    expect(wire.sent.where((m) => m['type'] == 'terminal.select').length, 3);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpWidget(const SizedBox());
    await session.disconnect();
  });
}
