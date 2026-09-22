// CDP 세션의 문서 계약과 명시적 관찰 계약이 서로 침범하지 않는지 검증한다.
//
// 소유 범위
//   cdp-session의 document/observation 두 단계, 초기 이벤트 배선, OOPIF 승격과 detach 정리 계약.
//
// 제공 API
//   node --test test/cdp-session.mjs 한 명령으로 실제 Electron 없이 세션 수명주기를 판정한다.
//
// 의존 대상
//   주입한 webContents.debugger probe와 cdp-session.cjs의 공개 API만 사용한다.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCdpSession } = require("../native/electron/cdp-session.cjs");

function fixture(extra = {}) {
  const debuggerHandlers = {};
  const wcHandlers = {};
  const sent = [];
  const rootPrimers = [];
  const childPrimers = [];
  const rootOverlays = [];
  const childOverlays = [];
  const chooserCalls = [];
  const chooserStates = [];
  const resets = [];
  const origins = [];
  let debuggerAttached = false;
  let observationPrimes = 0;

  const dbg = {
    isAttached: () => debuggerAttached,
    attach: () => { debuggerAttached = true; },
    detach: () => {
      debuggerAttached = false;
      debuggerHandlers.detach?.({}, "target closed");
    },
    on: (name, fn) => { debuggerHandlers[name] = fn; },
    sendCommand: (method, params, sid) => {
      sent.push({ method, params, sid });
      return Promise.resolve({});
    },
  };
  const wc = {
    id: 71001,
    debugger: dbg,
    isDestroyed: () => false,
    on: (name, fn) => { wcHandlers[name] = fn; },
    once: (name, fn) => { wcHandlers[name] = fn; },
  };
  const session = createCdpSession({
    observation: {
      prime: () => { observationPrimes++; },
      forget() {},
      momentPayload: () => null,
      noteMoment() {},
      recordConsole() {},
      recordException() {},
      recordNetwork() {},
      setFileChooser: (_id, value) => chooserStates.push(value),
      closeDialog() {},
      openDialog: (_id, record) => record,
      noteRequest() {},
      requestUrl: () => "",
    },
    hiddenViewport: {
      forget() {},
      resetSession: (id) => resets.push(["viewport", id]),
    },
    overlay: {
      injectActive: (id, sid) => sid ? childOverlays.push([id, sid]) : rootOverlays.push(id),
      resetSession: (id) => resets.push(["overlay", id]),
    },
    refRegistry: {
      bumpNavigation() {},
      clear() {},
      clearSnapshot: (id) => resets.push(["ref", id]),
    },
    upload: {
      forget() {},
      serveFileChooser: async (_send, _wc, params) => { chooserCalls.push(params); },
    },
    deviceEmulation: { forget() {} },
    ctlSend: (message) => {
      if (message.type === "browser-frame-origins") origins.push(message.origins);
    },
    tagError: (error, code) => Object.assign(error, { code }),
    sessionDetachedCode: "session_detached",
    ...extra,
  });
  session.registerSessionPrimer(wc.id,
    () => {
      assert.equal(typeof debuggerHandlers.message, "function", "primer 전에 debugger dispatcher가 배선돼야 한다");
      rootPrimers.push("root");
    },
    (_childDbg, sid) => childPrimers.push(sid));

  return {
    session, wc, dbg, debuggerHandlers, wcHandlers, sent, rootPrimers, childPrimers,
    rootOverlays, childOverlays, chooserCalls, chooserStates, resets, origins,
    observationPrimes: () => observationPrimes,
    emitMessage: (method, params) => debuggerHandlers.message?.({}, method, params),
    emitDetach: () => {
      debuggerAttached = false;
      debuggerHandlers.detach?.({}, "external detach");
    },
  };
}

function count(calls, method, sid) {
  return calls.filter((call) => call.method === method && call.sid === sid).length;
}

test("document prime은 dispatcher와 Page 계약만 준비하고 첫 AI 전 파일 선택을 처리한다", async () => {
  const f = fixture();
  const send = f.session.primeSession(f.wc);

  assert.equal(typeof send, "function");
  assert.equal(f.rootPrimers.length, 1);
  assert.equal(count(f.sent, "Page.enable", undefined), 1);
  assert.equal(count(f.sent, "Page.setInterceptFileChooserDialog", undefined), 1);
  assert.equal(count(f.sent, "Runtime.enable", undefined), 0);
  assert.equal(count(f.sent, "Log.enable", undefined), 0);
  assert.equal(count(f.sent, "Network.enable", undefined), 0);
  assert.equal(f.observationPrimes(), 0);
  assert.equal(f.rootOverlays.length, 0);

  f.emitMessage("Page.fileChooserOpened", { backendNodeId: 19, mode: "selectSingle" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.chooserStates, [{ backendNodeId: 19, mode: "selectSingle" }]);
  assert.deepEqual(f.chooserCalls, [{ backendNodeId: 19, mode: "selectSingle" }]);
});

test("document dispatcher는 첫 AI 전에도 무장된 native dialog 응답을 유지한다", () => {
  const f = fixture();
  f.session.primeSession(f.wc);
  f.session.planFor(f.wc.id).queue.push("ok");

  f.emitMessage("Page.javascriptDialogOpening", { type: "confirm", message: "continue?" });

  const replies = f.sent.filter((call) => call.method === "Page.handleJavaScriptDialog");
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].params, { accept: true });
  assert.equal(count(f.sent, "Runtime.enable", undefined), 0);
});

test("첫 explicit observation은 이미 알려진 child를 정확히 한 번 승격하고 child Runtime은 켜지 않는다", () => {
  const f = fixture();
  f.session.primeSession(f.wc);
  f.emitMessage("Target.attachedToTarget", {
    sessionId: "child-a",
    targetInfo: { type: "iframe" },
  });
  f.emitMessage("Target.attachedToTarget", {
    sessionId: "child-a",
    targetInfo: { type: "iframe" },
  });

  assert.deepEqual(f.childPrimers, ["child-a"]);
  assert.equal(count(f.sent, "Page.enable", "child-a"), 1);
  assert.equal(count(f.sent, "DOM.enable", "child-a"), 0);
  assert.equal(count(f.sent, "Accessibility.enable", "child-a"), 0);
  assert.equal(count(f.sent, "Runtime.enable", "child-a"), 0);

  const send = f.session.ensureAttached(f.wc);
  f.session.ensureAttached(f.wc);

  assert.deepEqual(send.frames(), [null, "child-a"]);
  assert.equal(f.observationPrimes(), 1);
  assert.equal(f.rootOverlays.length, 1);
  assert.equal(f.childOverlays.length, 1);
  assert.equal(count(f.sent, "Runtime.enable", undefined), 1);
  assert.equal(count(f.sent, "Log.enable", undefined), 1);
  assert.equal(count(f.sent, "Network.enable", undefined), 1);
  assert.equal(count(f.sent, "DOM.enable", "child-a"), 1);
  assert.equal(count(f.sent, "Accessibility.enable", "child-a"), 1);
  assert.equal(count(f.sent, "Runtime.enable", "child-a"), 0);
});

test("observe:false와 external detach는 관찰을 되살리지 않고 다음 document prime을 허용한다", () => {
  const f = fixture();
  f.session.ensureAttached(f.wc, { observe: false });
  f.session.ensureAttached(f.wc, { observe: false });
  assert.equal(f.rootPrimers.length, 1);
  assert.equal(f.observationPrimes(), 0);

  f.emitDetach();
  f.session.primeSession(f.wc);
  assert.equal(f.rootPrimers.length, 2);
  assert.equal(f.observationPrimes(), 0);

  f.session.ensureAttached(f.wc);
  assert.equal(f.observationPrimes(), 1);
  assert.equal(count(f.sent, "Runtime.enable", undefined), 1);
});

test("tool recovery reset은 document와 observation을 복원하고 session 자식 상태를 새로 받는다", () => {
  const f = fixture();
  f.session.ensureAttached(f.wc);
  f.emitMessage("Target.attachedToTarget", {
    sessionId: "child-a",
    targetInfo: { type: "iframe" },
  });

  f.session.resetCdpSession(f.wc);
  assert.equal(f.rootPrimers.length, 2);
  assert.equal(f.observationPrimes(), 2);
  assert.deepEqual(f.session.childrenOf(f.wc.id), new Set());
  assert.deepEqual(f.resets.map(([kind]) => kind), ["viewport", "overlay", "ref"]);

  f.emitMessage("Target.attachedToTarget", {
    sessionId: "child-b",
    targetInfo: { type: "iframe" },
  });
  assert.deepEqual(f.childPrimers, ["child-a", "child-b"]);
  assert.equal(count(f.sent, "Runtime.enable", "child-b"), 0);
  assert.equal(count(f.sent, "DOM.enable", "child-b"), 1);
});

test("destroy는 child primer와 frame origin 장부까지 버린다", () => {
  const f = fixture();
  f.session.primeSession(f.wc);
  f.session.noteFrameOrigin(f.wc.id, "https://one.example/a");
  f.wcHandlers.destroyed();

  f.session.noteChildSession(f.wc.id, "child-after-destroy", f.dbg);
  f.session.noteFrameOrigin(f.wc.id, "https://one.example/b");
  assert.deepEqual(f.childPrimers, []);
  assert.deepEqual(f.origins, [["https://one.example"], ["https://one.example"]]);
});

test("부착 관문이 거짓이면 어떤 경로도 debugger 를 붙이지 않고 cdp_blocked 로 거절한다", () => {
  const f = fixture({ allowAttach: () => false, attachBlockedCode: "cdp_blocked" });
  assert.throws(() => f.session.primeSession(f.wc), (e) => e.code === "cdp_blocked");
  assert.throws(() => f.session.ensureAttached(f.wc), (e) => e.code === "cdp_blocked");
  assert.equal(f.dbg.isAttached(), false);
  assert.equal(f.sent.length, 0, "거절된 관문 뒤에 CDP 명령이 나가면 안 된다");
});

test("이미 붙어 있으면 관문이 거짓이어도 그 세션은 계속 쓴다(중간에 끊지 않는다)", () => {
  let allow = true;
  const f = fixture({ allowAttach: () => allow });
  f.session.primeSession(f.wc);
  allow = false;
  assert.doesNotThrow(() => f.session.ensureAttached(f.wc));
  f.session.detachIdle(f.wc);
  assert.throws(() => f.session.ensureAttached(f.wc), (e) => e.code === "cdp_blocked");
});
