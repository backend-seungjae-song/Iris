import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/paseo_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

void main() {
  final ticket = 'a' * 64;
  final der = Uint8List.fromList(List<int>.generate(40, (i) => i));
  final endpoint = PairingSettings(
    address: 'mac.test',
    port: 4443,
    certHash: sha256.convert(der).toString(),
    deviceId: 'd' * 32,
  );

  test('paseo.open 결과는 64자리 hex 티켓만 받는다', () {
    String message(Object? value) =>
        jsonEncode({'type': 'paseo.open.result', 'rid': '1', 'ticket': value});
    expect(parseServerMessage(message(ticket)), isA<PaseoOpenResult>());
    expect(() => parseServerMessage(message('A' * 64)), throwsA(anything));
    expect(() => parseServerMessage(message('abc')), throwsA(anything));
    expect(() => parseServerMessage(message(null)), throwsA(anything));
  });

  test('openPaseo 는 paseo.open 을 보내고 티켓을 돌려준다', () async {
    final connection = _Connection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['paseo.open'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final pending = session.openPaseo();
    final sent = await connection.nextSent();
    expect(sent['type'], 'paseo.open');
    expect(sent.keys.toSet(), {'type', 'rid'});
    connection.add({
      'type': 'paseo.open.result',
      'rid': sent['rid']!,
      'ticket': ticket,
    });
    expect((await pending).ticket, ticket);
    await session.disconnect();
  });

  test('티켓 주소는 등록된 Mac 의 https 주소와 포트를 쓴다', () {
    expect(
      paseoEnterUri(endpoint, ticket).toString(),
      'https://mac.test:4443/.iris-paseo/enter?t=$ticket',
    );
  });

  test('웹뷰는 등록된 Mac 의 주소 밖으로 이동하지 못한다', () {
    expect(paseoNavigationAllowed(endpoint, 'https://mac.test:4443/'), true);
    expect(paseoNavigationAllowed(endpoint, 'about:blank'), true);
    expect(paseoNavigationAllowed(endpoint, 'https://mac.test:4444/'), false);
    expect(paseoNavigationAllowed(endpoint, 'https://other.test:4443/'), false);
    expect(paseoNavigationAllowed(endpoint, 'http://mac.test:4443/'), false);
    expect(paseoNavigationAllowed(endpoint, 'https://example.com/'), false);
    expect(paseoNavigationAllowed(endpoint, 'javascript:alert(1)'), false);
    expect(paseoNavigationAllowed(endpoint, 'not a url'), false);
  });

  Map<String, Object?> msg(String id, [String role = 'assistant']) => {
    'id': id,
    'role': role,
    'ts': 1,
    'blocks': [
      {'type': 'text', 'text': '내용 $id'},
    ],
  };
  final key = 'b' * 32;

  test('chat.frame · chat.older · chat.ui 푸시는 모양이 맞을 때만 받는다', () {
    ServerMessage? parse(Map<String, Object?> value) =>
        parseServerMessage(jsonEncode(value));
    final frame = parse({
      'type': 'chat.frame',
      'key': key,
      'kind': 'snapshot',
      'messages': [msg('m1'), msg('m2', 'user')],
      'hasOlder': true,
    });
    expect(frame, isA<ChatFrame>());
    expect((frame as ChatFrame).messages.length, 2);
    expect(frame.hasOlder, true);
    expect(
      parse({
        'type': 'chat.frame',
        'key': key,
        'kind': 'missing',
        'reason': '없음',
      }),
      isA<ChatFrame>(),
    );
    expect(
      parse({
        'type': 'chat.older',
        'key': key,
        'messages': [msg('m0')],
        'hasOlder': false,
      }),
      isA<ChatOlder>(),
    );
    final ui = parse({
      'type': 'chat.ui',
      'phase': 'ready',
      'message': '',
      'version': 'v1',
      'url': '/paseo-ui/?v=v1',
    });
    expect((ui as ChatUi).url, '/paseo-ui/?v=v1');
    for (final bad in <Map<String, Object?>>[
      {'type': 'chat.frame', 'key': 'x', 'kind': 'append', 'messages': []},
      {'type': 'chat.frame', 'key': key, 'kind': 'weird', 'messages': []},
      {
        'type': 'chat.frame',
        'key': key,
        'kind': 'append',
        'messages': [
          {'id': 'a'},
        ],
      },
      {
        'type': 'chat.frame',
        'key': key,
        'kind': 'append',
        'messages': [],
        'extra': 1,
      },
      {
        'type': 'chat.ui',
        'phase': 'ready',
        'message': '',
        'url': 'https://evil.example/',
      },
      {'type': 'chat.older', 'key': key, 'messages': [], 'hasOlder': 'yes'},
    ]) {
      expect(() => parse(bad), throwsA(anything), reason: '$bad');
    }
  });

  test('openChat 은 chat.open 을 보내고 key 를 돌려준다', () async {
    final connection = _Connection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['chat.open'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final pending = session.openChat('a' * 32);
    final sent = await connection.nextSent();
    expect(sent['type'], 'chat.open');
    expect(sent['agent'], 'a' * 32);
    final events = <ServerMessage>[];
    session.chatEvents.listen(events.add);
    connection.add({'type': 'chat.ui', 'phase': 'building', 'message': '빌드 중'});
    connection.add({
      'type': 'chat.open.result',
      'rid': sent['rid']!,
      'key': key,
    });
    expect((await pending).key, key);
    await Future<void>.delayed(Duration.zero);
    expect(events.single, isA<ChatUi>());
    await session.disconnect();
  });

  test('대화 모델은 스냅샷·덧붙임·이전 대화를 순서대로 쌓는다', () {
    final model = PaseoChatModel(key);
    expect(
      model.apply(
        ChatFrame(key: 'c' * 32, kind: 'append', messages: [msg('x')]),
      ),
      false,
    );
    expect(
      model.apply(ChatFrame(key: key, kind: 'missing', reason: '기록 없음')),
      true,
    );
    expect(model.reason, '기록 없음');
    model.apply(
      ChatFrame(
        key: key,
        kind: 'snapshot',
        messages: [msg('m2')],
        hasOlder: true,
      ),
    );
    model.apply(ChatFrame(key: key, kind: 'append', messages: [msg('m3')]));
    expect(model.loaded, true);
    expect(model.reason, '');
    model.loadingOlder = true;
    model.apply(ChatOlder(key: key, messages: [msg('m1')], hasOlder: false));
    expect(model.messages.map((m) => m['id']), ['m1', 'm2', 'm3']);
    expect(model.hasOlder, false);
    expect(model.loadingOlder, false);
    final state = model.state(kind: 'codex', running: true, light: true);
    expect(state['paneId'], key);
    expect(state['readOnly'], true);
    expect(state['key'], key);
    expect(state['theme'], 'light');
    expect(state['cwd'], '');
  });

  test('open 응답보다 먼저 온 프레임도 같은 key 만 골라 반영한다', () {
    final model = PaseoChatModel(key)
      ..adoptEarly([
        ChatFrame(
          key: key,
          kind: 'snapshot',
          messages: [msg('m1')],
          hasOlder: true,
        ),
        ChatFrame(key: 'c' * 32, kind: 'append', messages: [msg('other')]),
        ChatFrame(key: key, kind: 'append', messages: [msg('m2')]),
      ]);
    expect(model.messages.map((m) => m['id']), ['m1', 'm2']);
    expect(model.hasOlder, true);
    expect(model.loaded, true);
  });

  test('reasoning 역할과 ts 가 없는 메시지도 받는다', () {
    final parsed = parseServerMessage(
      jsonEncode({
        'type': 'chat.frame',
        'key': key,
        'kind': 'snapshot',
        'messages': [
          {
            'id': 'r1',
            'role': 'reasoning',
            'ts': null,
            'blocks': [
              {'type': 'text', 'text': '생각'},
            ],
          },
        ],
      }),
    );
    expect((parsed as ChatFrame).messages.single['role'], 'reasoning');
  });

  test('웹뷰 스크립트는 따옴표와 줄바꿈이 있는 글도 데이터로만 넘긴다', () {
    final script = paseoPostScript({
      'messages': ['\"); alert(1); (\"\n</script>'],
    });
    expect(script.startsWith('window.postMessage(JSON.parse('), true);
    expect(script.contains('\n'), false);
    final inner = RegExp(r'JSON\.parse\((".*")\), window')
        .firstMatch(script)!
        .group(1)!;
    final payload =
        jsonDecode(jsonDecode(inner) as String) as Map<String, dynamic>;
    expect(payload['type'], 'iris-chat.state');
    expect(
      (payload['state']['messages'] as List).single,
      '\"); alert(1); (\"\n</script>',
    );
  });

  test('저장된 인증서와 같은 인증서만 통과한다', () {
    expect(paseoCertificateAllowed(endpoint, der), true);
    expect(
      paseoCertificateAllowed(endpoint, Uint8List.fromList([1, 2])),
      false,
    );
    expect(paseoCertificateAllowed(endpoint, null), false);
  });

  test('다른 주소의 오류는 같은 인증서여도 통과하지 못한다', () {
    expect(
      paseoSslErrorAllowed(endpoint, 'https://mac.test:4443/ws', der),
      true,
    );
    expect(
      paseoSslErrorAllowed(endpoint, 'https://other.test:4443/', der),
      false,
    );
    expect(
      paseoSslErrorAllowed(endpoint, 'https://mac.test:9999/', der),
      false,
    );
    expect(
      paseoSslErrorAllowed(endpoint, 'https://mac.test:4443/', null),
      false,
    );
  });
}

class _Connection implements RemoteConnection {
  final StreamController<String> _incoming = StreamController<String>();
  final StreamController<Map<String, Object>> _sent =
      StreamController<Map<String, Object>>();
  final Completer<void> _closed = Completer<void>();
  late final StreamIterator<String> _iterator = StreamIterator(
    _incoming.stream,
  );

  @override
  Future<void> get closed => _closed.future;

  void add(Map<String, Object> message) => _incoming.add(jsonEncode(message));

  Future<Map<String, Object>> nextSent() => _sent.stream.first;

  @override
  void sendJson(Map<String, Object> message) => _sent.add(message);

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
    unawaited(_sent.close());
  }
}
