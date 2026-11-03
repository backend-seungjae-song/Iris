import assert from "node:assert/strict";
import test from "node:test";

import * as runtime from "../server/browser-runtime.js";

test("실행기 등록 메시지의 기능 목록을 보관하고 지우며 형식 밖 값은 버린다", () => {
  const ws = { readyState: 1, send() {} };
  assert.equal(runtime.registerCdpExecutor(ws, { app: "t", pid: process.pid, features: ["worker-command-unit", 7, { a: 1 }] }), true);
  assert.deepEqual(runtime.cdpExecutorInfo().features, ["worker-command-unit"]);
  const bare = { readyState: 1, send() {} };
  runtime.disconnectCdpExecutor(ws);
  runtime.registerCdpExecutor(bare, { app: "t", pid: process.pid });
  assert.deepEqual(runtime.cdpExecutorInfo().features, []);
  runtime.disconnectCdpExecutor(bare);
});

test("worker 중계 요청은 unit 표시가 있을 때만 그 필드를 executor 메시지에 싣는다", async () => {
  const sent = [];
  const ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
  runtime.registerCdpExecutor(ws, { app: "t", pid: process.pid });
  const base = { workerGeneration: "g/1", commandId: "g/1/a", callId: 1, targetToken: null, command: "wc.info", args: {}, wc: 7, timeoutMs: 20 };
  runtime.requestWorkerRelay({ ...base, unit: { command: "url", phase: "last" } });
  runtime.requestWorkerRelay(base);
  assert.deepEqual(sent[0].unit, { command: "url", phase: "last" });
  assert.equal(Object.hasOwn(sent[1], "unit"), false);
  runtime.disconnectCdpExecutor(ws);
});
