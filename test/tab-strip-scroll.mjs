import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
// TAB_STRIP_SRC: 고치기 전 판의 tabs.js 로 같은 검사를 돌릴 때
const src = readFileSync(process.env.TAB_STRIP_SRC || new URL("../web/js/browser/tabs.js", import.meta.url), "utf8");
const revealSrc = sliceBetween(src, "const revealedActive", "export function renderBmTabs", "revealActiveTab").replace("export function", "function");

// 300px 띠에 탭 12개. names[i] 가 i번 탭 이름, active 가 선택한 탭 번호
async function run(steps) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><div id="s" style="width:300px;overflow:hidden;display:flex;white-space:nowrap"></div>`);
    return await page.evaluate((revealSrc, steps) => {
      const revealActiveTab = new Function(`${revealSrc}; return revealActiveTab;`)();
      const s = document.getElementById("s");
      const names = Array.from({ length: 12 }, (_, i) => `탭${i}`);
      let active = 0;
      const out = [];
      for (const st of steps) {
        if (st.scroll != null) s.scrollLeft = st.scroll;
        if (st.name) names[st.name[0]] = st.name[1];
        if (st.active != null) active = st.active;
        s.innerHTML = names.map((n, i) => `<div class="ctab${i === active ? " active" : ""}" data-tab="t${i}" style="flex:none;padding:0 10px">${n}</div>`).join("");
        revealActiveTab(s);
        const a = s.querySelector(".ctab.active");
        const box = s.getBoundingClientRect(), r = a.getBoundingClientRect();
        out.push({ left: s.scrollLeft, visible: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 });
      }
      return out;
    }, revealSrc, steps);
  } finally { await browser.close(); }
}

test("뒤로 넘긴 띠는 선택한 탭의 제목·표시가 바뀌어도 그 위치 유지", async () => {
  const r = await run([{}, { scroll: 200 }, { name: [0, "탭0 ●"] }, { name: [0, "(3) 탭0 ●"] }, { name: [0, "탭0"] }]);
  assert.deepEqual(r.slice(1).map((x) => x.left), [200, 200, 200, 200]);
});

test("다른 탭을 고르면 그 탭까지 스크롤", async () => {
  const r = await run([{}, { scroll: 200 }, { name: [0, "탭0 ●"] }, { active: 11 }]);
  assert.equal(r.at(-1).visible, true);
});

test("넘기지 않은 띠에서 앞쪽 탭이 늘어 선택한 탭이 밀리면 다시 보여 줌", async () => {
  const r = await run([{ active: 5 }, { name: [0, "아주 아주 아주 아주 긴 이름의 앞쪽 탭"] }]);
  assert.equal(r[0].visible, true);
  assert.equal(r[1].visible, true);
});
