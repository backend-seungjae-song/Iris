import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/diagnostics/app_log.dart';
import 'package:iris_remote/remote/connection_key.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/code_screen.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/screens/notification_navigation.dart';
import 'package:iris_remote/screens/qr_scanner_screen.dart';
import 'package:iris_remote/screens/pin_screen.dart';
import 'package:iris_remote/screens/start_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AppLog.install();
  runApp(const IrisRemoteApp());
}

class IrisRemoteApp extends StatefulWidget {
  const IrisRemoteApp({super.key});

  @override
  State<IrisRemoteApp> createState() => _IrisRemoteAppState();
}

class _IrisRemoteAppState extends State<IrisRemoteApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  final PairingStore _store = PairingStore();
  final ConnectionKey _connectionKey = const ConnectionKey();
  final RemoteSession _remoteSession = RemoteSession();
  PairingSettings? _settings;
  ActiveRemoteSession? _initialConnection;
  bool _loading = true;
  bool _pairing = false;
  String? _pairingError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    var settings = await _store.load();
    var notice = _pairingError;
    // 이전 버전에서 만든 연결 키는 잠금 해제를 요구해 새 키로 바꿈: 컴퓨터에 등록한 키가 사라지므로 다시 페어링
    if (settings != null && !await _connectionKeyExists()) {
      await _store.removeRegistration(_connectionKey);
      settings = null;
      notice = '연결 키가 새로 바뀌어 다시 페어링해야 합니다. 컴퓨터에서 이 폰을 지우고 QR 을 다시 스캔하세요.';
    }
    if (!mounted) return;
    setState(() {
      _settings = settings;
      _pairingError = notice;
      _loading = false;
    });
  }

  Future<bool> _connectionKeyExists() async {
    try {
      return await _connectionKey.hasKey();
    } on ConnectionKeyException {
      return true;
    }
  }

  Future<void> _scan() async {
    final qr = await _navigatorKey.currentState!.push<PairingQr>(
      MaterialPageRoute(builder: (_) => const QrScannerScreen()),
    );
    if (qr == null || !mounted) return;
    setState(() {
      _pairing = true;
      _pairingError = null;
    });
    try {
      final pending = await _remoteSession.pair(qr);
      if (!mounted) return;
      setState(() => _pairing = false);
      await _navigatorKey.currentState!.push<void>(
        MaterialPageRoute(
          builder: (_) => CodeScreen(
            pending: pending,
            onConfirm: () => _confirmPairing(pending),
          ),
        ),
      );
    } on RemoteFailure catch (error) {
      if (mounted) {
        setState(() {
          _pairing = false;
          _pairingError = error.message;
        });
      }
    }
  }

  Future<void> _confirmPairing(PendingPairing pending) async {
    final pin = await _navigatorKey.currentState!.push<String>(
      MaterialPageRoute(builder: (_) => const AccessPinScreen()),
    );
    if (pin == null) throw const RemoteFailure('접속 PIN 입력을 취소했습니다.');
    final connection = await _remoteSession.connect(
      pending.settings,
      pin: pin,
      onAuthenticated: () => _store.save(pending.settings),
      onResumeToken: _store.saveResumeToken,
    );
    if (!mounted) {
      await connection.disconnect();
      return;
    }
    setState(() {
      _settings = pending.settings;
      _initialConnection = connection;
    });
  }

  Future<void> _unregister(ActiveRemoteSession? connection) async {
    // Mac 기기 목록에서 먼저 지운다. 연결이 없거나 실패하면 폰만 지우고 Mac에서 직접 삭제하라고 알린다
    var serverRemoved = false;
    if (connection != null) {
      try {
        await connection.unregisterDevice();
        serverRemoved = true;
      } on Object catch (error) {
        AppLog.write('unregister', 'server removal failed: $error');
      }
    }
    await connection?.disconnect();
    try {
      await _store.removeRegistration(_connectionKey);
    } on ConnectionKeyException {
      throw const RemoteFailure('이 폰의 연결 키를 삭제하지 못했습니다. 다시 시도하세요.');
    }
    if (!mounted) return;
    setState(() {
      _settings = null;
      _initialConnection = null;
      _pairingError = serverRemoved
          ? null
          : '컴퓨터의 기기 목록에서는 지우지 못했습니다. Mac의 Iris 원격 화면에서 이 폰을 직접 삭제하세요.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: _navigatorKey,
      navigatorObservers: [
        NotificationNavigation.instance,
        AppLogNavigatorObserver(),
      ],
      builder: (context, child) => Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _remoteSession.noteTouch(),
        child: child,
      ),
      title: 'Iris 원격',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.system,
      theme: irisTheme(Brightness.light),
      darkTheme: irisTheme(Brightness.dark),
      home: _home(),
    );
  }

  Widget _home() {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final settings = _settings;
    if (settings == null) {
      return StartScreen(onScan: _scan, busy: _pairing, error: _pairingError);
    }
    final initialConnection = _initialConnection;
    _initialConnection = null;
    return ConnectionScreen(
      key: ValueKey(settings.deviceId),
      settings: settings,
      remoteSession: _remoteSession,
      store: _store,
      initialConnection: initialConnection,
      onUnregister: _unregister,
    );
  }
}
