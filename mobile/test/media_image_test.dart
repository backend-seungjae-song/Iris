import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/design/chat_tools.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/remote/pinned_client.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';

import 'design_fixture.dart';

// 1x1 투명 PNG
final Uint8List _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);
final String _ref = 'c' * 32;

class _Connection implements RemoteConnection {
  final StreamController<String> _incoming = StreamController<String>();
  late final StreamIterator<String> _iterator = StreamIterator(
    _incoming.stream,
  );
  final Completer<void> _closed = Completer<void>();
  final List<Map<String, Object>> sent = [];
  void Function(Map<String, Object>)? onSend;

  void add(Map<String, Object> message) => _incoming.add(jsonEncode(message));

  @override
  Future<void> get closed => _closed.future;

  @override
  void sendJson(Map<String, Object> message) {
    sent.add(message);
    onSend?.call(message);
  }

  @override
  Future<String> receive() async {
    if (await _iterator.moveNext()) return _iterator.current;
    throw StateError('closed');
  }

  @override
  Future<void> close() async {
    if (!_closed.isCompleted) _closed.complete();
    await _incoming.close();
    await _iterator.cancel();
  }
}

Widget _app(Widget child, {Future<Uint8List> Function(String)? load}) =>
    MaterialApp(
      theme: designTestTheme(Brightness.dark),
      home: Scaffold(
        body: IrisLinkScope(open: null, loadImage: load, child: child),
      ),
    );

void main() {
  test('media.image 요청과 응답 모양', () {
    expect(mediaImageRequest(rid: 'r1', media: _ref, offset: 7), {
      'type': 'media.image',
      'rid': 'r1',
      'media': _ref,
      'offset': 7,
    });
    expect(
      () => mediaImageRequest(rid: 'r1', media: 'x', offset: 0),
      throwsA(isA<ProtocolException>()),
    );
    final chunk = parseServerMessage(
      jsonEncode({
        'type': 'media.image.result',
        'rid': 'r1',
        'mime': 'image/png',
        'size': _png.length,
        'offset': 0,
        'data': base64Encode(_png),
      }),
    );
    expect(chunk, isA<MediaImageChunk>());
    expect((chunk as MediaImageChunk).bytes, _png);
    for (final bad in <Map<String, Object>>[
      {
        'type': 'media.image.result',
        'rid': 'r1',
        'mime': 'image/svg+xml',
        'size': 1,
        'offset': 0,
        'data': 'AA==',
      },
      {
        'type': 'media.image.result',
        'rid': 'r1',
        'mime': 'image/png',
        'size': 1,
        'offset': 0,
        'data': 'AAAA',
      },
    ]) {
      expect(() => parseServerMessage(jsonEncode(bad)), throwsA(anything));
    }
    // 큰 조각은 브라우저 화면과 같은 큰 프레임 한도
    final big = jsonEncode({
      'type': 'media.image.result',
      'data': 'A' * (300 * 1024),
    });
    expect(remoteInboundFrameLimit(big), maximumBrowserFrameBytes);
  });

  test('이미지는 offset 을 늘려 끝까지 이어 받고 한 번 받은 것은 다시 받지 않는다', () async {
    final connection = _Connection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['media.image'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final whole = Uint8List.fromList(List.generate(10, (i) => i));
    connection.onSend = (message) {
      if (message['type'] != 'media.image') return;
      final offset = message['offset']! as int;
      final part = whole.sublist(offset, (offset + 4).clamp(0, whole.length));
      connection.add({
        'type': 'media.image.result',
        'rid': message['rid']!,
        'mime': 'image/png',
        'size': whole.length,
        'offset': offset,
        'data': base64Encode(part),
      });
    };
    expect(await session.mediaImage(_ref), whole);
    expect(
      connection.sent
          .where((m) => m['type'] == 'media.image')
          .map((m) => m['offset']),
      [0, 4, 8],
    );
    expect(await session.mediaImage(_ref), whole);
    expect(connection.sent.where((m) => m['type'] == 'media.image').length, 3);
    await session.disconnect();
  });

  test('받은 이미지 바이트 총량이 48MiB 를 넘으면 오래된 것부터 다시 받는다', () async {
    final connection = _Connection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['media.image'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    // 한 장 20MiB 처럼 보이게 size 만 크게 하고 바이트는 조각마다 보냄
    const size = 20 << 20;
    final chunk = Uint8List(360 * 1024);
    connection.onSend = (message) {
      if (message['type'] != 'media.image') return;
      final offset = message['offset']! as int;
      final n = (size - offset).clamp(0, chunk.length);
      connection.add({
        'type': 'media.image.result',
        'rid': message['rid']!,
        'mime': 'image/png',
        'size': size,
        'offset': offset,
        'data': base64Encode(chunk.sublist(0, n)),
      });
    };
    int asked() =>
        connection.sent.where((m) => m['type'] == 'media.image').length;
    final a = 'a' * 32, b = 'b' * 32, c = 'c' * 32;
    await session.mediaImage(a);
    await session.mediaImage(b);
    final perImage = asked() ~/ 2;
    await session.mediaImage(c);
    await Future<void>.delayed(Duration.zero);
    // a 는 밀려나 다시 받고, c 는 남아 있어 다시 받지 않음
    await session.mediaImage(c);
    expect(asked(), perImage * 3);
    await session.mediaImage(a);
    expect(asked(), perImage * 4);
    await session.disconnect();
  });

  testWidgets('대화 속 iris-image 이미지는 그림으로 보이고 누르면 확대 화면이 열린다', (tester) async {
    final asked = <String>[];
    await tester.pumpWidget(
      _app(
        IrisMarkdown('이 화면\n\n![이미지](iris-image:$_ref)'),
        load: (media) async {
          asked.add(media);
          return _png;
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(asked, [_ref]);
    expect(find.byKey(const Key('media-image')), findsOneWidget);
    await tester.tap(find.byKey(const Key('media-image')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('media-image-viewer')), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    await tester.tap(find.byKey(const Key('media-image-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('media-image-viewer')), findsNothing);
  });

  testWidgets('받지 못한 이미지는 다시 시도할 수 있고 다른 주소 이미지는 받지 않는다', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      _app(
        const IrisMarkdown(
          '![a](iris-image:cccccccccccccccccccccccccccccccc)\n\n![b](https://example.com/x.png)\n\n![c](iris-media:dddddddddddddddddddddddddddddddd)',
        ),
        load: (media) async {
          calls++;
          if (calls == 1) throw StateError('끊김');
          return _png;
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('media-image-failed')), findsOneWidget);
    expect(find.textContaining('이미지: b'), findsOneWidget);
    // 파일 링크(iris-media)는 그림으로 받지 않음
    expect(find.textContaining('이미지: c'), findsOneWidget);
    await tester.tap(find.byKey(const Key('media-image-failed')));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.byKey(const Key('media-image')), findsOneWidget);
  });

  testWidgets('loadImage 가 없는 화면은 iris-image 이미지도 받지 않는다', (tester) async {
    await tester.pumpWidget(_app(IrisMarkdown('![이미지](iris-image:$_ref)')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('media-image')), findsNothing);
    expect(find.textContaining('이미지: 이미지'), findsOneWidget);
  });

  testWidgets('도구 결과의 이미지 주소는 글 대신 그림으로 보인다', (tester) async {
    final rows = buildToolRows([
      const TranscriptItem(role: 'tool', text: '{}', tool: 'Screenshot'),
      TranscriptItem(
        role: 'tool',
        text: '찍음\n![이미지](iris-image:$_ref)',
        tool: 'Screenshot',
      ),
    ]);
    await tester.pumpWidget(
      _app(
        SingleChildScrollView(child: IrisToolTable(rows: rows, live: false)),
        load: (_) async => _png,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Screenshot').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-tool-detail')), findsOneWidget);
    expect(find.textContaining('iris-image', findRichText: true), findsNothing);
    expect(find.byKey(const Key('media-image')), findsOneWidget);
  });
}
