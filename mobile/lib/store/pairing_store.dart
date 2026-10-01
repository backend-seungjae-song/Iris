import 'dart:convert';

import 'package:iris_remote/remote/connection_key.dart';
import 'package:shared_preferences/shared_preferences.dart';

class PairingSettings {
  const PairingSettings({
    required this.address,
    required this.port,
    required this.certHash,
    required this.deviceId,
  });

  final String address;
  final int port;
  final String certHash;
  final String deviceId;

  Map<String, Object> toJson() => {
    'address': address,
    'port': port,
    'certHash': certHash,
    'deviceId': deviceId,
  };

  static PairingSettings? fromJson(Object? value) {
    if (value is! Map<String, dynamic> ||
        value.length != 4 ||
        !value.keys.every(
          const {'address', 'port', 'certHash', 'deviceId'}.contains,
        )) {
      return null;
    }
    final address = value['address'];
    final port = value['port'];
    final certHash = value['certHash'];
    final deviceId = value['deviceId'];
    if (address is! String ||
        !_isIpv4(address) ||
        port is! int ||
        port < 1 ||
        port > 65535 ||
        certHash is! String ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(certHash) ||
        deviceId is! String ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(deviceId)) {
      return null;
    }
    return PairingSettings(
      address: address,
      port: port,
      certHash: certHash,
      deviceId: deviceId,
    );
  }
}

class PairingStore {
  PairingStore({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  static const _key = 'iris.remote.pairing';
  final SharedPreferencesAsync _preferences;

  Future<PairingSettings?> load() async {
    final text = await _preferences.getString(_key);
    if (text == null) return null;
    try {
      return PairingSettings.fromJson(jsonDecode(text));
    } on FormatException {
      return null;
    }
  }

  Future<void> save(PairingSettings settings) =>
      _preferences.setString(_key, jsonEncode(settings.toJson()));

  Future<void> removeRegistration(ConnectionKey connectionKey) async {
    await connectionKey.deleteKey();
    await _preferences.remove(_key);
  }
}

bool _isIpv4(String value) {
  final parts = value.split('.');
  return parts.length == 4 &&
      parts.every((part) {
        if (part.isEmpty ||
            (part.length > 1 && part.startsWith('0')) ||
            !RegExp(r'^\d{1,3}$').hasMatch(part)) {
          return false;
        }
        return int.parse(part) <= 255;
      });
}
