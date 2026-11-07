import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// LAYOUT_SRC: 고치기 전 판의 core/layout-engine.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ LAYOUT_SRC: "/js/core/layout-engine.js" });

test("다시 배치해도 경계 막대는 같은 요소를 재사용해 위치만 바꾸고 드래그는 최신 경계를 씀", async () => {
  const r = await withWebPage(async (page) => {
    await page.setViewport({ width: 1200, height: 700 });
    return page.evaluate(async () => {
      document.body.classList.add("sidebar-collapsed");
      const { initLayoutEngine } = await import("/js/core/layout-engine.js");
      initLayoutEngine({ $: (s) => document.querySelector(s) });
      const frame = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      await frame();
      const bars = () => [...document.querySelectorAll(".lay-split")];
      const first = bars();
      const before = first[0] && first[0].style.left;
      document.querySelector(".app").style.width = "1000px"; // 크기 변화로 다시 배치
      window.dispatchEvent(new Event("resize")); await frame();
      const after = bars();
      return { count: first.length, same: after.length === first.length && after[0] === first[0],
        moved: after[0] && after[0].style.left !== before };
    });
  }, { body: `<style>.app{position:relative;width:1200px;height:600px}</style>
    <div class="app"><div id="actrail"></div><div class="sidebar-head"></div><div id="panel-explorer"></div><div id="panel-spaces"></div>
    <div id="center"></div><div id="right"></div></div>`, overrides });
  assert.ok(r.count >= 1, "경계 막대가 그려짐");
  assert.equal(r.same, true, "같은 막대 요소 재사용");
  assert.equal(r.moved, true, "크기가 바뀌면 위치는 갱신");
});
