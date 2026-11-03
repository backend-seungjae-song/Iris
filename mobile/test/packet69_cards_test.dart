import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/response_notifications.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';

import 'packet65_notifications_test.dart' as prior;
import 'packet66_prompts_test.dart' as prompts;

void main() {
  testWidgets('69 사람 차례의 모든 종류에 누를 수 있는 홈 카드', (tester) async {
    const qbody = QuestionRequestBody([
      RequestQuestion(
        question: '계속?',
        header: '확인',
        multiSelect: false,
        options: [RequestOption(label: '예', description: '')],
      ),
    ]);
    final parsed = (parseServerMessage(
      jsonEncode(prompts.message()),
    ) as TerminalQuestionsMessage).questions.single;
    final fallback = prompts.message();
    (fallback['questions'] as List).single['body'] = {
      'questions': [],
      'screen': null,
    };
    final unknown = (parseServerMessage(
      jsonEncode(fallback),
    ) as TerminalQuestionsMessage).questions.single;
    final bodies = <String, RemoteRequestBody>{
      'claude-permission': const PermissionRequestBody(
        tool: 'Bash',
        description: '',
        input: 'pwd',
      ),
      'claude-question': qbody,
      'browser-user': const BrowserUserRequestBody(
        title: '확인',
        text: '',
        choices: ['다 했음', '못 하겠음'],
      ),
    };
    for (final kind in [
      ...bodies.keys,
      'saved',
      'parsed',
      'fallback',
      'blocked',
      'question',
    ]) {
      final owner = prior.agent(
        parsed.agent,
        status: kind == 'blocked' ? 'blocked' : 'idle',
        question: kind == 'question',
      );
      final requests = <RemoteRequest>[
        if (bodies.containsKey(kind))
          RemoteRequest(
            ref: 'request',
            agent: owner.ref,
            kind: kind,
            createdAt: 1,
            expiresAt: 2,
            body: bodies[kind]!,
          ),
      ];
      final terminal = <RemoteRequest>[
        if (kind == 'saved')
          RemoteRequest(
            ref: 'saved',
            agent: owner.ref,
            kind: 'claude-question',
            createdAt: 1,
            expiresAt: 2,
            body: qbody,
          ),
        if (kind == 'parsed') parsed,
        if (kind == 'fallback') unknown,
      ];
      expect(
        responseItems(
          requests: requests,
          terminalQuestions: terminal,
          agents: [owner],
        ).length,
        1,
        reason: kind,
      );
      var opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: irisTheme(Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: AgentHomeView(
            key: ValueKey(kind),
            agents: [owner],
            requests: requests,
            terminalQuestions: terminal,
            connectionName: 'Mac',
            // 질문형 끝맺음 카드는 터미널이 아니라 대화창으로 이동
            onOpenAgent: (_) {
              if (kind == 'question') opened++;
            },
            onOpenRequest: (_, _) async {
              opened++;
            },
            onOpenTerminalQuestion: (_) => opened++,
            onOpenWaitingTerminal: (_) => opened++,
            onAnswerPermission: (_, _) async =>
                const RequestAnswerResult(rid: 'x', result: 'delivered'),
            onAnswerQuestion: (_, _, _) async =>
                const RequestAnswerResult(rid: 'x', result: 'delivered'),
            onAnswerHuman: (_, _) async =>
                const RequestAnswerResult(rid: 'x', result: 'delivered'),
            onSettings: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      final action = kind == 'claude-question'
          ? find.byWidgetPredicate(
              (widget) => '${widget.key}'.contains('home-answer-'),
            )
          : find.text(switch (kind) {
              'claude-permission' => '명령 실행 승인',
              'browser-user' => '다 했음',
              'question' => '대화창으로 이동',
              _ => '터미널에서 답하기',
            });
      expect(action, findsOneWidget, reason: kind);
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      if (kind != 'browser-user') expect(opened, 1, reason: kind);
      expect(tester.takeException(), isNull, reason: kind);
    }
  });
}
