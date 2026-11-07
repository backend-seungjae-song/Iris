import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// SEARCH_SRC: 고치기 전 판의 boot.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ SEARCH_SRC: "/js/unified-search/boot.js" });

test("파일 목록이 오래돼 다시 받는 동안에도 이미 보이던 파일 결과가 그대로", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const search = await import("/js/unified-search/boot.js");
    const { callHook } = await import("/js/core/hooks.js");
    const sent = [];
    search.initCapability({
      wsSend: (m) => sent.push(m), wsIsOpen: () => true, esc: (s) => String(s),
      orderedSpaces: () => [{ id: "s1", folder: "/p", label: "p" }], getLastAgents: () => [], getBrowserState: () => ({}),
    });
    search.openUnifiedSearch();
    const input = document.querySelector(".unified-search input");
    const list = document.getElementById("unified-search-results");
    const type = (v) => { input.value = v; input.dispatchEvent(new Event("input")); };
    type("note");
    callHook("unifiedsearch.tree", { root: "/p", files: ["notes.md", "note-2.md"] });
    const first = list.textContent;
    const now = Date.now(); Date.now = () => now + 20000;   // 캐시 15초가 지남
    type("notes");
    return { first, during: list.textContent, asked: sent.filter((m) => m.type === "fs.tree").length };
  }), { body: `<div class="sidebar-head"></div>`, overrides });
  assert.match(r.first, /notes\.md/, "처음 응답 뒤 파일 결과가 보임");
  assert.equal(r.asked, 2, "오래된 목록은 다시 요청");
  assert.match(r.during, /notes\.md/, "다시 받는 동안에도 파일 결과가 남음");
  assert.doesNotMatch(r.during, /불러오는 중/);
});
