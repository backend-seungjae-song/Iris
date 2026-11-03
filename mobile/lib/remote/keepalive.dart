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

  Future<void> update(int requestCount, {bool alert = false}) =>
      _invoke('update', {'requestCount': requestCount, 'alert': alert});

  void onOpenResponses(void Function()? callback) {
    _channel.setMethodCallHandler(
      callback == null
          ? null
          : (call) async {
              if (call.method == 'openResponses') callback();
            },
    );
  }

  Future<bool> takeOpenResponses() async =>
      await _channel.invokeMethod<bool>('takeOpenResponses') ?? false;

  Future<void> stop() => _invoke('stop');

  Future<void> _invoke(String method, [Object? arguments]) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on PlatformException catch (error) {
      throw KeepAliveException(error.code, error.message);
    }
  }
}
