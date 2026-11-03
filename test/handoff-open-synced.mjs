import assert from "node:assert/strict";
import test from "node:test";
import { callHook, clearHooks } from "../web/js/core/hooks.js";
import { initCapability } from "../web/js/browser/handoff.js";

// 막대 DOM 흉내: createElement·appendChild·remove 만 사용
function fakeDocument() {
  const el = () => ({ style: {}, children: [], appendChild(c) { this.children.push(c); c.isConnected = true; return c; },
    insertBefore(c) { this.children.push(c); return c; }, remove() { this.isConnected = false; } });
  return { createElement: el, body: el() };
}

function setup({ source = "chrome:Profile 6", blocked = false } = {}) {
  const calls = [];
  const reloads = [];
  globalThis.document = fakeDocument();
  clearHooks();
  initCapability({
    acHost: { chromeAuth: async (...args) => { calls.push(args); return { ok: true, harvested: 3, live: 3, staged: 0 }; } },
    showToast: () => {},
    getProfileChromeSource: () => (source ? { "example.profile": source } : {}),
    autofillBlocked: () => blocked,
    blog: () => {},
  });
  const rec = { tabId: "t1", url: "https://example.com/a",
    el: { getAttribute: (n) => (n === "partition" ? "persist:acprof:example.profile" : null),
      executeJavaScript: async () => ({ url: "https://example.com/a", fields: [] }), reload: () => reloads.push(1) } };
  return { calls, reloads, rec };
}

test("짝지은 Chrome 프로필이 있는 탭은 넘기기로 열고 창을 닫으면 가져온 뒤 새로고침한다", async () => {
  const { calls, rec } = setup();
  assert.equal(callHook("handoff.openSynced", rec), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [["https://example.com/a", "persist:acprof:example.profile", "chrome:Profile 6", []]]);
});

test("짝지은 프로필이 없거나 AI 가 조작 중인 탭은 넘기지 않는다", async () => {
  for (const opts of [{ source: "" }, { blocked: true }]) {
    const { calls, rec } = setup(opts);
    assert.equal(callHook("handoff.openSynced", rec), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);
  }
});
