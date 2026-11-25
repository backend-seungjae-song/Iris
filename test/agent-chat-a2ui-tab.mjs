import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withWebPage } from "./lib/web-page.mjs";

const body = readFileSync(new URL("../web/index.html", import.meta.url), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

test("입력창의 다시 열기 요청으로 A2UI 탭을 복원하면 메모와 입력값을 유지한다", async (t) => {
  for (const [width, height] of [[900, 650], [1024, 1100], [1600, 900]]) {
    await t.test(`${width} × ${height}`, () => withWebPage(async (page) => {
      await page.setViewport({ width, height });
      await page.evaluate(async () => {
        const { initCapability } = await import("/js/agentchat/boot.js");
        const tabs = await import("/js/center/tabs.js");
        const store = await import("/js/center/tab-store.js");
        const $ = (sel) => document.querySelector(sel);
        const agent = { paneId: "test-pane", agent: "agy", sessionUuid: "test-session" };
        const deps = { $, esc: String, getLastAgents: () => [agent], getCurTarget: () => agent.paneId,
          getSelectedSpaceId: () => "test-space", wsSend() {}, isFileLikeKind: () => false,
          tabstrip: $("#tabstrip"), centerEmpty: $("#center-empty"), fileview: $("#fileview"), browserview: $("#browserview") };
        store.setCenterSpace("test-space");
        tabs.initCenterTabs(deps);
        const { initTabClose, bindTabCloseTextEditor } = await import("/js/center/tab-close.js");
        bindTabCloseTextEditor({ isTextTabDirty: () => false });
        initTabClose({ ...deps, renderTabs: tabs.renderTabs, showActiveTab: tabs.showActiveTab, persistFileTabs() {}, syncWatchDirs() {}, scheduleWebviewThrottling() {}, forgetTabWc() {} });
        const { ws } = initCapability({ ...deps, renderTabs: tabs.renderTabs, showActiveTab: tabs.showActiveTab });
        const surface = { surfaceId: "one", title: "검토", layout: "dock", components: [{ type: "TextField", bind: "note" }] };
        window.updateSurfaces = (surfaces = [surface]) => ws["agentchat.a2ui"]({ key: "pane:test-pane:test-session", surfaces });
        $("#panel-memo").classList.remove("collapsed");
        window.updateSurfaces();
      });
      assert.equal(await page.$$eval("#tabstrip .ctab.active", els => els.length), 1);
      assert.equal(await page.$(".a2ui-head"), null);
      assert.equal(await page.$('#right .right-head [aria-label="A2UI 탭 열기"]'), null);
      const field = "#center-body .a2ui-input";
      await page.type(field, "draft");
      const memo = await page.$eval("#panel-memo", el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 10));
      });
      assert.ok(memo, "메모의 머리글을 클릭할 수 있어야 함");
      await page.click("#tabstrip .ctab.active .cclose");
      await page.evaluate(() => window.updateSurfaces());
      assert.equal(await page.$$eval("#tabstrip .ctab", els => els.length), 0);
      const frame = await (await page.$(".achat-frame")).contentFrame();
      await frame.evaluate(origin => parent.postMessage({
        type: "iris-chat.open-a2ui", key: "pane:test-pane:test-session",
      }, origin), new URL(page.url()).origin);
      await page.waitForSelector("#tabstrip .ctab.active");
      assert.equal(await page.$eval(field, el => el.value), "draft");
      await page.evaluate(() => window.updateSurfaces([]));
      assert.equal(await page.$$eval("#tabstrip .ctab", els => els.length), 0);
    }, { body }));
  }
});
