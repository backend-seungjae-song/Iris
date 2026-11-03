import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { HOST_OPERATION_NAMES } from "../server/mcp-host/operations.js";
import { createWorkerBrowserService } from "../server/mcp-worker/browser-service.js";
import { INTERNAL_HOST_API_COMMANDS, INTERNAL_RELAY_COMMANDS } from "../server/mcp-worker/relay-contract.js";

const require = createRequire(import.meta.url);
const { BASE_COMMANDS } = require("../native/electron/relay/index.cjs");

test("일반 MCP 이름으로 중계 기본 명령과 host API를 직접 호출할 수 없다", async () => {
  const calls = [];
  const service = createWorkerBrowserService({
    hostApi: { withCommand: (_command, run) => run(), call: async operation => { calls.push(operation); return {}; } },
    activity: { run: (_kind, _id, run) => run() },
  });
  assert.deepEqual([...INTERNAL_HOST_API_COMMANDS].sort(), [...HOST_OPERATION_NAMES].sort());
  assert.deepEqual([...INTERNAL_RELAY_COMMANDS].sort(), [...BASE_COMMANDS].sort());
  for (const command of [...INTERNAL_RELAY_COMMANDS, ...INTERNAL_HOST_API_COMMANDS]) {
    const result = await service.dispatch({ command, identity: { session: "pane" }, commandId: `command/${command}` });
    assert.equal(result.ok, false, command);
    assert.match(result.error, /내부 명령/);
  }
  assert.deepEqual([...new Set(calls)], ["journal.accept"]);
});

test("검토 1-A의 상태 없는 명령은 eb90977 응답 형태를 유지한다", async () => {
  let identity = null;
  const outputs = {
    "browser.sessionView": { ok: true, data: { tabs: ["tab-a"] } },
    "browser.targetGet": { ok: true, data: { session: "pane", tabId: "tab-a", handle: "@a", pinned: true, pinnedAll: ["@a"], tab: {}, pending: false } },
    "browser.targetSet": { ok: true, data: { handle: "@a" } },
    "browser.targetClear": { ok: true, data: { pinnedAll: [] } },
    "browser.promptTargetsActivate": { ok: true, data: { activated: [] } },
    "browser.pickList": { ok: true, data: { picks: [] } },
    "app.targetsGet": { ok: true, data: { session: "pane", devices: [] } },
    "app.targetsSet": { ok: true, data: { session: "pane", devices: [] } },
    "browser.tabCreate": { ok: true, data: { handle: "@new", tabId: "new" } },
    "browser.tabClose": { ok: true, data: { closed: "@a", remaining: [] } },
    "journal.sessionCommand": { ok: true, data: { count: 0, items: [] } },
  };
  const hostApi = {
    withCommand: (command, run) => { identity = command.identity; return run(); },
    call: async (operation, input) => {
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "user.ask") return { question: input.message, choices: input.choices, approved: false };
      if (operation === "user.notify") return { id: "notice", shown: "app" };
      if (operation === "user.progress") return { id: "progress" };
      if (operation === "app.command") {
        if (input.command === "list") return { ok: true, data: { tabs: [{ udid: "device" }] } };
        if (input.command === "viewport") return { ok: true, data: { current: "phone" } };
        return { ok: true, data: { udid: "device" } };
      }
      return outputs[operation];
    },
  };
  const service = createWorkerBrowserService({ hostApi, activity: { run: (_kind, _id, run) => run() } });
  const run = (command, args = {}, session = "pane") => service.dispatch({ command, args,
    identity: session == null ? {} : { session }, commandId: `table/${command}` });
  const cases = [
    ["tabs", {}, { tabs: ["tab-a"] }], ["target", {}, outputs["browser.targetGet"].data],
    ["target", { tab: "@a" }, { handle: "@a" }], ["untarget", {}, { pinnedAll: [] }],
    ["prompt-targets", { markers: [] }, { activated: [] }], ["picks", {}, { picks: [] }],
    ["app-picks", {}, { picks: [] }], ["app-targets-get", {}, { session: "pane", devices: [] }],
    ["app-targets-set", { devices: [] }, { session: "pane", devices: [] }],
    ["newtab", {}, { handle: "@new", tabId: "new" }], ["closetab", { tab: "@a" }, { closed: "@a", remaining: [] }],
    ["trace", {}, { count: 0, items: [] }], ["app-devices", {}, { tabs: [{ udid: "device" }] }],
    ["app-viewport", {}, { current: "phone" }], ["app-open", {}, { udid: "device" }],
    ["notify", { level: "info", title: "알림" }, { id: "notice", shown: "app" }],
    ["progress", { op: "start", title: "진행" }, { id: "progress" }],
  ];
  for (const [command, args, expected] of cases) {
    const result = await run(command, args);
    assert.equal(result.ok, true, command);
    assert.deepEqual(result.data, expected, command);
  }
  const ask = await run("ask", { message: "  질문  ", choices: ["예", "아니요"] }, null);
  assert.deepEqual(ask.data, { question: "질문", choices: ["예", "아니요"], approved: false });
  const approve = await run("approve", { summary: "  승인  ", approve_label: "진행", deny_label: "중지" }, null);
  assert.deepEqual(approve.data, { question: "승인", choices: ["진행", "중지"], approved: false });
  assert.equal((await run("ask", { message: " " }, null)).error, "message를 적어 주세요.");
  assert.equal((await run("approve", { summary: " " }, null)).error, "summary를 적어 주세요.");
  assert.deepEqual(identity, {});
});

test("검토 1-A의 대상·dialog·재시도 행은 기존 오류와 data를 통과시킨다", async () => {
  const calls = [];
  let stateMode = "gone";
  const service = createWorkerBrowserService({
    hostApi: {
      withCommand: (_command, run) => run(),
      call: async (operation, input) => {
        calls.push([operation, input]);
        if (operation === "journal.accept") return {};
        if (operation === "browser.commandGuard") return { qaOwned: false };
        if (operation === "browser.commandTargetState") {
          if (stateMode === "gone") return { response: { ok: false,
            error: "브라우저 제어기(앱)가 연결 안 됨 — Iris 앱을 실행하세요(pnpm app).", sent: false, appGone: true } };
          if (stateMode === "missing") return { response: { ok: false,
            error: "그런 탭 핸들이 없습니다: @missing.", data: { tabs: ["@a"] } } };
          return { target: { tabId: "tab-a", targetToken: { wcId: 1 }, tab: { url: "https://e2e.test/" } } };
        }
        if (operation === "browser.dialogAnswer") return { ok: true, data: { none: true, note: "떠 있는 확인 창이 없습니다." } };
        if (operation === "browser.executeWithDialog") return input.relay.command === "dialogs"
          ? { ok: true, data: { dialogs: [] } } : { ok: false, error: "fixture selector missing" };
        if (operation === "journal.trace") return {};
        throw new Error(operation);
      },
    },
    activity: { run: (_kind, _id, run) => run() },
  });
  const dispatch = (command, args = {}) => service.dispatch({ command, args,
    identity: { session: "pane" }, commandId: `edge/${command}/${calls.length}` });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => nativeSetTimeout(fn, 0, ...args);
  try {
    const gone = await dispatch("url");
    assert.equal(gone.error, "브라우저 제어기(앱)가 연결 안 됨 — Iris 앱을 실행하세요(pnpm app). (13회 시도)");
    assert.equal(gone.sent, false);
    assert.equal(gone.appGone, true);
    stateMode = "missing";
    const missing = await dispatch("url", { tab: "@missing" });
    assert.deepEqual(missing, { ok: false, error: "그런 탭 핸들이 없습니다: @missing.", data: { tabs: ["@a"] } });
    stateMode = "target";
    const dialog = await dispatch("dialog", { answer: "cancel" });
    assert.deepEqual(dialog.data, { none: true, note: "떠 있는 확인 창이 없습니다." });
    const dialogs = await dispatch("dialogs");
    assert.deepEqual(dialogs.data, { dialogs: [] });
    assert.equal(calls.filter(([operation]) => operation === "browser.executeWithDialog").length, 1);
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("대기 이유가 바뀌면 그 이유의 첫 재시도부터 센다", async () => {
  const states = [
    ...Array.from({ length: 4 }, () => ({ response: { ok: false, error: "앱 없음", sent: false, appGone: true } })),
    { response: { ok: false, error: "탭 복원 중", sent: false } },
    { target: { tabId: "tab-a", targetToken: { wcId: 1 }, tab: { url: "https://e2e.test/" } } },
  ];
  let targets = 0;
  const service = createWorkerBrowserService({
    hostApi: {
      withCommand: (_command, run) => run(),
      call: async operation => {
        if (operation === "journal.accept" || operation === "journal.trace") return {};
        if (operation === "browser.commandTargetState") return states[targets++];
        if (operation === "browser.executeWithDialog") return { ok: true, data: { url: "https://e2e.test/" } };
        throw new Error(operation);
      },
    },
    activity: { run: (_kind, _id, run) => run() },
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => nativeSetTimeout(fn, 0, ...args);
  try {
    const result = await service.dispatch({ command: "url", identity: { session: "pane" }, commandId: "reason-change" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.retried, 5);
    assert.equal(targets, 6);
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("회차 조작은 accepted 뒤 직전 프레임을 남기고 같은 token으로 완료한다", async () => {
  const calls = [];
  const runToken = { id: "run-token", run: "run-a" };
  const service = createWorkerBrowserService({
    hostApi: {
      withCommand: (_command, run) => run(),
      call: async (operation, input) => {
        calls.push([operation, input]);
        if (operation === "journal.accept") return { callId: "c1", runToken, captureFrames: true };
        if (operation === "journal.recordFrame" || operation === "journal.trace" || operation === "journal.complete" || operation === "journal.release") return {};
        if (operation === "browser.commandGuard") return { qaOwned: false };
        if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: { wcId: 1 }, tab: {} } };
        if (operation === "browser.executeWithDialog") return { ok: true, data: { clicked: true } };
        throw new Error(operation);
      },
    },
    activity: { run: (_kind, _id, run) => run() },
  });
  const result = await service.dispatch({ command: "click", args: { tab: "tab-a", ref: "button" },
    identity: { session: "pane", run: "run-a", key: "key" }, commandId: "journal-order" });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.map(([operation, input]) => `${operation}${input?.phase ? `:${input.phase}` : ""}`), [
    "journal.accept", "journal.recordFrame:before", "browser.commandGuard", "browser.commandTargetState",
    // click 은 worker 경로라 메인 기능을 먼저 조회 · 조회가 실패하면 옛 봉투
    "browser.status", "browser.executeWithDialog", "journal.trace", "journal.complete", "journal.recordFrame:after", "journal.release",
  ]);
  const completed = calls.find(([operation]) => operation === "journal.complete")[1];
  assert.deepEqual(completed.runToken, runToken);
});

test("알림·진행·승인은 QA 소유 탭을 검사한 뒤 한 번만 실행한다", async () => {
  for (const command of ["notify", "progress", "approve"]) {
    const calls = [];
    const service = createWorkerBrowserService({
      hostApi: {
        withCommand: (_command, run) => run(),
        call: async (operation, input) => {
          calls.push([operation, input]);
          if (["journal.accept", "journal.complete", "journal.release", "journal.trace"].includes(operation)) return {};
          if (operation === "browser.commandGuard") return { qaOwned: input.tabRef === "qa-tab" };
          if (operation === "user.notify" || operation === "user.progress") return { id: operation };
          if (operation === "user.ask") return { approved: false };
          throw new Error(operation);
        },
      },
      activity: { run: (_kind, _id, run) => run() },
    });
    const args = command === "approve"
      ? { tab: "normal-tab,qa-tab", summary: "승인" } : { tab: "normal-tab,qa-tab", title: "상태" };
    const denied = await service.dispatch({ command, args, identity: { session: "pane" }, commandId: `guard/${command}` });
    assert.equal(denied.ok, false, command);
    assert.match(denied.error, /QA 회차/, command);
    assert.equal(calls.filter(([operation]) => ["user.notify", "user.progress", "user.ask"].includes(operation)).length, 0, command);
  }
});

test("다중 대상은 탭별 QA 소유권을 검사하고 부분 성공 결과를 한 번 기록한다", async () => {
  const calls = [];
  const service = createWorkerBrowserService({
    hostApi: {
      withCommand: (_command, run) => run(),
      call: async (operation, input) => {
        calls.push([operation, input]);
        if (operation === "journal.accept" || operation === "journal.complete" || operation === "journal.release") return {};
        if (operation === "journal.trace") return {};
        if (operation === "browser.commandGuard") return { qaOwned: input.tabRef === "qa-tab" };
        if (operation === "browser.tabClose") return { ok: true, data: { closed: input.tabRef } };
        if (operation === "browser.commandTargetState") {
          return { target: { tabId: input.tabRef, targetToken: { wcId: input.tabRef }, tab: {} } };
        }
        if (operation === "browser.executeWithDialog") return { ok: true, data: { clicked: input.tabId } };
        throw new Error(operation);
      },
    },
    activity: { run: (_kind, _id, run) => run() },
  });

  const denied = await service.dispatch({ command: "closetab", args: { tab: "qa-tab,normal-tab" },
    identity: { session: "pane" }, commandId: "multi/denied" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /QA 회차/);
  assert.equal(denied.multi, true);
  assert.equal(denied.okCount, 1);
  assert.deepEqual(denied.targets.map(({ tab, ok }) => ({ tab, ok })), [
    { tab: "qa-tab", ok: false },
    { tab: "normal-tab", ok: true },
  ]);
  assert.deepEqual(calls.filter(([operation]) => operation === "browser.tabClose").map(([, input]) => input.tabRef), ["normal-tab"]);

  calls.length = 0;
  const clicked = await service.dispatch({ command: "click", args: { tab: "normal-a,normal-b" },
    identity: { session: "pane" }, commandId: "multi/traced" });
  assert.equal(clicked.ok, true, clicked.error);
  assert.equal(clicked.multi, true);
  const traces = calls.filter(([operation]) => operation === "journal.trace");
  assert.equal(traces.length, 1);
  assert.equal(traces[0][1].result.multi, true);
  assert.equal(traces[0][1].result.targets.length, 2);
});
