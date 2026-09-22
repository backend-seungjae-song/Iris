// Space별 Agents 목록을 그리고 herdr 탭 조작과 선택 UI를 잇는다.
//
// 소유 범위
//   Agents DOM, 렌더·reveal, 탭 drag 상태, 인라인 이름변경 상태, 복귀 변경 표시 상태와
//   클릭·drag·우클릭·더블클릭 listener 연결.
//
// 제공 API
//   initAgents, Agents 렌더·reveal·이름변경 command, 이름변경 여부 query와 변경 표시 setter.
//
// 의존 대상
//   herdr snapshot·pane/space query는 herdr/state에서, 메뉴·입력·확인은 explorer/context-menu에서
//   import한다. $·esc·cssEsc·statusClass·wsSend와 main 소유 선택·정렬·접힘 동작은 init에서 받는다.
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
import { createItems } from "../panel/herdr-tabs.js";
import {
  askConfirm, askText, registerAgentRenderer, showCtx, spaceCtxItems,
} from "../explorer/context-menu.js";
import {
  agentByPane, agentKey, agentsOfSpace, getLastAgents, getTabsForSpace, nameOf,
} from "./state.js";
import {
  agentBranchKey, ancestorBranchKeys, buildAgentForest, visibleAgentNodes,
} from "./agent-tree.js";

let $, esc, cssEsc, statusClass, wsSend;
let getIsLocal, getCurTarget, orderedSpaces, spk, saveCollapsed, selectSession, copyText, showToast, getSelectedSpaceId;
let collapsed;
let agentList;
let changedInfo = new Map();
let dragTab = null, dragTabSpace = null, dragTreeParent = null;
let pendingTabName = null;
let renaming = null;
const collapsedAgentBranches = new Set();

export function initAgents(deps) {
  ({ $, esc, cssEsc, statusClass, wsSend,
    getIsLocal, getCurTarget, orderedSpaces, spk, saveCollapsed, selectSession,
    copyText, showToast, getSelectedSpaceId, collapsed } = deps);
  agentList = $("#agent-list");
  registerAgentRenderer(renderAgents);

  agentList.addEventListener("click", (e) => {
    if (e.target.closest(".rename-input")) return;
    const toggle = e.target.closest(".agent-tree-toggle");
    if (toggle) {
      e.stopPropagation();
      const key = toggle.dataset.agentToggle;
      toggleAgentBranch(key);
      return;
    }
    const add = e.target.closest(".agroup-add");
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
    const gh = e.target.closest(".agroup-head");
    if (gh) { const id = spk(gh.dataset.group); if (collapsed.groups.has(id)) collapsed.groups.delete(id); else collapsed.groups.add(id); saveCollapsed(); renderAgents(); return; }
    const row = e.target.closest(".srow");
    if (!row) return;
    const target = row.dataset.target;
    const agent = agentByPane(target);
    const hasChildren = agent?.subagents?.length || getLastAgents().some((a) => a.parentPaneId === target);
    if (target === getCurTarget() && hasChildren) toggleAgentBranch(agentBranchKey(agent));
    else selectSession(target);
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
  agentList.addEventListener("contextmenu", (e) => {
    // 스페이스 그룹 머리글에서도 보관할 수 있다. 여기서도 스페이스 전체가 보이기 때문이다.
    // 이름 편집칸에서는 브라우저 기본 메뉴를 가로채지 않는다. 붙여넣기가 거기서만 가능하다.
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
    const head = e.target.closest(".agroup-head");
    // 그룹 머리글은 스페이스를 가리킨다. Spaces 판에서 그 스페이스를 우클릭한 것과 같은 항목을 준다.
    if (head) { showCtx(e.clientX, e.clientY, spaceCtxItems(head.dataset.group)); return; }
    const row = e.target.closest(".srow");
    if (!row) {
      // 빈 영역에서도 받는다. 아무 일도 일어나지 않으면 기능이 없는 것으로 읽힌다.
      const sid = getSelectedSpaceId();
      showCtx(e.clientX, e.clientY, sid ? spaceCtxItems(sid)
        : [{ label: "먼저 스페이스를 선택하세요", disabled: true }]);
      return;
    }
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
      { label: "작업 폴더 복사", disabled: !a.cwd, act: () => { copyText(a.cwd); showToast("경로를 복사했습니다"); } },
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

export function renderAgents() {
  if (renaming) return; // 인라인 이름편집 중엔 리렌더 보류(포커스 유지)
  const list = orderedSpaces();
  if (!getLastAgents().length) { agentList.innerHTML = `<div class="list-empty">herdr 에이전트 없음</div>`; return; }
  agentList.innerHTML = list.map((s) => {
    const ags = agentsOfSpace(s.id);
    if (!ags.length) return "";
    const gopen = !collapsed.groups.has(spk(s.id));
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
    const rows = gopen ? visible.map(({ node, depth }, rowIndex) => {
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
      const nativeRows = open ? renderNativeRows(native, depth + 1, key) : "";
      return `<div class="srow agent-tree-row${a.paneId === getCurTarget() ? " sel" : ""}${chg ? " changed" : ""}${hasNext[rowIndex] ? " has-next" : ""}" style="--agent-indent:${5 + depth * 14}px;--agent-guide:${Math.max(0, 10 + (depth - 1) * 14)}px" data-depth="${depth}" data-target="${esc(a.paneId)}" data-tree-parent="${esc(treeParent)}"${draggable ? ` draggable="true" data-tab="${esc(a.tabId)}" data-space="${esc(s.id)}"` : ""}>
        ${toggle}
        <span class="dot ${statusClass(a.status)}"></span>
        <span class="srow-name">${esc(label)}</span>
        ${a.cross ? `<span class="badge">×</span>` : ""}
        ${agentMark(a.agent)}
      </div>${nativeRows}`;
    }).join("") : "";
    return `<div class="agroup" data-space="${esc(s.id)}">
      <div class="agroup-head" data-group="${esc(s.id)}">
        <span class="caret${gopen ? " open" : ""}">▶</span><span class="agroup-name">${esc(s.label)}</span>
        ${getIsLocal() ? `<button class="agroup-add" data-add="${esc(s.id)}" title="터미널 탭 생성">＋</button>` : ""}
      </div>${rows}</div>`;
  }).join("") || `<div class="list-empty">표시할 에이전트 없음</div>`;
}

function treeToggle(hasChildren, open, key, label) {
  if (!hasChildren) return `<span class="agent-tree-toggle-spacer" aria-hidden="true"></span>`;
  const action = open ? "접기" : "펼치기";
  return `<button class="agent-tree-toggle${open ? " open" : ""}" type="button" data-agent-toggle="${esc(key)}" aria-expanded="${open}" aria-label="${esc(label)} 하위 에이전트 ${action}" title="하위 에이전트 ${action}">▶</button>`;
}

function renderNativeRows(items, depth, parentKey) {
  return items.map((item, index) => {
    const key = `${parentKey}:native:${index}`;
    const children = Array.isArray(item?.children) ? item.children : [];
    const open = !collapsedAgentBranches.has(key);
    const label = item?.description || item?.agentType || "subagent";
    const toggle = treeToggle(children.length > 0, open, key, label);
    const childRows = open ? renderNativeRows(children, depth + 1, key) : "";
    return `<div class="agent-info-row agent-tree-row" style="--agent-indent:${5 + depth * 14}px;--agent-guide:${Math.max(0, 10 + (depth - 1) * 14)}px" data-depth="${depth}">
      ${toggle}
      <span class="dot ${item?.running ? "working" : "done"}"></span>
      <span class="srow-name">${esc(label)}</span>
      ${agentMark(item?.agentType)}
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
