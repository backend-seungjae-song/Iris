import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { UNFOCUSED_INTERVAL_MS, createFramePacer } = createRequire(import.meta.url)("../native/electron/emulator/frame-pace.cjs");

function fakeWindow() {
  const win = { focused: true, destroyed: false };
  return Object.assign(win, { isFocused: () => win.focused, isDestroyed: () => win.destroyed });
}

// 20ms 간격(초당 50프레임)으로 들어오는 프레임 중 전달된 수
function sentCount(allow, clock, frames) {
  let sent = 0;
  for (let i = 0; i < frames; i++) { if (allow()) sent++; clock.t += 20; }
  return sent;
}

test("포커스가 있는 창에는 프레임을 전부 전달한다", () => {
  const win = fakeWindow(), clock = { t: 1000 };
  assert.equal(sentCount(createFramePacer(win, () => clock.t), clock, 50), 50);
});

test("포커스가 없는 창에는 초당 5프레임까지만 전달하고, 포커스가 돌아오면 바로 전부 전달한다", () => {
  const win = fakeWindow(), clock = { t: 1000 };
  const allow = createFramePacer(win, () => clock.t);
  win.focused = false;
  assert.equal(sentCount(allow, clock, 50), 1000 / UNFOCUSED_INTERVAL_MS);
  win.focused = true;
  assert.equal(sentCount(allow, clock, 50), 50);
});

test("창이 닫혔거나 상태를 읽지 못하면 프레임을 막지 않는다", () => {
  const clock = { t: 1000 };
  const closed = fakeWindow();
  closed.focused = false; closed.destroyed = true;
  assert.equal(sentCount(createFramePacer(closed, () => clock.t), clock, 10), 10);
  const broken = { isDestroyed: () => false, isFocused: () => { throw new Error("gone"); } };
  assert.equal(sentCount(createFramePacer(broken, () => clock.t), clock, 10), 10);
});
