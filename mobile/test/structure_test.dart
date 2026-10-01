import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final lib = Directory('lib');
  final sources = lib
      .listSync(recursive: true)
      .whereType<File>()
      .where((file) => file.path.endsWith('.dart'))
      .toList();

  test('네트워크 생성 API는 pinned_client.dart에만 있다', () async {
    const forbidden = [
      'WebSocket',
      'HttpClient',
      'SecureSocket',
      'RawSocket',
      'Socket',
      'package:http',
    ];
    for (final file in sources.where(
      (file) => !file.path.endsWith('remote/pinned_client.dart'),
    )) {
      final text = await file.readAsString();
      for (final token in forbidden) {
        expect(text, isNot(contains(token)), reason: '${file.path}: $token');
      }
    }
  });

  test('MethodChannel은 연결 키·연결 유지·Tailscale 스토어 파일에만 있다', () async {
    for (final file in sources.where(
      (file) =>
          !file.path.endsWith('remote/connection_key.dart') &&
          !file.path.endsWith('remote/keepalive.dart') &&
          !file.path.endsWith('remote/tailscale_store.dart'),
    )) {
      expect(
        await file.readAsString(),
        isNot(contains('MethodChannel')),
        reason: file.path,
      );
    }
  });

  test('SharedPreferences는 pairing_store.dart에만 있다', () async {
    for (final file in sources.where(
      (file) => !file.path.endsWith('store/pairing_store.dart'),
    )) {
      expect(
        await file.readAsString(),
        isNot(contains('SharedPreferences')),
        reason: file.path,
      );
    }
  });

  test('lib에는 파일이나 경로 쓰기 API가 없다', () async {
    final patterns = [
      RegExp(r'\bFile\s*\('),
      RegExp(r'\bDirectory\s*\('),
      RegExp(r'\.writeAs(?:String|Bytes)'),
      RegExp(r'\.create(?:Sync)?\s*\('),
      RegExp(r'\.delete(?:Sync)?\s*\('),
      RegExp(r'\.rename(?:Sync)?\s*\('),
    ];
    for (final file in sources) {
      final text = await file.readAsString();
      for (final pattern in patterns) {
        expect(text, isNot(matches(pattern)), reason: '${file.path}: $pattern');
      }
    }
  });
}
