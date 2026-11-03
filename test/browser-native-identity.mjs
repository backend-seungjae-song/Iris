import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const identity = require('../native/electron/browser-hardening.cjs');
const native = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Iris/0.1.0 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36';
// 브라우저 세션에는 session.webRequest 리스너를 두지 않는다. 있으면 Electron 이 확장의 차단 규칙·webRequest 를 건너뛴다
function fixture() {
  let ua = native;
  const f = { webRequest: 0 };
  f.sess = { getUserAgent: () => ua, setUserAgent: value => { ua = value; },
    get webRequest() { f.webRequest++; return { onBeforeSendHeaders() {}, onBeforeRequest() {}, onHeadersReceived() {} }; } };
  identity.applyHardening(f.sess);
  return f;
}
test('ordinary browsing declares the actual Electron runtime without the Iris mobile-detector token', () => {
  const ua = identity.cleanUserAgent(native);
  assert.match(ua, /Electron\/43\.2\.0/);
  assert.match(ua, /Chrome\/150\.0\.7871\.129/);
  assert.doesNotMatch(ua, /Iris\//);
});
test('imported Chrome branding cannot replace the configured local runtime identity', () => {
  identity.setNativeUserAgent(native);
  const f = fixture();
  identity.applyHardening(f.sess, 'Mozilla/5.0 Chrome/999.0.0.0 Edg/999.0.0.0');
  assert.equal(f.sess.getUserAgent(), identity.cleanUserAgent(native));
});
test('hardening sets the engine identity without a session.webRequest listener', () => {
  const f = fixture();
  assert.equal(f.sess.getUserAgent(), identity.cleanUserAgent(native));
  assert.equal(f.webRequest, 0);
});
