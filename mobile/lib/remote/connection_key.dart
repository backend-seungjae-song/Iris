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

  // 이 기기에 현재 버전 연결 키가 있는지. 이전 버전 키는 지워짐
  Future<bool> hasKey() async {
    try {
      return await _channel.invokeMethod<bool>('hasKey') ?? false;
    } on PlatformException catch (error) {
      throw ConnectionKeyException(error.code, error.message);
    }
  }

  // 새 키는 잠금 해제를 요구하지 않아 즉시 끝남. 이전 호출부와의 호환용
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
