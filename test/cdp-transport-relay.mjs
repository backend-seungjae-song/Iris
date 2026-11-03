import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCdpTransport } = require("../native/electron/cdp-transport.cjs");
const { createCdpSession } = require("../native/electron/cdp-session.cjs");

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit("close"); }
  terminate() { this.emit("close"); }
}

test("transport는 재등록 상태, worker 세대 제어, relay 명령 메타를 전달한다", async () => {
  const sockets = [];
  class WebSocket { constructor() { const socket = new Socket(); sockets.push(socket); return socket; } }
  const accepted = [], retired = [], executions = [], replayed = [], deliveries = [];
  const transport = createCdpTransport({
    WebSocket,
    port: 4291,
    cdpExec: async (...args) => { executions.push(args); return { ok: true }; },
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    tabGoneCode: "tab_gone",
    execPath: "/Applications/Iris.app",
    pid: 123,
    features: ["worker-command-unit"],
    relayControl: {
      acceptGeneration: async (generation, connection, options) => { accepted.push([generation, connection, options]); return { accepted: true }; },
      retireGeneration: async (generation, options) => {
        retired.push([generation, options]);
        if (generation === "boot:fail") throw Object.assign(new Error("이전 작업 프로세스 세대의 자원을 모두 반환하지 못했습니다."),
          { code: "RESOURCE_RELEASE_FAILED", details: { count: 1, leftovers: ["viewport:7"] } });
        return { retired: true, forced: options.force, leftovers: ["capture-hold:7"] };
      },
      isBaseCommand: (command) => command === "qa.anchor" || command === "cdp.send",
    },
    onRegistered: () => { replayed.push(true); transport.ctlSend({ type: "browser-frame-origins", wc: 7, origins: ["https://a.test"] }); },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    setTimeoutFn() {},
    log() {}, error() {},
  });
  transport.setupCdpControl({ fromId() {} });
  transport.ctlSend({ type: "browser-frame-origins", wc: 7, origins: ["https://stale.test"] },
    (delivered) => deliveries.push(delivered));
  const socket = sockets[0];
  socket.readyState = 1;
  socket.emit("open");
  assert.equal(replayed.length, 1);
  assert.deepEqual(socket.sent.slice(0, 3).map((message) => message.type),
    ["cdp-executor-register", "browser-frame-origins", "browser-frame-origins"]);
  assert.deepEqual(socket.sent[0].features, ["worker-command-unit"]);
  assert.deepEqual(socket.sent[1].origins, ["https://stale.test"]);
  assert.deepEqual(socket.sent[2].origins, ["https://a.test"]);
  assert.deepEqual(deliveries, [true]);

  const relayEvent = { workerGeneration: "boot:1", subscriptionId: "sub-1", eventSeq: 1,
    method: "Runtime.bindingCalled", params: { name: "binding" } };
  transport.ctlSend({ type: "relay-event", event: relayEvent });
  assert.deepEqual(socket.sent.at(-1), { type: "relay-event", event: relayEvent });

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "worker.accept", id: "a", workerGeneration: "boot:1", takeover: true,
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0][0], "boot:1");
  assert.equal(accepted[0][1], socket);
  assert.deepEqual(accepted[0][2], { takeover: true });
  assert.equal(socket.sent.at(-1).type, "worker.accepted");

  socket.emit("message", Buffer.from(JSON.stringify({ type: "cdp-exec", id: "e", wc: 7, cmd: "cdp.send",
    args: { method: "Page.enable" }, workerGeneration: "boot:1", commandId: "boot:1/1", callId: "2",
    targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executions[0][4], { workerGeneration: "boot:1", commandId: "boot:1/1", callId: "2",
    targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } });

  socket.emit("message", Buffer.from(JSON.stringify({ type: "cdp-exec", id: "unit", wc: 7, cmd: "cdp.send",
    args: {}, workerGeneration: "boot:1", commandId: "boot:1/9", callId: "1", targetToken: { wcId: 7 },
    unit: { command: "url", phase: "last" } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executions.at(-1)[4].unit, { command: "url", phase: "last" });
  executions.pop();

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "cdp-exec", id: "legacy-worker", wc: 7, cmd: "dialog", args: { answer: "cancel" },
    workerGeneration: "boot:1", commandId: "boot:1/2", callId: "3",
    targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 },
  })));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "cdp-exec", id: "legacy-host", wc: 7, cmd: "redact", args: { text: "public" },
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions[1][2], "dialog");
  assert.deepEqual(executions[1][4], { workerGeneration: "boot:1", commandId: "boot:1/2", callId: "3",
    targetToken: { wcId: 7, documentGeneration: 2, debuggerGeneration: 3 } });
  assert.equal(executions[2][2], "redact");
  assert.deepEqual(executions[2][4], {
    workerGeneration: undefined,
    commandId: undefined,
    callId: undefined,
    targetToken: undefined,
  });

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "worker.retire", id: "r", workerGeneration: "boot:1", force: true,
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(retired, [["boot:1", { force: true }]]);
  assert.equal(socket.sent.at(-1).type, "worker.retired");
  assert.equal(socket.sent.at(-1).forced, true);
  assert.deepEqual(socket.sent.at(-1).leftovers, ["capture-hold:7"]);

  // 일반 교체 실패의 남은 자원 목록도 서버로 보냄 (빠지면 무엇이 남았는지 알 수 없음)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "worker.retire", id: "f", workerGeneration: "boot:fail" })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.at(-1).ok, false);
  assert.equal(socket.sent.at(-1).code, "RESOURCE_RELEASE_FAILED");
  assert.deepEqual(socket.sent.at(-1).details, { count: 1, leftovers: ["viewport:7"] });
});

test("실행기 재등록은 대기열 상한과 관계없이 등록 guest 전체의 세대를 보낸다", () => {
  const sockets = [];
  class WebSocket { constructor() { const socket = new Socket(); sockets.push(socket); return socket; } }
  let session;
  const transport = createCdpTransport({
    WebSocket,
    port: 4291,
    cdpExec: async () => ({}),
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    tabGoneCode: "tab_gone",
    execPath: "/Applications/Iris.app",
    pid: 123,
    onRegistered: () => session.replayExecutorState(),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    setTimeoutFn() {},
    log() {}, error() {},
  });
  session = createCdpSession({
    observation: { dialogOpen: () => null },
    hiddenViewport: {}, overlay: {}, refRegistry: {}, upload: {}, deviceEmulation: {},
    ctlSend: transport.ctlSend,
    tagError: (error, code) => Object.assign(error, { code }),
    sessionDetachedCode: "session_detached",
  });
  for (let id = 1; id <= 75; id++) session.registerSessionPrimer(id, () => {});

  transport.setupCdpControl({ fromId() {} });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.emit("open");

  const replayed = new Set(socket.sent
    .filter((message) => message.type === "browser-target-generation")
    .map((message) => message.wc));
  assert.equal(replayed.size, 75);
  assert.deepEqual([...replayed].sort((a, b) => a - b), Array.from({ length: 75 }, (_, index) => index + 1));
});
