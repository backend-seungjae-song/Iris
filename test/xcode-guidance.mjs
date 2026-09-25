import assert from "node:assert/strict";
import { test } from "node:test";
import { xcodeGuidance } from "../web/js/emulator/xcode-guidance.js";

test("Xcode 설치·선택 문제에 서로 다른 작업을 제시한다", () => {
  for (const [status, action] of [["missing", "download"], ["repair", "select"], ["choose", "select"], ["incomplete", "open"]]) {
    assert.equal(xcodeGuidance({ xcode: { status } }).action, action);
  }
  assert.equal(xcodeGuidance({ xcode: { status: "missing" } }).secondaryAction, "select");
});

test("시뮬레이터 누락을 Xcode 설정으로 안내하고 정상 상태에는 작업을 만들지 않는다", () => {
  assert.equal(xcodeGuidance({ xcode: { status: "ready" }, simctl: { ok: false, message: "No iOS simulators found." } }).action, "open");
  assert.equal(xcodeGuidance({ xcode: { status: "ready" }, simctl: { ok: true } }), null);
  assert.equal(xcodeGuidance({}), null);
});
