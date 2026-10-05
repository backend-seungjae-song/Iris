import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPageTranslate, assetKind, fetchAsset } = require("../native/electron/page-translate.cjs");

function fixture(fetchOverride) {
  const host = {}, session = { preloads: [], registerPreloadScript(value) { this.preloads.push(value); } };
  const calls = [], network = [];
  const context = vm.createContext({ document: { documentElement: { lang: "en" }, body: { innerText: "Hello world" }, querySelector: () => null }, setTimeout, Date });
  context.window = context;
  context.fakeLibrary = { isAvailable: () => true, translatePage(source, target, callback) { calls.push({ source, target }); context.document.body.innerText = `translated ${target}`; callback(100, true, 0); }, restore() { context.document.body.innerText = "Hello world"; }, getDetectedLanguage: () => "en" };
  class Guest extends EventEmitter {
    id = 4; hostWebContents = host; session = session; url = "https://site.test/page"; scripts = []; styles = [];
    isDestroyed() { return false; }
    getType() { return "webview"; }
    getURL() { return this.url; }
    async executeJavaScriptInIsolatedWorld(world, scripts) {
      assert.equal(world, 1777); this.scripts.push(scripts[0].code);
      const result = vm.runInContext(scripts[0].code, context);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    }
    async insertCSS(text) { this.styles.push(text); }
  }
  const guest = new Guest();
  const app = new EventEmitter(); app.whenReady = async () => {};
  const deps = { app, isProfilePartition: p => p === "persist:acbrowser", sessionFromPartition: () => session, forEachHardened: visit => visit("persist:acbrowser"), onSessionHardened: () => () => {}, isTrustedSender: e => e.trusted && e.sender === host, webContents: { fromId: id => id === guest.id ? guest : null }, fetchImpl: async (url, options) => {
    network.push({ url, options });
    if (fetchOverride) return fetchOverride(url, options);
    return new Response("window.google={translate:{TranslateService:()=>fakeLibrary}};window.__irisTranslateReady();");
  } };
  const service = createPageTranslate(deps);
  const event = { trusted: true, sender: host };
  const call = payload => service.handle(event, { wc: guest.id, ...payload });
  return { service, call, guest, context, session, host, event, network, calls };
}

test("언어 감지는 로컬 IPC만 쓰고 소유한 프로필에 전용 preload를 등록한다", async () => {
  const f = fixture();
  assert.deepEqual(await f.call({ op: "detect" }), { ok: true, code: "detected", language: "en", text: "Hello world" });
  assert.equal(f.network.length, 0);
  assert.equal(f.session.preloads.length, 1);
  assert.match(f.session.preloads[0].filePath, /page-translate-preload\.cjs$/);
  assert.equal(f.session.preloads[0].type, "frame");
});

test("신뢰하지 않은 창·다른 창의 guest·다른 session·잘못된 언어는 실행하지 않는다", async () => {
  const f = fixture(); await f.service.ready;
  const rejected = { ok: false, code: "unsupported" };
  assert.deepEqual(await f.service.handle({ sender: f.host, trusted: false }, { wc: 4, op: "translate" }), rejected);
  f.guest.hostWebContents = {};
  assert.deepEqual(await f.call({ op: "translate" }), rejected);
  f.guest.hostWebContents = f.host; f.guest.session = {};
  assert.deepEqual(await f.call({ op: "translate" }), rejected);
  f.guest.session = f.session; f.guest.url = "file:///private/file";
  assert.deepEqual(await f.call({ op: "translate" }), rejected);
  f.guest.url = "https://site.test/page";
  for (const payload of [{ source: "en;evil()" }, { target: "auto" }, { wc: "4" }, { op: "unknown" }]) assert.deepEqual(await f.call({ op: "translate", ...payload }), rejected);
  assert.deepEqual(await f.service.handle(f.event, null), rejected);
  assert.equal(f.network.length, 0); assert.equal(f.guest.scripts.length, 0);
});

test("번역·원문·언어 변경은 reload 없이 Google library를 재사용한다", async () => {
  const f = fixture();
  assert.deepEqual(await f.call({ op: "translate", source: "en", target: "ko" }), { ok: true, code: "translated", language: "en", detail: "ko" });
  assert.equal(f.context.document.body.innerText, "translated ko");
  assert.deepEqual(await f.call({ op: "restore" }), { ok: true, code: "original" });
  assert.equal(f.context.document.body.innerText, "Hello world");
  assert.equal((await f.call({ op: "translate", source: "en", target: "ja" })).ok, true);
  assert.equal(f.context.document.body.innerText, "translated ja");
  assert.deepEqual(f.calls, [{ source: "en", target: "ko" }, { source: "en", target: "ja" }]);
  assert.equal(f.network.length, 1);
  assert.deepEqual(await f.call({ op: "translate", source: "en", target: "en" }), { ok: true, code: "original" });
  assert.equal(f.context.document.body.innerText, "Hello world");
});

test("같은 URL reload 중 완료한 loader는 새 문서에서 실행되지 않는다", async () => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture(() => new Promise(resolve => { release = resolve; began(); }));
  const operation = f.call({ op: "translate", source: "en", target: "ko" });
  await started;
  f.guest.emit("did-start-navigation", {}, f.guest.url, false, true);
  release(new Response("window.google={translate:{TranslateService:()=>fakeLibrary}};window.__irisTranslateReady();"));
  assert.deepEqual(await operation, { ok: false, code: "navigated" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.document.body.innerText, "Hello world");
  assert.ok(f.network[0].options.signal.aborted);
});

test("번역 중 SPA 이동은 기존 문서의 번역을 복원하고 늦은 callback을 무시한다", async () => {
  const f = fixture(); let callback;
  f.context.fakeLibrary.translatePage = (_source, _target, next) => {
    callback = next; f.context.document.body.innerText = "partial translation";
    setTimeout(() => { f.guest.url = "https://site.test/other"; f.guest.emit("did-start-navigation", {}, f.guest.url, true, true); }, 1);
  };
  assert.deepEqual(await f.call({ op: "translate", source: "en", target: "ko" }), { ok: false, code: "navigated" });
  assert.equal(f.context.document.body.innerText, "Hello world");
  callback(100, true, 0);
  assert.equal(f.context.__irisTranslation.finished, false);
});

test("번역 resource는 고정 HTTPS 경로만 허용하고 쿠키·redirect·큰 응답을 거절한다", async () => {
  for (const url of ["http://translate.googleapis.com/translate_a/element.js", "https://translate.googleapis.com.evil.test/translate_a/element.js", "https://translate.googleapis.com/secret", "https://user@translate.googleapis.com/translate_a/element.js", "https://www.gstatic.com/unknown", "file:///private/file"]) {
    assert.equal(assetKind(url), null);
    await assert.rejects(fetchAsset(url, { fetchImpl: () => { throw Error("must not fetch"); } }));
  }
  const url = "https://translate.googleapis.com/translate_a/element.js";
  let options;
  assert.equal(await fetchAsset(url, { fetchImpl: async (_url, opts) => { options = opts; return new Response("valid script"); } }), "valid script");
  assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.ok(options.signal);
  await assert.rejects(fetchAsset(url, { fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) }), /too large/);
  await assert.rejects(fetchAsset(url, { fetchImpl: async () => new Response("blocked", { status: 403 }) }), /unavailable/);
});

test("Google이 임의 주소를 resource로 지정하면 로드하지 않는다", async () => {
  const f = fixture(async () => new Response("window.__irisTranslateJS('https://evil.test/script.js');"));
  assert.deepEqual(await f.call({ op: "translate" }), { ok: false, code: "unsupported" });
  assert.equal(f.network.length, 1);
});

test("Google library 초기화 실패 뒤 재시도는 오류 상태를 다시 만들고 번역한다", async () => {
  const f = fixture();
  f.context.fakeLibrary.isAvailable = () => { throw Error("temporary initialization failure"); };
  assert.deepEqual(await f.call({ op: "translate", source: "en", target: "ko" }), { ok: false, code: "network" });
  const failedToken = f.context.__irisTranslation.token;
  assert.equal(f.context.__irisTranslation.error, "network");
  f.context.fakeLibrary.isAvailable = () => true;
  assert.deepEqual(await f.call({ op: "translate", source: "en", target: "ko" }), { ok: true, code: "translated", language: "en", detail: "ko" });
  assert.notEqual(f.context.__irisTranslation.token, failedToken);
  assert.equal(f.context.__irisTranslation.error, "");
  assert.equal(f.context.document.body.innerText, "translated ko");
  assert.equal(f.network.length, 1, "오류 상태는 새로 만들고 정상 loader는 캐시에서 읽는다");
});
