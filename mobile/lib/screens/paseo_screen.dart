import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/store/pairing_store.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

// Mac 가 빌드한 Paseo 대화 화면을 웹뷰로 띄우고 대화 데이터를 postMessage 로 넣는 화면.
// 화면 내용은 Paseo 가 정하고 이 앱은 주소와 데이터만 준다

const _channelName = 'IrisChat';
// 화면이 보내는 iris-chat.ready · iris-chat.older 를 앱에 알린다. 부모 창이 없어 스스로에게 온다
const _shimScript =
    '''
(function () {
  if (window.__irisShim) return;
  window.__irisShim = true;
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.origin !== window.location.origin || !data) return;
    if (data.type === 'iris-chat.ready' || data.type === 'iris-chat.older') {
      $_channelName.postMessage(data.type);
    }
  });
  var last = 0;
  document.addEventListener('pointerdown', function () {
    var now = Date.now();
    if (now - last < 1000) return;
    last = now;
    $_channelName.postMessage('touch');
  }, true);
})();
''';

Uri paseoEnterUri(PairingSettings endpoint, String ticket) => Uri(
  scheme: 'https',
  host: endpoint.address,
  port: endpoint.port,
  path: '/.iris-paseo/enter',
  queryParameters: {'t': ticket},
);

// 웹뷰가 등록된 Mac 의 주소 밖으로 나가지 않게 한다
bool paseoNavigationAllowed(PairingSettings endpoint, String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  if (url == 'about:blank') return true;
  return uri.scheme == 'https' &&
      uri.host == endpoint.address &&
      uri.port == endpoint.port;
}

// 페어링 때 저장한 인증서와 같은 인증서만 통과
bool paseoCertificateAllowed(PairingSettings endpoint, Uint8List? der) =>
    der != null && sha256.convert(der).toString() == endpoint.certHash;

// 오류가 난 주소가 이 Mac 이고 인증서도 같을 때만 예외로 받는다
bool paseoSslErrorAllowed(
  PairingSettings endpoint,
  String url,
  Uint8List? der,
) =>
    paseoNavigationAllowed(endpoint, url) &&
    paseoCertificateAllowed(endpoint, der);

// 대화 하나의 화면 상태. 서버 푸시를 받아 메시지 목록을 만든다
class PaseoChatModel {
  PaseoChatModel(this.key);

  final String key;
  List<Map<String, dynamic>> messages = [];
  bool hasOlder = false;
  bool loadingOlder = false;
  bool loaded = false;
  String reason = '';

  // 대화를 연 응답보다 먼저 온 푸시를 key 가 같은 것만 골라 앞에서부터 반영한다
  void adoptEarly(List<ServerMessage> early) {
    for (final event in early) {
      apply(event);
    }
  }

  // 이 대화의 푸시를 반영했으면 true
  bool apply(ServerMessage event) {
    if (event is ChatFrame && event.key == key) {
      if (event.kind == 'missing' || event.kind == 'error') {
        if (!loaded) reason = event.reason;
        return true;
      }
      if (event.kind == 'append') {
        messages = [...messages, ...event.messages];
      } else {
        messages = [...event.messages];
        hasOlder = event.hasOlder ?? false;
      }
      loaded = true;
      reason = '';
      return true;
    }
    if (event is ChatOlder && event.key == key) {
      loadingOlder = false;
      hasOlder = event.hasOlder;
      messages = [...event.messages, ...messages];
      return true;
    }
    return false;
  }

  // 화면이 받는 iris-chat.state 의 state 값. paneId 는 서버가 이미지 요청에 쓰는 가짜 토큰이다
  Map<String, Object?> state({
    required String kind,
    required bool running,
    required bool light,
  }) => {
    'key': key,
    'paneId': key,
    'agentId': null,
    'kind': kind,
    'cwd': '',
    'messages': messages,
    'hasOlder': hasOlder,
    'loadingOlder': loadingOlder,
    'running': running,
    // 원격은 전송·첨부를 막아 두었으므로 화면이 입력창을 숨긴다
    'readOnly': true,
    'theme': light ? 'light' : 'dark',
  };
}

// 웹뷰에 넣을 스크립트. JSON 을 문자열로 한 번 더 감싸 따옴표·줄바꿈이 코드로 해석되지 않게 한다
String paseoPostScript(Map<String, Object?> state) {
  final payload = jsonEncode({'type': 'iris-chat.state', 'state': state});
  return 'window.postMessage(JSON.parse(${jsonEncode(payload)}), window.location.origin);';
}

class PaseoChatScreen extends StatefulWidget {
  const PaseoChatScreen({
    required this.session,
    required this.agent,
    super.key,
  });

  final ActiveRemoteSession session;
  final RemoteAgent agent;

  @override
  State<PaseoChatScreen> createState() => _PaseoChatScreenState();
}

class _PaseoChatScreenState extends State<PaseoChatScreen> {
  late final WebViewController _controller;
  StreamSubscription<ServerMessage>? _events;
  StreamSubscription<RemoteConnectionStatus>? _status;
  StreamSubscription<List<RemoteAgent>>? _agents;
  PaseoChatModel? _model;
  // 서버는 첫 프레임을 chat.open 응답보다 먼저 보낼 수 있어 응답 전에 온 푸시를 모아 둔다
  final List<ServerMessage> _early = [];
  PairingSettings? get _endpoint => widget.session.endpoint;
  String _phase = 'none';
  String _uiMessage = '';
  String? _error;
  bool _entered = false;
  bool _pageReady = false;
  bool _frameReady = false;
  bool _lostConnection = false;
  bool _running = false;
  int _attempt = 0;
  Timer? _resend;

  @override
  void initState() {
    super.initState();
    _running = widget.agent.status == 'working';
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(_channelName, onMessageReceived: _onChannel)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final endpoint = _endpoint;
            return endpoint != null &&
                    paseoNavigationAllowed(endpoint, request.url)
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onSslAuthError: (error) {
            final endpoint = _endpoint;
            final platform = error.platform;
            if (endpoint != null &&
                platform is AndroidSslAuthError &&
                paseoSslErrorAllowed(
                  endpoint,
                  platform.url,
                  error.certificate?.data,
                )) {
              error.proceed();
            } else {
              error.cancel();
            }
          },
          onPageFinished: (url) {
            if (!url.contains('/paseo-ui/')) return;
            _controller.runJavaScript(_shimScript);
            _pageReady = true;
            _pushState();
            _startResend();
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame != true || !mounted) return;
            setState(() => _error = '대화 화면을 불러오지 못했습니다.');
          },
        ),
      );
    _events = widget.session.chatEvents.listen(_onEvent);
    _status = widget.session.connectionStates.listen(_onConnection);
    _agents = widget.session.agents.listen((agents) {
      final current = agents
          .where((a) => a.ref == widget.agent.ref)
          .firstOrNull;
      final running = current?.status == 'working';
      if (running != _running) {
        _running = running;
        _pushState();
      }
    });
    unawaited(_pendingCleanup.then((_) => _start()));
  }

  // 화면이 ready 를 보내기 전에 상태를 받지 못할 수 있어, 확인될 때까지 짧게 반복해서 보낸다
  void _startResend() {
    _resend?.cancel();
    var count = 0;
    _resend = Timer.periodic(const Duration(milliseconds: 500), (timer) {
      if (_frameReady || ++count > 20) {
        timer.cancel();
        return;
      }
      _pushState();
    });
  }

  void _onChannel(JavaScriptMessage message) {
    switch (message.message) {
      case 'touch':
        widget.session.noteTouch();
      case 'iris-chat.ready':
        _frameReady = true;
        _pushState();
      case 'iris-chat.older':
        final model = _model;
        if (model == null || !model.hasOlder || model.loadingOlder) return;
        model.loadingOlder = true;
        _pushState();
        widget.session
            .chatOlder(model.key)
            .then<void>(
              (_) {},
              onError: (_) {
                model.loadingOlder = false;
                _pushState();
              },
            );
    }
  }

  void _onEvent(ServerMessage event) {
    if (event is ChatUi) {
      if (!mounted) return;
      setState(() {
        _phase = event.phase;
        _uiMessage = event.message;
      });
      if (event.phase == 'ready' && !_entered) unawaited(_enter());
      return;
    }
    final model = _model;
    if (model == null) {
      if (event is ChatFrame || event is ChatOlder) _early.add(event);
      return;
    }
    if (model.apply(event)) {
      if (mounted) setState(() {});
      _pushState();
    }
  }

  // 연결이 끊기면 서버가 쿠키와 대화를 거둔다. 다시 연결되면 처음부터 연다
  void _onConnection(RemoteConnectionStatus status) {
    if (status == RemoteConnectionStatus.reconnecting) {
      _lostConnection = true;
    } else if (_lostConnection) {
      _lostConnection = false;
      unawaited(_start());
    }
  }

  Future<void> _start() async {
    final attempt = ++_attempt;
    _entered = false;
    _pageReady = false;
    _frameReady = false;
    _resend?.cancel();
    if (!mounted) return;
    setState(() {
      _error = null;
      _phase = 'none';
      _uiMessage = '';
      _model = null;
      _early.clear();
    });
    try {
      if (_endpoint == null || !widget.session.supports('chat.open')) {
        throw const RemoteFailure('이 컴퓨터는 Paseo 대화를 열 수 없습니다.');
      }
      final opened = await widget.session.openChat(widget.agent.ref);
      if (!mounted || attempt != _attempt) return;
      final model = PaseoChatModel(opened.key)..adoptEarly(_early);
      _early.clear();
      setState(() => _model = model);
      _pushState();
    } on RemoteFailure catch (failure) {
      if (mounted && attempt == _attempt) {
        setState(() => _error = failure.message);
      }
    }
  }

  // 화면 빌드가 끝나면 티켓을 받아 쿠키를 심고 화면 주소를 연다
  Future<void> _enter() async {
    final endpoint = _endpoint;
    final attempt = _attempt;
    if (endpoint == null || _entered) return;
    _entered = true;
    try {
      final result = await widget.session.openPaseo();
      if (!mounted || attempt != _attempt) return;
      await _controller.loadRequest(paseoEnterUri(endpoint, result.ticket));
    } on RemoteFailure catch (failure) {
      if (mounted && attempt == _attempt) {
        setState(() => _error = failure.message);
      }
    }
  }

  void _pushState() {
    final model = _model;
    if (model == null || !_pageReady || !mounted) return;
    final light = Theme.of(context).brightness == Brightness.light;
    final state = model.state(
      kind: widget.agent.kind == 'codex' ? 'codex' : 'claude',
      running: _running,
      light: light,
    );
    _controller.runJavaScript(paseoPostScript(state));
  }

  @override
  void dispose() {
    _resend?.cancel();
    unawaited(_events?.cancel());
    unawaited(_status?.cancel());
    unawaited(_agents?.cancel());
    final key = _model?.key;
    if (key != null) {
      unawaited(
        widget.session.chatClose(key).then<void>((_) {}, onError: (_) {}),
      );
    }
    // 화면을 닫으면 쿠키와 저장소를 지운다. 다음에 열 때 새 티켓으로 다시 인증한다
    _pendingCleanup = _pendingCleanup.then((_) => _clear());
    super.dispose();
  }

  Future<void> _clear() async {
    try {
      await _controller.loadRequest(Uri.parse('about:blank'));
      await _controller.clearCache();
      await _controller.clearLocalStorage();
      await WebViewCookieManager().clearCookies();
    } catch (_) {}
  }

  String get _progress {
    if (_model == null) return '대화를 여는 중입니다';
    if (_phase == 'building') {
      return _uiMessage.isEmpty ? '대화 화면을 만드는 중입니다' : _uiMessage;
    }
    if (_phase == 'error') {
      return _uiMessage.isEmpty ? '대화 화면을 만들지 못했습니다' : _uiMessage;
    }
    if (_phase == 'none') return '대화 화면을 준비하는 중입니다';
    return '화면을 불러오는 중입니다';
  }

  bool get _showProgress => !_pageReady || (_model != null && !_model!.loaded);

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final reason = _model?.reason ?? '';
    final failure = _error ?? (_phase == 'error' ? _progress : null);
    return Scaffold(
      backgroundColor: colors.background,
      body: SafeArea(
        child: Column(
          children: [
            Container(
              key: const Key('paseo-header'),
              height: 58,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              color: colors.background,
              child: Row(
                children: [
                  IrisRoundButton(
                    icon: 'caret-left',
                    tooltip: '뒤로',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      widget.agent.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.foreground,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Stack(
                children: [
                  if (failure == null) WebViewWidget(controller: _controller),
                  if (failure == null && reason.isNotEmpty)
                    _Message(key: const Key('paseo-reason'), text: reason),
                  if (failure == null && reason.isEmpty && _showProgress)
                    Positioned.fill(
                      child: ColoredBox(
                        color: colors.background,
                        child: Center(
                          key: const Key('paseo-loading'),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const CircularProgressIndicator(),
                              const SizedBox(height: 12),
                              Text(
                                _progress,
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: colors.muted,
                                  fontSize: 13.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  if (failure != null)
                    _Message(
                      key: const Key('paseo-error'),
                      text: failure,
                      onRetry: _start,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// 화면 종료 정리는 앞 정리가 끝난 뒤에 하나씩 실행
Future<void> _pendingCleanup = Future<void>.value();

class _Message extends StatelessWidget {
  const _Message({required this.text, this.onRetry, super.key});

  final String text;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Positioned.fill(
      child: ColoredBox(
        color: colors.background,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  text,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colors.foreground, fontSize: 15),
                ),
                if (onRetry != null) ...[
                  const SizedBox(height: 16),
                  IrisButton(
                    key: const Key('paseo-retry'),
                    label: '다시 시도',
                    expand: false,
                    onPressed: onRetry,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
