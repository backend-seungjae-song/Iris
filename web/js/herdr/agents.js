// Spaces · Agents 목록에서 각 스페이스 줄 아래의 에이전트 줄을 그리고 herdr 탭 조작과 선택 UI를 잇는다.
//
// 소유 범위
//   에이전트 줄 마크업, 스페이스별 에이전트 접힘, reveal, 탭 drag 상태, 인라인 이름변경 상태,
//   복귀 변경 표시 상태와 에이전트 줄의 클릭·drag·우클릭 listener 연결.
//   스페이스 줄과 목록 전체의 다시 그리기는 explorer/tree.js 의 renderSpaces 가 갖는다. 그쪽이
//   스페이스 줄을 그리다가 이 모듈이 등록한 함수로 에이전트 줄을 받아 끼운다.
//
// 제공 API
//   initAgents, Agents 렌더·reveal·이름변경 command, 이름변경 여부 query와 변경 표시 setter.
//   explorer/tree.js 의 registerSpaceAgents 에 스페이스 id → { count, open, html } 과 이름 편집 중 여부를 등록한다.
//
// 의존 대상
//   herdr snapshot·pane/space query는 herdr/state에서, 메뉴·입력·확인은 explorer/context-menu에서
//   import한다. $·esc·cssEsc·wsSend와 main 소유 선택·정렬·접힘 동작은 init에서 받는다.
//   collapsed는 교체하지 않는 객체라 참조로, isLocal·curTarget은 접근자·setter로 받는다.
//
// 유지 조건
//   받은 herdr 탭 순서, 렌더 중 이름편집 보존, 같은 Space 안 drag만 허용하는 조건과 insert index,
//   listener 등록 순서, archive 전 확인·로컬 제한, 이름변경 commit/blur 순서를 보존한다.
//
// 영향 범위
//   main의 init·선택·키보드·복귀 변경 표시, herdr/sync의 역동기화 렌더·reveal,
//   explorer/context-menu의 Space reorder 재렌더 등록과 archive 메뉴 API, herdr/state의 query 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/herdr/agents.js

import { callHook } from "../core/hooks.js";
import { agentMark } from "../core/glyphs.js";
import { STATE_LABEL, agentState } from "../core/agent-state.js";
import { createItems } from "../panel/herdr-tabs.js";
import {
  askConfirm, askText, registerAgentRenderer, registerSpaceRowClick, showCtx, spaceCtxItems,
} from "../explorer/context-menu.js";
import { registerSpaceAgents } from "../explorer/tree.js";
import {
  agentByPane, agentKey, agentsOfSpace, getLastAgents, getTabsForSpace, nameOf,
} from "./state.js";
import {
  agentBranchKey, ancestorBranchKeys, buildAgentForest, visibleAgentNodes,
} from "./agent-tree.js";

let $, esc, cssEsc, wsSend;
let getIsLocal, getCurTarget, orderedSpaces, spk, saveCollapsed, selectSession, copyText, showToast, getSelectedSpaceId;
let renderSpaces;
let collapsed;
let agentList;
let changedInfo = new Map();
let dragTab = null, dragTabSpace = null, dragTreeParent = null;
let pendingTabName = null;
let renaming = null;
const collapsedAgentBranches = new Set();

export function initAgents(deps) {
  ({ $, esc, cssEsc, wsSend,
    getIsLocal, getCurTarget, orderedSpaces, spk, saveCollapsed, selectSession,
    copyText, showToast, getSelectedSpaceId, collapsed, renderSpaces } = deps);
  agentList = $("#space-list");
  registerAgentRenderer(renderAgents);
  registerSpaceRowClick(spaceRowClicked);
  registerSpaceAgents({ rows: spaceAgents, hold: () => !!renaming });

  agentList.addEventListener("click", (e) => {
    if (e.target.closest(".rename-input")) return;
    // 스페이스 줄 앞 삼각형: 그 스페이스의 에이전트 줄만 접고 편다. 스페이스 포커스는 옮기지 않는다.
    const spaceTog = e.target.closest("[data-space-tog]");
    if (spaceTog) { toggleSpaceAgents(spaceTog.dataset.spaceTog); renderAgents(); return; }
    const toggle = e.target.closest(".agent-tree-toggle");
    if (toggle) {
      e.stopPropagation();
      const key = toggle.dataset.agentToggle;
      toggleAgentBranch(key);
      return;
    }
    const add = e.target.closest(".agent-add-row");
    if (add) {
      e.stopPropagation();
      const wsid = add.dataset.add;
      askText("새 터미널 탭 이름", "", "비워 두면 herdr 기본 이름").then((name) => {
        if (name === null) return;                                   // 취소 = 만들지 않는다
        const nm = name.trim();
        wsSend({ type: "tab.create", workspaceId: wsid, name: nm || undefined });
        pendingTabName = nm || null;
      });
      return;
    }
    // 서브에이전트 줄: 부모 세션을 고르고 그 서브에이전트의 대화를 채팅 보기로 연다.
    // 채팅 보기 기능이 꺼져 있으면 부모 세션 선택만 남는다.
    const info = e.target.closest(".agent-info-row[data-sub-agent]");
    if (info) {
      const paneId = info.dataset.subPane;
      const parent = agentByPane(paneId);
      if (!parent) return;
      if (paneId !== getCurTarget()) selectSession(paneId);
      callHook("agentchat.openSubagent", {
        paneId, agentId: info.dataset.subAgent, parentLabel: nameOf(parent),
        description: info.dataset.subDesc || "", agentType: info.dataset.subType || "",
      });
      return;
    }
    const row = e.target.closest(".srow");
    if (!row) return;
    const target = row.dataset.target;
    const agent = agentByPane(target);
    const hasChildren = agent?.subagents?.length || getLastAgents().some((a) => a.parentPaneId === target);
    // 하위가 있는 줄은 누를 때마다 접기·펴기가 바뀐다. 고르지 않은 줄이면 고르면서 바꾼다.
    if (!(hasChildren && agent)) { selectSession(target); return; }
    if (target !== getCurTarget()) selectSession(target);
    toggleAgentBranch(agentBranchKey(agent));
  });
  agentList.addEventListener("dragstart", (e) => {
    if (e.target.closest(".agent-tree-toggle")) { e.preventDefault(); return; }
    const r = e.target.closest(".srow[data-tab]"); if (!r) return;
    dragTab = r.dataset.tab; dragTabSpace = r.dataset.space;
    dragTreeParent = r.dataset.treeParent || "";
    r.classList.add("dragging");
  });
  agentList.addEventListener("dragend", (e) => {
    e.target.closest(".srow")?.classList.remove("dragging");
    clearDragMark();
    dragTab = null; dragTabSpace = null; dragTreeParent = null;
  });
  agentList.addEventListener("dragover", (e) => {
    const r = e.target.closest(".srow[data-tab]");
    clearDragMark();
    if (!dragTab || !r || r.dataset.space !== dragTabSpace
      || (r.dataset.treeParent || "") !== dragTreeParent) return;    // 같은 스페이스·형제 안에서만
    e.preventDefault();
    if (r.dataset.tab === dragTab) return;
    // 실제로 들어갈 위치를 그대로 보여준다. 아래로 끄는 중이면 그 줄 밑에 선이 그려진다.
    const tabs = tabIdsOf(dragTabSpace);
    const down = tabs.indexOf(dragTab) < tabs.indexOf(r.dataset.tab);
    r.classList.add(down ? "dragover-after" : "dragover");
  });
  agentList.addEventListener("drop", (e) => {
    e.preventDefault();
    const r = e.target.closest(".srow[data-tab]");
    clearDragMark();
    if (!dragTab || !r || r.dataset.space !== dragTabSpace || r.dataset.tab === dragTab
      || (r.dataset.treeParent || "") !== dragTreeParent) return;
    const tabs = tabIdsOf(dragTabSpace);
    const from = tabs.indexOf(dragTab), to = tabs.indexOf(r.dataset.tab);
    if (from < 0 || to < 0) return;
    wsSend({ type: "tab.move", tabId: dragTab, index: moveIndexFor(from, to) });
    dragTab = null; dragTabSpace = null; dragTreeParent = null;
  });
  // 에이전트 우클릭: 보관. 복원 키가 없는 세션은 보관할 수 없게 막는다(닫으면 복구 불가).
  // 스페이스 줄과 빈 영역의 메뉴는 목록을 그리는 쪽(explorer/context-menu)이 띄운다.
  agentList.addEventListener("contextmenu", (e) => {
    // 이름 편집칸에서는 브라우저 기본 메뉴를 가로채지 않는다. 붙여넣기가 거기서만 가능하다.
    if (e.target.closest("input, textarea")) return;
    const row = e.target.closest(".srow");
    if (!row) {
      // 터미널 탭 추가 줄은 그 스페이스를 가리킨다. 스페이스 줄을 우클릭한 것과 같은 항목을 준다.
      const addRow = e.target.closest(".agent-add-row");
      if (addRow) { e.preventDefault(); showCtx(e.clientX, e.clientY, spaceCtxItems(addRow.dataset.add)); }
      else if (e.target.closest(".agent-info-row")) e.preventDefault();
      return;
    }
    e.preventDefault();
    const a = agentByPane(row.dataset.target); if (!a) return;
    const nm = nameOf(a);
    const why = !a.sessionUuid ? "세션 id가 없어 되살릴 수 없습니다"
      : a.status === "working" ? null : null;
    const local = getIsLocal();
    showCtx(e.clientX, e.clientY, [
      { label: "이 세션 보기", act: () => selectSession(a.paneId, true) },
      { label: "이름 바꾸기", disabled: !local || !a.tabId, act: async () => {
        const v = await askText("세션 이름", nm);
        if (v !== null && v !== "" && v !== nm) wsSend({ type: "tab.rename", tabId: a.tabId, label: v });
      } },
      { label: "작업 폴더 복사", disabled: !a.cwd, act: () => { copyText(a.cwd).then((ok) => showToast(ok ? "경로를 복사했습니다" : "경로를 복사하지 못했습니다")); } },
      { sep: true },
      ...(local && a.workspaceId ? createItems(a.workspaceId) : []),
      { sep: true },
      { label: why ? `접기 불가: ${why}` : "이 세션 접기(보관)", disabled: !local || !!why, act: async () => {
        const busy = a.status === "working" ? "\n지금 작업 중입니다. 진행하던 것이 끊깁니다." : "";
        if (!(await askConfirm(`"${nm}"을(를) 접을까요?${busy}\n마지막 화면 100줄과 되살릴 열쇠를 저장한 뒤 닫습니다.`))) return;
        wsSend({ type: "archive.agent", paneId: a.paneId });
      } },
      { label: "이 세션 닫기", danger: true, disabled: !local || !a.paneId || !a.terminalId, act: async () => {
        if (!(await askConfirm(`"${nm}"을(를) 닫을까요?`, "되돌릴 수 없습니다. 접기와 달리 되살릴 열쇠를 남기지 않습니다."))) return;
        wsSend({ type: "pane-close", paneId: a.paneId, terminalId: a.terminalId });
      } },
    ]);
  });
}

function toggleAgentBranch(key) {
  if (collapsedAgentBranches.has(key)) collapsedAgentBranches.delete(key);
  else collapsedAgentBranches.add(key);
  renderAgents();
}

// 목록 전체를 다시 그린다. 스페이스 줄을 그리는 쪽이 이 모듈의 줄을 받아 가므로 그쪽을 부른다.
export function renderAgents() {
  if (renaming) return; // 인라인 이름편집 중엔 리렌더 보류(포커스 유지)
  renderSpaces();
}

function toggleSpaceAgents(spaceId) {
  const id = spk(spaceId);
  if (collapsed.groups.has(id)) collapsed.groups.delete(id); else collapsed.groups.add(id); saveCollapsed();
}

// 스페이스 줄 누름: 포커스를 옮기고, 누르기 전과 반대 접힘 상태로 끝낸다. 포커스 이동은 고른
// 에이전트를 보이려고 접힌 그룹을 펴므로, 펴진 뒤에 원하는 상태를 다시 적는다.
// 에이전트가 없는 스페이스는 접을 것이 없고, 접으면 터미널 탭 추가 줄만 사라진다.
function spaceRowClicked(spaceId, focus) {
  const id = spk(spaceId);
  const wasOpen = !collapsed.groups.has(id);
  focus(spaceId);
  if (!agentsOfSpace(spaceId).length) return;
  if (wasOpen) collapsed.groups.add(id); else collapsed.groups.delete(id);
  saveCollapsed();
  renderAgents();
}

// 한 스페이스 줄 아래에 들어갈 에이전트 줄. 고른 스페이스에는 터미널 탭 추가 줄을 붙인다.
function spaceAgents(spaceId) {
  const ags = agentsOfSpace(spaceId);
  const gopen = !collapsed.groups.has(spk(spaceId));
  const add = gopen && getIsLocal() && spaceId === getSelectedSpaceId()
    ? `<div class="agent-add-row" data-add="${esc(spaceId)}" title="이 스페이스에 터미널 탭 만들기"><span class="agent-add-spacer" aria-hidden="true"></span><svg class="i agent-add-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>터미널 탭</div>`
    : "";
  if (!ags.length) return { count: 0, open: gopen, html: add };
  const forest = buildAgentForest(ags);
  const tabCounts = new Map();
  for (const a of ags) if (a.tabId) tabCounts.set(a.tabId, (tabCounts.get(a.tabId) || 0) + 1);
  const visible = gopen ? visibleAgentNodes(forest, collapsedAgentBranches) : [];
  // 트리 안내선은 다음 형제가 있을 때만 아래로 이어진다. 그렇지 않으면 마지막 줄 밑까지 선이
  // 이어져 어디서 분기가 끝나는지 보이지 않는다.
  const hasNext = visible.map(({ depth }, i) => {
    for (let j = i + 1; j < visible.length; j++) {
      if (visible[j].depth < depth) return false;
      if (visible[j].depth === depth) return true;
    }
    return false;
  });
  const rows = visible.map(({ node, depth }, rowIndex) => {
    const a = node.agent;
    const chg = changedInfo.get(agentKey(a));
    const native = Array.isArray(a.subagents) ? a.subagents : [];
    const hasChildren = node.children.length > 0 || native.length > 0;
    const key = agentBranchKey(a);
    const open = !collapsedAgentBranches.has(key);
    const draggable = a.tabId && tabCounts.get(a.tabId) === 1;
    const treeParent = node.parent?.agent?.paneId || "";
    const label = depth > 0 && a.lineageLabel ? a.lineageLabel : nameOf(a);
    const toggle = treeToggle(hasChildren, open, key, label);
    const st = agentState(a.status, a.question);
    const nativeRows = open ? renderNativeRows(native, depth + 1, key, a.paneId, a.agent) : "";
    return `<div class="srow agent-tree-row${depth > 0 ? " sub" : ""}${depth > 0 && !hasNext[rowIndex] ? " last" : ""}${a.paneId === getCurTarget() ? " sel" : ""}${chg ? " changed" : ""}${hasNext[rowIndex] ? " has-next" : ""}" style="${rowIndent(depth)}" data-depth="${depth}" data-target="${esc(a.paneId)}" data-tree-parent="${esc(treeParent)}"${draggable ? ` draggable="true" data-tab="${esc(a.tabId)}" data-space="${esc(spaceId)}"` : ""}>
        ${depth > 0 ? `<span class="guide" aria-hidden="true"></span>` : ""}
        ${toggle}
        <span class="dot ${st}" role="img" aria-label="${STATE_LABEL[st]}" title="${STATE_LABEL[st]}"></span>
        <span class="srow-name">${esc(label)}</span>
        ${a.cross ? `<span class="x-badge">×</span>` : ""}
        ${agentMark(a.agent)}
        ${chg ? `<span class="srow-chg" title="돌아와 보니 바뀐 세션"></span>` : ""}
      </div>${nativeRows}`;
  }).join("");
  return { count: ags.length, open: gopen, html: rows + add };
}

// 에이전트 줄은 스페이스 이름 아래에서 한 단 들어가고, 하위 에이전트는 한 단씩 더 들어간다.
function rowIndent(depth) {
  return `--agent-indent:${22 + depth * 18}px;--agent-guide:${Math.max(0, 27 + (depth - 1) * 18)}px`;
}

function treeToggle(hasChildren, open, key, label) {
  if (!hasChildren) return `<span class="agent-tree-toggle-spacer" aria-hidden="true"></span>`;
  const action = open ? "접기" : "펼치기";
  return `<button class="agent-tree-toggle${open ? " open" : ""}" type="button" data-agent-toggle="${esc(key)}" aria-expanded="${open}" aria-label="${esc(label)} 하위 에이전트 ${action}" title="하위 에이전트 ${action}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`;
}

// 서브에이전트는 herdr pane 이 아니라 부모 세션의 기록 폴더에 있다. 중첩된 것도 같은 폴더라서
// 부모 pane 과 서브에이전트 id 만 있으면 대화를 연다.
// 서브에이전트는 부모 에이전트 안에서 도는 같은 도구라 부모의 마크를 단다.
function renderNativeRows(items, depth, parentKey, paneId, parentAgent) {
  return items.map((item, index) => {
    const key = `${parentKey}:native:${index}`;
    const children = Array.isArray(item?.children) ? item.children : [];
    const open = !collapsedAgentBranches.has(key);
    const label = item?.description || item?.agentType || "subagent";
    const toggle = treeToggle(children.length > 0, open, key, label);
    const childRows = open ? renderNativeRows(children, depth + 1, key, paneId, parentAgent) : "";
    const last = index === items.length - 1 ? " last" : "";
    const sub = item?.agentId
      ? ` data-sub-pane="${esc(paneId)}" data-sub-agent="${esc(item.agentId)}" data-sub-desc="${esc(item.description || "")}" data-sub-type="${esc(item.agentType || "")}" title="대화 보기"`
      : "";
    return `<div class="agent-info-row agent-tree-row sub${last}" style="${rowIndent(depth)}" data-depth="${depth}"${sub}>
      <span class="guide" aria-hidden="true"></span>
      ${toggle}
      <span class="dot ${item?.running ? "working" : "done"}"></span>
      <span class="srow-name">${esc(label)}</span>
      ${agentMark(parentAgent)}
    </div>${childRows}`;
  }).join("");
}

// 고른 에이전트를 화면에 드러낸다. scrollIntoView({block:"nearest"})는 딱 맞게 붙여서, 고른 것이
// 목록의 맨 끝처럼 보이고 앞뒤가 보이지 않으므로, 위아래로 한 줄씩은 남긴다.
// 그 에이전트가 접힌 그룹 안에 있으면 먼저 펴고, 다시 그려진 뒤에 계산한다.
export function revealAgentRow(paneId) {
  if (!paneId) return;
  const a = agentByPane(paneId);
  let rerender = false;
  if (a && a.workspaceId && collapsed.groups.has(spk(a.workspaceId))) {
    collapsed.groups.delete(spk(a.workspaceId)); saveCollapsed(); rerender = true;
  }
  if (a?.workspaceId) {
    const forest = buildAgentForest(agentsOfSpace(a.workspaceId));
    for (const key of ancestorBranchKeys(forest, paneId)) {
      if (collapsedAgentBranches.delete(key)) rerender = true;
    }
  }
  if (rerender) renderAgents();
  const row = agentList.querySelector(`.srow[data-target="${cssEsc(paneId)}"]`);
  if (!row) return;
  const r = row.getBoundingClientRect(), b = agentList.getBoundingClientRect();
  const pad = r.height + 6;                       // 위아래 한 줄치 여유
  if (r.top - pad < b.top) agentList.scrollTop -= (b.top - (r.top - pad));
  else if (r.bottom + pad > b.bottom) agentList.scrollTop += (r.bottom + pad) - b.bottom;
}

// 에이전트 순서 바꾸기: 드래그로 놓는다. 표시 순서만 바꾸면 herdr 사이드바·키보드 이동과 일치하지 않으므로
// 실제 탭 순서(tab.move)를 옮긴다. 여러 pane이 든 탭은 한 번 옮기면 여러 트리 행이 함께 움직이므로
// draggable을 주지 않고, 단일-pane 탭도 같은 트리 부모를 둔 형제끼리만 받는다.
const clearDragMark = () => agentList.querySelectorAll(".dragover, .dragover-after")
  .forEach((x) => x.classList.remove("dragover", "dragover-after"));
// herdr의 insert_index는 *옮기기 전* 탭 목록의 위치다. "그 위치에 있던 탭 앞에 끼운다"는 뜻이고
// 목록 길이를 주면 맨 뒤에 붙는다(확인 결과: [t1 t2 t3 t4]에서 t1을 2로 옮기면 t3 앞 → t2 t1 t3 t4).
// 그래서 끌어놓은 줄의 인덱스를 그대로 보내면 언제나 그 줄 *위*로 간다. 아래로 끌 때는 한 칸씩
// 모자라고, 바로 아래 줄에 놓으면 위치가 그대로다(확인 결과: index=1을 보내면 아무것도 움직이지 않음).
// 아래로 가는 이동이면 그 줄 다음 위치(to+1)를 준다.
const moveIndexFor = (from, to) => (from < to ? to + 1 : to);
// 그 스페이스의 탭 목록에서의 위치. 화면에 보이지 않는 빈 탭도 herdr 목록에 있으므로 herdr 값을 쓴다.
const tabIdsOf = (spaceId) => getTabsForSpace(spaceId).map((t) => t.tabId);

// 인라인 탭 이름변경: herdr rename_tab(ctrl+shift+r) 대응. 브라우저 리로드 대신 제자리 편집.
export function startInlineRename() {
  const curTarget = getCurTarget();
  const a = agentByPane(curTarget);
  if (!a || !a.tabId) return;
  const row = agentList.querySelector(`.srow[data-target="${cssEsc(curTarget)}"]`);
  const nameEl = row?.querySelector(".srow-name");
  if (!nameEl) return;
  const cur = nameOf(a);
  renaming = curTarget;
  nameEl.innerHTML = `<input class="rename-input" value="${esc(cur)}" />`;
  const inp = nameEl.querySelector("input");
  inp.focus(); inp.select();
  let closed = false;
  const finish = (commit) => {
    if (closed) return; closed = true;
    const v = inp.value.trim();
    renaming = null;
    if (commit && v && v !== cur) wsSend({ type: "tab.rename", tabId: a.tabId, label: v });
    renderAgents();
  };
  inp.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // 전역 네비/단축키 차단
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
}

export function isAgentRenaming() { return !!renaming; }
export function setChangedInfo(value) { changedInfo = value; }
