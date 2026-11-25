import assert from "node:assert/strict";
import test from "node:test";
import { withWebPage } from "./lib/web-page.mjs";

test("목록 아래에서 이름을 바꾸면 상태 응답은 해당 세션 이름만 갱신", async () => {
  await withWebPage(async (page) => {
    const errors = [];
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = class {
        readyState = 1;
        constructor() { window.serverMessage = (message) => this.onmessage({ data: JSON.stringify(message) }); }
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg.type === "tab.rename") {
            const agent = window.snapshot.agents.find((a) => a.tabId === msg.tabId);
            agent.tabLabel = msg.label;
            window.serverMessage(window.snapshot);
          }
        }
        close() {}
      };
    });
    await page.goto(new URL("/index.html", page.url()).href);
    await page.evaluate(() => import("/js/main.js").then(() => true));
    await page.evaluate(() => {
      window.serverMessage({ type: "caps", netPolicy: "loopback-only/1", local: true });
      const agents = Array.from({ length: 70 }, (_, i) => ({
        paneId: "pane" + i, workspaceId: "space", tabId: "tab" + i,
        agent: "codex", status: "idle", tabLabel: "세션 " + i,
      }));
      window.snapshot = { type: "state", workspaces: [{ id: "space", label: "프로젝트" }],
        agents, tabs: { space: agents.map(({ tabId }) => ({ tabId })) } };
      window.serverMessage(window.snapshot);
    });
    const target = '.srow[data-target="pane55"]';
    await page.click(target, { button: "right" });
    await page.locator('#ctxmenu ::-p-text(이름 바꾸기)').click();
    await page.waitForSelector(".askwrap input");
    await page.$eval(".askwrap input", (input) => input.select());
    await page.keyboard.type("edited");
    const before = await page.evaluate(() => {
      const list = document.querySelector("#space-list");
      window.neighbor = list.querySelector('[data-target="pane54"]');
      window.edited = list.querySelector('[data-target="pane55"]');
      window.nameNode = edited.querySelector(".srow-name").firstChild;
      return list.scrollTop;
    });
    assert.ok(before > 0);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-target="pane55"] .srow-name').textContent === "edited");
    const result = await page.evaluate(() => ({
      sameNeighbor: neighbor === document.querySelector('[data-target="pane54"]'),
      sameName: nameNode === document.querySelector('[data-target="pane55"] .srow-name').firstChild,
      top: document.querySelector("#space-list").scrollTop,
    }));
    assert.deepEqual(result, { sameNeighbor: true, sameName: true, top: before });
    assert.deepEqual(errors, []);
  }, { overrides: { "/features": JSON.stringify({ exists: true, local: true, revision: 1, hidden: [] }) } });
});

test("분리 브라우저 창은 터미널이 닫혀도 콘솔 목록을 렌더하지 않는다", async () => {
  await withWebPage(async (page) => {
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = class {
        readyState = 1;
        constructor() { window.deliver = message => this.onmessage({ data: JSON.stringify(message) }); }
        send() {}
        close() {}
      };
    });
    await page.goto(new URL("/index.html?mode=browser&space=w1", page.url()).href);
    await page.evaluate(() => import("/js/main.js").then(() => true));
    const result = await page.evaluate(async () => {
      const { getTabsForSpace } = await import("/js/herdr/state.js");
      const tabs = [{ tabId: "t1", focused: true }, { tabId: "t2" }];
      const state = { type: "state", local: true, workspaces: [{ id: "w1" }], agents: [], tabs: { w1: tabs } };
      deliver({ type: "caps", netPolicy: "loopback-only/1", local: true });
      deliver(state);
      const observer = new MutationObserver(() => {});
      for (const id of ["space-list", "htabs"]) observer.observe(document.getElementById(id), { subtree: true, childList: true, attributes: true });
      tabs.pop();
      deliver(state);
      return { tabs: getTabsForSpace("w1").map(t => t.tabId), changes: observer.takeRecords().length };
    });
    assert.deepEqual(result, { tabs: ["t1"], changes: 0 });
  }, { overrides: { "/features": JSON.stringify({ exists: true, local: true, revision: 1, hidden: [] }) } });
});
