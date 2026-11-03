import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { createWorkerBrowserService } from "../server/mcp-worker/browser-service.js";
import { COMMAND_ROUTES, WORKER_HANDLERS, workerHandlerFor } from "../server/mcp-worker/command-routes.js";
import { INPUT_COMMAND_NAMES } from "../server/mcp-worker/input-route.js";
import { NATIVE_COMMAND_NAMES } from "../server/mcp-worker/native-route.js";
import { QA_OBSERVE_COMMAND_NAMES } from "../server/mcp-worker/qa-observe-route.js";
import { QA_COMMAND_NAMES } from "../server/mcp-worker/qa-route.js";
import { PAGE_COMMAND_NAMES } from "../server/mcp-worker/page-route.js";

const require = createRequire(import.meta.url);
const { createPageCommands } = require("../native/electron/cdp-cmd-page.cjs");
const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/worker-route-url-golden.json", import.meta.url), "utf8"));
const legacyHandlers = createPageCommands({ applyViewport: async () => ({}) });
const token = { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 };

// Electron 대역: 옛 명령은 실제 옛 처리기, 기본 명령 wc.info 는 중계의 info() 와 같은 모양
function harness(fixture, { dialog = null, failure = null, features = ["worker-command-unit"], statusFails = false } = {}) {
  const wc = { id: 7, getURL: () => fixture.url, getTitle: () => fixture.title };
  const relays = [];
  const calls = [];
  const hostApi = {
    withCommand: (command, run) => { calls.push(["identity", command.identity]); return run(); },
    call: async (operation, input) => {
      calls.push([operation, input]);
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: token, tab: {} } };
      if (operation === "browser.status") {
        if (statusFails) throw new Error("status 실패");
        return { executorReady: true, executor: { app: "x", pid: 1, features } };
      }
      if (operation !== "browser.executeWithDialog") return {};
      relays.push({ command: input.relay.command, args: input.relay.args, unit: input.relay.unit, tabId: input.tabId, targetToken: input.targetToken });
      if (input.relay.command === "unit.end") return { ok: true, data: { ended: true }, commandState: "completed" };
      if (dialog) return { ...dialog, commandState: "blocked" };
      if (failure) return { ok: false, error: failure, commandState: "completed" };
      if (input.relay.command === "url") return { ok: true, data: await legacyHandlers.url(null, wc), commandState: "completed" };
      if (input.relay.command === "wc.info") {
        return { ok: true, commandState: "completed", data: { wcId: 7, url: wc.getURL(), title: wc.getTitle(), loading: false,
          zoom: 1.25, canGoBack: true, canGoForward: false, documentGeneration: 3, debuggerGeneration: 4 } };
      }
      throw new Error(`예상하지 않은 중계 명령 ${input.relay.command}`);
    },
  };
  return { relays, calls, hostApi };
}

const dispatch = (service, session = "pane") => service.dispatch({ command: "url", args: {}, identity: { session }, commandId: "c/1" });
const activity = { run: (_kind, _id, run) => run() };

test("표 기본값은 url·snapshot·입력·페이지·네이티브·QA 명령과 확인 창 문구 가리기가 worker 경로", () => {
  assert.deepEqual({ ...COMMAND_ROUTES }, { url: "worker", snapshot: "worker", ...Object.fromEntries([...INPUT_COMMAND_NAMES, ...PAGE_COMMAND_NAMES, ...NATIVE_COMMAND_NAMES, ...QA_COMMAND_NAMES, ...QA_OBSERVE_COMMAND_NAMES].map((name) => [name, "worker"])), redact: "worker" });
  assert.equal(typeof workerHandlerFor("url"), "function");
  assert.equal(workerHandlerFor("mouse"), null);
  assert.equal(workerHandlerFor("phonekey"), null);
  assert.equal(workerHandlerFor("url", { url: "legacy" }), null);
  assert.equal(workerHandlerFor("toString", { toString: "worker" }), null);
  assert.deepEqual(Object.keys(WORKER_HANDLERS), ["url", "snapshot", ...INPUT_COMMAND_NAMES, ...PAGE_COMMAND_NAMES, ...NATIVE_COMMAND_NAMES, ...QA_COMMAND_NAMES, ...QA_OBSERVE_COMMAND_NAMES]);
});

for (const fixture of golden) {
  test(`url golden master: ${fixture.name} 은 옛 처리기와 새 경로가 같은 응답`, async () => {
    const worker = harness(fixture);
    const viaWorker = await dispatch(createWorkerBrowserService({ hostApi: worker.hostApi, activity }));
    assert.deepEqual(viaWorker, fixture.response);
    assert.deepEqual(worker.relays.map(item => item.command), ["wc.info"]);

    const legacy = harness(fixture);
    const viaLegacy = await dispatch(createWorkerBrowserService({ hostApi: legacy.hostApi, activity, routes: { url: "legacy" } }));
    assert.deepEqual(viaLegacy, fixture.response);
    assert.deepEqual(viaWorker, viaLegacy);
  });
}

test("플래그를 legacy 로 돌리면 옛 url 봉투로 간다", async () => {
  const { relays, hostApi } = harness(golden[0]);
  await dispatch(createWorkerBrowserService({ hostApi, activity, routes: { url: "legacy" } }));
  assert.deepEqual(relays.map(item => item.command), ["url"]);
  const empty = harness(golden[0]);
  await dispatch(createWorkerBrowserService({ hostApi: empty.hostApi, activity, routes: {} }));
  assert.deepEqual(empty.relays.map(item => item.command), ["url"]);
});

test("worker 경로도 같은 탭·target token·세션 식별을 그대로 보낸다", async () => {
  const { relays, calls, hostApi } = harness(golden[0]);
  const service = createWorkerBrowserService({ hostApi, activity });
  await dispatch(service, "pane-a");
  await dispatch(service, "pane-b");
  assert.deepEqual(relays.map(item => [item.tabId, item.targetToken]), [["tab-a", token], ["tab-a", token]]);
  assert.deepEqual(calls.filter(item => item[0] === "identity").map(item => item[1].session), ["pane-a", "pane-b"]);
});

test("실패 응답과 확인 창 차단 응답은 옛 경로와 같게 통과한다", async () => {
  for (const options of [{ failure: "탭이 닫혔습니다" }, { dialog: { dialogOpen: { type: "alert", message: "hi" } } }]) {
    const viaWorker = await dispatch(createWorkerBrowserService({ hostApi: harness(golden[0], options).hostApi, activity }));
    const viaLegacy = await dispatch(createWorkerBrowserService({ hostApi: harness(golden[0], options).hostApi, activity, routes: { url: "legacy" } }));
    assert.deepEqual(viaWorker, viaLegacy);
  }
});

test("메인이 단위 실행을 알리지 않으면 옛 url 봉투로 간다 (지금 설치 앱의 메인)", async () => {
  for (const options of [{ features: [] }, { features: null }, { statusFails: true }]) {
    const { relays, hostApi } = harness(golden[0], options);
    const response = await dispatch(createWorkerBrowserService({ hostApi, activity }));
    assert.deepEqual(relays.map(item => [item.command, item.unit]), [["url", undefined]]);
    assert.deepEqual(response, golden[0].response);
  }
});

test("worker 경로 url 은 마지막 호출 표시 하나만 보내고 명시 종료는 보내지 않는다", async () => {
  const { relays, hostApi } = harness(golden[0]);
  await dispatch(createWorkerBrowserService({ hostApi, activity }));
  assert.deepEqual(relays.map(item => [item.command, item.unit]), [["wc.info", { command: "url", phase: "last" }]]);
});

test("마지막 호출이 확인 창에 막히면 명시 종료로 단위를 닫는다", async () => {
  const { relays, hostApi } = harness(golden[0], { dialog: { dialogOpen: { type: "alert", message: "hi" } } });
  await dispatch(createWorkerBrowserService({ hostApi, activity }));
  assert.deepEqual(relays.map(item => [item.command, item.unit?.phase]), [["wc.info", "last"], ["unit.end", "end"]]);
});

test("기본 명령 응답의 moments 는 처리기가 모양을 바꿔도 사용자 응답에 붙는다", async () => {
  const { hostApi } = harness(golden[0]);
  const original = hostApi.call;
  hostApi.call = async (operation, input) => {
    const out = await original(operation, input);
    return operation === "browser.executeWithDialog" && input.relay.command === "wc.info"
      ? { ...out, data: { ...out.data, moments: [{ kind: "console", text: "m" }] } } : out;
  };
  const response = await dispatch(createWorkerBrowserService({ hostApi, activity }));
  assert.deepEqual(response.data.moments, [{ kind: "console", text: "m" }]);
  assert.equal(response.data.url, golden[0].response.data.url);
});

test("확인 창 게이트를 통과하는 host 작업 단위 이름은 일반 명령 경로로 고를 수 없다", async () => {
  const { ordinaryCommandDenied } = await import("../server/qa-command-contract.js");
  // browser-dialog.js 가 unit.command 로 통과시키는 이름 중 일반 MCP 명령으로 막혀야 하는 것
  for (const name of ["redact", "qa-mode-off", "qa-mode"]) {
    assert.equal(workerHandlerFor(name) !== null && !ordinaryCommandDenied(name), false, name);
  }
});
