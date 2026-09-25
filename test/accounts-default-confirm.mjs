import assert from "node:assert/strict";
import { test, mock } from "node:test";

// 스페이스 기본 계정을 고르면 서버가 그 값을 담은 상태를 보낸 뒤에 저장됐다고 알린다.
// 제한 시간 안에 오지 않으면 저장하지 못했다고 알린다.
mock.timers.enable({ apis: ["setTimeout"] });
const state = await import("../web/js/browser/state.js");
const screen = await import("../web/js/browser/accounts-screen.js");
const hooks = await import("../web/js/core/hooks.js");

const sent = [], toasts = [];
state.initBrowserState({ wsSend: (m) => sent.push(m) });
state.replaceBrowserState({ profiles: [{ id: "p1", name: "손님" }], defaultProfileBySpace: {} });
let onChange = null;
const body = { isConnected: false, addEventListener(t, fn) { if (t === "change") onChange = fn; } };
hooks.clearHooks();
screen.initCapability({
  $: (q) => (q === "#acct-body" ? body : null), esc: (s) => s, cssEsc: (s) => s, browserMode: false,
  showToast: (t) => toasts.push(t), orderedSpaces: () => [],
});
const pick = (space, value) => onChange({ target: { closest: () => ({ dataset: { spaceDef: space }, value }) } });
const serverState = (defaults) => {
  state.replaceBrowserState({ profiles: [{ id: "p1", name: "손님" }], defaultProfileBySpace: defaults });
  hooks.callHook("accounts.stateChanged");
};

test("서버 상태가 오기 전에는 저장됐다고 알리지 않는다", () => {
  pick("s1", "p1");
  assert.equal(sent.at(-1).mutation.op, "space.defaultProfile");
  assert.deepEqual(toasts, []);
  serverState({});                       // 다른 변경으로 온 상태에는 아직 옛 값
  assert.deepEqual(toasts, []);
  serverState({ s1: "p1" });
  assert.deepEqual(toasts, ["스페이스 기본 계정 저장됨"]);
  mock.timers.tick(10000);
  assert.equal(toasts.length, 1, "확인 뒤에 실패 알림이 또 떴다");
});

test("서버 상태로 확인되지 않으면 저장하지 못했다고 알린다", () => {
  toasts.length = 0;
  pick("s2", "p1");
  mock.timers.tick(4999);
  assert.deepEqual(toasts, []);
  mock.timers.tick(1);
  assert.deepEqual(toasts, ["스페이스 기본 계정을 저장하지 못했습니다"]);
  serverState({ s1: "p1", s2: "p1" });   // 늦게 온 상태로 성공을 다시 주장하지 않는다
  assert.equal(toasts.length, 1);
});
