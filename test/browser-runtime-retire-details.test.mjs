import assert from "node:assert/strict";
import test from "node:test";

// worker 세대 회수 실패의 남은 자원 목록이 서버에서 빠지면 무엇이 남았는지 알 수 없었음(2026-11-03 install:app worker 교체 실패)
test("세대 회수 실패 응답의 details 를 호출자에게 그대로 넘긴다", async () => {
  const runtime = await import("../server/browser-runtime.js");
  const ws = { readyState: 1, send(raw) {
    const m = JSON.parse(raw);
    queueMicrotask(() => runtime.resolveCdpResult(ws, { type: "worker.retired", id: m.id, ok: false,
      error: "이전 작업 프로세스 세대의 자원을 모두 반환하지 못했습니다.", code: "RESOURCE_RELEASE_FAILED",
      details: { count: 1, leftovers: ["viewport:7"] } }));
  } };
  runtime.registerCdpExecutor(ws, { app: "test", pid: process.pid });
  const result = await runtime.requestWorkerGeneration("worker.retire", "boot:1", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESOURCE_RELEASE_FAILED");
  assert.deepEqual(result.details, { count: 1, leftovers: ["viewport:7"] });
});
