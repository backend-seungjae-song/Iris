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

test("Chrome에서 계속을 누르면 주소와 프로필만 보내고 로그인 동기화는 시작하지 않는다", async () => {
  const { handoffToChrome, initHandoff } = await import("../web/js/browser/handoff.js");
  const { rec } = setup();
  const opened = [];
  let captures = 0;
  rec.el.executeJavaScript = () => { captures++; };
  initHandoff({
    acHost: { chromeAuth() { throw new Error("동기화 호출"); }, openInChrome: async request => {
      opened.push(request); return { ok: true };
    } },
    getProfileChromeSource: () => ({ "example.profile": "chrome:Default" }),
    autofillBlocked: () => false, showToast() {}, blog() {},
  });
  handoffToChrome(rec);
  const bar = document.body.children.at(-1);
  const button = bar.children.find(child => child.textContent === "Chrome에서 계속");
  assert.ok(button);
  await button.onclick();
  assert.equal(captures, 0);
  assert.deepEqual(opened, [{ url: rec.url, source: "chrome:Default", partition: "persist:acprof:example.profile", requireProfile: true }]);
});

test("인증 안내에서 브라우저로 계속하는 버튼을 작은 창과 큰 창 모두에서 누를 수 있다", async () => {
  const { withWebPage } = await import("./lib/web-page.mjs");
  await withWebPage(async page => {
    for (const [width, height] of [[320, 568], [390, 844], [1280, 900]]) {
      await page.setViewport({ width, height });
      await page.evaluate(async () => {
        const { initHandoff, webauthnNotice } = await import("/js/browser/handoff.js");
        const el = document.createElement("div");
        el.className = "active";
        el.setAttribute("partition", "persist:acprof:one");
        window.requested = [];
        initHandoff({
          acHost: { chromeAuth() { throw new Error("unexpected"); }, openInChrome: async request => {
            window.requested.push(request); return { ok: true };
          } }, getProfileChromeSource: () => ({ one: "chrome:Default" }),
          autofillBlocked: () => false, showToast() {}, blog() {},
        });
        webauthnNotice({ phase: "start", host: "example.com" }, "", "", el, { tabId: "1", url: "https://example.com/", el });
      });
      assert.ok(await page.evaluate(() => [...document.querySelectorAll(".hoff-bar button")].every(button => {
        const r = button.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      })), String(width));
      const button = page.locator("::-p-text(Chrome에서 계속)");
      await button.click();
      await page.locator("::-p-text(다시 열기)").click();
      const requests = await page.evaluate(() => window.requested);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].source, "chrome:Default");
      assert.deepEqual(requests[1], requests[0]);
      assert.match(await page.$eval(".hoff-text", el => el.textContent), /열기 요청을 보냈습니다/);
    }
  }, { body: '<link rel="stylesheet" href="/css/00-tokens.css"><link rel="stylesheet" href="/css/22-handoff.css">' });
});

test("연결 프로필을 열 수 없으면 기본 브라우저는 사용자가 다시 선택할 때만 연다", async () => {
  const { handoffToChrome, initHandoff } = await import("../web/js/browser/handoff.js");
  const { rec } = setup();
  const opened = [];
  initHandoff({
    acHost: { chromeAuth() {}, openInChrome: async request => {
      opened.push(request);
      return request.requireProfile ? { ok: false, profileUnavailable: true, error: "프로필을 열 수 없습니다." } : { ok: true };
    } }, getProfileChromeSource: () => ({ "example.profile": "chrome:Default" }),
    autofillBlocked: () => false, showToast() {}, blog() {},
  });
  handoffToChrome(rec);
  const button = document.body.children.at(-1).children.find(child => child.textContent === "Chrome에서 계속");
  await button.onclick();
  assert.equal(opened.length, 1);
  assert.equal(button.textContent, "기본 브라우저에서 계속");
  await button.onclick();
  assert.deepEqual(opened.map(request => request.requireProfile), [true, false]);
  assert.equal(opened[1].source, "");
});
