import 'dart:typed_data';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/remote/pinned_client.dart';

void main() {
  test('host, port, DER 해시가 모두 같을 때만 인증서를 받는다', () {
    final der = Uint8List.fromList([1, 2, 3, 4]);
    final pin = sha256.convert(der).toString();

    expect(
      certificateMatchesPin(
        actualHost: '100.64.1.2',
        actualPort: 4293,
        certificateDer: der,
        expectedHost: '100.64.1.2',
        expectedPort: 4293,
        expectedSha256: pin,
      ),
      isTrue,
    );
    for (final mismatch in [
      ('100.64.1.3', 4293, pin),
      ('100.64.1.2', 4294, pin),
      ('100.64.1.2', 4293, '0' * 64),
    ]) {
      expect(
        certificateMatchesPin(
          actualHost: mismatch.$1,
          actualPort: mismatch.$2,
          certificateDer: der,
          expectedHost: '100.64.1.2',
          expectedPort: 4293,
          expectedSha256: mismatch.$3,
        ),
        isFalse,
      );
    }
  });

  test('수신 크기 상한은 브라우저 화면과 붙여넣기 결과에만 커진다', () {
    final frame = jsonEncode({
      'type': 'browser.frame',
      'jpeg': 'A' * (300 * 1024),
    });
    final draft = jsonEncode({
      'type': 'browser.draft.result',
      'content': '가' * (30 * 1024),
    });
    final generic = jsonEncode({'type': 'agents', 'data': 'A' * (70 * 1024)});
    String exactPayload(String type, String field, int maximum) {
      final empty = jsonEncode({'type': type, field: ''});
      return jsonEncode({
        'type': type,
        field: 'A' * (maximum - utf8.encode(empty).length),
      });
    }

    final exactFrame = exactPayload(
      'browser.frame',
      'jpeg',
      maximumBrowserFrameBytes,
    );
    final exactDraft = exactPayload(
      'browser.draft.result',
      'content',
      maximumBrowserDraftBytes,
    );
    expect(remoteInboundFrameLimit(frame), maximumBrowserFrameBytes);
    expect(remoteInboundFrameLimit(draft), maximumBrowserDraftBytes);
    expect(remoteInboundFrameLimit(generic), maximumRemoteFrameBytes);
    expect(utf8.encode(exactFrame).length, maximumBrowserFrameBytes);
    expect(utf8.encode(exactDraft).length, maximumBrowserDraftBytes);
    expect(
      utf8.encode(exactFrame).length <= remoteInboundFrameLimit(exactFrame),
      isTrue,
    );
    expect(
      utf8.encode('$exactDraft ').length <=
          remoteInboundFrameLimit('$exactDraft '),
      isFalse,
    );
  });
}
