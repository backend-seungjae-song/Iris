// 에이전트 채팅 보기. 오른쪽 터미널의 Claude Code·Codex pane 을 대화 기록 기반 채팅 화면으로
// 바꿔 보고, 서브에이전트 줄을 누르면 그 서브에이전트의 대화를 읽기 전용으로 연다.
//
// 소유 범위
//   터미널 머리의 전환 단추, 터미널 위에 덮는 채팅 판, pane 별 보기 기억, 구독(agentchat.*),
//   입력창의 전송 순서, ⌘⇧J.
//
// 제공 API
//   initCapability(ctx) → { ws }. 앱 셸은 이름으로만 부른다:
//   agentchat.sync(선택 pane·상태가 바뀜) · agentchat.openSubagent({ paneId, agentId, … }).
//
// 의존 대상
//   agentchat/view.js · agentchat/fold.js, core/hooks.js · core/keymap.js. 앱 셸 DOM 은
//   #right 머리(.right-head)와 #terminal 만 찾는다.
//
// 유지 조건
//   터미널(xterm·PTY)은 채팅 판 아래에서 그대로 돈다. 채팅 판은 덮기만 하고 터미널을 멈추거나
//   옮기지 않는다. 입력은 터미널과 같은 pty.input 으로 보낸다(Ctrl+U 로 줄을 비우고, 여러 줄은
//   bracketed paste, Enter 는 따로). Enter 를 붙여 보내면 붙여넣기 도중에 제출된다.
//
// 영향 범위
//   main.js·herdr/sync.js 가 agentchat.sync 를, herdr/agents.js 가 agentchat.openSubagent 를 부른다.
//   서버 짝은 server/agent-chat.js. 현재 목록 확인: node bin/importers.mjs web/js/agentchat/boot.js

import { provide } from "../core/hooks.js";
import { bindingOf, matchBinding } from "../core/keymap.js";
import { foldTurns } from "./fold.js";
import { initView, renderTurn, turnSignature } from "./view.js";

const MODE_KEY = "ac.agentchat.mode";
const STICK_PX = 48;
const OLDER_PX = 80;
const ENTER_DELAY_MS = 500;

let ctx;
let $root, $list, $toggle, $compose, $input, $latest, $hint, $head;
const modes = loadModes();          // paneId → "chat"
let view = null;                    // { key, paneId, agentId, kind, messages, hasOlder, loadingOlder, status, reason, sub }
const expanded = new Set();         // 펼친 도구 묶음·도구·생각 줄 key
const turnCache = new Map();        // turn key → { sig, html }
const sendQueues = new Map();       // paneId → Promise

function loadModes() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(MODE_KEY) || "{}"))); } catch { return new Map(); }
}
function saveModes() {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(Object.fromEntries(modes))); } catch {}
}

function agentKind(a) {
  const n = String(a?.agent || "").toLowerCase();
  if (n.startsWith("claude")) return "claude";
  if (n.startsWith("codex")) return "codex";
  return null;
}

function currentAgent() {
  const target = ctx.getCurTarget();
  return target ? (ctx.getLastAgents() || []).find((a) => a.paneId === target) || null : null;
}

const ICON_CHAT = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4z"/><path d="M9 9h6M9 12h4"/></svg>`;
const ICON_TERM = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="m8 10 3 2-3 2M13 15h3"/></svg>`;
const ICON_BACK = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>`;
const ICON_X = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const ICON_DOWN = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`;

export function initCapability(c) {
  ctx = c;
  initView({ esc: ctx.esc, mdToHtml: ctx.mdToHtml });
  const head = document.querySelector("#right .right-head");
  const terminal = document.querySelector("#terminal");
  if (!head || !terminal) return {};

  $toggle = document.createElement("button");
  $toggle.type = "button";
  $toggle.className = "achat-toggle";
  $toggle.hidden = true;
  head.insertBefore($toggle, head.querySelector("#right-collapse"));
  $toggle.addEventListener("click", () => toggleMode());

  $root = document.createElement("div");
  $root.className = "achat";
  $root.hidden = true;
  $root.innerHTML = `
    <div class="achat-head" hidden>
      <button class="achat-ib" type="button" data-achat-back title="부모 에이전트로 돌아가기" aria-label="부모 에이전트로 돌아가기">${ICON_BACK}</button>
      <span class="achat-head-parent"></span><span class="achat-head-sep">›</span><span class="achat-head-desc"></span>
      <span class="achat-head-mk"></span>
      <button class="achat-ib" type="button" data-achat-close title="닫기" aria-label="서브에이전트 대화 닫기">${ICON_X}</button>
    </div>
    <div class="achat-list" tabindex="-1"></div>
    <button class="cc-btn achat-latest" type="button" hidden>${ICON_DOWN}최신으로</button>
    <div class="achat-hint" hidden><span>에이전트가 답을 기다립니다. 선택지는 터미널에서 고릅니다.</span><button class="cc-btn" type="button" data-achat-term>터미널에서 답하기</button></div>
    <form class="achat-compose">
      <textarea class="achat-input" rows="1" placeholder="메시지 보내기 · Enter 전송, ⇧Enter 줄바꿈" aria-label="에이전트에게 보낼 메시지"></textarea>
      <button class="cc-btn cc-btn-pri achat-send" type="submit">보내기</button>
    </form>`;
  terminal.appendChild($root);
  $head = $root.querySelector(".achat-head");
  $list = $root.querySelector(".achat-list");
  $latest = $root.querySelector(".achat-latest");
  $hint = $root.querySelector(".achat-hint");
  $compose = $root.querySelector(".achat-compose");
  $input = $root.querySelector(".achat-input");

  $list.addEventListener("click", onListClick);
  $list.addEventListener("scroll", onScroll, { passive: true });
  $latest.addEventListener("click", () => { $list.scrollTop = $list.scrollHeight; $latest.hidden = true; });
  $root.querySelector("[data-achat-back]").addEventListener("click", closeSubagent);
  $root.querySelector("[data-achat-close]").addEventListener("click", closeSubagent);
  $hint.querySelector("[data-achat-term]").addEventListener("click", () => setMode(view?.paneId, false));
  $compose.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  $input.addEventListener("keydown", (e) => {
    e.stopPropagation();   // 전역 단축키가 입력 중 글자를 가져가지 않게
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
  $input.addEventListener("input", autosize);
  // 채팅 판 위의 휠·드래그가 터미널로 새지 않게 한다(터미널이 스크롤백을 움직인다).
  $root.addEventListener("wheel", (e) => e.stopPropagation());
  $root.addEventListener("mousedown", (e) => e.stopPropagation());

  // 키를 받았으면 참. 웹뷰에 포커스가 있을 때는 main 이 같은 키를 가로채 agentchat.toggle 로 보낸다.
  const toggleByKey = () => {
    if (view?.agentId) { closeSubagent(); return true; }
    if (!agentKind(currentAgent())) return false;
    toggleMode();
    return true;
  };
  document.addEventListener("keydown", (e) => {
    if (!matchBinding(e, bindingOf("agent-chat"))) return;
    if (!toggleByKey()) return;
    e.preventDefault(); e.stopPropagation();
  }, true);

  provide("agentchat.sync", () => sync());
  provide("agentchat.toggle", () => { toggleByKey(); });
  provide("agentchat.openSubagent", (info) => openSubagent(info));
  sync();
  return {
    ws: {
      "agentchat.frame": onFrame,
      "agentchat.older": onOlder,
      // 서버는 연결이 끊기면 구독을 모두 버린다. 다시 붙었으면 보던 것을 다시 연다.
      "agentchat.hello": () => { if (view) subscribe(); },
    },
  };
}

function toggleMode() {
  const a = currentAgent();
  if (!agentKind(a)) return;
  setMode(a.paneId, modes.get(a.paneId) !== "chat");
}

function setMode(paneId, chat) {
  if (!paneId) return;
  if (chat) modes.set(paneId, "chat"); else modes.delete(paneId);
  saveModes();
  sync();
  if (chat) setTimeout(() => $input?.focus(), 0);
  else document.querySelector("#terminal .xterm-helper-textarea")?.focus();
}

// 앱 셸이 선택 pane·에이전트 상태가 바뀔 때 부른다. 여기서 보일 것과 구독을 맞춘다.
function sync() {
  if (!$root) return;
  const a = currentAgent();
  const kind = agentKind(a);
  $toggle.hidden = !kind;
  const chat = !!kind && modes.get(a.paneId) === "chat";
  $toggle.classList.toggle("on", chat);
  $toggle.setAttribute("aria-pressed", String(chat));
  $toggle.innerHTML = chat ? ICON_TERM : ICON_CHAT;
  $toggle.title = chat ? "터미널로 보기 (⌘⇧J)" : "채팅으로 보기 (⌘⇧J)";
  $toggle.setAttribute("aria-label", $toggle.title);

  // 서브에이전트 보기는 부모 pane 에 딸려 있다. 다른 pane 을 고르면 닫는다.
  if (view?.agentId && view.paneId !== a?.paneId) closeView();
  if (view?.agentId) { updateStatus(a); return; }

  if (chat) {
    if (!view || view.paneId !== a.paneId) startView({ paneId: a.paneId, agentId: null, kind });
    updateStatus(a);
  } else if (view) closeView();
}

function startView(spec) {
  if (view) unsubscribe();
  view = { key: `${spec.agentId ? "sub" : "pane"}:${spec.paneId}:${spec.agentId || ""}:${Date.now()}`,
    paneId: spec.paneId, agentId: spec.agentId || null, kind: spec.kind, messages: [], hasOlder: false,
    loadingOlder: false, status: null, reason: "", loaded: false, parentLabel: spec.parentLabel || "",
    description: spec.description || "", agentType: spec.agentType || "" };
  expanded.clear();
  turnCache.clear();
  $root.hidden = false;
  $root.classList.toggle("sub", !!view.agentId);
  $head.hidden = !view.agentId;
  $compose.hidden = !!view.agentId;
  if (view.agentId) {
    $head.querySelector(".achat-head-parent").textContent = view.parentLabel || "에이전트";
    $head.querySelector(".achat-head-desc").textContent = view.description || view.agentType || "서브에이전트";
    $head.querySelector(".achat-head-mk").textContent = view.agentType || "agent";
  }
  $list.innerHTML = `<div class="achat-empty"><div class="achat-empty-t">대화 기록을 읽는 중</div></div>`;
  $latest.hidden = true;
  subscribe();
}

function closeView() {
  unsubscribe();
  view = null;
  $root.hidden = true;
  $list.innerHTML = "";
  $hint.hidden = true;
}

function subscribe() {
  if (!view) return;
  ctx.wsSend({ type: "agentchat.open", key: view.key, paneId: view.paneId, ...(view.agentId ? { agentId: view.agentId } : {}) });
}

function unsubscribe() {
  if (view) ctx.wsSend({ type: "agentchat.close", key: view.key });
}

function openSubagent(info) {
  if (!info || !info.paneId || !info.agentId) return;
  startView({ paneId: info.paneId, agentId: String(info.agentId), kind: "claude",
    parentLabel: info.parentLabel, description: info.description, agentType: info.agentType });
  updateStatus(currentAgent());
}

// 서브에이전트 보기를 닫으면 그 pane 의 원래 보기(채팅 또는 터미널)로 돌아간다.
function closeSubagent() {
  if (!view?.agentId) return;
  closeView();
  sync();
}

function updateStatus(a) {
  if (!view) return;
  const blocked = !view.agentId && a && a.paneId === view.paneId && a.status === "blocked";
  $hint.hidden = !blocked;
}

function atBottom() {
  return $list.scrollHeight - $list.scrollTop - $list.clientHeight <= STICK_PX;
}

function onFrame(m) {
  if (!view || m.key !== view.key) return;
  if (m.kind === "missing" || m.kind === "error") {
    if (!view.loaded) renderEmpty(m.reason || "대화 기록을 찾지 못했습니다");
    return;
  }
  const stick = !view.loaded || atBottom();
  if (m.kind === "snapshot" || m.kind === "replacement") {
    view.messages = Array.isArray(m.messages) ? m.messages : [];
    view.hasOlder = !!m.hasOlder;
    turnCache.clear();
  } else if (m.kind === "append") {
    view.messages = view.messages.concat(Array.isArray(m.messages) ? m.messages : []);
  }
  view.loaded = true;
  render();
  if (stick) { $list.scrollTop = $list.scrollHeight; $latest.hidden = true; }
  else if (m.kind === "append") $latest.hidden = false;
}

function onOlder(m) {
  if (!view || m.key !== view.key) return;
  view.loadingOlder = false;
  view.hasOlder = !!m.hasOlder;
  if (!Array.isArray(m.messages) || !m.messages.length) { render(); return; }
  // 앞에 붙인 만큼 스크롤 위치를 내려 보던 줄이 그 자리에 남게 한다.
  const before = $list.scrollHeight - $list.scrollTop;
  view.messages = m.messages.concat(view.messages);
  render();
  $list.scrollTop = $list.scrollHeight - before;
}

function onScroll() {
  if (!view) return;
  if (atBottom()) $latest.hidden = true;
  if (view.hasOlder && !view.loadingOlder && $list.scrollTop < OLDER_PX) {
    view.loadingOlder = true;
    ctx.wsSend({ type: "agentchat.older", key: view.key });
  }
}

function renderEmpty(reason) {
  const canTerm = !view?.agentId;
  $list.innerHTML = `<div class="achat-empty"><div class="achat-empty-t">대화 기록을 보여 줄 수 없습니다</div>`
    + `<div class="achat-empty-s">${ctx.esc(reason)}</div>`
    + (canTerm ? `<div class="achat-empty-acts"><button class="achat-empty-act" type="button" data-achat-empty-term>${ICON_TERM}터미널로 보기</button></div>` : "")
    + `</div>`;
}

function render() {
  if (!view) return;
  const turns = foldTurns(view.messages);
  if (!turns.length) {
    $list.innerHTML = `<div class="achat-empty"><div class="achat-empty-t">아직 대화가 없습니다</div>`
      + `<div class="achat-empty-s">${view.agentId ? "서브에이전트가 첫 메시지를 쓰면 여기에 나타납니다." : "아래 입력창에 쓰면 터미널로 보냅니다."}</div></div>`;
    return;
  }
  const html = [];
  if (view.hasOlder) html.push(`<div class="achat-older">${view.loadingOlder ? "이전 대화를 읽는 중" : "위로 올리면 이전 대화를 더 읽습니다"}</div>`);
  const seen = new Set();
  for (const t of turns) {
    seen.add(t.key);
    const sig = turnSignature(t, expanded);
    const hit = turnCache.get(t.key);
    if (hit && hit.sig === sig) { html.push(hit.html); continue; }
    const out = renderTurn(t, view.kind, expanded);
    turnCache.set(t.key, { sig, html: out });
    html.push(out);
  }
  for (const k of [...turnCache.keys()]) if (!seen.has(k)) turnCache.delete(k);
  $list.innerHTML = html.join("");
}

function onListClick(e) {
  const t = e.target instanceof Element ? e.target.closest("[data-achat-toggle]") : null;
  if (t) {
    const k = t.dataset.achatToggle;
    if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
    const keep = $list.scrollTop;
    render();
    $list.scrollTop = keep;
    return;
  }
  if (e.target instanceof Element && e.target.closest("[data-achat-empty-term]") && view) setMode(view.paneId, false);
}

function autosize() {
  $input.style.height = "auto";
  $input.style.height = `${Math.min($input.scrollHeight, 160)}px`;
}

// 보낼 글을 PTY 입력 조각으로 바꾼다. 여러 줄은 bracketed paste 로 감싸 에이전트 입력창이 한 번에
// 받게 하고, 제출(Enter)은 붙여넣기가 끝난 뒤 따로 보낸다.
export function ptyChunks(text) {
  const body = text.replace(/\r\n?/g, "\n");
  const payload = body.includes("\n") ? `\x1b[200~${body}\x1b[201~` : body;
  return ["\x15", payload, "\r"];
}

function submit() {
  if (!view || view.agentId) return;
  const text = $input.value;
  if (!text.trim()) return;
  const paneId = view.paneId;
  // 터미널 입력은 지금 오른쪽에 붙은 pane 으로 간다. 다른 pane 을 보고 있으면 보내지 않는다.
  if (ctx.getCurTarget() !== paneId) { ctx.showToast("보고 있는 pane 이 바뀌어 보내지 않았습니다"); return; }
  $input.value = "";
  autosize();
  const [clear, payload, enter] = ptyChunks(text);
  const prev = sendQueues.get(paneId) || Promise.resolve();
  const next = prev.then(() => new Promise((resolve) => {
    ctx.wsSend({ type: "pty.input", data: clear });
    ctx.wsSend({ type: "pty.input", data: payload });
    setTimeout(() => { ctx.wsSend({ type: "pty.input", data: enter }); resolve(); }, ENTER_DELAY_MS);
  }));
  sendQueues.set(paneId, next);
  next.then(() => { if (sendQueues.get(paneId) === next) sendQueues.delete(paneId); });
  $list.scrollTop = $list.scrollHeight;
}
