import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const css = readFileSync(new URL("../web/css/20-keymap.css", import.meta.url), "utf8");

// 설정 → 단축키와 같은 모양: 두 묶음 열, 가장 긴 이름 줄과 키 조합 칸
async function layout(width) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    const row = (label) => `<div class="km-row"><span class="km-lead"></span><span class="km-label">${label}</span><span class="km-keys"><span class="km-kc">⌥</span><span class="km-kc">Tab</span></span></div>`;
    await page.setContent(`<!doctype html><style>${css}</style><div class="km-scroll" style="width:${width}px;height:700px">
      <div class="km-cols"><div>${row("다음 창 (고른 창이 없으면 메인 화면 ↔ 스페이스 브라우저)")}${row("이전 창")}</div>
      <div>${row("화면 녹화 시작 / 종료")}${row("페이지에서 찾기")}</div></div></div>`);
    return await page.evaluate(() => {
      const box = document.querySelector(".km-scroll").getBoundingClientRect();
      const keys = [...document.querySelectorAll(".km-keys")].map((e) => e.getBoundingClientRect());
      return {
        outside: keys.filter((r) => r.right > box.right + 0.5).length,
        columns: new Set([...document.querySelectorAll(".km-cols > div")].map((e) => Math.round(e.getBoundingClientRect().left))).size,
      };
    });
  } finally { await browser.close(); }
}

test("좁은 설정 화면에서 단축키 조합 칸이 화면 밖으로 넘치지 않는다", async () => {
  const narrow = await layout(540);
  assert.equal(narrow.outside, 0);
  assert.equal(narrow.columns, 1);
});

test("넓은 설정 화면에서는 두 열이다", async () => {
  const wide = await layout(900);
  assert.equal(wide.outside, 0);
  assert.equal(wide.columns, 2);
});
