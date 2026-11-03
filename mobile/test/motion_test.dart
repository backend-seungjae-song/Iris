import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/terminal_chrome.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/screens/response_kit.dart';

import 'design_fixture.dart';

// 가장 가까운 FadeTransition 의 현재 불투명도
double fadeOf(WidgetTester tester, Finder target) => tester
    .widget<FadeTransition>(
      find.ancestor(of: target, matching: find.byType(FadeTransition)).first,
    )
    .opacity
    .value;

// OS 동작 줄이기가 켜진 상태에서도 모션이 실행되는지 함께 확인
Future<void> pumpApp(WidgetTester tester, Widget child) => tester.pumpWidget(
  MaterialApp(
    theme: designTestTheme(Brightness.dark),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: true),
      child: child!,
    ),
    home: Scaffold(body: child),
  ),
);

Color? segmentColor(WidgetTester tester, int index) {
  final box = tester
      .widgetList<Container>(
        find.descendant(
          of: find.byType(ResponseProgress),
          matching: find.byType(Container),
        ),
      )
      .elementAt(index);
  return (box.decoration as BoxDecoration).color;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadDesignReferenceFont);

  testWidgets('선택지 카드: 선택하면 테두리와 배경이 140ms 동안 바뀐다', (tester) async {
    Widget option(bool selected) => ResponseOption(
      key: const Key('opt'),
      title: '가',
      selected: selected,
      onTap: () {},
    );
    BoxDecoration? fore() => tester
        .widgetList<Container>(
          find.descendant(
            of: find.byKey(const Key('opt')),
            matching: find.byType(Container),
          ),
        )
        .map((c) => c.foregroundDecoration)
        .whereType<BoxDecoration>()
        .first;
    await pumpApp(tester, option(false));
    final colors = tester.element(find.byKey(const Key('opt'))).iris;
    final before = (fore()!.border! as Border).top.color;
    expect(before, colors.line2);
    await pumpApp(tester, option(true));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final mid = (fore()!.border! as Border).top.color;
    expect(mid, isNot(before));
    expect(mid, isNot(colors.link));
    await tester.pump(const Duration(milliseconds: 200));
    expect((fore()!.border! as Border).top.color, colors.link);
  });

  testWidgets('진행 막대: 칸이 180ms 동안 채워진다', (tester) async {
    await pumpApp(tester, const ResponseProgress(count: 3, current: 0));
    final colors = tester.element(find.byType(ResponseProgress)).iris;
    expect(segmentColor(tester, 1), colors.level3);
    await pumpApp(tester, const ResponseProgress(count: 3, current: 1));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final mid = segmentColor(tester, 1);
    expect(mid, isNot(colors.level3));
    expect(mid, isNot(colors.link));
    await tester.pump(const Duration(milliseconds: 300));
    expect(segmentColor(tester, 1), colors.link);
  });

  testWidgets('이미 답함 화면: 진입 때 페이드', (tester) async {
    await pumpApp(
      tester,
      const SingleChildScrollView(
        child: ResponseAnswered(
          title: '답함',
          detail: '상세',
          ghost: SizedBox(height: 10),
          kindLabel: '질문',
          kindIcon: 'check-circle',
        ),
      ),
    );
    expect(fadeOf(tester, find.text('답함').first), 0);
    await tester.pump(const Duration(milliseconds: 60));
    final mid = fadeOf(tester, find.text('답함').first);
    expect(mid, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 300));
    expect(fadeOf(tester, find.text('답함').first), 1);
  });

  testWidgets('선택 대기 칩: 나타날 때 페이드', (tester) async {
    await pumpApp(tester, const TerminalDetectChip());
    await tester.pump(const Duration(milliseconds: 50));
    expect(fadeOf(tester, find.text('선택 대기 중')), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 300));
    expect(fadeOf(tester, find.text('선택 대기 중')), 1);
  });

  testWidgets('IrisEnterOnce: 처음 한 번만 실행하고 다시 만들어져도 반복하지 않는다', (tester) async {
    final shown = <String>{};
    Widget card() =>
        IrisEnterOnce(registry: shown, id: 'q1', child: const Text('카드'));
    await pumpApp(tester, card());
    await tester.pump(const Duration(milliseconds: 50));
    expect(fadeOf(tester, find.text('카드')), inExclusiveRange(0, 1));
    expect(
      tester
          .widget<Transform>(
            find
                .ancestor(of: find.text('카드'), matching: find.byType(Transform))
                .first,
          )
          .transform
          .getTranslation()
          .y,
      greaterThan(0),
    );
    await tester.pump(const Duration(milliseconds: 300));
    // 스크롤로 사라졌다 다시 만들어지는 경우
    await pumpApp(tester, const SizedBox());
    await pumpApp(tester, card());
    expect(fadeOf(tester, find.text('카드')), 1);
  });

  testWidgets('IrisPulse: 값이 바뀔 때만 커졌다 돌아온다', (tester) async {
    Widget badge(int n) => IrisPulse(value: n, child: Text('$n'));
    double scale() => tester
        .widget<ScaleTransition>(
          find
              .ancestor(
                of: find.byType(Text),
                matching: find.byType(ScaleTransition),
              )
              .first,
        )
        .scale
        .value;
    await pumpApp(tester, badge(1));
    expect(scale(), 1);
    await pumpApp(tester, badge(2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    expect(scale(), greaterThan(1.0));
    await tester.pump(const Duration(milliseconds: 300));
    expect(scale(), 1);
  });
}
