import { shortcutLabel } from "../core/keymap.js";
// 에이전트 채팅 보기. 오른쪽 터미널의 Claude Code·Codex pane 을 대화 기록 기반 채팅 화면으로
// 바꿔 보고, 서브에이전트 줄을 누르면 그 서브에이전트의 대화를 읽기 전용으로 연다.
// 대화 목록은 Paseo 대화 화면 빌드(/paseo-ui/, server/paseo-ui)가 iframe 안에서 그린다.
//
// 소유 범위
//   터미널 머리의 전환 단추, 터미널 위에 덮는 채팅 판, pane 별 보기 기억, 구독(agentchat.*),
//   iframe 에 대화 상태 전달, 입력창의 전송 순서, ⌘⇧J.
//
// 제공 API
//   initCapability(ctx) → { ws }. 앱 셸은 이름으로만 부른다:
//   agentchat.sync(선택 pane·상태가 바뀜) · agentchat.openSubagent({ paneId, agentId, … }).
//
// 의존 대상
//   core/hooks.js · core/keymap.js · center/file-routing.js(답변 링크 열기). 앱 셸 DOM 은 #right 머리(.right-head)와 #terminal 만 찾는다.
//   iframe 쪽 짝은 server/paseo-ui/entry/iris-chat-entry.tsx(postMessage iris-chat.*).
//
// 유지 조건
//   터미널(xterm·PTY)은 채팅 판 아래에서 그대로 돈다. 채팅 판은 덮기만 하고 터미널을 멈추거나
//   옮기지 않는다. 입력은 agentchat.send 로 서버에 보내고 서버가 구독한 pane 에 넣는다.
//   iframe 은 같은 출처라 postMessage 대상 출처를 location.origin 으로 고정한다. iframe 은 한 번
//   만들고 pane 이 바뀌어도 다시 읽지 않는다(Paseo 화면 로딩이 수 초 걸린다).
//
// 영향 범위
//   main.js·herdr/sync.js 가 agentchat.sync 를, herdr/agents.js 가 agentchat.openSubagent 를 부른다.
//   서버 짝은 server/agent-chat.js. 현재 목록 확인: node bin/importers.mjs web/js/agentchat/boot.js

import { provide } from "../core/hooks.js";
import { ANYWHERE, MAIN_WINDOW, bindingOf, matchBinding, resolvedKeymap } from "../core/keymap.js";
import { openInSpaceBrowser, openTerminalTarget, revealTerminalPath, wantsReveal } from "../center/file-routing.js";
import { DEFAULT_VIEW_KEY, chatFor, parseDefaultView, settingsSection } from "./view-pref.js";
import { chatPickBlock, chatPickContent, chatPickUnit } from "./chat-pick.js";

const MODE_KEY = "ac.agentchat.mode";
const CONTEXT_KEY = "ac.agentchat.contexts";

let ctx;
let $root, $list, $frame, $empty, $loading, $toggle, $hint, $head;
const modes = loadModes();          // paneId → "chat" | "term"
let view = null;                    // { key, paneId, agentId, kind, messages, hasOlder, loadingOlder, loaded, reason }
let ui = { phase: "none", url: null, build: null, message: "" };   // Paseo 화면 빌드 상태(서버 agentchat.ui)
let frameReady = false;             // iframe 진입 파일이 iris-chat.ready 를 보냄
let frameWatch = null;              // { build, timer, at } 새로 띄운 빌드가 뜨는지 보는 중
const FRAME_READY_MS = 30 * 1000;
// 대화 보기를 닫고 이만큼 지나면 iframe 을 비워 Paseo 런타임·저장소·이미지 캐시를 놓음
const FRAME_RELEASE_MS = 5 * 60 * 1000;
let releaseTimer = null;
// 요소 선택 블록. 대화(pane+세션)마다 따로, 보낼 때까지 localStorage 에 저장(앱을 다시 켜도 남음). 칩으로 보이고 보낼 때 글 앞에 붙음
// - 사라진 pane 의 칩은 지우지 않음. 시작 직후 pane 목록이 비어 있을 때 지우면 남아야 할 칩까지 사라짐
const contexts = loadContexts();     // 대화 키(pane+세션) → [{ id, content, no, kind? }]
const pendingContexts = new Map();   // 전송 id → { owner, ids } 성공하면 그 칩을 뺌
const CONTEXT_MAX = 20;
// 마지막으로 받은 Codex 모델 목록(~/.codex/models_cache.json). 세션과 무관하므로 새 보기의 meta 가 오기 전에도 씀
let codexModelsSeen = null;

function loadModes() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(MODE_KEY) || "{}"))); } catch { return new Map(); }
}
function saveModes() {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(Object.fromEntries(modes))); } catch {}
}
function loadContexts() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTEXT_KEY) || "{}");
    return new Map(Object.entries(raw).map(([paneId, list]) => [paneId,
      (Array.isArray(list) ? list : []).filter((c) => typeof c?.id === "string" && typeof c?.content === "string")])
      .filter(([, list]) => list.length));
  } catch { return new Map(); }
}
function saveContexts() {
  try { localStorage.setItem(CONTEXT_KEY, JSON.stringify(Object.fromEntries(contexts))); } catch {}
}

function sessionOf(a) { return String(a?.sessionUuid || ""); }

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

export function initCapability(c) {
  ctx = c;
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
    <div class="achat-list">
      <iframe class="achat-frame" title="에이전트 대화" hidden></iframe>
      <div class="achat-empty" hidden></div>
      <div class="achat-loading" role="status" hidden><span class="achat-spin" aria-hidden="true"></span>대화를 불러오는 중</div>
    </div>
    <div class="achat-hint" hidden><span>에이전트가 답을 기다립니다. 선택지는 터미널에서 고릅니다.</span><button class="cc-btn" type="button" data-achat-term>터미널에서 답하기</button></div>
`;
  terminal.appendChild($root);
  $head = $root.querySelector(".achat-head");
  $list = $root.querySelector(".achat-list");
  $frame = $root.querySelector(".achat-frame");
  $empty = $root.querySelector(".achat-empty");
  $loading = $root.querySelector(".achat-loading");
  $hint = $root.querySelector(".achat-hint");

  $empty.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-achat-empty-term]") && view) setMode(view.paneId, false);
  });
  $frame.addEventListener("load", bindFrameKeys);
  window.addEventListener("message", onFrameMessage);
  // Iris 테마(밝음·어두움)가 바뀌면 Paseo 화면에도 알린다
  new MutationObserver(() => postState()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  $root.querySelector("[data-achat-back]").addEventListener("click", closeSubagent);
  $root.querySelector("[data-achat-close]").addEventListener("click", closeSubagent);
  $hint.querySelector("[data-achat-term]").addEventListener("click", () => setMode(view?.paneId, false));
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
  onToggleKey = (e) => {
    if (!matchBinding(e, bindingOf("agent-chat"))) return;
    if (!toggleByKey()) return;
    e.preventDefault(); e.stopPropagation();
  };
  document.addEventListener("keydown", onToggleKey, true);

  provide("agentchat.sync", () => sync());
  provide("agentchat.settingsSection", () => ({ ...settingsSection(defaultView(), settingsFrameHeight), set: (key, value) => { if (key === "defaultView") setDefaultView(value); } }));
  window.addEventListener("message", onSettingsFrameSize);
  provide("agentchat.toggle", () => { toggleByKey(); });
  provide("agentchat.openSubagent", (info) => openSubagent(info));
  // 요소 선택 기능들이 터미널에 붙이기 전에 부른다. 대화 보기가 열려 있으면 칩으로 받고 true
  // - inline: @파일 멘션처럼 글 사이에 쓰는 것은 칩이 아니라 입력창 글에 넣음
  provide("agentchat.paste", (text, opts) => paste(text, opts));
  // 요소 선택 모드에서 대화 화면 안의 대화도 고름. web/js/browser/pick.js 가 마우스 아래 대상·모드 변경 때 부름
  provide("agentchat.pickTarget", (under, pt) => chatPickAt(under, pt));
  provide("agentchat.pickMode", (on) => setChatPickMode(on));
  // 브라우저 탭이 없어도 대화 화면이 열려 있으면 요소 선택을 켤 수 있음(서버 판정 hasChatContext)
  provide("agentchat.hasPickContext", () => !!frameDoc());
  // herdr/agents.js 가 부모 에이전트 줄을 누를 때 호출한다. 이 pane 의 서브에이전트 보기를 닫았으면 true 를 반환한다.
  provide("agentchat.closeSubagent", (paneId) => {
    if (!view?.agentId || view.paneId !== paneId) return false;
    closeSubagent();
    return true;
  });
  sync();
  return {
    ws: {
      "agentchat.frame": onFrame,
      "agentchat.older": onOlder,
      "agentchat.ui": onUi,
      "agentchat.sent": onSent,
      "agentchat.commands": onToolReply,
      "agentchat.files": onToolReply,
      "agentchat.meta": onMeta,
      "agentchat.tasks": onTasks,
      "agentchat.taskread": onToolReply,
      // 권한 답·모드 변경 결과. iframe 요청 이름(iris-chat.answer·mode)으로 돌려줌
      "agentchat.answered": (m) => onToolReply({ ...m, type: "agentchat.answer" }),
      "agentchat.moded": (m) => onToolReply({ ...m, type: "agentchat.mode" }),
      // 서버는 연결이 끊기면 구독을 모두 버린다. 다시 붙었으면 보던 것을 다시 연다.
      "agentchat.hello": () => { if (view) subscribe(); },
    },
  };
}

// ── 대화 화면 안 요소 선택 ──
// - 마우스 위치는 부모(pick.js)가 OS 커서로 알려 줌. 누름은 iframe 문서에서 직접 받음(부모 문서로 오지 않음)
// - 강조 모양은 부모의 .pick-hover 와 같은 색(--pick-ring). iframe 은 부모 CSS 를 못 봐서 문서에 직접 넣음
let chatPicking = false;
let chatPickDoc = null;
const CHAT_PICK_SWALLOW = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
function frameDoc() {
  try { return frameReady && $frame && !$frame.hidden ? $frame.contentDocument : null; } catch { return null; }
}
function chatPickAt(under, pt) {
  if (!chatPicking || !$frame || under !== $frame || !pt) return null;
  const doc = frameDoc();
  if (!doc) return null;
  const r = $frame.getBoundingClientRect();
  const unit = chatPickUnit(doc.elementFromPoint(pt.x - r.left, pt.y - r.top));
  return unit ? { el: unit.el } : null;
}
function swallowChatPick(e) {
  if (!chatPickUnit(e.target)) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
}
function onChatPickDown(e) {
  const unit = chatPickUnit(e.target);
  if (!unit) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  unit.el.classList.remove("pick-hover");
  const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view?.paneId);
  const where = a?.tabLabel || (a?.cwd ? String(a.cwd).split("/").pop() : a?.agent) || "";
  const { text, image } = chatPickContent(unit);
  if (!text && !image) return;
  paste(chatPickBlock({ pid: `c${Math.random().toString(36).slice(2, 6)}`, where, kind: unit.kind, text, image }));
}
function setChatPickMode(on) {
  chatPicking = !!on;
  const doc = chatPicking ? frameDoc() : null;
  if (chatPickDoc && chatPickDoc !== doc) {
    for (const t of CHAT_PICK_SWALLOW) chatPickDoc.removeEventListener(t, swallowChatPick, true);
    chatPickDoc.removeEventListener("pointerdown", onChatPickDown, true);
    chatPickDoc.querySelectorAll(".pick-hover").forEach((el) => el.classList.remove("pick-hover"));
    chatPickDoc.getElementById("iris-chat-pick-style")?.remove();
    chatPickDoc = null;
  }
  if (!doc || chatPickDoc === doc) return;
  chatPickDoc = doc;
  for (const t of CHAT_PICK_SWALLOW) doc.addEventListener(t, swallowChatPick, true);
  doc.addEventListener("pointerdown", onChatPickDown, true);
  const ring = getComputedStyle(document.documentElement).getPropertyValue("--pick-ring").trim() || "#4ea1ff";
  const style = doc.createElement("style");
  style.id = "iris-chat-pick-style";
  style.textContent = `.pick-hover { outline: 2px solid ${ring} !important; outline-offset: 2px; border-radius: 6px; background: color-mix(in srgb, ${ring} 14%, transparent) !important; cursor: crosshair; }`;
  doc.head.appendChild(style);
}

function paste(text, opts) {
  if (!view || view.agentId || typeof text !== "string" || !text.trim()) return false;
  if (opts?.inline) {
    if (!frameReady) return false;
    $frame.contentWindow?.postMessage({ type: "iris-chat.insert", key: view.key, text }, location.origin);
    return true;
  }
  addContext(text);
  focusFrame();
  return true;
}
// 칩 하나 추가. no = 입력 글 속 칩 번호(그 대화 안에서 바뀌지 않음), kind "paste" = 입력창에 길게 붙여 넣은 글
function addContext(content, kind) {
  const list = contexts.get(view.key) || [];
  if (list.length >= CONTEXT_MAX) { ctx.showToast(`입력창에는 ${CONTEXT_MAX}개까지 붙일 수 있습니다`, { level: "warn" }); return; }
  const no = Math.max(0, ...list.map((c) => (Number.isInteger(c.no) ? c.no : 0))) + 1;
  contexts.set(view.key, [...list, { id: crypto.randomUUID(), content, no, ...(kind ? { kind } : {}) }]);
  saveContexts();
  postState();
}
function focusFrame() {
  if (frameReady && view) $frame.contentWindow?.postMessage({ type: "iris-chat.focus", key: view.key }, location.origin);
}
function removeContexts(owner, ids) {
  const list = contexts.get(owner);
  if (!list) return;
  const next = ids ? list.filter((c) => !ids.includes(c.id)) : [];
  if (next.length) contexts.set(owner, next); else contexts.delete(owner);
  saveContexts();
}

function isChat(a) {
  return chatFor(modes.get(a.paneId), defaultView(), a.parentPaneId);
}

// 설정 > 대화 화면의 Paseo 설정 iframe 높이. 설정 화면이 다시 그려져도 마지막 높이로 시작
let settingsFrameHeight = 0;
function onSettingsFrameSize(e) {
  if (e.origin !== location.origin || e.data?.type !== "iris-chat.panel-size") return;
  const frame = [...document.querySelectorAll('iframe[data-fs-frame="agentchat:paseoChat"]')].find((f) => f.contentWindow === e.source);
  const height = Number(e.data.height);
  if (!frame || !Number.isFinite(height) || height <= 0) return;
  settingsFrameHeight = Math.min(Math.round(height), 2000);
  frame.style.height = `${settingsFrameHeight}px`;
}

function defaultView() {
  try { return parseDefaultView(localStorage.getItem(DEFAULT_VIEW_KEY)); } catch { return parseDefaultView(null); }
}
function setDefaultView(value) {
  try { localStorage.setItem(DEFAULT_VIEW_KEY, parseDefaultView(value)); } catch {}
  sync();
}

function toggleMode() {
  const a = currentAgent();
  if (!agentKind(a)) return;
  setMode(a.paneId, !isChat(a));
}

// 대화 분기: 원래 pane 과 같은 herdr 워크스페이스·폴더에 새 탭을 만들고 같은 에이전트를 실행
// - 그 뒤 처음 고른 새 에이전트 pane 을 대화 화면으로 열고 입력창에 채팅 기록 첨부를 넘김
// - 2분 안에 새 pane 이 안 보이면 버림
const FORK_WAIT_MS = 2 * 60 * 1000;
let pendingFork = null;   // { attachment, sourceKey, known: 분기 때 있던 pane, at }
let forkAttach = null;    // { key, sourceKey, attachment } 대화 화면에 아직 넘기지 않은 첨부
function startFork(attachment) {
  const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId);
  if (!a?.workspaceId || !view.kind) { ctx.showToast("분기하지 못했습니다: 이 대화의 herdr 워크스페이스를 찾지 못했습니다", { level: "warn" }); return; }
  pendingFork = { attachment, sourceKey: view.key, known: new Set((ctx.getLastAgents() || []).map((x) => x.paneId)), at: Date.now() };
  ctx.wsSend({ type: "tab.create", workspaceId: a.workspaceId, ...(a.cwd ? { cwd: a.cwd } : {}), launch: view.kind });
}
function claimForkPane(a, kind) {
  if (!pendingFork || !a || !kind || pendingFork.known.has(a.paneId)) return;
  const f = pendingFork;
  pendingFork = null;
  if (Date.now() - f.at > FORK_WAIT_MS) return;
  if (!isChat(a)) { modes.set(a.paneId, "chat"); saveModes(); }
  forkAttach = { paneId: a.paneId, sourceKey: f.sourceKey, attachment: f.attachment };
}

function setMode(paneId, chat) {
  if (!paneId) return;
  modes.set(paneId, chat ? "chat" : "term");
  saveModes();
  sync();
  if (chat) focusFrame();
  else document.querySelector("#terminal .xterm-helper-textarea")?.focus();
}

// 앱 셸이 선택 pane·에이전트 상태가 바뀔 때 부른다. 여기서 보일 것과 구독을 맞춘다.
function sync() {
  if (!$root) return;
  const a = currentAgent();
  const kind = agentKind(a);
  claimForkPane(a, kind);
  $toggle.hidden = !kind;
  const chat = !!kind && isChat(a);
  $toggle.classList.toggle("on", chat);
  $toggle.setAttribute("aria-pressed", String(chat));
  $toggle.innerHTML = chat ? ICON_TERM : ICON_CHAT;
  $toggle.title = chat ? shortcutLabel("터미널로 보기 (⌘⇧J)") : shortcutLabel("채팅으로 보기 (⌘⇧J)");
  $toggle.setAttribute("aria-label", $toggle.title);

  // 서브에이전트 보기는 부모 pane 에 딸려 있다. 다른 pane 을 고르면 닫는다.
  if (view?.agentId && view.paneId !== a?.paneId) closeView();
  if (view?.agentId) { updateStatus(a); return; }

  if (chat) {
    // 같은 pane 에서 다른 세션이 시작되면 새 대화로 엶. 초안·칩이 이전 세션 것과 섞이지 않게
    if (!view || view.paneId !== a.paneId || view.session !== sessionOf(a)) startView({ paneId: a.paneId, agentId: null, kind, session: sessionOf(a) });
    updateStatus(a);
  } else if (view) closeView();
}

function startView(spec) {
  clearTimeout(releaseTimer);
  if (view) unsubscribe();
  // 키는 대화(pane+세션)마다 고정. Paseo 는 이 키(에이전트 id)로 입력창 초안을 저장하므로 바뀌면 다시 열 때 초안이 사라짐
  view = { key: spec.agentId ? `sub:${spec.paneId}:${spec.agentId}` : `pane:${spec.paneId}:${spec.session || ""}`,
    session: spec.session || "",
    paneId: spec.paneId, agentId: spec.agentId || null, kind: spec.kind, messages: [], hasOlder: false,
    loadingOlder: false, reason: "", loaded: false, parentLabel: spec.parentLabel || "",
    description: spec.description || "", agentType: spec.agentType || "", tasks: [] };
  $root.hidden = false;
  $root.classList.toggle("sub", !!view.agentId);
  $head.hidden = !view.agentId;
  if (view.agentId) {
    $head.querySelector(".achat-head-parent").textContent = view.parentLabel || "에이전트";
    $head.querySelector(".achat-head-desc").textContent = view.description || view.agentType || "서브에이전트";
    $head.querySelector(".achat-head-mk").textContent = view.agentType || "agent";
  }
  render();
  subscribe();
}

function closeView() {
  unsubscribe();
  view = null;
  $root.hidden = true;
  $hint.hidden = true;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseFrame, FRAME_RELEASE_MS);
}

function releaseFrame() {
  if (view || !$frame?.getAttribute("src")) return;
  clearTimeout(frameWatch?.timer);
  frameWatch = null;
  frameReady = false;
  $frame.removeAttribute("src");
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
  view.blocked = !view.agentId && a && a.paneId === view.paneId && a.status === "blocked";
  syncHint();
  postState();
}

function onFrame(m) {
  if (!view || m.key !== view.key) return;
  if (m.kind === "missing" || m.kind === "error") {
    if (!view.loaded) { view.reason = m.reason || "대화 기록을 찾지 못했습니다"; render(); }
    return;
  }
  if (m.kind === "snapshot" || m.kind === "replacement") {
    view.messages = Array.isArray(m.messages) ? m.messages : [];
    view.hasOlder = !!m.hasOlder;
    view.file = typeof m.file === "string" ? m.file : null;
    view.gen = typeof m.gen === "string" ? m.gen : null;
  } else if (m.kind === "append") {
    view.messages = view.messages.concat(Array.isArray(m.messages) ? m.messages : []);
  }
  view.loaded = true;
  view.reason = "";
  render();
}

// 서버가 기록·화면에서 읽은 지금 모델·effort·모드·사용량과 답을 기다리는 질문
// 답 기다림 안내: Paseo 권한 카드가 그 질문을 보이면 숨김. 화면에서 질문을 못 읽었으면 터미널로 안내
function syncHint() {
  $hint.hidden = !view?.blocked || !!view.prompt;
}

function onMeta(m) {
  if (!view || m.key !== view.key || view.agentId) return;
  view.agent = m.agent && typeof m.agent === "object" ? m.agent : null;
  view.prompt = m.prompt && typeof m.prompt === "object" ? m.prompt : null;
  // 터미널 입력줄 글. 대화 화면 입력창이 같은 글을 보임(server/agent-chat-draft.js)
  view.draft = m.draft && typeof m.draft.text === "string" ? { text: m.draft.text } : null;
  view.codexModels = Array.isArray(m.codexModels) ? m.codexModels : null;
  if (view.codexModels) codexModelsSeen = view.codexModels;
  syncHint();
  postState();
}

// 백그라운드 셸·Monitor 목록. 출력 끝(tail)은 바뀐 작업에만 오므로 없으면 이전 것을 유지
function onTasks(m) {
  if (!view || m.key !== view.key || !Array.isArray(m.tasks)) return;
  const prev = new Map(m.reset ? [] : view.tasks.map((t) => [t.id, t]));
  view.tasks = m.tasks.filter((t) => t && typeof t.id === "string").map((t) => {
    const old = prev.get(t.id);
    return "tail" in t || !old ? t : { ...t, tail: old.tail, cut: old.cut };
  });
  postState();
}

function onOlder(m) {
  if (!view || m.key !== view.key) return;
  view.loadingOlder = false;
  view.hasOlder = !!m.hasOlder;
  if (Array.isArray(m.messages) && m.messages.length) view.messages = m.messages.concat(view.messages);
  postState();
}

function onUi(m) {
  ui = { phase: String(m.phase || "none"), url: typeof m.url === "string" ? m.url : null,
    build: typeof m.build === "string" ? m.build : null, message: String(m.message || "") };
  render();
}

// 새로 띄운 빌드가 대화를 그렸다는 신호(iris-chat.healthy)를 30초 안에 주지 않거나 그 사이 오류를 내면
// 서버에 알림. 서버가 이전 빌드로 되돌림
// - 대화 기록이 아직 없거나(로딩·기록 없음) 화면이 가려져 있으면 빌드 탓이 아니라서 기다림
function watchFrame() {
  clearTimeout(frameWatch?.timer);
  frameWatch = { build: ui.build, at: Date.now(), timer: null };
  armWatch();
}
function armWatch() {
  if (!frameWatch) return;
  frameWatch.timer = setTimeout(() => {
    if (view?.loaded && !$frame.hidden && !$root.hidden) brokenFrame("대화를 그리지 못함(30초)");
    else { frameWatch.at = Date.now(); armWatch(); }
  }, FRAME_READY_MS);
}
function brokenFrame(reason) {
  if (!frameWatch?.build || !view) return;
  const { build } = frameWatch;
  clearTimeout(frameWatch.timer);
  frameWatch = null;
  ctx.wsSend({ type: "agentchat.ui-broken", key: view.key, build, reason });
}

// iframe 진입 파일이 보내는 것: 준비됨, 오류, 이전 대화 요청
function onFrameMessage(e) {
  if (e.origin !== location.origin || e.source !== $frame?.contentWindow) return;
  if (e.data?.type === "iris-chat.ready") {
    frameReady = true;
    // 요소 선택 중에 대화 화면이 새로 떴으면 새 문서에 다시 연결
    if (chatPicking) setChatPickMode(true);
    syncLoading();
    postState();
  } else if (e.data?.type === "iris-chat.healthy") {
    clearTimeout(frameWatch?.timer);
    frameWatch = null;
  } else if (isInputRequest(e.data?.type)) {
    relayInput(e.data);
  } else if (e.data?.type === "iris-chat.open-subagent" && view && !view.agentId && e.data.key === view.key) {
    const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId);
    const sub = subagentsOf(a).find((s) => s.id === e.data.agentId);
    if (sub) openSubagent({ paneId: view.paneId, agentId: sub.id, parentLabel: a?.tabLabel || (a?.cwd ? String(a.cwd).split("/").pop() : a?.agent) || "", description: sub.description, agentType: sub.agentType });
  } else if (e.data?.type === "iris-chat.fork" && view && !view.agentId && e.data.key === view.key) {
    if (e.data.attachment && typeof e.data.attachment.text === "string") startFork(e.data.attachment);
  } else if (e.data?.type === "iris-chat.open-url" && view && e.data.key === view.key) {
    const url = String(e.data.url || "");
    if (/^https?:\/\//i.test(url)) openInSpaceBrowser(url);
  } else if (e.data?.type === "iris-chat.open-file" && view && e.data.key === view.key) {
    const p = String(e.data.path || "");
    const cwd = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId)?.cwd || "";
    // Paseo 는 작업 폴더 안 파일을 상대 경로로 넘김. 터미널 경로 링크와 같은 함수로 엶, ⌘⇧ 는 Finder
    const full = /^[/~]/.test(p) || !cwd ? p : `${cwd.replace(/\/+$/, "")}/${p}`;
    if (p) (wantsReveal(e.data.mods) ? revealTerminalPath : openTerminalTarget)(full);
  } else if (e.data?.type === "iris-chat.context-add" && view && !view.agentId && e.data.key === view.key) {
    if (typeof e.data.content === "string" && e.data.content) addContext(e.data.content, e.data.kind === "paste" ? "paste" : undefined);
  } else if (e.data?.type === "iris-chat.context-remove" && view && e.data.key === view.key) {
    // ids 가 없으면 모두 지우기
    const ids = Array.isArray(e.data.ids) ? e.data.ids.filter((x) => typeof x === "string") : null;
    removeContexts(view.key, ids);
    postState();
  } else if (e.data?.type === "iris-chat.error") {
    if (frameWatch && Date.now() - frameWatch.at < FRAME_READY_MS) brokenFrame(String(e.data.message || "오류"));
  }
  else if (e.data?.type === "iris-chat.older" && view && view.hasOlder && !view.loadingOlder) {
    view.loadingOlder = true;
    ctx.wsSend({ type: "agentchat.older", key: view.key });
    postState();
  }
}

// iframe 입력창 요청 → 서버. 요청을 만든 대화(key)가 지금 보기와 다르면 보내지 않고 바로 실패로 답함
// - 업로드를 기다리는 사이 다른 pane 으로 옮긴 경우. 그 대화의 구독은 이미 닫힘
const INPUT_TYPES = new Set(["iris-chat.send", "iris-chat.cancel", "iris-chat.commands", "iris-chat.files", "iris-chat.answer", "iris-chat.mode", "iris-chat.taskread"]);
const SUBAGENT_INPUT = new Set(["iris-chat.send", "iris-chat.commands", "iris-chat.files", "iris-chat.taskread"]);
function isInputRequest(type) { return INPUT_TYPES.has(type); }
function relayInput(d) {
  const id = String(d.id ?? "");
  const reason = !view ? "대화 보기가 닫혔습니다"
    // 서브에이전트 보기: 보내기·명령·파일 목록만. 중단·답·모드는 부모 대화에서
    : view.agentId && !SUBAGENT_INPUT.has(d.type) ? "서브에이전트 대화에서는 할 수 없습니다"
      : typeof d.key === "string" && d.key !== view.key ? "다른 대화로 바뀌어 보내지 않았습니다" : "";
  if (reason) {
    if (d.type === "iris-chat.send") $frame.contentWindow?.postMessage({ type: "iris-chat.sent", id, ok: false, reason }, location.origin);
    else if (d.type !== "iris-chat.cancel") $frame.contentWindow?.postMessage({ type: d.type, id, error: reason }, location.origin);
    return;
  }
  if (d.type === "iris-chat.send") {
    if (typeof d.text !== "string") return;
    // 같이 보낸 칩. 보내기에 성공해야 뺌(실패하면 칩이 남아 다시 보낼 수 있게)
    const ids = Array.isArray(d.contextIds) ? d.contextIds.filter((x) => typeof x === "string") : [];
    if (ids.length) pendingContexts.set(id, { owner: view.key, ids });
    ctx.wsSend({ type: "agentchat.send", key: view.key, text: d.text, id });
  } else if (d.type === "iris-chat.cancel") ctx.wsSend({ type: "agentchat.cancel", key: view.key });
  else if (d.type === "iris-chat.answer") ctx.wsSend({ type: "agentchat.answer", key: view.key, id, promptId: String(d.promptId || ""), row: Number(d.row),
    // AskUserQuestion 카드 답(server/agent-chat-question.js)
    ...(d.answers && typeof d.answers === "object" ? { answers: d.answers } : {}), ...(d.dismiss === true ? { dismiss: true } : {}) });
  else if (d.type === "iris-chat.mode") ctx.wsSend({ type: "agentchat.mode", key: view.key, id, modeId: String(d.modeId || "") });
  else if (d.type === "iris-chat.taskread") ctx.wsSend({ type: "agentchat.taskread", key: view.key, id, taskId: String(d.taskId || ""), ...(Number.isInteger(d.from) ? { from: d.from } : {}) });
  else ctx.wsSend({ type: d.type.replace("iris-chat.", "agentchat."), key: view.key, id, ...(typeof d.query === "string" ? { query: d.query } : {}) });
}

// iframe 안에 포커스가 있으면 키 입력이 이 문서로 오지 않음. 단축키 표의 앱 전역 조합만 같은 키로 다시 보냄
// - 편집기·브라우저 탭 전용 조합(⌘B·⌘F 등)은 입력창 동작으로 남김
// - 터미널과 같게 Iris 명령이 입력창 동작(⌥←→ 단어 이동)보다 먼저
let onToggleKey = null;
// - reload-tab(⌘R): 터미널 영역 포커스에선 이름 변경(keynav). 안 넘기면 메뉴 새로고침이 앱 화면을 다시 읽음
const FRAME_FORWARD_IDS = new Set(["reload-tab"]);
const isAppKey = (e) => resolvedKeymap().some((x) => (x.where === ANYWHERE || x.where === MAIN_WINDOW || FRAME_FORWARD_IDS.has(x.id)) && matchBinding(e, x.binding));
function forwardFrameKey(e) {
  if (e.isComposing || !isAppKey(e)) return;
  const copy = new KeyboardEvent("keydown", {
    key: e.key, code: e.code, location: e.location, repeat: e.repeat,
    altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
    modifierAltGraph: !!e.getModifierState?.("AltGraph"), bubbles: true, cancelable: true, composed: true,
  });
  $frame.dispatchEvent(copy);
  if (copy.defaultPrevented) { e.preventDefault(); e.stopImmediatePropagation(); }
}
function bindFrameKeys() {
  frameReady = false;
  try { $frame.contentWindow?.addEventListener("keydown", forwardFrameKey, true); } catch {}
}

function postState() {
  if (!$frame || !frameReady || !view) return;
  const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId) || null;
  const state = {
    key: view.key, paneId: view.paneId, agentId: view.agentId, kind: view.kind, cwd: a?.cwd || "",
    file: view.file || null, gen: view.gen || null,
    messages: view.messages, hasOlder: view.hasOlder, loadingOlder: view.loadingOlder,
    running: !view.agentId && a?.status === "working",
    // 서브에이전트 보기도 입력창을 씀. 보낸 글은 서버가 부모 pane 에 전달 부탁으로 넣음
    readOnly: false,
    contexts: view.agentId ? [] : (contexts.get(view.key) || []),
    agent: view.agentId ? null : (view.agent || null),
    prompt: view.agentId ? null : (view.prompt || null),
    draft: view.agentId ? null : (view.draft || null),
    codexModels: view.codexModels || codexModelsSeen,
    // 지금 돌고 있는 Claude 서브에이전트. Paseo 입력창 위 버튼으로 열면 iris-chat.open-subagent 로 돌아옴
    subagents: view.agentId ? [] : subagentsOf(a),
    // 백그라운드 셸·Monitor(server/agent-chat-tasks.js). 입력창 위 버튼과 도구 카드 출력
    tasks: view.tasks,
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  };
  $frame.contentWindow?.postMessage({ type: "iris-chat.state", state }, location.origin);
  if (forkAttach && forkAttach.paneId === view.paneId && !view.agentId) {
    $frame.contentWindow?.postMessage({ type: "iris-chat.fork-attach", key: view.key, sourceKey: forkAttach.sourceKey, attachment: forkAttach.attachment }, location.origin);
    forkAttach = null;
  }
}

// 사이드바와 같은 목록(server/join.js 의 실행 중 서브에이전트 트리)을 펼친 것
function subagentsOf(a) {
  const out = [];
  const walk = (list) => { for (const s of Array.isArray(list) ? list : []) {
    if (s?.agentId && out.length < 50) out.push({ id: String(s.agentId), description: s.description || "", agentType: s.agentType || "" });
    walk(s?.children);
  } };
  walk(a?.subagents);
  return out;
}

function showEmpty(title, sub, canTerm) {
  $frame.hidden = true;
  $empty.hidden = false;
  $empty.innerHTML = `<div class="achat-empty-t">${ctx.esc(title)}</div>`
    + (sub ? `<div class="achat-empty-s">${ctx.esc(sub)}</div>` : "")
    + (canTerm ? `<div class="achat-empty-acts"><button class="achat-empty-act" type="button" data-achat-empty-term>${ICON_TERM}터미널로 보기</button></div>` : "");
}

function render() {
  if (!view) return;
  const canTerm = !view.agentId;
  if (ui.phase !== "ready" || !ui.url) {
    const building = ui.phase === "building" || ui.phase === "none";
    showEmpty(building ? "대화 화면을 준비하는 중" : "대화 화면을 열 수 없습니다",
      ui.message || (building ? "Paseo 대화 화면을 처음 받아 빌드합니다" : ""), canTerm);
    $loading.hidden = true;
    return;
  }
  if (view.reason && !view.loaded) { showEmpty("대화 기록을 보여 줄 수 없습니다", view.reason, canTerm); $loading.hidden = true; return; }
  $empty.hidden = true;
  $frame.hidden = false;
  if ($frame.getAttribute("src") !== ui.url) { $frame.setAttribute("src", ui.url); watchFrame(); }
  syncLoading();
  postState();
}

// 화면이 뜨고 이 대화 기록을 받을 때까지 덮음. pane 을 바꾼 직후 iframe 에 남은 이전 대화도 가림
function syncLoading() {
  $loading.hidden = !view || $frame.hidden || (frameReady && view.loaded);
}

// 입력창 도구 결과(명령 목록·파일 후보)를 iframe 에 그대로 돌려줌
function onToolReply(m) {
  if (!view || m.key !== view.key) return;
  const { type, key, ...rest } = m;
  $frame.contentWindow?.postMessage({ ...rest, type: type.replace("agentchat.", "iris-chat.") }, location.origin);
}

// 서버 전송 결과는 iframe 에 돌려줌. 보낸 뒤 다른 대화로 바뀌었어도 돌려줌
// - iframe 은 요청 id 로 결과를 찾음. 안 돌려주면 전달된 글도 15초 뒤 실패로 처리됨
// - 다른 대화를 보는 중의 실패는 알림도 띄움
function onSent(m) {
  const done = m.id != null ? pendingContexts.get(m.id) : null;
  if (done) {
    pendingContexts.delete(m.id);
    if (m.ok !== false) { removeContexts(done.owner, done.ids); postState(); }
  }
  const shown = !!view && m.key === view.key;
  if (m.id != null) $frame.contentWindow?.postMessage({ type: "iris-chat.sent", id: m.id, ok: m.ok !== false, reason: m.reason || "" }, location.origin);
  if (m.ok === false && !(shown && m.id != null)) ctx.showToast(`보내지 못했습니다: ${m.reason || "알 수 없는 오류"}`, { level: "warn" });
}
