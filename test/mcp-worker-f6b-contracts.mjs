import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostIdentityAuthority } from "../server/mcp-host/identity.js";
import { createMcpHostHandlers } from "../server/mcp-host/handlers.js";
import { HOST_OPERATION_DEFINITIONS } from "../server/mcp-host/operations.js";
import { createMcpWorkerSupervisor } from "../server/mcp-worker/supervisor.js";
import { createWorkerLock, workerLockOwnerAlive } from "../server/mcp-worker/worker-lock.js";

test("app.targetsGet 읽기 오류는 기존 사용자 문구로 반환한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f6b-targets-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, "app-targets.json"), "{");
  const handlers = createMcpHostHandlers({ appTargetOptions: { stateDir } });

  const result = await handlers["app.targetsGet"]({ identity: { session: "pane-a" }, input: {} });

  assert.equal(result.ok, false);
  assert.match(result.error, /^기기 등록을 읽지 못했습니다:/);
});

test("qa.tabCreate는 긴 탐색 동안 세션 전체 잠금을 점유하지 않는다", () => {
  const locks = HOST_OPERATION_DEFINITIONS["qa.tabCreate"].locks({
    identity: { session: "pane-a", run: "run-a" }, input: { url: "https://example.test/" },
  });
  assert.equal(locks.includes("session:pane-a"), false);
  assert.equal(locks.includes("run:run-a"), true);
});

test("시작 시각을 읽지 못해도 살아 있는 PID의 잠금은 회수하지 않는다", () => {
  const alive = workerLockOwnerAlive({
    pid: 777,
    workerGeneration: "old:1",
    processStartedAt: null,
  }, {
    isProcessAlive: () => true,
    getProcessStartedAt: () => null,
  });
  assert.equal(alive, true);
});

test("살아 있는 PID의 만료된 잠금은 새 worker가 회수하지 않는다", (t) => {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f7b-live-lock-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const file = path.join(stateDir, "worker.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 777, workerGeneration: "old:1", processStartedAt: null,
    leaseId: "old-lease" }));
  const lock = createWorkerLock({ file, pid: 888, workerGeneration: "new:1",
    isProcessAlive: pid => pid === 777, processStartedAt: () => null, heartbeatIntervalMs: 60_000 });

  assert.throws(() => lock.acquire(), error => error.code === "BUSY");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).leaseId, "old-lease");
});

test("잠금 소유권 확인 파일 교체 실패는 worker 타이머 밖으로 예외를 내보내지 않는다", (t) => {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f6b-heartbeat-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const file = path.join(stateDir, "worker.lock");
  const lock = createWorkerLock({ file, heartbeatIntervalMs: 60_000, processStartedAt: () => null });
  lock.acquire();
  t.after(() => lock.release());
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")), "heartbeatAt"), false);
  const renameSync = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("fixture rename failure"), { code: "EIO" }); };
  t.after(() => { fs.renameSync = renameSync; });

  assert.doesNotThrow(() => assert.equal(lock.pulse(), false));
});

test("잠금 대기는 시작 시각을 한 번 읽고 반복해서 PID 생존만 확인한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f6b-lock-wait-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const file = path.join(stateDir, "mcp-worker", "worker.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 777, workerGeneration: "old:1", processStartedAt: "same" }));
  let aliveChecks = 0;
  let startedAtChecks = 0;
  const supervisor = createMcpWorkerSupervisor({
    stateDir,
    bundleId: "bundle",
    maxRestarts: 0,
    workerLockPollMs: 1,
    workerLockWaitMs: 100,
    isProcessAlive: () => { aliveChecks += 1; return true; },
    getProcessStartedAt: () => { startedAtChecks += 1; return "same"; },
    spawnWorker: () => { throw Object.assign(new Error("fixture stop"), { code: "FIXTURE_STOP" }); },
    identityAuthority: createHostIdentityAuthority(),
    hostDispatcher: () => ({ dispatch: async () => ({}) }),
    log: { info() {} },
  });
  setTimeout(() => fs.unlinkSync(file), 10);

  await assert.rejects(supervisor.start(), error => error.code === "FIXTURE_STOP");
  assert.equal(startedAtChecks, 1);
  assert.ok(aliveChecks > 1);
});
