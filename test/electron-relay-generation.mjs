import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createElectronRelay } = require("../native/electron/relay/index.cjs");

function relayFixture() {
  return createElectronRelay({
    webContents: { fromId: () => null },
    targetState: { generations: () => ({}), ownsChildSession: () => false },
    currentUrl: () => "",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    qaAnchor: async () => ({ ok: true, data: { accepted: true } }),
  });
}

test("빈 명령·하위 호출 식별자와 종료된 worker 세대 재등록을 거부한다", async () => {
  const relay = relayFixture();
  await relay.acceptGeneration("boot:1");
  const request = (commandId, callId) => relay.execute({
    workerGeneration: "boot:1",
    commandId,
    callId,
    command: "qa.anchor",
    args: { run: "run-1", runId: "run-1" },
  });

  await assert.rejects(() => request("boot:1/", "1"), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => request("boot:1/1", ""), (error) => error.code === "INVALID_REQUEST");
  await relay.retireGeneration("boot:1");
  await assert.rejects(() => relay.acceptGeneration("boot:1"), (error) => error.code === "STALE_WORKER");
});

test("서버 boot id가 바뀌면 이전 owner를 회수하고 새 첫 세대를 받는다", async () => {
  const relay = relayFixture();
  await relay.acceptGeneration("bootA:1");

  const accepted = await relay.acceptGeneration("bootB:1");

  assert.deepEqual(accepted, { accepted: true, workerGeneration: "bootB:1" });
  assert.deepEqual(relay.state(), { workerGeneration: "bootB:1", state: "accepting", active: 0 });
});

test("request 메타가 없는 relay 호출은 TypeError 대신 계약 오류를 돌려준다", async () => {
  const relay = relayFixture();
  await assert.rejects(() => relay.execute(), (error) => {
    assert.notEqual(error?.name, "TypeError");
    assert.equal(error?.code, "STALE_WORKER");
    assert.match(String(error?.message || ""), /작업 프로세스 세대/);
    return true;
  });
});

test("lifecycle commandId 오류는 worker 세대 접두 형식을 알려 준다", async () => {
  const relay = relayFixture();
  await relay.acceptGeneration("boot:1");
  const execute = (commandId) => relay.execute({
    workerGeneration: "boot:1",
    commandId,
    callId: "1",
    command: "qa.anchor",
    args: { run: "run-1", runId: "run-1" },
  });

  await assert.rejects(() => execute("lifecycle/run-1/id-1"), (error) => {
    assert.equal(error.code, "INVALID_REQUEST");
    assert.match(error.message, /<workerGeneration>\/lifecycle\/<run>\/<uuid>/);
    return true;
  });
  assert.deepEqual(await execute("boot:1/lifecycle/run-1/id-1"), { accepted: true });
});

test("자원 반환 실패는 새 worker 세대를 막고 같은 retire 재시도로 복구한다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let releaseFails = true;
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (!on && releaseFails) throw new Error("release failed");
      return true;
    },
  });
  await relay.acceptGeneration("boot:1");
  await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });

  await assert.rejects(() => relay.retireGeneration("boot:1"), (error) => error.code === "RESOURCE_RELEASE_FAILED");
  await assert.rejects(() => relay.acceptGeneration("boot:2"), (error) => error.code === "BUSY");
  releaseFails = false;
  await relay.retireGeneration("boot:1");
  assert.deepEqual(relay.state(), { workerGeneration: "boot:1", state: "retired", active: 0 });
  await relay.acceptGeneration("boot:2");
  assert.deepEqual(relay.state(), { workerGeneration: "boot:2", state: "accepting", active: 0 });
});

test("서버 재연결의 자원 회수 실패는 다음 등록에서 같은 retire를 재시도한다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let releaseFails = true;
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (!on && releaseFails) throw new Error("release failed");
      return true;
    },
  });
  await relay.acceptGeneration("bootA:1", { socket: 1 });
  await relay.execute({
    workerGeneration: "bootA:1",
    commandId: "bootA:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });

  await assert.rejects(() => relay.acceptGeneration("bootB:1", { socket: 2 }),
    (error) => error.code === "RESOURCE_RELEASE_FAILED");
  releaseFails = false;
  assert.deepEqual(await relay.acceptGeneration("bootB:1", { socket: 2 }),
    { accepted: true, workerGeneration: "bootB:1" });
  assert.deepEqual(relay.state(), { workerGeneration: "bootB:1", state: "accepting", active: 0 });
});

test("force retire는 실패 자원을 leftovers로 남기고 새 세대 accept 때 다시 반환한다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let releaseFails = true;
  let releaseAttempts = 0;
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (!on) {
        releaseAttempts++;
        if (releaseFails) throw new Error("release failed");
      }
      return true;
    },
  });
  await relay.acceptGeneration("boot:1");
  await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });

  const forced = await relay.retireGeneration("boot:1", { force: true });
  assert.equal(forced.forced, true);
  assert.deepEqual(forced.leftovers, ["capture-hold:7"]);
  assert.deepEqual(relay.state(), { workerGeneration: "boot:1", state: "retired", active: 0 });

  releaseFails = false;
  await relay.acceptGeneration("boot:2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseAttempts, 2);
  assert.deepEqual(relay.state(), { workerGeneration: "boot:2", state: "accepting", active: 0 });
});

test("takeover는 멈춘 반환을 기다리지 않고 같은 boot의 새 세대를 받는다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let releaseCalls = 0;
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (!on) {
        releaseCalls++;
        return new Promise(() => {});
      }
      return true;
    },
    resourceReleaseTimeoutMs: 20,
  });
  await relay.acceptGeneration("boot:1");
  await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });

  const accepted = await relay.acceptGeneration("boot:2", null, { takeover: true });

  assert.deepEqual(accepted, { accepted: true, workerGeneration: "boot:2", takeover: true });
  assert.deepEqual(relay.state(), { workerGeneration: "boot:2", state: "accepting", active: 0 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(releaseCalls, 1);
  await assert.rejects(() => relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/2",
    callId: "1",
    command: "qa.anchor",
    args: { run: "run-1", runId: "run-1" },
  }), (error) => error.code === "STALE_WORKER");
});

test("takeover는 반환 중인 같은 boot 세대도 기다리지 않는다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => on ? true : new Promise(() => {}),
    resourceReleaseTimeoutMs: 20,
  });
  await relay.acceptGeneration("boot:1");
  await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });
  const retiring = relay.retireGeneration("boot:1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relay.state(), { workerGeneration: "boot:1", state: "retiring", active: 0 });

  await relay.acceptGeneration("boot:2", null, { takeover: true });

  assert.deepEqual(relay.state(), { workerGeneration: "boot:2", state: "accepting", active: 0 });
  await retiring;
});

test("force retire는 멈춘 반환을 기다리지 않고 leftovers를 보고한다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => on ? true : new Promise(() => {}),
    resourceReleaseTimeoutMs: 20,
  });
  await relay.acceptGeneration("boot:1");
  await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });

  const retired = await relay.retireGeneration("boot:1", { force: true });

  assert.equal(retired.forced, true);
  assert.deepEqual(retired.leftovers, ["capture-hold:7"]);
  await relay.acceptGeneration("boot:2");
  assert.deepEqual(relay.state(), { workerGeneration: "boot:2", state: "accepting", active: 0 });
});

test("은퇴 세대가 늦게 얻은 capture hold는 즉시 반환한다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let finishHold;
  let mainCount = 0;
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (on) await new Promise((resolve) => { finishHold = resolve; });
      mainCount += on ? 1 : -1;
      return true;
    },
    resourceReleaseTimeoutMs: 20,
  });
  await relay.acceptGeneration("boot:1");
  const pending = relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await relay.acceptGeneration("boot:2", null, { takeover: true });

  finishHold();

  await assert.rejects(pending, (error) => error.code === "STALE_WORKER");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mainCount, 0);
});

test("기록한 capture hold가 없으면 메인 해제를 호출하지 않는다", async () => {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  const calls = [];
  const relay = createElectronRelay({
    webContents: { fromId: (id) => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => { calls.push(on); return on ? false : true; },
  });
  await relay.acceptGeneration("boot:1");

  const acquired = await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });
  const result = await relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/2",
    callId: "2",
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: false },
  });

  assert.deepEqual(acquired, { held: false });
  assert.deepEqual(result, { held: false });
  assert.deepEqual(calls, [true]);
});
