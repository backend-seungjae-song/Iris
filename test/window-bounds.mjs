import assert from "node:assert/strict";
import test from "node:test";

import { boundsVisible } from "../native/electron/window-bounds.cjs";

// 예시 배치: 내장 하나와 외장 둘.
const INTERNAL = { workArea: { x: 0, y: 25, width: 1728, height: 1092 } };
const LEFT = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
const RIGHT = { workArea: { x: 1920, y: 32, width: 1920, height: 1083 } };

const MAIN = { x: 96, y: 25, width: 1728, height: 1017 };
const BROWSER = { x: -1510, y: 130, width: 1100, height: 820 };
const MEMO = { x: 3217, y: 34, width: 429, height: 1081 };

test("외장 모니터가 아직 안 붙은 시점에는 그 모니터의 창이 갈 곳이 없다", () => {
  // 로그인·깨어남 직후 실제로 발생하는 상태다. 내장 하나만 보인다.
  assert.equal(boundsVisible(MAIN, [INTERNAL]), true);
  assert.equal(boundsVisible(BROWSER, [INTERNAL]), false);
  assert.equal(boundsVisible(MEMO, [INTERNAL]), false);
});

test("모니터가 다 붙으면 세 창 모두 제 자리로 돌아간다", () => {
  const all = [INTERNAL, LEFT, RIGHT];
  for (const b of [MAIN, BROWSER, MEMO]) assert.equal(boundsVisible(b, all), true);
});

test("모니터가 하나만 돌아와도 그 모니터의 창만 자리를 얻는다", () => {
  // display-added가 올 때마다 전부 되돌리면 안 된다. 아직 없는 모니터의 창은 계속 기다려야 한다.
  assert.equal(boundsVisible(BROWSER, [INTERNAL, LEFT]), true);
  assert.equal(boundsVisible(MEMO, [INTERNAL, LEFT]), false);
});

test("살짝 걸치기만 하는 자리는 복원하지 않는다", () => {
  // 모니터를 재배치했을 때 화면 밖으로 거의 나간 창이 그대로 복원되면 조작할 수 없다.
  assert.equal(boundsVisible({ x: 1728 - 100, y: 25, width: 400, height: 300 }, [INTERNAL]), false);
  assert.equal(boundsVisible({ x: 1728 - 300, y: 25, width: 400, height: 300 }, [INTERNAL]), true);
});

test("망가진 값과 비정상 소형은 복원하지 않는다", () => {
  const all = [INTERNAL, LEFT, RIGHT];
  assert.equal(boundsVisible(null, all), false);
  assert.equal(boundsVisible({ x: 0, y: 0, width: 100, height: 100 }, all), false);
  assert.equal(boundsVisible({ x: NaN, y: 0, width: 800, height: 600 }, all), false);
  assert.equal(boundsVisible({ x: 0, y: 0, width: 800 }, all), false);
});

test("모니터 목록을 못 얻으면 복원하지 않는다", () => {
  // screen을 못 읽는 상황에서 아무 자리에나 놓느니 기본 자리가 낫다.
  assert.equal(boundsVisible(MAIN, []), false);
  assert.equal(boundsVisible(MAIN, undefined), false);
});
