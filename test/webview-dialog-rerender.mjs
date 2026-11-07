import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// WV_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ WV_SRC: "/js/browser/webview.js" });

test("페이지 prompt 창은 같은 질문이면 방송·탭 전환에 다시 그려지지 않아 입력 중인 글자를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const hooks = await import("/js/core/hooks.js");
    const wv = await import("/js/browser/webview.js");
    hooks.provide("detach.boundTab", () => "t1");
    const $ = (q) => document.querySelector(q);
    wv.initWebview({ $, esc: (s) => String(s).replace(/[&<>"]/g, ""), wsSend() {}, BROWSER_MODE: true, bNote() {}, renderBmTabs() {}, renderTabs() {},
      getSpaces: () => [], createWebview() {}, forgetTabWc() {}, showToast() {} });
    wv.setTabDialog("t1", { kind: "prompt", message: "이름?", def: "기본값", wc: 7, byAi: false });
    wv.renderTabDialog();
    const inp = $("#wd-in");
    inp.value = "사용자가 친 글자";
    inp.setSelectionRange(2, 2);
    wv.renderTabDialog(); wv.renderTabDialog();   // 상태 방송
    const now = $("#wd-in");
    return { same: now === inp, value: now.value, caret: now.selectionStart };
  }), { body: `<div id="wv-dialog" hidden></div>`, overrides });
  assert.equal(r.same, true, "입력칸을 다시 만들지 않음");
  assert.equal(r.value, "사용자가 친 글자");
  assert.equal(r.caret, 2, "선택·커서 위치 유지");
});
