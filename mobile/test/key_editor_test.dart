import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/screens/terminal_screen.dart';

Future<TerminalKeyButton?> openEditor(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  TerminalKeyButton? result;
  await tester.pumpWidget(
    MaterialApp(
      theme: irisTheme(Brightness.dark),
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              onPressed: () async {
                result = await showIrisSheet<TerminalKeyButton>(
                  context: context,
                  builder: (_) => const TerminalKeyEditorSheet(),
                );
              },
              child: const Text('열기'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('열기'));
  await tester.pumpAndSettle();
  return result;
}

void main() {
  testWidgets('키를 고르기 전에는 추가할 수 없고 힌트를 값으로 쓰지 않는다', (tester) async {
    await openEditor(tester);
    expect(find.text('키를 고르세요'), findsOneWidget);
    final button = tester.widget<TextButton>(
      find.ancestor(
        of: find.text('키를 고르세요'),
        matching: find.byType(TextButton),
      ),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('보조키와 키를 차례로 골라 여러 키를 한 버튼에 담는다', (tester) async {
    TerminalKeyButton? saved;
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: irisTheme(Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                saved = await showIrisSheet<TerminalKeyButton>(
                  context: context,
                  builder: (_) => const TerminalKeyEditorSheet(),
                );
              },
              child: const Text('열기'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('열기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ctrl'));
    await tester.pump();
    await tester.ensureVisible(find.text('C'));
    await tester.pump();
    await tester.tap(find.text('C'));
    await tester.pump();
    await tester.ensureVisible(find.text('↵ Enter'));
    await tester.pump();
    await tester.tap(find.text('↵ Enter'));
    await tester.pump();
    await tester.tap(find.text('추가'));
    await tester.pumpAndSettle();
    expect(saved, isNotNull);
    expect(saved!.key, 'c');
    expect(saved!.modifiers.ctrl, isTrue);
    expect(saved!.then, hasLength(1));
    expect(saved!.then.single.key, 'Enter');
    expect(saved!.then.single.modifiers.ctrl, isFalse);
    expect(saved!.label, '⌃C ↵ Enter');
    final request = terminalKeysSetRequest(rid: 'r1', keys: [saved!]);
    final wire = (request['keys']! as List).single as Map;
    expect(wire['then'], [
      {
        'key': 'Enter',
        'modifiers': {
          'ctrl': false,
          'alt': false,
          'shift': false,
          'cmd': false,
        },
      },
    ]);
  });
}
