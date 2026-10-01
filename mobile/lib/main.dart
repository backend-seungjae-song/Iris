import 'package:flutter/material.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/connection_key.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/code_screen.dart';
import 'package:iris_remote/screens/connection_screen.dart';
import 'package:iris_remote/screens/qr_scanner_screen.dart';
import 'package:iris_remote/screens/pin_screen.dart';
import 'package:iris_remote/screens/start_screen.dart';
import 'package:iris_remote/store/pairing_store.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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
    final settings = await _store.load();
    if (!mounted) return;
    setState(() {
      _settings = settings;
      _loading = false;
    });
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
      _pairingError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: _navigatorKey,
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
      initialConnection: initialConnection,
      onUnregister: _unregister,
    );
  }
}
