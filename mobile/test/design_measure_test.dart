import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/tokens.dart';

import 'design_fixture.dart';

const _screenSize = Size(394, 854);
const _safeTop = 54.0;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, dynamic> darkMeasure;
  late Map<String, dynamic> lightMeasure;

  setUpAll(() async {
    await loadDesignReferenceFont();
    darkMeasure = jsonDecode(
      await File('test/design_ref/dark-measure.json').readAsString(),
    ) as Map<String, dynamic>;
    lightMeasure = jsonDecode(
      await File('test/design_ref/light-measure.json').readAsString(),
    ) as Map<String, dynamic>;
  });

  test('다크·라이트 치수표의 좌표와 크기가 같다', () {
    for (final screen in darkMeasure.keys) {
      final darkRows =
          (darkMeasure[screen] as Map<String, dynamic>)['rows']
              as List<dynamic>;
      final lightRows =
          (lightMeasure[screen] as Map<String, dynamic>)['rows']
              as List<dynamic>;
      expect(lightRows.length, darkRows.length, reason: screen);
      for (var index = 0; index < darkRows.length; index++) {
        final dark = darkRows[index] as Map<String, dynamic>;
        final light = lightRows[index] as Map<String, dynamic>;
        for (final field in const ['x', 'y', 'w', 'h']) {
          expect(light[field], dark[field], reason: '$screen[$index].$field');
        }
      }
    }
  });

  group('치수표 대조', () {
    testWidgets('H 주요 요소', (tester) async {
      await _pump(tester, designHome());
      final rows = _ReferenceRows(darkMeasure, 'sH');
      _expectRect(tester, 'home-header', rows.one(cls: 'hdr'));
      _expectRect(
        tester,
        'home-title',
        rows.one(tag: 'h1', text: '에이전트'),
        ignoreWidth: true,
      );
      _expectRect(tester, 'home-connection', rows.one(cls: 'dev'));
      _expectRect(tester, 'home-live-dot', rows.one(cls: 'live'));
      _expectRect(
        tester,
        'home-needed-header',
        rows.one(cls: 'sec', startsWith: '답이 필요함'),
      );
      _expectRect(tester, 'home-needed-count', rows.one(cls: 'n hot'));
      _expectRect(
        tester,
        'home-agent-tile-$permissionRequestRef',
        rows.one(cls: 'tile '),
      );
      _expectRect(
        tester,
        'home-status-$permissionRequestRef',
        rows.one(cls: 'dot blocked'),
      );
      _expectRect(
        tester,
        'home-agent-name-$permissionRequestRef',
        rows.one(cls: 'nm'),
        ignoreWidth: true,
      );
      _expectRect(
        tester,
        'home-agent-space-$permissionRequestRef',
        rows.one(cls: 'sub'),
        ignoreWidth: true,
      );
      _expectRect(
        tester,
        'home-agent-time-$permissionRequestRef',
        rows.one(cls: 'tm'),
        ignoreWidth: true,
      );
      _expectRect(
        tester,
        'home-request-title',
        rows.one(cls: 'what'),
        ignoreWidth: true,
      );
      _expectRect(tester, 'home-command', rows.one(cls: 'cmd'));
      _expectRect(
        tester,
        'home-allow',
        rows.one(tag: 'button', cls: 'chipbtn pri', text: '허용'),
      );
      _expectRect(
        tester,
        'home-deny',
        rows.one(tag: 'button', cls: 'chipbtn no', text: '거절'),
      );
      _expectRect(
        tester,
        'home-open',
        rows.one(tag: 'button', cls: 'chipbtn ghost', text: '열기'),
      );
      _expectRect(
        tester,
        'home-question-title-$questionRequestRef',
        rows.one(cls: 'what', occurrence: 1),
        ignoreWidth: true,
      );
      _expectRect(
        tester,
        'home-choice-$questionRequestRef-1',
        rows.one(tag: 'button', text: '하나로 합치기'),
        ignoreWidth: true,
      );
    });

    testWidgets('Sa 주요 요소', (tester) async {
      await _pump(tester, designSession());
      final rows = _ReferenceRows(darkMeasure, 'sSa');
      _expectRect(
        tester,
        'session-header',
        const _Measure(x: 0, y: 54, w: 394, h: 98),
      );
      _expectRect(tester, 'session-back', rows.one(cls: 'gbtn'));
      _expectRect(tester, 'session-mode', rows.one(cls: 'mode'));
      _expectRect(tester, 'session-tabs', rows.one(cls: 'tabsline'));
      _expectRect(tester, 'session-user-message', rows.one(cls: 'me'));
      _expectRect(tester, 'session-tool-card', rows.one(cls: 'tcard'));
      _expectRect(tester, 'session-composer', rows.one(cls: 'dock'));
      _expectRect(tester, 'session-input', rows.one(cls: 'field'));
      _expectRect(tester, 'session-action', rows.one(cls: 'rnd stop'));
    });

    testWidgets('Sb 주요 요소', (tester) async {
      await _pump(tester, designPermissionScene());
      final rows = _ReferenceRows(darkMeasure, 'sSb');
      // 가운데 선택지를 뺀 만큼 시트 위쪽과 앞선 요소가 56px 내려감
      _expectRect(
        tester,
        'permission-sheet',
        const _Measure(x: 8, y: 510.7, w: 378, h: 335.3),
      );
      _expectRect(tester, 'permission-grabber', rows.one(cls: 'grab').dy(56));
      _expectRect(tester, 'permission-header', rows.one(cls: 'sh').dy(56));
      _expectRect(tester, 'permission-tile', rows.one(cls: 'tile sm').dy(56));
      _expectRect(tester, 'permission-title', rows.one(tag: 'h3').dy(56));
      _expectRect(tester, 'permission-command', rows.one(cls: 'cmd').dy(56));
      final options = rows.one(cls: 'opts').dy(56);
      _expectRect(
        tester,
        'permission-options',
        _Measure(x: options.x, y: options.y, w: options.w, h: 112),
      );
      _expectRect(
        tester,
        'permission-option-1',
        rows.one(cls: 'opt main').dy(56),
      );
      _expectRect(tester, 'permission-option-2', rows.one(cls: 'opt no'));
    });

    testWidgets('Sc 주요 요소', (tester) async {
      await _pump(tester, designQuestionScene());
      await tester.tap(find.byKey(const Key('question-option-first')));
      await tester.pumpAndSettle();
      final rows = _ReferenceRows(darkMeasure, 'sSc');
      _expectRect(tester, 'question-sheet', rows.one(cls: 'sheet2'));
      _expectRect(tester, 'question-grabber', rows.one(cls: 'grab'));
      _expectRect(tester, 'question-header', rows.one(cls: 'sh'));
      _expectRect(tester, 'question-tile', rows.one(cls: 'tile sm'));
      _expectRect(tester, 'question-progress', rows.one(cls: 'step'));
      _expectRect(tester, 'question-title', rows.one(tag: 'h3'));
      _expectRect(tester, 'question-note', rows.one(cls: 'note'));
      _expectRect(tester, 'question-option-first', rows.one(cls: 'qopt sq on'));
      _expectRect(tester, 'question-footer', rows.one(cls: 'foot'));
      _expectRect(tester, 'question-next', rows.one(tag: 'button', text: '다음'));
      _expectRect(tester, 'question-dots', rows.one(cls: 'dots'));
    });

    testWidgets('Sd 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designHumanScene(remote)),
      );
      final rows = _ReferenceRows(darkMeasure, 'sSd');
      _expectRect(tester, 'human-turn-scene', rows.one(cls: 'sheet2'));
      _expectRect(tester, 'human-turn-grabber', rows.one(cls: 'grab'));
      _expectRect(tester, 'human-turn-header', rows.one(cls: 'sh'));
      _expectRect(
        tester,
        'human-turn-title',
        rows.one(tag: 'h3'),
        ignoreWidth: true,
      );
      _expectRect(tester, 'human-turn-frame', rows.one(cls: 'thumb'));
    });

    testWidgets('Ba 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      final rows = _ReferenceRows(darkMeasure, 'sBa');
      _expectRect(
        tester,
        'session-header',
        const _Measure(x: 0, y: 54, w: 394, h: 98),
      );
      _expectRect(tester, 'session-mode', rows.one(cls: 'mode'));
      _expectRect(tester, 'session-tabs', rows.one(cls: 'tabsline'));
      _expectRect(tester, 'browser-address', rows.one(cls: 'urlbar'));
      _expectRect(tester, 'browser-frame', rows.one(cls: 'page'));
      _expectRect(tester, 'browser-toolbar', rows.one(cls: 'btb'));
    });

    testWidgets('Be 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      await tester.tap(find.text('스케치'));
      await tester.pumpAndSettle();
      final rows = _ReferenceRows(darkMeasure, 'sBe');
      _expectRect(tester, 'browser-frame', rows.one(cls: 'page'));
      _expectRect(tester, 'browser-pens', rows.one(cls: 'pens'));
      _expectRect(tester, 'browser-sketch-composer', rows.one(cls: 'btb'));
    });

    testWidgets('Bb 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      await tester.tap(find.text('요소 선택'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('browser-frame')));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      final sheet = _ReferenceRows(darkMeasure, 'sBb').one(cls: 'sheet2');
      _expectRect(
        tester,
        'browser-element-sheet',
        _Measure(
          x: sheet.x + 16,
          y: sheet.y + 10,
          w: sheet.w - 32,
          h: sheet.h - 34,
        ),
      );
    });

    testWidgets('Bc 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designBrowserScene(remote, human: true),
        ),
      );
      final rows = _ReferenceRows(darkMeasure, 'sBc');
      _expectRect(tester, 'browser-human-banner', rows.one(cls: 'human'));
      _expectRect(tester, 'browser-direct-controls', rows.one(cls: 'btools'));
    });

    testWidgets('Bd 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      await tester.tap(find.text('조작 기록'));
      await tester.pumpAndSettle();
      final rows = _ReferenceRows(darkMeasure, 'sBd');
      _expectRect(tester, 'browser-record-banner', rows.one(cls: 'recbar'));
      _expectRect(tester, 'browser-record-sheet', rows.one(cls: 'sheet2'));
    });

    testWidgets('Bf 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      await tester.tap(find.text('더보기'));
      await tester.pumpAndSettle();
      final sheet = _ReferenceRows(darkMeasure, 'sBf').one(cls: 'sheet2');
      _expectRect(
        tester,
        'browser-more-sheet',
        _Measure(
          x: sheet.x + 16,
          y: sheet.y + 10,
          w: sheet.w - 32,
          h: sheet.h - 34,
        ),
      );
    });

    testWidgets('Bg 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
      );
      await tester.tap(find.text('더보기'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('데스크톱 보기'));
      await tester.pumpAndSettle();
      final rows = _ReferenceRows(darkMeasure, 'sBg');
      _expectRect(tester, 'browser-address', rows.one(cls: 'urlbar'));
      _expectRect(tester, 'browser-frame', rows.one(cls: 'page'));
      _expectRect(tester, 'browser-human-banner', rows.one(cls: 'human'));
      _expectRect(tester, 'browser-toolbar', rows.one(cls: 'btb'));
    });

    testWidgets('Ta 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designTerminalScene(remote)),
      );
      final rows = _ReferenceRows(darkMeasure, 'sTa');
      _expectRect(tester, 'session-tabs', rows.one(cls: 'tabsline'));
      _expectRect(tester, 'terminal-key-row', rows.one(cls: 'kbar'));
      _expectRect(tester, 'terminal-composer', rows.one(cls: 'tdock'));
    });

    testWidgets('Tb 주요 요소', (tester) async {
      await _pump(tester, designKeySettings());
      final rows = _ReferenceRows(darkMeasure, 'sTb');
      _expectRect(
        tester,
        'key-settings-header',
        const _Measure(x: 0, y: 54, w: 394, h: 58),
      );
      _expectRect(tester, 'key-host', rows.one(cls: 'hostseg'));
      _expectRect(tester, 'esc', rows.one(cls: 'krow2'));
    });

    testWidgets('Tc 주요 요소', (tester) async {
      await _pump(tester, designKeyEditorScene());
      final rows = _ReferenceRows(darkMeasure, 'sTc');
      _expectRect(tester, 'key-editor-scene', rows.one(cls: 'sheet2'));
      _expectRect(
        tester,
        'key-editor-sheet',
        const _Measure(x: 24, y: 311, w: 346, h: 511),
      );
    });

    testWidgets('Ga 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designSourceControlScene(remote),
        ),
      );
      final rows = _ReferenceRows(darkMeasure, 'sGa');
      _expectRect(tester, 'source-control-scene', rows.one(cls: 'sheet2'));
      _expectRect(tester, 'source-control-grabber', rows.one(cls: 'grab'));
      _expectRect(tester, 'source-control-header', rows.one(cls: 'sh'));
      _expectRect(tester, 'source-control-segment', rows.one(cls: 'gseg'));
    });

    testWidgets('Gb 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(builder: (_, remote) => designDiffScene(remote)),
      );
      final rows = _ReferenceRows(darkMeasure, 'sGb');
      _expectRect(
        tester,
        'diff-header',
        const _Measure(x: 0, y: 54, w: 394, h: 58),
      );
      _expectRect(tester, 'diff-lines', rows.one(cls: 'gdiff'));
    });

    testWidgets('Gc 주요 요소', (tester) async {
      await _pump(
        tester,
        DesignRemoteScene(
          builder: (_, remote) => designCheckFailureScene(remote),
        ),
      );
      final rows = _ReferenceRows(darkMeasure, 'sGc');
      _expectRect(tester, 'check-failure-scene', rows.one(cls: 'sheet2'));
      _expectRect(tester, 'check-log', rows.one(cls: 'glog'));
    });
  });

  testWidgets('다크·라이트 색과 글자 토큰', (tester) async {
    await _pump(tester, designHome());
    _expectThemeAgainstMeasure(tester, darkMeasure, Brightness.dark);

    await _pump(tester, designHome(), brightness: Brightness.light);
    _expectThemeAgainstMeasure(tester, lightMeasure, Brightness.light);
  });

  testWidgets('주요 요소의 반경·패딩·글자 속성', (tester) async {
    await _pump(tester, designHome());
    final rows = _ReferenceRows(darkMeasure, 'sH');

    final command = tester.widget<Container>(
      find.byKey(const Key('home-command')),
    );
    final commandStyle = rows.raw(cls: 'cmd')['style'] as Map<String, dynamic>;
    expect(command.padding, const EdgeInsets.fromLTRB(12, 10, 40, 10));
    final commandDecoration = command.decoration! as BoxDecoration;
    expect(
      commandDecoration.color,
      _cssColor(commandStyle['backgroundColor'] as String),
    );
    expect(
      (commandDecoration.borderRadius! as BorderRadius).topLeft.x,
      _cssNumber(commandStyle['borderRadius'] as String),
    );

    final allow = tester.widget<TextButton>(
      find.descendant(
        of: find.byKey(const Key('home-allow')),
        matching: find.byType(TextButton),
      ),
    );
    final allowStyle =
        rows.raw(cls: 'chipbtn pri', text: '허용')['style']
            as Map<String, dynamic>;
    expect(
      allow.style?.padding?.resolve({}),
      const EdgeInsets.symmetric(horizontal: 14),
    );
    expect(
      allow.style?.backgroundColor?.resolve({}),
      _cssColor(allowStyle['backgroundColor'] as String),
    );
    final allowShape =
        allow.style?.shape?.resolve({})! as RoundedRectangleBorder;
    expect(
      (allowShape.borderRadius as BorderRadius).topLeft.x,
      _cssNumber(allowStyle['borderRadius'] as String),
    );
    final allowTextStyle = allow.style!.textStyle!.resolve({})!;
    expect(
      allowTextStyle.fontSize,
      _cssNumber(allowStyle['fontSize'] as String),
    );
    expect(
      allowTextStyle.fontWeight?.value,
      int.parse(allowStyle['fontWeight'] as String),
    );

    await _pump(tester, designPermissionScene());
    final sheetRows = _ReferenceRows(darkMeasure, 'sSb');
    final sheetDecoration = tester.widget<DecoratedBox>(
      find
          .descendant(
            of: find.byKey(const Key('permission-sheet')),
            matching: find.byType(DecoratedBox),
          )
          .first,
    );
    final sheetStyle =
        sheetRows.raw(cls: 'sheet2')['style'] as Map<String, dynamic>;
    final box = sheetDecoration.decoration as BoxDecoration;
    expect(box.color, _cssColor(sheetStyle['backgroundColor'] as String));
    expect(
      (box.borderRadius! as BorderRadius).topLeft.x,
      _cssNumber(sheetStyle['borderRadius'] as String),
    );
    final sheetPadding = tester.widget<Padding>(
      find
          .descendant(
            of: find.byKey(const Key('permission-sheet')),
            matching: find.byType(Padding),
          )
          .first,
    );
    expect(sheetPadding.padding, const EdgeInsets.fromLTRB(16, 10, 16, 24));
  });
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  Brightness brightness = Brightness.dark,
}) async {
  tester.view.physicalSize = _screenSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: designTestTheme(brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: const EdgeInsets.only(top: _safeTop, bottom: 34),
          viewPadding: const EdgeInsets.only(top: _safeTop, bottom: 34),
          textScaler: TextScaler.noScaling,
        ),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

void _expectRect(
  WidgetTester tester,
  String key,
  _Measure reference, {
  bool ignoreWidth = false,
}) {
  final rect = tester.getRect(find.byKey(Key(key)));
  _close(rect.left, reference.x, '$key.x');
  _close(rect.top, reference.y, '$key.y');
  if (!ignoreWidth) _close(rect.width, reference.w, '$key.w');
  _close(rect.height, reference.h, '$key.h');
}

void _close(double actual, double expected, String property) {
  expect(
    actual,
    moreOrLessEquals(expected, epsilon: 1),
    reason: '$property: 시안 $expected, 앱 $actual',
  );
}

void _expectThemeAgainstMeasure(
  WidgetTester tester,
  Map<String, dynamic> measure,
  Brightness brightness,
) {
  final context = tester.element(find.byKey(const Key('home-scroll')));
  final colors = context.iris;
  final rows = _ReferenceRows(measure, 'sH');
  final view = rows.raw(cls: 'view');
  final title = rows.raw(tag: 'h1', text: '에이전트');

  expect(
    colors.background,
    _cssColor(
      (view['style'] as Map<String, dynamic>)['backgroundColor'] as String,
    ),
  );
  expect(
    colors.foreground,
    _styleColor(rows.raw(tag: 'h1', text: '에이전트'), 'color'),
  );
  expect(colors.working, _styleColor(rows.raw(cls: 'live'), 'backgroundColor'));
  expect(colors.level1, _styleColor(rows.raw(cls: 'cmd'), 'backgroundColor'));
  expect(
    colors.brand,
    _styleColor(rows.raw(cls: 'chipbtn pri', text: '허용'), 'backgroundColor'),
  );
  expect(
    colors.onBrand,
    _styleColor(rows.raw(cls: 'chipbtn pri', text: '허용'), 'color'),
  );
  final titleStyle = title['style'] as Map<String, dynamic>;
  expect(IrisType.title.fontSize, _cssNumber(titleStyle['fontSize'] as String));
  expect(
    IrisType.title.fontWeight?.value,
    int.parse(titleStyle['fontWeight'] as String),
  );
  expect(
    IrisType.title.height! * IrisType.title.fontSize!,
    _cssNumber(titleStyle['lineHeight'] as String),
  );
  expect(
    IrisType.title.letterSpacing,
    _cssNumber(titleStyle['letterSpacing'] as String),
  );
  expect(Theme.of(context).brightness, brightness);
}

double _cssNumber(String value) => double.parse(value.replaceAll('px', ''));

Color _cssColor(String value) {
  final channels = RegExp(r'\d+').allMatches(value).map((match) {
    return int.parse(match.group(0)!);
  }).toList();
  return Color.fromARGB(255, channels[0], channels[1], channels[2]);
}

Color _styleColor(Map<String, dynamic> row, String property) =>
    _cssColor((row['style'] as Map<String, dynamic>)[property] as String);

class _ReferenceRows {
  _ReferenceRows(Map<String, dynamic> measure, String screen)
    : screen = screen,
      rows = (measure[screen] as Map<String, dynamic>)['rows'] as List<dynamic>;

  final String screen;
  final List<dynamic> rows;

  Map<String, dynamic> raw({
    String? tag,
    String? cls,
    String? text,
    String? startsWith,
    int occurrence = 0,
  }) {
    final matches = rows.cast<Map<String, dynamic>>().where((row) {
      return (tag == null || row['tag'] == tag) &&
          (cls == null || row['cls'] == cls) &&
          (text == null || row['text'] == text) &&
          (startsWith == null ||
              (row['text'] as String).startsWith(startsWith));
    }).toList();
    expect(
      matches.length,
      greaterThan(occurrence),
      reason: '$screen: tag=$tag cls=$cls text=$text startsWith=$startsWith',
    );
    return matches[occurrence];
  }

  _Measure one({
    String? tag,
    String? cls,
    String? text,
    String? startsWith,
    int occurrence = 0,
  }) {
    final row = raw(
      tag: tag,
      cls: cls,
      text: text,
      startsWith: startsWith,
      occurrence: occurrence,
    );
    return _Measure(
      x: (row['x'] as num).toDouble(),
      y: (row['y'] as num).toDouble(),
      w: (row['w'] as num).toDouble(),
      h: (row['h'] as num).toDouble(),
    );
  }
}

class _Measure {
  const _Measure({
    required this.x,
    required this.y,
    required this.w,
    required this.h,
  });

  final double x;
  final double y;
  final double w;
  final double h;

  _Measure dy(double delta) => _Measure(x: x, y: y + delta, w: w, h: h);
}
