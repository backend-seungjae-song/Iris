import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");

test("주소창 확장 버튼은 현재 탭을 열고 실패 뒤 다시 사용할 수 있다", async () => {
  const built = await build({ entryPoints: ["web/js/browser/extensions.js"], bundle: true,
    write: false, format: "iife", globalName: "Extensions" });
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const tools = html.match(/<div class="ub-tools">[\s\S]*?<\/div>/)?.[0];
  assert.ok(tools);
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="urlbar">${tools}</div>`);
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.evaluate(() => {
      window.calls = [];
      window.messages = [];
      window.active = 11;
      window.fail = false;
      const records = [11, 22].map((id) => [String(id), { tabId: String(id), wc: 999,
        el: { classList: { contains: () => active === id }, getWebContentsId: () => id } }]);
      window.ctx = {
        acHost: { browserExtensionsMenu: async (payload) => {
          calls.push(payload);
          if (fail) throw new Error("메뉴 연결 실패");
          return { ok: true };
        } },
        getWebviewEntries: () => records,
        showToast: (message) => messages.push(message),
      };
      Extensions.initCapability(ctx);
      Extensions.initCapability(ctx);
    });
    assert.equal(await page.$$eval("#wv-extensions", (nodes) => nodes.length), 1);
    await page.click("#wv-extensions");
    await page.waitForFunction(() => calls.length === 1);
    assert.deepEqual(await page.evaluate(() => calls[0]), { guestWebContentsId: 11 });
    await page.evaluate(() => { active = 22; });
    await page.click("#wv-extensions");
    assert.deepEqual(await page.evaluate(() => calls.at(-1)), { guestWebContentsId: 22 });
    await page.evaluate(() => { fail = true; });
    await page.click("#wv-extensions");
    await page.waitForFunction(() => messages.includes("메뉴 연결 실패"));
    assert.equal(await page.$eval("#wv-extensions", (button) => button.disabled), false);
    await page.evaluate(() => { active = null; });
    await page.click("#wv-extensions");
    assert.equal(await page.evaluate(() => calls.length), 3);
    assert.match(await page.evaluate(() => messages.at(-1)), /탭을 먼저/);
    await page.evaluate(() => { document.querySelector("#wv-extensions").remove(); Extensions.initCapability({}); });
    assert.equal(await page.$("#wv-extensions"), null);
  } finally { await browser.close(); }
});

test("확장의 새 탭은 요청한 탭의 스페이스·그룹·실제 프로필을 이어받는다", async () => {
  const built = await build({ stdin: { contents: `export { createExtensionTab } from './web/js/browser/extensions.js';
    export { replaceBrowserState } from './web/js/browser/state.js';
    export { initAiTabs } from './web/js/browser/ai-tabs.js';
    export { initWebview } from './web/js/browser/webview.js';
    export { registerWebview, getWebviewEntries } from './web/js/browser/webview-store.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", globalName: "Fixture" });
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: built.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      Fixture.replaceBrowserState({ tabsBySpace: { source: [{ id: "opener", group: "g1", profile: "old" }] } });
      Fixture.registerWebview("opener", { el: { dataset: { profile: "live-profile" }, getWebContentsId: () => 11 }, ready: true, createdAt: Date.now() });
      Fixture.initWebview({ getSpaces: () => [{ id: "source" }] });
      const calls = [], woken = [];
      const aiContext = { BROWSER_MODE: true, BOUND_SPACE: null, reportTabWc: () => {}, createWebview: (id, profile, url) => {
        woken.push({ id, profile, url });
        Fixture.registerWebview(id, { el: { getWebContentsId: () => 22 }, ready: false, createdAt: Date.now() });
      } };
      Fixture.initAiTabs(aiContext);
      const ctx = { getWebviewEntries: Fixture.getWebviewEntries, openBrowserTab: (url, options) => {
        calls.push({ url, options });
        setTimeout(() => {
          Fixture.replaceBrowserState({ tabsBySpace: { source: [{ id: "opener" }, { id: "created", profile: options.profile, url }] } });
        }, 30);
        return "created";
      } };
      const response = await Fixture.createExtensionTab(ctx, { openerWc: 11, url: "https://example.test/", active: false });
      let error;
      try { await Fixture.createExtensionTab(ctx, { openerWc: 999, url: "https://example.test/" }); } catch (failure) { error = failure.message; }
      const blocked = [];
      try { await Fixture.createExtensionTab({ ...ctx, boundTab: "opener" }, { openerWc: 11, url: "https://example.test/" }); } catch (failure) { blocked.push(failure.message); }
      Fixture.initAiTabs({ ...aiContext, BOUND_SPACE: "source" });
      try { await Fixture.createExtensionTab(ctx, { openerWc: 11, url: "https://example.test/" }); } catch (failure) { blocked.push(failure.message); }
      return { calls, woken, blocked, response, error };
    });
    assert.deepEqual(result.calls, [{ url: "https://example.test/", options: { background: true, profile: "live-profile", space: "source", group: "g1" } }]);
    assert.deepEqual(result.response, { webContentsId: 22, index: 1 });
    assert.deepEqual(result.woken, [{ id: "created", profile: "live-profile", url: "https://example.test/" }]);
    assert.equal(result.blocked.length, 2);
    assert.match(result.blocked[0], /한 탭/);
    assert.match(result.blocked[1], /표시할 수 없습니다/);
    assert.match(result.error, /닫혔습니다/);
  } finally { await browser.close(); }
});
