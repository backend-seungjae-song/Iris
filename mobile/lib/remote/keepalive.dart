import 'package:flutter/services.dart';

class KeepAliveException implements Exception {
  const KeepAliveException(this.code, [this.message]);

  final String code;
  final String? message;

  @override
  String toString() => message ?? code;
}

class KeepAlive {
  const KeepAlive();

  static const MethodChannel _channel = MethodChannel('iris.remote/keepalive');

  Future<void> start() => _invoke('start');

  Future<void> update(int requestCount) =>
      _invoke('update', {'requestCount': requestCount});

  Future<void> stop({bool disconnected = false}) =>
      _invoke('stop', {'disconnected': disconnected});

  Future<void> _invoke(String method, [Object? arguments]) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on PlatformException catch (error) {
      throw KeepAliveException(error.code, error.message);
    }
  }
}
