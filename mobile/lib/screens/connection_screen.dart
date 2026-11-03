import 'dart:async';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/keepalive.dart' as remote_keepalive;
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/remote/tailscale_store.dart';
import 'package:iris_remote/remote/response_notifications.dart';
import 'package:iris_remote/screens/notification_navigation.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/state/remote_state.dart';
import 'package:iris_remote/store/pairing_store.dart';

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({
    required this.settings,
    required this.remoteSession,
    required this.onUnregister,
    this.initialConnection,
    this.store,
    super.key,
  });

  // 재접속 토큰을 저장·읽는 곳. 없으면 매번 PIN 으로 연결
  final PairingStore? store;
  final PairingSettings settings;
  final RemoteSession remoteSession;
  final ActiveRemoteSession? initialConnection;
  final Future<void> Function(ActiveRemoteSession? connection) onUnregister;

  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen>
    with WidgetsBindingObserver {
  static const remote_keepalive.KeepAlive _keepAlive =
      remote_keepalive.KeepAlive();

  ActiveRemoteSession? _connection;
  RemoteState? _state;
  bool _busy = false;
  String _status = '연결 안 됨';
  String _macName = 'Mac';
  ResponseNotifications _notifications = ResponseNotifications();
  int _responseFocus = 0;
  int _lastNotificationCount = -1;
  Timer? _retryTimer;
  DateTime? _retryUntil;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _keepAlive.onOpenResponses(null);
    _retryTimer?.cancel();
    super.dispose();
  }

  int get _retrySeconds {
    final until = _retryUntil;
    if (until == null) return 0;
    final milliseconds = until.difference(DateTime.now()).inMilliseconds;
    return milliseconds <= 0 ? 0 : (milliseconds / 1000).ceil();
  }

  String get _visibleStatus {
    final seconds = _retrySeconds;
    return seconds > 0 ? '$_status · $seconds초 후 다시 시도하세요.' : _status;
  }

  void _clearRetry() {
    _retryTimer?.cancel();
    _retryTimer = null;
    _retryUntil = null;
  }

  void _showFailure(RemoteFailure error) {
    _clearRetry();
    final retryAfter = error.retryAfter;
    if (retryAfter != null && retryAfter > Duration.zero) {
      _retryUntil = DateTime.now().add(retryAfter);
      _retryTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        if (_retrySeconds == 0) _clearRetry();
        setState(() {});
      });
    }
    setState(() => _status = error.message);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(const TailscaleStore().setActive(true));
    _keepAlive.onOpenResponses(_openResponses);
    unawaited(_takeOpenResponses());
    final initial = widget.initialConnection;
    if (initial != null) {
      _busy = true;
      _status = '연결 준비 중…';
      WidgetsBinding.instance.addPostFrameCallback((_) => _activate(initial));
    } else if (widget.store != null) {
      unawaited(_resumeStored());
    }
  }

  // 앱을 다시 열었을 때 마지막 행동 뒤 10분 안이면 PIN 없이 이어서 연결
  Future<void> _resumeStored() async {
    final store = widget.store!;
    final token = await store.loadResumeToken();
    if (token == null || !mounted) return;
    setState(() {
      _busy = true;
      _status = '이전 연결을 이어 가는 중…';
    });
    // 앱을 열면서 Tailscale 을 켜는 중이라 처음 몇 번은 통신이 안 될 수 있어 잠시 기다리며 다시 시도
    for (var attempt = 0; mounted; attempt++) {
      try {
        final connection = await widget.remoteSession.resume(
          widget.settings,
          token: token,
          onResumeToken: store.saveResumeToken,
        );
        await _activate(connection);
        break;
      } on RemoteFailure catch (error) {
        // 기한이 지났거나 거절된 토큰만 지우고, 잠깐의 통신 실패에는 남겨 다시 열 때 이어 감
        if (error.requiresPin) await store.saveResumeToken(null);
        final waiting =
            !error.requiresPin && error.retryAfter == null && attempt < 4;
        if (mounted) {
          setState(
            () => _status = error.requiresPin
                ? 'PIN 기한이 지나 다시 확인이 필요합니다. 접속 PIN을 입력하세요.'
                : waiting
                ? 'Tailscale 연결을 기다리는 중…'
                : error.message,
          );
        }
        if (!waiting) break;
        await Future<void>.delayed(Duration(seconds: 2 + attempt));
      }
    }
    if (mounted && _connection == null) setState(() => _busy = false);
  }

  // 화면을 하나씩 닫다가 맨 처음 화면에서 뒤로가기를 누르면 앱을 완전히 종료.
  // 백그라운드 연결과 Tailscale 도 함께 끔. 홈 키로 나가는 경우는 해당 없음
  @override
  Future<bool> didPopRoute() async {
    if (defaultTargetPlatform != TargetPlatform.android) return false;
    final connection = _connection;
    _connection = null;
    unawaited(_keepAlive.stop().catchError((_) {}));
    if (connection != null) unawaited(connection.disconnect());
    return const TailscaleStore().exitApp();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (foreground) unawaited(const TailscaleStore().setActive(true));
    _connection?.setForeground(foreground);
  }

  // 연결 버튼 → PIN 시트. 입력과 연결을 한 흐름으로 보이게
  Future<void> _openPinSheet() async {
    if (_busy || _retrySeconds > 0) return;
    await showIrisSheet<void>(
      context: context,
      builder: (_) => ConnectPinSheet(
        retrySeconds: () => _retrySeconds,
        onSubmit: _connectWithPin,
      ),
    );
  }

  // 성공이면 null, 실패면 시트에 보일 사유
  Future<String?> _connectWithPin(String pin) async {
    if (_retrySeconds > 0) return _visibleStatus;
    _clearRetry();
    setState(() {
      _busy = true;
      _status = 'PIN을 확인하는 중…';
    });
    try {
      final connection = await widget.remoteSession.connect(
        widget.settings,
        pin: pin,
        onResumeToken: widget.store?.saveResumeToken,
      );
      await _activate(connection);
      return _connection == null ? _status : null;
    } on RemoteFailure catch (error) {
      if (mounted) _showFailure(error);
      return error.message;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _activate(ActiveRemoteSession connection) async {
    RemoteState? state;
    try {
      await _keepAlive.start();
      state = RemoteState(connection);
      await state.initialize();
      if (!mounted) {
        state.dispose();
        await connection.disconnect();
        await _keepAlive.stop();
        return;
      }
      _connection = connection;
      connection.setForeground(
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
      );
      _state = state;
      _macName = state.macName;
      _notifications = ResponseNotifications();
      _lastNotificationCount = -1;
      state.addListener(_onRemoteStateChanged);
      _onRemoteStateChanged();
      setState(() {
        _status = '연결됨';
        _busy = false;
      });
      _watchDisconnection(connection);
    } on remote_keepalive.KeepAliveException catch (error) {
      state?.dispose();
      await connection.disconnect();
      if (mounted) {
        setState(() {
          _status = error.code == 'notification-denied'
              ? '알림 권한을 허용해야 연결을 유지할 수 있습니다.'
              : '연결 유지 서비스를 시작하지 못했습니다.';
          _busy = false;
        });
      }
    } on RemoteFailure catch (error) {
      state?.dispose();
      await connection.disconnect();
      await _keepAlive.stop();
      if (mounted) {
        setState(() {
          _status = error.message;
          _busy = false;
        });
      }
    }
  }

  Future<void> _takeOpenResponses() async {
    if (await _keepAlive.takeOpenResponses() && mounted) _openResponses();
  }

  void _openResponses() {
    if (!mounted) return;
    NotificationNavigation.instance.openResponses();
    setState(() => _responseFocus++);
  }

  void _onRemoteStateChanged() {
    final state = _state;
    if (state == null) return;
    final update = _notifications.update(
      responseItems(
        requests: state.requests,
        terminalQuestions:
            state.supports('terminal.watch') && state.supports('terminal.key')
            ? state.terminalQuestions
            : const [],
        agents: state.supports('terminal.watch') ? state.agents : const [],
      ),
      foreground:
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
      visibleAgent: NotificationNavigation.instance.visibleAgent,
    );
    if (!update.alert && update.count == _lastNotificationCount) return;
    _lastNotificationCount = update.count;
    unawaited(
      _keepAlive.update(update.count, alert: update.alert).catchError((_) {}),
    );
  }

  void _watchDisconnection(ActiveRemoteSession connection) {
    connection.disconnected.then((_) async {
      if (!mounted || !identical(_connection, connection)) return;
      _clearState();
      await _keepAlive.stop();
      if (mounted) {
        setState(() {
          _connection = null;
          _status = connection.disconnectReason?.message ?? '연결이 끊겼습니다.';
        });
      }
    });
  }

  Future<void> _disconnect() async {
    final connection = _connection;
    if (connection == null) return;
    _connection = null;
    _clearState();
    setState(() => _status = '연결 안 됨');
    await connection.disconnect();
    await _keepAlive.stop();
  }

  Future<void> _unregister() async {
    setState(() => _busy = true);
    final connection = _connection;
    _connection = null;
    _clearState();
    await _keepAlive.stop();
    try {
      await widget.onUnregister(connection);
    } on RemoteFailure catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _status = error.message;
        });
      }
    }
  }

  void _clearState() {
    final state = _state;
    if (state == null) return;
    // 연결 종료 시 위에 열린 대화·터미널·브라우저·시트 화면 닫기. 남겨 두면 폐기된 상태로 요청을 보내 아무 동작도 안 함
    if (mounted) {
      final route = ModalRoute.of(context);
      Navigator.of(context)
          .popUntil((current) => current == route || current.isFirst);
    }
    state.removeListener(_onRemoteStateChanged);
    state.dispose();
    _state = null;
    _notifications = ResponseNotifications();
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    if (_connection != null && state != null) {
      return AgentListScreen(
        responseFocus: _responseFocus,
        state: state,
        onDisconnect: () => unawaited(_disconnect()),
        onUnregister: () => unawaited(_unregister()),
      );
    }
    return DisconnectedView(
      name: _macName,
      busy: _busy,
      status: _visibleStatus,
      retrySeconds: _retrySeconds,
      onConnect: () => unawaited(_openPinSheet()),
      onUnregister: _unregister,
    );
  }
}

// 연결 안 된 홈. 머리글(이름 + 연결 끊김 칩) 아래 안내 카드, 맨 아래 등록 해제
class DisconnectedView extends StatelessWidget {
  const DisconnectedView({
    required this.busy,
    required this.status,
    required this.onConnect,
    required this.onUnregister,
    this.retrySeconds = 0,
    this.name = 'Mac',
    super.key,
  });

  final bool busy;
  final String status;
  final VoidCallback onConnect;
  final VoidCallback onUnregister;
  final int retrySeconds;
  final String name;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Container(
              constraints: const BoxConstraints(minHeight: 64),
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      name,
                      key: const Key('connection-name'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.foreground,
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.44,
                        height: 1.2,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  const IrisStatusChip(IrisStatus.off),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                children: [
                  _OfflineBanner(
                    key: const Key('connection-panel'),
                    busy: busy,
                    message: status == '연결 안 됨' ? null : status,
                    retrySeconds: retrySeconds,
                    onConnect: onConnect,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              child: Row(
                children: [
                  IrisButton(
                    label: '이 폰 등록 해제',
                    tone: IrisButtonTone.danger,
                    onPressed: busy ? null : onUnregister,
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

// 연결 끊김 안내 카드. 분홍 면 + 끊김 아이콘, 연결 중에는 진행 막대
class _OfflineBanner extends StatefulWidget {
  const _OfflineBanner({
    required this.busy,
    required this.message,
    required this.retrySeconds,
    required this.onConnect,
    super.key,
  });

  final bool busy;
  final String? message;
  final int retrySeconds;
  final VoidCallback onConnect;

  @override
  State<_OfflineBanner> createState() => _OfflineBannerState();
}

class _OfflineBannerState extends State<_OfflineBanner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _bar = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final move = widget.busy && !MediaQuery.disableAnimationsOf(context);
    if (move && !_bar.isAnimating) {
      _bar.repeat();
    } else if (!move) {
      _bar.stop();
    }
  }

  @override
  void didUpdateWidget(_OfflineBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    didChangeDependencies();
  }

  @override
  void dispose() {
    _bar.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final waiting = widget.retrySeconds > 0;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: colors.dangerTint,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: colors.pink.withValues(alpha: .3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: IrisIcon(
                  widget.busy ? 'lock-simple' : 'wifi-slash',
                  size: 20,
                  color: colors.dangerText,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.busy ? '연결 준비 중' : '연결이 끊겼습니다',
                      style: TextStyle(
                        color: colors.foreground,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.4,
                      ),
                    ),
                    if (widget.message != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          widget.message!,
                          style: TextStyle(
                            color: colors.foreground2,
                            fontSize: 13,
                            height: 1.45,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (widget.busy) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: Container(
                height: 4,
                color: colors.pink.withValues(alpha: .25),
                alignment: Alignment.centerLeft,
                child: AnimatedBuilder(
                  animation: _bar,
                  builder: (_, _) => FractionallySizedBox(
                    widthFactor: .4 + .6 * _bar.value,
                    child: Container(color: colors.dangerText),
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              IrisButton(
                expand: false,
                label: waiting
                    ? '${widget.retrySeconds}초 후 다시 시도'
                    : widget.busy
                    ? '연결 중…'
                    : '다시 연결',
                icon: waiting || widget.busy ? null : 'arrow-clockwise',
                onPressed: waiting || widget.busy ? null : widget.onConnect,
                height: 36,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// 연결 버튼이 여는 PIN 시트. 틀린 PIN·대기 시간은 시트 안에 두고 성공하면 닫힘
class ConnectPinSheet extends StatefulWidget {
  const ConnectPinSheet({
    required this.onSubmit,
    required this.retrySeconds,
    super.key,
  });

  final Future<String?> Function(String pin) onSubmit;
  final int Function() retrySeconds;

  @override
  State<ConnectPinSheet> createState() => _ConnectPinSheetState();
}

class _ConnectPinSheetState extends State<ConnectPinSheet> {
  final TextEditingController _controller = TextEditingController();
  bool _busy = false;
  String? _error;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_changed);
    _tickWhileWaiting();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _controller
      ..removeListener(_changed)
      ..dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  // 대기 초 표시 갱신. 대기가 끝나면 멈춤
  void _tickWhileWaiting() {
    _ticker?.cancel();
    if (widget.retrySeconds() <= 0) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      if (widget.retrySeconds() <= 0) timer.cancel();
      setState(() {});
    });
  }

  bool get _canSubmit =>
      !_busy &&
      widget.retrySeconds() == 0 &&
      RegExp(r'^\d{6,32}$').hasMatch(_controller.text);

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final pin = _controller.text;
    _controller.clear();
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.onSubmit(pin);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
    _tickWhileWaiting();
  }

  @override
  Widget build(BuildContext context) {
    final wait = widget.retrySeconds();
    return Column(
      key: const Key('connect-pin-sheet'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const IrisSheetGrabber(),
        const SizedBox(height: 18),
        Text(
          '접속 PIN',
          style: TextStyle(
            color: context.iris.foreground,
            fontSize: 20,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          '컴퓨터에서 정한 PIN을 입력하면 연결합니다. 이 폰에는 저장하지 않습니다.',
          style: TextStyle(
            color: context.iris.muted,
            fontSize: 14,
            height: 1.45,
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const Key('connection-pin-input'),
          controller: _controller,
          autofocus: true,
          enabled: !_busy && wait == 0,
          obscureText: true,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          autofillHints: null,
          enableSuggestions: false,
          autocorrect: false,
          maxLength: 32,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(
            labelText: 'PIN',
            hintText: '숫자 6자리 이상',
            counterText: '',
          ),
          onSubmitted: (_) => unawaited(_submit()),
        ),
        if (_error != null || wait > 0) ...[
          const SizedBox(height: 10),
          Text(
            [?_error, if (wait > 0) '$wait초 후 다시 시도할 수 있습니다.'].join(' '),
            key: const Key('connect-pin-error'),
            style: TextStyle(
              color: context.iris.blocked,
              fontSize: 14,
              height: 1.4,
            ),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          '컴퓨터의 Iris 원격 화면 → 접속 PIN에서 정하고 바꿉니다.',
          style: TextStyle(
            color: context.iris.faint,
            fontSize: 13,
            height: 1.4,
          ),
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            IrisButton(
              key: const Key('connect-pin-submit'),
              label: _busy
                  ? '연결 중…'
                  : wait > 0
                  ? '$wait초 후 다시 시도'
                  : '연결',
              tone: IrisButtonTone.primary,
              height: 52,
              onPressed: _canSubmit ? () => unawaited(_submit()) : null,
            ),
          ],
        ),
      ],
    );
  }
}
