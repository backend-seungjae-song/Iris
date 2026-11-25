// AI 가 쓰는 탭을 숨길 때 패널 크기로 뒤에 깔아 두면, 메인은 그 탭에 크기 대체 보정을 걸지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const registry = require("../native/electron/visibility-registry.cjs");
const { createHiddenViewport } = require("../native/electron/cdp-hidden-viewport.cjs");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("뒤에 깔린 탭 장부는 창마다 마지막 보고만 남기고 보이는 탭 장부와 따로 움직임", () => {
  registry.reportBehind(1, [11, 12]);
  registry.reportBehind(2, [21]);
  assert.equal(registry.isBehind(11), true);
  assert.equal(registry.isBehind(21), true);
  registry.reportBehind(1, [12]);
  assert.equal(registry.isBehind(11), false, "새 보고가 이전 목록을 대체");
  assert.equal(registry.isShown(12), false, "뒤에 깔린 탭은 보이는 탭이 아님(select 목록 보호 기준)");
  registry.dropBehind(1);
  assert.equal(registry.isBehind(12), false);
  assert.equal(registry.isBehind(21), true, "다른 창의 보고는 유지");
  registry.dropBehind(2);
});

function rig(behindIds) {
  const sent = [];
  const send = (method, params) => {
    sent.push({ method, params });
    return Promise.resolve(method === "Runtime.evaluate" ? { result: { value: [0, 0] } } : {});
  };
  const viewport = createHiddenViewport({
    isTabShown: () => false, isBehindTab: (id) => behindIds.includes(id), shownStateKnown: () => true,
    hasExplicitDevice: () => false, navigationEpoch: () => 1, now: () => Date.now(), isDisabled: () => false,
  });
  viewport.setDefaultViewport(843, 857);
  const metrics = () => sent.filter((s) => s.method === "Emulation.setDeviceMetricsOverride");
  return { viewport, send, metrics };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("뒤에 깔린 탭에는 숨은 탭 대체 크기를 걸지 않고 그렇지 않은 탭에는 건다", async () => {
  const { viewport, send, metrics } = rig([7]);
  assert.equal(viewport.pin(7, send), false);
  assert.equal(viewport.pin(7, send, { onlyIfCollapsed: true }), false);
  await viewport.ensureReady(send, 7, "snapshot");
  await settle();
  assert.equal(metrics().length, 0, "크기 보정이 나가면 패널 크기와 다른 크기로 바뀜");
  assert.equal(viewport.pin(8, send), true, "깔리지 않은 탭은 기존대로 보정");
  await viewport.ensureReady(send, 9, "snapshot");
  assert.equal(metrics().length >= 2, true);
});

test("뒤에 깔린 탭의 크기는 숨은 탭에 물려줄 기준 크기로 기록하지 않음", async () => {
  const sent = [];
  const send = (method) => { sent.push(method); return Promise.resolve({ result: { value: [999, 555] } }); };
  const viewport = createHiddenViewport({
    isTabShown: () => false, isBehindTab: (id) => id === 7, shownStateKnown: () => true,
    hasExplicitDevice: () => false, navigationEpoch: () => 1, now: () => Date.now(), isDisabled: () => false,
  });
  viewport.setDefaultViewport(843, 857);
  await viewport.ensureReady(send, 7, "snapshot");
  const later = [];
  await viewport.ensureReady((m, p) => { later.push({ m, p }); return Promise.resolve({ result: { value: [0, 0] } }); }, 8, "snapshot");
  const applied = later.find((x) => x.m === "Emulation.setDeviceMetricsOverride");
  assert.equal(applied.p.width, 843);
});

test("main 은 뒤에 깔린 탭에 캡처 유지를 걸지 않고, 깔리는 순간 대체 크기를 거둠", () => {
  const main = read("../native/electron/main.cjs");
  const hold = sliceBetween(main, "setCaptureHold(async", "\n});", "setCaptureHold");
  assert.match(hold, /needsHold\(on, visibilityRegistry\.isShown\(id\) \|\| visibilityRegistry\.isBehind\(id\)\)/);
  const behind = sliceBetween(main, 'ipcMain.on("ac-tabs-behind"', "\n});", "ac-tabs-behind");
  assert.match(behind, /visibilityRegistry\.reportBehind\(/);
  assert.match(behind, /clearAutoViewport\(/);
  assert.match(behind, /left[\s\S]*pinHiddenViewportById\(/, "기준에서 빠진 탭은 대체 크기를 다시 건다");
  assert.match(read("../native/electron/preload.cjs"), /ac-tabs-behind/);
  assert.match(read("../native/electron/cdp-control.cjs"), /isBehindTab: \(wcId\) => isTabBehind\(wcId\)/);
});

test("렌더러는 비활성이고 AI 가 쓰는 탭만 뒤에 깔 대상으로 판정", () => {
  const src = read("../web/js/browser/webview.js");
  const fn = sliceBetween(src, "export function isKeptBehind(", "\n}", "isKeptBehind") + "\n}";
  const body = fn.replace("export function", "function");
  const isKeptBehind = new Function(`${body}\nreturn isKeptBehind;`)();
  assert.equal(isKeptBehind({ active: false, qaOwned: true, aiProtected: null }), true, "QA 소유는 보호 신호 없이도");
  assert.equal(isKeptBehind({ active: false, qaOwned: false, aiProtected: new Set(["a"]), tabId: "a" }), true);
  assert.equal(isKeptBehind({ active: false, qaOwned: false, aiProtected: new Set(["a"]), tabId: "b" }), false, "5분 지난 탭은 제외");
  assert.equal(isKeptBehind({ active: false, qaOwned: false, aiProtected: null, tabId: "a" }), false, "신호 불명이면 일반 탭을 깔지 않음");
  assert.equal(isKeptBehind({ active: true, qaOwned: true, aiProtected: null }), false, "앞 탭은 대상이 아님");
});


test("뒤에 깔린 목록 보고는 새로 깔린 탭과 빠진 탭을 돌려줌", () => {
  assert.deepEqual(registry.reportBehind(5, [1, 2]), { fresh: [1, 2], left: [] });
  assert.deepEqual(registry.reportBehind(5, [2, 3]), { fresh: [3], left: [1] });
  assert.deepEqual(registry.reportBehind(5, []), { fresh: [], left: [2, 3] });
  assert.equal(registry.isBehind(2), false);
});

test("AI 사용 보호가 끝나는 가장 이른 시각을 돌려줌", async () => {
  const { setAiRecentUse, nextAiRecentExpiry } = await import("../web/js/browser/ai-state.js");
  setAiRecentUse([{ tabId: "a", until: 5000 }, { tabId: "b", until: 3000 }, { tabId: "c", until: 900 }]);
  assert.equal(nextAiRecentExpiry(1000), 3000, "이미 지난 것은 제외");
  assert.equal(nextAiRecentExpiry(6000), 0, "남은 보호가 없으면 0");
  setAiRecentUse([]);
});

test("실제로 그려지지 않는 탭(크기 0)은 뒤에 깔 대상이 아님", () => {
  const src = read("../web/js/browser/webview.js");
  const fn = sliceBetween(src, "export function isKeptBehind(", "\n}", "isKeptBehind") + "\n}";
  const isKeptBehind = new Function(`${fn.replace("export function", "function")}\nreturn isKeptBehind;`)();
  assert.equal(isKeptBehind({ active: false, qaOwned: true, aiProtected: null, painted: false }), false);
  assert.equal(isKeptBehind({ active: false, qaOwned: true, aiProtected: null, painted: true }), true);
});

test("뒤 배치 재판정은 layout owner와 visibility 복귀를 감시한다", () => {
  const src = read("../web/js/browser/webview.js");
  assert.match(src, /visibilitychange/);
  assert.match(src, /observe\(stack\.parentElement\)/);
});

test("0×0 후보 제거 뒤 .ai-keep를 지우고 원래 슬롯 복귀 시 다시 붙인다", async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  const attrs = new Set();
  const classes = new Set();
  const observers = [];
  const owner = {};
  let size = { width: 0, height: 0 };
  const classList = {
    contains: (name) => classes.has(name),
    toggle: (name, force) => { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
  };
  const stack = {
    classList,
    parentElement: owner,
    toggleAttribute: (name, force) => { if (force) attrs.add(name); else attrs.delete(name); },
    hasAttribute: (name) => attrs.has(name),
  };
  const el = {
    classList,
    setAttribute: (name) => attrs.add(name),
    removeAttribute: (name) => attrs.delete(name),
    getBoundingClientRect: () => size,
    getWebContentsId: () => 701,
    dataset: {},
  };
  const listeners = new Map();
  globalThis.window = { acHost: { tabsBehind() {} } };
  globalThis.document = {
    getElementById: (id) => id === "wv-stack" ? stack : null,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } };
  try {
    const { replaceBrowserState } = await import("../web/js/browser/state.js");
    const { replaceTabs, setCenterSpace, setActiveTab } = await import("../web/js/center/tab-store.js");
    const { registerWebview } = await import("../web/js/browser/webview-store.js");
    const { syncAiBehindPlacement } = await import(`../web/js/browser/webview.js?layout=${Date.now()}`);
    replaceBrowserState({ tabsBySpace: { layout: [{ id: "front", kind: "browser" }, { id: "behind", kind: "browser", qaRunId: "run" }] },
      activeBySpace: {}, activeSpace: "layout", bookmarksBySpace: {}, bookmarksCommon: [], profiles: [], profileSources: {}, defaultProfileBySpace: {}, urlHistoryBySpace: {} });
    setCenterSpace("layout");
    replaceTabs("layout", [{ id: "front", kind: "browser" }, { id: "behind", kind: "browser" }]);
    setActiveTab("layout", "front");
    registerWebview("behind", { el, ready: false, renderGone: false });

    syncAiBehindPlacement(new Set());
    assert.equal(classList.contains("ai-keep"), false, "0×0 후보 제거 뒤 stack 보존 해제");
    assert.equal(classList.contains("ai-behind"), false, "0×0 후보의 class 제거");
    assert.equal(attrs.has("data-ai-keep-pending"), true);

    size = { width: 500, height: 300 };
    observers.find((observer) => observer.target === owner)?.callback();
    syncAiBehindPlacement(new Set());
    assert.equal(classList.contains("ai-keep"), true, "원래 layout slot 복귀 뒤 stack 보존");
    assert.equal(classList.contains("ai-behind"), true, "실제 크기 복귀 뒤 후보 class 재계산");
    assert.equal(attrs.has("data-ai-keep-pending"), false);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldResizeObserver === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("뒤에 깔린 탭의 누르기는 포커스를 빌리지 않고 키·글자는 기존 판정을 따름", async () => {
  const { qaFocusPlan } = await import("../native/electron/user-focus.cjs").then((m) => m.default || m);
  const typingElsewhere = { owns: false, idle: false, windowFocused: true };
  assert.equal(qaFocusPlan(typingElsewhere, true, true), "trusted", "뒤에 깔린 탭의 누르기");
  assert.equal(qaFocusPlan(typingElsewhere, true, false), "borrow");
  assert.equal(qaFocusPlan(typingElsewhere, false, false), "wait");
});

test("QA 입력은 포커스 준비에 동작 이름을 넘김(네이티브·worker 두 구현)", async () => {
  const { createQaInputCommands } = require("../native/electron/cdp-qa-input.cjs");
  const seen = [];
  const send = async (method, params = {}) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 500, clientHeight: 300 } };
    if (method === "Runtime.evaluate") {
      const e = params.expression || "";
      return { result: { value: e.includes("inspectLoginPage") ? { fields: [], reasons: [] }
        : e.includes("document.activeElement") ? { role: "textbox", name: "검색", tag: "input", at: { x: 40, y: 30 }, disabled: false } : true } };
    }
    return {};
  };
  send.on = () => send; send.frames = () => [null];
  await createQaInputCommands({ prepareFocus: async (_wc, action) => { seen.push(action); return "guarded"; } })["qa-input"](send, {}, { action: "key", key: "Tab" }).catch(() => {});
  assert.deepEqual(seen, ["key"], "prepareFocus 가 동작 이름을 받아야 메인이 누르기와 키를 가름");
  assert.match(read("../server/mcp-worker/qa-input-commands.js"), /await prepareFocus\(wc, action\)/);
  assert.match(read("../server/mcp-worker/qa-route.js"), /prepareFocus: async \(_wc, action\) => \(await step\("focus\.prepare", \{ action \}\)\)/);
});

// 앱 셸 문서 대역: 실측대로 webview 로 옮길 때는 앞 요소의 focusout 만 일으키고(이때 activeElement 는 앞 요소) webview 자신에는 이벤트가 없는 최소 DOM
function fakeShell() {
  const body = { tagName: "BODY" };
  const listeners = [];
  const doc = { activeElement: body, body, documentElement: { tagName: "HTML" }, __irisQaBorrowed: 0 };
  const fireOut = (old) => { for (const [type, fn] of [...listeners]) if (type === "focusout") fn({ target: old }); };
  const focusTo = (el) => { const old = doc.activeElement; if (old !== body) fireOut(old); doc.activeElement = el; };
  const blurOf = (el) => { if (doc.activeElement === el) { fireOut(el); doc.activeElement = body; } };
  doc.addEventListener = (type, fn) => listeners.push([type, fn]);
  doc.removeEventListener = (type, fn) => { const i = listeners.findIndex(([t, f]) => t === type && f === fn); if (i >= 0) listeners.splice(i, 1); };
  const wvs = [];
  doc.querySelectorAll = () => wvs;
  const input = (name) => ({ tagName: "INPUT", name, isConnected: true,
    focus() { focusTo(this); }, blur() { blurOf(this); } });
  const webview = (id, behind = true) => {
    const cls = new Set(behind ? ["ai-behind"] : []);
    const el = { tagName: "WEBVIEW", id, cls, classList: { contains: (c) => cls.has(c) }, getWebContentsId: () => id,
      focus() { focusTo(this); }, blur() { blurOf(this); } };
    wvs.push(el); return el;
  };
  const host = { isDestroyed: () => false, executeJavaScript: async (expr) => new Function("document", `return ${expr}`)(doc) };
  const wc = (id) => ({ id, isDestroyed: () => false, hostWebContents: host });
  return { doc, input, webview, wc, listeners };
}
const userFocus = require("../native/electron/user-focus.cjs");
const nextTask = () => new Promise((r) => setTimeout(r, 0));

test("보호를 켠 뒤 뒤에 깐 탭이 포커스를 받으면 바로 다음 태스크에서 직전 요소로 되돌아감", async () => {
  const sh = fakeShell(), term = sh.input("term"), ai = sh.webview(9);
  term.focus();
  ai.focus();
  await nextTask();
  assert.equal(sh.doc.activeElement, ai, "보호 전에는 AI 클릭이 포커스를 가져감(대조)");
  term.focus();
  assert.equal(await userFocus.armAiFocus(sh.wc(9)), true);
  ai.focus();
  await nextTask();
  assert.equal(sh.doc.activeElement, term, "명령이 끝나기를 기다리지 않고 되돌아가야 사용자 키가 AI 탭으로 새지 않음");
  assert.equal(await userFocus.releaseAiFocus(sh.wc(9)), "kept", "이미 되돌렸으면 끝낼 때 건드리지 않음");
  assert.equal(sh.listeners.length, 0, "끝나면 감시를 뗌");
  term.focus(); ai.focus(); await nextTask();
  assert.equal(sh.doc.activeElement, ai, "끝난 뒤의 포커스는 되돌리지 않음");
});

test("뒤에 깐 탭 둘이 겹쳐 조작돼도 앞 탭이 가져간 포커스를 사용자 포커스로 저장하지 않음", async () => {
  const sh = fakeShell(), term = sh.input("term"), a = sh.webview(9), b = sh.webview(10);
  term.focus();
  await userFocus.armAiFocus(sh.wc(9));
  sh.doc.activeElement = a;                       // 9 의 되돌림이 아직 오기 전에 10 이 시작
  await userFocus.armAiFocus(sh.wc(10));
  sh.doc.activeElement = term;
  assert.equal(await userFocus.releaseAiFocus(sh.wc(9)), "kept");   // 9 의 보호가 끝난 뒤
  b.focus(); await nextTask();
  assert.equal(sh.doc.activeElement, term, "10 의 저장값은 9 의 webview 가 아니라 사용자 요소");
});

test("사용자가 조작 중인 탭을 앞으로 올려 안을 누르면 되돌리지 않음", async () => {
  const sh = fakeShell(), term = sh.input("term"), ai = sh.webview(9);
  term.focus();
  await userFocus.armAiFocus(sh.wc(9));
  ai.cls.delete("ai-behind");                     // 사용자가 그 탭을 앞으로 올림
  ai.focus(); await nextTask();
  assert.equal(sh.doc.activeElement, ai, "앞 탭의 포커스는 사용자 것");
  assert.equal(await userFocus.releaseAiFocus(sh.wc(9)), "kept");
  assert.equal(sh.doc.activeElement, ai, "명령이 끝나도 사용자 포커스를 되돌리지 않음");
});

test("뒤에 깐 탭에 포커스가 남은 채 끝나면 끝날 때 되돌리고 보호하지 않은 탭이면 건드리지 않음", async () => {
  const sh = fakeShell(), term = sh.input("term"), ai = sh.webview(9);
  term.focus();
  await userFocus.armAiFocus(sh.wc(9));
  sh.doc.activeElement = ai;                      // 포커스 이동 알림 없이 옮겨졌다고 가정
  assert.equal(await userFocus.releaseAiFocus(sh.wc(9)), "restored");
  assert.equal(sh.doc.activeElement, term);
  assert.equal(await userFocus.releaseAiFocus(sh.wc(9)), "kept", "켜지 않은 탭의 끝내기는 아무것도 안 함");
});

test("QA 가 의도해서 빌리거나 잡은 포커스는 보호가 되돌리지 않고 반환은 저장한 요소로 감", async () => {
  const sh = fakeShell(), term = sh.input("term"), ai = sh.webview(9);
  term.focus();
  await userFocus.armAiFocus(sh.wc(9));
  assert.equal(await userFocus.borrowWindowFocus(sh.wc(9)), true);
  await nextTask();
  assert.equal(sh.doc.activeElement, ai, "빌린 포커스는 키 입력이 가야 하므로 유지");
  assert.equal(await userFocus.returnWindowFocus(sh.wc(9)), "restored");
  assert.equal(sh.doc.activeElement, term);
  ai.focus(); await nextTask();
  assert.equal(sh.doc.activeElement, term, "반환 뒤에는 보호가 다시 적용");
});

function guardRig({ behind = [7], arm, release } = {}) {
  const log = [];
  const causality = { enter: (id) => { log.push("enter" + id); return id; }, leave: (t) => { log.push("leave" + t); }, driving: () => true };
  const { createAiFocusGuard } = require("../native/electron/ai-focus-guard.cjs");
  const guard = createAiFocusGuard({ causality, isBehind: (id) => behind.includes(id), liveWc: (id) => ({ id }),
    arm: arm || (async (wc) => { log.push("arm" + wc.id); return true; }),
    release: release || (async (wc) => { log.push("release" + wc.id); }) });
  return { guard, log };
}

test("겹친 명령은 마지막이 끝날 때 한 번만 해제하고 앞 탭 명령은 건드리지 않음", async () => {
  const { guard, log } = guardRig();
  const t1 = guard.enter(7), t2 = guard.enter(7);
  guard.leave(t2); await guard.released(7);
  assert.equal(log.includes("release7"), false);
  guard.leave(t1); await guard.released(7);
  assert.deepEqual(log.filter((x) => /arm|release/.test(x)), ["arm7", "release7"]);
  log.length = 0;
  guard.leave(guard.enter(8)); await guard.released(8);
  assert.deepEqual(log, ["enter8", "leave8"]);
});

test("첫 명령은 보호가 켜진 뒤에 나가고 같은 탭의 다음 보호는 앞 해제가 끝난 뒤에 켜짐", async () => {
  let openArm, openRelease;
  const log = [];
  const { guard } = guardRig({
    arm: (wc) => new Promise((r) => { log.push("arm-start"); openArm = () => { log.push("arm-done"); r(true); }; }),
    release: () => new Promise((r) => { log.push("release-start"); openRelease = () => { log.push("release-done"); r(); }; }),
  });
  const t1 = guard.enter(7);
  let ready = false; guard.armed(t1).then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ready, false, "보호가 켜지기 전에는 armed 가 풀리지 않음");
  openArm(); await guard.armed(t1);
  assert.equal(ready, true);
  guard.leave(t1);
  await new Promise((r) => setTimeout(r, 5));
  const t2 = guard.enter(7);                     // 앞 해제가 끝나기 전에 다음 명령 시작
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["arm-start", "arm-done", "release-start"], "해제 중에는 두 번째 arm 이 시작하지 않음");
  openRelease(); await new Promise((r) => setTimeout(r, 5));
  assert.equal(log.at(-1), "arm-start");
  openArm(); await guard.armed(t2);
});

test("앞 해제 뒤 뒤 배치가 풀린 탭에는 새 webview를 보호하지 않음", async () => {
  let releaseDone;
  let behind = true;
  const armed = [];
  const causality = { enter: (id) => id, leave() {}, driving: () => true };
  const { createAiFocusGuard } = require("../native/electron/ai-focus-guard.cjs");
  const guard = createAiFocusGuard({
    causality,
    isBehind: () => behind,
    liveWc: (id) => ({ id }),
    arm: async (wc) => { armed.push(wc.id); return true; },
    release: () => new Promise((resolve) => { releaseDone = resolve; }),
  });
  const first = guard.enter(7);
  await guard.armed(first);
  guard.leave(first);
  await Promise.resolve();
  behind = false;
  const second = guard.enter(7);
  releaseDone();
  await guard.armed(second);
  assert.deepEqual(armed, [7]);
});

test("보호 중 뒤 배치가 풀린 뒤 시작한 명령의 leave는 기존 보호 깊이를 줄이지 않음", async () => {
  let behind = true;
  const log = [];
  const causality = { enter: (id) => { log.push("enter" + id); return id; }, leave: (id) => log.push("leave" + id), driving: () => true };
  const { createAiFocusGuard } = require("../native/electron/ai-focus-guard.cjs");
  const guard = createAiFocusGuard({ causality, isBehind: () => behind, liveWc: (id) => ({ id }),
    arm: async (wc) => { log.push("arm" + wc.id); return true; },
    release: async (wc) => { log.push("release" + wc.id); } });
  const first = guard.enter(7);
  await guard.armed(first);
  behind = false;
  const skipped = guard.enter(7);

  guard.leave(skipped);
  await Promise.resolve();
  assert.equal(log.includes("release7"), false, "보호를 등록하지 않은 명령은 기존 보호를 해제하지 않음");

  guard.leave(first);
  await guard.released(7);
  assert.equal(log.filter((entry) => entry === "release7").length, 1);
});

test("호스트가 응답하지 않아도 명령 끝내기는 기다리지 않고 해제 실패는 결과를 바꾸지 않음", async () => {
  const hung = guardRig({ release: () => new Promise(() => {}) });
  const t = hung.guard.enter(7);
  await hung.guard.armed(t);
  assert.equal(hung.guard.leave(t), undefined, "leave 가 해제를 기다리면 결과가 타임아웃 두 번만큼 늦어짐");
  const broken = guardRig({ arm: async () => { throw new Error("host gone"); } });
  const t2 = broken.guard.enter(7);
  await broken.guard.armed(t2);
  broken.guard.leave(t2);
  await broken.guard.released(7);
  assert.equal(broken.log.includes("release7"), false, "켜지지 않았으면 해제하지 않음");
});
