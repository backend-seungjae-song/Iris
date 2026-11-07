import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// BKM_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ BKM_SRC: "/js/bookmarks/manager.js" });

test("북마크 관리에서 이름을 바꾸면 새 이름으로 바로 그리고, 서버 방송에도 줄을 다시 만들지 않음", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const state = await import("/js/browser/state.js");
    const hooks = await import("/js/core/hooks.js");
    const mgr = await import("/js/bookmarks/manager.js");
    state.initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: "w1", wsSend() {} });
    const put = (title) => state.replaceBrowserState({ bookmarksBySpace: { w1: [{ url: "https://a.com/", title }, { url: "https://b.com/", title: "비" }] }, profiles: [] });
    put("옛 이름");
    const $ = (q) => document.querySelector(q);
    const { screen } = mgr.initCapability({ $, esc: (s) => String(s).replace(/[&<>"]/g, ""), showToast() {}, orderedSpaces: () => [{ id: "w1", label: "첫째" }] });
    screen.enter();
    $("[data-bkm-edit]").click();
    const inp = $("[data-bkm-rename]");
    inp.value = "새 이름";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const row = () => $(".bkm-row.bkm-fresh");
    const first = row(), firstTitle = first && first.textContent;
    put("새 이름");            // 서버 방송
    hooks.callHook("bookmarkmgr.stateChanged");
    return { firstTitle, same: row() === first, title: row() && row().textContent };
  }), { body: `<div id="bookmarkmgr-panel"><span id="bkm-sum"></span><input id="bkm-q"><div id="bkm-bulk"></div><div id="bkm-undo"></div><div id="bkm-list"></div></div>`, overrides });
  assert.ok(r.firstTitle && r.firstTitle.includes("새 이름"), "이름을 확정한 즉시 새 이름으로 그림: " + r.firstTitle);
  assert.equal(r.same, true, "방송이 와도 강조 중인 줄을 다시 만들지 않음(애니메이션 재생 없음)");
  assert.ok(r.title.includes("새 이름"));
});
