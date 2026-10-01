import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLine } from '../scripts/private-traces.mjs';

test('공개 앱에 필요한 공식 호스트만 허용한다', () => {
  for (const host of ['schemas.android.com', 'play.google.com', 'flutter.dev', 'dart.dev', 'pub.dev', 'login.tailscale.com']) {
    assert.equal(scanLine(`https://${host}/example`).filter((reason) => reason.startsWith('허용 목록에 없는 호스트')).length, 0, host);
  }

  const unknown = ['https://', 'unlisted', '.', 'vendor', '.', 'dev'].join('');
  assert.ok(scanLine(unknown).some((reason) => reason.startsWith('허용 목록에 없는 호스트')));
  assert.ok(scanLine(['', 'Users', 'localperson', 'project'].join('/')).some((reason) => reason.startsWith('사람 홈 경로')));
});
