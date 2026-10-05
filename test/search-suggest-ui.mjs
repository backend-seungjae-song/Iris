import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");

async function fixture(run, { enabled = true } = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    try {
      if (!path.startsWith("/js/")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<input id="url"><div id="url-sug" hidden></div><button id="other">다른 버튼</button>'); return; }
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(await readFile(new URL(`../web${path}`, import.meta.url)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async (enabled) => {
      const bookmarks = await import("/js/browser/bookmarks.js");
      const state = await import("/js/browser/state.js");
      state.initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: "test", wsSend() {} });
      state.replaceBrowserState({ urlHistoryBySpace: { test: ["https://apple.test/", "https://other.test/"], other: ["https://secret.test/"] }, tabsBySpace: {}, activeBySpace: {} });
      const urlInput = document.querySelector("#url");
      bookmarks.initBookmarks({ $: (selector) => document.querySelector(selector), esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), urlInput, openBrowser() {}, navigate() {} });
      window.goCalls = []; window.requests = []; window.pending = [];
      window.acHost = { searchSuggestions(query) { requests.push(query); return new Promise((resolve) => pending.push({ query, resolve })); } };
      if (enabled) (await import("/js/browser/search-suggest.js")).initCapability();
      bookmarks.wireUrlBar({ goUrl: () => goCalls.push(urlInput.value) });
      window.bookmarks = bookmarks; window.state = state;
      const tabStore = await import("/js/center/tab-store.js");
      tabStore.setCenterSpace("test");
      tabStore.addTab("test", { id: "tab-a", kind: "browser" });
      tabStore.addTab("test", { id: "tab-b", kind: "browser" });
      tabStore.setActiveTab("test", "tab-a");
      window.tabStore = tabStore;
    }, enabled);
    await run(page);
  } finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}

async function type(page, value) {
  await page.focus("#url");
  await page.$eval("#url", (input, text) => { input.value = text; input.dispatchEvent(new InputEvent("input", { bubbles: true })); }, value);
}
const rows = (page) => page.$$eval("#url-sug .sug", (items) => items.map((item) => item.textContent));

test("기존 주소창에서 기록과 Google 추천을 선택하고 검색한다", async () => fixture(async (page) => {
  await type(page, "apple");
  assert.deepEqual(await rows(page), ["https://apple.test/"]);
  await page.waitForFunction(() => requests.length === 1);
  await page.evaluate(() => pending[0].resolve(["apple price", "apple.com", '<img src=x onerror="window.injected=true">']));
  await page.waitForFunction(() => document.querySelectorAll("#url-sug .sug").length === 4);
  assert.equal(await page.$eval("#url-sug", (el) => el.querySelector("img")), null);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.$eval("#url", (input) => input.value), "https://apple.test/");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.$eval("#url", (input) => input.value), "apple price");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#url", (input) => input.value), "apple");
  assert.equal(await page.$eval("#url-sug", (el) => el.hidden), true);
  await type(page, "apple");
  await page.waitForFunction(() => requests.length === 2);
  await page.evaluate(() => pending[1].resolve(["apple.com"]));
  await page.waitForFunction(() => document.querySelectorAll("#url-sug .sug").length === 2);
  await page.click('#url-sug .sug[data-i="1"]');
  assert.deepEqual(await page.evaluate(() => goCalls), ["https://www.google.com/search?q=apple.com"]);
}));

test("빠른 입력·Esc·blur·스페이스 변경 뒤의 응답을 무시한다", async () => fixture(async (page) => {
  await type(page, "first");
  await page.waitForFunction(() => requests.length === 1);
  await type(page, "second");
  await page.waitForFunction(() => requests.length === 2);
  await page.evaluate(() => { pending[1].resolve(["second result"]); pending[0].resolve(["first result"]); });
  await page.waitForFunction(() => document.querySelector("#url-sug .sug")?.textContent === "second result");
  assert.deepEqual(await rows(page), ["second result"]);
  await type(page, "apple");
  await page.waitForFunction(() => requests.length === 3);
  await page.keyboard.press("Escape");
  await page.evaluate(() => pending[2].resolve(["late result"]));
  assert.equal(await page.$eval("#url-sug", (el) => el.hidden), true);
  await type(page, "blur");
  await page.waitForFunction(() => requests.length === 4);
  await page.click("#other");
  await page.evaluate(() => pending[3].resolve(["blur result"]));
  assert.deepEqual(await rows(page), []);
  await type(page, "space");
  await page.waitForFunction(() => requests.length === 5);
  await page.evaluate(() => { state.initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: "other", wsSend() {} }); bookmarks.renderUrlDatalist(); pending[4].resolve(["old space result"]); });
  assert.deepEqual(await rows(page), []);
  await type(page, "no local matches");
  await page.waitForFunction(() => requests.length === 6);
  await page.keyboard.press("Escape");
  await page.evaluate(() => pending[5].resolve(["late query"]));
  assert.equal(await page.$eval("#url-sug", (el) => el.hidden), true);
}));

test("빠른 입력을 한 번만 요청하고 추천 도착 뒤 방향키·Enter 선택을 유지한다", async () => fixture(async (page) => {
  await type(page, "ap");
  await type(page, "apple");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => requests.length === 1);
  assert.deepEqual(await page.evaluate(() => requests), ["apple"]);
  await page.evaluate(() => pending[0].resolve(["apple price"]));
  await page.waitForFunction(() => document.querySelectorAll("#url-sug .sug").length === 2);
  assert.equal(await page.$eval("#url", (input) => input.value), "https://apple.test/");
  assert.equal(await page.$eval("#url-sug .sug.on", (item) => item.textContent), "https://apple.test/");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => goCalls), ["https://www.google.com/search?q=apple%20price"]);
  assert.equal(await page.$eval("#url-sug", (el) => el.hidden), true);
}));

test("같은 스페이스에서 탭이나 주소창 값이 바뀌면 이전 추천을 표시하지 않는다", async () => fixture(async (page) => {
  await type(page, "apple");
  await page.waitForFunction(() => requests.length === 1);
  await page.evaluate(() => {
    tabStore.setActiveTab("test", "tab-b");
    document.querySelector("#url").value = "https://next.test/";
    pending[0].resolve(["old tab result"]);
  });
  await page.waitForFunction(() => document.querySelector("#url-sug").hidden);
  assert.equal(await page.$eval("#url", (input) => input.value), "https://next.test/");
  assert.deepEqual(await rows(page), []);
  await type(page, "apple");
  await page.waitForFunction(() => requests.length === 2);
  await page.evaluate(() => {
    document.querySelector("#url").value = "https://changed.test/";
    pending[1].resolve(["old input result"]);
  });
  await page.waitForFunction(() => document.querySelector("#url-sug").hidden);
  assert.deepEqual(await rows(page), []);
  await type(page, "apple");
  await page.waitForFunction(() => requests.length === 3);
  await page.evaluate(() => { tabStore.setActiveTab("test", "tab-a"); pending[2].resolve(["old tab same input"]); });
  await page.waitForFunction(() => document.querySelector("#url-sug").hidden);
  assert.deepEqual(await rows(page), []);
}));

// 조합 끝(스페이스 등)까지 추천을 미루면 입력하는 동안 추천이 안 뜬다. 방향키·Enter 는 입력기 것이라 조합 중에는 무시한다.
test("한글 조합 중에도 추천을 갱신하고, 방향키 선택·Enter 탐색은 실행하지 않는다", async () => fixture(async (page) => {
  await page.focus("#url");
  await page.$eval("#url", (input) => {
    input.dispatchEvent(new CompositionEvent("compositionstart")); input.value = "서";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", isComposing: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowDown", isComposing: true }));
  });
  await page.waitForFunction(() => requests.length === 1);
  assert.deepEqual(await page.evaluate(() => requests), ["서"]);
  assert.deepEqual(await page.evaluate(() => goCalls), []);
  assert.equal(await page.$eval("#url", (input) => input.value), "서");
  await page.$eval("#url", (input) => { input.value = "서울"; input.dispatchEvent(new CompositionEvent("compositionend")); });
  await page.waitForFunction(() => requests.length === 2);
  assert.deepEqual(await page.evaluate(() => requests), ["서", "서울"]);
}));

test("추천 기능을 끄면 기록·북마크와 원래 값 복귀를 유지한다", async () => fixture(async (page) => {
  await type(page, "apple");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.$eval("#url", (input) => input.value), "https://apple.test/");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.$eval("#url", (input) => input.value), "apple");
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => goCalls), ["apple"]);
  assert.deepEqual(await page.evaluate(() => requests), []);
}, { enabled: false }));
