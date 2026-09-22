// 웹뷰 수명주기가 CDP 를 스스로 붙이지 않고, 탐색을 부착 정책에 알리며, CDP 가 없는 탭에는
// 같은 스크립트를 dom-ready 에서 심는지 검증한다.
//
// 소유 범위
//   webview-lifecycle 의 생성 시 attach 부재, noteNavigation 호출 조건, CDP 없는 주입 경로, destroyed 정리.
//
// 제공 API
//   node --test test/webview-lifecycle.mjs 한 명령으로 실제 Electron 없이 판정한다.
//
// 의존 대상
//   가짜 app·webContents·debugger·WebFrameMain 과 webview-lifecycle.cjs 의 공개 API만 사용한다.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createWebviewLifecycle } = require("../native/electron/webview-lifecycle.cjs");

function fakeFrame(parent = null) {
  const handlers = {};
  const runs = [];
  return {
    parent,
    runs,
    executeJavaScript: (src) => { runs.push(src); return Promise.resolve(); },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    once: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    emit: (name, ...args) => { for (const fn of handlers[name] || []) fn(...args); },
  };
}

function fixture(overrides = {}) {
  const appHandlers = {};
  const wcHandlers = {};
  const dbgHandlers = {};
  const attachCalls = [];
  const navigations = [];
  const forgotten = [];
  const primers = {};
  let attached = false;
  const dbg = {
    isAttached: () => attached,
    attach: (v) => { attachCalls.push(v); attached = true; },
    detach: () => { attached = false; },
    on: (name, fn) => { dbgHandlers[name] = fn; },
    sendCommand: () => Promise.resolve(),
  };
  const mainFrame = fakeFrame(null);
  const wc = {
    id: 51,
    debugger: dbg,
    mainFrame,
    getType: () => "webview",
    isDestroyed: () => false,
    setBackgroundThrottling() {},
    setWindowOpenHandler() {},
    hostWebContents: { isDestroyed: () => false, send() {} },
    on: (name, fn) => { (wcHandlers[name] = wcHandlers[name] || []).push(fn); },
    once: (name, fn) => { (wcHandlers[name] = wcHandlers[name] || []).push(fn); },
  };
  createWebviewLifecycle({
    app: { on: (name, fn) => { appHandlers[name] = fn; } },
    noThrottleOpt: false,
    getAppUrl: () => "http://127.0.0.1:4291",
    clearThrottleState() {},
    forgetSecrets() {},
    dialogScript: (id, port) => `dialog:${id}:${port}`,
    webAuthnScript: "webauthn",
    botcheckScript: "botcheck",
    registerSessionPrimer: (_id, parent, child) => { primers.parent = parent; primers.child = child; },
    noteNavigation: (id, url) => { navigations.push([id, url]); return false; },
    forgetAttachPolicy: (id) => forgotten.push(id),
    noteFrameOrigin() {},
    dropChildSession() {},
    noteChildSession() {},
    randomUuid: () => "u1",
    registerPopup() {},
    unregisterPopup() {},
    setThrottleReason() {},
    reconcilePopupThrottling() {},
    ctlSend() {},
    aiDriving: () => false,
    ...overrides,
  });
  appHandlers["web-contents-created"](null, wc);
  const emit = (name, ...args) => { for (const fn of wcHandlers[name] || []) fn(...args); };
  return {
    wc, dbg, mainFrame, attachCalls, navigations, forgotten, primers, emit,
    setAttached: (value) => { attached = value; },
    hasDebuggerListener: () => typeof dbgHandlers.message === "function",
  };
}

test("탭 생성과 일반 탐색만으로는 debugger 를 붙이지 않고 primer 와 수신기만 걸어 둔다", () => {
  const f = fixture();
  assert.deepEqual(f.attachCalls, []);
  assert.equal(f.dbg.isAttached(), false);
  assert.equal(typeof f.primers.parent, "function", "CDP 세션이 생길 때 심을 목록은 등록돼 있어야 한다");
  assert.equal(f.hasDebuggerListener(), true, "자식 타깃 수신기는 붙기 전에 걸려 있어야 한다");
  f.emit("did-start-navigation", {}, "https://example.com/a", false, true);
  f.emit("did-stop-loading");
  assert.deepEqual(f.attachCalls, []);
});

test("main-frame 탐색 시작·리다이렉트는 목적지를 정책에 알리고, 로드가 끝나면 null 로 지운다", () => {
  const f = fixture();
  f.emit("did-start-navigation", {}, "https://app.example/login", false, true);
  f.emit("did-start-navigation", {}, "https://ads.example/frame", false, false);   // 자식 프레임은 무시
  f.emit("did-start-navigation", {}, "https://app.example/login#x", true, true);   // 같은 문서 안 이동은 무시
  f.emit("will-redirect", {}, "https://accounts.google.com/o/oauth2/auth", false, true);
  f.emit("did-stop-loading");
  assert.deepEqual(f.navigations, [
    [51, "https://app.example/login"],
    [51, "https://accounts.google.com/o/oauth2/auth"],
    [51, null],
  ]);
});

test("CDP 가 없는 탭은 dom-ready 에서 세 스크립트를 main frame 에 심고, 붙어 있으면 심지 않는다", () => {
  const f = fixture();
  f.emit("dom-ready");
  assert.deepEqual(f.mainFrame.runs, ["webauthn", "botcheck", "dialog:51:4291"]);
  f.setAttached(true);
  f.emit("dom-ready");
  assert.equal(f.mainFrame.runs.length, 3, "CDP 세션이 있으면 document-start 주입이 맡는다");
});

test("자식 프레임은 frame-created 뒤 그 프레임의 dom-ready 에서 심고, 최상위 프레임은 건너뛴다", () => {
  const f = fixture();
  const child = fakeFrame(f.mainFrame);
  f.emit("frame-created", {}, { frame: child });
  assert.deepEqual(child.runs, [], "dom-ready 전에는 심지 않는다");
  child.emit("dom-ready");
  assert.deepEqual(child.runs, ["webauthn", "botcheck", "dialog:51:4291"]);
  const top = fakeFrame(null);
  f.emit("frame-created", {}, { frame: top });
  top.emit("dom-ready");
  assert.deepEqual(top.runs, [], "최상위 문서는 wc 의 dom-ready 가 맡아 두 번 심지 않는다");
});

test("탭이 사라지면 primer 등록을 지우고 부착 정책에도 알린다", () => {
  const registrations = [];
  const f = fixture({ registerSessionPrimer: (id, parent) => registrations.push([id, typeof parent]) });
  f.emit("destroyed");
  assert.deepEqual(f.forgotten, [51]);
  assert.deepEqual(registrations.at(-1), [51, "object"]);   // null 등록 = 해제
});
