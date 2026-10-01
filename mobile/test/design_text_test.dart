import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'design_fixture.dart';

const _screenSize = Size(394, 854);
const _safeTop = 54.0;
const _sceneKey = Key('design-text-scene');
const _epsilon = 1.0;

const _screens = <String>[
  'h',
  'sa',
  'sb',
  'sc',
  'sd',
  'ba',
  'bb',
  'bc',
  'bd',
  'be',
  'bf',
  'bg',
  'ta',
  'tb',
  'tc',
  'ga',
  'gb',
  'gc',
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, dynamic> darkMeasure;
  late Map<String, dynamic> lightMeasure;
  final reportOnly = Platform.environment['DESIGN_TEXT_REPORT_ONLY'] == '1';
  final verbose = Platform.environment['DESIGN_TEXT_VERBOSE'] == '1';
  final selectedScreens =
      Platform.environment['DESIGN_TEXT_SCREENS']?.split(',') ?? _screens;
  final selectedTones =
      Platform.environment['DESIGN_TEXT_TONES']?.split(',') ??
      Brightness.values.map((value) => value.name);

  setUpAll(() async {
    await loadDesignReferenceFont();
    darkMeasure = jsonDecode(
      await File('test/design_ref/dark-measure.json').readAsString(),
    ) as Map<String, dynamic>;
    lightMeasure = jsonDecode(
      await File('test/design_ref/light-measure.json').readAsString(),
    ) as Map<String, dynamic>;
  });

  testWidgets('시험 글꼴 굵기 적용', (tester) async {
    final advances = <double>[];
    for (final weight in const [
      FontWeight.w400,
      FontWeight.w500,
      FontWeight.w600,
      FontWeight.w700,
    ]) {
      advances.add(_renderedAdvance(weight));
    }
    expect(advances.toSet(), hasLength(4));
  });

  for (final brightness in Brightness.values.where(
    (value) => selectedTones.contains(value.name),
  )) {
    final tone = brightness.name;
    for (final screen in _screens.where(selectedScreens.contains)) {
      testWidgets('$tone $screen 글자 대조', (tester) async {
        await _pumpScene(tester, _scene(screen), brightness);
        await _prepare(tester, screen);
        final measure = brightness == Brightness.dark
            ? darkMeasure
            : lightMeasure;
        final failures = _compareText(
          tester,
          screen,
          measure['s${_screenName(screen)}'] as Map<String, dynamic>,
        );
        // 화면별 실패 수와 대표 항목을 남기는 고정 형식
        // ignore: avoid_print
        print(
          'DESIGN_TEXT $tone-$screen ${failures.length} '
          '${failures.take(5).join(' | ')}',
        );
        if (verbose) {
          for (final failure in failures) {
            // ignore: avoid_print
            print('DESIGN_TEXT_DETAIL $tone-$screen $failure');
          }
        }
        if (!reportOnly) {
          expect(failures, isEmpty, reason: failures.join('\n'));
        }
      });
    }
  }
}

double _renderedAdvance(FontWeight weight) {
  final painter = TextPainter(
    text: TextSpan(
      text: 'worktree-row.js',
      style: TextStyle(
        fontFamily: designReferenceFontFamily,
        fontSize: 20,
        fontWeight: weight,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  return painter.width;
}

String _screenName(String screen) => switch (screen) {
  'h' => 'H',
  _ => '${screen[0].toUpperCase()}${screen.substring(1)}',
};

Widget _scene(String screen) => switch (screen) {
  'h' => designHome(),
  'sa' => designSession(),
  'sb' => designPermissionScene(),
  'sc' => designQuestionScene(),
  'sd' => DesignRemoteScene(builder: (_, remote) => designHumanScene(remote)),
  'ba' ||
  'bb' ||
  'bd' ||
  'be' ||
  'bg' => DesignRemoteScene(builder: (_, remote) => designBrowserScene(remote)),
  'bc' => DesignRemoteScene(
    builder: (_, remote) => designBrowserScene(remote, human: true),
  ),
  'bf' => DesignRemoteScene(
    builder: (_, remote) => designBrowserScene(remote, frame: 'more'),
  ),
  'ta' => DesignRemoteScene(
    builder: (_, remote) => designTerminalScene(remote),
  ),
  'tb' => designKeySettings(),
  'tc' => designKeyEditorScene(),
  'ga' => DesignRemoteScene(
    builder: (_, remote) => designSourceControlScene(remote),
  ),
  'gb' => DesignRemoteScene(builder: (_, remote) => designDiffScene(remote)),
  'gc' => DesignRemoteScene(
    builder: (_, remote) => designCheckFailureScene(remote),
  ),
  _ => throw ArgumentError.value(screen),
};

Future<void> _prepare(WidgetTester tester, String screen) async {
  switch (screen) {
    case 'sc':
      await tester.tap(find.byKey(const Key('question-option-first')));
      await tester.pumpAndSettle();
      return;
    case 'bb':
      await tester.tap(find.text('요소 선택'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('browser-frame')));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('browser-element-input')),
        '버튼 문구를 “결제하기”로 바꿔 줘',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      return;
    case 'bd':
      await tester.tap(find.text('조작 기록'));
      await tester.pumpAndSettle();
      return;
    case 'be':
      await tester.tap(find.text('스케치'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, '그림과 함께 보낼 글'),
        '결제 버튼을 더 크게, 테두리 부분 강조',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      return;
    case 'bf':
      await tester.tap(find.text('더보기'));
      await tester.pumpAndSettle();
      return;
    case 'bg':
      await tester.tap(find.text('더보기'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('데스크톱 보기'));
      await tester.pumpAndSettle();
      return;
    case 'gb':
      await tester.tap(find.text('+ row.append(text(pr.label));'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('diff-comment-input')),
        '이름이 길면 PR 글자가 잘립니다. 이름 쪽을 줄이고 PR 글자는 남겨 주세요.',
      );
      tester.testTextInput.hide();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      return;
  }
}

Future<void> _pumpScene(
  WidgetTester tester,
  Widget scene,
  Brightness brightness,
) async {
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
        child: RepaintBoundary(key: _sceneKey, child: child!),
      ),
      home: scene,
    ),
  );
  await tester.pumpAndSettle();
}

List<String> _compareText(
  WidgetTester tester,
  String screen,
  Map<String, dynamic> screenMeasure,
) {
  final references = _references(screen, screenMeasure);
  final candidates = _textCandidates(
    tester.renderObject<RenderBox>(find.byKey(_sceneKey)),
  );
  final failures = <String>[];
  final pairs = <_ScoredPair>[];

  for (
    var referenceIndex = 0;
    referenceIndex < references.length;
    referenceIndex++
  ) {
    final reference = references[referenceIndex];
    for (var index = 0; index < candidates.length; index++) {
      if (candidates[index].text != reference.text) continue;
      final match = candidates[index].match(reference);
      final stylePenalty = _styleDistance(reference, candidates[index]);
      pairs.add(
        _ScoredPair(
          referenceIndex: referenceIndex,
          candidateIndex: index,
          score: match.distance + stylePenalty,
        ),
      );
    }
  }
  pairs.sort((first, second) => first.score.compareTo(second.score));
  final assignedReferences = <int, _ScoredPair>{};
  final assignedCandidates = <int>{};
  for (final pair in pairs) {
    if (assignedReferences.containsKey(pair.referenceIndex) ||
        assignedCandidates.contains(pair.candidateIndex)) {
      continue;
    }
    assignedReferences[pair.referenceIndex] = pair;
    assignedCandidates.add(pair.candidateIndex);
  }

  for (
    var referenceIndex = 0;
    referenceIndex < references.length;
    referenceIndex++
  ) {
    final reference = references[referenceIndex];
    final pair = assignedReferences[referenceIndex];
    if (pair == null) {
      failures.add('${reference.label}: 빠짐');
      continue;
    }
    final actual = candidates[pair.candidateIndex];
    _compareFontMetrics(reference, actual, failures);
    _compareStyle(reference, actual, failures);
    if (actual.lineCount != reference.lineCount) {
      failures.add(
        '${reference.label}.줄: ${reference.lineCount}→${actual.lineCount}',
      );
    }
  }
  return failures;
}

List<_ReferenceText> _references(
  String screen,
  Map<String, dynamic> screenMeasure,
) {
  final rows = (screenMeasure['rows'] as List<dynamic>)
      .cast<Map<String, dynamic>>();
  final result = <_ReferenceText>[];
  var hiddenView = false;
  for (var index = 0; index < rows.length; index++) {
    final row = rows[index];
    final cls = row['cls'] as String;
    if (cls == 'sview hide') hiddenView = true;
    if (cls == 'scrim' || cls.startsWith('sheet2')) hiddenView = false;
    final text = (row['text'] as String).trim();
    final y = (row['y'] as num).toDouble();
    final height = (row['h'] as num).toDouble();
    if (hiddenView ||
        text.isEmpty ||
        y >= _screenSize.height ||
        y + height <= _safeTop) {
      continue;
    }
    if (_isException(screen, row, text) || _hasTextChild(rows, index)) continue;
    var adjustedY = y;
    if (screen == 'sb' && y >= 483 && y < 710) adjustedY += 56;
    final style = row['style'] as Map<String, dynamic>;
    final rect = Rect.fromLTWH(
      (row['x'] as num).toDouble(),
      adjustedY,
      (row['w'] as num).toDouble(),
      height,
    );
    final padding = EdgeInsets.fromLTRB(
      _cssNumber(style['paddingLeft'] as String),
      _cssNumber(style['paddingTop'] as String),
      _cssNumber(style['paddingRight'] as String),
      _cssNumber(style['paddingBottom'] as String),
    );
    final tag = row['tag'] as String;
    final fontSize = _cssNumber(style['fontSize'] as String);
    final fontWeight = int.parse(style['fontWeight'] as String);
    final rangeWidth = _referenceAdvance(text, fontSize, fontWeight);
    final contentWidth = rect.width - padding.horizontal;
    final usesBox =
        tag != 'button' &&
        contentWidth > math.max(rangeWidth + 8, rangeWidth * 1.25);
    result.add(
      _ReferenceText(
        label: '${row['tag']}.$cls[$index] "$text"',
        text: text,
        rect: rect,
        padding: padding,
        placement: tag == 'button'
            ? _TextPlacement.centeredRange
            : padding != EdgeInsets.zero
            ? _TextPlacement.paddedRange
            : usesBox
            ? _TextPlacement.contentBox
            : _TextPlacement.inlineRange,
        fontSize: fontSize,
        fontWeight: fontWeight,
        color: _cssColor(style['color'] as String),
        lineHeight: _lineHeight(style),
        letterSpacing: _letterSpacing(style),
        lineCount: _lineCount(row),
      ),
    );
  }
  return result;
}

bool _hasTextChild(List<Map<String, dynamic>> rows, int parentIndex) {
  final parent = rows[parentIndex];
  final parentText = (parent['text'] as String).trim();
  if (parentText.isEmpty) return false;
  final parentRect = _rowRect(parent);
  for (var index = parentIndex + 1; index < rows.length; index++) {
    final child = rows[index];
    if ((child['text'] as String).trim().isEmpty) continue;
    final childRect = _rowRect(child);
    if (childRect.size == parentRect.size) continue;
    if (parentRect.inflate(0.1).contains(childRect.topLeft) &&
        parentRect.inflate(0.1).contains(childRect.bottomRight)) {
      return true;
    }
  }
  return false;
}

Rect _rowRect(Map<String, dynamic> row) => Rect.fromLTWH(
  (row['x'] as num).toDouble(),
  (row['y'] as num).toDouble(),
  (row['w'] as num).toDouble(),
  (row['h'] as num).toDouble(),
);

double _referenceAdvance(String text, double fontSize, int fontWeight) {
  final painter = TextPainter(
    text: TextSpan(
      text: text,
      style: TextStyle(
        fontFamily: designReferenceFontFamily,
        fontFamilyFallback: const [
          'DesignReferenceKorean',
          'DesignReferenceSymbols',
        ],
        fontSize: fontSize,
        fontWeight: FontWeight.values[(fontWeight ~/ 100 - 1).clamp(0, 8)],
      ),
    ),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return painter.width;
}

bool _isException(String screen, Map<String, dynamic> row, String text) {
  if (screen == 'sb' &&
      const {'이 세션에서 계속 허용', '2', '3', 'Face ID'}.contains(text)) {
    return true;
  }
  if (!const {
    'sd',
    'ba',
    'bb',
    'bc',
    'bd',
    'be',
    'bf',
    'bg',
  }.contains(screen)) {
    return false;
  }
  return const {
    'Pocket Store',
    '장바구니 1',
    '장바구니 1 · 로그인',
    '결제',
    '린넨 토트백',
    '내추럴 · 1개',
    '39,000원',
    'kim@example.com',
    '카드 번호',
    '만료일 · CVC',
    '39,000원 결제',
    '인증',
    '카드 인증',
    '문자로 받은 6자리를 입력하세요.',
    '482 9|',
    '확인',
    '인증번호 6자리',
    '배송비',
    '무료',
    '0원',
  }.contains(text);
}

int _lineCount(Map<String, dynamic> row) {
  final style = row['style'] as Map<String, dynamic>;
  final raw = style['lineHeight'] as String;
  if (raw == 'normal') return 1;
  final height =
      (row['h'] as num).toDouble() -
      _cssNumber(style['paddingTop'] as String) -
      _cssNumber(style['paddingBottom'] as String);
  return math.max(1, (height / _cssNumber(raw)).round());
}

double? _lineHeight(Map<String, dynamic> style) {
  final value = style['lineHeight'] as String;
  return value == 'normal' ? null : _cssNumber(value);
}

double? _letterSpacing(Map<String, dynamic> style) {
  final value = style['letterSpacing'] as String;
  return value == 'normal' ? null : _cssNumber(value);
}

List<_TextCandidate> _textCandidates(RenderBox root) {
  final result = <_TextCandidate>[];
  void visit(RenderObject object) {
    if (object is RenderParagraph) {
      _collectParagraphAggregate(result, root, object);
      _collectUnstyledAggregate(result, root, object);
      _collectSpan(
        result,
        root,
        object,
        object.text,
        object.text.style ?? const TextStyle(),
        0,
      );
    } else if (object is RenderEditable) {
      final text = object.text;
      if (text == null) {
        object.visitChildren(visit);
        return;
      }
      _collectEditableSpan(
        result,
        root,
        object,
        text,
        text.style ?? const TextStyle(),
        0,
      );
    }
    object.visitChildren(visit);
  }

  visit(root);
  return result;
}

void _collectParagraphAggregate(
  List<_TextCandidate> result,
  RenderBox root,
  RenderParagraph paragraph,
) {
  if (paragraph.text case final TextSpan span
      when span.children?.isNotEmpty != true) {
    return;
  }
  final plain = paragraph.text.toPlainText();
  final text = plain.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (text.isEmpty) return;
  final boxes = paragraph.getBoxesForSelection(
    TextSelection(baseOffset: 0, extentOffset: plain.length),
  );
  if (boxes.isEmpty) return;
  final local = boxes
      .map((box) => Rect.fromLTRB(box.left, box.top, box.right, box.bottom))
      .reduce((first, second) => first.expandToInclude(second));
  result.add(
    _TextCandidate(
      text: text.substring(0, math.min(60, text.length)),
      rect: Rect.fromPoints(
        paragraph.localToGlobal(local.topLeft, ancestor: root),
        paragraph.localToGlobal(local.bottomRight, ancestor: root),
      ),
      style: paragraph.text.style ?? const TextStyle(),
      lineCount: _boxLineCount(boxes),
      renderer: paragraph,
      root: root,
    ),
  );
}

void _collectUnstyledAggregate(
  List<_TextCandidate> result,
  RenderBox root,
  RenderParagraph paragraph,
) {
  if (paragraph.text case final TextSpan span
      when span.children?.isNotEmpty != true) {
    return;
  }
  final base = paragraph.text.style ?? const TextStyle();
  final parts = <String>[];
  final boxes = <ui.TextBox>[];

  int visit(InlineSpan span, TextStyle inherited, int offset) {
    if (span is! TextSpan) return offset + span.toPlainText().length;
    final style = inherited.merge(span.style);
    final text = span.text;
    if (text != null) {
      final end = offset + text.length;
      final sameColor = style.color == base.color;
      final sameWeight = style.fontWeight == base.fontWeight;
      if (sameColor && sameWeight) {
        parts.add(text);
        boxes.addAll(
          paragraph.getBoxesForSelection(
            TextSelection(baseOffset: offset, extentOffset: end),
          ),
        );
      }
      offset = end;
    }
    for (final child in span.children ?? const <InlineSpan>[]) {
      offset = visit(child, style, offset);
    }
    return offset;
  }

  visit(paragraph.text, base, 0);
  final text = parts.join().replaceAll(RegExp(r'[\r\n\t]'), ' ').trim();
  if (text.isEmpty || boxes.isEmpty) return;
  final local = boxes
      .map((box) => Rect.fromLTRB(box.left, box.top, box.right, box.bottom))
      .reduce((first, second) => first.expandToInclude(second));
  final topLeft = paragraph.localToGlobal(local.topLeft, ancestor: root);
  final bottomRight = paragraph.localToGlobal(
    local.bottomRight,
    ancestor: root,
  );
  result.add(
    _TextCandidate(
      text: text.substring(0, math.min(60, text.length)),
      rect: Rect.fromPoints(topLeft, bottomRight),
      style: base,
      lineCount: _boxLineCount(boxes),
      renderer: paragraph,
      root: root,
    ),
  );
}

void _collectDirectAggregate(
  List<_TextCandidate> result,
  RenderBox root,
  RenderParagraph paragraph,
  InlineSpan span,
  TextStyle inherited,
) {
  if (span is! TextSpan || span.children == null) return;
  final baseStyle = inherited.merge(span.style);
  var offset = span.text?.length ?? 0;
  final parts = <String>[];
  final boxes = <ui.TextBox>[];
  for (final child in span.children!) {
    final length = child.toPlainText().length;
    if (child is TextSpan && child.text != null) {
      final style = baseStyle.merge(child.style);
      if (child.style == null || style.color == baseStyle.color) {
        parts.add(child.text!);
        boxes.addAll(
          paragraph.getBoxesForSelection(
            TextSelection(baseOffset: offset, extentOffset: offset + length),
          ),
        );
      }
    }
    offset += length;
  }
  final text = parts.join().replaceAll(RegExp(r'\s+'), ' ').trim();
  if (text.isEmpty || boxes.isEmpty) return;
  final local = boxes
      .map((box) => Rect.fromLTRB(box.left, box.top, box.right, box.bottom))
      .reduce((first, second) => first.expandToInclude(second));
  final topLeft = paragraph.localToGlobal(local.topLeft, ancestor: root);
  final bottomRight = paragraph.localToGlobal(
    local.bottomRight,
    ancestor: root,
  );
  result.add(
    _TextCandidate(
      text: text.substring(0, math.min(60, text.length)),
      rect: Rect.fromPoints(topLeft, bottomRight),
      style: baseStyle,
      lineCount: _boxLineCount(boxes),
      renderer: paragraph,
      root: root,
    ),
  );
}

int _collectEditableSpan(
  List<_TextCandidate> result,
  RenderBox root,
  RenderEditable editable,
  InlineSpan span,
  TextStyle inherited,
  int offset,
) {
  if (span is! TextSpan) return offset + span.toPlainText().length;
  final style = inherited.merge(span.style);
  final text = span.text;
  if (text != null) {
    final start = offset;
    final end = start + text.length;
    if (text.trim().isNotEmpty) {
      final boxes = editable.getBoxesForSelection(
        TextSelection(baseOffset: start, extentOffset: end),
      );
      if (boxes.isNotEmpty) {
        final local = boxes
            .map(
              (box) => Rect.fromLTRB(box.left, box.top, box.right, box.bottom),
            )
            .reduce((first, second) => first.expandToInclude(second));
        final globalTopLeft = editable.localToGlobal(
          local.topLeft,
          ancestor: root,
        );
        final globalBottomRight = editable.localToGlobal(
          local.bottomRight,
          ancestor: root,
        );
        result.add(
          _TextCandidate(
            text: text.trim(),
            rect: Rect.fromPoints(globalTopLeft, globalBottomRight),
            style: style,
            lineCount: _boxLineCount(boxes),
            renderer: editable,
            root: root,
          ),
        );
      }
    }
    offset = end;
  }
  for (final child in span.children ?? const <InlineSpan>[]) {
    offset = _collectEditableSpan(result, root, editable, child, style, offset);
  }
  return offset;
}

int _collectSpan(
  List<_TextCandidate> result,
  RenderBox root,
  RenderParagraph paragraph,
  InlineSpan span,
  TextStyle inherited,
  int offset,
) {
  if (span is! TextSpan) return offset + span.toPlainText().length;
  final style = inherited.merge(span.style);
  _collectDirectAggregate(result, root, paragraph, span, inherited);
  final text = span.text;
  if (text != null) {
    final start = offset;
    final end = start + text.length;
    if (text.trim().isNotEmpty) {
      final selectedStart = start + text.length - text.trimLeft().length;
      final selectedEnd = end - (text.length - text.trimRight().length);
      final boxes = paragraph.getBoxesForSelection(
        TextSelection(baseOffset: selectedStart, extentOffset: selectedEnd),
      );
      if (boxes.isNotEmpty) {
        final local = boxes
            .map(
              (box) => Rect.fromLTRB(box.left, box.top, box.right, box.bottom),
            )
            .reduce((first, second) => first.expandToInclude(second));
        final globalTopLeft = paragraph.localToGlobal(
          local.topLeft,
          ancestor: root,
        );
        final globalBottomRight = paragraph.localToGlobal(
          local.bottomRight,
          ancestor: root,
        );
        final lineCount = span.children?.isNotEmpty ?? false
            ? _boxLineCount(
                paragraph.getBoxesForSelection(
                  TextSelection(
                    baseOffset: 0,
                    extentOffset: paragraph.text.toPlainText().length,
                  ),
                ),
              )
            : _boxLineCount(boxes);
        result.add(
          _TextCandidate(
            text: text.trim(),
            rect: Rect.fromPoints(globalTopLeft, globalBottomRight),
            style: style,
            lineCount: lineCount,
            renderer: paragraph,
            root: root,
          ),
        );
      }
    }
    offset = end;
  }
  for (final child in span.children ?? const <InlineSpan>[]) {
    offset = _collectSpan(result, root, paragraph, child, style, offset);
  }
  return offset;
}

double _styleDistance(_ReferenceText reference, _TextCandidate candidate) {
  final style = candidate.style;
  return ((style.fontSize ?? 0) - reference.fontSize).abs() * 5 +
      ((style.fontWeight?.value ?? 400) - reference.fontWeight).abs() / 20 +
      (_colorDistance(style.color, reference.color) / 20);
}

void _compareFontMetrics(
  _ReferenceText reference,
  _TextCandidate actual,
  List<String> failures,
) {
  final expected = _metricPainter(
    reference.text,
    actual.style.copyWith(
      fontSize: reference.fontSize,
      fontWeight:
          FontWeight.values[(reference.fontWeight ~/ 100 - 1).clamp(0, 8)],
      letterSpacing: reference.letterSpacing ?? 0,
      height: reference.lineHeight == null
          ? null
          : reference.lineHeight! / reference.fontSize,
    ),
  );
  final observed = _metricPainter(reference.text, actual.style);
  _compareNumber(reference, '글자폭', expected.width, observed.width, failures);
  _compareNumber(
    reference,
    '기준선',
    expected.computeDistanceToActualBaseline(TextBaseline.alphabetic),
    observed.computeDistanceToActualBaseline(TextBaseline.alphabetic),
    failures,
  );
}

TextPainter _metricPainter(String text, TextStyle style) => TextPainter(
  text: TextSpan(text: text, style: style),
  textDirection: TextDirection.ltr,
  maxLines: 1,
)..layout();

void _compareStyle(
  _ReferenceText reference,
  _TextCandidate actual,
  List<String> failures,
) {
  final style = actual.style;
  _compareNumber(
    reference,
    '크기',
    reference.fontSize,
    style.fontSize ?? 0,
    failures,
  );
  if ((style.fontWeight?.value ?? 400) != reference.fontWeight) {
    failures.add(
      '${reference.label}.굵기: ${reference.fontWeight}→'
      '${style.fontWeight?.value ?? 400}',
    );
  }
  if (!reference.label.startsWith('text.') && style.color != reference.color) {
    failures.add(
      '${reference.label}.색: ${_hex(reference.color)}→${_hex(style.color)}',
    );
  }
  if (reference.lineHeight == null) {
    if (style.height != null) {
      _compareNumber(
        reference,
        '줄높이',
        reference.fontSize * 1.2,
        style.height! * (style.fontSize ?? reference.fontSize),
        failures,
      );
    }
  } else {
    final actualLineHeight = style.height == null || style.fontSize == null
        ? actual.rect.height / actual.lineCount
        : style.height! * style.fontSize!;
    _compareNumber(
      reference,
      '줄높이',
      reference.lineHeight!,
      actualLineHeight,
      failures,
    );
  }
  final expectedSpacing = reference.letterSpacing ?? 0;
  final actualSpacing = style.letterSpacing ?? 0;
  _compareNumber(reference, '자간', expectedSpacing, actualSpacing, failures);
}

int _boxLineCount(List<ui.TextBox> boxes) {
  final tops = boxes.map((box) => box.top).toList()..sort();
  var count = 0;
  double? previous;
  for (final top in tops) {
    if (previous == null || (top - previous).abs() > 10) {
      count++;
      previous = top;
    }
  }
  return count;
}

void _compareNumber(
  _ReferenceText reference,
  String field,
  double expected,
  double actual,
  List<String> failures,
) {
  if ((actual - expected).abs() > _epsilon) {
    failures.add(
      '${reference.label}.$field: ${expected.toStringAsFixed(1)}→'
      '${actual.toStringAsFixed(1)}',
    );
  }
}

double _colorDistance(Color? first, Color second) {
  if (first == null) return 255 * 3;
  return (first.r * 255 - second.r * 255).abs() +
      (first.g * 255 - second.g * 255).abs() +
      (first.b * 255 - second.b * 255).abs();
}

double _cssNumber(String value) => double.parse(value.replaceAll('px', ''));

Color _cssColor(String value) {
  final channels = RegExp(r'[\d.]+')
      .allMatches(value)
      .map((match) => double.parse(match.group(0)!))
      .toList();
  final alpha = channels.length > 3 ? channels[3] : 1.0;
  return Color.fromRGBO(
    channels[0].round(),
    channels[1].round(),
    channels[2].round(),
    alpha,
  );
}

String _hex(Color? color) {
  if (color == null) return '없음';
  final value = color.toARGB32() & 0xffffff;
  return '#${value.toRadixString(16).padLeft(6, '0')}';
}

class _ReferenceText {
  const _ReferenceText({
    required this.label,
    required this.text,
    required this.rect,
    required this.padding,
    required this.placement,
    required this.fontSize,
    required this.fontWeight,
    required this.color,
    required this.lineHeight,
    required this.letterSpacing,
    required this.lineCount,
  });

  final String label;
  final String text;
  final Rect rect;
  final EdgeInsets padding;
  final _TextPlacement placement;
  final double fontSize;
  final int fontWeight;
  final Color color;
  final double? lineHeight;
  final double? letterSpacing;
  final int lineCount;

  Rect comparisonRect(double actualRangeHeight) {
    final content = Rect.fromLTRB(
      rect.left + padding.left,
      rect.top + padding.top,
      rect.right - padding.right,
      rect.bottom - padding.bottom,
    );
    if (placement == _TextPlacement.paddedRange) return content;
    if (placement == _TextPlacement.contentBox) {
      final expectedLineHeight = (lineHeight ?? fontSize * 1.2) * lineCount;
      final top = content.height > expectedLineHeight + 1
          ? content.center.dy - actualRangeHeight / 2
          : content.top;
      return Rect.fromLTWH(content.left, top, content.width, actualRangeHeight);
    }
    if (placement == _TextPlacement.centeredRange) {
      return Rect.fromCenter(
        center: content.center,
        width: _referenceAdvance(text, fontSize, fontWeight),
        height: actualRangeHeight,
      );
    }
    return rect;
  }
}

enum _TextPlacement { inlineRange, paddedRange, contentBox, centeredRange }

class _TextCandidate {
  const _TextCandidate({
    required this.text,
    required this.rect,
    required this.style,
    required this.lineCount,
    required this.renderer,
    required this.root,
  });

  final String text;
  final Rect rect;
  final TextStyle style;
  final int lineCount;
  final RenderBox renderer;
  final RenderBox root;

  _CandidateMatch match(_ReferenceText reference) {
    final rendererTopLeft = renderer.localToGlobal(Offset.zero, ancestor: root);
    final rendererRect = rendererTopLeft & renderer.size;
    var candidate = rect;
    if (reference.placement == _TextPlacement.contentBox) {
      var widthRect = rendererRect;
      RenderObject? parent = renderer.parent;
      while (parent != null && parent != root) {
        if (parent is RenderBox && parent.hasSize && parent.attached) {
          final topLeft = parent.localToGlobal(Offset.zero, ancestor: root);
          final parentRect = topLeft & parent.size;
          if (parentRect.width > rect.width + 4) {
            widthRect = parentRect;
            break;
          }
        }
        parent = parent.parent;
      }
      candidate = Rect.fromLTWH(
        widthRect.left,
        rect.top,
        widthRect.width,
        rect.height,
      );
    }
    final expected = reference.comparisonRect(candidate.height);
    return _CandidateMatch(_rectDistance(candidate, expected));
  }
}

class _CandidateMatch {
  const _CandidateMatch(this.distance);

  final double distance;
}

class _ScoredPair {
  const _ScoredPair({
    required this.referenceIndex,
    required this.candidateIndex,
    required this.score,
  });

  final int referenceIndex;
  final int candidateIndex;
  final double score;
}

double _rectDistance(Rect first, Rect second) =>
    (first.left - second.left).abs() +
    (first.top - second.top).abs() +
    (first.width - second.width).abs() +
    (first.height - second.height).abs();
