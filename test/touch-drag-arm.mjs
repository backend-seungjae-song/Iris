import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createTouchDragArm } = require("../native/electron/touch-drag-arm.cjs");

// 마우스→터치 변환이 켜지면 창 안의 마우스 이동이 렌더러에 오지 않는다. 렌더러가 손잡이 위에서 끄는 신호를
// 받지 못하므로, 변환은 커서가 페이지 영역 안에 있을 때만 켜져 있어야 손잡이·탭 줄을 마우스로 누를 수 있다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig() {
  const cursor = { x: 0, y: 0 };
  const calls = [];
  const win = { getContentBounds: () => ({ x: 100, y: 50, width: 1100, height: 820 }), isDestroyed: () => false };
  const host = { zoom: 1, getZoomFactor() { return this.zoom; }, isDestroyed: () => false };
  const mk = (id) => ({ id, hostWebContents: host, isDestroyed: () => false });
  const arm = createTouchDragArm({
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    BrowserWindow: { fromWebContents: (h) => (h === host ? win : null) },
    setTouchDrag: async (wc, on) => { calls.push(`${wc.id}:${on ? "on" : "off"}`); return { ok: true, on }; },
    intervalMs: 5,
  });
  return { cursor, calls, host, mk, arm: arm.arm };
}

// 페이지 영역: 창 내용 기준 x 349~739, y 153~820
const RECT = { x: 349, y: 153, w: 390, h: 667 };
const at = (c, x, y) => { c.x = 100 + x; c.y = 50 + y; };

test("커서가 페이지 밖 손잡이로 가면 변환을 끄고 돌아오면 다시 켠다", async (t) => {
  const r = rig(); const a = r.mk(1);
  t.after(() => r.arm(a, false));
  at(r.cursor, 500, 400);
  assert.deepEqual(await r.arm(a, RECT), { ok: true, on: true });
  at(r.cursor, 746, 400); await sleep(30);
  assert.deepEqual(r.calls, ["1:on", "1:off"]);
  at(r.cursor, 600, 300); await sleep(30);
  assert.deepEqual(r.calls, ["1:on", "1:off", "1:on"]);
});

test("영역 밖에서 무장하면 켜지 않는다", async (t) => {
  const r = rig(); const a = r.mk(1);
  t.after(() => r.arm(a, false));
  at(r.cursor, 500, 20);
  assert.deepEqual(await r.arm(a, RECT), { ok: true, on: false });
  await sleep(30);
  assert.deepEqual(r.calls, []);
});

test("해제하면 끄고 더는 확인하지 않는다", async () => {
  const r = rig(); const a = r.mk(1);
  at(r.cursor, 500, 400);
  await r.arm(a, RECT);
  await r.arm(a, false);
  at(r.cursor, 10, 10); await sleep(20); at(r.cursor, 500, 400); await sleep(20);
  assert.deepEqual(r.calls, ["1:on", "1:off"]);
});

test("다른 탭으로 무장하면 이전 탭의 변환을 끈다", async (t) => {
  const r = rig(); const a = r.mk(1), b = r.mk(2);
  t.after(() => r.arm(b, false));
  at(r.cursor, 500, 400);
  await r.arm(a, RECT);
  await r.arm(b, RECT);
  assert.deepEqual(r.calls, ["1:on", "1:off", "2:on"]);
});

test("같은 탭을 새 영역으로 다시 무장해도 켜진 상태를 끊지 않는다", async (t) => {
  const r = rig(); const a = r.mk(1);
  t.after(() => r.arm(a, false));
  at(r.cursor, 500, 400);
  await r.arm(a, RECT);
  await r.arm(a, { ...RECT, w: 510 });
  at(r.cursor, 800, 400); await sleep(30);
  assert.deepEqual(r.calls, ["1:on"]);
});

test("창 확대 비율을 반영해 영역을 비교한다", async (t) => {
  const r = rig(); const a = r.mk(1);
  t.after(() => r.arm(a, false));
  r.host.zoom = 2;
  at(r.cursor, 500, 400);   // CSS px 로는 (250, 200): 영역 왼쪽 밖
  assert.deepEqual(await r.arm(a, RECT), { ok: true, on: false });
});
