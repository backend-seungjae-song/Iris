import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerActivity } from "../server/mcp-worker/activity.js";
import { createWorkerRuntime } from "../server/mcp-worker/runtime.js";
import { createWorkerLock } from "../server/mcp-worker/worker-lock.js";
import { createIpcClient } from "../server/mcp-worker/ipc-client.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "server/mcp-worker/entry.js");
const tick = () => new Promise(resolve => setImmediate(resolve));

class Transport extends EventEmitter {
  connected = true;
  sent = [];
  send(message) { this.sent.push(message); }
  disconnect() { this.connected = false; this.emit("disconnect"); }
}

const message = (type, requestId = type) => ({ protocol: 1, workerGeneration: "boot:1", type, requestId });

test("worker는 부모 승인 뒤에 잠금을 잡고 accept 뒤에만 명령을 받는다", async () => {
  const transport = new Transport(), activity = createWorkerActivity(), calls = [];
  const lock = { acquired: 0, released: 0, acquire() { this.acquired++; }, release() { this.released++; } };
  const service = { dispatch: request => activity.run("commands", request.commandId, async () => { calls.push(request.command); return { ok: true }; }, { allowDuringDrain: request.command === "dialog" }), stopObservations: async () => [] };
  let exited = null;
  const runtime = createWorkerRuntime({ deployId: "deploy-a", workerGeneration: "boot:1", token: "test-" + "x".repeat(64), transport, lock, service, activity, exit: code => { exited = code; } });
  assert.equal(transport.sent[0].type, "worker.hello");
  assert.equal(lock.acquired, 0);
  transport.emit("message", message("worker.request", "before"));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(transport.sent.find(item => item.requestId === "before")?.error.code, "UNAUTHORIZED_WORKER");

  transport.emit("message", message("worker.authorized", "authorized"));
  await runtime.done();
  assert.equal(lock.acquired, 1);
  assert.equal(transport.sent.some(item => item.type === "worker.ready"), true);
  transport.emit("message", message("worker.accept", "accept"));
  await runtime.done();
  transport.emit("message", { ...message("worker.request", "work"), command: "review", commandId: "c1", identity: { session: "s", run: "r", key: "k" } });
  await tick();
  assert.deepEqual(calls, ["review"]);

  transport.emit("message", message("worker.stopAccepting", "stop"));
  await runtime.done();
  transport.emit("message", { ...message("worker.request", "rejected"), command: "review", commandId: "c2", identity: { session: "s" } });
  transport.emit("message", { ...message("worker.request", "dialog"), command: "dialog", commandId: "c3", identity: { session: "s" } });
  await tick();
  assert.equal(transport.sent.find(item => item.requestId === "rejected")?.error.code, "DRAINING");
  assert.equal(transport.sent.find(item => item.requestId === "dialog")?.ok, true);
  assert.deepEqual(calls, ["review", "dialog"]);

  transport.emit("message", message("worker.drain", "drain"));
  await runtime.done();
  assert.equal(transport.sent.find(item => item.requestId === "drain")?.ok, true);
  transport.emit("message", message("worker.shutdown", "shutdown"));
  await runtime.done();
  assert.equal(lock.released, 1);
  assert.equal(exited, 0);
});

test("drain은 활성 관찰을 목록으로 거부하고 나머지 활성 작업을 기다린다", async () => {
  const transport = new Transport(), activity = createWorkerActivity();
  const lock = { acquire() {}, release() {} };
  const runtime = createWorkerRuntime({ deployId: "deploy-a", workerGeneration: "boot:1", token: "test-" + "y".repeat(64), transport, lock,
    service: { dispatch: async () => ({}), stopObservations: async () => [] }, activity });
  transport.emit("message", message("worker.authorized")); await runtime.done();
  transport.emit("message", message("worker.accept")); await runtime.done();
  const releaseObservation = activity.hold("observations", "watch-1", { device: "phone" });
  transport.emit("message", message("worker.drain", "busy")); await runtime.done();
  const busy = transport.sent.find(item => item.requestId === "busy");
  assert.equal(busy.error.code, "BUSY");
  assert.deepEqual(busy.error.details.observations.map(item => item.id), ["watch-1"]);
  releaseObservation();

  const releases = [activity.hold("mobile", "m1"), activity.hold("reports", "r1"), activity.hold("journalWrites", "j1"), activity.hold("relayCommands", "e1")];
  transport.emit("message", message("worker.drain", "wait"));
  await tick();
  assert.equal(transport.sent.some(item => item.requestId === "wait"), false);
  releases.forEach(release => release());
  await runtime.done();
  assert.equal(transport.sent.find(item => item.requestId === "wait")?.ok, true);
});

test("부모 단절은 관찰을 중단하고 drain 뒤 잠금을 반환한다", async () => {
  const transport = new Transport(), activity = createWorkerActivity();
  let released = 0, stopped = 0, exited = null;
  const runtime = createWorkerRuntime({ deployId: "deploy-a", workerGeneration: "boot:1", token: "test-" + "z".repeat(64), transport,
    lock: { acquire() {}, release() { released++; } }, activity, exit: code => { exited = code; },
    service: { dispatch: async () => ({}), stopObservations: async () => { stopped++; releaseObservation(); return [{ id: "watch" }]; } } });
  transport.emit("message", message("worker.authorized")); await runtime.done();
  transport.emit("message", message("worker.accept")); await runtime.done();
  const releaseObservation = activity.hold("observations", "watch");
  transport.connected = false;
  transport.emit("disconnect");
  await runtime.done();
  assert.equal(stopped, 1);
  assert.equal(released, 1);
  assert.equal(exited, 0);
  assert.equal(activity.isAccepting(), false);
});

test("죽은 pid의 worker.lock은 회수하고 살아 있는 pid의 잠금은 보존한다", (t) => {
  const state = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-worker-lock-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const file = path.join(state, "mcp-worker", "worker.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 41, workerGeneration: "old:1" }));
  const reclaimed = createWorkerLock({ file, pid: 42, workerGeneration: "new:1", isProcessAlive: () => false });
  reclaimed.acquire();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 42);
  reclaimed.release();

  fs.writeFileSync(file, JSON.stringify({ pid: 43, workerGeneration: "live:1" }));
  const blocked = createWorkerLock({ file, pid: 44, workerGeneration: "new:2", isProcessAlive: () => true });
  assert.throws(() => blocked.acquire(), error => error.code === "BUSY");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 43);
});

test("worker.lock은 pid가 같아도 프로세스 시작 시각이 다르면 회수한다", (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-worker-lock-reused-pid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "worker.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 777, workerGeneration: "old:1", processStartedAt: "old-start" }));
  const lock = createWorkerLock({ file, pid: 778, workerGeneration: "new:1",
    isProcessAlive: () => true, processStartedAt: pid => pid === 777 ? "new-start" : "worker-start" });
  lock.acquire();
  const owner = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(owner.pid, 778);
  assert.equal(owner.processStartedAt, "worker-start");
  lock.release();
});

test("SIGTERM 종료 경로는 접수를 멈추고 잠금을 반환한다", async () => {
  const transport = new EventEmitter();
  transport.connected = true;
  transport.send = () => {};
  let released = 0, exited = null;
  const runtime = createWorkerRuntime({ deployId: "deploy", workerGeneration: "boot:term", token: "fixture-token-value-with-at-least-32-chars", transport,
    lock: { acquire() {}, release() { released += 1; } }, service: { stopObservations: async () => [] },
    exit: code => { exited = code; } });
  assert.equal(typeof runtime.terminate, "function");
  await runtime.terminate("SIGTERM");
  assert.equal(runtime.activity.isAccepting(), false);
  assert.equal(released, 1);
  assert.equal(exited, 0);
});

test("worker 잠금 획득 실패는 IPC를 끊고 실패 코드로 종료한다", async () => {
  const transport = new Transport();
  let exited = null;
  const runtime = createWorkerRuntime({ deployId: "deploy-a", workerGeneration: "boot:1", token: "t".repeat(64), transport,
    lock: { acquire() { throw Object.assign(new Error("lock busy"), { code: "BUSY" }); }, release() {} },
    service: { dispatch: async () => ({}) }, exit: code => { exited = code; } });
  transport.emit("message", message("worker.authorized", "authorized-fail"));
  await runtime.done();
  assert.equal(transport.sent.find(item => item.requestId === "authorized-fail")?.error.code, "BUSY");
  assert.equal(transport.connected, false);
  assert.equal(exited, 1);
});

test("host IPC는 공통 응답 상한 없이 실제 host 응답을 기다린다", async () => {
  const events = new EventEmitter();
  let sent;
  const ipc = createIpcClient({ workerGeneration: "boot:1", timeoutMs: null, events, send: message => { sent = message; } });
  const pending = ipc.request("app.command", { input: { command: "open" } });
  await tick();
  events.emit("message", { protocol: 1, workerGeneration: "boot:1", type: "host.response",
    requestId: sent.requestId, ok: true, output: { done: true } });
  assert.deepEqual(await pending, { done: true });
  ipc.close();
});

test("entry 직접 실행은 잠금을 만들지 않고 종료한다", async t => {
  const state = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-worker-direct-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, IRIS_STATE_DIR: state }, stdio: "ignore" });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(state, "mcp-worker", "worker.lock")), false);
});

test("fork entry는 authorized 전 잠금을 만들지 않고 부모 단절 뒤 제거한다", async t => {
  const state = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-worker-fork-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const generation = "fork:1";
  const child = fork(entry, [], { cwd: root, env: { ...process.env, IRIS_STATE_DIR: state,
    IRIS_MCP_WORKER_TOKEN: "test-" + "q".repeat(64), IRIS_MCP_WORKER_DEPLOY_ID: "deploy-fork", IRIS_MCP_WORKER_GENERATION: generation }, silent: true });
  const next = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} 메시지를 받지 못했습니다.`)), 5000);
    const onMessage = value => { if (value?.type !== type) return; clearTimeout(timer); child.off("message", onMessage); resolve(value); };
    child.on("message", onMessage);
  });
  const hello = await next("worker.hello");
  assert.equal(hello.deployId, "deploy-fork");
  const lock = path.join(state, "mcp-worker", "worker.lock");
  assert.equal(fs.existsSync(lock), false);
  child.send({ protocol: 1, type: "worker.authorized", workerGeneration: generation, requestId: "authorized" });
  await next("worker.ready");
  assert.equal(fs.existsSync(lock), true);
  child.disconnect();
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(lock), false);
});
