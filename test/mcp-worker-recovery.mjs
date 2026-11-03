import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostIdentityAuthority } from "../server/mcp-host/identity.js";
import { createMcpWorkerSupervisor } from "../server/mcp-worker/supervisor.js";

const require = createRequire(import.meta.url);
const { createElectronRelay } = require("../native/electron/relay/index.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));

function childSpawner(control, children) {
  let pid = 30_000;
  return (_entry, options) => {
    control.spawnCount = (control.spawnCount || 0) + 1;
    if (control.failSpawnAt === control.spawnCount) throw Object.assign(new Error("fixture spawn failure"), { code: "SPAWN_FAILED" });
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.accepting = false;
    child.kill = () => {
      if (!child.connected) return false;
      child.connected = false;
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    };
    child.disconnect = () => child.kill();
    child.send = (message, callback) => {
      if (!child.connected) {
        callback?.(Object.assign(new Error("child disconnected"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
        return;
      }
      callback?.();
      const reply = (ok = true, output = {}, error = null) => queueMicrotask(() => child.emit("message", {
        protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
        type: `${message.type}.result`,
        requestId: message.requestId,
        ok,
        output,
        ...(ok ? {} : { error }),
      }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", {
        protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
        type: "worker.ready",
        pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      }));
      if (message.type === "worker.accept") {
        child.accepting = true;
        reply();
        if (control.exitOnFirstAccept && children.length === 1) queueMicrotask(() => {
          child.connected = false;
          child.emit("exit", 9, null);
        });
      }
      if (message.type === "worker.stopAccepting") {
        child.accepting = false;
        if (child.dieOnStopAccepting) {
          child.connected = false;
          queueMicrotask(() => child.emit("exit", 9, null));
        } else reply();
      }
      if (message.type === "worker.drain") reply();
      if (message.type === "worker.request") reply(true, { ok: true, command: message.command });
      if (message.type === "worker.shutdown") {
        if (child.failShutdown) {
          reply(false, {}, { code: "TIMEOUT", message: "fixture shutdown failure" });
        } else {
          reply();
          queueMicrotask(() => {
            child.connected = false;
            child.emit("exit", 0, null);
          });
        }
      }
    };
    children.push(child);
    queueMicrotask(() => child.emit("message", {
      protocol: 1,
      workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello",
      pid: child.pid,
      deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN,
    }));
    return child;
  };
}

function supervisorFixture({ relay, control = {}, extra = {} } = {}) {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f6b-supervisor-"));
  const children = [];
  const supervisor = createMcpWorkerSupervisor({
    stateDir,
    bundleId: "bundle",
    spawnWorker: childSpawner(control, children),
    identityAuthority: createHostIdentityAuthority(),
    hostDispatcher: () => ({ dispatch: async () => ({}), waitForIdle: async () => {} }),
    releaseHostGeneration: generation => { (control.released ||= []).push(generation); },
    relay,
    maxRestarts: 2,
    restartBackoffMs: [0, 0],
    requestWaitMs: 20,
    log: { info() {} },
    ...extra,
  });
  return { supervisor, children, control, stateDir };
}

function actualRelayFixture() {
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  let releaseFails = false;
  let releaseHangs = false;
  let connection = { id: 1 };
  const acceptOptions = [];
  const relay = createElectronRelay({
    webContents: { fromId: id => Number(id) === 7 ? guest : null },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => "https://example.test/",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    captureHold: async (_wcId, on) => {
      if (!on && releaseHangs) return new Promise(() => {});
      if (!on && releaseFails) throw new Error("fixture release failure");
      return true;
    },
  });
  const wrap = invoke => async (...args) => {
    try { return { ok: true, data: await invoke(...args) }; }
    catch (error) { return { ok: false, code: error.code, error: error.message }; }
  };
  return {
    relay,
    ports: {
      accept: wrap((generation, options) => {
        acceptOptions.push(options || {});
        return relay.acceptGeneration(generation, connection, options || {});
      }),
      retire: wrap((generation, options) => relay.retireGeneration(generation, options || {})),
    },
    acceptOptions,
    failRelease(value) { releaseFails = value; },
    hangRelease(value) { releaseHangs = value; },
    reconnect() { connection = { id: connection.id + 1 }; },
  };
}

async function holdCapture(relay, generation) {
  await relay.execute({
    workerGeneration: generation,
    commandId: `${generation}/hold`,
    callId: 1,
    command: "hold.capture",
    target: { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 },
    args: { on: true },
  });
}

test("비정상 종료의 실제 relay 자원 반환 실패는 takeover 재기동을 막지 않는다", async (t) => {
  const actual = actualRelayFixture();
  const fixture = supervisorFixture({ relay: actual.ports });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const generation = fixture.supervisor.status().workerGeneration;
  await holdCapture(actual.relay, generation);
  actual.failRelease(true);
  const crashed = fixture.children.at(-1);
  crashed.connected = false;
  crashed.emit("exit", 9, null);
  await tick();
  await tick();
  const result = await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" });

  assert.equal(result.ok, true);
  assert.equal(fixture.children.length, 2);
  assert.equal(actual.relay.state().state, "accepting");
  assert.notEqual(actual.relay.state().workerGeneration, generation);
  actual.failRelease(false);
  await fixture.supervisor.shutdown();
});

test("실행기 재등록의 실제 relay accept 실패는 다음 요청에서 같은 accept를 재시도한다", async (t) => {
  const actual = actualRelayFixture();
  const fixture = supervisorFixture({ relay: actual.ports });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const generation = fixture.supervisor.status().workerGeneration;
  await holdCapture(actual.relay, generation);
  actual.failRelease(true);
  actual.reconnect();
  assert.equal(await fixture.supervisor.executorRegistered(), false);
  assert.equal(fixture.supervisor.status().state, "failed");

  actual.failRelease(false);
  const result = await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" });

  assert.equal(result.ok, true);
  assert.equal(fixture.children.length, 1);
  assert.deepEqual(actual.relay.state(), { workerGeneration: generation, state: "accepting", active: 0 });
  await fixture.supervisor.shutdown();
});

test("retire 성공 뒤 shutdown 실패는 이전 세대를 재접수하지 않고 새 세대를 기동한다", async (t) => {
  let owner = null;
  const retired = new Set();
  const fixture = supervisorFixture({ relay: {
    accept: generation => retired.has(generation) || (owner && owner !== generation)
      ? { ok: false, code: "STALE_WORKER", error: "retired" } : (owner = generation, { ok: true }),
    retire: generation => {
      if (owner !== generation) return { ok: false, code: "STALE_WORKER", error: "stale" };
      owner = null;
      retired.add(generation);
      return { ok: true };
    },
  } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const generation = fixture.supervisor.status().workerGeneration;
  fixture.children.at(-1).failShutdown = true;

  await assert.rejects(fixture.supervisor.reloadSource(), error => error.code === "TIMEOUT");
  const result = await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" });

  assert.equal(result.ok, true);
  assert.notEqual(fixture.supervisor.status().workerGeneration, generation);
  assert.equal(retired.has(generation), true);
  await fixture.supervisor.shutdown();
});

test("accept 직후 종료한 미등록 child는 현재 worker가 되지 않는다", async (t) => {
  const fixture = supervisorFixture({ control: { exitOnFirstAccept: true }, relay: { accept: () => ({ ok: true }), retire: () => ({ ok: true }) } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));

  await fixture.supervisor.start();

  assert.equal(fixture.children.length, 2);
  assert.equal(fixture.supervisor.status().accepting, true);
  assert.equal(fixture.children.at(-1).connected, true);
  await fixture.supervisor.shutdown();
});

test("reloadSource 새 기동 실패와 이전 worker 사망을 각각 복구한다", async (t) => {
  const fixture = supervisorFixture({ control: { failSpawnAt: 2 }, relay: { accept: () => ({ ok: true }), retire: () => ({ ok: true }) } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();

  await assert.rejects(fixture.supervisor.reloadSource(), error => error.code === "SPAWN_FAILED");
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);

  fixture.children.at(-1).dieOnStopAccepting = true;
  await assert.rejects(fixture.supervisor.reloadSource());
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  await fixture.supervisor.shutdown();
});

test("일반 activate의 retire 실패 뒤 이전 배포를 takeover로 다시 기동한다", async (t) => {
  const actual = actualRelayFixture();
  const verify = directory => ({ manifest: { deployId: path.basename(directory), bundle: { id: "bundle" }, protocol: { worker: 1 } },
    complete: { manifestSha256: "manifest" } });
  const fixture = supervisorFixture({ relay: actual.ports, extra: { verify } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const generation = fixture.supervisor.status().workerGeneration;
  await holdCapture(actual.relay, generation);
  actual.failRelease(true);

  await assert.rejects(fixture.supervisor.activate({ deployId: "next" }), error => error.code === "RESOURCE_RELEASE_FAILED");
  assert.equal(fixture.supervisor.status().state, "accepting");
  const result = await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" });
  assert.equal(result.ok, true);
  assert.notEqual(fixture.supervisor.status().workerGeneration, generation);
  assert.equal(actual.relay.state().state, "accepting");
  actual.failRelease(false);
  actual.reconnect();
  assert.equal(await fixture.supervisor.executorRegistered(), true);
  assert.equal(fixture.supervisor.status().state, "accepting");
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  await fixture.supervisor.shutdown();
});

test("recover는 failed·current 없음·재시작 상한 초과 상태를 한 번에 복구한다", async (t) => {
  const cases = ["failed", "absent", "restart-limit"];
  for (const scenario of cases) {
    const actual = actualRelayFixture();
    const control = {};
    const fixture = supervisorFixture({ relay: actual.ports, control,
      extra: { restartWindowMs: 5, requestWaitMs: 10 } });
    t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
    if (scenario === "absent") {
      let failAll = true;
      Object.defineProperty(control, "failSpawnAt", { get: () => failAll ? control.spawnCount : -1 });
      await assert.rejects(fixture.supervisor.start());
      failAll = false;
    } else {
      await fixture.supervisor.start();
      const child = fixture.children.at(-1);
      if (scenario === "failed") {
        await holdCapture(actual.relay, fixture.supervisor.status().workerGeneration);
        actual.reconnect();
        actual.failRelease(true);
        assert.equal(await fixture.supervisor.executorRegistered(), false);
        actual.failRelease(false);
      } else {
        for (let index = 0; index < 3; index++) {
          const current = fixture.children.at(-1);
          current.connected = false;
          current.emit("exit", 9, null);
          await tick();
          await tick();
        }
      }
    }

    const recovered = await fixture.supervisor.activate({ recover: true });
    assert.equal(recovered.ok, true, scenario);
    assert.equal(fixture.supervisor.status().accepting, true, scenario);
    assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true, scenario);
    await fixture.supervisor.shutdown();
  }
});

test("recover는 실제 relay에 takeover를 전달하고 다음 요청을 새 세대에서 처리한다", async (t) => {
  const actual = actualRelayFixture();
  const fixture = supervisorFixture({ relay: actual.ports });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const previous = fixture.supervisor.status().workerGeneration;

  const recovered = await fixture.supervisor.activate({ recover: true });

  assert.equal(recovered.ok, true);
  assert.equal(actual.acceptOptions.at(-1).takeover, true);
  assert.notEqual(fixture.supervisor.status().workerGeneration, previous);
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  assert.equal(fixture.children.filter(child => child.connected && child.accepting).length, 1);
  await fixture.supervisor.shutdown();
});

test("이전 세대 자원 반환이 멈춰도 takeover recover는 상한 안에 새 요청을 받는다", async (t) => {
  const actual = actualRelayFixture();
  const fixture = supervisorFixture({ relay: actual.ports });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  await holdCapture(actual.relay, fixture.supervisor.status().workerGeneration);
  actual.hangRelease(true);

  const recovered = await Promise.race([
    fixture.supervisor.activate({ recover: true }),
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("recover upper bound"), { code: "TEST_TIMEOUT" })), 500)),
  ]);

  assert.equal(recovered.ok, true);
  assert.equal(actual.acceptOptions.at(-1).takeover, true);
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  actual.hangRelease(false);
  await fixture.supervisor.shutdown();
});

test("자동 복구 중 recover는 같은 복구 결과를 기다리고 accepting을 성공으로 반환한다", async (t) => {
  const actual = actualRelayFixture();
  const originalAccept = actual.ports.accept;
  let delayTakeover = false;
  actual.ports.accept = async (generation, options) => {
    if (delayTakeover && options?.takeover) await new Promise(resolve => setTimeout(resolve, 40));
    return originalAccept(generation, options);
  };
  const fixture = supervisorFixture({ relay: actual.ports });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  delayTakeover = true;
  const crashed = fixture.children.at(-1);
  crashed.connected = false;
  crashed.emit("exit", 9, null);
  await tick();

  const recovered = await fixture.supervisor.activate({ recover: true });

  assert.equal(recovered.ok, true);
  assert.equal(fixture.supervisor.status().accepting, true);
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  assert.equal(fixture.children.filter(child => child.connected && child.accepting).length, 1);
  await fixture.supervisor.shutdown();
});

test("recover의 current 기록 실패 뒤 다음 활성화는 실행 배포로 pointer를 재조정한다", async (t) => {
  const actual = actualRelayFixture();
  let failWrite = true;
  const writes = [];
  const fixture = supervisorFixture({ relay: actual.ports, extra: {
    verify: directory => ({ manifest: { deployId: path.basename(directory), bundle: { id: "bundle" }, protocol: { worker: 1 } },
      complete: { manifestSha256: "manifest" } }),
    writeCurrent: (file, value) => {
      if (failWrite) throw new Error("fixture pointer failure");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
      writes.push(value);
    },
  } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  const currentFile = path.join(fixture.stateDir, "mcp-worker", "current.json");
  fs.mkdirSync(path.dirname(currentFile), { recursive: true });
  fs.writeFileSync(currentFile, JSON.stringify({ schemaVersion: 1, deployId: "old", manifestSha256: "manifest",
    bundleId: "bundle", workerProtocol: 1 }));

  await assert.rejects(fixture.supervisor.activate({ deployId: "next", recover: true }), error => error.code === "POINTER_WRITE_FAILED");
  assert.equal(fixture.supervisor.status().deployId, "next");
  assert.equal(fixture.supervisor.status().accepting, true);
  assert.equal((await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" })).ok, true);
  failWrite = false;

  const reused = await fixture.supervisor.activate({ deployId: "next", expectPrevId: "next" });
  assert.equal(reused.reused, true);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(currentFile, "utf8")).deployId, "next");
  await fixture.supervisor.shutdown();
});

test("재시작 상한 뒤 retryAt이 지나면 host 세대를 반환하고 takeover로 재기동한다", async (t) => {
  const actual = actualRelayFixture();
  const fixture = supervisorFixture({ relay: actual.ports,
    extra: { restartWindowMs: 100, requestWaitMs: 200 } });
  t.after(() => fs.rmSync(fixture.stateDir, { recursive: true, force: true }));
  await fixture.supervisor.start();
  let cappedGeneration = null;
  for (let index = 0; index < 3; index++) {
    const child = fixture.children.filter(item => item.connected).at(-1);
    cappedGeneration = fixture.supervisor.status().workerGeneration;
    child.connected = false;
    child.accepting = false;
    child.emit("exit", 9, null);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 110));

  const response = await fixture.supervisor.request("browser", "tabs", {}, { session: "pane" });

  assert.equal(response.ok, true);
  assert.equal(fixture.control.released.includes(cappedGeneration), true,
    JSON.stringify({ cappedGeneration, released: fixture.control.released }));
  assert.equal(actual.acceptOptions.at(-1).takeover, true);
  assert.equal(fixture.children.filter(child => child.connected && child.accepting).length, 1);
  await fixture.supervisor.shutdown();
});
