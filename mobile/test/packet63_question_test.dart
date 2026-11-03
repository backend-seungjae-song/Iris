import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'packet61_test.dart' as prior;

Map<String, Object?> questionMessage({String agent = prior.a}) => {
  'type': 'terminal.questions',
  'questions': [
    {
      'ref': prior.b,
      'agent': agent,
      'kind': 'claude-question',
      'createdAt': 1,
      'expiresAt': 86400001,
      'body': {
        'questions': [
          {
            'question': '어느 색으로 할까요?',
            'header': '색',
            'multiSelect': false,
            'options': [
              {'label': '파랑', 'description': '선택 설명'},
            ],
          },
        ],
      },
    },
  ],
};

class QuestionWire extends prior.Wire {
  QuestionWire() : super('claude');
  int watches = 0;
  @override
  void sendJson(Map<String, Object> message) {
    if (message['type'] == 'session.watch') {
      watches++;
      super.sendJson({...message, 'type': 'watch'});
      emit(questionMessage());
    } else {
      super.sendJson(message);
    }
  }
}

void main() {
  test('터미널 질문 정확한 키 검사', () {
    final parsed = parseServerMessage(jsonEncode(questionMessage()));
    expect(parsed, isA<TerminalQuestionsMessage>());
    expect(
      (parsed as TerminalQuestionsMessage).questions.single.agent,
      prior.a,
    );
    final extra = questionMessage()..['paneId'] = 'private';
    expect(
      () => parseServerMessage(jsonEncode(extra)),
      throwsA(isA<ProtocolException>()),
    );
  });

  testWidgets('홈 질문 내용·선택지·동기화·눌러서 기존 터미널 진입', (tester) async {
    final wire = QuestionWire();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['session.watch', 'terminal.watch', 'terminal.key'],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: AgentListScreen(
          state: state,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('어느 색으로 할까요?', findRichText: true), findsOneWidget);
    expect(find.textContaining('파랑', findRichText: true), findsOneWidget);
    expect(find.text('터미널에서 답하기'), findsOneWidget);
    await tester.tap(find.byKey(const Key('home-refresh')));
    await tester.pumpAndSettle();
    expect(wire.watches, 2);
    await tester.tap(
      find.byKey(const Key('terminal-question-open-${prior.b}')),
    );
    await tester.pumpAndSettle();
    expect(find.byType(TerminalScreen), findsOneWidget);
    expect(
      wire.sent.where((m) => m['type'] == 'terminal.watch').single['agent'],
      prior.a,
    );
    expect(
      wire.sent.where(
        (m) => m['type'] == 'terminal.key' || m['type'] == 'terminal.input',
      ),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });

  testWidgets('대화 질문 표시·다른 pane 제외·종료 삭제·caps 없는 조작 숨김', (tester) async {
    final wire = QuestionWire();
    final session = ActiveRemoteSession.attach(
      capabilities: const [
        'session.watch',
        'terminal.watch',
        'terminal.key',
        'transcript.page',
        'transcript.watch',
      ],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: AgentScreen(state: state, agentRef: prior.a),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('터미널에서 답하기'), findsOneWidget);
    wire.emit(questionMessage(agent: prior.b));
    await tester.pumpAndSettle();
    expect(find.text('터미널에서 답하기'), findsNothing);
    wire.emit({'type': 'terminal.questions', 'questions': []});
    await tester.pumpAndSettle();
    expect(state.terminalQuestions, isEmpty);
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
    final older = QuestionWire();
    final oldSession = ActiveRemoteSession.attach(
      capabilities: const ['watch'],
      connection: older,
      pingInterval: const Duration(days: 1),
    );
    final oldState = RemoteState(oldSession);
    await oldState.initialize();
    older.emit(questionMessage());
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: AgentListScreen(
          state: oldState,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('터미널에서 답하기'), findsNothing);
    expect(older.watches, 0);
    await tester.pumpWidget(const SizedBox());
    oldState.dispose();
    await oldSession.disconnect();
  });
}
