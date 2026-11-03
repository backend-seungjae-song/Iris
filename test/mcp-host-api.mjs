import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBrowserDialogHost,
  createHostIdentityAuthority,
  createHostLeaseStore,
  createHostUserCoordinator,
  createMcpHostDispatcher,
  createMcpHostHandlers,
  HOST_OPERATION_NAMES,
} from "../server/mcp-host/index.js";
import * as hostApiModule from "../server/mcp-host/index.js";
import { readAppTargets } from "../server/app-targets.js";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const EXPECTED_OPERATIONS = [
  "browser.sessionView", "browser.targetGet", "browser.targetSet", "browser.targetClear", "browser.commandGuard",
  "browser.commandTargetState", "browser.resolveForCommand",
  "browser.tabCreate", "browser.tabWake", "browser.tabClose", "browser.status",
  "browser.promptTargetsActivate", "browser.pickRecord", "browser.pickList",
  "browser.executeWithDialog", "browser.dialogState", "browser.dialogAnswer", "browser.legacyHostTask", "qa.anchorUpdate",
  "qa.claimIfFree", "qa.releaseIfOwner", "qa.owner", "qa.tabCreate", "qa.tabsRestore",
  "qa.tabClose", "qa.tabsPublish", "qa.deviceAuthorize", "app.targetsGet", "app.targetsAll", "app.targetsSet",
  "app.command", "qa.askUser", "qa.reportOpen", "journal.sessionCommand", "journal.accept",
  "journal.complete", "journal.release", "journal.trace", "journal.recordFrame", "journal.surfaces", "lease.grant",
  "lease.check", "lease.revoke", "user.ask", "user.notify", "user.progress",
];

function authority(...bindings) {
  const value = createHostIdentityAuthority();
  for (const binding of bindings) {
    value.allowSession(binding.session);
    if (binding.run) value.bindRun(binding);
  }
  return value;
}

let sequence = 0;
function message(operation, identity = {}, input = {}, options = {}) {
  sequence += 1;
  return {
    protocol: 1,
    type: "host.request",
    requestId: options.requestId || `request-${sequence}`,
    workerGeneration: "boot:1",
    commandId: options.commandId || `command-${sequence}`,
    callId: options.callId || sequence,
    operation,
    identity,
    input,
  };
}

test("계약의 host API 연산을 모두 등록한다", () => {
  assert.deepEqual([...HOST_OPERATION_NAMES].sort(), [...EXPECTED_OPERATIONS].sort());
});

test("조건부 claim은 한 회차만 성공하고 session·run·교체된 key를 다시 검사한다", async () => {
  const ids = authority(
    { session: "pane-a", run: "run-a", key: "key-a" },
    { session: "pane-a", run: "run-b", key: "key-b" },
    { session: "pane-b", run: "run-c", key: "key-c" },
  );
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: createMcpHostHandlers() });
  const target = `tab-${Date.now()}-${Math.random()}`;
  const a = { session: "pane-a", run: "run-a", key: "key-a" };
  const b = { session: "pane-a", run: "run-b", key: "key-b" };
  const c = { session: "pane-b", run: "run-c", key: "key-c" };

  const claims = await Promise.all([
    host.dispatch(message("qa.claimIfFree", a, { target })),
    host.dispatch(message("qa.claimIfFree", b, { target })),
  ]);
  assert.equal(claims.filter((result) => result.ok).length, 1);
  assert.equal(claims.filter((result) => result.error?.code === "QA_OWNED").length, 1);

  const wrongRun = await host.dispatch(message("qa.releaseIfOwner", b, { target }));
  assert.equal(wrongRun.error.code, "RUN_DENIED");
  const wrongSession = await host.dispatch(message("qa.claimIfFree", c, { target }));
  assert.equal(wrongSession.error.code, "QA_OWNED");

  ids.rotateRunKey({ session: "pane-a", run: "run-a", key: "key-a-new" });
  const oldKey = await host.dispatch(message("qa.releaseIfOwner", a, { target }));
  assert.equal(oldKey.error.code, "KEY_DENIED");
  const forgedBrowser = await host.dispatch(message("browser.executeWithDialog", a,
    { tabId: target, targetToken: "forged", command: "click" }));
  assert.equal(forgedBrowser.error.code, "KEY_DENIED");
  const released = await host.dispatch(message("qa.releaseIfOwner",
    { ...a, key: "key-a-new" }, { target }));
  assert.equal(released.ok, true);
  assert.equal(released.output.released, true);
});

test("같은 run 식별자를 다른 session에 다시 결속하지 않는다", () => {
  const ids = createHostIdentityAuthority();
  ids.allowSession("pane-a");
  ids.allowSession("pane-b");
  ids.bindRun({ session: "pane-a", run: "shared-run", key: "key-a" });
  assert.throws(() => ids.bindRun({ session: "pane-b", run: "shared-run", key: "key-b" }),
    (error) => error.code === "RUN_DENIED");
});

test("회차 이어받기 후보 key는 지정한 상위 명령 안에서만 허용한다", () => {
  const ids = authority({ session: "pane", run: "run", key: "old" });
  ids.allowCandidate({ commandId: "resume", session: "pane", run: "run", key: "candidate" });
  assert.deepEqual(ids.authorize({ session: "pane", run: "run", key: "candidate" }, ["session", "run", "key"],
    { commandId: "resume" }), { session: "pane", run: "run" });
  assert.throws(() => ids.authorize({ session: "pane", run: "run", key: "candidate" }, ["session", "run", "key"],
    { commandId: "other" }), error => error.code === "KEY_DENIED");
  ids.clearCandidate("resume");
  assert.throws(() => ids.authorize({ session: "pane", run: "run", key: "candidate" }, ["session", "run", "key"],
    { commandId: "resume" }), error => error.code === "KEY_DENIED");
});

test("결속이 없는 run_resume 후보는 해당 명령과 session에서만 임시 권한을 받는다", async () => {
  const ids = createHostIdentityAuthority();
  ids.allowSession("pane-a");
  ids.allowSession("pane-b");
  ids.allowCandidate({ commandId: "boot:1/resume", session: "pane-a", run: "run-a", key: "temporary" });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: createMcpHostHandlers({ qa: { anchorUpdate: ({ identity }) => ({ session: identity.session, run: identity.run }) } }) });
  const allowed = await host.dispatch(message("qa.anchorUpdate",
    { session: "pane-a", run: "run-a", key: "temporary" }, { op: "read", runId: "run-a" }, { commandId: "boot:1/resume" }));
  assert.equal(allowed.ok, true, allowed.error?.message);
  const otherSession = await host.dispatch(message("qa.anchorUpdate",
    { session: "pane-b", run: "run-a", key: "temporary" }, { op: "read", runId: "run-a" }, { commandId: "boot:1/resume" }));
  assert.equal(otherSession.ok, false);
  assert.equal(otherSession.error.code, "RUN_DENIED");
  const otherCommand = await host.dispatch(message("qa.anchorUpdate",
    { session: "pane-a", run: "run-a", key: "temporary" }, { op: "read", runId: "run-a" }, { commandId: "boot:1/other" }));
  assert.equal(otherCommand.ok, false);
});

test("session 없는 target 조회·newtab·picks·app-targets-get은 원래 응답을 돌려준다", async () => {
  const ids = createHostIdentityAuthority();
  const handlers = createMcpHostHandlers({
    browser: {
      targetGet: () => ({ ok: true, data: { tabId: null } }),
      tabCreate: () => ({ ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음)." }),
      pickList: () => ({ ok: true, data: { count: 0, picks: [] } }),
    },
  });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, handlers });
  const target = await host.dispatch(message("browser.targetGet"));
  const created = await host.dispatch(message("browser.tabCreate"));
  const picks = await host.dispatch(message("browser.pickList", {}, { kind: "browser" }));
  const appTargets = await host.dispatch(message("app.targetsGet"));
  assert.equal(target.ok, true);
  assert.equal(created.ok, true);
  assert.equal(picks.ok, true);
  assert.equal(appTargets.ok, true);
  assert.equal(appTargets.output.ok, false);
  assert.match(appTargets.output.error, /세션을 알 수 없습니다/);
});

test("긴 app.command는 기기별로만 직렬화한다", async () => {
  const ids = authority({ session: "pane" });
  let active = 0, maxActive = 0;
  const handlers = createMcpHostHandlers({ app: { command: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { ok: true };
  } } });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, handlers });
  await Promise.all([
    host.dispatch(message("app.command", { session: "pane" }, { command: "open", device: "device-a" })),
    host.dispatch(message("app.command", { session: "pane" }, { command: "open", device: "device-b" })),
  ]);
  assert.equal(maxActive, 2);
});

test("host 실행 조정자는 worker 세대가 달라도 직렬 실행하고 세대 종료를 기다린다", async () => {
  assert.equal(typeof hostApiModule.createMcpHostExecutionCoordinator, "function");
  const coordinator = hostApiModule.createMcpHostExecutionCoordinator();
  let release;
  const first = coordinator.run("boot:1", ["device:a"], () => new Promise(resolve => { release = resolve; }));
  let secondStarted = false;
  const second = coordinator.run("boot:2", ["device:a"], async () => { secondStarted = true; });
  const waiting = coordinator.waitForGeneration("boot:1");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondStarted, false);
  release();
  await Promise.all([first, second, waiting]);
  assert.equal(secondStarted, true);
});

test("journal 임대는 worker 세대에 묶이고 세대 작업 종료 뒤 회수한다", async () => {
  const ids = authority({ session: "pane" });
  const handlers = createMcpHostHandlers();
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, handlers });
  const accepted = await host.dispatch(message("journal.accept", { session: "pane" }, { command: "url", args: {} }));
  assert.equal(accepted.ok, true, accepted.error?.message);
  const otherHost = createMcpHostDispatcher({ workerGeneration: "boot:2", identityAuthority: ids, handlers });
  const otherMessage = message("journal.recordFrame", { session: "pane" }, { runToken: accepted.output.runToken, phase: "before" });
  const otherFrame = await otherHost.dispatch({ ...otherMessage, workerGeneration: "boot:2" });
  assert.equal(otherFrame.error?.code, "STALE_WORKER");
  assert.equal(typeof handlers.releaseWorkerGeneration, "function");
  assert.equal(handlers.releaseWorkerGeneration("boot:2"), 0);
  assert.equal(handlers.releaseWorkerGeneration("boot:1"), 1);
});

test("종료된 세대의 대기 host 호출은 직렬 실행 전에 거절한다", async () => {
  const ids = authority({ session: "pane" });
  const handlers = createMcpHostHandlers();
  const coordinator = hostApiModule.createMcpHostExecutionCoordinator();
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers, execution: coordinator });
  let releaseBlocker;
  const blocker = coordinator.run("blocker", ["session:pane"], () => new Promise(resolve => { releaseBlocker = resolve; }));
  const queued = host.dispatch(message("journal.accept", { session: "pane" }, { command: "url", args: {} }));
  await new Promise(resolve => setImmediate(resolve));

  host.retire(() => handlers.releaseWorkerGeneration("boot:1"));
  releaseBlocker();
  await blocker;
  const result = await queued;

  assert.equal(result.error?.code, "STALE_WORKER");
  assert.equal(handlers.releaseWorkerGeneration("boot:1"), 0);
});

test("종료 뒤 늦게 끝난 host 호출이 만든 journal token도 다시 회수한다", async () => {
  const ids = authority({ session: "pane" });
  const baseHandlers = createMcpHostHandlers();
  let releaseHandler;
  const handlerGate = new Promise(resolve => { releaseHandler = resolve; });
  const handlers = { ...baseHandlers,
    "journal.accept": async context => { await handlerGate; return baseHandlers["journal.accept"](context); } };
  const coordinator = hostApiModule.createMcpHostExecutionCoordinator();
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers, execution: coordinator });
  const running = host.dispatch(message("journal.accept", { session: "pane" }, { command: "url", args: {} }));
  await new Promise(resolve => setImmediate(resolve));
  let cleanupCalls = 0;

  host.retire(() => {
    cleanupCalls += 1;
    baseHandlers.releaseWorkerGeneration("boot:1");
  });
  releaseHandler();
  const result = await running;

  assert.equal(result.ok, true, result.error?.message);
  assert.ok(cleanupCalls >= 2);
  assert.equal(baseHandlers.releaseWorkerGeneration("boot:1"), 0);
});

test("회차 없는 summary와 catalog 승인 연산은 session 권한으로 호출한다", async () => {
  const ids = authority({ session: "pane-summary" });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: {
      "qa.askUser": ({ identity }) => ({ session: identity.session, approved: false }),
      "qa.reportOpen": ({ identity }) => ({ session: identity.session, opened: true }),
    } });
  const identity = { session: "pane-summary" };
  const asked = await host.dispatch(message("qa.askUser", identity, { message: "승인할까요?" }));
  const opened = await host.dispatch(message("qa.reportOpen", identity, { url: "file:///report.html" }));
  assert.deepEqual(asked.output, { session: "pane-summary", approved: false });
  assert.deepEqual(opened.output, { session: "pane-summary", opened: true });
});

test("대기 중 key가 바뀌면 임계 구역에 들어갈 때 옛 key를 거부한다", async () => {
  const ids = authority({ session: "pane", run: "run", key: "old-key" });
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: { "lease.grant": async () => { calls += 1; if (calls === 1) await gate; return { calls }; } } });
  const identity = { session: "pane", run: "run", key: "old-key" };
  const first = host.dispatch(message("lease.grant", identity, { executor: "one", scope: ["read"], ttlMs: 1000 }));
  await Promise.resolve();
  const second = host.dispatch(message("lease.grant", identity, { executor: "two", scope: ["read"], ttlMs: 1000 }));
  ids.rotateRunKey({ session: "pane", run: "run", key: "new-key" });
  releaseFirst();

  assert.equal((await first).ok, true);
  assert.equal((await second).error.code, "KEY_DENIED");
  assert.equal(calls, 1);
});

test("같은 부수효과 요청은 완료 결과를 돌려주고 다시 실행하지 않는다", async () => {
  const ids = authority({ session: "pane" });
  let calls = 0;
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: { "user.notify": () => ({ calls: ++calls }) } });
  const firstMessage = message("user.notify", { session: "pane" }, { title: "알림" }, { commandId: "same" });
  const first = await host.dispatch(firstMessage);
  const retried = await host.dispatch({ ...firstMessage, requestId: "retry" });
  assert.equal(first.output.calls, 1);
  assert.equal(retried.output.calls, 1);
  assert.equal(calls, 1);
});

test("한 상위 명령 안의 같은 연산도 하위 호출 번호가 다르면 각각 실행한다", async () => {
  const ids = authority({ session: "pane" });
  let calls = 0;
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: { "user.notify": () => ({ calls: ++calls }) } });
  const first = message("user.notify", { session: "pane" }, { title: "알림" }, { commandId: "same", callId: 1 });
  const second = { ...first, requestId: "second", callId: 2 };
  assert.equal((await host.dispatch(first)).output.calls, 1);
  assert.equal((await host.dispatch(second)).output.calls, 2);
  assert.equal(calls, 2);
});

test("완료한 명령도 key 교체 뒤 옛 key로 조회하지 못하고 새 key에는 완료 결과를 돌려준다", async () => {
  const ids = authority({ session: "pane", run: "run", key: "old" });
  let calls = 0;
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: { "lease.grant": () => ({ calls: ++calls }) } });
  const original = message("lease.grant", { session: "pane", run: "run", key: "old" },
    { executor: "runner", scope: ["read"], ttlMs: 1000 }, { commandId: "lease-command" });
  assert.equal((await host.dispatch(original)).output.calls, 1);
  ids.rotateRunKey({ session: "pane", run: "run", key: "new" });
  const denied = await host.dispatch({ ...original, requestId: "old-retry" });
  assert.equal(denied.error.code, "KEY_DENIED");
  const resumed = await host.dispatch({ ...original, requestId: "new-retry",
    identity: { ...original.identity, key: "new" } });
  assert.equal(resumed.output.calls, 1);
  assert.equal(calls, 1);
});

test("lease는 session·run·범위와 만료를 함께 검사한다", async () => {
  let now = 1000;
  const ids = authority(
    { session: "pane", run: "run-a", key: "key-a" },
    { session: "pane", run: "run-b", key: "key-b" },
  );
  const lease = createHostLeaseStore({ now: () => now });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: createMcpHostHandlers({ lease }) });
  const a = { session: "pane", run: "run-a", key: "key-a" };
  const b = { session: "pane", run: "run-b", key: "key-b" };
  const granted = await host.dispatch(message("lease.grant", a,
    { executor: "runner", scope: ["capture", "input"], expiresAt: 2000 }));
  assert.equal(granted.ok, true);
  const leaseId = granted.output.leaseId;
  const checked = await host.dispatch(message("lease.check", a, { leaseId, scope: ["capture"] }));
  assert.deepEqual(checked.output.allowed, ["capture"]);
  const otherRun = await host.dispatch(message("lease.check", b, { leaseId, scope: ["capture"] }));
  assert.equal(otherRun.error.code, "RUN_DENIED");
  now = 2001;
  const expired = await host.dispatch(message("lease.check", a, { leaseId, scope: ["capture"] }));
  assert.equal(expired.error.code, "NOT_FOUND");
});

test("app-targets 전체 갱신은 한 번에 하나씩 실행되어 다른 세션의 값을 보존한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-host-targets-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const ids = authority({ session: "pane-a" }, { session: "pane-b" });
  let active = 0;
  let maxActive = 0;
  const handlers = createMcpHostHandlers({ appTargetOptions: { stateDir }, app: {
    afterTargetsSet: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  } });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, handlers });

  const results = await Promise.all([
    host.dispatch(message("app.targetsSet", { session: "pane-a" }, { devices: ["device-a"] })),
    host.dispatch(message("app.targetsSet", { session: "pane-b" }, { devices: ["device-b"] })),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(maxActive, 1);
  assert.deepEqual(readAppTargets({ stateDir }), { "pane-a": ["device-a"], "pane-b": ["device-b"] });
  assert.deepEqual(results.map(result => result.output.data.devices), [["device-a"], ["device-b"]]);
});

test("확인창 경쟁 결과는 원문을 가린 뒤 full 없이 반환하고 원래 명령을 추적한다", async () => {
  const dialog = { kind: "prompt", message: "앞부분 TOKEN-1" };
  Object.defineProperty(dialog, "full", { value: "앞부분 TOKEN-123456789 뒷부분", enumerable: false });
  const redacted = [];
  const pending = new Promise(() => {});
  const browser = createBrowserDialogHost({
    resolveForCommand: async () => ({ tabId: "tab-1", wc: 7,
      targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } }),
    execute: () => pending,
    raceDialog: async () => ({ ok: false, dialogOpen: dialog }),
    redact: async (source) => { redacted.push(source); return source.replace("TOKEN-123456789", "[가림]"); },
  });
  const result = await browser.executeWithDialog({
    identity: { session: "pane", run: "run" },
    input: { tabId: "tab-1", targetToken: { debuggerGeneration: 3, documentGeneration: 2, wcId: 7 },
      command: "click", args: {}, answerTool: "browser_dialog" },
    request: { commandId: "dialog-command" },
  });

  assert.deepEqual(redacted, ["앞부분 TOKEN-123456789 뒷부분"]);
  assert.equal(result.commandState, "running");
  assert.equal(result.dialogOpen.message, "앞부분 [가림] 뒷부분");
  assert.equal(JSON.stringify(result).includes("TOKEN-123456789"), false);
  assert.equal(browser.commandState("dialog-command").state, "running");
  await assert.rejects(() => browser.executeWithDialog({
    identity: { session: "pane", run: "run" },
    input: { tabId: "tab-1", targetToken: { wcId: 7, documentGeneration: 1, debuggerGeneration: 3 },
      command: "click", args: {} },
    request: { commandId: "stale-target-command" },
  }), (error) => error.code === "STALE_TARGET");
});

test("열린 확인창은 기본 중계 명령 dialog.answer와 dialog.plan을 차단하지 않는다", async () => {
  const executed = [];
  const browser = createBrowserDialogHost({
    resolveForCommand: async () => ({ tabId: "tab-1",
      targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } }),
    execute: async (_target, input) => { executed.push(input.relay.command); return { ok: true, data: input.relay.command }; },
    raceDialog: async (_target, pending) => pending,
    currentDialog: () => ({ kind: "confirm", message: "계속할까요?" }),
    redact: async value => value,
  });
  const base = { tabId: "tab-1", targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } };

  for (const command of ["dialog.answer", "dialog.plan"]) {
    const result = await browser.executeWithDialog({ identity: { session: "pane", run: "run" },
      input: { ...base, relay: { command, args: {} } }, request: { commandId: `dialog-${command}`, callId: 1 } });
    assert.equal(result.ok, true);
    assert.equal(result.commandState, "completed");
  }
  const blocked = await browser.executeWithDialog({ identity: { session: "pane", run: "run" },
    input: { ...base, relay: { command: "wc.exec", args: {} } }, request: { commandId: "dialog-blocked", callId: 1 } });
  assert.equal(blocked.commandState, "blocked");
  assert.deepEqual(executed, ["dialog.answer", "dialog.plan"]);
});

test("ask 대기열은 requestId를 session·run에 묶고 답을 한 요청에만 보관한다", async () => {
  const ids = authority(
    { session: "pane", run: "run-a", key: "key-a" },
    { session: "pane", run: "run-b", key: "key-b" },
  );
  const user = createHostUserCoordinator();
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids,
    handlers: createMcpHostHandlers({ user }) });
  const input = { requestId: "ask-1", tab: "tab-1", message: "계속할까요?", choices: ["예", "아니요"] };
  const a = { session: "pane", run: "run-a", key: "key-a" };
  const b = { session: "pane", run: "run-b", key: "key-b" };

  const pending = await host.dispatch(message("qa.askUser", a, input));
  assert.deepEqual(pending.output, { requestId: "ask-1", pending: true });
  assert.equal(user.pending().length, 1);
  assert.equal(user.answer("ask-1", "예"), true);
  assert.equal(user.answer("ask-1", "아니요"), false);
  const answered = await host.dispatch(message("qa.askUser", a, input));
  assert.deepEqual(answered.output, { requestId: "ask-1", pending: false, answer: "예" });
  const otherRun = await host.dispatch(message("qa.askUser", b, input));
  assert.equal(otherRun.error.code, "RUN_DENIED");
});

test("QA 탭 생성 연산은 같은 회차에서 직렬 실행되고 identity 검사가 생성보다 먼저 끝난다", async () => {
  const ids = authority({ session: "pane", run: "run", key: "key" });
  let active = 0;
  let maxActive = 0;
  let created = 0;
  const handlers = createMcpHostHandlers({ qa: {
    tabCreate: async ({ identity }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      created += 1;
      active -= 1;
      return { tabId: `tab-${created}`, owner: identity.run };
    },
  } });
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, handlers });
  const valid = { session: "pane", run: "run", key: "key" };
  const denied = await host.dispatch(message("qa.tabCreate", { ...valid, key: "wrong" }, { url: "https://example.test" }));
  assert.equal(denied.error.code, "KEY_DENIED");
  assert.equal(created, 0);

  const results = await Promise.all([
    host.dispatch(message("qa.tabCreate", valid, { url: "https://example.test/a" })),
    host.dispatch(message("qa.tabCreate", valid, { url: "https://example.test/b" })),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((result) => result.output.owner), ["run", "run"]);
});

test("현재 서버 QA 탭 연산은 상태 생성 뒤 claim하고 그 뒤에 broadcast한다", () => {
  const commands = fs.readFileSync(new URL("../server/browser-commands.js", import.meta.url), "utf8");
  const createStart = commands.indexOf("function createTabForSession");
  const createEnd = commands.indexOf("export async function createQaEntry", createStart);
  const createBody = commands.slice(createStart, createEnd);
  const mutateAt = createBody.indexOf("bsMutate({ op: \"tab.open\"");
  const claimAt = createBody.indexOf("claimQaTab(id, qaRunId)");
  const broadcastAt = createBody.indexOf("broadcast({ type: \"browser-state\"");
  assert.ok(mutateAt >= 0 && mutateAt < claimAt && claimAt < broadcastAt);

  const adapter = fs.readFileSync(new URL("../server/mcp-host/current-server.js", import.meta.url), "utf8");
  const qaPorts = sliceBetween(adapter, "const qa = {", "const app = {", "현재 서버 QA port");
  assert.match(qaPorts, /tabCreate: async \(\{ identity, input \}\) => \{[\s\S]*?createQaEntry\(identity\.session, input\.url, identity\.run\)/);
});
