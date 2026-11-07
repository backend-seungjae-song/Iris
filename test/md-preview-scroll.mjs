import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// MDP_SRC: 고치기 전 판의 md-preview.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ MDP_SRC: "/js/center/md-preview.js" });

test("마크다운 미리보기는 본문을 다시 그려도 그 탭의 스크롤 위치로 돌아감", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    (await import("/js/core/markdown.js")).initMarkdown({ esc: (v) => String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) });
    (await import("/js/center/md-preview.js")).initCapability();
    const { callHook } = await import("/js/core/hooks.js");
    const view = document.getElementById("fileview");
    const a = { path: "/p/a.md", content: Array.from({ length: 300 }, (_, i) => `줄 ${i}`).join("\n\n") };
    const b = { path: "/p/b.md", content: Array.from({ length: 300 }, (_, i) => `다른 ${i}`).join("\n\n") };
    // text-editor.js 의 파일 본문 그리기와 같은 순서: 뼈대 → 미리보기 칸 → render 훅
    const draw = (t) => {
      view.innerHTML = callHook("mdpreview.paneHtml", t, 0) + `<div class="editor-wrap"></div>`;
      callHook("mdpreview.render", t, view.querySelector(".editor-wrap"), 0);
      return view.querySelector("[data-md-preview]");
    };
    for (const t of [a, b]) callHook("mdpreview.click", { closest: () => ({ dataset: { md: "preview" } }) }, t, 0);
    const first = draw(a); first.scrollTop = 800; first.dispatchEvent(new Event("scroll"));
    const again = draw(a).scrollTop;
    const other = draw(b).scrollTop;
    return { again, other };
  }), { body: `<style>.md-body{height:200px;overflow:auto}</style><div id="fileview"></div>`, overrides });
  assert.equal(r.again, 800, "같은 탭을 다시 그리면 읽던 위치");
  assert.equal(r.other, 0, "다른 탭은 처음 위치");
});
