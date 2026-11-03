import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/chat_tools.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/agent_screen.dart';

import 'design_fixture.dart';

void main() {
  group('도구 줄 묶기', () {
    test('호출과 결과를 한 줄로 합치고 경로·명령을 뽑는다', () {
      final rows = buildToolRows(const [
        TranscriptItem(
          role: 'tool',
          tool: 'Read',
          text: '{"file_path":"/a/b/web/js/split.js"}',
        ),
        TranscriptItem(role: 'tool', tool: 'Read', text: 'line 1\nline 2'),
        TranscriptItem(
          role: 'tool',
          tool: 'Bash',
          text: '{"command":"pnpm test split","description":"run"}',
        ),
      ]);
      expect(rows, hasLength(2));
      expect(rows[0].verb, '읽기');
      expect(rows[0].target, '/a/b/web/js/split.js');
      expect(rows[0].output, 'line 1\nline 2');
      expect(rows[1].verb, '실행');
      expect(rows[1].target, 'pnpm test split');
      expect(rows[1].pending, isTrue);
    });

    test('JSON 호출 뒤 JSON 결과는 숨기지 않고 원문 전체를 가진 줄로 남긴다', () {
      final rows = buildToolRows(const [
        TranscriptItem(role: 'tool', tool: 'Cfg', text: '{"file_path":"/a"}'),
        TranscriptItem(role: 'tool', tool: 'Cfg', text: '{"enabled":true}'),
      ]);
      expect(rows.any((r) => r.output == '{"enabled":true}'), isTrue);
    });

    test('같은 도구 병렬 호출은 결과를 짝짓지 않고 각각 표시한다', () {
      final rows = buildToolRows(const [
        TranscriptItem(role: 'tool', tool: 'Read', text: '{"file_path":"/a"}'),
        TranscriptItem(role: 'tool', tool: 'Read', text: '{"file_path":"/b"}'),
        TranscriptItem(role: 'tool', tool: 'Read', text: 'B 내용'),
        TranscriptItem(role: 'tool', tool: 'Read', text: 'A 내용'),
      ]);
      final a = rows.firstWhere((r) => r.target == '/a');
      final b = rows.firstWhere((r) => r.target == '/b');
      expect(a.output, isNull);
      expect(b.output, isNull);
      expect(rows.map((r) => r.output), containsAll(['B 내용', 'A 내용']));
    });

    test('수정 입력은 변경 줄과 개수를 만들고 잘린 입력은 경로만 읽는다', () {
      final rows = buildToolRows(const [
        TranscriptItem(
          role: 'tool',
          tool: 'Edit',
          text: '{"file_path":"x.js","old_string":"a\\nb","new_string":"c\\nd\\ne"}',
        ),
        TranscriptItem(
          role: 'tool',
          tool: 'Edit',
          text: '{"file_path":"y.js","old_string":"긴 문자열…',
        ),
      ]);
      expect(rows[0].verb, '수정');
      expect(rows[0].removed, 2);
      expect(rows[0].added, 3);
      expect(rows[0].diff!.first.added, isFalse);
      expect(rows[1].target, 'y.js');
      expect(rows[1].diff, isNull);
    });
  });

  group('표시', () {
    testWidgets('표 안의 +N 은 초록, −N 은 분홍으로 칠한다', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: designTestTheme(Brightness.dark),
          home: const Scaffold(
            body: IrisMarkdown(
              '| 파일 | 변경 |\n|---|---|\n| a.js | +6 −3 |\n\n본문 +6',
            ),
          ),
        ),
      );
      Color? colorOf(String text) {
        final span = tester
            .widgetList<RichText>(find.byType(RichText))
            .map((w) => w.text.toPlainText())
            .where((t) => t == text);
        expect(span, isNotEmpty, reason: text);
        final widget = tester.widget<Text>(find.text(text));
        return widget.style?.color;
      }

      expect(colorOf('+6'), IrisColors.dark.okText);
      expect(colorOf('−3'), IrisColors.dark.dangerText);
    });

    testWidgets('대화 머리: 브라우저 버튼·터미널 탭·작성자 줄', (tester) async {
      var browser = 0;
      var terminal = 0;
      final agent = designAgent(
        ref: permissionAgentRef,
        name: '기록 확인',
        kind: 'claude',
        status: 'working',
        space: 'iris',
        minutes: 0,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: designTestTheme(Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: AgentSessionView(
            agent: agent,
            spaceAgents: [agent],
            transcript: const [
              TranscriptItem(role: 'user', text: '고쳐 줘'),
              TranscriptItem(role: 'assistant', text: '확인합니다'),
              TranscriptItem(role: 'assistant', text: '고쳤습니다'),
            ],
            onBack: () {},
            onSelectAgent: (_) {},
            onSend: (_) async => true,
            onBrowser: () => browser++,
            onTerminal: () => terminal++,
            canMessage: true,
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Claude'), findsOneWidget);
      expect(find.textContaining('작업 중 · Claude · iris'), findsOneWidget);
      await tester.tap(find.byKey(const Key('session-browser')));
      await tester.tap(find.byKey(const Key('session-terminal')));
      expect(browser, 1);
      expect(terminal, 1);
    });

    testWidgets('질문 대기 카드는 질문이라고 부르고 터미널로 보낸다', (tester) async {
      var terminal = 0;
      final agent = designAgent(
        ref: permissionAgentRef,
        name: '기록 확인',
        kind: 'claude',
        status: 'blocked',
        space: 'iris',
        minutes: 0,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: designTestTheme(Brightness.dark),
          home: AgentSessionView(
            agent: agent,
            spaceAgents: [agent],
            transcript: const [],
            terminalFallback: true,
            onBack: () {},
            onSelectAgent: (_) {},
            onSend: (_) async => true,
            onTerminal: () => terminal++,
            canMessage: true,
          ),
        ),
      );
      await tester.pump();
      expect(find.text('질문'), findsWidgets);
      expect(find.textContaining('답할 것'), findsNothing);
      await tester.tap(find.text('터미널에서 답하기'));
      expect(terminal, 1);
    });
  });
}
