import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/tokens.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final brightness in Brightness.values) {
    testWidgets('${brightness.name} 마크다운 요소를 화면 요소로 구분한다', (tester) async {
      await tester.pumpWidget(
        _app(
          brightness,
          const IrisMarkdown('''
# 제목

**굵게**와 *기울임*, `inline()`

- 첫 항목
  - 안쪽 항목

> 인용문

| 이름 | 값 |
| --- | --- |
| 상태 | 완료 |

[문서](https://example.test/docs)

![원격 그림](https://example.test/image.png)

```dart
final count = 42; // 설명
print("value");
```
'''),
        ),
      );

      expect(find.text('제목', findRichText: true), findsOneWidget);
      expect(find.text('첫 항목', findRichText: true), findsOneWidget);
      expect(find.text('안쪽 항목', findRichText: true), findsOneWidget);
      expect(find.text('인용문', findRichText: true), findsOneWidget);
      expect(find.text('상태', findRichText: true), findsOneWidget);
      expect(find.byType(Table), findsOneWidget);
      expect(find.byKey(const Key('markdown-code-dart')), findsOneWidget);
      expect(find.byKey(const Key('markdown-code-scroll')), findsOneWidget);
      expect(
        tester
            .widget<SingleChildScrollView>(
              find.byKey(const Key('markdown-code-scroll')),
            )
            .scrollDirection,
        Axis.horizontal,
      );
      expect(find.byType(Image), findsNothing);
      expect(find.text('이미지: 원격 그림'), findsOneWidget);

      final styles = _allTextStyles(tester);
      expect(
        styles.any((style) => style.fontWeight == FontWeight.w700),
        isTrue,
      );
      expect(
        styles.any((style) => style.fontStyle == FontStyle.italic),
        isTrue,
      );
      expect(styles.any((style) => style.fontFamily == 'monospace'), isTrue);
      expect(styles.any((style) => style.backgroundColor != null), isTrue);

      await tester.tap(find.text('문서', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('markdown-link-address')), findsOneWidget);
      expect(find.text('https://example.test/docs'), findsOneWidget);
      expect(find.text('주소 복사'), findsOneWidget);
    });
  }

  testWidgets('코드 블록은 원문을 복사한다', (tester) async {
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await tester.pumpWidget(
      _app(
        Brightness.dark,
        const IrisMarkdown('```dart\nfinal answer = 42;\n```'),
      ),
    );

    await tester.tap(find.byKey(const Key('markdown-code-copy')));
    await tester.pump();
    final clipboard = calls.singleWhere(
      (call) => call.method == 'Clipboard.setData',
    );
    expect(clipboard.arguments, {'text': 'final answer = 42;\n'});
  });

  test('언어별 코드는 키워드·문자열·주석·숫자 TextSpan으로 나뉜다', () {
    final span = highlightCode(
      'final message = "ready"; // note\nreturn 42;',
      'dart',
    );
    final styles = _spanStyles(span)
        .where((style) => style.color != null)
        .toList();
    final colors = styles.map((style) => style.color).toSet();
    expect(colors, hasLength(greaterThanOrEqualTo(4)));
    expect(styles.any((style) => style.fontStyle == FontStyle.italic), isTrue);
    expect(styles.any((style) => style.fontWeight == FontWeight.w600), isTrue);
    for (final color in colors.whereType<Color>()) {
      expect(
        _contrast(color, const Color(0xff08121a)),
        greaterThanOrEqualTo(4.5),
      );
    }
  });

  test('diff 코드는 추가·삭제·위치 줄을 다른 색으로 표시한다', () {
    final span = highlightCode('@@ -1 +1 @@\n-old\n+new\n same', 'diff');
    final lineStyles = <String, TextStyle?>{};
    for (final child in span.children!.whereType<TextSpan>()) {
      if (child.text != null && child.text != '\n') {
        lineStyles[child.text!] = child.style;
      }
    }
    expect(lineStyles['+new']?.color, isNot(lineStyles['-old']?.color));
    expect(lineStyles['@@ -1 +1 @@']?.color, isNot(lineStyles['+new']?.color));
    expect(lineStyles['+new']?.backgroundColor, isNotNull);
    expect(lineStyles['-old']?.backgroundColor, isNotNull);
  });
}

Widget _app(Brightness brightness, Widget child) => MaterialApp(
  theme: irisTheme(brightness),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: child,
    ),
  ),
);

Iterable<TextStyle> _allTextStyles(WidgetTester tester) sync* {
  for (final selectable in tester.widgetList<SelectableText>(
    find.byType(SelectableText),
  )) {
    final span = selectable.textSpan;
    if (span != null) yield* _spanStyles(span);
    if (selectable.style != null) {
      yield selectable.style!;
    }
  }
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    yield* _spanStyles(rich.text);
  }
}

Iterable<TextStyle> _spanStyles(InlineSpan span) sync* {
  if (span.style != null) yield span.style!;
  if (span is TextSpan) {
    for (final child in span.children ?? const <InlineSpan>[]) {
      yield* _spanStyles(child);
    }
  }
}

double _contrast(Color foreground, Color background) {
  final light = foreground.computeLuminance();
  final dark = background.computeLuminance();
  return (light + 0.05) / (dark + 0.05);
}
