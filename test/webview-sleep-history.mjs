// 탭 재우기: 방문 기록을 저장했다가 깨울 때 넘기고, 입력칸에 글이 남은 탭은 재우지 않는다
import assert from "node:assert/strict";
import test from "node:test";

const HISTORY = { index: 0, entries: [{ url: "https://a.test/", title: "A", pageState: "AAAA" }] };
const created = [];
const exported = [];
let exportResult = { ok: true, history: HISTORY };

globalThis.acHost = { webviewPolicy: () => ({ lru: true, idleMin: 5, recent: 0 }) };
globalThis.window = { acHost: globalThis.acHost };
globalThis.document = { addEventListener() {}, getElementById: () => null };
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;   // 정기 정리 타이머는 검사에서 직접 부른다
const state = await import("../web/js/browser/state.js");
const store = await import("../web/js/browser/webview-store.js");
const ai = await import("../web/js/browser/ai-state.js");
const webview = await import("../web/js/browser/webview.js");
const noop = () => {};
webview.initWebview({
  $: () => null, esc: (s) => s, wsSend: noop, BROWSER_MODE: false, bNote: {}, renderBmTabs: noop, renderTabs: noop,
  getSpaces: () => [{ id: "s1" }],
  createWebview: (...args) => { created.push(args); return { el: { dataset: {} } }; },
  forgetTabWc: noop, showToast: noop,
  exportBrowserHistory: async (wcId) => { exported.push(wcId); return exportResult; },
});
globalThis.setInterval = realSetInterval;
ai.setAiTargets([]);
ai.setAiRecentUse([]);

function seed(ids, extra = {}) {
  state.replaceBrowserState({ tabsBySpace: { s1: ids.map((id) => ({ id, url: `https://${id.slice(8)}.test/`, ...(extra[id] || {}) })) }, activeBySpace: {} });
  for (const id of ids) {
    store.registerWebview(id, { el: { dataset: { profile: "p1" }, getWebContentsId: () => 40 + ids.indexOf(id), remove() {} }, ready: true, url: `https://${id.slice(8)}.test/` });
    store.recordWebviewUse(id, 1);   // 오래전에 쓴 탭
  }
}

test("재운 탭은 방문 기록을 저장하고, 깨우면 그 기록으로 다시 만든다", async () => {
  seed(["browser:a"]);
  await webview.sweepIdleWebviews();
  assert.ok(!store.getWebview("browser:a"), "재워짐");
  assert.deepEqual(store.getDiscardedWebview("browser:a").history, HISTORY);
  assert.deepEqual(exported, [40]);
  created.length = 0;
  webview.wakeWebview("browser:a");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0][3], HISTORY, "createWebview 네 번째 인자로 기록 전달");
  assert.equal(created[0][2], "https://a.test/");
});

test("입력칸에 글이 남은 탭은 재우지 않고, 글이 없어지면 재운다", async () => {
  seed(["browser:draft"]);
  webview.setTabStatus("browser:draft", { formDirty: true });
  assert.equal(webview.holdsDraft("browser:draft"), true);
  await webview.sweepIdleWebviews();
  assert.ok(store.getWebview("browser:draft"), "글이 남아 있으면 그대로");
  await webview.sweepIdleWebviews(0);
  assert.ok(store.getWebview("browser:draft"), "메모리가 심각할 때도 그대로");
  webview.setTabStatus("browser:draft", { formDirty: false });
  await webview.sweepIdleWebviews();
  assert.ok(!store.getWebview("browser:draft"), "글이 없어지면 재움");
});

test("입력 상태는 백그라운드 절전 보호 판정을 바꾸지 않는다", () => {
  seed(["browser:t"]);
  webview.setTabStatus("browser:t", { formDirty: true });
  assert.equal(webview.webviewProtected("browser:t", new Set(), new Set()), false);
});

test("기록을 받는 사이 다시 쓴 탭은 재우지 않는다", async () => {
  seed(["browser:busy"]);
  exportResult = { ok: true, history: HISTORY };
  const pending = webview.sweepIdleWebviews();
  store.recordWebviewUse("browser:busy", Date.now());
  await pending;
  assert.ok(store.getWebview("browser:busy"), "그대로");
});

test("기록을 못 받으면 예전처럼 주소만 남기고 재운다", async () => {
  seed(["browser:nohist"]);
  exportResult = { ok: false };
  await webview.sweepIdleWebviews();
  const slept = store.getDiscardedWebview("browser:nohist");
  assert.equal(slept.url, "https://nohist.test/");
  assert.equal("history" in slept, false);
  created.length = 0;
  webview.wakeWebview("browser:nohist");
  assert.equal(created[0][3], null);
});

test("잠들지 않게 한 탭은 유휴·메모리 심각 때 모두 재우지 않는다", async () => {
  seed(["browser:keep"], { "browser:keep": { keepAwake: true } });
  exportResult = { ok: true, history: HISTORY };
  await webview.sweepIdleWebviews();
  assert.ok(store.getWebview("browser:keep"), "유휴");
  await webview.sweepIdleWebviews(0);
  assert.ok(store.getWebview("browser:keep"), "메모리 심각");
});
