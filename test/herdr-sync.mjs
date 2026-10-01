import assert from "node:assert/strict";
import test from "node:test";

import { initAgents } from "../web/js/herdr/agents.js";
import { replaceHerdrState } from "../web/js/herdr/state.js";
import { initHerdrSync, markHerdrUserSelect, scheduleHerdrSync } from "../web/js/herdr/sync.js";

// 오른쪽 머리 이름은 사람이 입력 대상을 확인하는 곳. 사용자 입력은 herdr 포커스 pane 으로 가므로
// 머리가 가리키는 세션과 herdr 포커스가 계속 다르면 입력이 엉뚱한 세션에 들어간다.
function setup() {
  globalThis.document = { createElement: () => ({}) };
  let cur = "w1:p1";
  const list = { innerHTML: "", addEventListener() {}, querySelector: () => null };
  initAgents({
    $: () => list, esc: String, cssEsc: String, wsSend() {},
    getIsLocal: () => true, getCurTarget: () => cur, orderedSpaces: () => [{ id: "w1" }], spk: String,
    saveCollapsed() {}, selectSession() {}, copyText: async () => true, showToast() {},
    getSelectedSpaceId: () => "w1", collapsed: { groups: new Set() }, renderSpaces() {},
  });
  replaceHerdrState({ agents: ["w1:p1", "w1:p2", "w1:p3"].map((paneId) => ({
    paneId, workspaceId: "w1", tabId: paneId.replace(":p", ":t"), agent: "claude", status: "idle", tabLabel: paneId,
  })) });
  const tName = { textContent: "w1:p1" };
  const tSub = { innerHTML: "", append() {} };
  const tDot = { className: "", title: "", setAttribute() {} };
  initHerdrSync({
    getCurTarget: () => cur, setCurTarget: (value) => { cur = value; },
    getSelectedSpaceId: () => "w1", switchToSpaceOf() {}, lastAgentBySpace: {}, tName, tSub, tDot,
  });
  return { current: () => cur, select: (pane) => { markHerdrUserSelect(); cur = pane; tName.textContent = pane; }, tName };
}

test("사용자 선택 직후에 옮겨 간 herdr 포커스도 쿨다운이 끝나면 머리에 반영된다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const ui = setup();
  ui.select("w1:p2");
  t.mock.timers.tick(200);
  scheduleHerdrSync("w1:p3"); // 선택 0.2초 뒤 다른 경로(탭줄·⌥←→·herdr 단축키)로 포커스가 p3 로 감
  for (let i = 0; i < 20; i++) t.mock.timers.tick(100); // 한 번에 넘기면 모의 시계가 끝 시각에서 타이머를 부름
  assert.equal(ui.current(), "w1:p3");
  assert.equal(ui.tName.textContent, "w1:p3");
});

test("대기 중 herdr 포커스가 선택과 같아지면 옛 포커스로 되돌리지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 200_000 });
  const ui = setup();
  ui.select("w1:p2");
  for (let i = 0; i < 13; i++) t.mock.timers.tick(100);
  scheduleHerdrSync("w1:p1"); // 쿨다운 끝 무렵 도착한 옛 포커스 방송
  scheduleHerdrSync("w1:p2"); // herdr 가 선택을 반영한 방송
  for (let i = 0; i < 50; i++) t.mock.timers.tick(100);
  assert.equal(ui.current(), "w1:p2");
});
