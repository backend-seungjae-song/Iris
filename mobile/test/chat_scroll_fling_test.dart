import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/agent_screen.dart';

import 'design_fixture.dart';

List<TranscriptItem> _items(int from, int to) => [
  for (var i = from; i < to; i++)
    TranscriptItem(
      role: i.isEven ? 'user' : 'assistant',
      text: '메시지 $i\n${'긴 줄 ' * (i % 7 * 12)}',
    ),
];

// 같은 날 기록. 149·150·151 처럼 쪽 경계에 도구 줄이 이어짐
final _day = DateTime(2026, 1, 5, 9).millisecondsSinceEpoch;
List<TranscriptItem> _toolItems(int from, int to) => [
  for (var i = from; i < to; i++)
    if (const {4, 0, 1}.contains(i % 5))
      TranscriptItem(role: 'tool', text: '{}', tool: 'Read', at: _day + i)
    else
      TranscriptItem(
        role: i % 5 == 2 ? 'user' : 'assistant',
        text: '메시지 $i\n${'긴 줄 ' * (i % 7 * 12)}',
        at: _day + i,
      ),
];

class _Harness extends StatefulWidget {
  const _Harness({required this.onState, this.make = _items});
  final void Function(_HarnessState) onState;
  final List<TranscriptItem> Function(int, int) make;
  @override
  State<_Harness> createState() => _HarnessState();
}

class _HarnessState extends State<_Harness> {
  late List<TranscriptItem> transcript = widget.make(150, 200);
  bool loadingEarlier = false;
  int next = 150;
  int loads = 0;

  @override
  void initState() {
    super.initState();
    widget.onState(this);
  }

  Future<void> loadEarlier() async {
    loads++;
    setState(() => loadingEarlier = true);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    setState(() {
      transcript = [...widget.make(next - 50, next), ...transcript];
      next -= 50;
      loadingEarlier = false;
    });
  }

  // 이미지를 받아 끝에서 두 번째 항목 높이가 늘어난 것처럼. 항목 수는 그대로
  void grow() => setState(() {
    final n = transcript.length - 2;
    final item = transcript[n];
    transcript = [
      ...transcript.sublist(0, n),
      TranscriptItem(role: item.role, text: '${item.text}${'\n늘어난 줄' * 40}'),
      transcript.last,
    ];
  });

  @override
  Widget build(BuildContext context) {
    final agent = designAgent(
      ref: permissionAgentRef,
      name: '스크롤',
      kind: 'claude',
      status: 'idle',
      space: 'iris',
      minutes: 0,
    );
    return MaterialApp(
      theme: designTestTheme(Brightness.dark),
      home: AgentSessionView(
        agent: agent,
        spaceAgents: [agent],
        transcript: transcript,
        loading: false,
        loadingEarlier: loadingEarlier,
        hasEarlier: next > 0,
        onLoadEarlier: loadEarlier,
        onBack: () {},
        onSelectAgent: (_) {},
        onSend: (_) async => true,
        canMessage: true,
      ),
    );
  }
}

ScrollPosition _position(WidgetTester tester) =>
    tester.state<ScrollableState>(find.byType(Scrollable).first).position;

void main() {
  testWidgets('손가락으로 위로 튕겨 옛 대화를 불러와도 보던 줄이 제자리에 있다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s));
    await tester.pumpAndSettle();
    for (var round = 0; round < 3; round++) {
      final loadsBefore = h.loads;
      var guard = 0;
      while (h.loads == loadsBefore && guard++ < 40) {
        await tester.fling(
          find.byType(Scrollable).first,
          const Offset(0, 500),
          3000,
        );
        for (var f = 0; f < 10 && h.loads == loadsBefore; f++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
      }
      expect(h.loads, loadsBefore + 1);
      // 튕긴 움직임이 멈출 때까지(불러오기 300ms 안)
      final position = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position;
      for (var f = 0; f < 12; f++) {
        final px = position.pixels;
        await tester.pump(const Duration(milliseconds: 16));
        if (position.pixels == px) break;
      }
      // 불러오는 중 화면에 보이는 가장 위 메시지
      final anchor = find
          .textContaining(
            RegExp(
              '메시지 ${h.next}'
              r'(?!\d)',
            ),
          )
          .first;
      final before = tester.getTopLeft(anchor).dy;
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      final after = find.textContaining(
        RegExp(
          '메시지 ${h.next + 50}'
          r'(?!\d)',
        ),
      );
      expect(after, findsOneWidget, reason: '보던 메시지가 화면 밖으로 밀려남 round $round');
      expect(
        tester.getTopLeft(after.first).dy,
        closeTo(before, 1),
        reason: 'round $round',
      );
    }
  });

  testWidgets('쪽 경계에 같은 날 도구 줄이 이어져도 옛 대화를 붙일 때 보던 줄이 제자리에 있다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s, make: _toolItems));
    await tester.pumpAndSettle();
    // 사람처럼 끌어 올려 맨 위에 닿음(불러오기 300ms 동안 멈춤)
    for (var i = 0; i < 40 && h.loads == 0; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 300));
      await tester.pump();
    }
    expect(h.loads, 1);
    final seen = find.textContaining(RegExp(r'메시지 152(?!\d)'));
    final before = tester.getTopLeft(seen.first).dy;
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(h.next, 100);
    expect(tester.getTopLeft(seen.first).dy, closeTo(before, 1));
  });

  testWidgets('맨 아래를 보던 중 위 항목 높이가 늘면 맨 아래를 유지한다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s));
    await tester.pumpAndSettle();
    expect(_position(tester).extentAfter, lessThan(1));
    h.grow();
    await tester.pumpAndSettle();
    expect(_position(tester).extentAfter, lessThan(1));
  });

  testWidgets('위로 올려 둔 동안 항목 높이가 늘어도 끌어내리지 않는다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, 400));
    await tester.pumpAndSettle();
    final pixels = _position(tester).pixels;
    h.grow();
    await tester.pumpAndSettle();
    expect(_position(tester).pixels, closeTo(pixels, 1));
  });
}
