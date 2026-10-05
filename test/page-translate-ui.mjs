import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const action = (name) => `[data-translate-action="${name}"]`;

async function fixture(run) {
  const built = await build({ entryPoints: ["web/js/browser/page-translate-ui.js"], bundle: true,
    write: false, format: "iife", globalName: "TranslateUI" });
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const bar = html.match(/<div class="urlbar">[\s\S]*?(?=\n        <div class="bookmark-line">)/)?.[0];
  assert.ok(bar, "제품 주소창을 사용한다");
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700 });
    await page.setContent(`${bar}<button id="outside">페이지 내용</button>`);
    for (const name of ["00-tokens.css", "01-base.css", "01c-components.css", "18-browser.css", "42-page-translate.css"]) {
      await page.addStyleTag({ content: readFileSync(new URL(`../web/css/${name}`, import.meta.url), "utf8") });
    }
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.evaluate(() => {
      window.calls = [];
      window.controls = TranslateUI.createTranslateControls({
        onTranslate: () => calls.push(["translate"]),
        onRestore: () => calls.push(["restore"]),
        onPreference: (key, enabled) => calls.push([key, enabled]),
        onTargetChange: (value) => calls.push(["target", value]),
        onSourceChange: (value) => calls.push(["source", value]),
      });
      window.translationState = { visible: true, sourceLanguage: "en", targetLanguage: "ko", status: "idle",
        languages: [{ value: "en", label: "영어" }, { value: "ko", label: "한국어" }, { value: "ja", label: "일본어" }] };
    });
    await run(page);
  } finally { await browser.close(); }
}

test("주소창에서 번역·원문·재시도와 언어·사이트 설정을 선택한다", async () => fixture(async (page) => {
  assert.equal(await page.$eval("#wv-translate", (el) => el.hidden), true);
  await page.evaluate(() => controls.update(translationState));
  await page.click("#wv-translate");
  assert.equal(await page.$eval("#wv-translate", (el) => el.getAttribute("aria-expanded")), "true");
  assert.equal(await page.$eval(action("original"), (el) => el.textContent), "영어");
  assert.equal(await page.$eval(action("translated"), (el) => el.textContent), "한국어");
  await page.click(action("translated"));
  assert.deepEqual(await page.evaluate(() => calls), [["translate"]]);
  await page.evaluate(() => controls.update({ status: "translating" }));
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.getAttribute("aria-busy")), "true");
  await page.click(action("translated"));
  await page.click(action("original"));
  assert.deepEqual(await page.evaluate(() => calls), [["translate"]]);
  await page.evaluate(() => controls.update({ status: "translated" }));
  assert.equal(await page.$eval(action("translated"), (el) => el.getAttribute("aria-pressed")), "true");
  await page.click(action("original"));
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["restore"]);
  await page.evaluate(() => controls.update({ status: "error", error: '<img src=x onerror="window.injected=true"> 연결 실패' }));
  assert.equal(await page.$(".page-translate-status img"), null);
  assert.match(await page.$eval(".page-translate-status", (el) => el.textContent), /연결 실패/);
  await page.click(action("retry"));
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["translate"]);
  await page.click('[data-translate-preference="alwaysLanguage"]');
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["alwaysLanguage", true]);
  await page.click(action("options"));
  await page.click('[data-translate-language="target"] .cc-dd-trigger');
  await page.click('[data-translate-language="target"] [data-value="ja"]');
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["target", "ja"]);
  await page.click('[data-translate-language="source"] .cc-dd-trigger');
  await page.click('[data-translate-language="source"] [data-value="ja"]');
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["source", "ja"]);
  await page.click('[data-translate-preference="neverLanguage"]');
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["neverLanguage", true]);
  await page.click('[data-translate-preference="neverSite"]');
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["neverSite", true]);
  await page.evaluate(() => controls.update({ status: "translated", targetLanguage: "ja", sourceLanguage: "en", neverSite: true, alwaysLanguage: true }));
  if (process.env.IRIS_TRANSLATE_SCREENSHOT) await page.screenshot({ path: process.env.IRIS_TRANSLATE_SCREENSHOT });
  await page.click(action("close"));
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "wv-translate");
}));

test("자동 팝업은 입력 포커스를 유지하고 Esc·외부 클릭·숨김으로 닫힌다", async () => fixture(async (page) => {
  await page.evaluate(() => controls.update(translationState));
  await page.focus("#url");
  await page.evaluate(() => controls.open({ focus: false }));
  assert.equal(await page.evaluate(() => document.activeElement.id), "url");
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), false);
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "url");
  await page.click("#wv-translate");
  await page.click(action("options"));
  await page.click('[data-translate-language="target"] .cc-dd-trigger');
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval('[data-translate-language="target"] .cc-dd-menu', (el) => el.hidden), true);
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), false);
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "wv-translate");
  await page.click("#wv-translate");
  await page.click("#outside");
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "outside");
  await page.click("#wv-translate");
  await page.evaluate(() => controls.update({ visible: false }));
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  assert.equal(await page.$eval("#wv-translate", (el) => el.hidden), true);
  await page.evaluate(() => controls.update({ visible: true, sourceLanguage: "fr", languages: [], status: "idle" }));
  await page.click("#wv-translate");
  assert.equal(await page.$eval(action("original"), (el) => el.textContent), "프랑스어");
  await page.setViewport({ width: 350, height: 500 });
  await page.waitForFunction(() => {
    const rect = document.querySelector("#page-translate-panel").getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth;
  });
  const bounds = await page.$eval("#page-translate-panel", (el) => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
  assert.ok(bounds.left >= 0 && bounds.right <= 350, "좁은 창에서도 팝업이 화면 안에 있다");
  await page.evaluate(() => controls.dispose());
  assert.equal(await page.$("#wv-translate"), null);
  assert.equal(await page.$("#page-translate-panel"), null);
}));
