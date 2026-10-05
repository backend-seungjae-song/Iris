import { isHostWindows, pathDirname } from "../core/host-path.js";
// 통합 검색 기능의 사이드바 버튼과 검색 대화상자.
//
// 소유 범위
//   검색창 DOM, 파일 목록 요청과 캐시, 결과 선택과 키보드 동작.
//
// 제공 API
//   initCapability(ctx), openUnifiedSearch.
//
// 의존 대상
//   main이 제공하는 Space 선택·agent 선택·WebSocket·center 렌더 함수와 셸의 파일 열기 함수.
//
// 유지 조건
//   기존 파일 팔레트는 그대로 두고, fs.tree 응답은 root별로 판정한다. 파일 결과를 열기 전에
//   해당 Space를 선택한다. 끈 뒤 다시 로드하면 버튼과 대화상자를 만들지 않는다.
//
// 영향 범위
//   capability 표·CSS 로드, main의 unifiedsearch.tree 훅, sidebar-head.

import { provide } from "../core/hooks.js";
import { getTabs, setActiveTab } from "../center/tab-store.js";
import { getTabsForSpace } from "../herdr/state.js";
import { openFile } from "../center/file-routing.js";
import { stateLabel } from "../core/agent-state.js";
import { collectResults, filterResults } from "./model.js";

const KINDS = ["전체", "스페이스", "에이전트", "탭", "파일"];
const KIND_ORDER = ["에이전트", "파일", "탭", "스페이스"];
const svg = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
// glyphs.js 에 없는 모양이라 결과 종류 칸에만 쓰는 아이콘을 여기서 정의한다.
const KIND_ICONS = {
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  terminal: svg('<path d="m4 17 6-6-6-6M12 19h8"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
};
const CACHE_MS = 15000;
let ctx;
let backdrop, input, searchList, trigger;
let selected = 0, category = "전체", matches = [];
let searchOpen = false, previousFocus = null;
const filesByRoot = new Map();
const treeCache = new Map();
const inflight = new Map();
let waiting = new Set();
let treeError = new Map();
let truncatedRoots = new Set();

function sendTree(root, attempt = 0) {
  const previous = inflight.get(root);
  if (previous) clearTimeout(previous.timer);
  ctx.wsSend({ type: "fs.tree", path: root });
  const timer = setTimeout(() => {
    if (!inflight.has(root)) return;
    if (attempt === 0 && searchOpen && ctx.wsIsOpen()) { sendTree(root, 1); return; }
    inflight.delete(root); waiting.delete(root);
    treeError.set(root, "시간 초과"); render();
  }, 8000);
  inflight.set(root, { timer, attempt });
}

function roots() {
  return [...new Set(ctx.orderedSpaces().map((s) => s.folder).filter(Boolean))];
}

function requestTrees() {
  if (!input.value.trim() || !["전체", "파일"].includes(category)) return;
  const want = roots();
  waiting = new Set(); treeError = new Map(); truncatedRoots = new Set();
  for (const root of want) {
    const cached = treeCache.get(root);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      filesByRoot.set(root, cached.files);
      if (cached.truncated) truncatedRoots.add(root);
      continue;
    }
    filesByRoot.delete(root);
    if (!ctx.wsIsOpen()) { treeError.set(root, "연결되지 않음"); continue; }
    waiting.add(root);
    if (!inflight.has(root)) sendTree(root);
  }
  render();
}

function onTree(message) {
  if (!message?.root) return;
  const request = inflight.get(message.root);
  if (request) clearTimeout(request.timer);
  inflight.delete(message.root);
  if (!message.error) treeCache.set(message.root, { at: Date.now(), files: message.files || [], truncated: !!message.truncated });
  if (!searchOpen || !roots().includes(message.root) || !waiting.has(message.root)) return;
  waiting.delete(message.root);
  if (message.error) { treeError.set(message.root, message.error); filesByRoot.delete(message.root); }
  else {
    filesByRoot.set(message.root, Array.isArray(message.files) ? message.files : []);
    if (message.truncated) truncatedRoots.add(message.root);
  }
  render();
}

function ensureDialog() {
  if (backdrop) return;
  backdrop = document.createElement("div");
  backdrop.className = "unified-search-backdrop palette-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `<section class="unified-search palette" role="dialog" aria-modal="true" aria-label="통합 검색">
    <div class="unified-search-input cc-search">${SEARCH_ICON}<input type="search" aria-label="통합 검색" role="combobox" aria-expanded="true" aria-controls="unified-search-results" aria-autocomplete="list" placeholder="스페이스, 에이전트, 탭, 파일 검색" autocomplete="off" spellcheck="false"><button type="button" class="unified-search-close kbd" aria-label="검색 닫기">Esc</button></div>
    <div class="unified-search-categories" role="group" aria-label="검색 범위"><div class="cc-seg">${KINDS.map((kind) => `<button type="button" data-kind="${kind}" aria-pressed="${kind === "전체"}">${kind}<span class="unified-search-count"></span></button>`).join("")}</div></div>
    <div id="unified-search-results" class="unified-search-results" role="listbox" aria-label="검색 결과"></div>
    <footer class="unified-search-footer"><span><span class="kbd">↑↓</span>이동</span><span><span class="kbd">↵</span>열기</span><span class="unified-search-status" role="status" aria-live="polite"></span></footer>
  </section>`;
  document.body.append(backdrop);
  input = backdrop.querySelector("input"); searchList = backdrop.querySelector("#unified-search-results");
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  backdrop.querySelector(".unified-search-close").addEventListener("click", close);
  backdrop.querySelectorAll("[data-kind]").forEach((button) => button.addEventListener("click", () => {
    category = button.dataset.kind; selected = 0;
    backdrop.querySelectorAll("[data-kind]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    requestTrees(); render(); input.focus();
  }));
  input.addEventListener("input", () => { selected = 0; requestTrees(); render(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(selected + 1, matches.length - 1); render(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); render(); }
    else if (event.key === "Enter") { event.preventDefault(); if (matches[selected]) choose(matches[selected]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  searchList.addEventListener("click", (event) => { const item = event.target.closest("[data-index]"); if (item) choose(matches[Number(item.dataset.index)]); });
  backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...backdrop.querySelectorAll("input, button")].filter((node) => !node.disabled && !node.hidden);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

function render() {
  if (!searchOpen) return;
  const rows = collectResults({ spaces: ctx.orderedSpaces(), agents: ctx.getLastAgents(),
    browserState: ctx.getBrowserState(), filesByRoot: input.value.trim() ? filesByRoot : new Map() });
  // 선택안의 순서대로 종류끼리 모은다. 같은 종류 안에서는 스페이스 순서를 유지한다.
  matches = filterResults(rows, category, input.value).sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
  backdrop.querySelectorAll("[data-kind]").forEach((button) => {
    const n = filterResults(rows, button.dataset.kind, input.value).length;
    button.querySelector(".unified-search-count").textContent = input.value.trim() ? ` ${n}${n === 160 ? "+" : ""}` : "";
  });
  selected = Math.max(0, Math.min(selected, matches.length - 1));
  const status = backdrop.querySelector(".unified-search-status");
  status.textContent = waiting.size ? `폴더 ${waiting.size}개의 파일 목록을 불러오는 중…`
    : treeError.size ? `폴더 ${treeError.size}개의 파일 목록을 읽지 못했습니다`
      : `모든 스페이스${truncatedRoots.size ? ` · 폴더 ${truncatedRoots.size}개는 파일 일부만 검색` : ""}`;
  const query = input.value.trim();
  searchList.innerHTML = matches.length ? matches.map((row, index) => `<button type="button" role="option" id="unified-search-result-${index}" aria-selected="${index === selected}" class="unified-search-result${index === selected ? " selected" : ""}" data-index="${index}"><span class="unified-search-tile">${KIND_ICONS[kindIcon(row)]}</span><span class="unified-search-result-text"><strong>${highlight(row.title, query)}</strong><small>${highlight(detailText(row), query)}</small></span><span class="unified-search-kind">${row.kind}</span></button>`).join("")
    : waiting.size || (treeError.size && category === "파일")
      ? `<div class="unified-search-empty">${waiting.size ? "파일 목록을 불러오는 중…" : "파일 목록을 읽지 못했습니다"}</div>`
      : `<div class="unified-search-empty"><strong>${query ? `"${ctx.esc(query)}" 검색 결과가 없습니다` : "검색할 항목이 없습니다"}</strong></div>`;
  input.setAttribute("aria-activedescendant", matches.length ? `unified-search-result-${selected}` : "");
  searchList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

// 검색어와 같은 부분을 표시한다. 대소문자를 무시하는 것은 filterResults 의 판정과 같다.
function highlight(text, query) {
  const value = String(text ?? "");
  if (!query) return ctx.esc(value);
  const lower = value.toLocaleLowerCase(), q = query.toLocaleLowerCase();
  let out = "", from = 0, at;
  while ((at = lower.indexOf(q, from)) !== -1) {
    out += ctx.esc(value.slice(from, at)) + `<mark>${ctx.esc(value.slice(at, at + q.length))}</mark>`;
    from = at + q.length;
  }
  return out + ctx.esc(value.slice(from));
}

// 둘째 줄은 종류마다 소속을 짧게 적는다. 검색 판정은 model.js 의 detail 을 그대로 쓴다.
function detailText(row) {
  const space = ctx.orderedSpaces().find((s) => s.id === row.spaceId);
  const owner = space?.label || row.spaceId;
  if (row.kind === "스페이스") return row.path ? isHostWindows() ? pathDirname(row.path) : row.path.replace(/\/[^/]+\/?$/, "") || "/" : row.detail;
  if (row.kind === "파일") return `${owner} / ${row.detail.slice(owner.length + 3)}`;
  if (row.kind === "에이전트") {
    const agent = ctx.getLastAgents().find((a) => a.paneId === row.id && a.workspaceId === row.spaceId);
    const name = agent?.agent ? agent.agent[0].toUpperCase() + agent.agent.slice(1) : "에이전트";
    return `${owner} · ${name} · ${stateLabel(agent)}`;
  }
  if (row.tabType === "browser" || /^https?:/i.test(row.path)) {
    try { return `${owner} · ${new URL(row.path).host}`; } catch { return row.detail; }
  }
  return row.detail;
}

function kindIcon(row) {
  if (row.kind === "스페이스") return "folder";
  if (row.kind === "에이전트" || row.tabType === "terminal") return "terminal";
  if (row.kind === "파일") return "file";
  // 가운데 탭은 파일 경로이거나 브라우저 주소다.
  return row.path && !/^[a-z][\w+.-]*:/i.test(row.path) ? "file" : "globe";
}

function choose(row) {
  if (!row) return;
  // 선택 당시 객체가 이미 사라졌다면 서버 상태가 갱신된 뒤 다시 고르게 한다.
  const space = ctx.orderedSpaces().find((s) => s.id === row.spaceId);
  if (!space) { render(); return; }
  if (row.kind === "에이전트" && !ctx.getLastAgents().some((agent) => agent.paneId === row.id
    && agent.workspaceId === row.spaceId && row.terminalId && row.terminalId === agent.terminalId)) {
    render(); return;
  }
  if (row.tabType === "terminal" && !getTabsForSpace(row.spaceId).some((tab) => tab.tabId === row.id)) {
    render(); return;
  }
  if (row.tabType === "browser" && !(ctx.getBrowserState().tabsBySpace?.[row.spaceId] || []).some((tab) => tab.id === row.id)) {
    render(); return;
  }
  close();
  if (row.kind === "스페이스") { ctx.focusSpace(row.spaceId); return; }
  if (row.kind === "에이전트") { ctx.selectSession(row.id, false, "search"); return; }
  if (row.kind === "파일") { ctx.focusSpace(row.spaceId); openFile(row.id); return; }
  ctx.focusSpace(row.spaceId);
  if (row.tabType === "terminal") ctx.wsSend({ type: "tab-focus", tabId: row.id, origin: "search" });
  else if (getTabs(row.spaceId).some((tab) => tab.id === row.id)) {
    setActiveTab(row.spaceId, row.id); ctx.renderTabs(); ctx.showActiveTab();
  } else if (row.tabType === "browser") {
    // 분리 브라우저의 탭은 브라우저 상태가 소유한다.
    ctx.wsSend({ type: "browser-sync", mutation: { op: "tab.switch", space: row.spaceId, id: row.id } });
  }
}

function close() {
  if (!searchOpen) return;
  searchOpen = false;
  backdrop.hidden = true; waiting.clear();
  if (previousFocus?.isConnected) previousFocus.focus(); else trigger.focus();
}

export function openUnifiedSearch() {
  ensureDialog();
  if (searchOpen) { input.focus(); return; }
  searchOpen = true; previousFocus = document.activeElement;
  input.value = ""; category = "전체"; selected = 0;
  backdrop.querySelectorAll("[data-kind]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.kind === "전체")));
  backdrop.hidden = false; render(); input.focus();
}

export function initCapability(context) {
  ctx = context;
  const head = document.querySelector(".sidebar-head");
  if (!head) return {};
  trigger = document.createElement("button");
  trigger.type = "button"; trigger.id = "header-search";
  trigger.className = "cc-btn cc-btn-txt cc-btn-icon unified-search-trigger";
  trigger.title = "통합 검색"; trigger.setAttribute("aria-label", "통합 검색");
  trigger.innerHTML = SEARCH_ICON;
  trigger.addEventListener("click", openUnifiedSearch);
  head.append(trigger);
  provide("unifiedsearch.tree", onTree);
  return {};
}
