import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  attachGoogleAuthUserAgent,
  googleAuthUserAgent,
  identityOwnsDebugger,
  isGoogleAuthUrl,
  rewriteGoogleAuthHeaders,
  sendDeviceUserAgentOverride,
} = require("../native/electron/google-auth-user-agent.cjs");
const { createDeviceEmulation } = require("../native/electron/cdp-device-emulation.cjs");

const BASE_UA = "Mozilla/5.0 Iris/0.1 Chrome/140.0.0.0 Electron/43.2.0 Safari/537.36";
const MOBILE_PAYLOAD = {
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  userAgentMetadata: { platform: "Android", mobile: true },
};

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = true;
    this.attachCalls = [];
    this.detachCalls = 0;
    this.sent = [];
  }
  isAttached() { return this.attached; }
  attach(protocol) { this.attachCalls.push(protocol); this.attached = true; }
  detach() { this.detachCalls += 1; this.attached = false; this.emit("detach", {}, "target closed"); }
  async sendCommand(method, params) {
    this.sent.push({ method, params });
  }
}

class FakeWebContents extends EventEmitter {
  constructor(id, url = "https://example.com/") {
    super();
    this.id = id;
    this.url = url;
    this.ua = BASE_UA;
    this.destroyed = false;
    this.debugger = new FakeDebugger();
    this.session = { getUserAgent: () => BASE_UA };
    this.setUserAgentCalls = [];
    this.reloadCalls = 0;
  }
  getURL() { return this.url; }
  getUserAgent() { return this.ua; }
  setUserAgent(value) { this.ua = value; this.setUserAgentCalls.push(value); }
  isDestroyed() { return this.destroyed; }
  reload() { this.reloadCalls += 1; }
  loadURL(url) { this.url = url; }
}

function start(wc, url) {
  wc.emit("did-start-navigation", {}, url, false, true);
}

function redirect(wc, url) {
  wc.emit("will-redirect", {}, url, false, true);
}

function fail(wc, url) {
  wc.emit("did-fail-load", {}, -3, "aborted", url, true);
}

function uaWrites(wc) {
  return wc.debugger.sent
    .filter(({ method }) => method === "Emulation.setUserAgentOverride")
    .map(({ params }) => params);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("Google 인증 URL은 HTTPS의 정확한 두 호스트만 허용한다", () => {
  assert.equal(isGoogleAuthUrl("https://accounts.google.com/o/oauth2/auth"), true);
  assert.equal(isGoogleAuthUrl("https://ACCOUNTS.YOUTUBE.COM/signin"), true);
  for (const raw of [
    "http://accounts.google.com/",
    "https://accounts.google.com.evil.test/",
    "https://accounts.google.com@evil.test/",
    "https://myaccount.google.com/",
    "javascript:https://accounts.google.com/",
    "not a url",
  ]) assert.equal(isGoogleAuthUrl(raw), false, raw);
});

test("Firefox 140 UA는 실행 OS 토큰과 버전 토큰이 일치한다", () => {
  const ua = googleAuthUserAgent();
  assert.match(ua, /rv:140\.0\) Gecko\/20100101 Firefox\/140\.0$/);
  if (process.platform === "darwin") assert.match(ua, /Macintosh; Intel Mac OS X 10\.15/);
  else if (process.platform === "win32") assert.match(ua, /Windows NT 10\.0; Win64; x64/);
  else assert.match(ua, /X11; Linux x86_64/);
});

test("인증 요청은 중복 UA 키를 모두 통일하고 모든 sec-ch-ua 힌트를 지운다", () => {
  const headers = {
    "user-agent": "old-a",
    "USER-AGENT": "old-b",
    "Sec-CH-UA": "brands",
    "sec-ch-ua-platform": '"macOS"',
    Accept: "text/html",
  };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://accounts.google.com/"), true);
  assert.equal(headers["user-agent"], googleAuthUserAgent());
  assert.equal(headers["USER-AGENT"], googleAuthUserAgent());
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase().startsWith("sec-ch-ua")), false);
  assert.equal(headers.Accept, "text/html");
});

test("ordinary 문서의 auth-host iframe/XHR는 native wire identity를 유지한다", () => {
  for (const resourceType of ["subFrame", "xhr", "script"]) {
    const headers = { "User-Agent": BASE_UA, "sec-ch-ua": "stock" };
    assert.equal(rewriteGoogleAuthHeaders(headers, "https://accounts.google.com/embedded", {
      resourceType,
    }), false);
    assert.deepEqual(headers, { "User-Agent": BASE_UA, "sec-ch-ua": "stock" });
  }

  const fromAuthDocument = { "User-Agent": googleAuthUserAgent(), "sec-ch-ua": "wrong" };
  assert.equal(rewriteGoogleAuthHeaders(fromAuthDocument, "https://accounts.google.com/embedded", {
    resourceType: "subFrame",
  }), true);
  assert.deepEqual(fromAuthDocument, { "User-Agent": googleAuthUserAgent() });
});

test("인증 문서의 외부 요청도 Firefox UA를 보존하며 힌트를 제거한다", () => {
  const headers = { "User-Agent": googleAuthUserAgent(), "sec-ch-ua-mobile": "?0" };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://static.example.test/widget.js"), true);
  assert.deepEqual(headers, { "User-Agent": googleAuthUserAgent() });

  const ordinary = { "User-Agent": BASE_UA, "sec-ch-ua": "stock" };
  assert.equal(rewriteGoogleAuthHeaders(ordinary, "https://example.com/"), false);
  assert.deepEqual(ordinary, { "User-Agent": BASE_UA, "sec-ch-ua": "stock" });
});

test("인증 문서에서 떠나는 첫 main-frame 요청은 wire 단계에서 session base로 복원한다", () => {
  const wc = new FakeWebContents(5, "https://accounts.google.com/");
  attachGoogleAuthUserAgent(wc);
  const headers = { "User-Agent": googleAuthUserAgent() };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://example.com/return", {
    resourceType: "mainFrame",
    webContentsId: wc.id,
  }), true);
  assert.deepEqual(headers, { "User-Agent": BASE_UA });
});

test("active device가 있으면 인증 이탈 첫 main-frame 요청도 device base UA로 복원한다", async () => {
  const wc = new FakeWebContents(6, "https://accounts.google.com/");
  attachGoogleAuthUserAgent(wc);
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), MOBILE_PAYLOAD);
  const headers = { "user-agent": googleAuthUserAgent(), "USER-AGENT": "duplicate" };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://example.com/return", {
    resourceType: "mainFrame",
    webContents: wc,
  }), true);
  assert.equal(headers["user-agent"], MOBILE_PAYLOAD.userAgent);
  assert.equal(headers["USER-AGENT"], MOBILE_PAYLOAD.userAgent);
});

test("webview와 popup 같은 WebContents는 인증 진입과 이탈 때 같은 CDP 수명주기를 쓴다", async () => {
  for (const id of [10, 11]) {
    const wc = new FakeWebContents(id);
    const dispose = attachGoogleAuthUserAgent(wc);
    start(wc, "https://accounts.google.com/signin");
    await flush();
    assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
    start(wc, "https://mail.google.com/mail/u/0/");
    await flush();
    assert.deepEqual(uaWrites(wc).at(-1), { userAgent: BASE_UA });
    assert.deepEqual(wc.setUserAgentCalls, []);
    dispose();
  }
});

test("redirect 중에는 setUserAgent로 POST 탐색을 건드리지 않고 기존 CDP만 쓴다", async () => {
  const wc = new FakeWebContents(20);
  attachGoogleAuthUserAgent(wc);
  redirect(wc, "https://accounts.google.com/o/oauth2/auth");
  await flush();
  assert.deepEqual(wc.setUserAgentCalls, []);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });

  redirect(wc, "https://example.com/callback");
  await flush();
  assert.deepEqual(wc.setUserAgentCalls, []);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: BASE_UA });
});

test("debugger detach는 동기 UA setter 없이 상태를 지우고 다음 탐색에서 다시 적용한다", async () => {
  const wc = new FakeWebContents(21);
  attachGoogleAuthUserAgent(wc);
  redirect(wc, "https://accounts.google.com/o/oauth2/auth");
  await flush();
  assert.deepEqual(wc.setUserAgentCalls, []);

  wc.url = "https://accounts.google.com/o/oauth2/auth";
  wc.emit("did-navigate", {}, wc.url);
  await flush();
  wc.debugger.attached = false;
  wc.debugger.emit("detach", {}, "target closed");
  assert.equal(wc.getUserAgent(), BASE_UA);
  start(wc, "https://accounts.google.com/next");
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3"]);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
  assert.deepEqual(wc.setUserAgentCalls, []);
});

test("debugger 없는 popup은 auth redirect 때 UA 전용 CDP만 붙이고 이후 전환에도 유지한다", async () => {
  const wc = new FakeWebContents(22);
  wc.debugger.attached = false;
  attachGoogleAuthUserAgent(wc);
  redirect(wc, "https://accounts.google.com/o/oauth2/auth");
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3"]);
  assert.deepEqual(wc.setUserAgentCalls, []);
  assert.deepEqual(wc.debugger.sent, [{
    method: "Emulation.setUserAgentOverride",
    params: { userAgent: googleAuthUserAgent() },
  }]);

  wc.url = "https://accounts.google.com/o/oauth2/auth";
  wc.emit("did-navigate", {}, wc.url);
  assert.deepEqual(wc.setUserAgentCalls, []);
  wc.emit("did-finish-load");
  assert.equal(wc.getUserAgent(), BASE_UA);
  assert.equal(wc.debugger.detachCalls, 0);
  assert.equal(wc.debugger.isAttached(), true);

  start(wc, "https://example.com/return");
  await flush();
  assert.deepEqual(wc.setUserAgentCalls, []);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: BASE_UA });
});

test("redirect 없는 일반 popup 탐색은 debugger를 새로 붙이지 않는다", () => {
  const wc = new FakeWebContents(23);
  wc.debugger.attached = false;
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://example.com/ordinary");
  assert.deepEqual(wc.debugger.attachCalls, []);
});

test("superseded 탐색의 늦은 실패는 현재 대상의 UA 판정을 되돌리지 않는다", async () => {
  const wc = new FakeWebContents(30);
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/first");
  start(wc, "https://example.com/current");
  fail(wc, "https://accounts.google.com/first");
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), MOBILE_PAYLOAD);
  assert.deepEqual(uaWrites(wc).at(-1), MOBILE_PAYLOAD);

  wc.url = "https://example.com/committed";
  fail(wc, "https://example.com/current");
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), MOBILE_PAYLOAD);
  assert.deepEqual(uaWrites(wc).at(-1), MOBILE_PAYLOAD);
});

test("활성 viewport UA는 인증 탐색마다 기존 debugger로 다시 적용된다", async () => {
  const wc = new FakeWebContents(40);
  attachGoogleAuthUserAgent(wc);
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), MOBILE_PAYLOAD);
  start(wc, "https://accounts.google.com/signin");
  await flush();
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
  assert.deepEqual(wc.setUserAgentCalls, []);

  start(wc, "https://example.com/after");
  await flush();
  assert.deepEqual(uaWrites(wc).at(-1), MOBILE_PAYLOAD);
});

test("인증 페이지에서 처음 적용한 device UA도 session base로 만들고 clear가 base UA를 복원한다", async () => {
  const wc = new FakeWebContents(50);
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/signin");
  const device = createDeviceEmulation({
    attach: () => wc.debugger.sendCommand.bind(wc.debugger),
    yieldToExplicitViewport: () => {},
    notify: () => {},
  });
  await device.apply(wc, { width: 390, height: 844, live: true });
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
  assert.equal(uaWrites(wc).some(({ userAgent }) => /Firefox/.test(userAgent) && /Android/.test(userAgent)), false);

  start(wc, "https://example.com/after");
  await flush();
  await device.apply(wc, { clear: true });
  assert.equal(uaWrites(wc).at(-1).userAgent, BASE_UA);
});

test("인증 페이지에서 viewport를 clear해도 Firefox standing UA를 보존한다", async () => {
  const wc = new FakeWebContents(51);
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/signin");
  const device = createDeviceEmulation({
    attach: () => wc.debugger.sendCommand.bind(wc.debugger),
    yieldToExplicitViewport: () => {},
    notify: () => {},
  });
  await device.apply(wc, { width: 390, height: 844, live: true });
  await device.apply(wc, { clear: true });
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
});

test("metrics await 중 인증 탐색이 시작돼도 실제 UA send 시점의 target을 쓴다", async () => {
  const wc = new FakeWebContents(60);
  attachGoogleAuthUserAgent(wc);
  let releaseMetrics;
  const metrics = new Promise((resolve) => { releaseMetrics = resolve; });
  const send = async (method, params) => {
    wc.debugger.sent.push({ method, params });
    if (method === "Emulation.setDeviceMetricsOverride") await metrics;
  };
  const device = createDeviceEmulation({ attach: () => send, yieldToExplicitViewport: () => {}, notify: () => {} });
  const applying = device.apply(wc, { width: 390, height: 844, live: true });
  await Promise.resolve();
  start(wc, "https://accounts.google.com/signin");
  releaseMetrics();
  await applying;
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
});

test("debugger detach 뒤 첫 탐색이 active device intent를 직접 재부착해 복원한다", async () => {
  const wc = new FakeWebContents(70);
  attachGoogleAuthUserAgent(wc);
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), MOBILE_PAYLOAD);
  wc.debugger.attached = false;
  wc.debugger.emit("detach", {}, "target closed");
  start(wc, "https://example.com/after-reattach");
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3"]);
  assert.deepEqual(uaWrites(wc).at(-1), MOBILE_PAYLOAD);

  wc.debugger.attached = false;
  wc.debugger.emit("detach", {}, "target closed");
  start(wc, "https://accounts.google.com/signin");
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3", "1.3"]);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
});

test("dispose와 destroyed는 listener/state를 정리하고 우리 CDP override만 복원한다", async () => {
  const disposed = new FakeWebContents(80);
  const dispose = attachGoogleAuthUserAgent(disposed);
  assert.equal(disposed.listenerCount("did-start-navigation"), 1);
  assert.equal(disposed.debugger.listenerCount("detach"), 1);
  start(disposed, "https://accounts.google.com/");
  await flush();
  dispose();
  dispose();
  await flush();
  assert.equal(disposed.getUserAgent(), BASE_UA);
  assert.deepEqual(uaWrites(disposed).at(-1), { userAgent: BASE_UA });
  assert.deepEqual(disposed.setUserAgentCalls, []);
  assert.equal(disposed.listenerCount("did-start-navigation"), 0);
  assert.equal(disposed.debugger.listenerCount("detach"), 0);

  const destroyed = new FakeWebContents(81);
  attachGoogleAuthUserAgent(destroyed);
  start(destroyed, "https://accounts.google.com/");
  await flush();
  destroyed.destroyed = true;
  destroyed.emit("destroyed");
  assert.equal(destroyed.getUserAgent(), BASE_UA);
  assert.deepEqual(uaWrites(destroyed).at(-1), { userAgent: googleAuthUserAgent() });
  assert.deepEqual(destroyed.setUserAgentCalls, []);
  assert.equal(destroyed.listenerCount("did-start-navigation"), 0);
  assert.equal(destroyed.debugger.listenerCount("detach"), 0);
});

test("popup 같은 새 WebContents의 첫 auth 탐색부터 CDP identity를 적용한다", async () => {
  const wc = new FakeWebContents(99);
  wc.url = "";
  wc.getType = () => "window";
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/first");
  await flush();
  assert.deepEqual(uaWrites(wc), [{ userAgent: googleAuthUserAgent() }]);
  assert.deepEqual(wc.setUserAgentCalls, []);
  const headers = { "User-Agent": BASE_UA, "Sec-CH-UA": "native" };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://accounts.google.com/first", {
    resourceType: "mainFrame",
    webContents: wc,
  }), true);
  assert.equal(headers["User-Agent"], googleAuthUserAgent());
  assert.equal(headers["Sec-CH-UA"], undefined);
});

// 첫 main-frame 요청이 Chrome 으로 나가면 Google 이 그 세션을 Chrome 으로 시작한다. CDP override 가
// 아직 없거나 실패했어도 인증 호스트 main-frame 헤더는 Firefox 여야 하고 WebContents UA 는 건드리지 않는다.
test("CDP attach 실패 시에도 인증 호스트 첫 main-frame 요청 헤더는 Firefox 이고 WebContents UA는 바꾸지 않는다", async () => {
  const wc = new FakeWebContents(100);
  wc.debugger.attached = false;
  wc.debugger.attach = () => { throw new Error("debugger unavailable"); };
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/first");
  await flush();

  assert.deepEqual(uaWrites(wc), []);
  assert.deepEqual(wc.setUserAgentCalls, []);
  assert.equal(wc.getUserAgent(), BASE_UA);
  const headers = { "User-Agent": BASE_UA, "Sec-CH-UA": "native" };
  assert.equal(rewriteGoogleAuthHeaders(headers, "https://accounts.google.com/first", {
    resourceType: "mainFrame",
    webContents: wc,
  }), true);
  assert.deepEqual(headers, { "User-Agent": googleAuthUserAgent() });
});

test("정체성 모듈이 스스로 붙인 debugger 만 소유로 답한다", async () => {
  const own = new FakeWebContents(101);
  own.debugger.attached = false;
  attachGoogleAuthUserAgent(own);
  assert.equal(identityOwnsDebugger(own), false);
  start(own, "https://accounts.google.com/first");
  await flush();
  assert.deepEqual(own.debugger.attachCalls, ["1.3"]);
  assert.equal(identityOwnsDebugger(own), true);

  // 이미 AI 세션이 붙어 있던 탭은 그 attach 를 빌려 쓸 뿐 소유하지 않는다.
  const borrowed = new FakeWebContents(102);
  attachGoogleAuthUserAgent(borrowed);
  start(borrowed, "https://accounts.google.com/first");
  await flush();
  assert.deepEqual(borrowed.debugger.attachCalls, []);
  assert.deepEqual(uaWrites(borrowed).at(-1), { userAgent: googleAuthUserAgent() });
  assert.equal(identityOwnsDebugger(borrowed), false);
});

// 부착 정책이나 AI 세션 정리가 debugger 를 떼어도 인증 문서에는 Firefox 정체가 계속 필요하다.
test("인증 호스트에서 외부가 debugger 를 떼면 다음 틱에 정체성 전용으로 다시 붙이고 override 를 다시 보낸다", async () => {
  const wc = new FakeWebContents(103, "");
  attachGoogleAuthUserAgent(wc);
  start(wc, "https://accounts.google.com/signin");
  await flush();
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
  assert.equal(identityOwnsDebugger(wc), false);

  wc.debugger.detach();   // AI 세션 정리(detachIdle)가 떼었다
  assert.equal(wc.debugger.isAttached(), false);
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3"]);
  assert.equal(identityOwnsDebugger(wc), true);
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: googleAuthUserAgent() });
  assert.deepEqual(wc.setUserAgentCalls, []);

  // 커밋 뒤 문서 주소가 인증 호스트여도 같다.
  wc.url = "https://accounts.google.com/signin";
  wc.emit("did-navigate", {}, wc.url);
  wc.debugger.detach();
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, ["1.3", "1.3"]);
});

test("일반 문서에서 외부가 debugger 를 떼면 다시 붙이지 않는다", async () => {
  const wc = new FakeWebContents(104, "https://example.com/");
  attachGoogleAuthUserAgent(wc);
  wc.debugger.detach();
  await flush();
  assert.deepEqual(wc.debugger.attachCalls, []);
  assert.equal(identityOwnsDebugger(wc), false);
});

// 로그인이 끝나 인증 호스트를 떠나면 소유를 내려놓고 정책에 알린다. AI 창·유지 조건이 없으면 정책이 뗀다.
test("인증 호스트를 떠나면 base override 를 보낸 뒤 소유를 해제하고 onRelease 를 한 번 부른다", async () => {
  const wc = new FakeWebContents(105, "");
  wc.debugger.attached = false;
  const released = [];
  attachGoogleAuthUserAgent(wc, { onRelease: (target) => released.push(target.id) });
  start(wc, "https://accounts.google.com/signin");
  await flush();
  assert.equal(identityOwnsDebugger(wc), true);
  assert.deepEqual(released, []);

  wc.url = "https://accounts.google.com/signin";
  wc.emit("did-navigate", {}, wc.url);
  start(wc, "https://example.com/oauth/callback");
  await flush();
  assert.deepEqual(uaWrites(wc).at(-1), { userAgent: BASE_UA });
  assert.equal(identityOwnsDebugger(wc), false);
  assert.deepEqual(released, [105]);
  assert.equal(wc.debugger.detachCalls, 0);   // 떼는 것은 정책의 몫이다

  // 소유하지 않은 탭의 일반 탐색은 알리지 않는다.
  start(wc, "https://example.com/next");
  await flush();
  assert.deepEqual(released, [105]);
});
