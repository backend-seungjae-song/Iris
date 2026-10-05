import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const css = read("../web/css/17-editor-bar.css");
const format = read("../web/js/center/md-format.js");
const fitStart = format.indexOf("function fitEditorTop(");
const fitSource = fitStart < 0 ? "function fitEditorTop() {}" : format.slice(fitStart, format.indexOf("\n}", fitStart) + 2);

// 메모 열과 같은 모양: 위치 기준이 되는 열 안에 떠 있는 도구 상자, 서식 손잡이 아홉과 줄바꿈 손잡이 하나
async function layout(width) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1180, height: 600 });
    const tools = Array.from({ length: 9 }, (_, i) => `<button type="button" class="etool" data-mdformat="f${i}">${i}</button>`).join("");
    await page.setContent(`<!doctype html><style>${css}</style><style>.slot{position:relative;overflow:hidden;width:${width}px;height:300px;margin-left:200px}</style>
      <div class="slot"><span class="editor-float"><span class="editor-controls"><span data-mdformat-bar role="toolbar">${tools}</span></span>
      <span class="editor-view-opts"><button type="button" class="etool">w</button></span></span></div>`);
    return await page.evaluate(async (fitSource) => {
      const slot = document.querySelector(".slot").getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".editor-float button")].map((b) => b.getBoundingClientRect());
      const options = { padding: { top: 36, bottom: 3 } };
      const editor = { getRawOptions: () => options, updateOptions: (next) => Object.assign(options, next) };
      const fitEditorTop = new Function(`${fitSource}; return fitEditorTop;`)();
      const disposables = [];
      fitEditorTop(editor, document.querySelector(".editor-float"), disposables);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        outside: buttons.filter((r) => r.left < slot.left || r.right > slot.right).length,
        rows: new Set(buttons.map((r) => Math.round(r.top))).size,
        rowSpan: Math.round(buttons.at(-1).top - buttons[0].top),
        top: options.padding.top, bottom: options.padding.bottom,
      };
    }, fitSource);
  } finally { await browser.close(); }
}

test("좁은 열에서 떠 있는 도구 상자의 손잡이가 모두 열 안에 있고 늘어난 줄만큼 편집기 위쪽 여백이 는다", async () => {
  const narrow = await layout(220);
  assert.equal(narrow.outside, 0, "열 밖으로 잘린 손잡이가 있다");
  assert.ok(narrow.rows > 1, "좁은 열인데 한 줄이다(시험 조건이 틀렸다)");
  assert.equal(narrow.top, 36 + narrow.rowSpan);
  assert.equal(narrow.bottom, 3, "위쪽 여백만 바꾼다");
});

test("넓은 열에서는 한 줄이고 편집기 위쪽 여백은 원래 값이다", async () => {
  const wide = await layout(600);
  assert.equal(wide.outside, 0);
  assert.equal(wide.rows, 1);
  assert.equal(wide.top, 36);
});
