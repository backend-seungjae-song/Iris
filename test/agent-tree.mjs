import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBranchKey, ancestorBranchKeys, buildAgentForest, visibleAgentNodes,
} from "../web/js/herdr/agent-tree.js";
import { initAgents, renderAgents, revealAgentRow } from "../web/js/herdr/agents.js";
import { replaceHerdrState } from "../web/js/herdr/state.js";

const agent = (paneId, parentPaneId = null, extra = {}) => ({
  paneId, parentPaneId, workspaceId: "w1", tabId: `tab-${paneId}`, agent: "codex", ...extra,
});

test("루트와 형제는 받은 탭 순서를 유지하면서 자식만 부모 아래로 모은다", () => {
  const forest = buildAgentForest([
    agent("root-a"), agent("child-a2", "root-a"), agent("root-b"), agent("child-a1", "root-a"),
  ]);
  assert.deepEqual(forest.roots.map((n) => n.agent.paneId), ["root-a", "root-b"]);
  assert.deepEqual(forest.roots[0].children.map((n) => n.agent.paneId), ["child-a2", "child-a1"]);
  assert.deepEqual(visibleAgentNodes(forest, new Set()).map(({ node, depth }) => [node.agent.paneId, depth]), [
    ["root-a", 0], ["child-a2", 1], ["child-a1", 1], ["root-b", 0],
  ]);
});

test("없는·다른 workspace·자기 자신 부모는 행을 숨기지 않는다", () => {
  const rows = [
    agent("missing", "gone"),
    agent("other-parent", null, { workspaceId: "w2" }),
    agent("cross", "other-parent"),
    agent("self", "self"),
  ];
  const forest = buildAgentForest(rows);
  assert.deepEqual(forest.roots.map((n) => n.agent.paneId), rows.map((a) => a.paneId));
  assert.equal(forest.nodes.length, rows.length);
});

test("순환 edge를 끊고 순환으로 들어오는 정상 후손은 한 번만 보인다", () => {
  const forest = buildAgentForest([
    agent("a", "b"), agent("b", "c"), agent("c", "a"), agent("child", "b"), agent("root"),
  ]);
  assert.deepEqual(forest.roots.map((n) => n.agent.paneId), ["a", "b", "c", "root"]);
  assert.deepEqual(forest.roots[1].children.map((n) => n.agent.paneId), ["child"]);
  const visible = visibleAgentNodes(forest, new Set()).map(({ node }) => node.agent.paneId);
  assert.equal(visible.length, 5);
  assert.equal(new Set(visible).size, 5);
});

test("접힌 가지는 후손을 감추고 reveal용 조상 목록은 바깥부터 모두 알려준다", () => {
  const rows = [agent("root"), agent("child", "root"), agent("grandchild", "child")];
  const forest = buildAgentForest(rows);
  const collapsed = new Set([agentBranchKey(rows[0])]);
  assert.deepEqual(visibleAgentNodes(forest, collapsed).map(({ node }) => node.agent.paneId), ["root"]);
  assert.deepEqual(ancestorBranchKeys(forest, "grandchild"), [
    agentBranchKey(rows[1]), agentBranchKey(rows[0]),
  ]);
});

test("중복 pane id는 부모 대상으로 쓰지 않아 어느 행도 잘못 흡수하지 않는다", () => {
  const rows = [agent("dup"), agent("dup"), agent("child", "dup")];
  const forest = buildAgentForest(rows);
  assert.deepEqual(forest.roots.map((n) => n.agent.paneId), ["dup", "dup", "child"]);
});

test("DOM 배선은 토글 클릭을 선택으로 흘리지 않고 reveal 때 조상 가지를 다시 연다", () => {
  const listeners = new Map();
  const row = {
    getBoundingClientRect: () => ({ top: 20, bottom: 42, height: 22 }),
    querySelector: () => null,
  };
  const list = {
    innerHTML: "", scrollTop: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    querySelector(selector) {
      const match = selector.match(/data-target="([^"]+)"/);
      return match && this.innerHTML.includes(`data-target="${match[1]}"`) ? row : null;
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
  };
  const rows = [
    agent("root", null, { tabId: "shared", tabLabel: "공유 탭", subagents: [{
      agentType: "Explore", description: "코드 경로 조사", running: true, children: [],
    }] }),
    agent("child", "root", { tabId: "shared", tabLabel: "공유 탭", lineageLabel: "검증 담당" }),
    agent("solo"),
    agent("solo-2"),
  ];
  replaceHerdrState({
    agents: rows,
    workspaces: [{ id: "w1", label: "작업" }],
    tabs: { w1: [{ tabId: "shared" }, { tabId: "tab-solo" }, { tabId: "tab-solo-2" }] },
  });
  const selected = [];
  let selectedPane = null;
  const sent = [];
  initAgents({
    $: (selector) => selector === "#agent-list" ? list : null,
    esc: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    cssEsc: (value) => String(value), statusClass: (value) => value, wsSend: (message) => sent.push(message),
    getIsLocal: () => true, getCurTarget: () => selectedPane, setCurTarget: (value) => { selectedPane = value; },
    orderedSpaces: () => [{ id: "w1", label: "작업" }], spk: (value) => value,
    saveCollapsed: () => {}, selectSession: (paneId) => { selected.push(paneId); selectedPane = paneId; },
    collapsed: { groups: new Set() },
  });
  renderAgents();

  assert.match(list.innerHTML, /aria-expanded="true"/);
  assert.match(list.innerHTML, /aria-label="공유 탭 하위 에이전트 접기"/);
  assert.match(list.innerHTML, />검증 담당<\/span>/, "child는 공유 탭 이름 대신 lineage 이름을 쓴다");
  assert.match(list.innerHTML, />코드 경로 조사<\/span>/);
  assert.doesNotMatch(list.innerHTML, /data-target="undefined"/, "정보 행은 pane target을 만들지 않는다");
  assert.doesNotMatch(list.innerHTML, /data-tab="shared"/, "여러 pane이 든 탭은 draggable 대상이 아니다");
  assert.match(list.innerHTML, /data-tab="tab-solo"/, "단일-pane 탭은 기존 reorder 대상이다");

  const toggle = {
    dataset: { agentToggle: agentBranchKey(rows[0]) },
    closest: (selector) => selector === ".agent-tree-toggle" ? toggle
      : selector === ".srow" || selector === ".srow[data-tab]" ? { dataset: { target: "root" } } : null,
  };
  let stopped = false;
  listeners.get("click")({ target: toggle, stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(selected, [], "토글 클릭이 부모 session 선택으로 흐르면 안 된다");
  assert.equal(listeners.has("dblclick"), false, "두 번째 행 클릭이 이름 편집으로 바뀌면 안 된다");
  let dragPrevented = false;
  listeners.get("dragstart")({ target: toggle, preventDefault: () => { dragPrevented = true; } });
  assert.equal(dragPrevented, true, "토글에서 시작한 제스처는 부모 탭 drag가 아니다");
  assert.doesNotMatch(list.innerHTML, />검증 담당<\/span>/, "접힌 실제 child가 DOM에서 빠진다");
  assert.doesNotMatch(list.innerHTML, />코드 경로 조사<\/span>/, "접힌 정보 child도 DOM에서 빠진다");
  assert.match(list.innerHTML, /aria-expanded="false"/);

  revealAgentRow("child");
  assert.match(list.innerHTML, />검증 담당<\/span>/, "숨은 child reveal은 조상 가지를 연다");
  assert.match(list.innerHTML, />코드 경로 조사<\/span>/);

  const dragRow = (tab, treeParent) => {
    const el = {
      dataset: { tab, space: "w1", treeParent },
      classList: { add() {}, remove() {} },
    };
    el.closest = (selector) => selector === ".srow[data-tab]" || selector === ".srow" ? el : null;
    return el;
  };
  const source = dragRow("tab-solo", "");
  listeners.get("dragstart")({ target: source });
  let prevented = false;
  listeners.get("dragover")({ target: dragRow("tab-child", "root"), preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, "다른 부모 위에는 drop 자리 표시도 만들지 않는다");
  listeners.get("drop")({ target: dragRow("tab-child", "root"), preventDefault() {} });
  assert.deepEqual(sent, [], "다른 부모에 놓아도 tab.move를 보내지 않는다");

  listeners.get("drop")({ target: dragRow("tab-solo-2", ""), preventDefault() {} });
  assert.deepEqual(sent, [{ type: "tab.move", tabId: "tab-solo", index: 3 }],
    "같은 부모의 단일-pane 탭은 기존 tab.move reorder를 유지한다");

  const clickRow = (target) => listeners.get("click")({ target: {
    closest: (selector) => selector === ".srow" ? {dataset: {target}} : null,
  }});
  clickRow("root");
  assert.deepEqual(selected, ["root"], "다른 에이전트의 첫 클릭은 즉시 한 번 선택한다");
  assert.match(list.innerHTML, />검증 담당<\/span>/, "첫 선택은 가지를 접지 않는다");
  clickRow("root");
  assert.deepEqual(selected, ["root"], "같은 에이전트를 다시 누르면 재이동 없이 접는다");
  assert.doesNotMatch(list.innerHTML, />검증 담당<\/span>/);
  clickRow("root");
  assert.match(list.innerHTML, />검증 담당<\/span>/, "같은 행을 다시 누르면 펼친다");
  clickRow("child");
  assert.deepEqual(selected, ["root", "child"], "자식으로 이동도 첫 클릭 한 번이다");
});
