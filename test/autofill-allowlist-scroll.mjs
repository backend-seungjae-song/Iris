import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// AF_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ AF_SRC: "/js/browser/autofill-allowlist.js" });

test("자동완성 허용 화면에서 사이트·거르기를 눌러도 목록·상세의 스크롤을 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const hooks = await import("/js/core/hooks.js");
    const mod = await import("/js/browser/autofill-allowlist.js");
    const rows = [];
    for (let s = 0; s < 40; s++) for (let a = 0; a < (s === 3 ? 30 : 1); a++) rows.push({ origin: `https://site${s}.com`, username: `u${a}`, allowed: false });
    window.acHost = { aiLoginList: async () => rows };
    const $ = (q) => document.querySelector(q);
    mod.initCapability({ $, esc: (s) => String(s).replace(/[&<>"]/g, "") });
    await mod.afRefresh();
    const list = () => $(".af-sec-all .af-list"), detail = () => $(".af-detail");
    $('.af-sec-all [data-af-site]:nth-child(4)').click();   // 계정 30개인 사이트 선택
    await new Promise((ok) => setTimeout(ok, 30));
    list().scrollTop = 200; detail().scrollTop = 150;
    const before = { list: list().scrollTop, detail: detail().scrollTop };
    $('.af-sec-all [data-af-site]:nth-child(4)').click();   // 같은 사이트를 다시 누름
    $('[data-filter="off"]').click();
    await new Promise((ok) => setTimeout(ok, 30));
    return { before, after: { list: list().scrollTop, detail: detail().scrollTop } };
  }), { body: `<style>.af-sec-all .af-list{height:120px;overflow-y:auto}.af-detail{height:120px;overflow-y:auto;display:block}.af-sec-open .af-list{display:none}</style><span id="af-sum"></span><div id="af-body"></div>`, overrides });
  assert.ok(r.before.list > 0 && r.before.detail > 0, "준비: 스크롤됨 " + JSON.stringify(r.before));
  assert.deepEqual(r.after, r.before, "다시 그린 뒤에도 스크롤 위치 유지");
});
