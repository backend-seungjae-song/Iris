// 에이전트 스냅샷의 상태 전이를 알림 기록으로 바꾼다.
//
// 소유 범위
//   완료·질문·입력 대기 판정, 첫 방송 예외, 대기 해제, 기록 상한과 읽음 상태.
//
// 제공 API
//   eventKind, reconcileNotifications, unreadCount, pendingCount, markAllRead, clearHistory.
//
// 의존 대상
//   없음. 저장은 화면 모듈이 맡는다.
//
// 유지 조건
//   첫 방송의 대기 항목은 보여 주되 읽은 것으로 둔다. 읽음은 대기 상태를 해제하지 않는다.
//
// 영향 범위
//   알림 목록·배지 수와 로컬 저장 값.

import { agentState } from "../core/agent-state.js";

const MAX_RECORDS = 80;
const PENDING = new Set(["question", "blocked"]);

export function eventKind(agent) {
  const state = agentState(agent.status, agent.question);
  return ["question", "blocked", "done"].includes(state) ? state : null;
}

export function reconcileNotifications(state, agents, now = Date.now()) {
  const previous = state.seen || {};
  const nextSeen = {};
  const records = (state.records || []).map((record) => ({ ...record }));
  const initialized = !!state.initialized;
  const activeKeys = new Set();
  for (const agent of agents || []) {
    if (!agent?.paneId || !agent.workspaceId) continue;
    const pane = agent.paneId;
    const kind = eventKind(agent);
    const key = `${pane}:${agent.terminalId || ""}:${kind}`;
    nextSeen[pane] = { kind, status: agent.status || "", workspaceId: agent.workspaceId,
      terminalId: agent.terminalId || null };
    if (PENDING.has(kind)) activeKeys.add(key);
    const prior = previous[pane];
    const sessionChanged = !!(prior?.terminalId && agent.terminalId && prior.terminalId !== agent.terminalId);
    const changed = initialized && (!prior || prior.kind !== kind || prior.status !== agent.status || sessionChanged);
    const becamePending = PENDING.has(kind) && (!prior || prior.kind !== kind || sessionChanged);
    const completed = kind === "done" && changed && !sessionChanged
      && ["working", "blocked"].includes(prior?.status);
    if (becamePending || completed) {
      // 첫 상태 방송은 기존 대기를 보여 주되 새 알림으로 세지 않는다.
      const existing = records.find((record) => record.key === key && record.pending);
      const restore = !initialized && records.find((record) => record.key === key);
      if (restore) restore.pending = true;
      if (!existing && !restore) {
        records.unshift({ id: `${key}:${now}`, key, paneId: pane, terminalId: agent.terminalId || null,
          workspaceId: agent.workspaceId,
          agentName: agent.tabLabel || agent.cwd?.split("/").pop() || agent.agent || "에이전트",
          kind, at: now, read: !initialized, pending: PENDING.has(kind) });
      }
    }
  }
  for (const record of records) if (record.pending && !activeKeys.has(record.key)) record.pending = false;
  return { initialized: true, seen: nextSeen, records: records.slice(0, MAX_RECORDS) };
}

export function unreadCount(state) { return (state.records || []).filter((record) => !record.read).length; }
export function pendingCount(state) { return (state.records || []).filter((record) => record.pending).length; }
export function markAllRead(state) {
  return { ...state, records: state.records.map((record) => ({ ...record, read: true })) };
}
export function clearHistory(state) {
  return { ...state, records: state.records.filter((record) => record.pending).map((record) => ({ ...record, read: true })) };
}
