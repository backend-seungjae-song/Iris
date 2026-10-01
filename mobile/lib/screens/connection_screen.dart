import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/flow.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/keepalive.dart' as remote_keepalive;
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_list_screen.dart';
import 'package:iris_remote/state/remote_state.dart';
import 'package:iris_remote/store/pairing_store.dart';

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({
    required this.settings,
    required this.remoteSession,
    required this.onUnregister,
    this.initialConnection,
    super.key,
  });

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
  int _lastRequestCount = -1;
  Timer? _retryTimer;
  DateTime? _retryUntil;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
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
    final initial = widget.initialConnection;
    if (initial != null) {
      _busy = true;
      _status = '연결 준비 중…';
      WidgetsBinding.instance.addPostFrameCallback((_) => _activate(initial));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
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
      _status = '폰 잠금을 확인한 뒤 PIN을 확인합니다.';
    });
    try {
      final connection = await widget.remoteSession.connect(
        widget.settings,
        pin: pin,
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
      _lastRequestCount = -1;
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

  void _onRemoteStateChanged() {
    final count = _state?.requests.length ?? 0;
    if (count == _lastRequestCount) return;
    _lastRequestCount = count;
    unawaited(_keepAlive.update(count).catchError((_) {}));
  }

  void _watchDisconnection(ActiveRemoteSession connection) {
    connection.disconnected.then((_) async {
      if (!mounted || !identical(_connection, connection)) return;
      _clearState();
      await _keepAlive.stop(disconnected: true);
      if (mounted) {
        setState(() {
          _connection = null;
          _status = connection.disconnectReason?.message ?? 'Mac과 연결이 끊겼습니다.';
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
    _lastRequestCount = -1;
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    if (_connection != null && state != null) {
      return AgentListScreen(
        state: state,
        onDisconnect: () => unawaited(_disconnect()),
        onUnregister: () => unawaited(_unregister()),
      );
    }
    return DisconnectedView(
      busy: _busy,
      status: _visibleStatus,
      retrySeconds: _retrySeconds,
      onConnect: () => unawaited(_openPinSheet()),
      onUnregister: _unregister,
    );
  }
}

class DisconnectedView extends StatelessWidget {
  const DisconnectedView({
    required this.busy,
    required this.status,
    required this.onConnect,
    required this.onUnregister,
    this.retrySeconds = 0,
    super.key,
  });

  final bool busy;
  final String status;
  final VoidCallback onConnect;
  final VoidCallback onUnregister;
  final int retrySeconds;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const IrisFlowHeader(title: 'Iris 원격'),
            Expanded(
              child: ListView(
                children: [
                  IrisConnectionPanel(
                    key: const Key('connection-panel'),
                    title: busy ? '연결 준비 중' : 'Mac과 연결 안 됨',
                    message: status,
                    actionLabel: retrySeconds > 0
                        ? '$retrySeconds초 후 다시 시도'
                        : 'Mac에 연결',
                    icon: busy ? 'lock-simple' : 'wifi-slash',
                    busy: busy,
                    onAction: retrySeconds > 0 ? null : onConnect,
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
          'Mac에서 정한 PIN을 입력하면 연결합니다. 이 폰에는 저장하지 않습니다.',
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
          'Mac의 Iris 원격 화면 → 접속 PIN에서 정하고 바꿉니다.',
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
