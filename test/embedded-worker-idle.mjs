import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSharedEmbeddedRuntime } from "../server/paseo-ui/embedded-worker.mjs";

test("유휴 검사 중 새 요청이 끝나면 기존 검사 오류로 워커를 종료하지 않는다", async t => {
  const worker = new EventEmitter();
  let probes = 0, closed = 0;
  let failedProbe;
  const probeStarted = new Promise(resolve => {
    worker.postMessage = ({ id, method }) => {
      if (method === "canDispose" && ++probes === 1) {
        failedProbe = () => worker.emit("message", { id, error: "유휴 검사 실패" });
        resolve();
        return;
      }
      if (method === "close") closed++;
      queueMicrotask(() => worker.emit("message", { id, value: true }));
    };
  });
  worker.terminate = async () => {};
  const runtime = createSharedEmbeddedRuntime({ runtime: "/tmp/unused-paseo-runtime", stateDir: "/tmp/unused-paseo-state" }, { workerFactory: () => worker, idleMs: 30 });
  t.after(() => runtime.close());
  await runtime.snapshot("one");
  let deadline;
  try {
    await Promise.race([probeStarted, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("유휴 검사 대기 시간 초과")), 2000);
    })]);
  } finally { clearTimeout(deadline); }
  await runtime.snapshot("two");
  failedProbe();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 0);
  for (let n = 0; n < 100 && !closed; n++) await delay(10);
  assert.equal(probes, 2);
  assert.equal(closed, 1);
});
