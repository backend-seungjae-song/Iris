import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { autoTranslatePreferenceKey, findGuestWebview, normalizedResult } from "../web/js/browser/page-translate.js";
import { detectPageLanguage, translationSettings } from "../web/js/browser/page-translate-settings.js";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const action = (name) => `[data-translate-action="${name}"]`;
const settingsKey = "iris.pageTranslate.settings.v1:persist:acprof:first";

async function fixture(run) {
  const built = await build({ stdin: { contents: `export { initCapability } from './web/js/browser/page-translate.js';
    export { callHook } from './web/js/core/hooks.js';`, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "Translation" });
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const bar = html.match(/<div class="urlbar">[\s\S]*?(?=\n        <div class="bookmark-line">)/)?.[0];
  assert.ok(bar);
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(6000);
    await page.setViewport({ width: 1200, height: 800 });
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ contentType: "text/html", body: `<!doctype html>${bar}<button id="other-tab">다른 탭</button><div id="wv-stack"></div>` }));
    await page.goto("https://iris.automation.test/");
    for (const name of ["00-tokens.css", "01-base.css", "01c-components.css", "18-browser.css", "42-page-translate.css"]) await page.addStyleTag({ content: readFileSync(new URL(`../web/css/${name}`, import.meta.url), "utf8") });
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.focus("#url");
    await page.evaluate(() => {
      window.records = new Map(); window.calls = []; window.toasts = []; window.registrations = [];
      window.addTab = (id, options = {}) => {
        const el = document.createElement("webview"); el.setAttribute("partition", options.partition || "persist:acprof:first"); el.classList.toggle("active", !!options.active);
        const record = { el, wc: id, ready: true, language: "en", text: "This article explains how a browser translates a foreign language page.", url: `https://article.test/${id}`, ...options };
        el.getURL = () => record.url; el.getWebContentsId = () => id;
        el.reload = () => { throw new Error("번역 설정 때문에 입력 중인 페이지를 새로고침하면 안 된다"); };
        records.set(id, record); document.querySelector("#wv-stack").append(el); return record;
      };
      window.navigate = (id, url) => { const rec = records.get(id); rec.url = url; const event = new Event("did-start-navigation"); Object.assign(event, { isMainFrame: true }); rec.el.dispatchEvent(event); rec.el.dispatchEvent(new Event("dom-ready")); };
      window.inPage = (mainFrame = true) => { const event = new Event("did-navigate-in-page"); Object.assign(event, { isMainFrame: mainFrame }); records.get(71).el.dispatchEvent(event); };
      addTab(71, { active: true });
      window.capability = Translation.initCapability({ $: (selector) => document.querySelector(selector), getWebviewEntries: () => [...records],
        showToast: (message, options) => toasts.push({ message, options }), acHost: {
          registerContextAction: (item) => registrations.push(item), pageTranslate: async (payload) => {
            const record = records.get(payload.wc); calls.push({ ...payload, url: record.url, partition: record.el.getAttribute("partition") });
            if (payload.op === "detect") {
              if (window.deferDetect) return new Promise((resolve) => { window.resolveDetect = resolve; });
              return { ok: true, language: record.language, text: record.text };
            }
            if (window.deferTranslation && payload.op === "translate") return new Promise((resolve) => { window.resolveTranslation = resolve; });
            if (window.nativeFailure) { const failure = nativeFailure; nativeFailure = null; return failure; }
            return { ok: true, code: payload.op === "restore" ? "original" : "translated", language: record.language };
          },
        } });
      document.querySelector("#other-tab").addEventListener("click", () => { records.get(71).el.classList.remove("active"); records.get(72)?.el.classList.add("active"); });
    });
    await page.waitForFunction(() => !document.querySelector("#page-translate-panel").hidden);
    await run(page);
  } finally { await browser.close(); }
}

const waitStatus = (page, text) => page.waitForFunction((text) => document.querySelector(".page-translate-status")?.textContent.includes(text), {}, text);
const countTranslations = (page) => page.evaluate(() => calls.filter((call) => call.op === "translate").length);
async function openOptions(page) {
  if (await page.$eval("#page-translate-panel", (el) => el.hidden)) await page.click("#wv-translate");
  if (await page.$eval("#page-translate-options", (el) => el.hidden)) await page.click(action("options"));
}

test("자동 팝업에서 번역·원문·언어 변경과 정정을 실행한다", async () => fixture(async (page) => {
  assert.equal(await page.evaluate(() => document.activeElement.id), "url");
  assert.equal(await countTranslations(page), 0, "언어 감지만으로 외부 번역을 요청하지 않는다");
  await page.click(action("translated")); await waitStatus(page, "번역했습니다");
  assert.deepEqual(await page.evaluate(() => calls.filter((call) => call.op === "translate").map(({ wc, source, target }) => ({ wc, source, target }))), [{ wc: 71, source: "en", target: "ko" }]);
  await page.click(action("original")); await page.waitForFunction(() => calls.some((call) => call.op === "restore"));
  assert.equal(await page.$eval(action("original"), (el) => el.getAttribute("aria-pressed")), "true");
  await openOptions(page); await page.click('[data-translate-language="target"] .cc-dd-trigger'); await page.click('[data-translate-language="target"] [data-value="ja"]'); await waitStatus(page, "번역했습니다");
  assert.equal(await page.evaluate(() => calls.filter((call) => call.op === "translate").at(-1).target), "ja");
  assert.equal(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), settingsKey)).target, "ja");
  await page.click('[data-translate-language="source"] .cc-dd-trigger'); await page.click('[data-translate-language="source"] [data-value="fr"]');
  await page.waitForFunction(() => calls.some((call) => call.op === "translate" && call.source === "fr"));
}));

test("항상 번역·언어 제외·사이트 제외는 다음 문서와 프로필 범위에 적용한다", async () => fixture(async (page) => {
  await page.click('[data-translate-preference="alwaysLanguage"]'); await waitStatus(page, "번역했습니다");
  await page.evaluate(() => navigate(71, "https://article.test/two")); await page.waitForFunction(() => calls.filter((call) => call.op === "translate").length === 2);
  await openOptions(page); await page.click('[data-translate-preference="neverSite"]');
  await page.evaluate(() => navigate(71, "https://article.test/three")); await page.waitForFunction(() => calls.some((call) => call.op === "detect" && call.url.endsWith("/three")));
  assert.equal(await countTranslations(page), 2); assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  await openOptions(page);
  await page.click('[data-translate-preference="alwaysLanguage"]'); await page.click('[data-translate-preference="alwaysLanguage"]');
  assert.equal(await countTranslations(page), 2, "항상 번역을 다시 켜도 사이트 제외 설정이 우선한다");
  await page.click('[data-translate-preference="neverSite"]'); await page.waitForFunction(() => calls.filter((call) => call.op === "translate").length === 3);
  await page.click('[data-translate-preference="neverLanguage"]');
  const saved = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), settingsKey)); assert.deepEqual(saved.never, ["en"]); assert.deepEqual(saved.always, []);
  await page.evaluate(() => navigate(71, "https://other.test/four")); await page.waitForFunction(() => calls.some((call) => call.op === "detect" && call.url.endsWith("/four")));
  assert.equal(await countTranslations(page), 3); assert.equal(await page.$eval("#page-translate-panel", (el) => el.hidden), true);
  await page.evaluate(() => { records.get(71).el.setAttribute("partition", "persist:acprof:second"); navigate(71, "https://article.test/five"); });
  await page.waitForFunction(() => !document.querySelector("#page-translate-panel").hidden);
  assert.equal(await countTranslations(page), 3); assert.equal(await page.$eval('[data-translate-preference="neverLanguage"]', (el) => el.checked), false);
}));

test("탭 전환·새 탭·storage 변경을 관찰하고 dispose 뒤 실행을 중단한다", async () => fixture(async (page) => {
  await page.evaluate(() => addTab(72)); await page.waitForFunction(() => calls.some((call) => call.wc === 72 && call.op === "detect"));
  await page.click("#other-tab");
  await page.waitForFunction(() => records.get(72).el.classList.contains("active"));
  if (await page.$eval("#page-translate-panel", (el) => el.hidden)) await page.click("#wv-translate");
  await page.click(action("translated")); await waitStatus(page, "번역했습니다");
  assert.equal(await page.evaluate(() => calls.filter((call) => call.op === "translate").at(-1).wc), 72);
  await page.evaluate((key) => { localStorage.setItem(key, JSON.stringify({ target: "ko", always: ["en"], never: [], neverSites: [] })); window.dispatchEvent(new StorageEvent("storage", { key })); }, settingsKey);
  await page.waitForFunction(() => calls.some((call) => call.wc === 71 && call.op === "translate"));
  const before = await page.evaluate(() => calls.length);
  await page.evaluate(() => { capability.dispose(); for (const rec of records.values()) rec.el.dispatchEvent(new Event("dom-ready")); window.dispatchEvent(new StorageEvent("storage", { key: "iris.pageTranslate.settings.v1:persist:acprof:first" })); addTab(73); });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(await page.evaluate(() => calls.length), before); assert.equal(await page.$("#wv-translate"), null);
}));

test("SPA 이벤트를 합치고 하위 프레임·번역된 문서의 재감지를 생략한다", async () => fixture(async (page) => {
  const initial = await page.evaluate(() => calls.length); await page.evaluate(() => inPage(false));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 180))); assert.equal(await page.evaluate(() => calls.length), initial);
  await page.evaluate(() => { records.get(71).url = "https://article.test/spa"; inPage(); inPage(); });
  await page.waitForFunction(() => calls.some((call) => call.url.endsWith("/spa"))); assert.equal(await page.evaluate(() => calls.filter((call) => call.url.endsWith("/spa")).length), 1);
  await page.click(action("translated")); await waitStatus(page, "번역했습니다"); const translated = await page.evaluate(() => calls.length);
  await page.evaluate(() => inPage()); await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 180)));
  assert.equal(await page.evaluate(() => calls.length), translated);
}));

test("네이티브 실패·저장 실패를 알리고 이전 문서의 응답은 새 화면에 표시하지 않는다", async () => fixture(async (page) => {
  await page.evaluate(() => { window.nativeFailure = { ok: false, code: "network" }; });
  await page.click(action("translated")); await waitStatus(page, "연결하지 못했습니다"); assert.equal(await page.$eval(action("retry"), (el) => el.hidden), false);
  await page.click(action("retry")); await waitStatus(page, "번역했습니다");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("저장 실패"); }; });
  await page.click('[data-translate-preference="alwaysLanguage"]'); await page.waitForFunction(() => toasts.some((toast) => toast.options?.level === "err"));
  assert.equal(await page.$eval('[data-translate-preference="alwaysLanguage"]', (el) => el.checked), false);
  await page.evaluate(() => { window.deferTranslation = true; }); await page.click(action("translated")); await page.waitForFunction(() => typeof resolveTranslation === "function");
  await page.evaluate(() => navigate(71, "https://article.test/next")); await page.waitForFunction(() => calls.some((call) => call.op === "detect" && call.url.endsWith("/next")));
  await page.evaluate(() => resolveTranslation({ ok: true, code: "translated", language: "en" }));
  assert.equal(await page.$eval(action("translated"), (el) => el.getAttribute("aria-pressed")), "false");
}));

test("대상 언어·빈 문서·비웹 문서에서는 번역을 제안하지 않는다", async () => fixture(async (page) => {
  await page.evaluate(() => { records.get(71).language = "ko"; records.get(71).text = "이 문서는 이미 한국어로 작성되어 번역할 필요가 없습니다."; navigate(71, "https://article.test/korean"); });
  await page.waitForFunction(() => calls.some((call) => call.url.endsWith("/korean"))); assert.equal(await page.$eval("#wv-translate", (el) => el.hidden), true);
  await page.evaluate(() => { records.get(71).text = ""; navigate(71, "https://article.test/empty"); });
  await page.waitForFunction(() => calls.some((call) => call.url.endsWith("/empty"))); assert.equal(await page.$eval("#wv-translate", (el) => el.hidden), true);
  const before = await page.evaluate(() => calls.length); await page.evaluate(() => navigate(71, "file:///tmp/page.html")); await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(await page.evaluate(() => calls.length), before); assert.equal(await page.$eval("#wv-translate", (el) => el.hidden), true);
}));

test("기존 사이트 자동 번역 설정은 프로필·origin별로 이어서 적용한다", async () => fixture(async (page) => {
  await page.evaluate(() => { const key = 'iris.pageTranslate.auto.v1:' + JSON.stringify(["persist:acprof:first", "https://article.test"]); localStorage.setItem(key, "ko"); window.dispatchEvent(new StorageEvent("storage", { key })); });
  await page.waitForFunction(() => calls.some((call) => call.op === "translate"));
  await page.evaluate(() => navigate(71, "https://article.test/two")); await page.waitForFunction(() => calls.filter((call) => call.op === "translate").length === 2);
  await page.evaluate(() => navigate(71, "http://article.test/three")); await page.waitForFunction(() => calls.some((call) => call.op === "detect" && call.url.startsWith("http:")));
  assert.equal(await countTranslations(page), 2);
}));

test("번역 도중 SPA 이동한 문서는 진행 표시를 해제하고 다시 감지한다", async () => fixture(async (page) => {
  await page.evaluate(() => { window.deferTranslation = true; });
  await page.click(action("translated")); await page.waitForFunction(() => typeof resolveTranslation === "function");
  await page.evaluate(() => { records.get(71).url = "https://article.test/pending-spa"; inPage(); });
  await page.evaluate(() => resolveTranslation({ ok: true, code: "translated", language: "en" }));
  await page.waitForFunction(() => calls.some((call) => call.op === "detect" && call.url.endsWith("/pending-spa")));
  assert.equal(await page.$eval("#page-translate-panel", (el) => el.getAttribute("aria-busy")), "false");
  assert.equal(await page.$eval(action("translated"), (el) => el.disabled), false);
  assert.equal(await page.$eval(action("translated"), (el) => el.getAttribute("aria-pressed")), "false");
}));

test("수동 번역 뒤 늦게 도착한 언어 감지는 번역 상태를 바꾸지 않는다", async () => fixture(async (page) => {
  await page.evaluate(() => { window.deferDetect = true; navigate(71, "https://article.test/delayed-detect"); });
  await page.waitForFunction(() => typeof resolveDetect === "function");
  await page.evaluate(() => Translation.callHook("pagetranslate.page", { guestWebContentsId: 71 }));
  await waitStatus(page, "한국어로 번역했습니다");
  await page.evaluate(() => resolveDetect({ ok: true, language: "ja", text: "この文章は日本語で書かれています。翻訳の言語を検出します。" }));
  assert.equal(await page.$eval(action("original"), (el) => el.textContent), "영어");
  assert.equal(await page.$eval(action("translated"), (el) => el.getAttribute("aria-pressed")), "true");
}));

test("다른 탭에서 번역 언어를 바꿔도 이미 번역한 탭의 표시 언어를 유지한다", async () => fixture(async (page) => {
  await page.click(action("translated")); await waitStatus(page, "한국어로 번역했습니다");
  await page.evaluate(() => addTab(72)); await page.waitForFunction(() => calls.some((call) => call.wc === 72 && call.op === "detect"));
  await page.click("#other-tab"); await openOptions(page);
  await page.click('[data-translate-language="target"] .cc-dd-trigger'); await page.click('[data-translate-language="target"] [data-value="ja"]'); await waitStatus(page, "일본어로 번역했습니다");
  await page.evaluate(() => { records.get(72).el.classList.remove("active"); records.get(71).el.classList.add("active"); });
  await page.waitForFunction(() => document.querySelector('[data-translate-action="translated"]').textContent === "한국어");
  assert.match(await page.$eval(".page-translate-status", (el) => el.textContent), /한국어로 번역했습니다/);
  assert.equal(await page.evaluate(() => calls.filter((call) => call.wc === 71 && call.op === "translate").at(-1).target), "ko");
  if (await page.$eval("#page-translate-panel", (el) => el.hidden)) await page.click("#wv-translate");
  await page.click(action("original"));
  await page.waitForFunction(() => calls.some((call) => call.wc === 71 && call.op === "restore"));
  assert.equal(await page.$eval(action("translated"), (el) => el.textContent), "한국어");
  await page.evaluate(() => navigate(71, "https://article.test/new-document"));
  await page.waitForFunction(() => document.querySelector('[data-translate-action="translated"]').textContent === "일본어");
}));

test("나중에 본문이 생긴 문서를 재감지하고 닫힌 탭의 감지 예약을 제거한다", async () => fixture(async (page) => {
  await page.evaluate(() => { records.get(71).text = ""; navigate(71, "https://article.test/later-text"); });
  await page.waitForFunction(() => calls.some((call) => call.url.endsWith("/later-text")));
  await page.evaluate(() => { records.get(71).text = "This article now contains enough English text to detect its language."; });
  await page.waitForFunction(() => !document.querySelector("#page-translate-panel").hidden);
  await page.evaluate(() => addTab(72, { text: "" }));
  await page.waitForFunction(() => calls.some((call) => call.wc === 72 && call.op === "detect"));
  await page.evaluate(() => { records.get(72).el.remove(); records.delete(72); });
  const before = await page.evaluate(() => calls.filter((call) => call.wc === 72).length);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 550)));
  assert.equal(await page.evaluate(() => calls.filter((call) => call.wc === 72).length), before);
}));

test("guest 판별·설정 키·결과 정규화는 잘못된 입력을 거부한다", () => {
  const el = { getURL: () => "https://article.test/a", getAttribute: () => "persist:acprof:first", getWebContentsId: () => 71 };
  const entries = new Map([["tab", { el }]]); assert.equal(findGuestWebview(() => entries, 71), el);
  for (const id of [0, -1, 71.5, NaN]) assert.equal(findGuestWebview(() => entries, id), null);
  assert.equal(autoTranslatePreferenceKey(el), 'iris.pageTranslate.auto.v1:' + JSON.stringify(["persist:acprof:first", "https://article.test"]));
  for (const value of [null, "invalid", { ok: false, code: "unknown", detail: 17 }, new Proxy({}, { get() { throw new Error("hostile getter"); } })]) {
    const result = normalizedResult(value); assert.equal(result.ok, false); assert.equal(result.code, "unsupported"); assert.equal(typeof result.detail, "string");
  }
});

test("본문 문자와 언어 코드를 확인하고 프로필별 설정을 구분한다", () => {
  assert.deepEqual(detectPageLanguage({ language: "en", text: "이 문서는 한국어로 작성되어 언어 감지 결과를 확인합니다." }), { language: "ko", hasText: true });
  assert.deepEqual(detectPageLanguage({ language: "en", text: "この文章は日本語で書かれています。翻訳の言語を検出します。" }), { language: "ja", hasText: true });
  assert.deepEqual(detectPageLanguage({ language: "en-US", text: "This paragraph is written in the English language." }), { language: "en", hasText: true });
  assert.deepEqual(detectPageLanguage({ language: "en", text: "Hi" }), { language: "en", hasText: false });
  const storage = { getItem: (key) => key.endsWith("first") ? JSON.stringify({ target: "ja", always: ["en"], never: ["fr"], neverSites: ["https://article.test", "file:///tmp"] }) : null };
  assert.deepEqual(translationSettings(storage, "first"), { target: "ja", always: ["en"], never: ["fr"], neverSites: ["https://article.test"] });
  assert.deepEqual(translationSettings(storage, "second"), { target: "ko", always: [], never: [], neverSites: [] });
});
