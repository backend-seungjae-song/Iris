import assert from "node:assert/strict";
import test from "node:test";

import { initAgents } from "../web/js/herdr/agents.js";
import { replaceHerdrState } from "../web/js/herdr/state.js";
import { followInputFocus, herdrShowsOther, initHerdrSync, markHerdrUserSelect, scheduleHerdrSync } from "../web/js/herdr/sync.js";

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
    focusInput: () => { focused.push(cur); },
  });
  const focused = [];
  return { current: () => cur, select: (pane) => { markHerdrUserSelect(); cur = pane; tName.textContent = pane; }, tName, focused };
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

// 셸 pane 은 에이전트 목록에 없어 선택이 바뀌지 않음. 그동안 대화 화면이 이전 세션을 덮고 있으면 터미널이 안 보임
test("herdr 가 에이전트 아닌 pane 을 보이면 선택은 두고 그 상태를 알리고, 돌아오면 푼다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 300_000 });
  const ui = setup();
  ui.select("w1:p2");
  for (let i = 0; i < 20; i++) t.mock.timers.tick(100);
  scheduleHerdrSync(null);
  assert.equal(herdrShowsOther(), false); // 연속 방송을 묶는 대기 전
  for (let i = 0; i < 3; i++) t.mock.timers.tick(100);
  assert.equal(herdrShowsOther(), true);
  assert.equal(ui.current(), "w1:p2");
  scheduleHerdrSync("w1:p2"); // herdr 에서 그 세션으로 돌아옴
  assert.equal(herdrShowsOther(), false);
  scheduleHerdrSync(null);
  for (let i = 0; i < 3; i++) t.mock.timers.tick(100);
  scheduleHerdrSync("w1:p3"); // 셸에서 다른 에이전트로
  for (let i = 0; i < 3; i++) t.mock.timers.tick(100);
  assert.equal(herdrShowsOther(), false);
  assert.equal(ui.current(), "w1:p3");
});

test("사용자 선택 직후의 에이전트 없는 포커스 방송은 쿨다운 동안 대화 화면을 닫지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 400_000 });
  const ui = setup();
  ui.select("w1:p2");
  scheduleHerdrSync(null); // 고른 pane 으로 포커스가 옮겨지기 전 방송
  for (let i = 0; i < 5; i++) t.mock.timers.tick(100);
  assert.equal(herdrShowsOther(), false);
  scheduleHerdrSync("w1:p2");
  for (let i = 0; i < 30; i++) t.mock.timers.tick(100);
  assert.equal(herdrShowsOther(), false);
});

// ⌥←→ 는 herdr 에 탭 이동만 요청. 옮긴 결과가 방송으로 오면 그곳(대화 입력창·터미널)에 키 입력이 가야 함
test("탭 이동 요청 뒤 herdr 가 옮긴 곳에 키 입력 포커스를 준다(중간의 pane 없음 방송 뒤에도)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 500_000 });
  const ui = setup();
  ui.select("w1:p1");
  for (let i = 0; i < 20; i++) t.mock.timers.tick(100);
  followInputFocus();
  scheduleHerdrSync(null); // 탭만 고른 요청의 추정 방송: 포커스 pane 없음
  for (let i = 0; i < 2; i++) t.mock.timers.tick(100);
  scheduleHerdrSync("w1:p2"); // 실제 포커스
  for (let i = 0; i < 3; i++) t.mock.timers.tick(100);
  assert.equal(ui.current(), "w1:p2");
  assert.equal(ui.focused.at(-1), "w1:p2");
});

test("요청 없이 herdr 쪽에서 옮긴 것은 포커스를 가져가지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 600_000 });
  const ui = setup();
  ui.select("w1:p1");
  for (let i = 0; i < 20; i++) t.mock.timers.tick(100);
  scheduleHerdrSync("w1:p3");
  for (let i = 0; i < 3; i++) t.mock.timers.tick(100);
  assert.equal(ui.current(), "w1:p3");
  assert.deepEqual(ui.focused, []);
});
