import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/permission_request_screen.dart';
import 'package:iris_remote/screens/question_request_screen.dart';
import 'package:iris_remote/screens/response_host.dart';
import 'package:iris_remote/screens/terminal_question_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'design_fixture.dart';
import 'packet61_test.dart' as prior;

const _hash =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const _hash2 =
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

Map<String, Object?> _option(
  int row,
  String text, {
  bool selectable = true,
  String? role,
  bool? checked,
  String description = '',
}) => {
  'row': row,
  'text': text,
  'selectable': selectable,
  'role': ?role,
  'checked': ?checked,
  if (description.isNotEmpty) 'description': description,
};

Map<String, Object?> _terminalQuestion({
  required String question,
  required List<Map<String, Object?>> options,
  String hash = _hash,
  bool multi = false,
  String variant = 'choice',
  int? step,
  int? steps,
  String ref = prior.b,
}) => {
  'ref': ref,
  'agent': prior.a,
  'kind': 'terminal-prompt',
  'createdAt': 1,
  'expiresAt': 86400001,
  'body': {
    'questions': [
      {
        'question': question,
        'header': '질문',
        'multiSelect': multi,
        'options': [
          for (final o in options)
            {'label': o['text'], 'description': o['description'] ?? ''},
        ],
      },
    ],
    'screen': {
      'question': question,
      'title': question,
      'variant': variant,
      'step': ?step,
      'steps': ?steps,
      'hash': hash,
      'columns': 80,
      'rows': 24,
      'selectedRow': options.first['row'],
      'multiSelect': multi,
      'options': options,
    },
  },
};

Map<String, Object?> _permission(String ref, String agent, String input) => {
  'ref': ref,
  'agent': agent,
  'kind': 'claude-permission',
  'createdAt': DateTime.now().millisecondsSinceEpoch,
  'expiresAt': DateTime.now().millisecondsSinceEpoch + 600000,
  'body': {'tool': 'Bash', 'description': '설명', 'input': input},
};

Map<String, Object?> _askRequest(String ref, String agent, String text) => {
  'ref': ref,
  'agent': agent,
  'kind': 'claude-question',
  'createdAt': DateTime.now().millisecondsSinceEpoch,
  'expiresAt': DateTime.now().millisecondsSinceEpoch + 600000,
  'body': {
    'questions': [
      {
        'question': text,
        'header': '질문',
        'multiSelect': false,
        'options': [
          {'label': '가', 'description': ''},
          {'label': '나', 'description': ''},
        ],
      },
    ],
  },
};

class _Wire extends prior.Wire {
  _Wire() : super('claude');
  List<Map<String, Object?>> questions = [];
  List<Map<String, Object?>> requests = [];
  bool stale = false;

  List<Map<String, Object>> get selects =>
      sent.where((m) => m['type'] == 'terminal.select').toList();

  List<Map<String, Object>> get keys =>
      sent.where((m) => m['type'] == 'terminal.key').toList();

  void setQuestions(List<Map<String, Object?>> value) {
    questions = value;
    emit({'type': 'terminal.questions', 'questions': value});
  }

  void setRequests(List<Map<String, Object?>> value) {
    requests = value;
    emit({'type': 'requests', 'requests': value});
  }

  @override
  void sendJson(Map<String, Object> m) {
    switch (m['type']) {
      case 'session.watch':
        super.sendJson({...m, 'type': 'watch'});
        emit({'type': 'terminal.questions', 'questions': questions});
        emit({'type': 'requests', 'requests': requests});
      case 'terminal.key':
        sent.add(m);
        emit({
          'type': 'remote.action.result',
          'rid': m['rid'],
          'result': 'sent',
        });
      case 'terminal.select':
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
      case 'request.answer':
        sent.add(m);
        emit({
          'type': 'request.answer.result',
          'rid': m['rid'],
          'result': 'delivered',
        });
      default:
        super.sendJson(m);
    }
  }
}

Widget _still(BuildContext context, Widget? child) => MediaQuery(
  data: MediaQuery.of(context).copyWith(disableAnimations: true),
  child: child!,
);

// 서버가 보내는 checked 선택지를 앱 파서가 거절하므로(protocol.dart 허용 키 누락) 다중 선택은 모델을 직접 주입
class _FakeState extends RemoteState {
  _FakeState(super.session);
  List<RemoteRequest> fake = [];
  @override
  List<RemoteRequest> get terminalQuestions => fake;
  void setFake(List<RemoteRequest> value) {
    fake = value;
    notifyListeners();
  }
}

RemoteRequest _multiRequest(String hash, List<bool> checked) => RemoteRequest(
  ref: prior.b,
  agent: prior.a,
  kind: 'terminal-prompt',
  createdAt: 1,
  expiresAt: 86400001,
  body: QuestionRequestBody(
    const [
      RequestQuestion(
        question: '넣을 기능을 모두 고르세요',
        header: '질문',
        multiSelect: true,
        options: [],
      ),
    ],
    screen: TerminalPromptScreen(hash, 80, 24, 3, [
      TerminalPromptOption(3, '[x] 찾기', true, checked: checked[0]),
      TerminalPromptOption(4, '[ ] 닫은 탭 복구', true, checked: checked[1]),
      const TerminalPromptOption(5, 'Next', true),
    ], title: '넣을 기능을 모두 고르세요'),
  ),
);

const _caps = [
  'session.watch',
  'terminal.watch',
  'terminal.key',
  'terminal.select',
  'request.answer',
  'transcript.page',
  'transcript.watch',
];

Future<(_Wire, RemoteState, ActiveRemoteSession)> _setup(
  WidgetTester tester, {
  List<Map<String, Object?>> questions = const [],
  List<Map<String, Object?>> requests = const [],
  bool fake = false,
  List<String> caps = _caps,
}) async {
  tester.view.physicalSize = const Size(412, 892);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final wire = _Wire()
    ..questions = questions
    ..requests = requests;
  final session = ActiveRemoteSession.attach(
    capabilities: caps,
    connection: wire,
    pingInterval: const Duration(days: 1),
  );
  final state = fake ? _FakeState(session) : RemoteState(session);
  await state.initialize();
  return (wire, state, session);
}

Future<void> _home(WidgetTester tester, RemoteState state) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: designTestTheme(Brightness.dark),
      builder: _still,
      home: AgentListScreen(
        state: state,
        onDisconnect: () {},
        onUnregister: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _openAnswer(WidgetTester tester) async {
  // 제출 확인 카드는 답하기 버튼 없이 머리줄을 눌러 전체 화면을 연다
  final button = find.byKey(const Key('terminal-question-answer-${prior.b}'));
  await tester.tap(
    button.evaluate().isNotEmpty
        ? button
        : find
              .descendant(
                of: find.byKey(const Key('terminal-question-${prior.b}')),
                matching: find.byType(InkWell),
              )
              .first,
  );
  await tester.pumpAndSettle();
}

Finder get _send => find.byKey(const Key('terminal-question-send'));

Future<void> _finish(
  WidgetTester tester,
  RemoteState state,
  ActiveRemoteSession session,
) async {
  await tester.pump(const Duration(seconds: 6));
  await tester.pumpWidget(const SizedBox());
  state.dispose();
  await session.disconnect();
}

// 가장 가까운 FadeTransition 의 현재 불투명도
double _fadeOf(WidgetTester tester, Finder target) => tester
    .widget<FadeTransition>(
      find.ancestor(of: target, matching: find.byType(FadeTransition)).first,
    )
    .opacity
    .value;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadDesignReferenceFont);

  // 실제 화면 유형별 렌더 캡처: PROMPT_RENDER_JSON(서버 추출 결과)과 PROMPT_RENDER_DIR 가 있을 때만 PNG 로 저장
  final renderJson = Platform.environment['PROMPT_RENDER_JSON'];
  final renderDir = Platform.environment['PROMPT_RENDER_DIR'];
  if (renderJson != null && renderDir != null) {
    final items = (jsonDecode(File(renderJson).readAsStringSync()) as List)
        .cast<Map<String, dynamic>>();
    for (final item in items) {
      testWidgets('렌더 캡처 ${item['name']}', (tester) async {
        final screen = Map<String, Object?>.from(item['screen'] as Map)
          ..['hash'] = _hash
          ..['columns'] = 100
          ..['rows'] = 60
          ..['selectedRow'] = (item['screen']['options'] as List).first['row'];
        for (final o in screen['options'] as List) {
          (o as Map).remove('description_raw');
        }
        final (wire, state, session) = await _setup(
          tester,
          questions: [
            {
              'ref': prior.b,
              'agent': prior.a,
              'kind': 'terminal-prompt',
              'createdAt': 1,
              'expiresAt': 86400001,
              'body': {
                'questions': [
                  {
                    'question': screen['question'],
                    'header': '질문',
                    'multiSelect': screen['multiSelect'],
                    'options': [
                      for (final o in screen['options'] as List)
                        {'label': o['text'], 'description': o['description'] ?? ''},
                    ],
                  },
                ],
                'screen': screen,
              },
            },
          ],
        );
        tester.view.physicalSize = const Size(1080, 2340);
        tester.view.devicePixelRatio = 2.625;
        Future<void> shot(String suffix) async {
          final boundary = tester.renderObject<RenderRepaintBoundary>(
            find.byType(RepaintBoundary).first,
          );
          final bytes = await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            return (await image.toByteData(format: ui.ImageByteFormat.png))!;
          });
          File('$renderDir/${item['name']}-$suffix.png')
              .writeAsBytesSync(bytes!.buffer.asUint8List());
        }

        await _home(tester, state);
        await shot('card');
        final button = find.byKey(const Key('terminal-question-answer-${prior.b}'));
        await tester.tap(
          button.evaluate().isNotEmpty
              ? button
              : find
                    .descendant(
                      of: find.byKey(const Key('terminal-question-${prior.b}')),
                      matching: find.byType(InkWell),
                    )
                    .first,
        );
        await tester.pumpAndSettle();
        await shot('screen');
        await _finish(tester, state, session);
      });
    }
  }

  testWidgets('단일 질문: 홈 카드 답하기 → 전체 화면에서 고른 뒤 보내기로 한 번 전송', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '어느 색으로 할까요?',
          options: [
            _option(3, '1. 파랑', description: '차분한 색'),
            _option(4, '2. 초록'),
            _option(5, '3. Type something', selectable: false, role: 'text'),
          ],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    expect(find.byKey(const Key('response-screen')), findsOneWidget);
    expect(find.text('어느 색으로 할까요?'), findsWidgets);
    expect(find.text('차분한 색'), findsOneWidget);
    expect(find.byType(IrisActionBar), findsOneWidget);
    expect(find.text('답을 고르세요'), findsOneWidget);
    // 고르기만 하면 전송하지 않음
    await tester.tap(find.byKey(const Key('terminal-option-4')));
    await tester.pumpAndSettle();
    expect(wire.selects, isEmpty);
    expect(find.text('‘초록’ 보내기'), findsOneWidget);
    await tester.tap(_send);
    await tester.pumpAndSettle();
    final sent = wire.selects.single;
    expect(sent['hash'], _hash);
    expect(sent['row'], 4);
    expect(sent['agent'], prior.a);
    // 보낸 화면이 그대로면 다시 보내지 않음
    await tester.tap(_send);
    await tester.pumpAndSettle();
    expect(wire.selects.length, 1);
    await _finish(tester, state, session);
  });

  testWidgets('다중 질문: 체크는 고르는 즉시 전송, 다음 줄은 아래 버튼으로 전송', (tester) async {
    final (wire, state, session) = await _setup(tester, fake: true);
    (state as _FakeState).setFake([
      _multiRequest(_hash, [true, false]),
    ]);
    await _home(tester, state);
    await _openAnswer(tester);
    expect(find.text('질문 · 여러 개 선택'), findsOneWidget);
    expect(find.text('다음 · 1개 선택'), findsOneWidget);
    await tester.tap(find.byKey(const Key('terminal-option-4')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(wire.selects.single['row'], 4);
    // 새 체크 상태가 오기 전까지 눌린 줄의 체크 자리는 로딩 표시, 다른 줄은 그대로
    expect(
      find.descendant(
        of: find.byKey(const Key('terminal-option-4')),
        matching: find.byKey(const Key('select-mark-loading')),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('select-mark-loading')), findsOneWidget);
    // 화면이 바뀌면(새 해시) 입력이 다시 열림
    state.setFake([
      _multiRequest(_hash2, [true, true]),
    ]);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('select-mark-loading')), findsNothing);
    expect(find.text('다음 · 2개 선택'), findsOneWidget);
    await tester.tap(_send);
    await tester.pumpAndSettle();
    expect(wire.selects.length, 2);
    expect(wire.selects.last['row'], 5);
    expect(wire.selects.last['hash'], _hash2);
    await _finish(tester, state, session);
  });

  testWidgets('여러 질문과 제출 확인: 상단 질문 n / m, 제출·취소는 각 줄을 전송', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '두 번째 질문',
          step: 2,
          steps: 3,
          options: [_option(3, '1. 가'), _option(4, '2. 나')],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    expect(find.text('질문 2 / 3'), findsOneWidget);
    wire.setQuestions([
      _terminalQuestion(
        question: 'Review your answers',
        variant: 'review',
        step: 3,
        steps: 3,
        hash: _hash2,
        options: [
          _option(3, '1. Submit answers', role: 'allow'),
          _option(4, '2. Cancel', role: 'deny'),
        ],
      ),
    ]);
    await tester.pumpAndSettle();
    expect(find.text('이대로 보낼까요?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('terminal-question-cancel')));
    await tester.pumpAndSettle();
    expect(wire.selects.single['row'], 4);
    await _finish(tester, state, session);
  });

  testWidgets('여러 질문의 선택지는 누르는 즉시 전송해 다음 질문으로 넘어간다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '두 번째 질문',
          step: 2,
          steps: 3,
          options: [_option(3, '1. 가'), _option(4, '2. 나')],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    await tester.tap(find.byKey(const Key('terminal-option-4')));
    await tester.pumpAndSettle();
    expect(wire.selects.single['row'], 4);
    await _finish(tester, state, session);
  });

  testWidgets('여러 질문: 이전·다음 질문은 ←/→ 키를 보내고 화면이 바뀔 때까지 잠근다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '첫 질문입니까?',
          step: 1,
          steps: 3,
          options: [_option(3, '1. 가'), _option(4, '2. 나')],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    Finder prev = find.byKey(const Key('response-step-prev'));
    Finder next = find.byKey(const Key('response-step-next'));
    final semantics = tester.ensureSemantics();
    bool enabled(Finder f) =>
        tester.getSemantics(f).getSemanticsData().flagsCollection.isEnabled ==
        Tristate.isTrue;
    // 첫 질문: 이전·다음 모두 비활성
    expect(find.text('질문 1 / 3'), findsOneWidget);
    expect(enabled(prev), isFalse);
    expect(enabled(next), isFalse);
    await tester.tap(prev);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(wire.keys, isEmpty);
    // 답한 질문으로 돌아온 화면: 이전 선택 표시, 이전·다음 활성
    wire.setQuestions([
      _terminalQuestion(
        question: '둘째 질문입니까?',
        step: 3,
        steps: 3,
        hash: _hash2,
        options: [
          _option(3, '❯ 1. 가 (Recommended) ✔'),
          _option(4, '2. 나'),
        ],
      ),
    ]);
    await tester.pumpAndSettle();
    expect(find.text('이전 선택'), findsOneWidget);
    expect(find.text('추천'), findsOneWidget);
    expect(enabled(prev), isTrue);
    expect(enabled(next), isTrue);
    await tester.tap(prev);
    await tester.pumpAndSettle();
    expect(wire.keys.single['key'], 'ArrowLeft');
    expect(wire.keys.single['agent'], prior.a);
    // 화면이 그대로면 잠금: 다음을 눌러도 보내지 않음
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(wire.keys.length, 1);
    // 화면이 바뀌면 다시 열림
    wire.setQuestions([
      _terminalQuestion(
        question: '첫 질문입니까?',
        step: 3,
        steps: 3,
        hash: _hash,
        options: [_option(3, '1. 가 ✔'), _option(4, '2. 나')],
      ),
    ]);
    await tester.pumpAndSettle();
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(wire.keys.length, 2);
    expect(wire.keys.last['key'], 'ArrowRight');
    semantics.dispose();
    await _finish(tester, state, session);
  });

  testWidgets('제출 확인 칸은 이전만 활성, 질문이 하나거나 키 전송이 없으면 이동 조작이 없다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: 'Review your answers',
          variant: 'review',
          step: 3,
          steps: 3,
          options: [
            _option(3, '1. Submit answers', role: 'allow'),
            _option(4, '2. Cancel', role: 'deny'),
          ],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    await tester.tap(find.byKey(const Key('response-step-next')));
    await tester.pumpAndSettle();
    expect(wire.keys, isEmpty);
    await tester.tap(find.byKey(const Key('response-step-prev')));
    await tester.pumpAndSettle();
    expect(wire.keys.single['key'], 'ArrowLeft');
    wire.setQuestions([
      _terminalQuestion(
        question: '하나뿐입니까?',
        hash: _hash2,
        options: [_option(3, '1. 예'), _option(4, '2. 아니오')],
      ),
    ]);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('response-step-prev')), findsNothing);
    await _finish(tester, state, session);
  });

  testWidgets('키 전송 기능이 없는 연결에는 질문 이동 조작이 없다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      caps: [
        for (final c in _caps)
          if (c != 'terminal.key') c,
      ],
      questions: [
        _terminalQuestion(
          question: '질문입니까?',
          step: 2,
          steps: 3,
          options: [_option(3, '1. 가 ✔'), _option(4, '2. 나')],
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: TerminalQuestionScreen(
          state: state,
          agentRef: prior.a,
          agentName: 'claude',
          agentKind: 'claude',
          space: '',
          onTerminal: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('질문 2 / 3'), findsOneWidget);
    expect(find.byKey(const Key('response-step-prev')), findsNothing);
    expect(wire.keys, isEmpty);
    await _finish(tester, state, session);
  });

  testWidgets('질문 문구는 줄바꿈을 이어 제목과 설명으로 나누고 선택지는 고정 문구를 한글로 보인다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '지금 탭을 정리합니다. 어디까지\n닫을까요?',
          options: [
            _option(3, '1. 그 칸만 (Recommended)', description: '첫 줄\n둘째 줄'),
            _option(4, '2. Chat about this', role: 'chat'),
            _option(5, '3. Type something.', selectable: false, role: 'text'),
          ],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    expect(
      find.descendant(
        of: find.byKey(const Key('terminal-question-title')),
        matching: find.text('어디까지 닫을까요?'),
      ),
      findsOneWidget,
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('terminal-question-body'))).data,
      '지금 탭을 정리합니다.',
    );
    expect(find.text('첫 줄 둘째 줄'), findsOneWidget);
    expect(find.textContaining('Recommended'), findsNothing);
    expect(find.text('이 내용으로 대화하기'), findsOneWidget);
    expect(find.text('직접 입력'), findsOneWidget);
    expect(find.byKey(const Key('option-badge-recommended')), findsOneWidget);
    await _finish(tester, state, session);
  });

  testWidgets('제출 확인의 제출은 허용 줄을 전송', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: 'Review your answers',
          variant: 'review',
          options: [
            _option(3, '1. Submit answers', role: 'allow'),
            _option(4, '2. Cancel', role: 'deny'),
          ],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    await tester.tap(find.byKey(const Key('terminal-question-submit')));
    await tester.pumpAndSettle();
    expect(wire.selects.single['row'], 3);
    await _finish(tester, state, session);
  });

  testWidgets('화면이 바뀐 오류는 안내하고 전체 화면에 남으며 질문이 사라지면 종료 안내', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '계속할까요?',
          options: [_option(3, '1. 예'), _option(4, '2. 아니오')],
        ),
      ],
    );
    wire.stale = true;
    await _home(tester, state);
    await _openAnswer(tester);
    await tester.tap(find.byKey(const Key('terminal-option-3')));
    await tester.pumpAndSettle();
    await tester.tap(_send);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('화면이 바뀌었습니다'), findsOneWidget);
    expect(find.byKey(const Key('response-screen')), findsOneWidget);
    wire.setQuestions([]);
    await tester.pumpAndSettle();
    expect(find.text('질문이 끝났습니다'), findsOneWidget);
    expect(find.text('이미 답했습니다'), findsNothing);
    await _finish(tester, state, session);
  });

  testWidgets('대화의 터미널 질문 카드도 같은 전체 화면을 연다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '계속할까요?',
          options: [_option(3, '1. 예'), _option(4, '2. 아니오')],
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: AgentScreen(state: state, agentRef: prior.a),
      ),
    );
    await tester.pumpAndSettle();
    await _openAnswer(tester);
    expect(find.byType(TerminalQuestionScreen), findsOneWidget);
    await tester.tap(find.byKey(const Key('terminal-option-3')));
    await tester.pumpAndSettle();
    await tester.tap(_send);
    await tester.pumpAndSettle();
    expect(wire.selects.single['row'], 3);
    await _finish(tester, state, session);
  });

  testWidgets('대화에 같은 에이전트의 일반 승인·질문 카드가 보이고 답하기가 응답 화면을 연다', (tester) async {
    final (_, state, session) = await _setup(
      tester,
      requests: [
        _permission(prior.b, prior.a, 'pnpm install:app'),
        _askRequest('e' * 32, prior.a, '어느 쪽인가요?'),
        // 다른 에이전트의 요청은 보이지 않음
        _permission('f' * 32, prior.t, 'ls'),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: AgentScreen(state: state, agentRef: prior.a),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('답 필요'), findsNWidgets(2));
    expect(find.text('pnpm install:app'), findsOneWidget);
    expect(find.byKey(Key('conversation-request-${'f' * 32}')), findsNothing);
    // 요청이 있으면 터미널 대체 카드는 중복으로 나오지 않음
    expect(find.byKey(const Key('session-question-fallback')), findsNothing);
    await tester.tap(
      find.byKey(const Key('conversation-request-open-${prior.b}')),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('response-screen')), findsOneWidget);
    expect(find.byKey(const Key('permission-title')), findsOneWidget);
    await _finish(tester, state, session);
  });

  testWidgets('요청 사이를 오가도 고른 답이 남고 이동한 요청의 에이전트가 반환된다', (tester) async {
    final other = prior.t;
    final (wire, state, session) = await _setup(
      tester,
      requests: [
        _permission(prior.b, prior.a, 'ls'),
        _permission('e' * 32, other, 'pwd'),
      ],
    );
    String? result = 'unset';
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              result = await showResponseHost(
                context: context,
                state: state,
                request: state.requests.first,
                agentName: '첫째',
                agentKind: 'claude',
                space: 'iris',
              );
            },
            child: const Text('열기'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('permission-option-1')));
    await tester.pumpAndSettle();
    expect(find.text('‘허용’ 보내기'), findsOneWidget);
    await tester.tap(find.byKey(const Key('response-next')));
    await tester.pumpAndSettle();
    expect(find.text('답을 고르세요'), findsOneWidget);
    await tester.tap(find.byKey(const Key('response-prev')));
    await tester.pumpAndSettle();
    expect(find.text('‘허용’ 보내기'), findsOneWidget);
    // 둘째 요청으로 이동해 거절하면 둘째 에이전트가 반환됨
    await tester.tap(find.byKey(const Key('response-next')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('permission-option-2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('permission-send')));
    await tester.pumpAndSettle();
    expect(result, other);
    expect(wire.sent.where((m) => m['type'] == 'request.answer').length, 1);
    await _finish(tester, state, session);
  });

  testWidgets('질문 선택·직접 입력은 요청을 오간 뒤에도 남고 목록에서 사라진 요청은 종료로 안내', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      requests: [
        _askRequest(prior.b, prior.a, '첫 질문'),
        _permission('e' * 32, prior.a, 'ls'),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showResponseHost(
              context: context,
              state: state,
              request: state.requests.first,
              agentName: '첫째',
              agentKind: 'claude',
              space: 'iris',
            ),
            child: const Text('열기'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('question-option-first')));
    await tester.pumpAndSettle();
    expect(find.text('‘가’ 보내기'), findsOneWidget);
    await tester.tap(find.byKey(const Key('response-next')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('response-prev')));
    await tester.pumpAndSettle();
    expect(find.text('‘가’ 보내기'), findsOneWidget);
    // 요청이 목록에서 사라지면 답했다고 단정하지 않음
    wire.setRequests([]);
    await tester.pumpAndSettle();
    expect(find.text('요청이 끝났습니다'), findsOneWidget);
    expect(find.text('이미 답했습니다'), findsNothing);
    await _finish(tester, state, session);
  });

  testWidgets('보내는 중에는 질문 선택과 직접 입력이 잠기고 서버에는 보낸 답이 전달된다', (tester) async {
    final gate = Completer<RequestAnswerResult>();
    List<QuestionResponse>? sent;
    final request = RemoteRequest(
      ref: prior.b,
      agent: prior.a,
      kind: 'claude-question',
      createdAt: DateTime.now().millisecondsSinceEpoch,
      expiresAt: DateTime.now().millisecondsSinceEpoch + 600000,
      body: const QuestionRequestBody([
        RequestQuestion(
          question: '고르세요',
          header: '질문',
          multiSelect: false,
          options: [
            RequestOption(label: '가', description: ''),
            RequestOption(label: '나', description: ''),
          ],
        ),
      ]),
    );
    tester.view.physicalSize = const Size(412, 892);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: QuestionRequestSheet(
          request: request,
          agentName: '세션',
          agentKind: 'claude',
          space: 'iris',
          onAnswer: (responses) {
            sent = responses;
            return gate.future;
          },
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('question-option-first')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('question-next')));
    await tester.pump();
    expect(find.text('보내는 중…'), findsOneWidget);
    // 전송 중 다른 선택지를 눌러도 선택이 바뀌지 않음
    await tester.tap(find.text('나'));
    await tester.pump();
    gate.complete(const RequestAnswerResult(rid: 'x', result: 'failed'));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(seconds: 3));
    expect((sent!.single as QuestionLabels).labels, ['가']);
    // 화면의 선택도 보낸 답 그대로
    expect(find.text('‘가’ 보내기'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('명령·diff 의 긴 줄은 말줄임 없이 끝까지 표시된다', (tester) async {
    final tail = 'END-OF-LINE-${'x' * 30}';
    final command = 'echo ${'a' * 120} $tail';
    tester.view.physicalSize = const Size(412, 892);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    RemoteRequest permission(String tool, String input) => RemoteRequest(
      ref: prior.b,
      agent: prior.a,
      kind: 'claude-permission',
      createdAt: DateTime.now().millisecondsSinceEpoch,
      expiresAt: DateTime.now().millisecondsSinceEpoch + 600000,
      body: PermissionRequestBody(tool: tool, description: '', input: input),
    );
    Future<void> show(RemoteRequest request) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: designTestTheme(Brightness.dark),
          builder: _still,
          home: PermissionRequestSheet(
            request: request,
            agentName: '세션',
            agentKind: 'claude',
            space: 'iris',
            onAnswer: (_) async => throw StateError('no'),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    bool clipped(Finder finder) =>
        tester.renderObject<RenderParagraph>(finder).didExceedMaxLines;
    await show(permission('Bash', command));
    expect(clipped(find.text(command)), isFalse);
    final line = '+const value = "${'b' * 100} $tail";';
    await show(permission('Edit', '@@ -1,1 +1,1 @@\n-old\n$line'));
    expect(clipped(find.text(line.substring(1))), isFalse);
    // 파일 수정 승인 상단에 대상 세션 이름이 보임
    expect(find.textContaining('세션 · iris'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('홈 아이콘 버튼은 접근성 탭 동작을 제공한다', (tester) async {
    final handle = tester.ensureSemantics();
    final (_, state, session) = await _setup(tester);
    await _home(tester, state);
    final data = tester.getSemantics(find.byKey(const Key('home-refresh')));
    expect(data.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    handle.dispose();
    await _finish(tester, state, session);
  });

  testWidgets('모션: 요청 이동은 새 화면만 페이드·슬라이드, 제출 확인은 페이드', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      requests: [
        _permission(prior.b, prior.a, 'ls'),
        _permission('e' * 32, prior.t, 'pwd'),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showResponseHost(
              context: context,
              state: state,
              request: state.requests.first,
              agentName: '첫째',
              agentKind: 'claude',
              space: 'iris',
            ),
            child: const Text('열기'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    final screen = find.byKey(const Key('response-screen'));
    await tester.tap(find.byKey(const Key('response-next')));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(screen, findsOneWidget);
    expect(_fadeOf(tester, screen), inExclusiveRange(0, 1));
    expect(tester.getTopLeft(screen).dy, greaterThan(0));
    await tester.pump(const Duration(milliseconds: 300));
    expect(_fadeOf(tester, screen), 1);
    expect(tester.getTopLeft(screen).dy, 0);
    await _finish(tester, state, session);
  });

  testWidgets('모션: 질문 요청의 제출 확인 단계는 페이드로 들어온다', (tester) async {
    Map<String, Object> question(String text) => {
      'question': text,
      'header': '질문',
      'multiSelect': false,
      'options': [
        {'label': '가', 'description': ''},
        {'label': '나', 'description': ''},
      ],
    };
    final request = _askRequest('a' * 32, prior.a, '첫째');
    (request['body']! as Map<String, Object?>)['questions'] = [
      question('첫째'),
      question('둘째'),
    ];
    final (wire, state, session) = await _setup(tester, requests: [request]);
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showResponseHost(
              context: context,
              state: state,
              request: state.requests.first,
              agentName: '첫째',
              agentKind: 'claude',
              space: 'iris',
            ),
            child: const Text('열기'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    for (var i = 0; i < 2; i++) {
      await tester.tap(find.byKey(const Key('question-option-first')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('question-next')));
      if (i == 1) {
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 60));
      } else {
        await tester.pumpAndSettle();
      }
    }
    expect(_fadeOf(tester, find.text('이대로 보낼까요?')), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 300));
    expect(_fadeOf(tester, find.text('이대로 보낼까요?')), 1);
    await _finish(tester, state, session);
  });

  testWidgets('모션: 여러 질문의 제출 확인 단계는 페이드로 들어온다', (tester) async {
    final (wire, state, session) = await _setup(
      tester,
      questions: [
        _terminalQuestion(
          question: '두 번째 질문',
          step: 2,
          steps: 3,
          options: [_option(3, '1. 가'), _option(4, '2. 나')],
        ),
      ],
    );
    await _home(tester, state);
    await _openAnswer(tester);
    wire.setQuestions([
      _terminalQuestion(
        question: 'Review your answers',
        variant: 'review',
        step: 3,
        steps: 3,
        hash: _hash2,
        options: [
          _option(3, '1. Submit answers', role: 'allow'),
          _option(4, '2. Cancel', role: 'deny'),
        ],
      ),
    ]);
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(_fadeOf(tester, find.text('이대로 보낼까요?')), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 300));
    expect(_fadeOf(tester, find.text('이대로 보낼까요?')), 1);
    await _finish(tester, state, session);
  });

  testWidgets('모션: 홈 질문 카드는 새로 생길 때만 입장하고 개수 배지는 바뀔 때 스케일', (tester) async {
    final first = _askRequest('a' * 32, prior.a, '첫 질문');
    final (wire, state, session) = await _setup(tester, requests: [first]);
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        builder: _still,
        home: AgentListScreen(
          state: state,
          onDisconnect: () {},
          onUnregister: () {},
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    final firstCard = find.byKey(Key('request-${'a' * 32}'));
    final secondCard = find.byKey(Key('request-${'b' * 32}'));
    // 첫 빌드에 있던 카드는 모션 없음
    expect(_fadeOf(tester, firstCard), 1);
    double badge() => tester
        .widget<ScaleTransition>(
          find
              .ancestor(
                of: find.byKey(const Key('home-needed-count')),
                matching: find.byType(ScaleTransition),
              )
              .first,
        )
        .scale
        .value;
    expect(badge(), 1);
    wire.setRequests([first, _askRequest('b' * 32, prior.a, '둘째 질문')]);
    await tester.pump();
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(_fadeOf(tester, secondCard), inExclusiveRange(0, 1));
    expect(_fadeOf(tester, firstCard), 1);
    expect(badge(), greaterThan(1.0));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_fadeOf(tester, secondCard), 1);
    expect(badge(), 1);
    await _finish(tester, state, session);
  });
}
