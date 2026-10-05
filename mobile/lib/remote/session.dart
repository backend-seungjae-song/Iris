import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:iris_remote/remote/connection_key.dart';
import 'package:iris_remote/remote/pinned_client.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/store/pairing_store.dart';

class RemoteFailure implements Exception {
  const RemoteFailure(
    this.message, {
    this.retryAfter,
    this.requiresPin = false,
  });

  final String message;
  final Duration? retryAfter;
  final bool requiresPin;

  @override
  String toString() => message;
}

enum RemoteConnectionStatus { connected, reconnecting }

class PendingPairing {
  const PendingPairing({required this.settings, required this.code});

  final PairingSettings settings;
  final String code;
}

class ActiveRemoteSession {
  ActiveRemoteSession._(
    this.macName,
    this.capabilities,
    RemoteConnection connection, {
    required this.responseTimeout,
    this._resumeToken,
    this._resume,
    this.pingInterval = const Duration(seconds: 30),
    this.transcriptTimeout = const Duration(seconds: 30),
    this.browserActionTimeout = const Duration(seconds: 120),
    this.browserFrameTimeout = const Duration(seconds: 75),
  }) : _connection = connection {
    unawaited(_readLoop(connection));
    _pingTimer = Timer.periodic(pingInterval, (_) => unawaited(_ping()));
  }

  factory ActiveRemoteSession.attach({
    String macName = '컴퓨터',
    required List<String> capabilities,
    required RemoteConnection connection,
    Duration responseTimeout = const Duration(seconds: 10),
    Duration pingInterval = const Duration(seconds: 30),
    Duration transcriptTimeout = const Duration(seconds: 30),
    Duration browserActionTimeout = const Duration(seconds: 120),
    Duration browserFrameTimeout = const Duration(seconds: 75),
    String? resumeToken,
    Future<ResumedRemoteConnection> Function(String token)? resume,
  }) => ActiveRemoteSession._(
    macName,
    List<String>.unmodifiable(capabilities),
    connection,
    responseTimeout: responseTimeout,
    pingInterval: pingInterval,
    transcriptTimeout: transcriptTimeout,
    browserActionTimeout: browserActionTimeout,
    browserFrameTimeout: browserFrameTimeout,
    resumeToken: resumeToken,
    resume: resume,
  );

  final String macName;
  final List<String> capabilities;
  RemoteConnection? _connection;
  String? _resumeToken;
  final Future<ResumedRemoteConnection> Function(String token)? _resume;
  final Duration responseTimeout;
  final Duration pingInterval;
  final Duration transcriptTimeout;
  final Duration browserActionTimeout;
  final Duration browserFrameTimeout;
  final StreamController<List<RemoteAgent>> _agents =
      StreamController<List<RemoteAgent>>.broadcast();
  final StreamController<List<RemoteRequest>> _requests =
      StreamController<List<RemoteRequest>>.broadcast();
  final StreamController<TranscriptAppend> _transcriptAppends =
      StreamController<TranscriptAppend>.broadcast();
  final StreamController<TerminalFrame> _terminalFrames =
      StreamController<TerminalFrame>.broadcast();
  final StreamController<BrowserFrame> _browserFrames =
      StreamController<BrowserFrame>.broadcast();
  final StreamController<RemoteConnectionStatus> _connectionStates =
      StreamController<RemoteConnectionStatus>.broadcast(sync: true);
  final Map<String, Completer<ServerMessage>> _pending = {};
  final Map<String, _CoalescingRequestQueue<RemoteActionResult>>
  _mouseRequests = {};
  final Map<String, _CoalescingRequestQueue<BrowserElementHoverResult>>
  _hoverRequests = {};
  final Completer<void> _disconnected = Completer<void>();
  late final Timer _pingTimer;
  var _nextRid = 1;
  bool _ending = false;
  bool _foreground = true;
  bool _recovering = false;
  int _connectionEpoch = 0;
  RemoteConnectionStatus _connectionStatus = RemoteConnectionStatus.connected;
  bool _watching = false;
  String? _transcriptAgent;
  String? _terminalAgent;
  _BrowserWatch? _browserWatch;
  RemoteFailure? _disconnectReason;

  Future<void> get disconnected => _disconnected.future;

  RemoteFailure? get disconnectReason => _disconnectReason;

  Stream<List<RemoteAgent>> get agents => _agents.stream;

  Stream<List<RemoteRequest>> get requests => _requests.stream;

  Stream<TranscriptAppend> get transcriptAppends => _transcriptAppends.stream;

  Stream<TerminalFrame> get terminalFrames => _terminalFrames.stream;

  Stream<BrowserFrame> get browserFrames => _browserFrames.stream;

  Stream<RemoteConnectionStatus> get connectionStates =>
      _connectionStates.stream;

  RemoteConnectionStatus get connectionStatus => _connectionStatus;

  int get debugQueuedReplaceableInputs => [
    ..._mouseRequests.values,
    ..._hoverRequests.values,
  ].fold(0, (total, queue) => total + queue.queued);

  bool supports(String request) => capabilities.contains(request);

  void watch() {
    _watching = true;
    unawaited(_sendPaced(watchRequest(_newRid())).catchError((_) {}));
  }

  void watchTranscript(String agent) {
    _transcriptAgent = agent;
    unawaited(
      _sendPaced(transcriptWatchRequest(rid: _newRid(), agent: agent))
          .catchError((_) {}),
    );
  }

  Future<TranscriptPage> transcriptPage(String agent, {String? before}) =>
      _request<TranscriptPage>(
        (rid) => transcriptPageRequest(rid: rid, agent: agent, before: before),
        timeout: transcriptTimeout,
        timeoutMessage:
            '컴퓨터가 대화 기록을 30초 안에 보내지 못했습니다. 컴퓨터에서 Iris가 응답하는지 확인한 뒤 다시 열어 주세요.',
      );

  Future<AgentStopResult> stopAgent(String agent) => _request<AgentStopResult>(
    (rid) => agentStopRequest(rid: rid, agent: agent),
  );

  Future<AgentMessageResult> messageAgent(
    String agent,
    String text, {
    List<String> drafts = const [],
  }) => _request<AgentMessageResult>(
    (rid) =>
        agentMessageRequest(rid: rid, agent: agent, text: text, drafts: drafts),
  );

  Future<RequestAnswerResult> answerPermission(
    String request, {
    required bool allow,
  }) => _request<RequestAnswerResult>(
    (rid) => permissionAnswerRequest(rid: rid, request: request, allow: allow),
  );

  Future<RequestAnswerResult> answerQuestions(
    String request,
    QuestionRequestBody body,
    List<QuestionResponse> responses,
  ) => _request<RequestAnswerResult>(
    (rid) => questionAnswerRequest(
      rid: rid,
      request: request,
      body: body,
      responses: responses,
    ),
  );

  Future<RequestAnswerResult> answerBrowserUser(
    String request, {
    required String choice,
  }) => _request<RequestAnswerResult>(
    (rid) =>
        browserUserAnswerRequest(rid: rid, request: request, choice: choice),
  );

  Future<TerminalWatchResult> watchTerminal(String agent) {
    _terminalAgent = agent;
    return _request<TerminalWatchResult>(
      (rid) => terminalWatchRequest(rid: rid, agent: agent),
    );
  }

  Future<RemoteActionResult> inputTerminal(String agent, String text) =>
      _request<RemoteActionResult>(
        (rid) => terminalInputRequest(rid: rid, agent: agent, text: text),
      );

  Future<RemoteActionResult> keyTerminal(
    String agent,
    String key,
    KeyModifiers modifiers,
  ) => _request<RemoteActionResult>(
    (rid) => terminalKeyRequest(
      rid: rid,
      agent: agent,
      key: key,
      modifiers: modifiers,
    ),
  );

  Future<RemoteActionResult> selectTerminal(
    String agent,
    String hash,
    int columns,
    int rows,
    int row,
  ) => _request<RemoteActionResult>(
    (rid) => terminalSelectRequest(
      rid: rid,
      agent: agent,
      hash: hash,
      columns: columns,
      rows: rows,
      row: row,
    ),
  );

  Future<RemoteActionResult> mouseTerminal(
    String agent,
    String hash,
    int columns,
    int rows,
    int column,
    int row,
    String action, {
    int? dy,
  }) => _request<RemoteActionResult>(
    (rid) => terminalMouseRequest(
      rid: rid,
      agent: agent,
      hash: hash,
      columns: columns,
      rows: rows,
      column: column,
      row: row,
      action: action,
      dy: dy,
    ),
  );

  Future<TerminalScrollback> terminalScrollback(String agent) =>
      _request<TerminalScrollback>(
        (rid) => {'type': 'terminal.scrollback', 'rid': rid, 'agent': agent},
      );

  Future<TerminalKeys> terminalKeys() =>
      _request<TerminalKeys>(terminalKeysGetRequest);

  Future<TerminalKeys> setTerminalKeys(List<TerminalKeyButton> keys) =>
      _request<TerminalKeys>(
        (rid) => terminalKeysSetRequest(rid: rid, keys: keys),
      );

  Future<BrowserTabsResult> browserTabs() =>
      _request<BrowserTabsResult>(browserTabsRequest);

  Future<BrowserFrameWatchResult> watchBrowserFrame(
    String tab, {
    required int width,
    int fps = 2,
    bool desktop = false,
  }) {
    _browserWatch = _BrowserWatch(tab, width, fps, desktop);
    return _request<BrowserFrameWatchResult>(
      (rid) => browserFrameWatchRequest(
        rid: rid,
        tab: tab,
        width: width,
        fps: fps,
        desktop: desktop,
      ),
      timeout: browserFrameTimeout,
      timeoutMessage: '컴퓨터가 브라우저 화면을 준비하지 못했습니다. Iris에서 해당 탭을 연 뒤 다시 시도하세요.',
    );
  }

  Future<RemoteActionResult> browserPointer(
    String tab, {
    required double x,
    required double y,
    required int width,
    required int height,
    String action = 'click',
  }) => _request<RemoteActionResult>(
    (rid) => browserPointerRequest(
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
      action: action,
    ),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 브라우저 조작을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
  );

  Future<RemoteActionResult?> browserMouse(
    String tab, {
    required double x,
    required double y,
    required int width,
    required int height,
    required String action,
    int? dy,
  }) {
    final queue = _mouseRequests.putIfAbsent(
      tab,
      _CoalescingRequestQueue<RemoteActionResult>.new,
    );
    return queue.add(
      () => _request<RemoteActionResult>(
        (rid) => browserMouseRequest(
          rid: rid,
          tab: tab,
          x: x,
          y: y,
          width: width,
          height: height,
          action: action,
          dy: dy,
        ),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 마우스 조작을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      ),
      replaceable: const {'move', 'drag', 'wheel'}.contains(action),
    );
  }

  Future<RemoteActionResult> browserType(String tab, String text) =>
      _request<RemoteActionResult>(
        (rid) => browserTypeRequest(rid: rid, tab: tab, text: text),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 브라우저 입력을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<RemoteActionResult> browserKey(
    String tab,
    String key,
    KeyModifiers modifiers,
  ) => _request<RemoteActionResult>(
    (rid) =>
        browserKeyRequest(rid: rid, tab: tab, key: key, modifiers: modifiers),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 브라우저 키 입력을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
  );

  Future<RemoteActionResult> browserScroll(String tab, int dy) =>
      _request<RemoteActionResult>(
        (rid) => browserScrollRequest(rid: rid, tab: tab, dy: dy),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 브라우저 스크롤을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<RemoteActionResult> browserHistory(String tab, String action) =>
      _request<RemoteActionResult>(
        (rid) => browserHistoryRequest(rid: rid, tab: tab, action: action),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 브라우저 이동을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<RemoteActionResult> browserNavigate(String tab, String url) =>
      _request<RemoteActionResult>(
        (rid) => browserNavigateRequest(rid: rid, tab: tab, url: url),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 주소 이동을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<RemoteActionResult> browserNewTab(
    String space, {
    String? url,
    String? title,
    String? profile,
    String? agent,
    String? media,
  }) => _request<RemoteActionResult>(
    (rid) => browserNewTabRequest(
      rid: rid,
      space: space,
      url: url,
      title: title,
      profile: profile,
      agent: agent,
      media: media,
    ),
  );

  Future<BrowserElementResult> browserElement(
    String tab, {
    required double x,
    required double y,
    required int width,
    required int height,
  }) => _request<BrowserElementResult>(
    (rid) => browserElementRequest(
      rid: rid,
      tab: tab,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 페이지 요소를 찾지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
  );

  Future<BrowserElementHoverResult?> hoverBrowserElement(
    String tab, {
    required double x,
    required double y,
    required int width,
    required int height,
  }) {
    final queue = _hoverRequests.putIfAbsent(
      tab,
      _CoalescingRequestQueue<BrowserElementHoverResult>.new,
    );
    return queue.add(
      () => _request<BrowserElementHoverResult>(
        (rid) => browserElementHoverRequest(
          rid: rid,
          tab: tab,
          x: x,
          y: y,
          width: width,
          height: height,
        ),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 가리킨 요소를 찾지 못했습니다.',
      ),
      replaceable: true,
    );
  }

  Future<BrowserDraftResult> pickBrowserElement(
    String tab,
    String agent, {
    required double x,
    required double y,
    required int width,
    required int height,
  }) => _request<BrowserDraftResult>(
    (rid) => browserElementPickRequest(
      rid: rid,
      tab: tab,
      agent: agent,
      x: x,
      y: y,
      width: width,
      height: height,
    ),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 선택한 요소를 준비하지 못했습니다.',
  );

  Future<BrowserFocusResult> browserFocus(String tab) =>
      _request<BrowserFocusResult>(
        (rid) => browserFocusRequest(rid: rid, tab: tab),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 페이지 입력 상태를 확인하지 못했습니다.',
      );

  Future<BrowserDialogResult> browserDialog(
    String tab, {
    String action = 'get',
    String? text,
  }) => _request<BrowserDialogResult>(
    (rid) =>
        browserDialogRequest(rid: rid, tab: tab, action: action, text: text),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 페이지 대화상자를 처리하지 못했습니다.',
  );

  Future<BrowserDraftResult> sendBrowserElement(
    String tab,
    String agent, {
    required double x,
    required double y,
    required int width,
    required int height,
    required String text,
  }) => _request<BrowserDraftResult>(
    (rid) => browserElementSendRequest(
      rid: rid,
      tab: tab,
      agent: agent,
      x: x,
      y: y,
      width: width,
      height: height,
      text: text,
    ),
    timeout: browserActionTimeout,
    timeoutMessage: '컴퓨터가 선택한 요소를 보내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
  );

  Future<BrowserRecordResult> startBrowserRecord(String tab) =>
      _request<BrowserRecordResult>(
        (rid) => browserRecordStartRequest(rid: rid, tab: tab),
      );

  Future<BrowserRecordResult> pauseBrowserRecord(bool paused) =>
      _request<BrowserRecordResult>(
        (rid) => browserRecordPauseRequest(rid: rid, paused: paused),
      );

  Future<BrowserDraftResult> finishBrowserRecord(
    String agent, {
    String? note,
  }) => _request<BrowserDraftResult>(
    (rid) => browserRecordFinishRequest(rid: rid, agent: agent, note: note),
  );

  Future<BrowserDraftResult> sendBrowserSketch(
    String agent,
    String tab,
    String image,
    String text,
  ) => _request<BrowserDraftResult>(
    (rid) => browserSketchSendRequest(
      rid: rid,
      agent: agent,
      tab: tab,
      image: image,
      text: text,
    ),
  );

  Future<RemoteActionResult> removeBrowserDraft(String ref) =>
      _request<RemoteActionResult>(
        (rid) => browserDraftRemoveRequest(rid: rid, ref: ref),
      );

  Future<BrowserProfilesResult> browserProfiles() =>
      _request<BrowserProfilesResult>(browserProfilesRequest);

  Future<RemoteActionResult> setBrowserProfile(String tab, String profile) =>
      _request<RemoteActionResult>(
        (rid) => browserProfileSetRequest(rid: rid, tab: tab, profile: profile),
      );

  Future<RemoteActionResult> setBrowserDesktop(String tab, bool enabled) =>
      _request<RemoteActionResult>(
        (rid) => browserDesktopRequest(rid: rid, tab: tab, enabled: enabled),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 브라우저 화면 크기를 바꾸지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<RemoteActionResult> translateBrowser(String tab) =>
      _request<RemoteActionResult>(
        (rid) => browserTranslateRequest(rid: rid, tab: tab),
        timeout: browserActionTimeout,
        timeoutMessage: '컴퓨터가 페이지 번역을 끝내지 못했습니다. 페이지 상태를 확인한 뒤 다시 시도하세요.',
      );

  Future<BrowserBookmarksResult> browserBookmarks(String space) =>
      _request<BrowserBookmarksResult>(
        (rid) => browserBookmarksRequest(rid: rid, space: space),
      );

  Future<RemoteActionResult> setBrowserBookmark(String tab, bool bookmarked) =>
      _request<RemoteActionResult>(
        (rid) => browserBookmarkSetRequest(
          rid: rid,
          tab: tab,
          bookmarked: bookmarked,
        ),
      );

  Future<RemoteActionResult> takeBrowserControl(String tab) =>
      _request<RemoteActionResult>(
        (rid) => browserDirectRequest(rid: rid, tab: tab),
      );

  Future<GitChangesResult> gitChanges(String agent) =>
      _request<GitChangesResult>(
        (rid) => gitChangesRequest(rid: rid, agent: agent),
      );

  Future<GitDiffResult> gitDiff(
    String agent,
    String file, {
    String view = 'working',
    String? base,
  }) => _request<GitDiffResult>(
    (rid) => gitDiffRequest(
      rid: rid,
      agent: agent,
      file: file,
      view: view,
      base: base,
    ),
  );

  Future<RemoteActionResult> draftGitDiff(
    String agent,
    String file,
    String side,
    int line,
    String text,
  ) => _request<RemoteActionResult>(
    (rid) => gitDiffDraftRequest(
      rid: rid,
      agent: agent,
      file: file,
      side: side,
      line: line,
      text: text,
    ),
  );

  Future<GitHubPrResult> githubPr(String agent) => _request<GitHubPrResult>(
    (rid) => githubPrRequest(rid: rid, agent: agent),
  );

  Future<GitHubCheckLogResult> githubCheckLog(String agent, String run) =>
      _request<GitHubCheckLogResult>(
        (rid) => githubCheckLogRequest(rid: rid, agent: agent, run: run),
      );

  Future<RemoteActionResult> draftGithubCheck(
    String agent,
    String run, {
    String? text,
  }) => _request<RemoteActionResult>(
    (rid) =>
        githubCheckDraftRequest(rid: rid, agent: agent, run: run, text: text),
  );

  Future<void> disconnect() => _terminate();

  void setForeground(bool value) {
    _foreground = value;
    if (value) unawaited(_checkForegroundConnection());
  }

  Future<void> _checkForegroundConnection() async {
    if (_ending) return;
    if (_connection == null) {
      await recoverNow();
      return;
    }
    await _ping();
  }

  Future<void> recoverNow() async {
    if (_ending || _connection != null || _resume == null || _recovering) {
      return;
    }
    _recovering = true;
    var attempt = 0;
    try {
      while (!_ending && _foreground && _connection == null) {
        if (attempt > 0) {
          final delayIndex = attempt > 6 ? 5 : attempt - 1;
          final seconds = [1, 2, 4, 8, 16, 30][delayIndex];
          await Future<void>.delayed(Duration(seconds: seconds));
          if (_ending || !_foreground || _connection != null) return;
        }
        attempt++;
        try {
          final token = _resumeToken;
          if (token == null) {
            await _terminate(
              const RemoteFailure(
                'PIN 기한이 지나 다시 확인이 필요합니다.',
                requiresPin: true,
              ),
            );
            return;
          }
          final resumed = await _resume(token);
          if (_ending) {
            await resumed.connection.close();
            return;
          }
          _resumeToken = resumed.resumeToken;
          _connection = resumed.connection;
          _connectionEpoch++;
          _recentSends.clear();
          _setConnectionStatus(RemoteConnectionStatus.connected);
          unawaited(_readLoop(resumed.connection));
          await _restoreSubscriptions();
          return;
        } on RemoteFailure catch (error) {
          if (error.requiresPin) {
            await _terminate(error);
            return;
          }
        } on Object {
          // 짧은 네트워크 단절은 다음 간격에 같은 메모리 토큰으로 다시 시도
        }
      }
    } finally {
      _recovering = false;
    }
  }

  Future<void> _restoreSubscriptions() async {
    if (_watching) watch();
    final transcript = _transcriptAgent;
    if (transcript != null) watchTranscript(transcript);
    final terminal = _terminalAgent;
    if (terminal != null) unawaited(_restoreTerminal(terminal));
    final browser = _browserWatch;
    if (browser != null) {
      unawaited(_restoreBrowser(browser));
    }
  }

  Future<void> _restoreTerminal(String agent) async {
    try {
      final result = await watchTerminal(agent);
      if (_terminalAgent != agent || _terminalFrames.isClosed) return;
      _terminalFrames.add(
        TerminalFrame(
          agent: result.agent,
          revision: result.revision,
          text: result.text,
          truncated: result.truncated,
          hash: result.hash,
          columns: result.columns,
          rows: result.rows,
          mouseMode: result.mouseMode,
          error: result.error,
        ),
      );
    } on Object {
      // 다음 화면 요청이나 재연결에서 다시 구독
    }
  }

  Future<void> _restoreBrowser(_BrowserWatch watch) async {
    try {
      await watchBrowserFrame(
        watch.tab,
        width: watch.width,
        fps: watch.fps,
        desktop: watch.desktop,
      );
    } on Object {
      // 다음 화면 요청이나 재연결에서 다시 구독
    }
  }

  void _send(Map<String, Object> message) {
    if (_ending) throw const RemoteFailure('컴퓨터과 연결이 끊겼습니다.');
    final connection = _connection;
    if (connection == null) {
      if (_foreground) unawaited(recoverNow());
      throw const RemoteFailure('컴퓨터과 다시 연결하고 있습니다. 잠시 후 다시 시도하세요.');
    }
    try {
      connection.sendJson(message);
    } catch (error) {
      unawaited(_connectionLost(connection, error));
      throw const RemoteFailure('컴퓨터과 다시 연결하고 있습니다. 잠시 후 다시 시도하세요.');
    }
  }

  // 서버 평균 초당 10개 제한 아래의 9개 전송과 네트워크 몰림 여유
  static const _sendsPerSecond = 9;
  final List<DateTime> _recentSends = [];
  Future<void> _paceTail = Future<void>.value();

  Future<void> _sendPaced(Map<String, Object> message) {
    final epoch = _connectionEpoch;
    final next = _paceTail.then((_) async {
      if (epoch != _connectionEpoch) {
        throw const RemoteFailure('컴퓨터과 다시 연결하고 있습니다. 잠시 후 다시 시도하세요.');
      }
      while (true) {
        final now = DateTime.now();
        _recentSends.removeWhere(
          (at) => now.difference(at) >= const Duration(seconds: 1),
        );
        if (_recentSends.length < _sendsPerSecond) break;
        await Future<void>.delayed(
          const Duration(seconds: 1) -
              now.difference(_recentSends.first) +
              const Duration(milliseconds: 5),
        );
        if (epoch != _connectionEpoch) {
          throw const RemoteFailure('컴퓨터과 다시 연결하고 있습니다. 잠시 후 다시 시도하세요.');
        }
      }
      _recentSends.add(DateTime.now());
      _send(message);
    });
    _paceTail = next.catchError((_) {});
    return next;
  }

  Future<T> _request<T extends ServerMessage>(
    Map<String, Object> Function(String rid) makeMessage, {
    Duration? timeout,
    String? timeoutMessage,
  }) async {
    final rid = _newRid();
    final completer = Completer<ServerMessage>();
    unawaited(completer.future.then<void>((_) {}, onError: (_) {}));
    _pending[rid] = completer;
    try {
      await _sendPaced(makeMessage(rid));
      final response = await completer.future.timeout(
        timeout ?? responseTimeout,
      );
      if (response is! T) {
        throw const RemoteFailure('컴퓨터가 요청과 다른 응답을 보냈습니다.');
      }
      return response;
    } on TimeoutException {
      throw RemoteFailure(timeoutMessage ?? '컴퓨터가 요청에 응답하지 않았습니다.');
    } finally {
      _pending.remove(rid);
    }
  }

  Future<void> _ping() async {
    if (_ending || _connection == null) {
      if (_foreground) unawaited(recoverNow());
      return;
    }
    try {
      await _request<Pong>((rid) => pingRequest(rid, active: _foreground));
    } catch (error) {
      final connection = _connection;
      if (connection != null) await _connectionLost(connection, error);
    }
  }

  Future<void> _readLoop(RemoteConnection connection) async {
    while (!_ending && identical(_connection, connection)) {
      try {
        final message = parseServerMessage(await connection.receive());
        _accept(message);
      } on ProtocolException {
        // 인증 뒤 알 수 없는 서버 메시지는 현재 상태를 바꾸지 않음
      } catch (error) {
        await _connectionLost(connection, error);
      }
    }
  }

  Future<void> _connectionLost(
    RemoteConnection connection,
    Object failure,
  ) async {
    if (_ending || !identical(_connection, connection)) return;
    _connection = null;
    _connectionEpoch++;
    _recentSends.clear();
    final error =
        failure is PinnedClientException && failure.kind == 'session-expired'
        ? const RemoteFailure(
            'PIN 기한이 지나 다시 확인이 필요합니다. 접속 PIN을 입력하세요.',
            requiresPin: true,
          )
        : const RemoteFailure('컴퓨터과 다시 연결하고 있습니다. 잠시 후 다시 시도하세요.');
    if (!error.requiresPin) {
      _setConnectionStatus(RemoteConnectionStatus.reconnecting);
    }
    for (final queue in _mouseRequests.values) {
      queue.cancelPending(error);
    }
    for (final queue in _hoverRequests.values) {
      queue.cancelPending(error);
    }
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    _pending.clear();
    try {
      await connection.close();
    } catch (_) {}
    if (error.requiresPin || _resume == null) {
      await _terminate(error);
    } else if (_foreground) {
      unawaited(recoverNow());
    }
  }

  void _accept(ServerMessage message) {
    switch (message) {
      case AgentsMessage():
        _agents.add(message.agents);
      case RequestsMessage():
        _requests.add(message.requests);
      case TranscriptAppend():
        _transcriptAppends.add(message);
      case TerminalFrame():
        _terminalFrames.add(message);
      case BrowserFrame():
        _browserFrames.add(message);
      case RemoteError():
        final rid = message.rid;
        if (rid != null) {
          final pending = _pending[rid];
          if (pending != null && !pending.isCompleted) {
            pending.completeError(_remoteError(message.code));
          }
        }
      case Pong():
        _complete(message.rid, message);
      case TranscriptPage():
        _complete(message.rid, message);
      case AgentStopResult():
        _complete(message.rid, message);
      case AgentMessageResult():
        _complete(message.rid, message);
      case RequestAnswerResult():
        _complete(message.rid, message);
      case RemoteActionResult():
        _complete(message.rid, message);
      case TerminalWatchResult():
        _complete(message.rid, message);
      case TerminalKeys():
        _complete(message.rid, message);
      case TerminalScrollback():
        _complete(message.rid, message);
      case BrowserTabsResult():
        _complete(message.rid, message);
      case BrowserFrameWatchResult():
        _complete(message.rid, message);
      case BrowserElementResult():
        _complete(message.rid, message);
      case BrowserElementHoverResult():
        _complete(message.rid, message);
      case BrowserFocusResult():
        _complete(message.rid, message);
      case BrowserDialogResult():
        _complete(message.rid, message);
      case BrowserDraftResult():
        _complete(message.rid, message);
      case BrowserRecordResult():
        _complete(message.rid, message);
      case BrowserProfilesResult():
        _complete(message.rid, message);
      case BrowserBookmarksResult():
        _complete(message.rid, message);
      case GitChangesResult():
        _complete(message.rid, message);
      case GitDiffResult():
        _complete(message.rid, message);
      case GitHubPrResult():
        _complete(message.rid, message);
      case GitHubCheckLogResult():
        _complete(message.rid, message);
      default:
        break;
    }
  }

  String _newRid() => 'r${_nextRid++}';

  void _setConnectionStatus(RemoteConnectionStatus value) {
    if (_connectionStatus == value || _connectionStates.isClosed) return;
    _connectionStatus = value;
    _connectionStates.add(value);
  }

  void _complete(String rid, ServerMessage message) {
    final pending = _pending[rid];
    if (pending != null && !pending.isCompleted) pending.complete(message);
  }

  Future<void> _terminate([Object? failure]) async {
    if (_ending) return;
    _ending = true;
    _connectionEpoch++;
    _recentSends.clear();
    if (failure is RemoteFailure) {
      _disconnectReason = failure;
    }
    _pingTimer.cancel();
    final error = failure ?? const RemoteFailure('컴퓨터과 연결이 끊겼습니다.');
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    _pending.clear();
    try {
      final connection = _connection;
      _connection = null;
      await connection?.close();
    } finally {
      await Future.wait([
        _agents.close(),
        _requests.close(),
        _transcriptAppends.close(),
        _terminalFrames.close(),
        _browserFrames.close(),
        _connectionStates.close(),
      ]);
      if (!_disconnected.isCompleted) _disconnected.complete();
    }
  }
}

class _QueuedRequest<T> {
  _QueuedRequest(this.run, this.replaceable);

  final Future<T> Function() run;
  final bool replaceable;
  final Completer<T?> completer = Completer<T?>();
}

class _CoalescingRequestQueue<T> {
  final ListQueue<_QueuedRequest<T>> _pending = ListQueue<_QueuedRequest<T>>();
  bool _running = false;

  int get queued => _pending.length + (_running ? 1 : 0);

  Future<T?> add(Future<T> Function() run, {required bool replaceable}) {
    final request = _QueuedRequest<T>(run, replaceable);
    if (replaceable && _pending.isNotEmpty && _pending.last.replaceable) {
      final replaced = _pending.removeLast();
      if (!replaced.completer.isCompleted) replaced.completer.complete(null);
    }
    _pending.add(request);
    unawaited(_drain());
    return request.completer.future;
  }

  void cancelPending(Object error) {
    while (_pending.isNotEmpty) {
      final request = _pending.removeFirst();
      if (!request.completer.isCompleted) {
        request.completer.completeError(error);
      }
    }
  }

  Future<void> _drain() async {
    if (_running) return;
    _running = true;
    try {
      while (_pending.isNotEmpty) {
        final request = _pending.removeFirst();
        try {
          final result = await request.run();
          if (!request.completer.isCompleted) {
            request.completer.complete(result);
          }
        } on Object catch (error, stackTrace) {
          if (!request.completer.isCompleted) {
            request.completer.completeError(error, stackTrace);
          }
        }
      }
    } finally {
      _running = false;
      if (_pending.isNotEmpty) unawaited(_drain());
    }
  }
}

class ResumedRemoteConnection {
  const ResumedRemoteConnection({
    required this.connection,
    required this.capabilities,
    required this.resumeToken,
  });

  final RemoteConnection connection;
  final Capabilities capabilities;
  final String resumeToken;
}

class _BrowserWatch {
  const _BrowserWatch(this.tab, this.width, this.fps, this.desktop);

  final String tab;
  final int width;
  final int fps;
  final bool desktop;
}

class RemoteSession {
  RemoteSession({
    PinnedClient? client,
    ConnectionKey? connectionKey,
    this.deviceName = 'Galaxy S',
    this.responseTimeout = const Duration(seconds: 10),
  }) : _client = client ?? const PinnedClient(),
       _connectionKey = connectionKey ?? const ConnectionKey();

  final PinnedClient _client;
  final ConnectionKey _connectionKey;
  final String deviceName;
  final Duration responseTimeout;

  Future<PendingPairing> pair(PairingQr qr) async {
    PinnedConnection? connection;
    try {
      final publicKey = await _connectionKey.publicKey();
      await _connectionKey.unlock();
      connection = await _client.connect(
        address: qr.address,
        port: qr.port,
        certHash: qr.certHash,
      );
      await _readChallenge(connection, qr.certHash);
      connection.sendJson(
        pairRequest(secret: qr.secret, publicKey: publicKey, name: deviceName),
      );
      final response = parseServerMessage(
        await connection.receive().timeout(responseTimeout),
      );
      if (response is RemoteError) throw _remoteError(response.code);
      if (response is! PairPending) {
        throw const RemoteFailure('컴퓨터가 페어링 코드를 보내지 않았습니다.');
      }
      return PendingPairing(
        settings: PairingSettings(
          address: qr.address,
          port: qr.port,
          certHash: qr.certHash,
          deviceId: response.deviceId,
        ),
        code: response.code,
      );
    } catch (error) {
      throw _friendlyFailure(error);
    } finally {
      await connection?.close();
    }
  }

  Future<ActiveRemoteSession> connect(
    PairingSettings settings, {
    required String pin,
    Future<void> Function()? onAuthenticated,
  }) async {
    final authenticated = await _openAuthenticated(
      settings,
      pin: pin,
      onAuthenticated: onAuthenticated,
    );
    return ActiveRemoteSession._(
      authenticated.capabilities.macName,
      List<String>.unmodifiable(authenticated.capabilities.requests),
      authenticated.connection,
      responseTimeout: responseTimeout,
      resumeToken: authenticated.resumeToken,
      resume: (token) => _openAuthenticated(settings, resumeToken: token),
    );
  }

  Future<ResumedRemoteConnection> _openAuthenticated(
    PairingSettings settings, {
    String? pin,
    String? resumeToken,
    Future<void> Function()? onAuthenticated,
  }) async {
    PinnedConnection? connection;
    try {
      if (pin != null) await _connectionKey.unlock();
      connection = await _client.connect(
        address: settings.address,
        port: settings.port,
        certHash: settings.certHash,
      );
      final challenge = await _readChallenge(connection, settings.certHash);
      final target = canonicalJsonBytes(
        challenge.signingTarget(settings.deviceId),
      );
      final signature = await _signWithOneUnlockRetry(target);
      connection.sendJson(
        authResponse(
          deviceId: settings.deviceId,
          signature: signature,
          resumeToken: resumeToken,
        ),
      );
      var authenticated = parseServerMessage(
        await connection.receive().timeout(responseTimeout),
      );
      if (authenticated is RemoteError) {
        throw _remoteError(authenticated.code);
      }
      if (authenticated is PinRequired) {
        if (pin == null) {
          throw const RemoteFailure(
            'PIN 기한이 지나 다시 확인이 필요합니다. 접속 PIN을 입력하세요.',
            requiresPin: true,
          );
        }
        connection.sendJson(pinSubmit(pin));
        authenticated = parseServerMessage(
          await connection.receive().timeout(responseTimeout),
        );
        if (authenticated is PinError) throw _pinError(authenticated);
        if (authenticated is RemoteError) {
          throw _remoteError(authenticated.code);
        }
      }
      if (authenticated is! AuthOk) {
        throw const RemoteFailure('컴퓨터가 접속 PIN을 확인하지 못했습니다.');
      }
      await onAuthenticated?.call();
      connection.sendJson(capsGet());
      final capabilities = parseServerMessage(
        await connection.receive().timeout(responseTimeout),
      );
      if (capabilities is RemoteError) {
        throw _remoteError(capabilities.code);
      }
      if (capabilities is! Capabilities) {
        throw const RemoteFailure('컴퓨터가 허용한 요청 목록을 보내지 않았습니다.');
      }
      final resumed = ResumedRemoteConnection(
        connection: connection,
        capabilities: capabilities,
        resumeToken: authenticated.resumeToken,
      );
      connection = null;
      return resumed;
    } catch (error) {
      throw _friendlyFailure(error);
    } finally {
      await connection?.close();
    }
  }

  Future<AuthChallenge> _readChallenge(
    PinnedConnection connection,
    String pin,
  ) async {
    final text = await connection.receive().timeout(responseTimeout);
    final Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException {
      throw const ProtocolException('컴퓨터가 올바른 연결 정보를 보내지 않았습니다.');
    }
    if (decoded is Map<String, dynamic> &&
        decoded['type'] == 'service.status') {
      final status = parseServerMessage(text);
      if (status is ServiceStatus) {
        throw switch (status.reason) {
          'pin-required' => const RemoteFailure(
            '컴퓨터의 Iris 원격 화면에서 접속 PIN을 정하세요. 저장하면 원격 제어가 다시 켜집니다.',
          ),
          'sharing-disabled' => const RemoteFailure(
            '컴퓨터에서 휴대폰 원격 제어가 꺼져 있습니다. Iris 원격 화면에서 켜세요.',
          ),
          _ => const RemoteFailure('컴퓨터에서 원격 연결을 사용할 수 없습니다.'),
        };
      }
    }
    return AuthChallenge.parse(decoded, pin: pin);
  }

  Future<String> _signWithOneUnlockRetry(List<int> bytes) async {
    try {
      return await _connectionKey.sign(Uint8List.fromList(bytes));
    } on ConnectionKeyException catch (error) {
      if (error.code != 'unlock-required') rethrow;
      await _connectionKey.unlock();
      return _connectionKey.sign(Uint8List.fromList(bytes));
    }
  }
}

RemoteFailure _pinError(PinError error) {
  final retryAfter = Duration(milliseconds: error.retryAfterMs);
  return switch (error.reason) {
    'incorrect' => RemoteFailure('PIN이 올바르지 않습니다.', retryAfter: retryAfter),
    'retry-later' => RemoteFailure('PIN 확인 대기 중', retryAfter: retryAfter),
    _ => const RemoteFailure('컴퓨터에서 접속 PIN을 확인하지 못했습니다.'),
  };
}

RemoteFailure _remoteError(String code) {
  return switch (code) {
    'expired' => const RemoteFailure('연결 확인 시간이 지났습니다. 다시 시도하세요.'),
    'forbidden' => const RemoteFailure(
      '컴퓨터에서 이 항목을 더 이상 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 선택하세요.',
    ),
    'busy' => const RemoteFailure('컴퓨터가 다른 요청을 처리하고 있습니다. 잠시 기다린 뒤 다시 시도하세요.'),
    'limit-exceeded' => const RemoteFailure(
      '컴퓨터의 원격 요청 한도에 도달했습니다. 진행 중인 요청이 끝난 뒤 다시 시도하세요.',
    ),
    'unsupported-request' => const RemoteFailure(
      '컴퓨터의 Iris가 이 요청을 지원하지 않습니다. 컴퓨터과 폰 앱의 버전을 확인하세요.',
    ),
    'invalid-request' => const RemoteFailure(
      '컴퓨터가 요청 형식을 이해하지 못했습니다. 컴퓨터과 폰 앱을 다시 연결하세요.',
    ),
    'browser-controller-unavailable' => const RemoteFailure(
      '컴퓨터의 Iris 브라우저 제어기가 연결되지 않았습니다. Iris 앱에서 브라우저를 연 뒤 다시 시도하세요.',
    ),
    'browser-tab-unavailable' => const RemoteFailure(
      '컴퓨터가 잠든 브라우저 탭을 열지 못했습니다. Iris에서 해당 스페이스의 브라우저 창을 연 뒤 다시 시도하세요.',
    ),
    'browser-frame-unavailable' => const RemoteFailure(
      '컴퓨터가 브라우저 화면을 만들지 못했습니다. 해당 탭을 컴퓨터에서 연 뒤 다시 시도하세요.',
    ),
    'browser-command-unavailable' => const RemoteFailure(
      '컴퓨터가 브라우저 조작을 끝내지 못했습니다. 페이지 로딩 상태를 확인한 뒤 다시 시도하세요.',
    ),
    'terminal-stale-screen' => const RemoteFailure(
      '화면이 바뀌었습니다. 새 화면에서 다시 누르세요.',
    ),
    'terminal-selection-unavailable' => const RemoteFailure(
      '항목을 확인하지 못했습니다. 키 버튼으로 선택하세요',
    ),
    'terminal-mouse-unavailable' => const RemoteFailure(
      '이 화면은 마우스 입력을 받지 않습니다',
    ),
    'terminal-frame-too-large' => const RemoteFailure(
      '터미널 화면이 48 KiB를 넘어 표시할 수 없습니다.',
    ),
    'terminal-layout-unavailable' => const RemoteFailure(
      '터미널 화면 크기를 확인할 수 없습니다. 다시 연결하세요.',
    ),
    'terminal-read-unavailable' => const RemoteFailure(
      '터미널 화면을 읽지 못했습니다. 컴퓨터에서 pane 상태를 확인하세요.',
    ),
    'unavailable' => const RemoteFailure(
      '컴퓨터에서 요청한 기능을 지금 사용할 수 없습니다. Iris에서 해당 기능 상태를 확인한 뒤 다시 시도하세요.',
    ),
    _ => const RemoteFailure('컴퓨터가 알 수 없는 오류를 보냈습니다. 컴퓨터과 폰 앱의 버전을 확인하세요.'),
  };
}

RemoteFailure _friendlyFailure(Object error) {
  if (error is RemoteFailure) return error;
  if (error is ProtocolException) return RemoteFailure(error.message);
  if (error is ConnectionKeyException) {
    return switch (error.code) {
      'no-lock-screen' => const RemoteFailure('폰 잠금(패턴·PIN·비밀번호)을 먼저 설정하세요.'),
      'unlock-canceled' => const RemoteFailure('폰 잠금 확인을 취소했습니다.'),
      'unlock-required' => const RemoteFailure('폰 잠금을 다시 확인하세요.'),
      _ => const RemoteFailure('이 폰에서 연결 키를 사용할 수 없습니다.'),
    };
  }
  if (error is PinnedClientException) {
    if (error.kind == 'certificate-mismatch') {
      return const RemoteFailure('컴퓨터의 인증서가 등록한 것과 다릅니다.');
    }
    return const RemoteFailure('컴퓨터에 연결하지 못했습니다. Tailscale 연결을 확인하세요.');
  }
  if (error is TimeoutException) {
    return const RemoteFailure('컴퓨터에 연결하지 못했습니다. Tailscale 연결을 확인하세요.');
  }
  return const RemoteFailure('컴퓨터에 연결하지 못했습니다. 다시 시도하세요.');
}
