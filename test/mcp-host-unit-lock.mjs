import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserDialogHost,
  createHostIdentityAuthority,
  createMcpHostDispatcher,
  createMcpHostExecutionCoordinator,
  createMcpHostHandlers,
} from "../server/mcp-host/index.js";

const TOKEN = { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 메인 대역: 단위가 열려 있는 동안 단위 밖 명령은 단위 종료까지 기다림 (cdpQueues 와 같은 줄 서기)
function fixture({ unitIdleMs = 60, openDialog = null } = {}) {
  const log = [];
  let unitOpen = false;
  let unitClosed = null;
  const execute = async (_target, input) => {
    const { command, unit } = input.relay;
    if (unit) {
      if (!unitOpen) { unitOpen = true; unitClosed = Promise.withResolvers(); }
      log.push(`unit:${command}:${unit.phase}`);
      if (unit.phase === "last" || unit.phase === "end") { unitOpen = false; unitClosed.resolve(); }
      return { ok: true, data: command };
    }
    log.push(`legacy:${command}:start`);
    if (unitOpen) await unitClosed.promise;
    log.push(`legacy:${command}:end`);
    return { ok: true, data: command };
  };
  const execution = createMcpHostExecutionCoordinator();
  const dialog = createBrowserDialogHost({
    serial: execution.serial,
    unitIdleMs,
    resolveForCommand: async () => ({ tabId: "tab-1", targetToken: TOKEN }),
    execute,
    raceDialog: async (_target, pending) => pending,
    currentDialog: () => openDialog,
    redact: async (value) => value,
  });
  const ids = createHostIdentityAuthority();
  ids.allowSession("pane");
  const host = createMcpHostDispatcher({ workerGeneration: "boot:1", identityAuthority: ids, execution,
    handlers: createMcpHostHandlers({ browser: { executeWithDialog: dialog.executeWithDialog } }) });
  let sequence = 0;
  const call = (commandId, relay) => host.dispatch({
    protocol: 1, type: "host.request", requestId: `r${++sequence}`, workerGeneration: "boot:1",
    commandId, callId: sequence, operation: "browser.executeWithDialog", identity: { session: "pane" },
    input: { tabId: "tab-1", targetToken: TOKEN, relay },
  });
  return { log, call, execution, isOpen: () => unitOpen };
}

const withTimeout = (promise, ms, label) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} ${ms}ms 안에 끝나지 않음`)), ms))]);

test("단위 호출 사이에 들어온 다른 명령은 단위가 끝난 뒤에 실행되고 서로 기다리지 않는다", async () => {
  const f = fixture();
  await f.call("boot:1/a", { command: "wc.info", args: {}, unit: { command: "snapshot", phase: "run" } });
  const intruder = f.call("boot:1/legacy", { command: "click", args: {} });
  await tick(); await tick();
  assert.deepEqual(f.log, ["unit:wc.info:run"], "단위가 열려 있는 동안 옛 명령은 시작하지 않음");
  const second = await withTimeout(f.call("boot:1/a", { command: "cdp.send", args: {}, unit: { command: "snapshot", phase: "run" } }), 500, "2번째 호출");
  assert.equal(second.ok, true);
  const last = await withTimeout(f.call("boot:1/a", { command: "wc.info", args: {}, unit: { command: "snapshot", phase: "last" } }), 500, "마지막 호출");
  assert.equal(last.ok, true);
  assert.equal((await withTimeout(intruder, 500, "끼어든 명령")).ok, true);
  assert.deepEqual(f.log, ["unit:wc.info:run", "unit:cdp.send:run", "unit:wc.info:last", "legacy:click:start", "legacy:click:end"]);
  assert.equal(f.execution.serial.size(), 0, "잠금이 남지 않음");
});

test("명시 종료(end)와 유휴 만료는 단위가 쥔 탭 잠금을 놓는다", async () => {
  const f = fixture({ unitIdleMs: 40 });
  await f.call("boot:1/a", { command: "wc.info", args: {}, unit: { command: "x", phase: "run" } });
  assert.equal(f.execution.serial.size(), 1);
  await f.call("boot:1/a", { command: "unit.end", args: {}, unit: { command: "x", phase: "end" } });
  await tick();
  assert.equal(f.execution.serial.size(), 0, "end 뒤 잠금 해제");

  await f.call("boot:1/b", { command: "wc.info", args: {}, unit: { command: "x", phase: "run" } });
  assert.equal(f.execution.serial.size(), 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(f.execution.serial.size(), 0, "유휴 만료 뒤 잠금 해제");
});

test("단위 호출이 하나뿐(last)이어도 옛 명령과 서로 막지 않고 잠금을 남기지 않는다", async () => {
  const f = fixture();
  const one = await f.call("boot:1/a", { command: "wc.info", args: {}, unit: { command: "url", phase: "last" } });
  assert.equal(one.ok, true);
  assert.equal(f.execution.serial.size(), 0);
});

test("대기열 밖(outside) 단위 호출은 탭 잠금을 쥐지도 기다리지도 않아 막힌 단위 뒤에 서지 않는다", async () => {
  const f = fixture({ unitIdleMs: 500 });
  await f.call("boot:1/a", { command: "wc.info", args: {}, unit: { command: "upload", phase: "run" } });
  assert.equal(f.execution.serial.size(), 1, "일반 단위가 탭 잠금을 쥠");
  const outside = await withTimeout(f.call("boot:1/o", { command: "native.windowKey", args: {}, unit: { command: "nativekey", phase: "run", outside: true } }), 300, "outside 호출");
  assert.equal(outside.ok, true);
  const last = await withTimeout(f.call("boot:1/o", { command: "result.redact", args: {}, unit: { command: "nativekey", phase: "last", outside: true } }), 300, "outside 마지막");
  assert.equal(last.ok, true);
  assert.equal(f.execution.serial.size(), 1, "outside 호출이 잠금을 만들지도 풀지도 않음");
  await f.call("boot:1/a", { command: "unit.end", args: {}, unit: { command: "upload", phase: "end" } });
  await tick();
  assert.equal(f.execution.serial.size(), 0);
});

test("확인 창이 떠 있어도 dialog·dialogs 명령 단위의 모든 호출은 통과하고 다른 명령은 막힌다", async () => {
  const dialog = { kind: "confirm", message: "삭제할까요?", full: "삭제할까요?" };
  const f = fixture({ openDialog: dialog });
  for (const name of ["dialogs", "dialog"]) {
    for (const command of ["cdp.gate", "ai.enter", "viewport.ensureReady", "dialog.plan", "ai.leave", "result.redact"]) {
      const response = (await f.call(`boot:1/${name}`, { command, args: {}, unit: { command: name, phase: command === "result.redact" ? "last" : "run", outside: true } })).output;
      assert.equal(response.commandState, "completed", `${name} ${command}`);
      assert.equal(response.ok, true, `${name} ${command}`);
    }
  }
  for (const name of ["nativekey", "nativewin", "nativeclick", "dialoginfo", "login", "upload", "download", "click", "snapshot"]) {
    const response = (await f.call(`boot:1/${name}`, { command: "cdp.gate", args: {}, unit: { command: name, phase: "run", outside: name.startsWith("native") || name === "dialoginfo" } })).output;
    assert.equal(response.commandState, "blocked", name);
    assert.equal(response.dialogOpen.kind, "confirm", name);
    // 막힌 단위의 명시 종료는 통과
    const ended = (await f.call(`boot:1/${name}`, { command: "unit.end", args: {}, unit: { command: name, phase: "end", outside: name.startsWith("native") || name === "dialoginfo" } })).output;
    assert.equal(ended.commandState, "completed", `${name} end`);
  }
  assert.equal(f.execution.serial.size(), 0);
});
