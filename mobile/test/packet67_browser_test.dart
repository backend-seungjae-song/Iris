import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/browser_gestures.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

const tab =
    'a'
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const space = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

class Wire implements RemoteConnection {
  final incoming = StreamController<String>();
  late final iterator = StreamIterator(incoming.stream);
  final sent = <Map<String, Object>>[];
  final closedSignal = Completer<void>();
  bool failReload = false;
  bool delayReload = false;
  bool holdWheels = false;
  bool silent = false;
  int seq = 0;
  void emit(Map<String, Object?> value) => incoming.add(jsonEncode(value));
  void frame() => emit({
    'type': 'browser.frame',
    'tab': tab,
    'seq': ++seq,
    'width': 800,
    'height': 600,
    'jpeg': '/9j/2Q==',
  });
  @override
  void sendJson(Map<String, Object> value) {
    sent.add(value);
    final rid = value['rid'];
    switch (value['type']) {
      case 'browser.tabs':
        emit({
          'type': 'browser.tabs.result',
          'rid': rid,
          'spaces': [
            {'ref': space, 'name': '하나'},
          ],
          'tabs': [
            {
              'ref': tab,
              'space': space,
              'title': '페이지',
              'url': 'https://example.test',
              'profile': '기본',
              'aiControlled': false,
              'controlling': [],
              'active': true,
              'sleeping': false,
            },
          ],
        });
      case 'browser.frame.watch':
      case 'browser.frame.fast':
        emit({
          'type': 'browser.frame.watch.result',
          'rid': rid,
          'tab': tab,
          'watching': true,
        });
        if (!silent) frame();
      case 'browser.history':
        if (!delayReload) {
          emit(
            failReload
                ? {
                    'type': 'error',
                    'rid': rid,
                    'error': {'code': 'browser-command-unavailable'},
                  }
                : {
                    'type': 'remote.action.result',
                    'rid': rid,
                    'result': 'done',
                  },
          );
          if (!failReload) frame();
        }
      case 'browser.wheel':
      case 'browser.mouse':
      case 'browser.scroll':
        if (!holdWheels)
          emit({'type': 'remote.action.result', 'rid': rid, 'result': 'done'});
    }
  }

  @override
  Future<String> receive() async {
    if (!await iterator.moveNext()) throw StateError('closed');
    return iterator.current;
  }

  @override
  Future<void> close() async {
    if (!closedSignal.isCompleted) closedSignal.complete();
    unawaited(incoming.close());
  }

  @override
  Future<void> get closed => closedSignal.future;
}

// 테스트 중간에 키보드를 올리고 내리는 값
final keyboardInset = ValueNotifier<double>(0);

Future<
  ({Wire wire, RemoteState state, ActiveRemoteSession session, ui.Image image})
>
pumpBrowser(
  WidgetTester tester, {
  bool fast = true,
  double keyboard = 0,
  bool silent = false,
  bool sketch = false,
}) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 3;
  final wire = Wire()..silent = silent;
  final session = ActiveRemoteSession.attach(
    connection: wire,
    pingInterval: const Duration(days: 1),
    capabilities: [
      'browser.tabs',
      'browser.frame.watch',
      'browser.pointer',
      'browser.mouse',
      'browser.scroll',
      'browser.history',
      if (sketch) 'browser.sketch.send',
      if (fast) ...['browser.frame.fast', 'browser.wheel'],
    ],
  );
  final state = RemoteState(session);
  await state.refreshBrowserTabs();
  final recorder = ui.PictureRecorder();
  Canvas(recorder)
      .drawRect(const Rect.fromLTWH(0, 0, 8, 6), Paint()..color = Colors.white);
  final image = recorder.endRecording().toImageSync(8, 6);
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData(extensions: [IrisColors.dark]),
      builder: (context, child) => ValueListenableBuilder<double>(
        valueListenable: keyboardInset,
        builder: (context, inset, _) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            padding: const EdgeInsets.only(top: 64, bottom: 48),
            viewPadding: const EdgeInsets.only(top: 64, bottom: 48),
            viewInsets: EdgeInsets.only(bottom: keyboard + inset),
          ),
          child: child!,
        ),
      ),
      home: BrowserScreen(
        state: state,
        agentRef: space,
        tabRef: tab,
        frameImage: image,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  return (wire: wire, state: state, session: session, image: image);
}

Future<void> finish(WidgetTester tester, dynamic f) async {
  keyboardInset.value = 0;
  await tester.pumpWidget(const SizedBox());
  f.state.dispose();
  await f.session.disconnect();
  f.image.dispose();
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}

Future<void> enableSketch(WidgetTester tester, dynamic f) async {
  await f.state.initialize();
  f.wire.emit({
    'type': 'agents',
    'agents': [
      {
        'ref': space,
        'name': '작업',
        'kind': 'claude',
        'status': 'idle',
        'question': false,
        'space': 'iris',
        'spaceRef': space,
        'spaceOrder': 0,
        'sessionOrder': 0,
        'parent': null,
        'lastActivityAt': 1790000000000,
        'can': {'stop': false, 'message': true},
      },
    ],
  });
  await tester.pump(const Duration(milliseconds: 50));
  await tester.tap(find.byKey(const Key('browser-tool-sketch')));
  await tester.pump();
}

List<Map<String, Object>> wheels(Wire wire) => wire.sent
    .where(
      (v) =>
          v['type'] == 'browser.wheel' ||
          v['type'] == 'browser.scroll' ||
          v['type'] == 'browser.mouse' && v['action'] == 'wheel',
    )
    .toList();

void main() {
  test('packet67 핀치·스크롤 경계와 관성 감속', () {
    expect(
      classifyBrowserGesture(distanceChange: 5.99, centerMove: 0),
      BrowserGesture.pending,
    );
    expect(
      classifyBrowserGesture(distanceChange: 6, centerMove: 0),
      BrowserGesture.pinch,
    );
    expect(
      classifyBrowserGesture(distanceChange: 14.99, centerMove: 10),
      BrowserGesture.scroll,
    );
    expect(
      classifyBrowserGesture(distanceChange: 15, centerMove: 10),
      BrowserGesture.pinch,
    );
    expect(
      classifyBrowserGesture(distanceChange: 6, centerMove: 80),
      BrowserGesture.scroll,
    );
    final first = browserInertiaVelocity(const Offset(100, -200), .1);
    final second = browserInertiaVelocity(first, .1);
    expect(first.dx, closeTo(60.65, .01));
    expect(second.distance, lessThan(first.distance));
    expect(second.dy, lessThan(0));
  });
  test('같은 방향으로 움직이는 두 손가락은 간격이 변해도 스크롤이다', () {
    expect(
      classifyBrowserGesture(distanceChange: 12, centerMove: 6, travel: 0.9),
      BrowserGesture.scroll,
    );
    expect(
      classifyBrowserGesture(distanceChange: 12, centerMove: 6),
      BrowserGesture.pinch,
    );
    expect(
      classifyBrowserGesture(distanceChange: 12, centerMove: 2, travel: -0.9),
      BrowserGesture.pinch,
    );
    expect(
      classifyBrowserGesture(distanceChange: 8, centerMove: 4, travel: 0.1),
      BrowserGesture.pending,
    );
    expect(
      browserTravelCosine(const Offset(0, -10), const Offset(2, -12)),
      greaterThan(0.9),
    );
    expect(
      browserTravelCosine(const Offset(-10, 0), const Offset(10, 0)),
      closeTo(-1, 1e-9),
    );
    expect(browserTravelCosine(const Offset(0, -10), Offset.zero), isNull);
  });
  testWidgets('두 손가락이 같은 방향으로 끌리면 확대하지 않고 휠을 보낸다', (tester) async {
    final f = await pumpBrowser(tester);
    final surface = tester.getRect(find.byKey(const Key('browser-frame')));
    final one = await tester.startGesture(
      surface.center - const Offset(30, 0),
      pointer: 1,
    );
    final two = await tester.startGesture(
      surface.center + const Offset(30, 0),
      pointer: 2,
    );
    await tester.pump();
    final watchesBefore = f.wire.sent
        .where((v) => v['type'] == 'browser.frame.fast')
        .length;
    // 손가락 하나가 먼저, 더 빨리 움직여 간격이 변한다
    await one.moveBy(const Offset(-9, -30));
    await two.moveBy(const Offset(-2, -14));
    await one.moveBy(const Offset(-3, -20));
    await two.moveBy(const Offset(-1, -18));
    await tester.pump(const Duration(milliseconds: 200));
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 400));
    expect(wheels(f.wire), isNotEmpty);
    expect(
      f.wire.sent.where((v) => v['type'] == 'browser.frame.fast').length,
      watchesBefore,
    );
    await finish(tester, f);
  });
  for (final keyboard in [0.0, 300.0]) {
    testWidgets('packet67 1080×2340·큰 상단 inset·키보드 $keyboard 프레임 가운데 고정', (
      tester,
    ) async {
      final f = await pumpBrowser(tester, keyboard: keyboard);
      final surface = tester.getRect(find.byKey(const Key('browser-frame')));
      final image = tester.getRect(
        find.byKey(const Key('browser-frame-image')),
      );
      expect(image.center.dx, closeTo(surface.center.dx, .01));
      expect(image.center.dy, closeTo(surface.center.dy, .01));
      expect(image.top, greaterThanOrEqualTo(64));
      expect(image.bottom, lessThanOrEqualTo(surface.bottom + .01));
      expect(tester.takeException(), isNull);
      await finish(tester, f);
    });
  }
  testWidgets('packet67 스케치 모드는 하단 여백에서 넘치지 않고 뒤로가기로 모드만 꺼진다', (tester) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    expect(find.byKey(const Key('browser-sketch-controls')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.byKey(const Key('browser-sketch-controls')), findsNothing);
    expect(find.byKey(const Key('browser-frame')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await finish(tester, f);
  });
  testWidgets('packet67 스케치 모드 한 손가락은 선만 긋고 컴퓨터로 아무것도 보내지 않는다', (tester) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    final sentBefore = f.wire.sent.length;
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    final g = await tester.startGesture(center);
    await g.moveBy(
      const Offset(40, 30),
      timeStamp: const Duration(milliseconds: 20),
    );
    await g.moveBy(
      const Offset(30, -10),
      timeStamp: const Duration(milliseconds: 40),
    );
    await g.up();
    await tester.pump(const Duration(milliseconds: 200));
    expect(f.wire.sent.length, sentBefore);
    expect(wheels(f.wire), isEmpty);
    expect(tester.takeException(), isNull);
    await finish(tester, f);
  });
  testWidgets('packet67 스케치 모드 두 손가락은 확대와 화면 이동만 하고 스크롤은 막힌다', (tester) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    var one = await tester.startGesture(
      center - const Offset(30, 0),
      pointer: 11,
    );
    var two = await tester.startGesture(
      center + const Offset(30, 0),
      pointer: 12,
    );
    await one.moveBy(
      const Offset(-60, 0),
      timeStamp: const Duration(milliseconds: 20),
    );
    await two.moveBy(
      const Offset(60, 0),
      timeStamp: const Duration(milliseconds: 20),
    );
    await tester.pump();
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const Key('browser-zoom-chip')), findsOneWidget);
    final zoomed = tester.getTopLeft(
      find.byKey(const Key('browser-frame-image')),
    );
    one = await tester.startGesture(center - const Offset(25, 0), pointer: 13);
    two = await tester.startGesture(center + const Offset(25, 0), pointer: 14);
    await one.moveBy(
      const Offset(0, -40),
      timeStamp: const Duration(milliseconds: 20),
    );
    await two.moveBy(
      const Offset(0, -40),
      timeStamp: const Duration(milliseconds: 20),
    );
    await tester.pump();
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-frame-image'))).dy,
      lessThan(zoomed.dy),
    );
    expect(wheels(f.wire), isEmpty);
    await finish(tester, f);
  });
  testWidgets('packet67 스케치 모드는 확대해서 그려도 확대 전 화면 기준 그림을 보낸다', (tester) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    final one = await tester.startGesture(
      center - const Offset(30, 0),
      pointer: 21,
    );
    final two = await tester.startGesture(
      center + const Offset(30, 0),
      pointer: 22,
    );
    await one.moveBy(
      const Offset(-60, 0),
      timeStamp: const Duration(milliseconds: 20),
    );
    await two.moveBy(
      const Offset(60, 0),
      timeStamp: const Duration(milliseconds: 20),
    );
    await tester.pump();
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 200));
    final pen = await tester.startGesture(center);
    await pen.moveBy(
      const Offset(30, 20),
      timeStamp: const Duration(milliseconds: 20),
    );
    await pen.up();
    await tester.pump();
    await tester.enterText(find.byKey(const Key('browser-sketch-input')), '여기');
    await tester.tap(
      find.descendant(
        of: find.byKey(const Key('browser-sketch-composer')),
        matching: find.byType(IrisRoundButton),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
    await tester.pump(const Duration(milliseconds: 300));
    final sent = f.wire.sent.where((v) => v['type'] == 'browser.sketch.send');
    expect(sent, hasLength(1));
    expect(
      (sent.single['image'] as String).startsWith('data:image/png;base64,'),
      isTrue,
    );
    expect(tester.takeException(), isNull);
    await finish(tester, f);
  });
  testWidgets('packet67 스케치 모드 스크롤 버튼은 작은 단위로 나눠 부드럽게 움직이고 길게 누르면 이어진다', (
    tester,
  ) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    await tester.tap(find.byKey(const Key('browser-sketch-scroll-down')));
    await tester.pump(const Duration(milliseconds: 400));
    final tap = wheels(f.wire);
    expect(tap.length, greaterThanOrEqualTo(5));
    expect(tap.every((v) => (v['dy']! as int) > 0), isTrue);
    // 한 번에 화면 높이(600)의 25% 안쪽
    final total = tap.fold<int>(0, (sum, v) => sum + (v['dy']! as int));
    expect(total, lessThanOrEqualTo(600 * 0.3));
    await tester.tap(find.byKey(const Key('browser-sketch-scroll-up')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(wheels(f.wire).last['dy'], lessThan(0));
    final before = wheels(f.wire).length;
    final hold = await tester.startGesture(
      tester.getCenter(find.byKey(const Key('browser-sketch-scroll-down'))),
    );
    await tester.pump(const Duration(milliseconds: 700));
    final during = wheels(f.wire).length;
    expect(during, greaterThan(before + 3));
    await hold.up();
    await tester.pump(const Duration(milliseconds: 100));
    final after = wheels(f.wire).length;
    await tester.pump(const Duration(milliseconds: 300));
    expect(wheels(f.wire).length, after);
    await finish(tester, f);
  });
  testWidgets('packet67 스케치 모드는 키보드가 올라와도 화면 크기가 그대로다', (tester) async {
    final f = await pumpBrowser(tester, sketch: true);
    await enableSketch(tester, f);
    final before = tester.getRect(find.byKey(const Key('browser-frame-image')));
    keyboardInset.value = 600;
    await tester.pump();
    expect(
      tester.getRect(find.byKey(const Key('browser-frame-image'))),
      before,
    );
    // 입력줄은 키보드 위로 올라와 가려지지 않음
    final keyboardTop = tester.view.physicalSize.height / 3 - 600;
    expect(
      tester.getRect(find.byKey(const Key('browser-sketch-input'))).bottom,
      lessThanOrEqualTo(keyboardTop),
    );
    expect(tester.takeException(), isNull);
    await finish(tester, f);
  });
  testWidgets('packet67 주소줄 새로고침 로딩·성공·사유 표시', (tester) async {
    final f = await pumpBrowser(tester);
    expect(
      f.wire.sent.any(
        (v) => v['type'] == 'browser.frame.fast' && v['fps'] == 20,
      ),
      isTrue,
    );
    f.wire.delayReload = true;
    await tester.tap(find.byKey(const Key('browser-reload')));
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('browser-reload')))
          .onPressed,
      isNull,
    );
    final request = f.wire.sent.lastWhere(
      (v) => v['type'] == 'browser.history',
    );
    f.wire.emit({
      'type': 'remote.action.result',
      'rid': request['rid'],
      'result': 'done',
    });
    f.wire.frame();
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('browser-reload')))
          .onPressed,
      isNotNull,
    );
    f.wire.delayReload = false;
    f.wire.failReload = true;
    await tester.tap(find.byKey(const Key('browser-reload')));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(find.textContaining('조작'), findsWidgets);
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('browser-reload')))
          .onPressed,
      isNotNull,
    );
    await finish(tester, f);
  });
  testWidgets('두 손가락으로 짧게 대면 우클릭을 보내고 끌면 보내지 않는다', (tester) async {
    final f = await pumpBrowser(tester);
    final surface = tester.getRect(find.byKey(const Key('browser-frame')));
    List<Map<String, Object>> contexts() => f.wire.sent
        .where((v) => v['type'] == 'browser.mouse' && v['action'] == 'context')
        .toList();

    final one = await tester.startGesture(
      surface.center - const Offset(30, 0),
      pointer: 1,
    );
    final two = await tester.startGesture(
      surface.center + const Offset(30, 0),
      pointer: 2,
    );
    await tester.pump(const Duration(milliseconds: 80));
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 400));
    expect(contexts(), hasLength(1));

    final three = await tester.startGesture(
      surface.center - const Offset(30, 0),
      pointer: 3,
    );
    final four = await tester.startGesture(
      surface.center + const Offset(30, 0),
      pointer: 4,
    );
    await tester.pump();
    await three.moveBy(const Offset(0, -40));
    await four.moveBy(const Offset(0, -40));
    await tester.pump(const Duration(milliseconds: 80));
    await three.up();
    await four.up();
    await tester.pump(const Duration(milliseconds: 400));
    expect(contexts(), hasLength(1));
    await finish(tester, f);
  });
  testWidgets('packet67 스크롤 중 폰 화면은 움직이지 않고 컴퓨터로 휠만 보냄·가로 휠 합침·관성', (
    tester,
  ) async {
    final f = await pumpBrowser(tester);
    final surface = tester.getRect(find.byKey(const Key('browser-frame')));
    final initial = tester.getTopLeft(
      find.byKey(const Key('browser-frame-image')),
    );
    final one = await tester.startGesture(
      surface.center - const Offset(30, 0),
      pointer: 1,
    );
    final two = await tester.startGesture(
      surface.center + const Offset(30, 0),
      pointer: 2,
    );
    await tester.pump();
    expect(find.byKey(const Key('browser-touch-feedback')), findsOneWidget);
    await one.moveBy(
      const Offset(-10, -20),
      timeStamp: const Duration(milliseconds: 20),
    );
    await two.moveBy(
      const Offset(-10, -20),
      timeStamp: const Duration(milliseconds: 20),
    );
    await tester.pump();
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-frame-image'))),
      initial,
    );
    await tester.pump(const Duration(milliseconds: 150));
    expect(wheels(f.wire), hasLength(1));
    expect(wheels(f.wire).single['dx'], greaterThan(0));
    expect(wheels(f.wire).single['dy'], greaterThan(0));
    f.wire.frame();
    await tester.pump();
    await tester.pump();
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-frame-image'))),
      initial,
    );
    for (var n = 1; n <= 10; n++) {
      await one.moveBy(
        const Offset(0, -3),
        timeStamp: Duration(milliseconds: 20 + n * 20),
      );
      await two.moveBy(
        const Offset(0, -3),
        timeStamp: Duration(milliseconds: 20 + n * 20),
      );
      await tester.pump(const Duration(milliseconds: 20));
    }
    await one.up();
    await two.up();
    await tester.pump();
    final beforeInertia = wheels(f.wire).length;
    await tester.pump(const Duration(milliseconds: 80));
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-frame-image'))),
      initial,
    );
    await tester.pump(const Duration(milliseconds: 1000));
    expect(wheels(f.wire).length, greaterThan(beforeInertia));
    expect(wheels(f.wire).length, lessThanOrEqualTo(36));
    await finish(tester, f);
  });
  testWidgets('packet67 확대 후 평행 이동은 추가 확대 없이 페이지 스크롤', (tester) async {
    final f = await pumpBrowser(tester);
    final center = tester.getCenter(find.byKey(const Key('browser-frame')));
    var one = await tester.startGesture(
      center - const Offset(25, 0),
      pointer: 1,
    );
    var two = await tester.startGesture(
      center + const Offset(25, 0),
      pointer: 2,
    );
    await one.moveBy(const Offset(-25, 0));
    await two.moveBy(const Offset(25, 0));
    await tester.pump();
    await one.up();
    await two.up();
    await tester.pump(const Duration(milliseconds: 200));
    final watches = f.wire.sent
        .where((v) => v['type'] == 'browser.frame.fast')
        .length;
    final width = tester
        .getSize(find.byKey(const Key('browser-frame-image')))
        .width;
    one = await tester.startGesture(center - const Offset(25, 0), pointer: 3);
    two = await tester.startGesture(center + const Offset(25, 0), pointer: 4);
    await one.moveBy(
      const Offset(0, -25),
      timeStamp: const Duration(milliseconds: 20),
    );
    await two.moveBy(
      const Offset(0, -23),
      timeStamp: const Duration(milliseconds: 20),
    );
    final zoomedTopLeft = tester.getTopLeft(
      find.byKey(const Key('browser-frame-image')),
    );
    await tester.pump(const Duration(milliseconds: 160));
    expect(wheels(f.wire), isNotEmpty);
    // 두 손가락 스크롤은 컴퓨터 페이지만 움직이고 폰 쪽 보이는 영역은 그대로
    expect(
      tester.getTopLeft(find.byKey(const Key('browser-frame-image'))),
      zoomedTopLeft,
    );
    expect(
      tester.getSize(find.byKey(const Key('browser-frame-image'))).width,
      width,
    );
    expect(
      f.wire.sent.where((v) => v['type'] == 'browser.frame.fast').length,
      watches,
    );
    await one.cancel();
    await two.cancel();
    await finish(tester, f);
  });
  testWidgets('packet67 이전 서버는 기본 구독·세로 휠 유지, 실패 상태 뒤 프레임 복구', (tester) async {
    final f = await pumpBrowser(tester, fast: false);
    expect(
      f.wire.sent.any(
        (v) => v['type'] == 'browser.frame.watch' && v['fps'] == 2,
      ),
      isTrue,
    );
    f.wire.emit({
      'type': 'browser.frame.status',
      'tab': tab,
      'error': 'browser-tab-unavailable',
    });
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('탭을 깨우지'), findsOneWidget);
    f.wire.frame();
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('탭을 깨우지'), findsNothing);
    await finish(tester, f);
  });
  testWidgets('화면을 못 받으면 오류 화면과 대기 카드를 보이고 다시 시도가 구독을 다시 요청', (tester) async {
    final f = await pumpBrowser(tester, silent: true);
    f.wire.emit({
      'type': 'browser.frame.status',
      'tab': tab,
      'error': 'browser-tab-unavailable',
    });
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('browser-error-view')), findsOneWidget);
    expect(find.text('화면을 불러오지 못했습니다'), findsOneWidget);
    expect(find.textContaining('탭을 깨우지'), findsOneWidget);
    expect(find.text('browser-tab-unavailable'), findsOneWidget);
    expect(find.byKey(const Key('browser-frame-notice')), findsOneWidget);
    expect(find.text('Mac 화면을 기다리는 중'), findsOneWidget);
    await tester.tap(find.byKey(const Key('browser-error-address')));
    await tester.pump();
    expect(
      tester
          .widget<TextField>(
            find.descendant(
              of: find.byKey(const Key('browser-address')),
              matching: find.byType(TextField),
            ),
          )
          .focusNode!
          .hasFocus,
      isTrue,
    );
    final before = f.wire.sent
        .where((v) => v['type'] == 'browser.frame.fast')
        .length;
    await tester.tap(find.byKey(const Key('browser-error-retry')));
    await tester.pump();
    expect(
      f.wire.sent.where((v) => v['type'] == 'browser.frame.fast').length,
      before + 1,
    );
    f.wire.frame();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('browser-error-view')), findsNothing);
    expect(find.byKey(const Key('browser-frame-notice')), findsNothing);
    await finish(tester, f);
  });
  testWidgets('프레임이 있는 채 오류가 나면 화면은 남기고 띠만 보인다', (tester) async {
    final f = await pumpBrowser(tester);
    f.wire.emit({
      'type': 'browser.frame.status',
      'tab': tab,
      'error': 'browser-controller-unavailable',
    });
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('browser-error-view')), findsNothing);
    expect(find.byKey(const Key('browser-frame-image')), findsOneWidget);
    expect(find.byKey(const Key('browser-frame-notice')), findsOneWidget);
    expect(find.textContaining('브라우저 연결을 기다리고'), findsOneWidget);
    await finish(tester, f);
  });
  testWidgets('탭 줄은 맨 위, 주소 줄은 그 아래, 커서는 항상 보인다', (tester) async {
    final f = await pumpBrowser(tester);
    final strip = tester.getRect(find.byKey(const Key('session-tabs')));
    final address = tester.getRect(
      find.byKey(const Key('browser-address-area')),
    );
    final frame = tester.getRect(find.byKey(const Key('browser-frame')));
    expect(strip.bottom, lessThanOrEqualTo(address.top + .01));
    expect(address.bottom, lessThanOrEqualTo(frame.top + .01));
    expect(find.byKey(const Key('session-browser-tab-$tab')), findsOneWidget);
    expect(find.byKey(const Key('browser-cursor')), findsOneWidget);
    expect(find.byKey(const Key('browser-terminal')), findsNothing);
    await finish(tester, f);
  });

  testWidgets('모션: 오류 화면은 나타날 때 페이드', (tester) async {
    final f = await pumpBrowser(tester, silent: true);
    f.wire.emit({
      'type': 'browser.frame.status',
      'tab': tab,
      'error': 'browser-tab-unavailable',
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final view = find.byKey(const Key('browser-error-view'));
    final opacity = tester
        .widget<FadeTransition>(
          find.ancestor(of: view, matching: find.byType(FadeTransition)).first,
        )
        .opacity
        .value;
    expect(opacity, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      tester
          .widget<FadeTransition>(
            find
                .ancestor(of: view, matching: find.byType(FadeTransition))
                .first,
          )
          .opacity
          .value,
      1,
    );
    await finish(tester, f);
  });
}
