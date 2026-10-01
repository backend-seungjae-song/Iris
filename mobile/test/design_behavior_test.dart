import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'design_fixture.dart';

const _screenSize = Size(394, 854);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadDesignReferenceFont);

  testWidgets('허용 성공 후 요청 줄이 320ms 동안 접힌다', (tester) async {
    await _pump(tester, designHome(extended: false));
    final hierarchy = find.byKey(const Key('home-space-$irisAgentSpaceRef'));
    final before = tester.getTopLeft(hierarchy).dy;

    await tester.tap(find.byKey(const Key('home-allow')));
    await tester.pump();
    final started = tester.getTopLeft(hierarchy).dy;
    await tester.pump(const Duration(milliseconds: 160));
    final middle = tester.getTopLeft(hierarchy).dy;
    await tester.pump(const Duration(milliseconds: 160));
    await tester.pumpAndSettle();
    final after = tester.getTopLeft(hierarchy).dy;

    expect(started, before);
    expect(middle, lessThan(before));
    expect(middle, greaterThan(after));
    expect(find.byKey(Key('request-$permissionRequestRef')), findsNothing);
    expect(find.text('1'), findsWidgets);
  });

  testWidgets('선택 질문은 다중 선택·이전·직접 입력을 처리한다', (tester) async {
    List<QuestionResponse>? sent;
    await _pump(
      tester,
      designQuestionScene(
        onAnswer: (responses) async {
          sent = responses;
          return const RequestAnswerResult(rid: 'fixture', result: 'busy');
        },
      ),
    );

    await tester.tap(find.byKey(const Key('question-option-first')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('question-next')));
    await tester.pumpAndSettle();

    expect(_questionText(tester), '잠금 파일을 새로 만들까요?');
    expect(find.text('이전'), findsOneWidget);

    await tester.tap(find.text('직접 입력'));
    await tester.pumpAndSettle();
    final directInput = find.byKey(const Key('question-direct-input'));
    expect(directInput, findsOneWidget);
    await tester.enterText(directInput, '기존 파일을 유지해 줘');
    await tester.pump();
    expect(find.text('보내기'), findsOneWidget);

    await tester.tap(find.text('이전'));
    await tester.pumpAndSettle();
    expect(_questionText(tester), '어떤 패키지를 올릴까요?');

    await tester.tap(find.byKey(const Key('question-next')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('question-next')));
    await tester.pumpAndSettle();
    expect(sent, hasLength(2));
    expect(sent!.first, isA<QuestionLabels>());
    expect(sent![1], isA<QuestionText>());
  });

  testWidgets('동작 줄이기 설정에서도 시트가 320ms 동안 이동한다', (tester) async {
    await _pump(
      tester,
      Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showIrisSheet<void>(
              context: context,
              builder: (_) =>
                  const SizedBox(key: Key('motion-sheet-content'), height: 100),
            ),
            child: const Text('열기'),
          ),
        ),
      ),
      disableAnimations: true,
    );

    await tester.tap(find.text('열기'));
    await tester.pump();
    final content = find.byKey(const Key('motion-sheet-content'));
    final start = tester.getTopLeft(content).dy;
    await tester.pump(const Duration(milliseconds: 160));
    final middle = tester.getTopLeft(content).dy;
    await tester.pump(const Duration(milliseconds: 160));
    final end = tester.getTopLeft(content).dy;

    expect(middle, lessThan(start));
    expect(middle, greaterThan(end));
    Navigator.of(tester.element(content)).pop();
    await tester.pumpAndSettle();
  });

  testWidgets('터미널 카드의 전체 출력을 펼치고 접는다', (tester) async {
    await _pump(tester, designSession());
    await tester.tap(find.text('출력 전체 38줄'));
    await tester.pumpAndSettle();
    expect(find.textContaining('line 38'), findsOneWidget);
    expect(find.text('출력 접기'), findsOneWidget);

    await tester.ensureVisible(find.text('출력 접기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('출력 접기'));
    await tester.pumpAndSettle();
    expect(find.text('출력 전체 38줄'), findsOneWidget);
  });

  testWidgets('대화를 올리면 맨 아래 버튼이 나타나고 누르면 사라진다', (tester) async {
    late StateSetter update;
    var messageCount = 36;
    await _pump(
      tester,
      StatefulBuilder(
        builder: (context, setState) {
          update = setState;
          return _longSession(messageCount);
        },
      ),
    );
    await tester.pumpAndSettle();

    final chat = find.byKey(const Key('session-chat'));
    final position = tester.widget<ListView>(chat).controller!.position;
    expect(position.pixels, position.maxScrollExtent);
    expect(find.byKey(const Key('session-scroll-bottom')), findsNothing);

    await tester.drag(chat, const Offset(0, 420));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('맨 아래로'), findsOneWidget);
    final chatRect = tester.getRect(chat);
    final buttonRect = tester.getRect(
      find.byKey(const Key('session-scroll-bottom')),
    );
    expect(buttonRect.top, closeTo(chatRect.top + 12, 0.1));
    expect(buttonRect.right, closeTo(chatRect.right - 16, 0.1));

    update(() => messageCount++);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-scroll-bottom')), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-scroll-bottom')));
    await tester.pumpAndSettle();
    expect(position.pixels, position.maxScrollExtent);
    expect(find.byKey(const Key('session-scroll-bottom')), findsNothing);
  });

  testWidgets('대화 기록을 못 불러오면 이유와 다시 시도를 표시한다', (tester) async {
    var retries = 0;
    final agent = designAgent(
      ref: permissionAgentRef,
      name: '기록 확인',
      kind: 'codex',
      status: 'idle',
      space: 'iris',
      minutes: 0,
    );
    await _pump(
      tester,
      AgentSessionView(
        agent: agent,
        spaceAgents: [agent],
        transcript: const [],
        error: 'Mac이 대화 기록을 보내지 못했습니다.',
        onBack: () {},
        onSelectAgent: (_) {},
        onSend: (_) async => true,
        onRetry: () => retries++,
        canMessage: true,
      ),
    );

    expect(find.text('Mac이 대화 기록을 보내지 못했습니다.'), findsOneWidget);
    expect(find.text('다시 시도'), findsOneWidget);
    await tester.tap(find.byKey(const Key('transcript-retry')));
    expect(retries, 1);
  });

  testWidgets('입력칸 붙여넣기 칩은 여러 개를 열고 지우며 글 없이도 보낸다', (tester) async {
    late StateSetter update;
    var drafts = <ComposerDraft>[
      ComposerDraft(
        ref: '1' * 32,
        kind: 'element',
        summary: '저장 버튼',
        content: '[브라우저 요소]\n선택자: #save\n글자: 저장 버튼',
      ),
      ComposerDraft(
        ref: '2' * 32,
        kind: 'record',
        summary: '5단계',
        content: '[폰 브라우저 조작 기록]\n1. 저장 버튼 클릭',
      ),
    ];
    String? sent;
    final agent = designAgent(
      ref: permissionAgentRef,
      name: '기록 확인',
      kind: 'codex',
      status: 'idle',
      space: 'iris',
      minutes: 0,
    );
    await _pump(
      tester,
      StatefulBuilder(
        builder: (context, setState) {
          update = setState;
          return AgentSessionView(
            agent: agent,
            spaceAgents: [agent],
            transcript: const [],
            drafts: drafts,
            onBack: () {},
            onSelectAgent: (_) {},
            onSend: (text) async {
              sent = text;
              return true;
            },
            onRemoveDraft: (ref) => update(
              () => drafts = drafts
                  .where((draft) => draft.ref != ref)
                  .toList(growable: false),
            ),
            canMessage: true,
          );
        },
      ),
    );

    expect(find.byKey(const Key('composer-pasted-contexts')), findsOneWidget);
    expect(find.textContaining('브라우저 요소 · 저장 버튼'), findsOneWidget);
    expect(find.textContaining('조작 기록 · 5단계'), findsOneWidget);
    final first = find.byKey(Key('composer-draft-${'1' * 32}'));
    await tester.tap(
      find.descendant(
        of: first,
        matching: find.byKey(const Key('pasted-context-remove')),
      ),
    );
    await tester.pump();
    expect(find.textContaining('브라우저 요소 · 저장 버튼'), findsNothing);

    await tester.tap(find.textContaining('조작 기록 · 5단계'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pasted-context-sheet')), findsOneWidget);
    expect(find.textContaining('1. 저장 버튼 클릭'), findsOneWidget);
    Navigator.of(tester.element(find.byKey(const Key('pasted-context-sheet'))))
        .pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-action')));
    await tester.pump();
    expect(sent, '');
  });

  testWidgets('보낸 대화의 브라우저 블록은 칩으로 접고 모달에서 원문을 보인다', (tester) async {
    final agent = designAgent(
      ref: permissionAgentRef,
      name: '기록 확인',
      kind: 'codex',
      status: 'idle',
      space: 'iris',
      minutes: 0,
    );
    await _pump(
      tester,
      AgentSessionView(
        agent: agent,
        spaceAgents: [agent],
        transcript: const [
          TranscriptItem(
            role: 'user',
            text: '이 부분을 고쳐 줘\n\n[브라우저 요소]\n선택자: #save\n글자: 저장 버튼',
          ),
        ],
        onBack: () {},
        onSelectAgent: (_) {},
        onSend: (_) async => true,
        canMessage: true,
      ),
    );

    expect(find.text('이 부분을 고쳐 줘'), findsOneWidget);
    expect(find.textContaining('브라우저 요소 · 저장 버튼'), findsOneWidget);
    expect(find.textContaining('선택자: #save'), findsNothing);
    await tester.tap(find.textContaining('브라우저 요소 · 저장 버튼'));
    await tester.pumpAndSettle();
    expect(find.textContaining('선택자: #save'), findsOneWidget);
  });

  testWidgets('기본 브라우저 누르기는 가운데 커서 좌표 클릭을 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );

    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getTopLeft(find.byKey(const Key('browser-frame'))) +
          const Offset(30, 80),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final pointers = remote!.connection.sent
        .where(
          (message) =>
              message['type'] == 'browser.mouse' &&
              message['action'] == 'click',
        )
        .toList();
    expect(
      pointers,
      isNotEmpty,
      reason: remote!.connection.sent
          .map((message) => message['type'])
          .join(', '),
    );
    final pointer = pointers.last;
    expect(pointer['width'], 394);
    expect(pointer['height'], 648);
    expect(pointer['x'] as double, moreOrLessEquals(197, epsilon: 0.5));
    expect(pointer['y'] as double, moreOrLessEquals(324, epsilon: 0.5));
    expect(find.bySemanticsLabel('마우스 커서'), findsOneWidget);
  });

  testWidgets('대화 키보드 높이만큼 프레임을 줄여도 가운데 좌표를 유지한다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
      viewInsetBottom: 300,
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byKey(const Key('browser-composer-input')));
    await tester.pump();

    final composer = tester.getRect(find.byKey(const Key('browser-composer')));
    expect(composer.bottom, lessThanOrEqualTo(_screenSize.height - 300));
    final frame = find.byKey(const Key('browser-frame'));
    await tester.tapAt(tester.getCenter(frame));
    await tester.pump(const Duration(milliseconds: 400));
    final pointer = remote!.connection.sent.lastWhere(
      (message) =>
          message['type'] == 'browser.mouse' && message['action'] == 'click',
    );
    expect(pointer['x'] as double, moreOrLessEquals(197, epsilon: 0.5));
    expect(pointer['y'] as double, moreOrLessEquals(324, epsilon: 0.5));
  });

  testWidgets('한 손가락 이동은 커서를 옮기고 이동 요청을 묶는다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final frame = find.byKey(const Key('browser-frame'));
    final cursorBefore = tester.getTopLeft(
      find.byKey(const Key('browser-cursor')),
    );
    final gesture = await tester.startGesture(tester.getCenter(frame));
    for (var index = 0; index < 8; index++) {
      await gesture.moveBy(const Offset(5, 2));
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 500));

    final moves = remote!.connection.sent
        .where(
          (message) =>
              message['type'] == 'browser.mouse' && message['action'] == 'move',
        )
        .toList();
    expect(moves, isNotEmpty);
    expect(moves.length, lessThanOrEqualTo(2));
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-cursor'))).dx,
      greaterThan(cursorBefore.dx),
    );
  });

  testWidgets('요소 선택은 커서를 유지하고 호버 뒤 누른 요소를 연속 초안에 넣는다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    expect(find.byKey(const Key('browser-cursor')), findsOneWidget);

    final frame = find.byKey(const Key('browser-frame'));
    final gesture = await tester.startGesture(tester.getCenter(frame));
    await gesture.moveBy(const Offset(50, 20));
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 500));
    expect(
      remote!.connection.sent.where(
        (message) => message['type'] == 'browser.element.hover',
      ),
      isNotEmpty,
    );
    expect(find.byKey(const Key('browser-element-highlight')), findsOneWidget);

    await tester.tapAt(tester.getCenter(frame));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();
    expect(
      remote!.connection.sent.where(
        (message) => message['type'] == 'browser.element.pick',
      ),
      isNotEmpty,
    );
    expect(remote!.state.composerDraftsFor(humanAgentRef), hasLength(1));
    expect(find.text('요소 선택'), findsOneWidget);
    expect(find.byKey(const Key('browser-cursor')), findsOneWidget);
  });

  testWidgets('요소 선택 칩을 브라우저 입력칸에서 보내고 같은 화면에 남는다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('browser-composer')), findsOneWidget);
    expect(find.textContaining('브라우저 요소 · 39,000원 결제'), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('browser-composer-input')),
      '이 버튼을 고쳐 줘',
    );
    await tester.tap(find.byKey(const Key('browser-composer-action')));
    await tester.pump(const Duration(milliseconds: 600));

    final sent = remote!.connection.sent.lastWhere(
      (message) => message['type'] == 'agent.message',
    );
    expect(sent['agent'], humanAgentRef);
    expect(sent['text'], '이 버튼을 고쳐 줘');
    expect(sent['drafts'], ['6' * 32]);
    expect(find.byType(BrowserScreen), findsOneWidget);
    expect(remote!.state.composerDraftsFor(humanAgentRef), isEmpty);
    expect(remote!.state.composerTextFor(humanAgentRef), isEmpty);
    expect(find.byKey(const Key('browser-message-result')), findsOneWidget);
    expect(find.text('전달함'), findsOneWidget);
  });

  testWidgets('브라우저 대화 전송 실패를 표시하고 입력 글을 남긴다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.agentMessageResult = 'failed';
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.enterText(
      find.byKey(const Key('browser-composer-input')),
      '다시 보낼 글',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('browser-composer-action')));
    for (
      var attempt = 0;
      attempt < 20 &&
          find.byKey(const Key('browser-message-result')).evaluate().isEmpty;
      attempt++
    ) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(
      remote!.connection.sent.where(
        (message) => message['type'] == 'agent.message',
      ),
      isNotEmpty,
      reason: remote!.connection.sent.toString(),
    );
    expect(find.byType(BrowserScreen), findsOneWidget);
    expect(find.byKey(const Key('browser-message-result')), findsOneWidget);
    expect(find.text('실패'), findsOneWidget);
    expect(remote!.state.composerTextFor(humanAgentRef), '다시 보낼 글');
  });

  testWidgets('요소 선택 버튼과 다른 도구는 강조를 바로 없앤다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(builder: (_, value) => designBrowserScene(value)),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await _moveBrowserCursor(tester);
    expect(find.byKey(const Key('browser-element-highlight')), findsOneWidget);

    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);

    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await _moveBrowserCursor(tester);
    await tester.tap(find.text('조작 기록'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);
  });

  testWidgets('탭 전환과 화면 나가기는 요소 강조를 남기지 않는다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(builder: (_, value) => designBrowserScene(value)),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await _moveBrowserCursor(tester);
    expect(find.byKey(const Key('browser-element-highlight')), findsOneWidget);

    await tester.drag(
      find.byKey(const Key('session-tabs')),
      const Offset(-300, 0),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('session-browser-tab-$browserTabTwoRef')),
    );
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);

    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await _moveBrowserCursor(tester);
    expect(find.byKey(const Key('browser-element-highlight')), findsOneWidget);
    await _pump(tester, const SizedBox.shrink());
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('선택을 끈 뒤 늦게 온 hover 응답은 무시한다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final gate = Completer<void>();
    remote!.connection.browserHoverGate = gate;
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    final frame = find.byKey(const Key('browser-frame'));
    final gesture = await tester.startGesture(tester.getCenter(frame));
    await gesture.moveBy(const Offset(40, 12));
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    gate.complete();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);
  });

  testWidgets('재연결을 시작하면 강조를 지우고 연결 상태 한 줄만 표시한다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('요소 선택'));
    await tester.pump();
    await _moveBrowserCursor(tester);
    expect(find.byKey(const Key('browser-element-highlight')), findsOneWidget);

    final gate = Completer<void>();
    remote!.resumeGate = gate;
    remote!.connection.fail();
    await tester.pump(const Duration(milliseconds: 20));
    expect(find.byKey(const Key('browser-element-highlight')), findsNothing);
    expect(find.byKey(const Key('browser-reconnecting')), findsOneWidget);

    gate.complete();
    for (
      var attempt = 0;
      attempt < 20 &&
          remote!.session.connectionStatus ==
              RemoteConnectionStatus.reconnecting;
      attempt++
    ) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(remote!.resumedConnection, isNotNull);
    expect(remote!.session.connectionStatus, RemoteConnectionStatus.connected);
    expect(find.byKey(const Key('browser-reconnecting')), findsNothing);
  });

  testWidgets('입력칸을 누르면 조합 중 한글을 보류하고 확정 글자를 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserFocusEditable = true;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump();
    final input = find.byKey(const Key('browser-page-input'));
    expect(input, findsOneWidget);
    expect(tester.testTextInput.isVisible, true);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '\u200bㅎ',
        composing: TextRange(start: 1, end: 2),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    expect(
      remote!.connection.sent.where(
        (message) => message['type'] == 'browser.type',
      ),
      isEmpty,
    );
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '\u200b한',
        selection: TextSelection.collapsed(offset: 2),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    expect(
      remote!.connection.sent.lastWhere(
        (message) => message['type'] == 'browser.type',
      )['text'],
      '한',
    );
  });

  testWidgets('대화 입력칸을 누르면 페이지 입력을 닫고 글자를 에이전트 초안에 둔다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserFocusEditable = true;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    expect(
      find.byKey(const Key('browser-page-input-controls')),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const Key('browser-composer-input')));
    await tester.pump();
    expect(find.byKey(const Key('browser-page-input-controls')), findsNothing);
    await tester.enterText(
      find.byKey(const Key('browser-composer-input')),
      '대화 초안',
    );
    await tester.pump();

    expect(remote!.state.composerTextFor(humanAgentRef), '대화 초안');
    expect(
      remote!.connection.sent.where(
        (message) =>
            message['type'] == 'browser.type' && message['text'] == '대화 초안',
      ),
      isEmpty,
    );
  });

  testWidgets('페이지 입력 도구를 바로 닫아도 묶어 둔 확정 글자를 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserFocusEditable = true;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    expect(find.byKey(const Key('browser-page-input')), findsOneWidget);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '\u200b끝',
        selection: TextSelection.collapsed(offset: 2),
      ),
    );
    final inputTools = find.descendant(
      of: find.byKey(const Key('browser-page-input-controls')),
      matching: find.byType(ListView),
    );
    await tester.drag(inputTools, const Offset(-700, 0));
    await tester.pump();
    await tester.tap(find.text('닫기'));
    await tester.pump(const Duration(milliseconds: 1200));

    expect(find.byKey(const Key('browser-page-input-controls')), findsNothing);
    expect(
      remote!.connection.sent.where(
        (message) =>
            message['type'] == 'browser.type' && message['text'] == '끝',
      ),
      hasLength(1),
    );
  });

  testWidgets('페이지 입력 도구는 키와 폰 클립보드 글자를 페이지로 보낸다', (tester) async {
    DesignRemote? remote;
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserFocusEditable = true;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump();
    expect(
      find.byKey(const Key('browser-page-input')),
      findsOneWidget,
      reason: remote!.connection.sent.toString(),
    );

    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async => call.method == 'Clipboard.getData'
          ? <String, Object>{'text': '붙여넣기'}
          : null,
    );
    final inputTools = find.descendant(
      of: find.byKey(const Key('browser-page-input-controls')),
      matching: find.byType(ListView),
    );
    await tester.drag(inputTools, const Offset(-600, 0));
    await tester.pump();
    await tester.tap(find.byKey(const Key('browser-page-paste')));
    await tester.drag(inputTools, const Offset(600, 0));
    await tester.pump();
    await tester.tap(find.byKey(const Key('browser-page-backspace')));
    await tester.tap(find.byKey(const Key('browser-page-enter')));
    await tester.pump(const Duration(milliseconds: 2200));
    final keys = remote!.connection.sent
        .where((message) => message['type'] == 'browser.key')
        .map((message) => message['key'])
        .toList();
    expect(keys, containsAllInOrder(['Backspace', 'Enter']));
    expect(
      remote!.connection.sent.where(
        (message) =>
            message['type'] == 'browser.type' && message['text'] == '붙여넣기',
      ),
      hasLength(1),
    );
  });

  testWidgets('페이지 prompt는 폰에서 글을 받아 수락 응답으로 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserDialog = const BrowserDialog(
            kind: 'prompt',
            message: '이름을 입력하세요',
          );
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump();
    expect(find.byKey(const Key('browser-page-dialog')), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('browser-dialog-input')),
      '홍길동',
    );
    await tester.tap(find.widgetWithText(TextButton, '확인'));
    await tester.pump(const Duration(milliseconds: 1500));
    expect(
      remote!.connection.sent.where(
        (message) =>
            message['type'] == 'browser.dialog' &&
            message['action'] == 'accept' &&
            message['text'] == '홍길동',
      ),
      hasLength(1),
    );
  });

  testWidgets('클릭 뒤 늦게 열린 대화상자와 새 탭 목록을 다시 확인한다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          value.connection.browserDialog = const BrowserDialog(
            kind: 'alert',
            message: '늦은 알림',
          );
          value.connection.browserDialogGetDelay = 1;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final tabsBefore = remote!.connection.sent
        .where((message) => message['type'] == 'browser.tabs')
        .length;

    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump(const Duration(milliseconds: 2200));

    expect(find.byKey(const Key('browser-page-dialog')), findsOneWidget);
    expect(
      remote!.connection.sent
          .where((message) => message['type'] == 'browser.tabs')
          .length,
      greaterThan(tabsBefore),
    );
  });

  testWidgets('주소 입력은 바깥을 누르면 초점만 풀고 편집한 주소를 남긴다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(builder: (_, value) => designBrowserScene(value)),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final address = find.descendant(
      of: find.byKey(const Key('browser-address')),
      matching: find.byType(TextField),
    );
    await tester.tap(address);
    await tester.enterText(address, 'https://example.test/draft');
    expect(tester.testTextInput.isVisible, true);
    await tester.tapAt(
      tester.getCenter(find.byKey(const Key('browser-frame'))),
    );
    await tester.pump();
    expect(tester.testTextInput.isVisible, false);
    expect(
      tester.widget<TextField>(address).controller!.text,
      'https://example.test/draft',
    );
  });

  test('확대 화면 이동값은 가장자리 커서를 따라가고 안전 영역 안에서는 그대로다', () {
    final followed = browserCursorFollowPan(
      size: const Size(394, 540),
      frameSize: const Size(394, 648),
      zoom: 2,
      pan: Offset.zero,
      cursor: const Offset(0.95, 0.5),
    );
    expect(followed.dx, lessThan(0));
    expect(
      browserCursorFollowPan(
        size: const Size(394, 540),
        frameSize: const Size(394, 648),
        zoom: 2,
        pan: followed,
        cursor: const Offset(0.5, 0.5),
      ),
      followed,
    );
  });

  testWidgets('두 번 누르기와 길게 누른 채 이동은 좌표 마우스 동작을 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));

    await tester.tapAt(center);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tapAt(center);
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      remote!.connection.sent.where(
        (message) =>
            message['type'] == 'browser.mouse' && message['action'] == 'double',
      ),
      hasLength(1),
    );

    remote!.connection.sent.clear();
    final drag = await tester.startGesture(center);
    await tester.pump(const Duration(milliseconds: 400));
    await drag.moveBy(const Offset(40, 20));
    await tester.pump(const Duration(milliseconds: 200));
    await drag.up();
    await tester.pump(const Duration(milliseconds: 1800));
    final actions = remote!.connection.sent
        .where((message) => message['type'] == 'browser.mouse')
        .map((message) => message['action'])
        .toList();
    expect(actions, containsAllInOrder(['down', 'drag', 'up']));
  });

  testWidgets('두 손가락 이동은 커서 위치의 휠 요청을 한 번 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    final first = await tester.startGesture(
      center - const Offset(40, 0),
      pointer: 1,
    );
    final second = await tester.startGesture(
      center + const Offset(40, 0),
      pointer: 2,
    );
    await first.moveBy(const Offset(0, -60));
    await second.moveBy(const Offset(0, -60));
    await first.up();
    await second.up();
    await tester.pump(const Duration(milliseconds: 400));

    final wheels = remote!.connection.sent
        .where(
          (message) =>
              message['type'] == 'browser.mouse' &&
              message['action'] == 'wheel',
        )
        .toList();
    expect(wheels, hasLength(1));
    expect(wheels.single['dy'] as int, greaterThan(0));
    expect(wheels.single['x'] as double, moreOrLessEquals(197, epsilon: 0.5));
  });

  testWidgets('핀치 확대는 큰 프레임을 요청하고 커서 좌표를 유지한다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    final first = await tester.startGesture(
      center - const Offset(30, 0),
      pointer: 3,
    );
    final second = await tester.startGesture(
      center + const Offset(30, 0),
      pointer: 4,
    );
    await first.moveBy(const Offset(-45, 0));
    await second.moveBy(const Offset(45, 0));
    await tester.pump();
    await first.up();
    await second.up();
    await tester.pump(const Duration(milliseconds: 500));

    final watches = remote!.connection.sent
        .where((message) => message['type'] == 'browser.frame.watch')
        .toList();
    expect(watches.last['width'] as int, greaterThan(394));

    await tester.tapAt(center + const Offset(120, 100));
    await tester.pump(const Duration(milliseconds: 400));
    final click = remote!.connection.sent.lastWhere(
      (message) =>
          message['type'] == 'browser.mouse' && message['action'] == 'click',
    );
    expect(
      click['x'] as double,
      moreOrLessEquals((click['width'] as int) / 2, epsilon: 1),
    );
    expect(click['y'] as double, moreOrLessEquals(324, epsilon: 1));
  });

  testWidgets('더보기는 도구를 먼저 두고 많은 프로필을 안에서 스크롤한다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          value.connection.browserProfiles = const [
            '기본',
            '업무',
            '개인',
            '시험',
            '고객 A',
            '고객 B',
            '임시',
          ];
          return designBrowserScene(value);
        },
      ),
      screenSize: const Size(394, 540),
      safeBottom: 48,
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('더보기'));
    await tester.pumpAndSettle();

    expect(find.text('앞으로'), findsOneWidget);
    final bounds = tester.getRect(find.byKey(const Key('iris-sheet-bounds')));
    expect(bounds.top, greaterThanOrEqualTo(16));
    expect(bounds.bottom, lessThanOrEqualTo(484));
    final profiles = find.byKey(const Key('browser-profile-list'));
    expect(profiles, findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('임시'),
      120,
      scrollable: find.descendant(
        of: profiles,
        matching: find.byType(Scrollable),
      ),
    );
    expect(find.text('임시'), findsOneWidget);
  });

  testWidgets('더보기에서 직접 누르기로 바꾸면 손가락 위치를 기존 요청으로 보낸다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('더보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('직접 누르기'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('browser-cursor')), findsNothing);
    final frame = find.byKey(const Key('browser-frame'));
    final target = tester.getTopLeft(frame) + const Offset(90, 190);
    await tester.tapAt(target);
    await tester.pump(const Duration(milliseconds: 400));
    final pointer = remote!.connection.sent.lastWhere(
      (message) => message['type'] == 'browser.pointer',
    );
    expect(pointer['x'] as double, isNot(moreOrLessEquals(197, epsilon: 1)));
  });

  testWidgets('홈 브라우저 줄과 세션 지구본이 브라우저 화면을 연다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, remote) => AgentListScreen(
          state: remote.state,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final homeTab = find.byKey(const Key('browser-tab-$browserTabRef'));
    final homeScrollable = find.descendant(
      of: find.byKey(const Key('home-scroll')),
      matching: find.byType(Scrollable),
    );
    await tester.scrollUntilVisible(
      homeTab,
      500,
      scrollable: homeScrollable.first,
    );
    await tester.tap(homeTab);
    await tester.pumpAndSettle();
    expect(find.byType(BrowserScreen), findsOneWidget);

    Navigator.of(tester.element(find.byType(BrowserScreen))).pop();
    await tester.pumpAndSettle();
    final agentRow = find.byKey(const Key('agent-row-$mobileAgentRef'));
    await tester.scrollUntilVisible(
      agentRow,
      -500,
      scrollable: homeScrollable.first,
    );
    await tester.tap(agentRow);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pumpAndSettle();
    expect(find.byType(BrowserScreen), findsOneWidget);
  });

  testWidgets('브라우저에서 쓴 글은 같은 에이전트 대화 입력칸에 남는다', (tester) async {
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, remote) => AgentListScreen(
          state: remote.state,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final row = find.byKey(const Key('agent-row-$mobileAgentRef'));
    await tester.scrollUntilVisible(
      row,
      500,
      scrollable: find
          .descendant(
            of: find.byKey(const Key('home-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(row);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-browser')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('browser-composer-input')),
      '브라우저에서 이어 쓸 글',
    );
    await tester.pump();

    Navigator.of(tester.element(find.byType(BrowserScreen))).pop();
    await tester.pumpAndSettle();
    final input = tester.widget<TextField>(
      find.byKey(const Key('session-input')),
    );
    expect(input.controller!.text, '브라우저에서 이어 쓸 글');
  });

  testWidgets('브라우저 탭 칩이 고른 Mac 탭으로 구독을 바꾼다', (tester) async {
    DesignRemote? remote;
    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, value) {
          remote = value;
          return designBrowserScene(value);
        },
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.drag(
      find.byKey(const Key('session-tabs')),
      const Offset(-300, 0),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('session-browser-tab-$browserTabTwoRef')),
    );
    await tester.pump(const Duration(milliseconds: 400));
    final watches = remote!.connection.sent
        .where((message) => message['type'] == 'browser.frame.watch')
        .toList();
    expect(watches.last['tab'], browserTabTwoRef);
  });

  testWidgets('Iris 순서는 스페이스와 부모를 유지하고 최근 활동순은 평평하다', (tester) async {
    await _pump(tester, designHome(withRequests: false));
    final irisSpace = find.byKey(const Key('home-space-$irisAgentSpaceRef'));
    final parent = tester.getTopLeft(
      find.byKey(const Key('agent-tile-$mobileAgentRef')),
    );
    final child = tester.getTopLeft(
      find.byKey(const Key('agent-tile-$restingAgentRef')),
    );
    expect(child.dx, greaterThan(parent.dx));

    await tester.tap(irisSpace);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agent-tile-$mobileAgentRef')), findsNothing);
    await tester.tap(irisSpace);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('home-sort')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('home-sort-recent')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('home-recent-header')), findsOneWidget);
    expect(irisSpace, findsNothing);
    final newest = tester.getTopLeft(
      find.byKey(const Key('agent-tile-$permissionAgentRef')),
    );
    final second = tester.getTopLeft(
      find.byKey(const Key('agent-tile-$mobileAgentRef')),
    );
    expect(newest.dy, lessThan(second.dy));
    expect(newest.dx, second.dx);
  });

  testWidgets('하단 영역 48에서 대화와 터미널 입력이 내비게이션 바 위에 있다', (tester) async {
    await _pump(tester, designSession(), safeBottom: 48);
    expect(
      tester.getBottomRight(find.byKey(const Key('session-input'))).dy,
      lessThanOrEqualTo(806),
    );

    await _pump(
      tester,
      DesignRemoteScene(builder: (_, remote) => designTerminalScene(remote)),
      safeBottom: 48,
    );
    expect(
      tester.getBottomRight(find.byKey(const Key('terminal-input'))).dy,
      lessThanOrEqualTo(806),
    );

    await _pump(
      tester,
      DesignRemoteScene(
        builder: (_, remote) => designBrowserScene(remote, human: true),
      ),
      safeBottom: 48,
    );
    expect(tester.getBottomRight(find.text('다 했음')).dy, lessThanOrEqualTo(806));

    await _pump(tester, designPermissionScene(), safeBottom: 48);
    expect(
      tester.getBottomRight(find.byKey(const Key('permission-option-2'))).dy,
      lessThanOrEqualTo(806),
    );
  });

  testWidgets('키보드가 올라오면 대화 입력이 키보드 위에 있다', (tester) async {
    await _pump(tester, designSession(), safeBottom: 0, viewInsetBottom: 300);
    expect(
      tester.getBottomRight(find.byKey(const Key('session-input'))).dy,
      lessThanOrEqualTo(554),
    );
  });
}

AgentSessionView _longSession(int messageCount) {
  final agent = designAgent(
    ref: permissionAgentRef,
    name: '긴 대화',
    kind: 'codex',
    status: 'idle',
    space: 'iris',
    minutes: 0,
  );
  return AgentSessionView(
    agent: agent,
    spaceAgents: [agent],
    transcript: List.generate(
      messageCount,
      (index) => TranscriptItem(
        role: index.isEven ? 'user' : 'assistant',
        text: '대화 ${index + 1}: 화면 스크롤 동작을 확인하는 충분히 긴 내용입니다.',
      ),
    ),
    onBack: () {},
    onSelectAgent: (_) {},
    onSend: (_) async => true,
    canMessage: true,
  );
}

String _questionText(WidgetTester tester) => tester
    .widget<IrisMarkdown>(
      find.descendant(
        of: find.byKey(const Key('question-title')),
        matching: find.byType(IrisMarkdown),
      ),
    )
    .data;

Future<void> _moveBrowserCursor(WidgetTester tester) async {
  final frame = find.byKey(const Key('browser-frame'));
  final gesture = await tester.startGesture(tester.getCenter(frame));
  await gesture.moveBy(const Offset(44, 16));
  await gesture.up();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  bool disableAnimations = false,
  double safeBottom = 34,
  double viewInsetBottom = 0,
  Size screenSize = _screenSize,
}) async {
  tester.view.physicalSize = screenSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: designTestTheme(Brightness.dark),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: EdgeInsets.only(top: 54, bottom: safeBottom),
          viewPadding: EdgeInsets.only(top: 54, bottom: safeBottom),
          viewInsets: EdgeInsets.only(bottom: viewInsetBottom),
          textScaler: TextScaler.noScaling,
          disableAnimations: disableAnimations,
        ),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}
