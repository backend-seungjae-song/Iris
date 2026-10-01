// herdr 상태 변화에서 만든 알림을 사이드바에서 보여 주는 기능.
//
// 소유 범위
//   알림 버튼·목록 DOM, 읽음·지난 기록 저장, 에이전트 선택.
//
// 제공 API
//   initCapability(ctx).
//
// 의존 대상
//   main의 Space·Agent 조회와 선택 함수, herdr/state의 notifications.state 훅.
//
// 유지 조건
//   첫 상태 방송은 새 알림으로 세지 않는다. 읽음과 입력 대기는 별개다. 기록은 최대 80개다.
//   과거 세션의 pane id가 재사용돼도 다른 terminal id로 이동하지 않는다.
//
// 영향 범위
//   capability 표·CSS 로드, sidebar-head, 브라우저 localStorage의 알림 기록.

import { provide } from "../core/hooks.js";
import { clearHistory, markAllRead, pendingCount, reconcileNotifications, unreadCount } from "./model.js";

const BELL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9Z"/><path d="M10 21h4"/></svg>';
const STORE_KEY = "iris.notifications.v1";
let ctx, trigger, panel;
let state = readStored();
let filter = "all", inboxOpen = false, previousFocus = null;

function readStored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return value && Array.isArray(value.records)
      ? { initialized: false, seen: {}, records: value.records.slice(0, 80).map((r) => ({ ...r, pending: false })) }
      : { initialized: false, seen: {}, records: [] };
  } catch { return { initialized: false, seen: {}, records: [] }; }
}

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ records: state.records })); } catch {}
}

function onState(message) {
  state = reconcileNotifications(state, message.agents || []);
  persist(); paintTrigger(); if (inboxOpen) render();
}

function paintTrigger() {
  const unread = unreadCount(state);
  trigger.classList.toggle("has-unread", unread > 0);
  trigger.setAttribute("aria-label", unread ? `알림, 읽지 않음 ${unread}개` : "알림");
  trigger.title = unread ? `알림 · 읽지 않음 ${unread}개` : "알림";
  trigger.querySelector(".notifications-indicator").hidden = unread === 0;
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement("section");
  panel.className = "notifications-panel"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "알림");
  panel.innerHTML = `<header class="notifications-head"><strong>알림 <span class="notifications-count"></span></strong><div class="notifications-actions"><button type="button" class="cc-btn cc-btn-txt" data-action="read">모두 읽음</button><button type="button" class="cc-btn cc-btn-txt" data-action="clear">지난 알림 지우기</button></div><button type="button" class="cc-btn cc-btn-txt cc-btn-icon notifications-close" aria-label="알림 닫기">×</button></header>
    <div class="notifications-filters" role="group" aria-label="알림 필터"><div class="cc-seg"><button type="button" data-filter="all">전체 <span class="notifications-all-count"></span></button><button type="button" data-filter="pending">입력 대기 <span class="notifications-pending-count"></span></button></div></div>
    <div class="notifications-list"></div>
    <footer class="notifications-foot">누르면 해당 에이전트로 이동합니다</footer>`;
  document.body.append(panel);
  panel.querySelector(".notifications-close").addEventListener("click", closePanel);
  panel.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    filter = button.dataset.filter; render();
  }));
  panel.querySelector('[data-action="read"]').addEventListener("click", () => {
    state = markAllRead(state); persist(); paintTrigger(); render();
  });
  panel.querySelector('[data-action="clear"]').addEventListener("click", () => {
    state = clearHistory(state); persist(); paintTrigger(); render();
  });
  panel.querySelector(".notifications-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    const record = state.records.find((item) => item.id === row.dataset.id);
    if (!record) return;
    record.read = true; persist(); paintTrigger();
    if (ctx.getLastAgents().some((agent) => agent.paneId === record.paneId
      && agent.workspaceId === record.workspaceId
      && record.terminalId && record.terminalId === agent.terminalId)) {
      closePanel(); ctx.selectSession(record.paneId, false, "notice");
    } else render();
  });
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePanel(); } });
  document.addEventListener("mousedown", (event) => {
    if (inboxOpen && !panel.contains(event.target) && !trigger.contains(event.target)) closePanel();
  });
}

function timeLabel(at) {
  const min = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (min < 1) return "지금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

function titleFor(record) {
  if (record.kind === "question") return "질문이 있습니다";
  if (record.kind === "blocked") return "입력을 기다립니다";
  return "작업을 마쳤습니다";
}

function dotFor(record) {
  if (record.kind === "done") return "done";
  // 이미 풀린 질문·대기는 사이드바의 쉬는 상태와 같은 빈 원으로 그린다.
  if (!record.pending) return "idle";
  return record.kind === "question" ? "question" : "blocked";
}

function render() {
  if (!inboxOpen) return;
  panel.querySelector(".notifications-count").textContent = unreadCount(state) || "";
  panel.querySelector(".notifications-pending-count").textContent = pendingCount(state) || "";
  panel.querySelector(".notifications-all-count").textContent = state.records.length || "";
  panel.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === filter)));
  const spaces = new Map(ctx.orderedSpaces().map((space) => [space.id, space.label || space.id]));
  const records = state.records.filter((record) => filter === "all" || record.pending);
  const list = panel.querySelector(".notifications-list");
  list.innerHTML = records.length ? records.map((record) => `<button type="button" class="notifications-item${record.read ? "" : " unread"}" data-id="${ctx.esc(record.id)}"><span class="dot ${dotFor(record)}"></span><span class="notifications-item-main"><strong>${titleFor(record)}</strong><small>${ctx.esc(spaces.get(record.workspaceId) || record.workspaceId)} · ${ctx.esc(record.agentName)} · <em>${record.pending ? "입력 대기" : "지난 알림"}</em></small></span><time>${timeLabel(record.at)}</time></button>`).join("")
    : `<div class="notifications-empty">${filter === "pending" ? "입력을 기다리는 에이전트가 없습니다" : "알림이 없습니다"}</div>`;
}

function closePanel() {
  if (!inboxOpen) return;
  inboxOpen = false; panel.hidden = true;
  if (previousFocus?.isConnected) previousFocus.focus(); else trigger.focus();
}

function openPanel() {
  ensurePanel();
  if (inboxOpen) { closePanel(); return; }
  previousFocus = document.activeElement;
  inboxOpen = true; filter = "all"; panel.hidden = false; render();
  panel.querySelector(".notifications-close").focus();
}

export function initCapability(context) {
  ctx = context;
  const head = document.querySelector(".sidebar-head");
  if (!head) return {};
  trigger = document.createElement("button");
  trigger.type = "button"; trigger.id = "header-inbox";
  trigger.className = "cc-btn cc-btn-txt cc-btn-icon notifications-trigger";
  trigger.innerHTML = `${BELL_ICON}<span class="notifications-indicator" hidden></span>`;
  trigger.addEventListener("click", openPanel);
  head.append(trigger);
  paintTrigger();
  provide("notifications.state", onState);
  // 설정에서 나중에 켠 경우에도 현재 대기를 바로 보여 준다. 첫 관찰은 새 알림으로 세지 않는다.
  const initialAgents = ctx.getLastAgents();
  if (initialAgents.length) onState({ agents: initialAgents });
  return {};
}
