import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/terminal_grid.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'packet61_test.dart' as prior;
import 'packet62_terminal_test.dart' as terminal;

void main() {
  for (final code in ['terminal-read-timeout', 'terminal-screen-stale']) {
    testWidgets('$code 스트림 오류 표시와 다음 프레임 복구', (tester) async {
      final wire = terminal.TerminalWire();
      final session = ActiveRemoteSession.attach(
        macName: 'Mac',
        capabilities: ['watch', 'terminal.watch'],
        connection: wire,
        pingInterval: const Duration(days: 1),
      );
      final state = RemoteState(session);
      await state.initialize();
      await tester.pumpWidget(
        prior.app(TerminalScreen(state: state, agentRef: prior.a)),
      );
      await tester.pumpAndSettle();
      final frame = <String, Object>{
        'type': 'terminal.frame',
        'agent': prior.a,
        'revision': 0,
        'text': 'A',
        'truncated': false,
        'hash': 'c' * 64,
        'columns': 10,
        'rows': 3,
        'mouseMode': false,
        'error': code,
      };
      expect(parseServerMessage(jsonEncode(frame)), isA<TerminalFrame>());
      wire.emit(frame);
      await tester.pumpAndSettle();
      expect(find.text(terminalErrorMessage(code)), findsOneWidget);
      wire.emit({...frame..remove('error'), 'text': 'B', 'hash': 'd' * 64});
      await tester.pumpAndSettle();
      expect(find.text(terminalErrorMessage(code)), findsNothing);
      final paint = tester.widget<CustomPaint>(
        find.byKey(const Key('terminal-output')),
      );
      expect(
        (paint.painter! as TerminalGridPainter).grid.cells[0][0].value,
        'B',
      );
      await tester.pumpWidget(const SizedBox());
      state.dispose();
      await session.disconnect();
    });
  }
}
