import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// ACCT_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ ACCT_SRC: "/js/browser/accounts-screen.js" });

test("계정 화면을 다시 불러오는 동안 직전 로그인 요약·합계·Chrome 상자·스크롤을 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const state = await import("/js/browser/state.js");
    const screen = await import("/js/browser/accounts-screen.js");
    const profiles = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `프로필${i}` }));
    state.initBrowserState({ wsSend() {} });
    state.replaceBrowserState({ profiles, defaultProfileBySpace: {} });
    let hang = false;
    window.acHost = {
      credsSummary: (part) => (hang ? new Promise(() => {}) : Promise.resolve({ count: 2, accounts: [{ host: "a.com", user: "u" }] })),
      listChromeProfiles: () => (hang ? new Promise(() => {}) : Promise.resolve([{ id: "Default", label: "개인" }])),
      chromeDataBlocked: async () => "",
    };
    const $ = (q) => document.querySelector(q);
    screen.initCapability({ $, esc: (s) => s, cssEsc: (s) => s, browserMode: false, showToast() {}, orderedSpaces: () => [] });
    screen.acctRefresh();
    await new Promise((ok) => setTimeout(ok, 300));
    const snap = () => ({
      sum: $("#acct-sum").textContent, line: $("[data-creds]").textContent,
      chrome: $("#acct-chrome").textContent, top: $(".acct-main").scrollTop,
    });
    $(".acct-main").scrollTop = 120;
    const before = snap();
    hang = true;
    screen.acctRefresh();          // 응답이 오기 전 상태를 바로 읽음
    return { before, during: snap() };
  }), { body: `<style>.acct-main{height:150px;overflow:auto}</style><div id="acct-sum"></div><div id="acct-body"></div>`, overrides });
  assert.ok(r.before.line.length > 0 && r.before.top > 0, "준비: 응답이 반영되고 스크롤됨 " + JSON.stringify(r.before));
  assert.equal(r.during.line, r.before.line, "로그인 요약이 '확인 중…'으로 바뀌지 않음");
  assert.equal(r.during.sum, r.before.sum, "머리 합계가 0으로 바뀌지 않음");
  assert.equal(r.during.chrome, r.before.chrome, "Chrome 상자가 스피너로 바뀌지 않음");
  assert.equal(r.during.top, r.before.top, "스크롤이 맨 위로 가지 않음");
});
