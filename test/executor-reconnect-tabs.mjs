// 실행기 소켓만 다시 붙은 뒤에도 창이 탭을 다시 보고해 지목 모드를 켤 수 있어야 한다.
//
// 실행기(앱 메인 프로세스)의 소켓은 무응답 25초나 오류로 혼자 다시 붙는다. 끊길 때 서버는 탭 목록을 비우는데
// 창(렌더러) 소켓은 그대로라 탭 보고가 다시 오지 않으면 "브라우저 탭을 먼저 열어주세요"로 지목이 거절된다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-executor-reconnect-"));
process.env.IRIS_STATE_DIR = dir;
const handlers = await import("../server/browser-message-handlers.js");
const browserRuntime = await import("../server/browser-runtime.js");

browserRuntime.initBrowserRuntime({ broadcast: () => {}, getHerdr: () => null, relayToOneConsole: () => {} });
const local = [];
handlers.initBrowserMessageHandlers({ broadcast: () => {}, broadcastLocal: (m) => local.push(m) });
const ws = () => ({ _local: true, readyState: 1, replies: [], send(v) { this.replies.push(JSON.parse(v)); } });

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("같은 앱의 실행기가 다시 등록되면 창에 탭 재보고를 요청한다", () => {
  const log = console.log; console.log = () => {};
  const renderer = ws(), first = ws(), again = ws();
  try {
    handlers.handleBrowserMessage(first, { type: "cdp-executor-register", app: "/Applications/Iris.app", pid: 501 });
    handlers.handleBrowserMessage(renderer, { type: "browser-tab-wc", wc: 7, tabId: "tab-a", space: "s1", url: "https://a.test/" });
    assert.equal(browserRuntime.tabCount(), 1);

    browserRuntime.disconnectCdpExecutor(first);
    assert.equal(browserRuntime.tabCount(), 0, "끊길 때 비운다(전제)");
    local.length = 0;
    handlers.handleBrowserMessage(again, { type: "cdp-executor-register", app: "/Applications/Iris.app", pid: 501 });
    assert.ok(local.some((m) => m.type === "browser-tabs-resync"), "재등록 뒤 창이 탭을 다시 보고하지 않아 목록이 빈 채로 남는다");

    // 창이 요청을 받아 다시 보고하면 지목 모드가 켜진다.
    handlers.handleBrowserMessage(renderer, { type: "browser-tab-wc", wc: 7, tabId: "tab-a", space: "s1", url: "https://a.test/" });
    renderer.replies.length = 0;
    handlers.handleBrowserMessage(renderer, { type: "pick-mode", op: "toggle" });
    assert.equal(browserRuntime.getPickMode(), true, JSON.stringify(renderer.replies));
    handlers.handleBrowserMessage(renderer, { type: "pick-mode", op: "toggle" });
  } finally {
    browserRuntime.disconnectCdpExecutor(again);
    console.log = log;
  }
});

test("다른 앱이 거절되면 재보고를 요청하지 않는다", () => {
  const log = console.log, warn = console.warn; console.log = () => {}; console.warn = () => {};
  const holder = ws(), other = ws();
  try {
    handlers.handleBrowserMessage(holder, { type: "cdp-executor-register", app: "/Applications/Iris.app", pid: 501 });
    local.length = 0;
    handlers.handleBrowserMessage(other, { type: "cdp-executor-register", app: "/tmp/Other.app", pid: 777 });
    assert.equal(other.replies[0]?.type, "cdp-executor-refused");
    assert.ok(!local.some((m) => m.type === "browser-tabs-resync"));
  } finally {
    browserRuntime.disconnectCdpExecutor(holder);
    console.log = log; console.warn = warn;
  }
});

test("창은 재보고 요청을 받으면 열린 탭을 모두 다시 보고한다", () => {
  const main = fs.readFileSync(new URL("../web/js/main.js", import.meta.url), "utf8");
  assert.match(main, /"browser-tabs-resync": dispatchWs\([^\n]*reportAllBrowserTabs\(\)/);
});
