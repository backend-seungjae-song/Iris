import assert from "node:assert/strict";
import test from "node:test";

import { resetFocusEpoch } from "../server/focus-epoch.js";
import { handleFocus, initHerdrHandlers } from "../server/herdr-handlers.js";
import { initRuntimeState } from "../server/runtime-state.js";
import { buildWorkspaceSnapshot, initWorkspaceRuntime } from "../server/workspace-runtime.js";

// herdr 호출은 하나에 약 100ms 걸린다. 포커스 요청이 끝나기 전에 agent.list 를 받은 snapshot 은 옛 포커스를
// 담고 있어서, 창이 그 방송을 믿으면 사용자가 고른 세션을 직전 세션으로 되돌린다.
// 이 검사가 없으면 focusStale 표시를 지워도 단위 검사는 전부 통과하고 증상은 사람이 빠르게 고를 때만 나타난다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agents = [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "shell", status: "idle", cwd: "/tmp" }];

function herdrMock({ delay = 0, log = [] } = {}) {
  const call = async (name, value) => { log.push(`start ${name}`); await sleep(delay); log.push(`end ${name}`); return value; };
  return {
    log,
    agentList: () => call("agent.list", agents),
    workspaceList: () => call("workspace.list", []),
    tabList: (w) => call(`tab.list ${w}`, [{ tab_id: "w1:t1", number: 1, focused: true }]),
    tabFocus: (t) => call(`tab.focus ${t}`, {}),
    paneZoom: (p) => call(`pane.zoom ${p}`, {}),
    paneGet: (p) => call(`pane.get ${p}`, { tab_id: "w1:t1" }),
  };
}

test("agent·workspace 목록을 함께 묻고 tab 목록은 그 직후 한 번에 묻는다", async () => {
  resetFocusEpoch();
  const herdr = herdrMock({ delay: 5 });
  initWorkspaceRuntime({ herdr, requestRecompute() {}, broadcast() {} });
  const snap = await buildWorkspaceSnapshot();
  const firstEnd = herdr.log.findIndex((l) => l.startsWith("end "));
  const together = herdr.log.slice(0, firstEnd);
  assert.ok(together.includes("start agent.list") && together.includes("start workspace.list"), "두 목록은 서로를 기다리지 않는다");
  assert.ok(herdr.log.includes("start tab.list w1"));
  assert.deepEqual(snap.tabs, { w1: [{ tabId: "w1:t1", number: 1, label: "", focused: true, agentStatus: null, paneCount: 0 }] });
  assert.equal(snap.state[0].tabId, "w1:t1");
  assert.equal(snap.focusStale, false);
  // 두 번째 회차는 직전 회차가 본 workspace 의 tab 목록을 목록 응답을 기다리지 않고 함께 묻는다.
  herdr.log.length = 0;
  await buildWorkspaceSnapshot();
  const secondFirstEnd = herdr.log.findIndex((l) => l.startsWith("end "));
  assert.ok(herdr.log.slice(0, secondFirstEnd).includes("start tab.list w1"), `tab.list 가 첫 왕복에 들어가야 한다: ${herdr.log.join(" | ")}`);
});

test("포커스 요청이 진행 중인 동안 만든 snapshot 은 focusStale 이다", async () => {
  resetFocusEpoch();
  let release;
  const gate = new Promise((r) => { release = r; });
  const herdr = herdrMock();
  herdr.tabFocus = async () => { await gate; };
  initRuntimeState({ scheduleRecompute: async () => {} });
  initHerdrHandlers({ herdr, ptyManager: { clients: () => [] }, broadcastLocal() {} });
  initWorkspaceRuntime({ herdr, requestRecompute() {}, broadcast() {} });
  const ws = { _local: true, readyState: 1, send: () => assert.fail("포커스 오류가 나면 안 된다") };
  const focusing = handleFocus(ws, { target: "w1:p1" });
  const during = await buildWorkspaceSnapshot();
  assert.equal(during.focusStale, true, "tab.focus 가 끝나기 전의 snapshot");
  release();
  await focusing;
  const after = await buildWorkspaceSnapshot();
  assert.equal(after.focusStale, false, "포커스가 끝난 뒤 새로 만든 snapshot");
});

test("snapshot 을 만드는 사이에 포커스가 끝나도 focusStale 이다", async () => {
  resetFocusEpoch();
  const herdr = herdrMock();
  let finishFocus;
  herdr.agentList = async () => { finishFocus = handleFocus(ws, { target: "w1:p1" }); await finishFocus; return agents; };
  initRuntimeState({ scheduleRecompute: async () => {} });
  initHerdrHandlers({ herdr, ptyManager: { clients: () => [] }, broadcastLocal() {} });
  initWorkspaceRuntime({ herdr, requestRecompute() {}, broadcast() {} });
  const ws = { _local: true, readyState: 1, send: () => assert.fail("포커스 오류가 나면 안 된다") };
  const snap = await buildWorkspaceSnapshot();
  assert.equal(snap.focusStale, true);
});
