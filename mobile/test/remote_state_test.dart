import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';

void main() {
  const firstAgent = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const secondAgent = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  test('세션을 바꾸면 이전 기록 페이지의 로딩 상태와 응답을 버린다', () async {
    final connection = _TranscriptConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['transcript.page', 'transcript.watch'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);

    final initial = state.selectAgent(firstAgent);
    final initialPage = await connection.nextRequest('transcript.page');
    connection.respondPage(
      initialPage,
      firstAgent,
      text: '첫 화면',
      before: 'cccccccccccccccccccccccccccccccc',
    );
    await initial;

    final earlier = state.loadEarlier();
    final earlierPage = await connection.nextRequest('transcript.page');
    expect(state.loadingEarlier, isTrue);

    final switched = state.selectAgent(secondAgent);
    expect(
      state.loadingEarlier,
      isFalse,
      reason: '새 세션은 이전 세션의 페이지 로딩 표시를 이어받지 않아야 한다.',
    );
    final secondPage = await connection.nextRequest('transcript.page');
    connection.respondPage(secondPage, secondAgent, text: '둘째 화면');
    await switched;

    connection.respondPage(earlierPage, firstAgent, text: '이전 첫 화면');
    await earlier;
    expect(state.transcript.map((item) => item.text), ['둘째 화면']);
    expect(state.loadingEarlier, isFalse);

    state.dispose();
    await session.disconnect();
  });

  test('같은 세션을 다시 열면 먼저 시작한 페이지 응답을 버린다', () async {
    final connection = _TranscriptConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['transcript.page', 'transcript.watch'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);

    final older = state.selectAgent(firstAgent);
    final olderPage = await connection.nextRequest('transcript.page');
    final newer = state.selectAgent(firstAgent);
    final newerPage = await connection.nextRequest('transcript.page');

    connection.respondPage(newerPage, firstAgent, text: '새 응답');
    await newer;
    connection.respondPage(olderPage, firstAgent, text: '늦은 응답');
    await older;

    expect(state.transcript.map((item) => item.text), ['새 응답']);
    expect(state.loadingTranscript, isFalse);

    state.dispose();
    await session.disconnect();
  });

  test('연결 종료로 폐기된 뒤 끝난 요청은 예외 없이 무시한다', () async {
    final connection = _TranscriptConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const ['transcript.page', 'transcript.watch'],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    final pending = state.selectAgent(firstAgent);
    final page = await connection.nextRequest('transcript.page');
    state.dispose();
    connection.respondPage(page, firstAgent, text: '늦은 응답');
    await expectLater(pending, completes);
    await session.disconnect();
  });

  test('한 세션 입력칸에 붙여넣기 칩 여러 개를 보관하고 전송 뒤 비운다', () async {
    final connection = _TranscriptConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const [],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);
    state.addBrowserDraft(
      firstAgent,
      BrowserDraftResult(
        rid: 'one',
        ref: '1' * 32,
        kind: 'element',
        summary: '저장 버튼',
        content: '[브라우저 요소]\n글자: 저장 버튼',
      ),
    );
    state.addBrowserDraft(
      firstAgent,
      BrowserDraftResult(
        rid: 'two',
        ref: '2' * 32,
        kind: 'record',
        summary: '5단계',
        content: '[폰 브라우저 조작 기록]\n1. 클릭',
      ),
    );

    expect(state.composerDraftsFor(firstAgent).map((draft) => draft.summary), [
      '저장 버튼',
      '5단계',
    ]);
    state.removeComposerDraft(firstAgent, '1' * 32);
    expect(state.composerDraftsFor(firstAgent).single.summary, '5단계');
    state.clearComposerDrafts(firstAgent);
    expect(state.composerDraftsFor(firstAgent), isEmpty);

    state.dispose();
    await session.disconnect();
  });

  test('에이전트별 입력 글을 메모리에서 따로 공유한다', () async {
    final connection = _TranscriptConnection();
    final session = ActiveRemoteSession.attach(
      capabilities: const [],
      connection: connection,
      pingInterval: const Duration(days: 1),
    );
    final state = RemoteState(session);

    state.setComposerText(firstAgent, '첫째 초안');
    state.setComposerText(secondAgent, '둘째 초안');
    expect(state.composerTextFor(firstAgent), '첫째 초안');
    expect(state.composerTextFor(secondAgent), '둘째 초안');

    state.setComposerText(firstAgent, '');
    expect(state.composerTextFor(firstAgent), isEmpty);
    expect(state.composerTextFor(secondAgent), '둘째 초안');

    state.dispose();
    await session.disconnect();
  });
}

class _TranscriptConnection implements RemoteConnection {
  final StreamController<String> _incoming = StreamController<String>();
  final Completer<void> _closed = Completer<void>();
  final List<Map<String, Object>> sent = [];
  late final StreamIterator<String> _iterator = StreamIterator(
    _incoming.stream,
  );

  @override
  Future<void> get closed => _closed.future;

  @override
  void sendJson(Map<String, Object> message) {
    sent.add(Map<String, Object>.from(message));
  }

  Map<String, Object> lastRequest(String type) =>
      sent.lastWhere((message) => message['type'] == type);

  // 전송 간격 조절 대기열을 비운 뒤 마지막 요청
  Future<Map<String, Object>> nextRequest(String type) async {
    await pumpEventQueue();
    return lastRequest(type);
  }

  void respondPage(
    Map<String, Object> request,
    String agent, {
    required String text,
    String? before,
  }) {
    _incoming.add(
      jsonEncode({
        'type': 'transcript',
        'rid': request['rid'],
        'agent': agent,
        'items': [
          {'role': 'assistant', 'text': text},
        ],
        'before': before,
      }),
    );
  }

  @override
  Future<String> receive() async {
    if (await _iterator.moveNext()) return _iterator.current;
    throw const RemoteFailure('연결 종료');
  }

  @override
  Future<void> close() async {
    await _incoming.close();
    if (!_closed.isCompleted) _closed.complete();
  }
}
