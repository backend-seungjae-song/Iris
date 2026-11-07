import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// BMK_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ BMK_SRC: "/js/browser/bookmarks.js" });

test("북마크바는 방송으로 다시 그려져도 이름 편집 입력칸과 열린 폴더 메뉴를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const state = await import("/js/browser/state.js");
    const bm = await import("/js/browser/bookmarks.js");
    state.initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: "sp", wsSend() {} });
    state.replaceBrowserState({ bookmarksBySpace: { sp: [
      { url: "https://a.com/", title: "에이" },
      { folder: "f1", title: "폴더", items: [{ url: "https://b.com/", title: "비" }] },
    ] } });
    const $ = (q) => document.querySelector(q);
    bm.initBookmarks({ $, esc: (s) => String(s).replace(/[&<>"]/g, ""), urlInput: $("#u"), openBrowser() {}, navigate() {} });
    bm.wireBookmarkBar();
    bm.renderBookmarks();
    // 편집 중인 입력칸
    $('.bmk[data-key^="space|u|"] .bmk-e').click();
    const inp = $(".bmk-in");
    inp.value = "입력 중인 새 이름";
    bm.renderBookmarks();   // 서버 방송
    const edit = { alive: inp.isConnected, value: ($(".bmk-in") || {}).value, focused: !!$(".bmk-in") && document.activeElement === $(".bmk-in") };
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const afterEsc = { inputs: document.querySelectorAll(".bmk-in").length };
    // 열린 폴더 메뉴
    $('.bmk[data-key^="space|f|"]').click();
    const btn = $("#bmk-menu button"); btn.__mark = 1;
    bm.renderBookmarks(); bm.renderBookmarks();
    return { edit, afterEsc, menuKept: !!$("#bmk-menu button") && $("#bmk-menu button").__mark === 1 };
  }), { body: `<input id="u"><button id="wv-bookmark"></button><button id="bmk-add"></button><button id="bmk-folder-add"></button><div id="bookmark-bar"></div>`, overrides });
  assert.equal(r.edit.alive, true, "편집 입력칸이 방송에 지워지지 않음");
  assert.equal(r.edit.value, "입력 중인 새 이름", "입력 중이던 글자 유지");
  assert.equal(r.edit.focused, true, "포커스 유지");
  assert.equal(r.afterEsc.inputs, 0, "Esc 로 끝내면 칩이 다시 그려짐");
  assert.equal(r.menuKept, true, "내용이 같으면 열린 메뉴를 다시 만들지 않음");
});
