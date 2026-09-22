import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const identity = require('../native/electron/browser-hardening.cjs');
const native = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Iris/0.1.0 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36';
const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
function fixture() {
  let handler, ua = native;
  const sess = { getUserAgent: () => ua, setUserAgent: value => { ua = value; },
    webRequest: { onBeforeSendHeaders: (_filter, callback) => { handler = callback; } } };
  identity.applyHardening(sess);
  return { sess, request(url, requestHeaders, resourceType = 'mainFrame', pageUserAgent) {
    let result;
    handler({ url, requestHeaders, webContentsId: 1, resourceType, ...(pageUserAgent ? { webContents: { getUserAgent: () => pageUserAgent } } : {}) }, value => { result = value.requestHeaders; });
    return result;
  } };
}
test('ordinary browsing declares the actual Electron runtime without the Iris mobile-detector token', () => {
  const ua = identity.cleanUserAgent(native);
  assert.match(ua, /Electron\/43\.2\.0/);
  assert.match(ua, /Chrome\/150\.0\.7871\.129/);
  assert.doesNotMatch(ua, /Iris\//);
});
test('ordinary request keeps the engine-provided hints, including their absence', () => {
  const f = fixture();
  const headers = { 'User-Agent': identity.cleanUserAgent(native), 'Sec-CH-UA': 'engine brands', Accept: 'text/html' };
  assert.deepEqual(f.request('https://example.test/', { ...headers }), headers);
  assert.deepEqual(f.request('https://example.test/', { Accept: 'text/html' }), { Accept: 'text/html' });
});
test('auth request gets Firefox compatibility with no Chromium hints; ordinary tabs remain unchanged', () => {
  const f = fixture();
  const base = f.sess.getUserAgent();
  const result = f.request('https://accounts.google.com/v3/signin/identifier', {
    'user-agent': base, 'Sec-CH-UA': 'Chromium', 'sec-ch-ua-platform': 'macOS', Accept: 'text/html',
  }, 'mainFrame', firefox);
  assert.equal(result['user-agent'], firefox);
  assert.equal(Object.keys(result).some(k => k.toLowerCase().startsWith('sec-ch-ua')), false);
  assert.equal(f.sess.getUserAgent(), base);
  assert.match(base, /Electron\//);
});
test('auth document cross-host resources keep a coherent Firefox header without Chromium hints', () => {
  const result = fixture().request('https://www.gstatic.com/auth.js', {
    'User-Agent': firefox, 'Sec-CH-UA-Arch': 'arm', Accept: '*/*',
  }, 'script');
  assert.deepEqual(result, { 'User-Agent': firefox, Accept: '*/*' });
});
test('imported Chrome branding cannot replace the configured local runtime identity', () => {
  identity.setNativeUserAgent(native);
  const f = fixture();
  identity.applyHardening(f.sess, 'Mozilla/5.0 Chrome/999.0.0.0 Edg/999.0.0.0');
  assert.equal(f.sess.getUserAgent(), identity.cleanUserAgent(native));
});

test('native popup first document already carries the Firefox wire header before the CDP override lands', () => {
  const f = fixture();
  const headers = { 'User-Agent': f.sess.getUserAgent(), 'Sec-CH-UA': 'native brands' };
  assert.deepEqual(f.request('https://accounts.google.com/', { ...headers }, 'mainFrame', f.sess.getUserAgent()), { 'User-Agent': firefox });
});
