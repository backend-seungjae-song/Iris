import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// HTABS_SRC: 고치기 전 판의 herdr-tabs.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ HTABS_SRC: "/js/panel/herdr-tabs.js" });

test("상태 방송으로 터미널 탭 줄을 다시 그려도 사람이 넘긴 가로 위치를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const { replaceHerdrState } = await import("/js/herdr/state.js");
    const tabsMod = await import("/js/panel/herdr-tabs.js");
    const tabs = (status = "idle", focus = 0) => Array.from({ length: 14 }, (_, i) => ({ tabId: `t${i}`, number: i + 1, label: `긴 이름의 터미널 ${i}`, focused: i === focus, agentStatus: i === 3 ? status : null }));
    const state = (status, focus) => replaceHerdrState({ workspaces: [{ id: "w" }], agents: [], tabs: { w: tabs(status, focus) } });
    state("idle", 0);
    tabsMod.initHerdrTabs({ $: (s) => document.querySelector(s), wsSend() {}, showToast() {}, getIsLocal: () => true, getSelectedSpaceId: () => "w", onLayoutChange() {} });
    const box = () => document.querySelector("#htabs .htab-scroll");
    box().scrollLeft = 300;
    const set = box().scrollLeft;
    state("idle", 0); tabsMod.renderHerdrTabs();
    const same = box().scrollLeft;
    state("working", 0); tabsMod.renderHerdrTabs();
    const changed = box().scrollLeft;
    state("working", 13); tabsMod.renderHerdrTabs();
    const on = document.querySelector("#htabs .htab.on").getBoundingClientRect(), b = box().getBoundingClientRect();
    return { set, same, changed, focusedVisible: on.left >= b.left - 0.5 && on.right <= b.right + 0.5 };
  }), { body: `<link rel="stylesheet" href="/css/19-terminal.css"><div id="htabs" class="htabs" style="display:flex;width:320px"></div>`, overrides });
  assert.ok(r.set > 0, "넘길 만큼 탭이 넘침");
  assert.equal(r.same, r.set, "같은 상태로 다시 그려도 위치 유지");
  assert.equal(r.changed, r.set, "다른 탭의 상태 점만 바뀌어도 위치 유지");
  assert.equal(r.focusedVisible, true, "보고 있는 탭이 바뀌면 그 탭을 보여 줌");
});
