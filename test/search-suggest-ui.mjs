import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");

async function fixture(run, { enabled = true, chromeLayout = false } = {}) {
  let html = '<input id="url"><div id="url-sug" hidden></div><button id="other">다른 버튼</button>';
  if (chromeLayout) {
    const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    const header = sliceBetween(index, '<div class="browserview"', '<div class="wv-wrap"', "검색 주소창").replace('id="browserview" hidden', 'id="browserview"');
    const css = ['00-tokens', '01-base', '01c-components', '11-center-tabs', '17-editor-bar', '18-browser', '42-page-translate'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('');
    html = `<!doctype html><html><head>${css}</head><body><div class="center-body" style="height:100vh">${header}</div><div class="center-webviews" style="inset:80px 0 0;width:100%;height:calc(100% - 80px)"><button id="other">페이지 버튼</button></div></div></body></html>`;
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    try {
      if (!path.startsWith("/js/") && !path.startsWith("/css/")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return; }
      res.writeHead(200, { "Content-Type": path.endsWith('.css') ? 'text/css' : "text/javascript" });
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

test('북마크 링크·파일·폴더 편집 중에는 끌어서 이동하지 않고 편집 후에는 이동할 수 있다', async () => fixture(async page => {
  await page.evaluate(() => {
    window.mutations = [];
    state.initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: 'test', wsSend: message => mutations.push(message) });
    state.replaceBrowserState({ bookmarksBySpace: { test: [
      { url: 'https://example.test/', title: '링크' },
      { url: 'file:///tmp/example.txt', title: '파일' },
      { folder: 'folder', title: '폴더', items: [] },
    ] }, tabsBySpace: {}, activeBySpace: {} });
    bookmarks.renderBookmarks(); bookmarks.wireBookmarkBar();
  });
  for (const index of [0, 1, 2]) {
    await page.$$eval('.bmk-e', (buttons, i) => buttons[i].click(), index);
    const result = await page.evaluate(index => {
      const chips = [...document.querySelectorAll('.bmk')], chip = chips[index];
      const input = chip.querySelector('input');
      input.value = '수정 중'; input.setSelectionRange(1, 3);
      const starts = [chip, input, chips[(index + 1) % chips.length]].map(target => {
        const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
        target.dispatchEvent(event); return event.defaultPrevented;
      });
      chips[(index + 1) % chips.length].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      return { draggable: chip.draggable, starts, dragging: !!document.querySelector('.dragging'), value: input.value, selection: [input.selectionStart, input.selectionEnd], mutations: mutations.length };
    }, index);
    assert.deepEqual(result, { draggable: false, starts: [true, true, true], dragging: false, value: '수정 중', selection: [1, 3], mutations: 0 });
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.bmk', (chips, i) => chips[i].draggable, index), true);
  }
  await page.evaluate(() => {
    const chips = document.querySelectorAll('.bmk');
    chips[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    chips[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => mutations.length), 1);
}, { chromeLayout: true }));

test('주소창 자동완성은 북마크 위에 표시되고 가려진 위치에서도 선택할 수 있다', async () => fixture(async page => {
  await page.evaluate(() => {
    window.bookmarkClicks = 0;
    state.replaceBrowserState({ urlHistoryBySpace: { test: ['https://apple.test/', 'https://apple-two.test/', 'https://apple-three.test/'] }, tabsBySpace: {}, activeBySpace: {} });
    const bar = document.querySelector('#bookmark-bar');
    for (const name of ['AWS(center)', 'YouTube', 'Claude', 'Threads', 'ChatGPT']) {
      const button = document.createElement('button'); button.className = 'bmk'; button.textContent = name;
      button.addEventListener('click', () => { bookmarkClicks++; }); bar.append(button);
    }
  });
  for (const [width, height, zoom] of [[1000, 700, 1], [390, 900, 1], [1440, 1000, 1], [1000, 700, 1.25]]) {
    await page.setViewport({ width, height });
    await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
    await type(page, 'apple');
    const point = await page.$$eval('#url-sug .sug', rows => {
      const bookmark = document.querySelector('.bookmark-line').getBoundingClientRect();
      const row = rows.find(item => { const rect = item.getBoundingClientRect(); return rect.top < bookmark.bottom && rect.bottom > bookmark.top; });
      if (!row) return { overlaps: false };
      const rect = row.getBoundingClientRect();
      const x = rect.left + Math.min(80, rect.width / 2), y = (Math.max(rect.top, bookmark.top) + Math.min(rect.bottom, bookmark.bottom)) / 2;
      return { x, y, value: row.textContent, overlaps: true, topIsSuggestion: row.contains(document.elementFromPoint(x, y)) };
    });
    assert.equal(point.overlaps, true);
    assert.equal(point.topIsSuggestion, true, `${width}×${height}, 확대 ${zoom}: 북마크가 자동완성을 덮었다`);
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => goCalls.at(-1)), point.value);
    assert.equal(await page.evaluate(() => bookmarkClicks), 0);
  }
}, { chromeLayout: true }));

test('주소창의 별 아이콘은 북마크 해제·선택 상태 모두 버튼 중앙에 표시된다', async () => fixture(async page => {
  for (const width of [390, 1000, 1440]) {
    await page.setViewport({ width, height: 900 });
    const zoom = width === 1000 ? 1.25 : 1;
    await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
    for (const on of [false, true]) {
      const offset = await page.$eval('#wv-bookmark', (button, selected) => {
        button.classList.toggle('on', selected);
        const bounds = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
        return { x: Math.abs(bounds.left + bounds.width / 2 - icon.left - icon.width / 2), y: Math.abs(bounds.top + bounds.height / 2 - icon.top - icon.height / 2), width: bounds.width, height: bounds.height };
      }, on);
      assert.ok(offset.x <= 0.1 && offset.y <= 0.1, `${width}px, 북마크 ${on}: 중앙 오차 ${JSON.stringify(offset)}`);
      assert.deepEqual([offset.width, offset.height], [20 * zoom, 20 * zoom]);
    }
  }
}, { chromeLayout: true }));

test('번역 버튼과 계정 버튼의 간격은 번역 버튼이 없을 때 검색창과 계정 버튼의 간격과 같다', async () => fixture(async page => {
  await page.evaluate(async () => {
    window.translateControls = (await import('/js/browser/page-translate-ui.js')).createTranslateControls();
  });
  for (const width of [1000, 1440]) {
    await page.setViewport({ width, height: 900 });
    const zoom = width === 1000 ? 1.25 : 1;
    await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
    const dimensions = async () => page.evaluate(() => {
      const input = document.querySelector('.url-wrap'), account = document.querySelector('#wv-profile'), translate = document.querySelector('#wv-translate');
      const inputRect = input.getBoundingClientRect(), accountRect = account.getBoundingClientRect(), translateRect = translate.getBoundingClientRect();
      const padding = node => { const style = getComputedStyle(node); return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]; };
      return { gap: accountRect.left - (translate.hidden ? inputRect.right : translateRect.right), searchGap: translateRect.left - inputRect.right, inputPadding: padding(input), accountPadding: padding(account), accountWidth: accountRect.width, accountHeight: accountRect.height, translateWidth: translateRect.width, translateHeight: translateRect.height };
    });
    await page.evaluate(() => translateControls.update({ visible: false }));
    const hidden = await dimensions();
    await page.evaluate(() => translateControls.update({ visible: true }));
    const shown = await dimensions();
    assert.equal(shown.gap, hidden.gap, `${width}px`);
    assert.equal(shown.searchGap, 4 * zoom, `${width}px: 검색창과 번역 버튼 간격`);
    assert.deepEqual(shown.inputPadding, hidden.inputPadding);
    assert.deepEqual(shown.accountPadding, hidden.accountPadding);
    assert.deepEqual([shown.accountWidth, shown.accountHeight], [hidden.accountWidth, hidden.accountHeight]);
    assert.deepEqual([shown.translateWidth, shown.translateHeight], [26 * zoom, 26 * zoom]);
  }
}, { chromeLayout: true }));

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
