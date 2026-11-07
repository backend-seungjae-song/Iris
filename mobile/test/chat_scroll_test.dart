import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/agent_screen.dart';

import 'design_fixture.dart';

List<TranscriptItem> _items(int from, int to) => [
  for (var i = from; i < to; i++)
    TranscriptItem(role: 'assistant', text: '메시지 $i\n둘째 줄\n셋째 줄'),
];

class _Harness extends StatefulWidget {
  const _Harness({required this.onState});
  final void Function(_HarnessState) onState;
  @override
  State<_Harness> createState() => _HarnessState();
}

class _HarnessState extends State<_Harness> {
  List<TranscriptItem> transcript = _items(100, 140);
  bool loading = false;
  bool loadingEarlier = false;
  bool hasEarlier = true;
  int loads = 0;

  @override
  void initState() {
    super.initState();
    widget.onState(this);
  }

  Future<void> loadEarlier() async {
    loads++;
    setState(() => loadingEarlier = true);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    setState(() {
      transcript = [..._items(60, 100), ...transcript];
      loadingEarlier = false;
    });
  }

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
        loading: loading,
        loadingEarlier: loadingEarlier,
        hasEarlier: hasEarlier,
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
  testWidgets('옛 대화를 불러와도 보던 위치를 지키고 한 번만 불러온다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s));
    await tester.pumpAndSettle();
    final position = _position(tester);
    expect(position.pixels, position.maxScrollExtent);

    final anchor = find.textContaining('메시지 100').first;
    position.jumpTo(10);
    await tester.pump();
    final top = tester.getTopLeft(anchor).dy;
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pumpAndSettle();
    expect(h.loads, 1);
    // 불러오기 전에 보이던 줄이 화면의 같은 자리에 남는다
    expect(tester.getTopLeft(anchor).dy, closeTo(top, 1));
  });

  testWidgets('목록이 비었다 다시 채워지는 리로드는 위로 올려 둔 위치에서 맨 아래로 끌지 않는다', (tester) async {
    late _HarnessState h;
    await tester.pumpWidget(_Harness(onState: (s) => h = s));
    await tester.pumpAndSettle();
    h.hasEarlier = false;
    final position = _position(tester);
    // 사용자가 손으로 중간까지 올림
    final gesture = await tester.startGesture(const Offset(200, 300));
    await gesture.moveBy(const Offset(0, 400));
    await gesture.up();
    await tester.pumpAndSettle();
    final before = position.pixels;
    expect(before, lessThan(position.maxScrollExtent - 200));

    h.setState(() {
      h.transcript = const [];
      h.loading = true;
    });
    await tester.pump();
    h.setState(() {
      h.transcript = _items(100, 140);
      h.loading = false;
    });
    await tester.pumpAndSettle();
    expect(
      _position(tester).pixels,
      lessThan(_position(tester).maxScrollExtent - 200),
    );
  });
}
