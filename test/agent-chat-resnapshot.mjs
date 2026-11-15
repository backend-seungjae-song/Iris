import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import { RESNAPSHOT_APPENDED, needsResnapshot } from "../web/js/agentchat/resnapshot.js";

test("이어 붙인 메시지가 상한을 넘으면 최근 기록을 다시 받는다", () => {
  assert.equal(needsResnapshot({ appended: RESNAPSHOT_APPENDED }), false);
  assert.equal(needsResnapshot({ appended: RESNAPSHOT_APPENDED + 1 }), true);
});

test("이전 기록을 불러오는 중이거나 보기가 없으면 다시 받지 않는다", () => {
  assert.equal(needsResnapshot({ appended: RESNAPSHOT_APPENDED + 1, loadingOlder: true }), false);
  assert.equal(needsResnapshot(null), false);
  assert.equal(needsResnapshot({}), false);
});

test("대화 보기는 이어 붙인 수를 세고 상한을 넘으면 구독을 다시 연다", () => {
  const boot = fs.readFileSync(new URL("../web/js/agentchat/boot.js", import.meta.url), "utf8");
  const onFrame = sliceBetween(boot, "function onFrame(", "function syncHint(", "onFrame");
  assert.match(onFrame, /view\.appended = 0;[\s\S]*kind === "append"/, "새 기록을 받으면 센 수를 0으로 되돌린다");
  assert.match(onFrame, /view\.appended = \(view\.appended \|\| 0\) \+ added\.length/, "이어 붙인 수를 센다");
  assert.match(onFrame, /needsResnapshot\(view\)\)\s*\{[\s\S]*unsubscribe\(\);\s*subscribe\(\);/, "상한을 넘으면 구독을 다시 연다");
});
