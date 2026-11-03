import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/card.dart';
import 'package:iris_remote/design/section_header.dart';
import 'package:iris_remote/design/segmented.dart';
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';

Widget _app(Widget child, {Brightness brightness = Brightness.dark}) {
  return MaterialApp(
    theme: irisTheme(brightness),
    home: Scaffold(
      body: Align(alignment: Alignment.bottomCenter, child: child),
    ),
  );
}

void main() {
  testWidgets('버튼은 높이 48 알약이고 비활성 주색은 surface2 에 text3', (tester) async {
    await tester.pumpWidget(
      _app(
        Row(
          children: [
            IrisButton(
              label: '보내기',
              onPressed: null,
              tone: IrisButtonTone.primary,
            ),
          ],
        ),
      ),
    );
    expect(tester.getSize(find.byType(TextButton)).height, 48);
    final style = tester.widget<TextButton>(find.byType(TextButton)).style!;
    expect(style.backgroundColor!.resolve({}), IrisColors.dark.level2);
    expect(style.foregroundColor!.resolve({}), IrisColors.dark.muted);
  });

  testWidgets('동작 막대는 주 버튼이 남는 폭을 차지하고 하단 영역을 더한다', (tester) async {
    tester.view.physicalSize = const Size(412, 892);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(412, 892),
            padding: EdgeInsets.only(bottom: 20),
          ),
          child: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: IrisActionBar(
                buttons: [
                  IrisButton(
                    label: '홈으로',
                    onPressed: () {},
                    tone: IrisButtonTone.ghost,
                  ),
                  IrisButton(
                    label: '다음 질문',
                    onPressed: () {},
                    tone: IrisButtonTone.primary,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    final bar = tester.getRect(find.byType(IrisActionBar));
    // 위 12 + 버튼 48 + 아래 10 + 하단 영역 20
    expect(bar.height, 12 + 48 + 10 + 20);
    final primary = tester.getRect(find.widgetWithText(TextButton, '다음 질문'));
    expect(primary.right, 412 - 16);
    final ghost = tester.getRect(find.widgetWithText(TextButton, '홈으로'));
    expect(ghost.width, lessThan(primary.width));
    expect(primary.left - ghost.right, 8);
  });

  testWidgets('상태칩은 높이 22이고 기본 글자를 가진다', (tester) async {
    for (final status in IrisStatus.values) {
      await tester.pumpWidget(
        _app(IrisStatusChip(status, label: '라벨', animate: false)),
      );
      expect(tester.getSize(find.byType(IrisStatusChip)).height, 22);
    }
    await tester.pumpWidget(_app(const IrisStatusChip(IrisStatus.q)));
    expect(find.text('질문 있음'), findsOneWidget);
    final container = tester.widget<Container>(
      find.descendant(
        of: find.byType(IrisStatusChip),
        matching: find.byType(Container),
      ),
    );
    expect(
      (container.decoration as BoxDecoration).color,
      IrisColors.dark.yellow,
    );
    // 반복 애니메이션 정리
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('섹션 헤더·카드·세그먼트 치수', (tester) async {
    var picked = 'a';
    await tester.pumpWidget(
      _app(
        StatefulBuilder(
          builder: (context, set) => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const IrisSectionHeader('세션', count: 3),
              const IrisCard(child: SizedBox(height: 20, width: 50)),
              IrisSegmented<String>(
                segments: const [
                  IrisSegment(value: 'a', label: '가'),
                  IrisSegment(value: 'b', label: '나', count: 2),
                ],
                value: picked,
                onChanged: (v) => set(() => picked = v),
              ),
            ],
          ),
        ),
      ),
    );
    expect(tester.getSize(find.byType(IrisSectionHeader)).height, 44);
    expect(tester.getTopLeft(find.text('세션')).dx, 20);
    expect(tester.getSize(find.byType(IrisSegmented<String>)).height, 38 + 6);
    await tester.tap(find.text('나'));
    await tester.pump();
    expect(picked, 'b');
  });

  testWidgets('토스트는 표시되고 시간이 지나면 사라진다', (tester) async {
    late BuildContext captured;
    await tester.pumpWidget(
      _app(
        Builder(
          builder: (context) {
            captured = context;
            return const SizedBox();
          },
        ),
      ),
    );
    showIrisToast(captured, '에이전트에게 보냈습니다');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('에이전트에게 보냈습니다'), findsOneWidget);
    final box = tester.getRect(find.byKey(const Key('iris-toast')));
    expect(box.left, 16);
    final live = find.ancestor(
      of: find.byKey(const Key('iris-toast')),
      matching: find.byType(Semantics),
    );
    expect(
      tester
          .widgetList<Semantics>(live)
          .any((w) => w.properties.liveRegion == true),
      isTrue,
    );
    await tester.pump(const Duration(milliseconds: 2200));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('에이전트에게 보냈습니다'), findsNothing);
  });
}
