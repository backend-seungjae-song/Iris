import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);

// QA 입력이 사용자가 치는 중에 포커스를 빌려 사용자 키가 QA 탭으로 감(사용자 2026-10-29)

test("사용자가 다른 곳에서 치는 중이면 빌리지 않고 기다림", () => {
  const { qaFocusPlan } = require("../native/electron/user-focus.cjs");
  const typingElsewhere = { owns: false, idle: false, windowFocused: true };
  assert.equal(qaFocusPlan({ owns: true, idle: false, windowFocused: true }, false), "trusted");
  assert.equal(qaFocusPlan({ owns: false, idle: true, windowFocused: false }, false), "claim");
  assert.equal(qaFocusPlan(typingElsewhere, false), "wait");
  assert.equal(qaFocusPlan(typingElsewhere, true), "borrow");
});

test("사용자 키 시각은 조용한 시간이 지나야 조용함", () => {
  const { userQuiet } = require("../native/electron/user-focus.cjs");
  assert.equal(userQuiet(0, 10_000), true, "친 적 없음");
  assert.equal(userQuiet(9_000, 10_000), false);
  assert.equal(userQuiet(8_000, 10_000), true);
});

test("모든 화면의 키 입력이 사용자 키 시각을 갱신하고 AI 가 조작 중인 탭 키는 제외", () => {
  const main = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  const hook = sliceBetween(main, 'app.on("web-contents-created", (_event, contents) => {', "\n});", "web-contents-created");
  assert.match(hook, /before-input-event[\s\S]*noteUserKey\(contents\.id\)/);
  const control = readFileSync(new URL("../native/electron/cdp-control.cjs", import.meta.url), "utf8");
  assert.match(sliceBetween(control, "function noteUserKey(", "\n}", "noteUserKey"), /aiDriving\(/);
});

test("포커스를 빌리기 전에 입력 기록 준비를 끝냄", () => {
  const src = readFileSync(new URL("../native/electron/cdp-qa-input.cjs", import.meta.url), "utf8");
  const arm = src.indexOf("const recorder = await armCapture(send, wc);");
  const focus = src.indexOf("await prepareFocus(wc)");
  assert.ok(arm > 0 && focus > 0 && arm < focus);
});
