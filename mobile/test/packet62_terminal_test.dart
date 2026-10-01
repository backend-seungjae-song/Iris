import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';
import 'package:iris_remote/screens/terminal_screen.dart';

import 'packet61_test.dart' as prior;

import 'package:iris_remote/design/terminal_grid.dart';

void main() {
  test('콜론 truecolor의 빈·기본 색 공간과 팔레트 색을 분리해 해석', () {
    for (final colorSpace in ['', '0']) {
      final grid = parseTerminalGrid(
        '\x1b[38:2:$colorSpace:255:0:0;48:2:$colorSpace:0:0:255;1mR',
        columns: 1,
        rows: 1,
      );
      expect(grid.cells[0][0].style.color, const Color(0xffff0000));
      expect(grid.cells[0][0].style.backgroundColor, const Color(0xff0000ff));
      expect(grid.cells[0][0].style.fontWeight, FontWeight.bold);
    }
    final palette = parseTerminalGrid(
      '\x1b[38:5:196;48:5:21mR',
      columns: 1,
      rows: 1,
    );
    expect(palette.cells[0][0].style.color, const Color(0xffff0000));
    expect(palette.cells[0][0].style.backgroundColor, const Color(0xff0000ff));
  });
  test('16·256·truecolor와 굵게·기울임·밑줄·흐림·반전', () {
    final grid = parseTerminalGrid(
      '\x1b[91;1;3;4mA\x1b[38;5;196mB\x1b[38;2;1;2;3;48;2;4;5;6;2;7mC',
      columns: 3,
      rows: 1,
    );
    expect(grid.cells[0][0].style.color, const Color(0xffff0000));
    expect(grid.cells[0][0].style.fontWeight, FontWeight.bold);
    expect(grid.cells[0][0].style.fontStyle, FontStyle.italic);
    expect(grid.cells[0][0].style.decoration, TextDecoration.underline);
    expect(grid.cells[0][1].style.color, const Color(0xffff0000));
    expect(grid.cells[0][2].style.backgroundColor, const Color(0xff010203));
    expect(grid.cells[0][2].style.color!.a, closeTo(.55, .01));
    expect(terminalPalette(232), const Color(0xff080808));
    expect(terminalPalette(255), const Color(0xffeeeeee));
  });
  test('박스·목록1칸, 결합 글자·ZWJ·한글·이모지 셀 폭', () {
    final grid = parseTerminalGrid('│❯○é한👩‍💻Z', columns: 10, rows: 1);
    expect(grid.cells[0][0].value, '│');
    expect(grid.cells[0][1].value, '❯');
    expect(grid.cells[0][3].value, 'é');
    expect(grid.cells[0][4].width, 2);
    expect(grid.cells[0][6].value, '👩‍💻');
    expect(grid.cells[0][6].width, 2);
    expect(grid.cells[0][8].value, 'Z');
  });
  test('지우기·alternate screen·표시 커서 좌표', () {
    final grid = parseTerminalGrid(
      'old\x1b[?1049hnew\x1b[?1049l\x1b[2G\x1b[0K\x1b[?25h',
      columns: 4,
      rows: 1,
    );
    expect(grid.plainText, 'o');
    expect(grid.cursorX, 1);
    expect(grid.cursorVisible, true);
  });
  test('87·200열 폰 폭 맞춤과 실제 셀 좌표', () {
    for (final columns in [87, 200]) {
      final size = terminalFontSize(358, columns);
      final metric = TextPainter(
        text: TextSpan(
          text: 'M',
          style: TextStyle(fontFamily: 'monospace', fontSize: size),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      expect(metric.width * columns, lessThanOrEqualTo(358.01));
    }
    expect(terminalCellAt(const Offset(11, 31), 5, 10, 87, 44), (
      column: 3,
      row: 4,
    ));
    expect(terminalCellAt(const Offset(5000, 5000), 5, 10, 87, 44), (
      column: 87,
      row: 44,
    ));
  });
  test('프레임 메타데이터 검증과 크기 없는 이전 프레임 호환', () {
    final valid = <String, dynamic>{
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 0,
      'text': 'hello',
      'truncated': false,
      'hash': 'b' * 64,
      'columns': 87,
      'rows': 44,
      'mouseMode': false,
    };
    final frame = parseServerMessage(jsonEncode(valid)) as TerminalFrame;
    expect(frame.columns, 87);
    expect(
      () => parseServerMessage(jsonEncode({...valid, 'columns': 0})),
      throwsA(isA<ProtocolException>()),
    );
    expect(
      () => parseServerMessage(jsonEncode({...valid, 'extra': true})),
      throwsA(isA<ProtocolException>()),
    );
    expect(
      () => parseServerMessage(jsonEncode({...valid, 'hash': 'bad'})),
      throwsA(isA<ProtocolException>()),
    );
  });
  testWidgets('revision0 프레임 수신→격자 즉시 갱신·터치 row·복사 시트', (tester) async {
    final wire = TerminalWire();
    final session = ActiveRemoteSession.attach(
      macName: 'Mac',
      capabilities: ['watch', 'terminal.watch', 'terminal.select'],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      prior.app(TerminalScreen(state: state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    TerminalGridPainter painted() =>
        tester
                .widget<CustomPaint>(find.byKey(const Key('terminal-output')))
                .painter!
            as TerminalGridPainter;
    expect(painted().grid.cells[0][0].value, 'A');
    wire.emit({
      'type': 'terminal.frame',
      'agent': prior.a,
      'revision': 0,
      'text': 'B',
      'truncated': false,
      'hash': 'c' * 64,
      'columns': 10,
      'rows': 3,
      'mouseMode': false,
    });
    await tester.pumpAndSettle();
    expect(painted().grid.cells[0][0].value, 'B');
    final box = tester.getRect(find.byKey(const Key('terminal-output')));
    await tester.tapAt(box.topLeft + Offset(5, box.height / 3 + 2));
    await tester.pumpAndSettle();
    final request = wire.sent.lastWhere(
      (request) => request['type'] == 'terminal.select',
    );
    expect(request['row'], 2);
    expect(request['hash'], 'c' * 64);
    await tester.longPress(find.byKey(const Key('terminal-output')));
    await tester.pumpAndSettle();
    expect(find.text('전체 복사'), findsOneWidget);
    expect(find.byType(SelectableText), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });
  testWidgets('마우스 끌기 뗌 stale 거절 뒤 최신 프레임으로 한 번 복구', (tester) async {
    final wire = TerminalWire()
      ..mouse = true
      ..staleUp = true;
    final session = ActiveRemoteSession.attach(
      macName: 'Mac',
      capabilities: ['watch', 'terminal.watch', 'terminal.mouse'],
      connection: wire,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    await state.initialize();
    await tester.pumpWidget(
      prior.app(TerminalScreen(state: state, agentRef: prior.a)),
    );
    await tester.pumpAndSettle();
    final box = tester.getRect(find.byKey(const Key('terminal-output')));
    final gesture = await tester.startGesture(
      box.topLeft + const Offset(10, 10),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await gesture.moveBy(const Offset(10, 10));
    await tester.pump(const Duration(milliseconds: 300));
    await gesture.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    final actions = wire.sent
        .where((request) => request['type'] == 'terminal.mouse')
        .toList();
    expect(
      actions.map((request) => request['action']),
      containsAllInOrder(['down', 'drag', 'up', 'up']),
    );
    expect(actions.last['hash'], 'd' * 64);
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await session.disconnect();
  });
  for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
    testWidgets('$platform 스크롤백 진입·과거 화면 마우스 차단·현재로 복귀', (tester) async {
      final wire = TerminalWire();
      final session = ActiveRemoteSession.attach(
        macName: 'Mac',
        capabilities: [
          'watch',
          'terminal.watch',
          'terminal.scrollback',
          'terminal.mouse',
        ],
        connection: wire,
        pingInterval: const Duration(days: 1),
      );
      final state = RemoteState(session);
      await state.initialize();
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(platform: platform, extensions: [IrisColors.dark]),
          home: TerminalScreen(state: state, agentRef: prior.a),
        ),
      );
      await tester.pumpAndSettle();
      await tester.drag(
        find.byKey(const Key('terminal-output')),
        const Offset(0, 100),
      );
      await tester.pumpAndSettle();
      expect(
        wire.sent
            .where((request) => request['type'] == 'terminal.scrollback')
            .length,
        1,
      );
      expect(find.text('현재 화면으로'), findsOneWidget);
      wire.emit({
        'type': 'terminal.frame',
        'agent': prior.a,
        'revision': 0,
        'text': 'C',
        'truncated': false,
        'hash': 'c' * 64,
        'columns': 10,
        'rows': 3,
        'mouseMode': true,
      });
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('terminal-output')));
      await tester.pumpAndSettle();
      expect(
        wire.sent.where((request) => request['type'] == 'terminal.mouse'),
        isEmpty,
      );
      await tester.tap(find.text('현재 화면으로'));
      await tester.pumpAndSettle();
      final painter =
          tester
                  .widget<CustomPaint>(find.byKey(const Key('terminal-output')))
                  .painter!
              as TerminalGridPainter;
      expect(painter.grid.cells[0][0].value, 'C');
      await tester.pumpWidget(const SizedBox());
      state.dispose();
      await session.disconnect();
    });
  }
  test('ANSI SGR colors and inverse are retained per cell', () {
    final grid = parseTerminalGrid(
      '\x1b[38;5;200mA\x1b[48;2;1;2;3mB\x1b[7mC',
      columns: 3,
      rows: 1,
    );
    expect(grid.cells[0][0].value, 'A');
    expect(grid.cells[0][1].value, 'B');
    expect(grid.cells[0][2].value, 'C');
    expect(grid.cells[0][2].style.backgroundColor, isNotNull);
  });

  test('cursor movement overwrites the addressed cell', () {
    final grid = parseTerminalGrid('abc\x1b[2GZ', columns: 3, rows: 1);
    expect(grid.cells[0].map((cell) => cell.value).join(), 'aZc');
    expect(grid.cursorX, 2);
  });

  test('cursor visibility control is retained', () {
    expect(
      parseTerminalGrid('\x1b[?25l', columns: 2, rows: 1).cursorVisible,
      isFalse,
    );
  });

  test('wide code points occupy two terminal cells', () {
    final grid = parseTerminalGrid('한a', columns: 3, rows: 1);
    expect(grid.cells[0][0].value, '한');
    expect(grid.cells[0][2].value, 'a');
  });
}

class TerminalWire extends prior.Wire {
  TerminalWire() : super('terminal');
  bool mouse = false, staleUp = false;
  int watches = 0, ups = 0;
  @override
  void sendJson(Map<String, Object> message) {
    if (message['type'] == 'terminal.watch') {
      watches++;
      sent.add(message);
      emit({
        'type': 'terminal.watch.result',
        'rid': message['rid'],
        'agent': prior.a,
        'revision': 0,
        'text': 'A',
        'truncated': false,
        'hash': (watches == 1 ? 'b' : 'd') * 64,
        'columns': 10,
        'rows': 3,
        'mouseMode': mouse,
      });
    } else if (message['type'] == 'terminal.select') {
      sent.add(message);
      emit({
        'type': 'remote.action.result',
        'rid': message['rid'],
        'result': 'sent',
      });
    } else if (message['type'] == 'terminal.mouse') {
      sent.add(message);
      if (message['action'] == 'up' && staleUp && ups++ == 0) {
        emit({
          'type': 'error',
          'rid': message['rid'],
          'error': {'code': 'terminal-stale-screen'},
        });
      } else {
        emit({
          'type': 'remote.action.result',
          'rid': message['rid'],
          'result': 'sent',
        });
      }
    } else if (message['type'] == 'terminal.scrollback') {
      sent.add(message);
      emit({
        'type': 'terminal.scrollback.result',
        'rid': message['rid'],
        'agent': prior.a,
        'text': 'older\nlatest',
        'columns': 10,
        'lineCount': 2,
      });
    } else {
      super.sendJson(message);
    }
  }
}
