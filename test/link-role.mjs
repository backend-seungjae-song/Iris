// 링크를 받는 창: 공유 창·콘솔 창만. 공유 스페이스의 탭 분리 창이 공유 창 자리를 가져가면 링크가 닫힌 창으로 감
import assert from "node:assert/strict";
import test from "node:test";
import { linkRole } from "../web/js/browser/link-role.js";

test("공유 창은 shared, 콘솔 창은 session", () => {
  assert.equal(linkRole({ browserMode: true, boundSpace: "__shared__" }), "shared");
  assert.equal(linkRole({ browserMode: false, boundSpace: null }), "session");
});

test("공유 스페이스에서 떼어 낸 탭 분리 창은 링크를 받지 않는다", () => {
  assert.equal(linkRole({ browserMode: true, boundSpace: "__shared__", detachedWin: "w3" }), null);
});

test("메모 창과 스페이스 분리 창은 받지 않는다", () => {
  assert.equal(linkRole({ browserMode: false, memoMode: true }), null);
  assert.equal(linkRole({ browserMode: true, boundSpace: "w18" }), null);
});
