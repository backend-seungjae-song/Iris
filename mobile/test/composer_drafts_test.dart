import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/composer.dart';
import 'package:iris_remote/state/remote_state.dart';

import 'design_fixture.dart';

// 선택한 요소가 입력창에 여러 개 붙어도 위쪽 화면 영역을 밀어내지 않아야 한다
void main() {
  testWidgets('첨부가 많아도 입력창은 상한 높이에서 멈추고 첨부는 안에서 스크롤한다', (tester) async {
    tester.view.physicalSize = const Size(360, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    final drafts = [
      for (var i = 0; i < 14; i++)
        ComposerDraft(
          ref: 'd$i',
          kind: 'element',
          summary: '요소 $i · button.checkout-primary',
          content: '<button>$i</button>',
        ),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: designTestTheme(Brightness.dark),
        home: Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox.expand(key: Key('frame'))),
              IrisComposer(
                controller: controller,
                drafts: drafts,
                sending: false,
                stopping: false,
                working: false,
                workingLabel: '',
                onSend: () {},
                includeBottomInset: false,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    final composer = tester.getSize(find.byKey(const Key('session-composer')));
    final frame = tester.getSize(find.byKey(const Key('frame')));
    expect(composer.height, lessThanOrEqualTo(180));
    expect(frame.height, greaterThan(500));
  });
}
