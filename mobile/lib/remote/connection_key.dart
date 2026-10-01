import 'package:flutter/services.dart';

class ConnectionKeyException implements Exception {
  const ConnectionKeyException(this.code, [this.message]);

  final String code;
  final String? message;

  @override
  String toString() => message ?? code;
}

class ConnectionKey {
  const ConnectionKey();

  static const MethodChannel _channel = MethodChannel(
    'iris.remote/connection_key',
  );

  Future<String> publicKey() => _invokeString('publicKey');

  Future<void> unlock() => _invokeVoid('unlock');

  Future<String> sign(Uint8List bytes) =>
      _invokeString('sign', <String, Object>{'bytes': bytes});

  Future<void> deleteKey() => _invokeVoid('deleteKey');

  Future<String> _invokeString(String method, [Object? arguments]) async {
    try {
      final value = await _channel.invokeMethod<String>(method, arguments);
      if (value == null) throw const ConnectionKeyException('native-error');
      return value;
    } on PlatformException catch (error) {
      throw ConnectionKeyException(error.code, error.message);
    }
  }

  Future<void> _invokeVoid(String method, [Object? arguments]) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on PlatformException catch (error) {
      throw ConnectionKeyException(error.code, error.message);
    }
  }
}
