// herdr가 방송한 포커스를 Iris의 현재 에이전트·Space 선택으로 역동기화한다.
//
// 소유 범위
//   herdr 포커스 debounce timer·후보 pane과 최근 사용자 선택 시각.
//
// 제공 API
//   initHerdrSync, 사용자 선택 시각 기록 command, herdr 포커스 예약 command.
//
// 의존 대상
//   snapshot과 pane 표시는 herdr/state에서, Agents 렌더·reveal은 herdr/agents에서 import한다.
//   main 소유 선택 scalar는 접근자·setter로, 마지막 에이전트 객체와 DOM은 init에서 참조로 받는다.
//
// 유지 조건
//   동일 pane 무시 → 300ms debounce → 1.5s 사용자 쿨다운 → pane 존재 확인 순서와,
//   역동기화 경로에서 herdr focus를 되보내지 않는 loop-safe 경계를 그대로 보존한다.
//
// 영향 범위
//   main.js의 selectSession·WebSocket state 수신·Space 전환과 herdr/state의 pane snapshot query,
//   herdr/agents의 renderAgents·revealAgentRow 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/herdr/sync.js

import { callHook } from "../core/hooks.js";
import { agentMark } from "../core/glyphs.js";
import { paintStateDot, stateLabel } from "../core/agent-state.js";
import { renderAgents, revealAgentRow } from "./agents.js";
import { agentByPane, nameOf } from "./state.js";

let getCurTarget, setCurTarget, getSelectedSpaceId, switchToSpaceOf;
let lastAgentBySpace, tName, tSub, tDot;
let lastUserSelect = 0, herdrSyncTimer = null, herdrSyncPane = null;

export function initHerdrSync(deps) {
  ({
    getCurTarget, setCurTarget, getSelectedSpaceId, switchToSpaceOf,
    lastAgentBySpace, tName, tSub, tDot,
  } = deps);
}

export function markHerdrUserSelect() {
  lastUserSelect = Date.now();
}

export function scheduleHerdrSync(paneId) {
  if (!paneId || paneId === getCurTarget()) return;
  herdrSyncPane = paneId;
  clearTimeout(herdrSyncTimer);
  herdrSyncTimer = setTimeout(() => applyHerdrFocus(herdrSyncPane), 300);
}

function applyHerdrFocus(paneId) {
  if (!paneId || paneId === getCurTarget()) return;
  if (Date.now() - lastUserSelect < 1500) return; // 사용자 선택 우선(쿨다운)
  const a = agentByPane(paneId);
  if (!a) return; // 아직 목록에 없는 pane이면 스킵
  setCurTarget(paneId);
  if (a.workspaceId) lastAgentBySpace[a.workspaceId] = paneId; // herdr 역방향 전환도 마지막 탭으로 기록(스페이스 복귀 복원용)
  tName.textContent = nameOf(a); tSub.innerHTML = agentMark(a.agent); tSub.append(Object.assign(document.createElement("span"), { textContent: stateLabel(a) })); paintStateDot(tDot, a);
  if (a.workspaceId && a.workspaceId !== getSelectedSpaceId()) { // workspace 바뀔 때만 무거운 동기화
    switchToSpaceOf(a);
  }
  renderAgents();
  revealAgentRow(paneId);
  callHook("agentchat.sync"); // herdr 쪽에서 pane 을 옮겨도 채팅 보기가 따라간다
}
