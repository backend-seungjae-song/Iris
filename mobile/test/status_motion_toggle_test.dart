import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/agent_tile.dart' as tile;
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/status_glyph.dart' as glyph;
import 'package:iris_remote/design/tokens.dart';

// 세션 상태가 작업 중 → 대기 → 작업 중으로 바뀌면 회전 컨트롤러를 다시 만든다
Widget _host(Widget child) => MaterialApp(
  theme: ThemeData(extensions: const [IrisColors.dark]),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  Future<void> toggle(
    WidgetTester tester,
    Widget Function(String status) build,
  ) async {
    for (final status in ['working', 'idle', 'working', 'done', 'working']) {
      await tester.pumpWidget(_host(build(status)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(tester.takeException(), isNull);
  }

  testWidgets('목록 상태 모양은 상태를 오가도 오류가 없다', (tester) async {
    await toggle(tester, (s) => tile.IrisStatusGlyph(status: s));
  });
  testWidgets('대화 화면 상태 모양은 상태를 오가도 오류가 없다', (tester) async {
    await toggle(tester, (s) => glyph.IrisStatusGlyph(status: s));
  });
  testWidgets('상태칩은 작업 중과 대기를 오가도 오류가 없다', (tester) async {
    for (final status in [
      IrisStatus.work,
      IrisStatus.idle,
      IrisStatus.work,
      IrisStatus.live,
      IrisStatus.work,
    ]) {
      await tester.pumpWidget(_host(IrisStatusChip(status, label: '상태')));
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(tester.takeException(), isNull);
  });
}
