import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);

// 이미 보이는 탭을 캡처용으로 올리면 그 탭이 화면 전체 크기·투명으로 바뀌어 깜박이고 크기가 바뀜
// (2026-10-29 사용자 동행 QA 중 앞에 띄운 QA 탭)

test("보이는 탭은 캡처 유지를 걸지 않고 안 보이는 탭만 검", () => {
  const { needsHold } = require("../native/electron/capture-hold.cjs");
  assert.equal(needsHold(true, true), false);
  assert.equal(needsHold(true, false), true);
  assert.equal(needsHold(false, true), true, "해제는 보임과 관계없이 진행");
  assert.equal(needsHold(false, false), true);
});

test("main 의 캡처 유지는 렌더러를 바꾸기 전에 보이는 탭을 걸러냄", () => {
  const src = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  const body = sliceBetween(src, "setCaptureHold(async", "\n});", "setCaptureHold");
  const check = body.indexOf("needsHold(");
  assert.ok(check > 0, "needsHold 판정 없음");
  assert.ok(check < body.indexOf("setThrottleReason("), "판정이 throttle 변경보다 먼저");
  assert.ok(check < body.indexOf('host.send("ac-capture-hold"'), "판정이 렌더러 전송보다 먼저");
});
