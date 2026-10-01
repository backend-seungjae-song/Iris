import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:iris_remote/remote/protocol.dart';

const int maximumRemoteFrameBytes = 64 * 1024;
const int maximumBrowserFrameBytes = 520 * 1024;
const int maximumBrowserDraftBytes = 400 * 1024;

int remoteInboundFrameLimit(String data) {
  if (utf8.encode(data).length <= maximumRemoteFrameBytes) {
    return maximumRemoteFrameBytes;
  }
  try {
    final decoded = jsonDecode(data);
    if (decoded is Map<String, dynamic>) {
      if (decoded['type'] == 'browser.frame') return maximumBrowserFrameBytes;
      if (decoded['type'] == 'browser.draft.result') {
        return maximumBrowserDraftBytes;
      }
    }
  } on FormatException {
    return maximumRemoteFrameBytes;
  }
  return maximumRemoteFrameBytes;
}

class PinnedClientException implements Exception {
  const PinnedClientException(this.kind);

  final String kind;
}

bool certificateMatchesPin({
  required String actualHost,
  required int actualPort,
  required Uint8List certificateDer,
  required String expectedHost,
  required int expectedPort,
  required String expectedSha256,
}) {
  return actualHost == expectedHost &&
      actualPort == expectedPort &&
      sha256.convert(certificateDer).toString() == expectedSha256;
}

class PinnedClient {
  const PinnedClient({this.connectionTimeout = const Duration(seconds: 10)});

  final Duration connectionTimeout;

  Future<PinnedConnection> connect({
    required String address,
    required int port,
    required String certHash,
  }) async {
    var certificateRejected = false;
    final context = SecurityContext(withTrustedRoots: false);
    final client = HttpClient(context: context)
      ..connectionTimeout = connectionTimeout
      ..badCertificateCallback = (certificate, host, certificatePort) {
        final accepted = certificateMatchesPin(
          actualHost: host,
          actualPort: certificatePort,
          certificateDer: certificate.der,
          expectedHost: address,
          expectedPort: port,
          expectedSha256: certHash,
        );
        certificateRejected = !accepted;
        return accepted;
      };
    try {
      final channel = await WebSocket.connect(
        'wss://$address:$port/',
        customClient: client,
        compression: CompressionOptions.compressionOff,
        maxPayloadLength: maximumBrowserFrameBytes,
      ).timeout(connectionTimeout);
      return PinnedConnection._(channel, client);
    } catch (_) {
      client.close(force: true);
      throw PinnedClientException(
        certificateRejected ? 'certificate-mismatch' : 'connection-failed',
      );
    }
  }
}

class PinnedConnection implements RemoteConnection {
  PinnedConnection._(this._channel, this._client) {
    _subscription = _channel.listen(
      _onData,
      onError: _onError,
      onDone: _onDone,
      cancelOnError: true,
    );
  }

  final WebSocket _channel;
  final HttpClient _client;
  final Queue<String> _messages = Queue<String>();
  final Queue<Completer<String>> _waiters = Queue<Completer<String>>();
  final Completer<void> _closed = Completer<void>();
  late final StreamSubscription<dynamic> _subscription;
  Object? _failure;
  bool _finished = false;

  @override
  Future<void> get closed => _closed.future;

  @override
  Future<String> receive() {
    if (_messages.isNotEmpty) return Future.value(_messages.removeFirst());
    if (_failure != null) return Future.error(_failure!);
    if (_finished) {
      return Future.error(const PinnedClientException('connection-closed'));
    }
    final waiter = Completer<String>();
    _waiters.add(waiter);
    return waiter.future;
  }

  @override
  void sendJson(Map<String, Object> message) {
    if (_finished) throw const PinnedClientException('connection-closed');
    final text = jsonEncode(message);
    if (utf8.encode(text).length > maximumRemoteFrameBytes) {
      throw const PinnedClientException('outbound-frame-too-large');
    }
    _channel.add(text);
  }

  @override
  Future<void> close() async {
    if (!_finished) {
      await _channel.close(WebSocketStatus.normalClosure);
    }
    await _subscription.cancel();
    _finish();
  }

  void _onData(dynamic data) {
    if (data is! String) {
      _reject(
        const PinnedClientException('binary-frame'),
        WebSocketStatus.unsupportedData,
      );
      return;
    }
    if (utf8.encode(data).length > remoteInboundFrameLimit(data)) {
      _reject(
        const PinnedClientException('frame-too-large'),
        WebSocketStatus.messageTooBig,
      );
      return;
    }
    if (_waiters.isNotEmpty) {
      _waiters.removeFirst().complete(data);
    } else {
      _messages.add(data);
    }
  }

  void _onError(Object error, StackTrace stackTrace) {
    _failure = error;
    while (_waiters.isNotEmpty) {
      _waiters.removeFirst().completeError(error, stackTrace);
    }
    _finish();
  }

  void _onDone() {
    final failure = _channel.closeReason == 'idle-timeout'
        ? const PinnedClientException('session-expired')
        : const PinnedClientException('connection-closed');
    while (_waiters.isNotEmpty) {
      _waiters.removeFirst().completeError(failure);
    }
    _failure = failure;
    _finish();
  }

  void _reject(Object error, int closeCode) {
    _failure = error;
    while (_waiters.isNotEmpty) {
      _waiters.removeFirst().completeError(error);
    }
    unawaited(_channel.close(closeCode).catchError((_) {}));
    _finish();
  }

  void _finish() {
    if (_finished) return;
    _finished = true;
    _client.close(force: true);
    if (!_closed.isCompleted) _closed.complete();
  }
}
