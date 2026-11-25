import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHostIdentityAuthority } from "../server/mcp-host/identity.js";
import { createMcpWorkerSupervisor } from "../server/mcp-worker/supervisor.js";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, ".working", "20261101-1716-mcp-app-separation", "scratch", "F5b");

test("활성 관찰이 있는 worker는 교체를 거부하고 이전 세대만 다시 접수한다", async () => {
  fs.mkdirSync(scratch, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-busy-"));
  for (const deployId of ["one", "two"]) fs.mkdirSync(path.join(stateDir, "mcp-worker", deployId), { recursive: true });
  let pid = 8000, relayOwner = null, accepting = 0, maxAccepting = 0, failWrite = false, failRetire = false;
  const spawnFailures = new Map();
  const children = [];
  const spawnWorker = (_entry, options) => {
    const deployId = options.env.IRIS_MCP_WORKER_DEPLOY_ID;
    if ((spawnFailures.get(deployId) || 0) > 0) {
      spawnFailures.set(deployId, spawnFailures.get(deployId) - 1);
      throw Object.assign(new Error(`spawn failed: ${deployId}`), { code: `SPAWN_${deployId.toUpperCase()}` });
    }
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.accepting = false;
    child.busy = false;
    child.refAtSend = [];
    child.channel = { refd: false, ref() { this.refd = true; }, unref() { this.refd = false; } };
    child.kill = signal => {
      if (!child.connected) return false;
      child.connected = false;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    child.send = (message, callback) => {
      if (String(message.requestId).startsWith(`${message.type}:`)) child.refAtSend.push(child.channel.refd || message.type);
      callback?.();
      const reply = (type, ok = true, output = {}, error = null) => queueMicrotask(() => child.emit("message", {
        protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type,
        requestId: message.requestId, ok, output,
        ...(ok ? {} : { error: error || { code: "BUSY", message: "활성 관찰", details: { observations: [{ id: "watch" }] } } }),
      }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      if (message.type === "worker.accept") {
        if (!child.accepting) { child.accepting = true; accepting++; maxAccepting = Math.max(maxAccepting, accepting); }
        reply("worker.accept.result");
      }
      if (message.type === "worker.stopAccepting") {
        if (child.accepting) { child.accepting = false; accepting--; }
        if (child.dieOnStopAccepting) {
          child.connected = false;
          queueMicrotask(() => child.emit("exit", 9, null));
          return;
        }
        reply("worker.stopAccepting.result");
      }
      if (message.type === "worker.drain") {
        child.drainCalls = (child.drainCalls || 0) + 1;
        if (child.failSecondDrain && child.drainCalls > 1) {
          reply("worker.drain.result", false, {}, { code: "TIMEOUT", message: "두 번째 drain 시간 초과" });
        } else reply("worker.drain.result", !child.busy);
      }
      if (message.type === "worker.stopObservations") {
        if (child.failStopObservations) reply("worker.stopObservations.result", false, {}, { code: "KEY_DENIED", message: "anchor 거부" });
        else { child.busy = false; reply("worker.stopObservations.result"); }
      }
      if (message.type === "worker.request") reply("worker.request.result", true, { ok: true, command: message.command });
      if (message.type === "worker.status") reply("worker.status.result", true, { active: { commands: [], observations: child.busy ? [{ id: "watch" }] : [], mobile: [], reports: [], journalWrites: [], relayCommands: [] } });
      if (message.type === "worker.shutdown") {
        reply("worker.shutdown.result");
        if (child.delayExit) child.exitRequested = true;
        else queueMicrotask(() => { child.connected = false; child.emit("exit", 0, null); });
      }
    };
    children.push(child);
    queueMicrotask(() => child.emit("message", { protocol: 1,
      workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.hello", pid: child.pid,
      deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID, token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "bundle", spawnWorker,
    verify: directory => ({ manifest: { deployId: path.basename(directory), bundle: { id: "bundle" }, protocol: { worker: 1 } },
      complete: { manifestSha256: `sha-${path.basename(directory)}` } }),
    writeCurrent: (file, value) => {
      if (failWrite) throw new Error("fixture write failure");
      fs.writeFileSync(file, JSON.stringify(value));
    },
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }),
    relay: {
      accept: (generation, { takeover = false } = {}) => {
        if (relayOwner && relayOwner !== generation && !takeover) {
          return { ok: false, code: "BUSY", error: "이전 세대가 남았습니다." };
        }
        relayOwner = generation;
        return { ok: true };
      },
      retire: generation => {
        if (failRetire) return { ok: false, code: "RESOURCE_RELEASE_FAILED", error: "fixture retire failure", details: { count: 1, leftovers: ["subscription:watch"] } };
        if (relayOwner !== generation) return { ok: false, code: "STALE_WORKER", error: "다른 세대" };
        relayOwner = null;
        return { ok: true };
      },
    }, restartBackoffMs: [0, 0, 0], workerLockPollMs: 1, log: { info() {} } });
  await supervisor.start();
  assert.deepEqual(await supervisor.request("browser", "tabs", {}, { session: null }), { ok: true, command: "tabs" });
  await supervisor.activate({ deployId: "one", expectPrevId: supervisor.status().deployId });
  children.at(-1).busy = true;
  await assert.rejects(supervisor.activate({ deployId: "two", expectPrevId: "one" }), error => {
    assert.equal(error.code, "BUSY");
    assert.deepEqual(error.details.observations, [{ id: "watch" }]);
    return true;
  });
  // 거부 이유가 상태 조회에 보여야 함 (감독기 캐시만 보면 늘 빈 목록이었음)
  assert.deepEqual((await supervisor.liveStatus()).active.observations, [{ id: "watch" }]);
  assert.equal(supervisor.status().deployId, "one");
  assert.equal(supervisor.status().accepting, true);
  children.at(-1).busy = false;
  failWrite = true;
  await assert.rejects(supervisor.activate({ deployId: "two", expectPrevId: "one" }), error => error.code === "POINTER_WRITE_FAILED");
  assert.equal(supervisor.status().deployId, "one");
  assert.equal(supervisor.status().accepting, true);
  assert.equal(maxAccepting, 1);
  failWrite = false;

  for (const failure of ["stopObservations", "secondDrain", "retire"]) {
    const previous = children.at(-1);
    previous.busy = failure !== "retire";
    previous.failStopObservations = failure === "stopObservations";
    previous.failSecondDrain = failure === "secondDrain";
    failRetire = failure === "retire";
    await assert.rejects(supervisor.activate({ deployId: "two", expectPrevId: "one", stopObservations: true }),
      error => failure !== "retire" || (assert.deepEqual(error.details.leftovers, ["subscription:watch"]), true));
    if (failure === "retire") {
      assert.equal(supervisor.status().accepting, true, failure);
      assert.equal(supervisor.status().deployId, "one", failure);
      failRetire = false;
      assert.equal((await supervisor.request("browser", "tabs", {}, { session: null })).ok, true);
    } else {
      assert.equal(supervisor.status().deployId, "one", failure);
      assert.equal(supervisor.status().accepting, true, failure);
    }
    previous.failStopObservations = false;
    previous.failSecondDrain = false;
    previous.busy = false;
    previous.drainCalls = 0;
    failRetire = false;
  }

  const dying = children.at(-1);
  dying.dieOnStopAccepting = true;
  await assert.rejects(supervisor.activate({ deployId: "two", expectPrevId: "one" }));
  assert.equal(supervisor.status().deployId, "one");
  assert.equal(supervisor.status().accepting, true);
  assert.notEqual(children.at(-1), dying);

  spawnFailures.set("two", 1);
  spawnFailures.set("one", 1);
  await assert.rejects(supervisor.activate({ deployId: "two", expectPrevId: "one" }), error => error.code === "SPAWN_TWO");
  assert.equal(supervisor.status().deployId, "one");
  assert.equal(supervisor.status().accepting, true);
  assert.match(supervisor.status().lastActivation.error, /spawn failed: two/);

  const crashed = children.at(-1);
  const crashedGeneration = crashed.accepting && supervisor.status().workerGeneration;
  if (crashed.accepting) { crashed.accepting = false; accepting--; }
  crashed.connected = false;
  crashed.emit("exit", 9, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(supervisor.status().accepting, true);
  assert.notEqual(supervisor.status().workerGeneration, crashedGeneration);
  assert.equal(maxAccepting, 1);
  // 응답 대기 중에는 IPC 채널 ref, 응답 뒤 unref · 다른 핸들이 없는 프로세스가 대기 중에 끝나지 않게
  const sentWithRef = children.flatMap(child => child.refAtSend);
  assert.ok(sentWithRef.length > 0);
  assert.deepEqual(sentWithRef.filter(value => value !== true), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.at(-1).channel.refd, false);

  const finalChild = children.at(-1);
  finalChild.delayExit = true;
  let shutdownDone = false;
  const shutdown = supervisor.shutdown().then(() => { shutdownDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finalChild.exitRequested, true);
  assert.equal(shutdownDone, false);
  finalChild.connected = false;
  finalChild.emit("exit", 0, null);
  await shutdown;
});

test("일반 worker 명령에는 공통 30초 응답 상한을 두지 않는다", () => {
  const source = fs.readFileSync(path.join(root, "server/mcp-worker/supervisor.js"), "utf8");
  assert.doesNotMatch(source, /workerRequest\(instance, "worker\.request",[^\n]+30000\)/);
  const ipc = fs.readFileSync(path.join(root, "server/mcp-worker/ipc-client.js"), "utf8");
  assert.doesNotMatch(ipc, /timeoutMs\s*=\s*30000/);
});

test("Windows에서는 current.json 교체 뒤 디렉터리 fsync를 호출하지 않는다", () => {
  const source = fs.readFileSync(path.join(root, "server/mcp-worker/supervisor.js"), "utf8");
  assert.match(source, /if \(process\.platform !== "win32"\) \{\s*const directory = fs\.openSync\(path\.dirname\(file\), "r"\);[\s\S]*?fs\.fsyncSync\(directory\);/);
});

test("동시에 같은 QA 회차를 쓰는 요청은 마지막 요청이 끝날 때까지 binding을 유지한다", async () => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-run-binding-"));
  const identityAuthority = createHostIdentityAuthority();
  identityAuthority.allowSession("session-a");
  const waiting = [];
  let pid = 9200;
  const spawnWorker = (_entry, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.send = (message, callback) => {
      callback?.();
      const reply = (ok = true) => queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: `${message.type}.result`,
        requestId: message.requestId, ok,
        output: message.command === "run_resume" ? { ok: true, data: { runId: "run-a", runKey: "key-b" } } : { ok: true } }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      else if (message.type === "worker.accept") reply();
      else if (message.type === "worker.request") waiting.push(() => reply());
      else if (message.type === "worker.stopAccepting" || message.type === "worker.drain") reply();
      else if (message.type === "worker.shutdown") { reply(); queueMicrotask(() => child.emit("exit", 0, null)); }
    };
    queueMicrotask(() => child.emit("message", { protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello", pid: child.pid, deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({ stateDir, spawnWorker, maxRestarts: 0,
    identityAuthority, hostDispatcher: () => ({ dispatch: async () => ({}) }), log: { info() {} } });
  try {
    await supervisor.start();
    const input = { session: "session-a", run: "run-a", key: "key-a" };
    const first = supervisor.request("qa", "row", {}, input);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      supervisor.request("qa", "row", {}, { ...input, key: "key-b" }),
      error => error.code === "KEY_DENIED",
    );
    assert.equal(waiting.length, 1, "다른 key는 worker 요청으로 전달되기 전에 거절해야 한다");
    const second = supervisor.request("qa", "row", {}, input);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(identityAuthority.bindingFor("run-a"), "두 요청이 끝나기 전에는 회차 binding이 있어야 한다");
    assert.equal(waiting.length, 2);
    waiting.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(identityAuthority.bindingFor("run-a"), "첫 요청이 끝나도 두 번째 요청이 사용하는 binding은 남아야 한다");
    waiting.shift()();
    await Promise.all([first, second]);
    assert.ok(identityAuthority.bindingFor("run-a"), "성공한 요청 뒤에는 다음 요청을 위한 binding이 남아야 한다");
    identityAuthority.releaseRun(input);
    identityAuthority.rotateRunKey = () => { throw Object.assign(new Error("회차 key 검증 실패"), { code: "ROTATE_FAILED" }); };
    const failedRotation = supervisor.request("qa", "run_resume", {}, input);
    await new Promise(resolve => setImmediate(resolve));
    waiting.shift()();
    await assert.rejects(failedRotation, error => error.code === "ROTATE_FAILED");
    assert.equal(identityAuthority.bindingFor("run-a"), null, "rotateRunKey 실패 뒤 임시 binding을 정리해야 한다");
  } finally {
    await supervisor.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("종료 중 host 유휴 대기와 worker drain은 종료 예산 안에서 강제 회수한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-shutdown-budget-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let pid = 9400;
  let retired = 0;
  let released = 0;
  const spawnWorker = (_entry, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.disconnect = () => {
      child.connected = false;
      queueMicrotask(() => child.emit("exit", 0, null));
    };
    child.kill = () => {
      child.connected = false;
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    };
    child.send = (message, callback) => {
      callback?.();
      const reply = () => queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: `${message.type}.result`,
        requestId: message.requestId, ok: true, output: {} }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      if (["worker.accept", "worker.stopAccepting", "worker.drain"].includes(message.type)) reply();
      // shutdown 응답은 일부러 생략해 stopInstance의 남은 예산과 강제 회수를 확인
    };
    queueMicrotask(() => child.emit("message", { protocol: 1,
      workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.hello", pid: child.pid,
      deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID, token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({
    stateDir,
    spawnWorker,
    maxRestarts: 0,
    shutdownTimeoutMs: 30,
    releaseHostGeneration: () => { released++; },
    identityAuthority: createHostIdentityAuthority(),
    hostDispatcher: () => ({
      dispatch: async () => ({}),
      waitForIdle: () => new Promise(() => {}),
      retire: () => { retired++; },
    }),
    log: { info() {} },
  });
  await supervisor.start();
  const startedAt = Date.now();
  await supervisor.shutdown();
  assert.ok(Date.now() - startedAt < 500, "종료가 host 유휴 대기에 매달리지 않아야 한다");
  assert.equal(retired, 1);
  assert.equal(released, 1);
});

test("앱 재시작은 살아 있는 이전 worker의 잠금 반환을 기다린다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-lock-wait-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const lock = path.join(stateDir, "mcp-worker", "worker.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, workerGeneration: "old:1" }));
  let spawns = 0;
  const spawnWorker = (_entry, options) => {
    spawns++;
    const child = new EventEmitter();
    child.pid = 9000 + spawns;
    child.connected = true;
    child.send = (message, callback) => {
      callback?.();
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      if (["worker.accept", "worker.stopAccepting", "worker.drain", "worker.shutdown"].includes(message.type)) {
        queueMicrotask(() => child.emit("message", { protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
          type: `${message.type}.result`, requestId: message.requestId, ok: true, output: {} }));
        if (message.type === "worker.shutdown") queueMicrotask(() => child.emit("exit", 0, null));
      }
    };
    queueMicrotask(() => child.emit("message", { protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello", pid: child.pid, deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "bundle", spawnWorker, workerLockPollMs: 1,
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }), log: { info() {} } });
  const starting = supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns, 0);
  fs.unlinkSync(lock);
  await starting;
  assert.equal(spawns, 1);
  await supervisor.shutdown();
});

test("종료 중 start·activate·recover는 새 worker를 만들지 않는다", async (t) => {
  for (const operationName of ["start", "activate", "recover"]) {
    const stateDir = fs.mkdtempSync(path.join(scratch, `supervisor-stopping-${operationName}-`));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const lock = path.join(stateDir, "mcp-worker", "worker.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, workerGeneration: "old:1" }));
    fs.mkdirSync(path.join(stateDir, "mcp-worker", "one"), { recursive: true });
    let spawns = 0;
    const supervisor = createMcpWorkerSupervisor({
      stateDir,
      bundleId: "bundle",
      workerLockPollMs: 1,
      workerLockWaitMs: 100,
      spawnWorker: () => {
        spawns++;
        throw Object.assign(new Error("종료 중 spawn하면 안 됩니다."), { code: "EARLY_SPAWN" });
      },
      verify: directory => ({ manifest: { deployId: path.basename(directory), bundle: { id: "bundle" }, protocol: { worker: 1 } },
        complete: { manifestSha256: `sha-${path.basename(directory)}` } }),
      identityAuthority: createHostIdentityAuthority(),
      hostDispatcher: () => ({ dispatch: async () => ({}) }),
      log: { info() {} },
    });
    const operation = operationName === "start"
      ? supervisor.start()
      : operationName === "activate"
        ? supervisor.activate({ deployId: "one" })
        : supervisor.activate({ deployId: "one", recover: true });
    await new Promise(resolve => setImmediate(resolve));
    await supervisor.shutdown();
    fs.unlinkSync(lock);
    await assert.rejects(operation, error => error.code === "SHUTTING_DOWN");
    assert.equal(spawns, 0, `${operationName}은 종료 뒤 spawn하지 않아야 한다`);
  }
});

test("spawn 직후 종료가 시작되면 준비 중인 worker도 종료한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-stopping-spawned-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let supervisor;
  let child;
  let disconnects = 0;
  const spawnWorker = (_entry, options) => {
    child = new EventEmitter();
    child.pid = 9601;
    child.connected = true;
    child.disconnect = () => {
      disconnects++;
      child.connected = false;
      queueMicrotask(() => child.emit("exit", 0, null));
    };
    child.send = (message, callback) => {
      callback?.();
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      if (message.type === "worker.accept") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.accept.result",
        requestId: message.requestId, ok: true, output: {} }));
    };
    queueMicrotask(() => child.emit("message", { protocol: 1,
      workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.hello", pid: child.pid,
      deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID, token: options.env.IRIS_MCP_WORKER_TOKEN }));
    queueMicrotask(() => supervisor.shutdown());
    return child;
  };
  supervisor = createMcpWorkerSupervisor({ stateDir, spawnWorker, maxRestarts: 0,
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }),
    log: { info() {} } });
  await assert.rejects(supervisor.start(), error => ["SHUTTING_DOWN", "WORKER_EXIT"].includes(error.code));
  assert.equal(disconnects, 1);
  assert.equal(supervisor.status().state, "failed");
});

test("살아 있는 pid 잠금 대기는 상한 뒤 실패한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-lock-timeout-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const lock = path.join(stateDir, "mcp-worker", "worker.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, workerGeneration: "old:1" }));
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "bundle", maxRestarts: 0,
    workerLockPollMs: 1, workerLockWaitMs: 5,
    spawnWorker: () => { throw Object.assign(new Error("잠금 상한 전에 spawn하면 안 됩니다."), { code: "EARLY_SPAWN" }); },
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }), log: { info() {} } });
  const starting = supervisor.start();
  try { await assert.rejects(starting, error => error.code === "LOCK_TIMEOUT"); }
  finally { if (fs.existsSync(lock)) fs.unlinkSync(lock); }
});

test("기동 실패는 child IPC 단절과 잠금 반환을 확인한 뒤 실패 상태를 남긴다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-start-fail-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const lock = path.join(stateDir, "mcp-worker", "worker.lock");
  let disconnected = false;
  const spawnWorker = (_entry, options) => {
    const child = new EventEmitter();
    child.pid = 9100;
    child.connected = true;
    child.disconnect = () => {
      disconnected = true;
      child.connected = false;
      if (fs.existsSync(lock)) fs.unlinkSync(lock);
      queueMicrotask(() => child.emit("exit", 1, null));
    };
    child.send = (message, callback) => {
      callback?.();
      if (message.type === "worker.authorized") {
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION }));
        queueMicrotask(() => child.emit("error", Object.assign(new Error("ready failed"), { code: "READY_FAILED" })));
      }
    };
    queueMicrotask(() => child.emit("message", { protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello", pid: child.pid, deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "bundle", spawnWorker, maxRestarts: 1,
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }), log: { info() {} } });
  await assert.rejects(supervisor.start(), error => error.code === "READY_FAILED");
  assert.equal(disconnected, true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(supervisor.status().state, "failed");
  assert.match(supervisor.status().failure, /ready failed/);
});

test("현재 bundle 세대와 다른 current.json 배포는 시작 때 선택하지 않는다", (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-stale-pointer-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const deployRoot = path.join(stateDir, "mcp-worker");
  fs.mkdirSync(deployRoot, { recursive: true });
  fs.writeFileSync(path.join(deployRoot, "current.json"), JSON.stringify({ schemaVersion: 1, deployId: "old-worker",
    manifestSha256: "old-sha", bundleId: "old-full-install", workerProtocol: 1 }));
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "new-full-install",
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }) });
  const selected = supervisor.startupDeployment();
  assert.equal(selected.deployId, "bundle:new-full-install");
  assert.match(selected.reason, /current\.json/);
});

test("실행기 재등록은 보류한 이전 세대를 retire한 뒤 현재 세대를 accept한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(scratch, "supervisor-relay-reconnect-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls = [];
  let connected = false;
  let pid = 9300;
  const spawnWorker = (_entry, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.send = (message, callback) => {
      callback?.();
      const reply = () => queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: `${message.type}.result`,
        requestId: message.requestId, ok: true, output: {} }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", { protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION, type: "worker.ready", pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID }));
      if (["worker.accept", "worker.stopAccepting", "worker.drain"].includes(message.type)) reply();
      if (message.type === "worker.shutdown") {
        reply();
        queueMicrotask(() => { child.connected = false; child.emit("exit", 0, null); });
      }
    };
    queueMicrotask(() => child.emit("message", { protocol: 1, workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello", pid: child.pid, deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({ stateDir, bundleId: "bundle", spawnWorker,
    identityAuthority: createHostIdentityAuthority(), hostDispatcher: () => ({ dispatch: async () => ({}) }),
    relay: {
      accept: generation => connected ? (calls.push(["accept", generation]), { ok: true }) : { ok: true, pending: true },
      retire: generation => connected ? (calls.push(["retire", generation]), { ok: true }) : { ok: true, pending: true },
    }, log: { info() {} } });
  await supervisor.start();
  const oldGeneration = supervisor.status().workerGeneration;
  const running = supervisor.status().deployId;
  const current = supervisor.status();
  assert.equal(current.accepting, true);
  connected = true;
  await supervisor.executorRegistered();
  assert.deepEqual(calls, [["accept", oldGeneration]]);
  calls.length = 0;
  connected = false;
  const live = supervisor.status();
  assert.equal(live.deployId, running);
  const childrenBefore = pid;
  const worker = await supervisor.reloadSource();
  const newGeneration = worker.worker.workerGeneration;
  assert.notEqual(newGeneration, oldGeneration);
  assert.ok(pid > childrenBefore);
  connected = true;
  await supervisor.executorRegistered();
  assert.deepEqual(calls, [["retire", oldGeneration], ["accept", newGeneration]]);
  await supervisor.shutdown();
});
