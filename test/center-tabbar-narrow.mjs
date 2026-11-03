import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const css = readFileSync(new URL("../web/css/11-center-tabs.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
// index.html 의 가운데 탭 줄 그대로. 종류 선택은 renderKindBar 가 그리는 모양
const row = sliceBetween(html, '<div class="tabbar-row" id="tabbar-row">', '<div class="center-body"', "가운데 탭 줄");
const kind = (name, on) => `<button type="button" class="tab-kind${on ? " on" : ""}" aria-label="${name}"><svg class="ckind" viewBox="0 0 24 24"></svg><span>${name}</span></button>`;

// 가운데 칸 폭별 요소 선택 버튼 위치. 오른쪽 패널처럼 칸 바로 오른쪽에 붙은 판을 둠
async function measure(width) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 400 });
    await page.setContent(`<!doctype html><style>${css} body{margin:0} #right{position:absolute;left:${width}px;top:0;right:0;height:200px;background:#eee}</style>
      <section class="center" id="center" style="position:absolute;left:0;top:0;width:${width}px;height:200px">${row}</section><section id="right"></section>`);
    await page.evaluate((kinds) => {
      const bar = document.createElement("div"); bar.className = "tab-kinds"; bar.innerHTML = kinds;
      document.querySelector("#tabstrip").before(bar);
      document.querySelector("#tabstrip").innerHTML = '<div class="ctab active"><span class="cname">a.txt</span></div>';
    }, kind("파일", true) + kind("브라우저", false));
    return await page.evaluate(() => {
      const b = document.querySelector("#wv-pick").getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const kinds = document.querySelector(".tab-kinds").getBoundingClientRect();
      return { reachable: !!top?.closest("#wv-pick"), kindsWidth: Math.round(kinds.width) };
    });
  } finally { await browser.close(); }
}

test("가운데 칸이 좁아도 요소 선택 버튼이 칸 안에 있어 누를 수 있다", async () => {
  const narrow = await measure(161);
  assert.equal(narrow.reachable, true);
  assert.ok(narrow.kindsWidth >= 40, `종류 선택이 찌그러짐: ${narrow.kindsWidth}px`);
});

test("넓은 가운데 칸에서도 요소 선택 버튼을 누를 수 있다", async () => {
  assert.equal((await measure(900)).reachable, true);
});
