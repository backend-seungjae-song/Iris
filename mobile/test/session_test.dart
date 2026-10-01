import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/pinned_client.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';

void main() {
  test('재연결 구독 응답의 화면을 추가 푸시 없이 바로 반영한다', () async {
    final first = _FakeConnection();
    final second = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['terminal.watch'],
      connection: first,
      pingInterval: const Duration(days: 1),
      resumeToken: 'a' * 43,
      resume: (_) async => ResumedRemoteConnection(
        connection: second,
        capabilities: const Capabilities(
          macName: 'Mac',
          requests: ['terminal.watch'],
        ),
        resumeToken: 'b' * 43,
      ),
    );
    Map<String, Object> frame(String rid, String text) => {
      'type': 'terminal.watch.result',
      'rid': rid,
      'agent': 'a' * 32,
      'revision': 0,
      'text': text,
      'truncated': false,
      'hash': 'c' * 64,
      'columns': 87,
      'rows': 44,
      'mouseMode': true,
    };
    final initial = session.watchTerminal('a' * 32);
    final request = await first.nextSent();
    first.add(frame(request['rid']! as String, '이전'));
    await initial;
    session.setForeground(false);
    first.fail(const PinnedClientException('connection-closed'));
    await Future<void>.delayed(Duration.zero);
    final restored = session.terminalFrames.first;
    final next = second.nextSent();
    session.setForeground(true);
    final watch = await next;
    expect(watch['type'], 'terminal.watch');
    second.add(frame(watch['rid']! as String, '새 화면'));
    final value = await restored;
    expect(value.text, '새 화면');
    expect(value.revision, 0);
    expect(value.hash, 'c' * 64);
    expect(value.columns, 87);
    expect(value.rows, 44);
    expect(value.mouseMode, isTrue);
    await session.disconnect();
  });

  test('rid가 같은 응답만 해당 요청을 완료한다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['agent.message'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final pending = session.messageAgent('a' * 32, '확인해 주세요');
    var completed = false;
    pending.then((_) => completed = true);
    final sent = await connection.nextSent();
    expect(sent['type'], 'agent.message');
    expect(sent['text'], '확인해 주세요');

    connection.add({
      'type': 'agent.message.result',
      'rid': 'other',
      'result': 'failed',
    });
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse);

    connection.add({
      'type': 'agent.message.result',
      'rid': sent['rid']!,
      'result': 'delivered',
    });
    expect((await pending).result, 'delivered');
    await session.disconnect();
  });

  test('푸시와 요청 응답을 다른 스트림으로 보낸다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['watch'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final agents = session.agents.first;
    connection.add({
      'type': 'agents',
      'agents': [
        {
          'ref': 'a' * 32,
          'name': '검사',
          'kind': 'codex',
          'status': 'working',
          'question': false,
          'space': 'iris',
          'spaceRef': 'b' * 32,
          'spaceOrder': 0,
          'sessionOrder': 0,
          'parent': null,
          'lastActivityAt': null,
          'can': {'stop': true, 'message': true},
        },
      ],
    });
    expect((await agents).single.name, '검사');
    await session.disconnect();
  });

  test('서버가 PIN 기한 만료로 닫으면 다시 PIN을 요구하는 이유를 보존한다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['watch'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    connection.fail(const PinnedClientException('session-expired'));
    await session.disconnected;
    expect(session.disconnectReason?.message, contains('PIN 기한'));
    expect(session.disconnectReason?.message, contains('접속 PIN'));
  });

  test('앱으로 돌아오면 남아 있는 소켓도 전면 ping으로 바로 확인한다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['ping'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    session.setForeground(false);
    session.setForeground(true);
    final sent = await connection.nextSent();
    final rid = sent['rid']! as String;
    expect(sent, {'type': 'ping', 'rid': rid, 'active': true});
    connection.add({'type': 'pong', 'rid': rid});
    await Future<void>.delayed(Duration.zero);
    await session.disconnect();
  });

  test('백그라운드 소켓 단절은 화면 세션을 닫지 않고 복귀 때 토큰으로 재개해 구독한다', () async {
    final first = _FakeConnection();
    final second = _FakeConnection();
    final tokens = <String>[];
    final session = ActiveRemoteSession.attach(
      capabilities: const ['watch'],
      connection: first,
      pingInterval: const Duration(days: 1),
      resumeToken: 'a' * 43,
      resume: (token) async {
        tokens.add(token);
        return ResumedRemoteConnection(
          connection: second,
          capabilities: const Capabilities(macName: 'Mac', requests: ['watch']),
          resumeToken: 'b' * 43,
        );
      },
    );
    session.watch();
    await first.nextSent();
    var disconnected = false;
    session.disconnected.then((_) => disconnected = true);
    session.setForeground(false);
    first.fail(const PinnedClientException('connection-closed'));
    await Future<void>.delayed(Duration.zero);
    expect(disconnected, isFalse);
    expect(tokens, isEmpty);

    session.setForeground(true);
    for (var index = 0; index < 10 && second.sent.isEmpty; index++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(tokens, ['a' * 43]);
    expect(second.sent.single['type'], 'watch');
    expect(disconnected, isFalse);
    await session.disconnect();
  });

  test('복귀 때 재개 토큰이 만료됐으면 PIN 화면으로 돌아갈 이유를 보존한다', () async {
    final first = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['watch'],
      connection: first,
      pingInterval: const Duration(days: 1),
      resumeToken: 'a' * 43,
      resume: (_) async => throw const RemoteFailure(
        'PIN 기한이 지나 다시 확인이 필요합니다. 접속 PIN을 입력하세요.',
        requiresPin: true,
      ),
    );
    session.setForeground(false);
    first.fail(const PinnedClientException('connection-closed'));
    await Future<void>.delayed(Duration.zero);
    session.setForeground(true);
    await session.disconnected;
    expect(session.disconnectReason?.requiresPin, isTrue);
    expect(session.disconnectReason?.message, contains('접속 PIN'));
  });

  test('대화 기록은 기본 요청보다 긴 한도를 쓰고 시간 초과 대상을 밝힌다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['transcript.page'],
      connection: connection,
      responseTimeout: const Duration(milliseconds: 1),
      transcriptTimeout: const Duration(milliseconds: 20),
      pingInterval: const Duration(days: 1),
    );
    final pending = session.transcriptPage('a' * 32);
    final sent = await connection.nextSent();
    expect(sent['type'], 'transcript.page');
    await expectLater(
      pending,
      throwsA(
        isA<RemoteFailure>()
            .having((failure) => failure.message, 'message', contains('대화 기록'))
            .having((failure) => failure.message, 'message', contains('30초')),
      ),
    );
    await session.disconnect();
  });

  test('서버 오류 코드는 원인과 Mac에서 할 일을 각각 표시한다', () async {
    const expected = <String, String>{
      'expired': '다시 시도',
      'forbidden': '목록을 새로 고친',
      'busy': '잠시 기다린',
      'limit-exceeded': '진행 중인 요청',
      'unsupported-request': '버전을 확인',
      'invalid-request': '다시 연결',
      'unavailable': '해당 기능 상태를 확인',
      'browser-controller-unavailable': '브라우저를 연 뒤',
      'browser-tab-unavailable': '해당 스페이스의 브라우저 창을 연 뒤',
      'browser-frame-unavailable': '해당 탭을 Mac에서 연 뒤',
      'browser-command-unavailable': '페이지 로딩 상태를 확인',
    };
    for (final entry in expected.entries) {
      final connection = _FakeConnection();
      final session = ActiveRemoteSession.attach(
        capabilities: const ['browser.tabs'],
        connection: connection,
        pingInterval: const Duration(days: 1),
      );
      final pending = session.browserTabs();
      final sent = await connection.nextSent();
      connection.add({
        'type': 'error',
        'rid': sent['rid']!,
        'error': {'code': entry.key},
      });
      await expectLater(
        pending,
        throwsA(
          isA<RemoteFailure>().having(
            (failure) => failure.message,
            entry.key,
            contains(entry.value),
          ),
        ),
      );
      await session.disconnect();
    }
  });

  test('요청이 몰려도 1초에 9개까지만 보내 서버 속도 제한으로 끊기지 않는다', () async {
    final connection = _CountingConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['transcript.page'],
      connection: connection,
      transcriptTimeout: const Duration(seconds: 5),
      pingInterval: const Duration(days: 1),
    );
    final pending = [
      for (var index = 0; index < 12; index++)
        session.transcriptPage('a' * 32).catchError((_) => throw 0),
    ];
    for (final item in pending) {
      unawaited(item.then((_) {}, onError: (_) {}));
    }
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(connection.sent.length, 9);
    await Future<void>.delayed(const Duration(milliseconds: 1000));
    expect(connection.sent.length, 12);
    await session.disconnect();
  });

  test('이동과 hover가 몰리면 전송 중 하나와 최신 대기값 하나만 남긴다', () async {
    final connection = _FakeConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['browser.mouse', 'browser.element.hover'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final moves = [
      for (var index = 0; index < 40; index++)
        session.browserMouse(
          'a' * 32,
          x: index.toDouble(),
          y: 20,
          width: 400,
          height: 800,
          action: 'move',
        ),
    ];
    final firstMove = await _sentAt(connection, 0);
    expect(firstMove['type'], 'browser.mouse');
    expect(session.debugQueuedReplaceableInputs, lessThanOrEqualTo(2));
    connection.add({
      'type': 'remote.action.result',
      'rid': firstMove['rid']!,
      'result': 'done',
    });
    final lastMove = await _sentAt(connection, 1);
    expect(lastMove['x'], 39.0);
    connection.add({
      'type': 'remote.action.result',
      'rid': lastMove['rid']!,
      'result': 'done',
    });
    await Future.wait(moves);
    expect(
      connection.sent.where((message) => message['type'] == 'browser.mouse'),
      hasLength(2),
    );

    final hovers = [
      for (var index = 0; index < 40; index++)
        session.hoverBrowserElement(
          'a' * 32,
          x: index.toDouble(),
          y: 30,
          width: 400,
          height: 800,
        ),
    ];
    final firstHover = await _sentAt(connection, 2);
    expect(firstHover['type'], 'browser.element.hover');
    expect(session.debugQueuedReplaceableInputs, lessThanOrEqualTo(2));
    connection.add(_hoverResponse(firstHover));
    final lastHover = await _sentAt(connection, 3);
    expect(lastHover['x'], 39.0);
    connection.add(_hoverResponse(lastHover));
    await Future.wait(hovers);
    expect(
      connection.sent.where(
        (message) => message['type'] == 'browser.element.hover',
      ),
      hasLength(2),
    );
    expect(session.debugQueuedReplaceableInputs, 0);
    await session.disconnect();
  });

  test('클릭과 키 입력은 요청한 개수와 각 입력의 순서를 보존한다', () async {
    final connection = _AutoRespondingConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['browser.mouse', 'browser.key'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final pending = <Future<Object?>>[];
    for (var index = 0; index < 3; index++) {
      pending.add(
        session.browserMouse(
          'a' * 32,
          x: index.toDouble(),
          y: 20,
          width: 400,
          height: 800,
          action: 'click',
        ),
      );
      pending.add(
        session.browserKey(
          'a' * 32,
          ['ArrowLeft', 'Enter', 'Backspace'][index],
          const KeyModifiers(),
        ),
      );
    }
    await Future.wait(pending);
    final clicks = connection.sent
        .where((message) => message['type'] == 'browser.mouse')
        .toList();
    final keys = connection.sent
        .where((message) => message['type'] == 'browser.key')
        .toList();
    expect(clicks.map((message) => message['x']), [0.0, 1.0, 2.0]);
    expect(keys.map((message) => message['key']), [
      'ArrowLeft',
      'Enter',
      'Backspace',
    ]);
    await session.disconnect();
  });

  test('결과를 기다리지 않는 구독 실패는 비동기 미처리 오류를 만들지 않는다', () async {
    final errors = <Object>[];
    await runZonedGuarded(() async {
      final connection = _ThrowingConnection();
      final session = ActiveRemoteSession.attach(
        capabilities: const ['watch', 'transcript.watch'],
        connection: connection,
        pingInterval: const Duration(days: 1),
      );
      session.watch();
      session.watchTranscript('a' * 32);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await session.disconnect();
    }, (error, _) => errors.add(error));
    expect(errors, isEmpty);
  });

  test('전송 차례를 기다리는 요청이 연결 종료로 실패해도 미처리 오류가 없다', () async {
    final errors = <Object>[];
    await runZonedGuarded(() async {
      final connection = _FakeConnection();
      final session = ActiveRemoteSession.attach(
        capabilities: const ['transcript.page'],
        connection: connection,
        pingInterval: const Duration(days: 1),
      );
      final pending = [
        for (var index = 0; index < 20; index++)
          session.transcriptPage('a' * 32),
      ];
      for (final request in pending) {
        unawaited(request.then<void>((_) {}, onError: (_) {}));
      }
      await Future<void>.delayed(const Duration(milliseconds: 20));
      connection.fail(const PinnedClientException('connection-closed'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await session.disconnect();
    }, (error, _) => errors.add(error));
    expect(errors, isEmpty);
  });
}

Map<String, Object> _hoverResponse(Map<String, Object> request) => {
  'type': 'browser.element.hover.result',
  'rid': request['rid']!,
  'viewport': {'width': 400, 'height': 800},
  'element': {
    'selector': 'button.save',
    'text': '저장',
    'rect': {'x': 10, 'y': 20, 'width': 30, 'height': 40},
  },
};

Future<Map<String, Object>> _sentAt(
  _FakeConnection connection,
  int index,
) async {
  for (
    var attempt = 0;
    attempt < 100 && connection.sent.length <= index;
    attempt++
  ) {
    await Future<void>.delayed(Duration.zero);
  }
  return connection.sent[index];
}

class _AutoRespondingConnection extends _FakeConnection {
  @override
  void sendJson(Map<String, Object> message) {
    super.sendJson(message);
    final type = message['type'];
    scheduleMicrotask(() {
      if (type == 'browser.mouse' || type == 'browser.key') {
        add({
          'type': 'remote.action.result',
          'rid': message['rid']!,
          'result': 'done',
        });
      }
    });
  }
}

class _ThrowingConnection implements RemoteConnection {
  final Completer<void> _closed = Completer<void>();

  @override
  Future<void> get closed => _closed.future;

  @override
  void sendJson(Map<String, Object> message) {
    throw const PinnedClientException('connection-closed');
  }

  @override
  Future<String> receive() => Completer<String>().future;

  @override
  Future<void> close() async {
    if (!_closed.isCompleted) _closed.complete();
  }
}

class _CountingConnection implements RemoteConnection {
  final StreamController<String> _incoming = StreamController<String>();
  final Completer<void> _closed = Completer<void>();
  final List<Map<String, Object>> sent = [];

  @override
  Future<void> get closed => _closed.future;

  @override
  void sendJson(Map<String, Object> message) => sent.add(message);

  @override
  Future<String> receive() async {
    await for (final value in _incoming.stream) {
      return value;
    }
    throw StateError('closed');
  }

  @override
  Future<void> close() async {
    if (!_closed.isCompleted) _closed.complete();
    await _incoming.close();
  }
}

class _FakeConnection implements RemoteConnection {
  final StreamController<String> _incoming = StreamController<String>();
  final StreamController<Map<String, Object>> _sent =
      StreamController<Map<String, Object>>();
  final Completer<void> _closed = Completer<void>();
  final List<Map<String, Object>> sent = [];
  late final StreamIterator<String> _iterator = StreamIterator(
    _incoming.stream,
  );

  @override
  Future<void> get closed => _closed.future;

  void add(Map<String, Object> message) => _incoming.add(jsonEncode(message));

  void fail(Object error) => _incoming.addError(error);

  Future<Map<String, Object>> nextSent() => _sent.stream.first;

  @override
  void sendJson(Map<String, Object> message) {
    sent.add(message);
    _sent.add(message);
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
    // 구독자 없는 단일 구독 스트림의 close 는 끝나지 않음
    unawaited(_sent.close());
  }
}
