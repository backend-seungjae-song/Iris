import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/terminal_chrome.dart';
import 'package:iris_remote/design/terminal_grid.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'packet61_test.dart' as prior;
import 'packet62_terminal_test.dart' show TerminalWire;
import 'packet63_question_test.dart' show questionMessage;

Future<(RemoteState, ActiveRemoteSession, TerminalWire)> _open(
  WidgetTester tester,
  List<String> capabilities,
) async {
  final wire = TerminalWire();
  final session = ActiveRemoteSession.attach(
    macName: 'Mac',
    capabilities: ['watch', 'terminal.watch', ...capabilities],
    connection: wire,
    pingInterval: const Duration(days: 1),
  );
  final state = RemoteState(session);
  await state.initialize();
  await tester.pumpWidget(
    prior.app(TerminalScreen(state: state, agentRef: prior.a)),
  );
  await tester.pumpAndSettle();
  return (state, session, wire);
}

Future<void> _close(
  WidgetTester tester,
  RemoteState state,
  ActiveRemoteSession session,
) async {
  await tester.pump(const Duration(seconds: 3));
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
  testWidgets('긴 화면은 세로 드래그로 스크롤되고 따라가기가 풀린다', (tester) async {
    final (state, session, wire) = await _open(tester, const []);
    wire.emit({
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 2,
      'text': List.filled(200, 'Y').join('\n'),
      'truncated': false,
      'hash': 'f' * 64,
      'columns': 10,
      'rows': 200,
      'mouseMode': false,
    });
    await tester.pumpAndSettle();
    double offset() => tester
        .state<ScrollableState>(
          find
              .ancestor(
                of: find.byKey(const Key('terminal-output')),
                matching: find.byType(Scrollable),
              )
              .last,
        )
        .position
        .pixels;
    final before = offset();
    await tester.dragFrom(const Offset(200, 300), const Offset(0, 300));
    await tester.pumpAndSettle();
    expect(offset(), lessThan(before));
    await _close(tester, state, session);
  });

  testWidgets('화면 갱신 멈춤 안내는 기존 화면을 지우지 않는다', (tester) async {
    final (state, session, wire) = await _open(tester, const []);
    wire.emit({
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 1,
      'text': 'Z',
      'truncated': false,
      'hash': 'e' * 64,
      'columns': 10,
      'rows': 3,
      'mouseMode': false,
      'error': 'terminal-screen-stale',
    });
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('terminal-stale-notice')), findsOneWidget);
    final painter =
        tester
                .widget<CustomPaint>(find.byKey(const Key('terminal-output')))
                .painter!
            as TerminalGridPainter;
    expect(painter.grid.cells[0][0].value, 'Z');
    await _close(tester, state, session);
  });

  testWidgets('따라가기가 멈추면 자동 따라가기 선택이 풀린다', (tester) async {
    final (state, session, wire) = await _open(tester, const []);
    int selected() =>
        tester.widget<TerminalSegment>(find.byType(TerminalSegment)).selected;
    wire.emit({
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 2,
      'text': 'Y',
      'truncated': false,
      'hash': 'f' * 64,
      'columns': 10,
      'rows': 200,
      'mouseMode': false,
    });
    await tester.pumpAndSettle();
    expect(selected(), 0);
    await tester.tap(find.byKey(const Key('terminal-line-up')));
    await tester.pumpAndSettle();
    expect(selected(), 1);
    await tester.tap(find.text('자동 따라가기'));
    await tester.pumpAndSettle();
    expect(selected(), 0);
    await _close(tester, state, session);
  });

  testWidgets('기록 보기는 스크롤백을 불러오고 자동 따라가기가 실시간으로 복귀', (tester) async {
    final (state, session, wire) = await _open(tester, const [
      'terminal.scrollback',
    ]);
    await tester.tap(find.text('기록 보기'));
    await tester.pumpAndSettle();
    expect(
      wire.sent.where((r) => r['type'] == 'terminal.scrollback').length,
      1,
    );
    TerminalGridPainter painter() =>
        tester
                .widget<CustomPaint>(find.byKey(const Key('terminal-output')))
                .painter!
            as TerminalGridPainter;
    expect(painter().grid.cells[0][0].value, 'o');
    await tester.tap(find.text('자동 따라가기'));
    await tester.pumpAndSettle();
    expect(painter().grid.cells[0][0].value, 'A');
    await _close(tester, state, session);
  });

  testWidgets('일반 터미널에는 대화·브라우저·더 보기 아이콘이 없다', (tester) async {
    final (state, session, _) = await _open(tester, const []);
    expect(find.byKey(const Key('session-chat')), findsNothing);
    expect(find.byKey(const Key('session-browser')), findsNothing);
    expect(find.byKey(const Key('terminal-more')), findsNothing);
    await _close(tester, state, session);
  });

  testWidgets('질문이 있으면 선택 패널과 방향 키가 나오고 키를 보낸다', (tester) async {
    final (state, session, wire) = await _open(tester, const ['terminal.key']);
    expect(find.byKey(const Key('terminal-composer')), findsOneWidget);
    wire.emit(questionMessage());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('terminal-composer')), findsNothing);
    expect(find.text('선택 대기 중'), findsOneWidget);
    await tester.tap(find.text('Enter'));
    await tester.pumpAndSettle();
    final sent = wire.sent.lastWhere((r) => r['type'] == 'terminal.key');
    expect(sent['key'], 'Enter');
    wire.emit({'type': 'terminal.questions', 'questions': []});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('terminal-composer')), findsOneWidget);
    await _close(tester, state, session);
  });

  testWidgets('모션: 멈춤 안내와 선택 대기 칩은 나타날 때 페이드', (tester) async {
    final (state, session, wire) = await _open(tester, const ['terminal.key']);
    wire.emit({
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 1,
      'text': 'Z',
      'truncated': false,
      'hash': 'e' * 64,
      'columns': 10,
      'rows': 3,
      'mouseMode': false,
      'error': 'terminal-screen-stale',
    });
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final stale = find.byKey(const Key('terminal-stale-notice'));
    expect(_fadeOf(tester, stale), inExclusiveRange(0, 1));
    wire.emit(questionMessage());
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(_fadeOf(tester, find.text('선택 대기 중')), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_fadeOf(tester, stale), 1);
    expect(_fadeOf(tester, find.text('선택 대기 중')), 1);
    await _close(tester, state, session);
  });
}
