import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/select_mark.dart';
import 'package:iris_remote/design/tokens.dart';

void main() {
  unfillFlashTest();
  testWidgets('체크된 상태에서 해제 전송 중에는 채움 없이 돌림 표시만 보인다', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: const Scaffold(
          body: IrisSelectMark(selected: true, square: true, loading: true),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('select-mark-loading')), findsOneWidget);
    final box = tester.widget<Container>(find.byType(Container).first);
    final decoration = box.decoration! as BoxDecoration;
    expect(decoration.color!.a, 0);
  });
}

void unfillFlashTest() {
  testWidgets('해제 전송이 끝나 로딩이 사라져도 체크가 되살아나지 않는다', (tester) async {
    Widget mark({required bool selected, required bool loading}) => MaterialApp(
      theme: irisTheme(Brightness.dark),
      home: Scaffold(
        body: IrisSelectMark(selected: selected, square: true, loading: loading),
      ),
    );
    await tester.pumpWidget(mark(selected: true, loading: false));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(mark(selected: true, loading: true));
    await tester.pump(const Duration(milliseconds: 300));
    // 새 상태(해제)가 와서 로딩이 끝난 첫 프레임에 채움이 남아 있으면 안 됨
    await tester.pumpWidget(mark(selected: false, loading: false));
    await tester.pump(const Duration(milliseconds: 20));
    final box = tester.widget<Container>(find.byType(Container).first);
    expect((box.decoration! as BoxDecoration).color!.a, 0);
  });
}
