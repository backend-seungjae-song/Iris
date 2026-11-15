import assert from "node:assert/strict";
import test from "node:test";
import { createStepKit } from "../server/mcp-worker/step-kit.js";

test("결과 가리기가 실패하면 원인을 함께 알림 · 원인이 없으면 기존 문구", async () => {
  const kit = (response) => createStepKit(async () => ({ raw: { commandState: "completed" }, response }));
  assert.deepEqual(await kit({ ok: false, error: "단위 시간 초과" }).redacted({ ok: true, data: 1 }, true),
    { ok: false, error: "결과를 안전하게 가리지 못했습니다(단위 시간 초과)." });
  assert.deepEqual(await kit({ ok: false }).redacted({ ok: true, data: 1 }, true),
    { ok: false, error: "결과를 안전하게 가리지 못했습니다." });
  assert.deepEqual(await kit({ ok: true, data: { value: 5 } }).redacted(5, true), 5);
});
