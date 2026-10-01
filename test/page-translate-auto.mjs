import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { initCapability, autoTranslatePreferenceKey, buildPageTranslateScript } from "../web/js/browser/page-translate.js";
import { callHook, clearHooks } from "../web/js/core/hooks.js";

const require = createRequire(import.meta.url);
const { createWebviewContextActions } = require("../native/electron/webview-context-actions.cjs");
const { createWebviewContextMenu } = require("../native/electron/webview-context-menu.cjs");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t, { storage = new Map(), result = { ok: true, code: "translated" } } = {}) {
  const previousWindow = globalThis.window;
  clearHooks();
  globalThis.window = new EventTarget();
  window.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  t.after(() => { globalThis.window = previousWindow; clearHooks(); });
  const entries = new Map(), toasts = [], executions = [];
  const webview = new EventTarget();
  let url = "https://article.test/one";
  let partition = "persist:acprof:first";
  webview.getURL = () => url;
  webview.getWebContentsId = () => 71;
  webview.getAttribute = (name) => name === "partition" ? partition : null;
  webview.executeJavaScript = async (script) => { executions.push({ url, script }); return typeof result === "function" ? result() : result; };
  webview.reload = () => { throw new Error("setting must not reload pages with unsaved input"); };
  const record = { el: webview, wc: 71, ready: true };
  entries.set("tab", record);
  const host = new EventEmitter();
  Object.assign(host, { id: 41, isDestroyed: () => false,
    send: (_channel, message) => { host.pendingAction = callHook(message.name, message); } });
  const registry = createWebviewContextActions();
  initCapability({ getWebviewEntries: () => entries,
    acHost: { registerContextAction: (action) => registry.register(host, action) },
    showToast: (message, options) => toasts.push({ message, options }) });
  let menu;
  const guest = new EventEmitter();
  Object.assign(guest, { id: 71, hostWebContents: host, getURL: webview.getURL });
  createWebviewContextMenu({ Menu: { buildFromTemplate: (items) => ({ popup: () => { menu = items; } }) },
    clipboard: {}, searchUrlFor: () => "", getContextActions: registry.get }).attach(guest);
  return { storage, webview, record, toasts, executions, entries,
    setUrl: (value) => { url = value; }, setPartition: (value) => { partition = value; },
    emit(name, values = {}) { const event = new Event(name); Object.assign(event, values); webview.dispatchEvent(event); },
    async menuClick(label) {
      guest.emit("context-menu", {}, {});
      const item = menu.find((item) => item.label === label);
      assert.ok(item, `메뉴에서 ${label}에 도달할 수 있어야 한다`);
      item.click();
      return host.pendingAction;
    },
  };
}

test("실제 우클릭 메뉴 action으로 자동 번역을 켜고 다음 탐색·reload에 적용하고 끈다", async (t) => {
  const f = fixture(t);
  await settle();
  assert.equal(f.executions.length, 0, "설정 전에는 외부 번역 코드를 실행하지 않는다");
  const enabled = await f.menuClick("이 사이트 항상 한국어로 번역");
  assert.equal(enabled.code, "auto-enabled");
  assert.equal(enabled.translation.ok, true);
  assert.equal(f.executions.length, 1, "메뉴 선택은 현재 페이지도 번역한다");
  assert.equal(f.storage.get(autoTranslatePreferenceKey(f.webview)), "ko");
  f.setUrl("https://article.test/two");
  f.emit("did-start-navigation", { isMainFrame: true });
  f.emit("dom-ready");
  await settle();
  assert.equal(f.executions.length, 2);
  f.emit("dom-ready");
  await settle();
  assert.equal(f.executions.length, 3, "같은 URL 새 문서도 번역한다");
  assert.equal((await f.menuClick("이 사이트 자동 번역 끄기")).code, "auto-disabled");
  assert.equal(f.storage.size, 0);
  f.emit("dom-ready");
  await settle();
  assert.equal(f.executions.length, 3);
  assert.match(f.toasts.at(-1).message, /새로고침하면 원문/);
});

test("설정을 다시 읽고 프로필·origin 범위를 구분한다", async (t) => {
  const storage = new Map([["iris.pageTranslate.auto.v1:" + JSON.stringify(["persist:acprof:first", "https://article.test"]), "ko"]]);
  const f = fixture(t, { storage });
  await settle();
  assert.equal(f.executions.length, 1, "이미 준비된 탭은 저장 설정을 적용한다");
  for (const url of ["https://other.test/", "http://article.test/", "https://article.test:8443/", "file:///tmp/page.html"]) {
    f.setUrl(url); f.emit("dom-ready"); await settle();
  }
  f.setUrl("https://article.test/again");
  f.setPartition("persist:acprof:second"); f.emit("dom-ready"); await settle();
  assert.equal(f.executions.length, 1);
});

test("하위 프레임 이동은 무시하고 SPA 이벤트가 겹쳐도 한 번만 번역한다", async (t) => {
  const f = fixture(t);
  await f.menuClick("이 사이트 항상 한국어로 번역");
  f.setUrl("https://article.test/spa");
  f.emit("did-navigate-in-page", { isMainFrame: false }); await settle(180);
  assert.equal(f.executions.length, 1);
  f.emit("did-navigate-in-page", { isMainFrame: true });
  f.emit("did-navigate-in-page", { isMainFrame: true }); await settle(180);
  assert.equal(f.executions.length, 2);
});

test("저장 실패와 자동 번역 CSP 실패를 성공으로 표시하지 않는다", async (t) => {
  const f = fixture(t, { result: { ok: false, code: "csp", detail: "blocked" } });
  window.localStorage.setItem = () => { throw new Error("storage blocked"); };
  assert.equal((await f.menuClick("이 사이트 항상 한국어로 번역")).code, "storage");
  assert.equal(f.executions.length, 0);
  assert.equal(f.toasts.at(-1).options.level, "err");
  window.localStorage.setItem = (key, value) => f.storage.set(key, value);
  const enabled = await f.menuClick("이 사이트 항상 한국어로 번역");
  assert.equal(enabled.translation.code, "csp");
  assert.match(f.toasts.at(-1).message, /보안 정책/);
  f.emit("dom-ready"); await settle();
  assert.equal(f.toasts.at(-1).options.level, "err");
});

test("SPA 탐색 중 진행 중인 번역이 끝난 뒤 새 화면을 번역한다", async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let runs = 0;
  const f = fixture(t, { result: () => ++runs === 1 ? pending : { ok: true, code: "translated" } });
  const enabling = f.menuClick("이 사이트 항상 한국어로 번역");
  await settle();
  f.setUrl("https://article.test/spa");
  f.emit("did-start-navigation", { isMainFrame: true });
  f.emit("did-navigate-in-page", { isMainFrame: true });
  await settle(180);
  assert.equal(f.executions.length, 1, "앞선 번역 실행이 끝나기를 기다린다");
  resolve({ ok: true, code: "translated" });
  await enabling; await settle();
  assert.equal(f.executions.length, 2);
});

test("guest DOM에서 widget 적용과 실제 CSP 거절을 확인한다", async () => {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    let blocked = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith("https://translate.google.com/translate_a/element.js")) {
        const callback = new URL(request.url()).searchParams.get("cb");
        void request.respond({ contentType: "text/javascript; charset=utf-8", body: `window.google={translate:{TranslateElement:function(options,id){const select=document.createElement('select');select.className='goog-te-combo';select.innerHTML='<option value="">Select</option><option value="ko">Korean</option>';document.getElementById(id).append(select);select.addEventListener('change',()=>{document.querySelector('p').textContent='한국어 번역';document.documentElement.classList.add('translated-ltr');});}}};window[${JSON.stringify(callback)}]();` });
      } else void request.respond({ contentType: "text/html", headers: blocked ? { "Content-Security-Policy": "script-src 'self'" } : {},
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Hello world</p></body></html>' });
    });
    await page.goto("https://article.iris.test/");
    const result = await page.evaluate((script) => window.eval(script), buildPageTranslateScript());
    assert.equal(result.ok, true);
    assert.equal(await page.$eval("p", (el) => el.textContent), "한국어 번역");
    assert.equal(await page.evaluate(() => document.cookie.includes("googtrans=")), false);
    blocked = true;
    await page.reload();
    const refused = await page.evaluate((script) => window.eval(script), buildPageTranslateScript());
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "csp");
    assert.equal(await page.$eval("p", (el) => el.textContent), "Hello world");
  } finally { await browser.close(); }
});

test("실제 DOM에 추가한 새 탭과 다른 창의 설정 변경을 관찰한다", async () => {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ contentType: "text/html", body: '<!doctype html><div id="wv-stack"></div>' }));
    await page.goto("https://iris.automation.test/");
    await page.evaluate(async ({ hooksSource, source }) => {
      const moduleUrl = (body) => URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
      const hooksUrl = moduleUrl(hooksSource);
      const module = await import(moduleUrl(source.replace('"../core/hooks.js"', JSON.stringify(hooksUrl))));
      window.entries = new Map();
      window.executions = [];
      window.translationModule = module;
      module.initCapability({ $: (selector) => document.querySelector(selector), getWebviewEntries: () => entries,
        acHost: { registerContextAction() {} } });
      window.addTab = (id, ready = false) => {
        const el = document.createElement("webview");
        el.setAttribute("partition", "persist:acprof:first");
        el.getURL = () => "https://article.test/" + id;
        el.getWebContentsId = () => id;
        el.executeJavaScript = async () => { executions.push(id); return { ok: true, code: "translated" }; };
        entries.set(id, { el, wc: id, ready });
        document.querySelector("#wv-stack").append(el);
        return el;
      };
      const first = addTab(71);
      localStorage.setItem(module.autoTranslatePreferenceKey(first), "ko");
    }, { hooksSource: readFileSync(new URL("../web/js/core/hooks.js", import.meta.url), "utf8"),
      source: readFileSync(new URL("../web/js/browser/page-translate.js", import.meta.url), "utf8") });
    await settle();
    assert.equal(await page.evaluate(() => executions.length), 0, "로드 전 새 탭에서는 실행하지 않는다");
    await page.evaluate(() => { const rec = entries.get(71); rec.ready = true; rec.el.dispatchEvent(new Event("dom-ready")); });
    await page.waitForFunction(() => executions.length === 1);
    await page.evaluate(() => addTab(72, true));
    await page.waitForFunction(() => executions.length === 2);
    await page.evaluate(() => {
      const key = translationModule.autoTranslatePreferenceKey(entries.get(71).el);
      localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
      for (const rec of entries.values()) rec.el.dispatchEvent(new Event("dom-ready"));
    });
    await settle();
    assert.equal(await page.evaluate(() => executions.length), 2);
    await page.evaluate(() => {
      const key = translationModule.autoTranslatePreferenceKey(entries.get(71).el);
      localStorage.setItem(key, "ko");
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: "ko" }));
    });
    await page.waitForFunction(() => executions.length === 4);
    assert.deepEqual(await page.evaluate(() => executions), [71, 72, 71, 72]);
  } finally { await browser.close(); }
});
