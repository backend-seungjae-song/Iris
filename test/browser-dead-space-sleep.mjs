// 닫은 스페이스 탭 재우기: 보고 있는 탭과 스페이스 목록을 받기 전에는 재우지 않음
import assert from "node:assert/strict";
import test from "node:test";

const { sleepsWithDeadSpace } = await import("../web/js/browser/webview.js");
const LIVE = [{ id: "w1" }];

test("닫은 스페이스의 보고 있지 않은 탭은 재운다", () => {
  assert.equal(sleepsWithDeadSpace("browser:a", "w-gone", "browser:b", LIVE), true);
  assert.equal(sleepsWithDeadSpace("browser:a", "w1", "browser:b", LIVE), false, "살아 있는 스페이스");
  assert.equal(sleepsWithDeadSpace("browser:a", "__shared__", "browser:b", LIVE), false, "공유 탭");
});

test("보고 있는 탭은 스페이스가 목록에 없어도 재우지 않는다", () => {
  assert.equal(sleepsWithDeadSpace("browser:a", "w-gone", "browser:a", LIVE), false);
});

test("앱을 막 켜 스페이스 목록이 비어 있으면 재우지 않는다", () => {
  assert.equal(sleepsWithDeadSpace("browser:a", "w1", "browser:b", []), false);
  assert.equal(sleepsWithDeadSpace("browser:a", "w1", "browser:b", null), false);
});
