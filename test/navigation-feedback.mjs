import assert from 'node:assert/strict';
import test from 'node:test';
import { beginNavigation, endNavigation, failNavigation, navigationDisplay } from '../web/js/browser/navigation-feedback.js';
test('로딩 중에는 목적지를 보여주고 완료 주소는 그대로 보존한다', () => {
  const rec={url:'https://example.com/old'};
  beginNavigation(rec,'https://example.org/next');
  assert.equal(rec.url,'https://example.com/old');
  assert.deepEqual(navigationDisplay(rec),{url:'https://example.org/next',note:'여는 중… https://example.org/next'});
});
test('리다이렉트 목적지가 로딩 중에 표시되고 완료 시 실제 주소를 쓴다', () => {
  const rec={url:'https://example.com/'};
  beginNavigation(rec,'https://example.org/start'); beginNavigation(rec,'https://example.org/end');
  assert.equal(navigationDisplay(rec).url,'https://example.org/end');
  endNavigation(rec,'https://example.org/end');
  assert.deepEqual(navigationDisplay(rec),{url:'https://example.org/end',note:''});
});
test('옛 이동의 취소는 새 이동을 지우지 않는다', () => {
  const rec={url:'https://example.com/old'};
  beginNavigation(rec,'https://example.org/new');
  assert.equal(failNavigation(rec,'https://example.org/previous',true),false);
  assert.equal(rec.navigationState,'loading');
});
test('실패한 목적지는 stop-loading 뒤에도 보이고 다음 이동에서 해제된다', () => {
  const rec={url:'https://example.com/old'};
  beginNavigation(rec,'https://example.org/fail'); failNavigation(rec,'https://example.org/fail');
  endNavigation(rec,'https://example.com/old');
  assert.equal(navigationDisplay(rec).url,'https://example.org/fail');
  beginNavigation(rec,'https://example.org/retry');
  assert.equal(navigationDisplay(rec).url,'https://example.org/retry');
});
test('현재 이동 취소는 마지막 완료 주소로 돌아간다', () => {
  const rec={url:'https://example.com/old'};
  beginNavigation(rec,'https://example.org/new'); failNavigation(rec,'https://example.org/new',true);
  assert.deepEqual(navigationDisplay(rec),{url:'https://example.com/old',note:'이동을 취소했습니다.'});
});
// 분리 브라우저 창: 탭 상태를 다시 그릴 때 실패한 주소를 빈 주소로 덮고, 탭이 있으면 안내 줄을 숨겨
// 연결 거부 같은 실패가 흰 화면만 남겼다.
test('분리 창은 실패한 주소와 로드 실패 문구를 탭 다시 그리기 뒤에도 보인다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/js/browser/dock.js', import.meta.url), 'utf8');
  const { sliceBetween } = await import('../bin/slice-anchor.mjs');
  const fn = sliceBetween(src, 'export function reconcileBrowserMode', '\n}\n');
  assert.match(fn, /navigationDisplay\(active\)/);
  assert.doesNotMatch(fn, /urlInput\.value = isNewTab\(active\.url/);
  assert.match(fn, /bNote\.hidden = tabs\.length > 0 && !failure/);
  const factory = readFileSync(new URL('../web/js/browser/webview-factory.js', import.meta.url), 'utf8');
  assert.match(factory, /bNote\.textContent = getLoadFailure\(rec\.tabId\); bNote\.hidden = false;/);
});
