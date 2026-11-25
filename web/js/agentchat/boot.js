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
//   iframe 은 같은 출처라 postMessage 대상 출처를 location.origin 으로 고정한다. 대화별 iframe·상태 캐시를 통한
//   pane 변경·터미널 왕복 뒤 마지막 화면 즉시 표시.
//
// 영향 범위
//   main.js·herdr/sync.js 가 agentchat.sync 를, herdr/agents.js 가 agentchat.openSubagent 를 부른다.
//   서버 짝은 server/agent-chat.js. 현재 목록 확인: node bin/importers.mjs web/js/agentchat/boot.js

import { setHtml } from "../core/set-html.js";
import { provide } from "../core/hooks.js";
import { needsResnapshot } from "./resnapshot.js";
import { ANYWHERE, MAIN_WINDOW, bindingOf, matchBinding, resolvedKeymap } from "../core/keymap.js";
import { openInSpaceBrowser, openTerminalTarget, revealTerminalPath, wantsReveal } from "../center/file-routing.js";
import { DEFAULT_VIEW_KEY, chatFor, parseDefaultView, settingsSection } from "./view-pref.js";
import { chatPickBlock, chatPickContent, chatPickUnit } from "./chat-pick.js";
import { addTab, getCenterSpace, getTabs, removeTab, setActiveTab, setCenterSpace } from "../center/tab-store.js";
import { registerTabView } from "../core/tab-views.js";
import { createA2uiHost } from "./a2ui.js";
import { showCtx } from "../explorer/context-menu.js";

const MODE_KEY = "ac.agentchat.mode";
const CONTEXT_KEY = "ac.agentchat.contexts";

let ctx;
let cliPanel;
let $root, $list, $frame, $empty, $loading, $toggle, $hint, $head, a2uiHost;
let a2uiTab;
const modes = loadModes();          // paneId → "chat" | "term"
let selectedPane = null;
let terminalWanted = null;
let terminalHandoff = null;
let returningHandoff = null;
let terminalRequestSeq = 0;
const completedHandoffs = new Map();
// 숨긴 iframe 2개·대화 상태 6개까지 보관
const FRAME_CACHE_MAX = 6;
const MAX_CHAT_FRAMES = 5;
const frameCache = new Map();
let view = null;                    // { key, paneId, agentId, kind, messages, hasOlder, loadingOlder, loaded, reason }
let ui = { phase: "none", url: null, build: null, message: "" };   // Paseo 화면 빌드 상태(서버 agentchat.ui)
let frameReady = false;             // iframe 진입 파일이 iris-chat.ready 를 보냄
let frameReusesMessages = false;
let frameBuild = null;
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
// 마지막으로 받은 Codex·Antigravity 모델 목록. 세션과 무관하므로 새 보기의 meta 가 오기 전에도 씀
let codexModelsSeen = null;
let agyModelsSeen = null;

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
  if (a?.embeddedProvider) return a.embeddedProvider;
  if (a?.managedProvider) return a.managedProvider;
  const n = String(a?.agent || "").toLowerCase();
  if (a?.terminalId) {
    const provider = ui.chatProviders?.includes(n) ? n
      : ui.chatProviderAliases && Object.hasOwn(ui.chatProviderAliases, n) ? ui.chatProviderAliases[n] : null;
    if (provider) return provider === "antigravity" ? "agy" : provider;
  }
  if (n.startsWith("claude")) return "claude";
  if (n.startsWith("codex")) return "codex";
  if (n.startsWith("agy") || n.startsWith("antigravity")) return "agy";
  return null;
}

// herdr 가 셸 등 에이전트 아닌 pane 을 보이면 없음 → 대화 화면을 닫고 터미널. 그 pane 의 대화/터미널 선택은 그대로라 돌아오면 다시 열림
function currentAgent() {
  if (ctx.herdrShowsOther?.()) return null;
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
    <button type="button" class="cc-btn achat-cli-toggle" data-achat-cli aria-expanded="false" hidden>CLI 조작</button>
    <div class="achat-cli" hidden></div>
    <div class="achat-list">
      <iframe class="achat-frame" title="에이전트 대화" hidden></iframe>
      <div class="achat-empty" hidden></div>
      <div class="achat-loading" role="status" hidden><span class="achat-spin" aria-hidden="true"></span>대화를 불러오는 중</div>
    </div>
    <div class="achat-hint" hidden><span>에이전트가 답을 기다립니다. 선택지는 터미널에서 고릅니다.</span><button class="cc-btn" type="button" data-achat-term>터미널에서 답하기</button></div>
`;
  terminal.appendChild($root);
  cliPanel = createCliPanel($root, message => ctx.wsSend(message), () => view?.key, reason => ctx.showToast?.(reason, { level: "warn" }));
  $head = $root.querySelector(".achat-head");
  $list = $root.querySelector(".achat-list");
  $frame = $root.querySelector(".achat-frame");
  $empty = $root.querySelector(".achat-empty");
  $loading = $root.querySelector(".achat-loading");
  const root = document.createElement("div");
  root.className = "a2ui-content";
  registerTabView({ kind: "a2ui", panelId: "a2uiview", render() {
    const panel = document.getElementById("a2uiview");
    if (root.parentNode !== panel) panel.replaceChildren(root);
  } });
  $hint = $root.querySelector(".achat-hint");
  a2uiHost = createA2uiHost({
    root,
    onAction: ({ surfaceId, title, action, payload, dataModel }) => {
      if (!view) return;
      const parts = [`[A2UI:${title || surfaceId || "UI"}] ${action || "submit"}`];
      if (payload !== undefined && payload !== null && !(typeof payload === "object" && !Array.isArray(payload) && !Object.keys(payload).length)) {
        parts.push(`payload=${JSON.stringify(payload)}`);
      }
      if (dataModel && typeof dataModel === "object" && Object.keys(dataModel).length) {
        parts.push(`data=${JSON.stringify(dataModel)}`);
      }
      const text = parts.join(" ");
      if (view.managed) $frame.contentWindow?.postMessage({ type: "iris-chat.a2ui-action", key: view.key, text }, location.origin);
      else ctx.wsSend({ type: "agentchat.send", key: view.key, text, id: `a2ui-${Date.now().toString(36)}` });
    },
    onDismiss: (surfaceId) => {
      if (!view) return;
      ctx.wsSend({ type: "agentchat.a2ui-dismiss", key: view.key, id: surfaceId });
    },
  });

  $empty.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-achat-empty-term]") && view) setMode(view.paneId, false);
  });
  $frame.addEventListener("load", bindFrameKeys);
  window.addEventListener("message", onFrameMessage);
  window.addEventListener("focus", acknowledgeSeen);
  document.addEventListener("visibilitychange", acknowledgeSeen);
  // Iris 테마(밝음·어두움)가 바뀌면 Paseo 화면에도 알린다
  new MutationObserver(() => postState()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  $root.querySelector("[data-achat-back]").addEventListener("click", closeSubagent);
  $root.querySelector("[data-achat-close]").addEventListener("click", closeSubagent);
  $hint.querySelector("[data-achat-term]").addEventListener("click", () => {
    if (cliPanel.isAvailable()) $root.querySelector("[data-achat-cli]").click();
    else setMode(view?.paneId, false);
  });
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

  provide("agentchat.navigate", navigate);
  provide("agentchat.ownsInput", () => !!view);
  provide("agentchat.selectedTab", () => selectedPane && currentAgent()?.tabId);
  provide("agentchat.providers", () => ui.providers);
  provide("agentchat.sync", () => sync());
  provide("agentchat.focusInput", () => focusInput());
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
      "agentchat.cli": message => cliPanel.receive(message),
      "agentchat.cli-available": message => { if (view?.key === message.key) { cliPanel.available(message.available); syncHint(); postState(); } },
      "agentchat.managed": onManaged,
      "agentchat.managed-relay": onManagedRelay,
      "agentchat.seen-error": (m) => {
        if (view?.key === m.key && view.session === m.session) view.seen = false;
      },
      "agentchat.older": onOlder,
      "agentchat.ui": onUi,
      "agentchat.sent": onSent,
      "agentchat.commands": onToolReply,
      "agentchat.files": onToolReply,
      "agentchat.meta": onMeta,
      "agentchat.tasks": onTasks,
      "agentchat.taskread": onToolReply,
      "agentchat.permission": onToolReply,
      "agentchat.setting": onToolReply,
      "agentchat.terminal": onTerminalResult,
      "agentchat.fork-opened": onForkOpened,
      "agentchat.a2ui": onA2ui,
      // 권한 답·모드 변경 결과. iframe 요청 이름(iris-chat.answer·mode)으로 돌려줌
      "agentchat.answered": (m) => onToolReply({ ...m, type: "agentchat.answer" }),
      "agentchat.moded": (m) => onToolReply({ ...m, type: "agentchat.mode" }),
      // 서버는 연결이 끊기면 구독을 모두 버린다. 다시 붙었으면 보던 것을 다시 연다.
      "agentchat.hello": () => {
        cliPanel.reset();
        if (terminalHandoff) onTerminalResult({ ...terminalHandoff, ok: false, reason: "터미널 전환 결과를 받기 전에 연결이 끊겼습니다" });
        if (!view) return;
        subscribe();
        if (view.managed) onManagedRelay({ key: view.key, event: "reset" });
      },
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
  if (list.length >= CONTEXT_MAX) { ctx.showToast(`입력창에는 ${CONTEXT_MAX}개까지 첨부할 수 있습니다`, { level: "warn" }); return; }
  const no = Math.max(0, ...list.map((c) => (Number.isInteger(c.no) ? c.no : 0))) + 1;
  contexts.set(view.key, [...list, { id: crypto.randomUUID(), content, no, ...(kind ? { kind } : {}) }]);
  saveContexts();
  postState();
}
// 화면이 아직 안 떴으면 iris-chat.ready 때 보냄
let focusWanted = false;
function focusFrame() {
  if (cliPanel?.focus()) return;
  focusWanted = !frameReady && !!view;
  if (frameReady && view) $frame.contentWindow?.postMessage({ type: "iris-chat.focus", key: view.key }, location.origin);
}
// 세션을 옮긴 뒤 키 입력 받을 곳. 대화 화면이 보이면 그 입력창에 포커스하고 true, 아니면 false(앱 셸이 터미널에)
function focusInput() {
  if (!view || $root.hidden) return false;
  focusFrame();
  return true;
}
// 칩 미리보기에서 고친 내용. 번호·종류는 그대로
function editContext(owner, id, content) {
  const list = contexts.get(owner);
  if (!list || !list.some((c) => c.id === id)) return;
  contexts.set(owner, list.map((c) => (c.id === id ? { ...c, content } : c)));
  saveContexts();
}
function removeContexts(owner, ids) {
  const list = contexts.get(owner);
  if (!list) return;
  const next = ids ? list.filter((c) => !ids.includes(c.id)) : [];
  if (next.length) contexts.set(owner, next); else contexts.delete(owner);
  saveContexts();
}

function isChat(a) {
  if (terminalOwnsSession(a)) return isReturningHandoff(a);
  if (needsTerminalHandoff(a)) return true;
  if (a.embeddedProvider && !a.sharedCodex) return modes.get(a.paneId) !== "term";
  return chatFor(modes.get(a.paneId), defaultView(), a.parentPaneId);
}

function isReturningHandoff(a) {
  return !!returningHandoff && a?.paneId === returningHandoff.paneId && sessionOf(a) === returningHandoff.session;
}

function terminalOwnsSession(a) {
  if (!a?.embeddedProvider || a.sharedCodex) return false;
  if (isReturningHandoff(a) && returningHandoff.ready) return false;
  return !!a.embeddedTerminalPhase || completedHandoffs.get(a.paneId) === sessionOf(a);
}

function needsTerminalHandoff(a) {
  return !!a?.embeddedNative && !!a.embeddedProvider && !a.sharedCodex && !terminalOwnsSession(a);
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
  const a = currentAgent();
  if (selectedPane && a && !isChat(a) && !a.focused) {
    terminalWanted = selectedPane;
    ctx.wsSend({ type: "focus", target: selectedPane, origin: "chat-terminal" });
  }
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
let forkSeq = 0;
let forkAttach = null;    // { key, sourceKey, attachment } 대화 화면에 아직 넘기지 않은 첨부
function startFork(attachment) {
  const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId);
  if (!a?.workspaceId || !view.kind) { ctx.showToast("분기하지 못했습니다: 이 대화의 herdr 워크스페이스를 찾지 못했습니다", { level: "warn" }); return; }
  if (pendingFork?.id) return;
  const id = view.embedded ? `fork-${Date.now().toString(36)}-${++forkSeq}` : null;
  pendingFork = { id, attachment, sourceKey: view.key, workspaceId: a.workspaceId, provider: view.kind,
    known: new Set((ctx.getLastAgents() || []).map((x) => x.paneId)), at: Date.now() };
  if (id) pendingFork.timer = setTimeout(() => onForkOpened({ id, ok: false, reason: "새 대화 탭을 찾지 못했습니다" }), FORK_WAIT_MS);
  const sent = ctx.wsSend({ type: "tab.create", workspaceId: a.workspaceId, ...(a.cwd ? { cwd: a.cwd } : {}), launch: view.kind,
    ...(id ? { forkId: id } : {}) });
  if (sent === false && id) onForkOpened({ id, ok: false, reason: "Iris 서버에 연결되지 않았습니다" });
}
function onForkOpened(message) {
  if (!pendingFork?.id || pendingFork.id !== message.id) return;
  if (message.ok !== true || !message.paneId) {
    clearTimeout(pendingFork.timer);
    pendingFork = null;
    ctx.showToast?.(message.reason || "대화를 분기하지 못했습니다", { level: "warn" });
    return;
  }
  pendingFork.target = message.paneId;
  sync();
}
function claimForkPane(a, kind) {
  if (!pendingFork || !a || kind !== pendingFork.provider || a.workspaceId !== pendingFork.workspaceId || pendingFork.known.has(a.paneId)) return;
  if (pendingFork.id && pendingFork.target !== a.paneId) return;
  const f = pendingFork;
  pendingFork = null;
  clearTimeout(f.timer);
  if (Date.now() - f.at > FORK_WAIT_MS) return;
  if (!isChat(a)) { modes.set(a.paneId, "chat"); saveModes(); }
  forkAttach = { paneId: a.paneId, sourceKey: f.sourceKey, attachment: f.attachment };
}

function navigate(message) {
  const agents = ctx.getLastAgents() || [];
  if (message.type === "tab-focus" && ["key-tab", "tabstrip"].includes(message.origin)) {
    const matches = agents.filter((a) => a.tabId === message.tabId);
    const tab = ctx.getTabsForSpace?.(matches[0]?.workspaceId)?.find((t) => t.tabId === message.tabId);
    if (matches.length === 1 && !(tab?.paneCount > 1) && agentKind(matches[0]) && isChat(matches[0])) {
      ctx.selectSession(matches[0].paneId, false, message.origin);
      return true;
    }
  }
  if (message.type === "focus" && message.origin === "chat-terminal") return false;
  terminalWanted = null;
  const a = message.type === "focus" && agents.find((item) => item.paneId === message.target);
  selectedPane = a && agentKind(a) && isChat(a) ? a.paneId : null;
  return !!selectedPane;
}

function setMode(paneId, chat) {
  if (!paneId) return;
  const agent = currentAgent();
  if (agent?.paneId === paneId && !chat && needsTerminalHandoff(agent)) {
    if (view?.paneId !== paneId || terminalHandoff) return;
    const key = view.key;
    const id = `terminal-${Date.now().toString(36)}-${++terminalRequestSeq}`;
    terminalHandoff = { key, id, paneId, session: sessionOf(agent) };
    if (ctx.wsSend({ type: "agentchat.terminal", key, id }) === false) {
      onTerminalResult({ key, id, ok: false, reason: "Iris 서버에 연결되지 않았습니다" });
    } else sync();
    return;
  }
  if (agent?.paneId === paneId && terminalOwnsSession(agent)) {
    returningHandoff = chat ? { paneId, session: sessionOf(agent), ready: false } : null;
  }
  applyMode(paneId, chat);
}

function onTerminalResult(message) {
  if (!terminalHandoff || message.key !== terminalHandoff.key || message.id !== terminalHandoff.id) return;
  const { paneId, session } = terminalHandoff;
  terminalHandoff = null;
  if (message.ok !== true) {
    ctx.showToast?.(message.reason || "터미널을 열지 못했습니다", { level: "warn" });
    sync();
    return;
  }
  if (returningHandoff?.paneId === paneId) returningHandoff = null;
  completedHandoffs.set(paneId, session);
  const agent = currentAgent();
  if (agent?.paneId === paneId) applyMode(paneId, false);
  else { modes.set(paneId, "term"); saveModes(); sync(); }
}

function applyMode(paneId, chat) {
  if (!chat && selectedPane === paneId && !currentAgent()?.focused) {
    terminalWanted = paneId;
    ctx.wsSend({ type: "focus", target: paneId, origin: "chat-terminal" });
    return;
  }
  terminalWanted = null;
  selectedPane = chat ? paneId : null;
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
  if (terminalHandoff && terminalHandoff.paneId === a?.paneId && terminalHandoff.key === view?.key) {
    $toggle.disabled = true;
    return;
  }
  if (returningHandoff && (!isReturningHandoff(a) || (returningHandoff.ready && !a.embeddedTerminalPhase))) returningHandoff = null;
  for (const [paneId, session] of completedHandoffs) {
    const agent = (ctx.getLastAgents() || []).find((item) => item.paneId === paneId);
    if (!agent?.embeddedProvider || sessionOf(agent) !== session) completedHandoffs.delete(paneId);
  }
  const kind = agentKind(a);
  if (selectedPane !== a?.paneId) { selectedPane = null; terminalWanted = null; }
  if (terminalWanted && a?.paneId === terminalWanted && a.focused) {
    applyMode(terminalWanted, false);
    return;
  }
  claimForkPane(a, kind);
  $toggle.hidden = !kind;
  $toggle.disabled = !!terminalHandoff;
  const chat = !!kind && (isChat(a) || terminalWanted === a.paneId);
  if (!chat) selectedPane = null;
  $toggle.classList.toggle("on", chat);
  $toggle.setAttribute("aria-pressed", String(chat));
  setHtml($toggle, chat ? ICON_TERM : ICON_CHAT);
  $toggle.title = chat ? shortcutLabel("터미널로 보기 (⌘⇧J)") : shortcutLabel("채팅으로 보기 (⌘⇧J)");
  $toggle.setAttribute("aria-label", $toggle.title);

  // 서브에이전트 보기는 부모 pane 에 딸려 있다. 다른 pane 을 고르면 닫는다.
  if (view?.agentId && view.paneId !== a?.paneId) closeView();
  if (view?.agentId) { updateStatus(a); return; }

  if (chat) {
    // 같은 pane 에서 다른 세션이 시작되면 새 대화로 엶. 초안·칩이 이전 세션 것과 섞이지 않게
    if (!view || view.paneId !== a.paneId || view.session !== sessionOf(a) || view.kind !== kind) startView({ paneId: a.paneId, agentId: null, kind, session: sessionOf(a), expectManaged: !!a.managedProvider, expectEmbedded: !!a.embeddedProvider });
    updateStatus(a);
  } else if (view) closeView();
}

function frameCacheBuild(view, source) {
  return view?.managed?.build || ui.build || source || ui.url || "";
}

function frameCacheId(key, build) {
  return `${key}\u0000${build}`;
}

function frameOffset(frame) {
  try {
    const scroll = frame.contentDocument?.querySelector('[data-testid="agent-chat-scroll"]');
    if (scroll) return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1 ? scroll.scrollTop : null;
    const win = frame.contentWindow;
    const top = Number(win?.scrollY ?? frame.contentDocument?.scrollingElement?.scrollTop);
    return Number.isFinite(top) && top > 0 ? top : null;
  } catch { return null; }
}

function restoreFrameOffset(frame, offset) {
  if (offset == null) return;
  try {
    const scroll = frame.contentDocument?.querySelector('[data-testid="agent-chat-scroll"]');
    if (scroll) scroll.scrollTop = offset;
    else frame.contentWindow?.scrollTo(0, offset);
  } catch {}
}

function snapshotFrameView(source) {
  const messages = Array.isArray(source.messages) ? source.messages.slice() : [];
  const embedded = source.embedded && typeof source.embedded === "object" ? { ...source.embedded } : source.embedded;
  if (embedded) {
    for (const field of ["timeline", "timelineRows", "permissions", "controls", "options", "features", "availableModes", "models"]) {
      if (Array.isArray(embedded[field])) embedded[field] = embedded[field].slice();
    }
  }
  const snapshot = { ...source, messages, embedded,
    agent: source.agent ? { ...source.agent } : source.agent,
    prompt: source.prompt ? { ...source.prompt } : source.prompt,
    draft: source.draft ? { ...source.draft } : source.draft,
    tasks: Array.isArray(source.tasks) ? source.tasks.map((task) => ({ ...task })) : [] };
  if (source.sentMessages === source.messages) snapshot.sentMessages = messages;
  if (source.sentEmbedded === source.embedded) snapshot.sentEmbedded = embedded;
  return snapshot;
}

function enforceFrameCacheBounds(hiddenFrameLimit) {
  while (frameCache.size > FRAME_CACHE_MAX) {
    const [id, entry] = frameCache.entries().next().value;
    frameCache.delete(id);
    entry.frame?.remove();
  }
  const withFrames = () => [...frameCache.values()].filter((entry) => entry.frame);
  while (withFrames().length > hiddenFrameLimit) {
    const entry = withFrames()[0];
    entry.frame.remove();
    entry.frame = null;
  }
}

function frameIsCached(frame) {
  return [...frameCache.values()].some((entry) => entry.frame === frame);
}

function cacheCurrentFrame() {
  if (!view || (!view.session && !view.agentId) || !$frame || !frameReady || !view.loaded || !$frame.getAttribute("src")) return;
  const source = $frame.getAttribute("src");
  const build = frameBuild || frameCacheBuild(view, source);
  const id = frameCacheId(view.key, build);
  const old = frameCache.get(id);
  if (old?.frame && old.frame !== $frame) old.frame.remove();
  frameCache.delete(id);
  frameCache.set(id, { id, key: view.key, build, source,
    frame: $frame, view: snapshotFrameView(view), reuse: frameReusesMessages, ready: frameReady, offset: frameOffset($frame) });
  clearTimeout(frameWatch?.timer);
  frameWatch = null;
  $frame.classList.add("achat-previous");
  $frame.hidden = true;
}

function takeCachedFrame(key, spec) {
  const build = spec.build || ui.build || ui.url || "";
  const id = frameCacheId(key, build);
  const entry = frameCache.get(id);
  if (!entry) return null;
  frameCache.delete(id);
  if (entry.view.kind !== spec.kind) { entry.frame?.remove(); return null; }
  if (entry.frame && !entry.frame.isConnected) entry.frame = null;
  return entry;
}

function startView(spec) {
  clearTimeout(releaseTimer);
  const key = spec.agentId ? `sub:${spec.paneId}:${spec.agentId}` : `pane:${spec.paneId}:${spec.session || ""}`;
  const cached = takeCachedFrame(key, spec);
  if (view) {
    unsubscribe();
    cacheCurrentFrame();
  }
  enforceFrameCacheBounds(MAX_CHAT_FRAMES - 1);
  clearTimeout(frameWatch?.timer);
  frameWatch = null;
  if (cached?.frame) {
    if ($frame && $frame !== cached.frame && !frameIsCached($frame)) $frame.remove();
    $frame = cached.frame;
    $frame.classList.remove("achat-previous");
    $frame.hidden = false;
    frameReady = cached.ready;
    frameReusesMessages = cached.reuse;
    frameBuild = cached.build;
  } else {
    if ($frame?.getAttribute("src") && !frameIsCached($frame)) $frame.remove();
    if (!$frame?.isConnected || $frame.getAttribute("src")) {
      $frame = document.createElement("iframe");
      $frame.className = "achat-frame";
      $frame.title = "에이전트 대화";
      $frame.addEventListener("load", bindFrameKeys);
      $list.prepend($frame);
    }
    frameReady = false;
    frameReusesMessages = false;
    frameBuild = null;
  }
  // 키는 대화(pane+세션)마다 고정. Paseo 는 이 키(에이전트 id)로 입력창 초안을 저장하므로 바뀌면 다시 열 때 초안이 사라짐
  view = { key,
    session: spec.session || "",
    expectManaged: !!spec.expectManaged,
    expectEmbedded: !!spec.expectEmbedded,
    paneId: spec.paneId, agentId: spec.agentId || null, kind: spec.kind, messages: [], hasOlder: false,
    loadingOlder: false, reason: "", loaded: false, parentLabel: spec.parentLabel || "",
    description: spec.description || "", agentType: spec.agentType || "", tasks: [] };
  if (cached) Object.assign(view, cached.view, { key, session: spec.session || "", paneId: spec.paneId,
    agentId: spec.agentId || null, kind: spec.kind || cached.view.kind,
    expectManaged: !!spec.expectManaged, expectEmbedded: !!spec.expectEmbedded, loaded: true, cached: true,
    restoreOffset: cached.offset });
  if (cached && !cached.frame) {
    frameReusesMessages = false;
    view.sentMessages = null;
    view.sentEmbedded = null;
  }
  $root.hidden = false;
  $root.classList.toggle("sub", !!view.agentId);
  $head.hidden = !view.agentId;
  clearA2uiTab();
  if (view.agentId) {
    $head.querySelector(".achat-head-parent").textContent = view.parentLabel || "에이전트";
    $head.querySelector(".achat-head-desc").textContent = view.description || view.agentType || "서브에이전트";
    $head.querySelector(".achat-head-mk").textContent = view.agentType || "agent";
  }
  render();
  if (cached?.offset != null && cached.frame) restoreFrameOffset($frame, cached.offset);
  subscribe();
}

function closeView() {
  unsubscribe();
  cacheCurrentFrame();
  enforceFrameCacheBounds(MAX_CHAT_FRAMES);
  view = null;
  clearA2uiTab();
  $root.hidden = true;
  $hint.hidden = true;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseFrame, FRAME_RELEASE_MS);
}

function releaseFrame() {
  if (view) return;
  for (const entry of frameCache.values()) {
    entry.frame?.remove();
    entry.frame = null;
    entry.ready = false;
    entry.reuse = false;
  }
  if (!$frame?.getAttribute("src")) return;
  clearTimeout(frameWatch?.timer);
  frameWatch = null;
  frameReady = false;
  $frame.remove();
  $frame = null;
  frameBuild = null;
}

function subscribe() {
  if (!view) return;
  cliPanel.reset();
  ctx.wsSend({ type: "agentchat.open", key: view.key, paneId: view.paneId, ...(view.session ? { session: view.session } : {}), ...(view.agentId ? { agentId: view.agentId } : {}) });
}

function unsubscribe() {
  cliPanel.reset();
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
  postState({ agentUpdate: true });
  acknowledgeSeen();
}

function acknowledgeSeen() {
  if (!view || view.agentId || !view.session) return;
  const agent = currentAgent();
  if (agent?.paneId !== view.paneId || sessionOf(agent) !== view.session) return;
  if (agent.status !== "done") { view.seen = false; return; }
  if (view.seen || !frameReady || !view.loaded || (view.managed && !view.healthy)
    || $frame.hidden || $root.hidden || document.visibilityState !== "visible" || !document.hasFocus()) return;
  view.seen = ctx.wsSend({ type: "agentchat.seen", key: view.key, session: view.session }) !== false;
}

function onFrame(m) {
  if (!view || m.key !== view.key) return;
  const returning = isReturningHandoff(currentAgent()) && !returningHandoff.ready && returningHandoff.paneId === view.paneId;
  if (m.kind === "missing" || m.kind === "error") {
    if (returning) {
      const { paneId } = returningHandoff;
      returningHandoff = null;
      ctx.showToast?.(m.reason || "대화로 돌아가지 못했습니다", { level: "warn" });
      applyMode(paneId, false);
      return;
    }
    if (!view.loaded || view.cached) { view.loaded = false; view.reason = m.reason || "대화 기록을 찾지 못했습니다"; render(); }
    return;
  }
  if (m.embedded === true) {
    if (m.sessionUuid !== view.session) return;
    if (returning) {
      returningHandoff.ready = true;
      completedHandoffs.delete(view.paneId);
    }
    view.embedded = { provider: m.provider, status: m.status, activeTurn: m.activeTurn,
      controls: m.controls, options: m.options, features: m.features, availableModes: m.availableModes, modeId: m.modeId, model: m.model,
      models: m.models, lastUsage: m.lastUsage, thinkingOptionId: m.thinkingOptionId,
      ...(Array.isArray(m.timelineRows) ? { timelineRows: m.timelineRows } : { timeline: m.timeline }), permissions: m.permissions };
    view.kind = m.provider;
    syncHint();
  } else if (m.kind === "snapshot" || m.kind === "replacement") {
    view.messages = Array.isArray(m.messages) ? m.messages : [];
    view.hasOlder = !!m.hasOlder;
    view.file = typeof m.file === "string" ? m.file : null;
    view.gen = typeof m.gen === "string" ? m.gen : null;
    view.appended = 0;
  } else if (m.kind === "append") {
    const added = Array.isArray(m.messages) ? m.messages : [];
    view.messages = view.messages.concat(added);
    view.appended = (view.appended || 0) + added.length;
    if (needsResnapshot(view)) {
      // 다시 구독하면 서버가 최근 창(LIMITS.initial)만 다시 보냄. 이전 기록 위치도 그 창 기준으로 맞춰짐
      view.appended = 0;
      unsubscribe();
      subscribe();
    }
  }
  view.cached = false;
  view.loaded = true;
  view.reason = "";
  render();
}

function onManaged(m) {
  if (!view || m.key !== view.key) return;
  view.managed = { build: m.build, agentId: m.agentId, serverId: m.serverId, workspaceId: m.workspaceId };
  view.loaded = true;
  view.reason = "";
  render();
}

function onManagedRelay(m) {
  if (!view?.managed || m.key !== view.key) return;
  $frame.contentWindow?.postMessage({ ...m, type: "iris-chat.managed-relay" }, location.origin);
}

// 서버가 기록·화면에서 읽은 지금 모델·effort·모드·사용량과 답을 기다리는 질문
// 답 기다림 안내: Paseo 권한 카드가 그 질문을 보이면 숨김. 화면에서 질문을 못 읽었으면 터미널로 안내
function syncHint() {
  $hint.hidden = !view?.blocked || !!view.prompt || !!view.managed || !!view.embedded;
  if (!$hint.hidden) {
    $hint.querySelector("span").textContent = cliPanel.isAvailable() ? "에이전트가 답을 기다립니다." : "에이전트가 답을 기다립니다. 선택지는 터미널에서 고릅니다.";
    $hint.querySelector("button").textContent = cliPanel.isAvailable() ? "CLI에서 답하기" : "터미널에서 답하기";
  }
}

function onMeta(m) {
  if (!view || m.key !== view.key || view.agentId) return;
  view.agent = m.agent && typeof m.agent === "object" ? m.agent : null;
  view.prompt = m.prompt && typeof m.prompt === "object" ? m.prompt : null;
  // 터미널 입력줄 글. 대화 화면 입력창이 같은 글을 보임(server/agent-chat-draft.js)
  view.draft = m.draft && typeof m.draft.text === "string" ? { text: m.draft.text } : null;
  view.codexModels = Array.isArray(m.codexModels) ? m.codexModels : null;
  if (view.codexModels) codexModelsSeen = view.codexModels;
  view.agyModels = Array.isArray(m.agyModels) ? m.agyModels : null;
  if (view.agyModels) agyModelsSeen = view.agyModels;
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

function openA2uiTab() {
  const space = a2uiTab?.space || getCenterSpace() || ctx.getSelectedSpaceId();
  if (!space || !view?.hasA2ui) return;
  const id = `a2ui:${view.key}`;
  if (!getTabs(space).some(tab => tab.id === id)) {
    a2uiTab = addTab(space, { id, kind: "a2ui", label: "A2UI", space });
  }
  setCenterSpace(space);
  setActiveTab(space, id);
  ctx.renderTabs();
  ctx.showActiveTab();
}

function clearA2uiTab() {
  if (view) view.hasA2ui = false;
  a2uiHost.clear();
  if (a2uiTab && removeTab(a2uiTab.space, a2uiTab) && a2uiTab.space === getCenterSpace()) {
    ctx.renderTabs();
    ctx.showActiveTab();
  }
  a2uiTab = null;
  postState();
}

function onA2ui(m) {
  if (!view || m.key !== view.key || view.agentId) return;
  if (!Array.isArray(m.surfaces) || !m.surfaces.length) { clearA2uiTab(); return; }
  a2uiHost.setSurfaces(m.surfaces);
  view.hasA2ui = true;
  postState();
  if (!a2uiTab) openA2uiTab();
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
    build: typeof m.build === "string" ? m.build : null, message: String(m.message || ""),
    providers: Array.isArray(m.providers) ? m.providers : ui.providers,
    chatProviderAliases: m.chatProviderAliases ?? {},
    chatProviders: Array.isArray(m.chatProviders) ? m.chatProviders : m.providers?.map(({ id }) => id) ?? ui.chatProviders };
  sync();
  render();
}

// 새로 띄운 빌드가 대화를 그렸다는 신호(iris-chat.healthy)를 30초 안에 주지 않거나 그 사이 오류를 내면
// 서버에 알림. 서버가 이전 빌드로 되돌림
// - 대화 기록이 아직 없거나(로딩·기록 없음) 화면이 가려져 있으면 빌드 탓이 아니라서 기다림
function watchFrame() {
  clearTimeout(frameWatch?.timer);
  frameWatch = { build: view?.managed?.build || ui.build, at: Date.now(), timer: null };
  armWatch();
}
function armWatch() {
  if (!frameWatch) return;
  frameWatch.timer = setTimeout(() => {
    if (view?.loaded && !$frame.hidden && !$root.hidden) brokenFrame("대화 표시 실패(30초)");
    else { frameWatch.at = Date.now(); armWatch(); }
  }, FRAME_READY_MS);
}
function brokenFrame(reason) {
  if (!frameWatch?.build || !view) return;
  const { build } = frameWatch;
  clearTimeout(frameWatch.timer);
  frameWatch = null;
  if (view.managed) {
    showEmpty("대화 화면을 열 수 없습니다", reason, true);
    $loading.hidden = true;
    return;
  }
  ctx.wsSend({ type: "agentchat.ui-broken", key: view.key, build, reason });
}

// iframe 진입 파일이 보내는 것: 준비됨, 오류, 이전 대화 요청
// 대화 화면 링크 우클릭 → 앱 우클릭 메뉴. 좌표는 iframe 안 좌표라 iframe 위치를 더함
function showLinkMenu(m) {
  const text = typeof m.text === "string" ? m.text : "";
  if (!text || !$frame) return;
  const r = $frame.getBoundingClientRect();
  const what = m.kind === "url" ? "주소" : "경로";
  showCtx(r.left + Number(m.x || 0), r.top + Number(m.y || 0), [{
    label: `${what} 복사`,
    act: () => Promise.resolve(ctx.copyText ? ctx.copyText(text) : navigator.clipboard.writeText(text).then(() => true))
      .catch(() => false)
      .then((ok) => ctx.showToast(ok ? `${what}를 복사했습니다` : `${what}를 복사하지 못했습니다`, { level: ok ? "ok" : "err" })),
  }]);
}

function onFrameMessage(e) {
  if (e.origin !== location.origin || e.source !== $frame?.contentWindow) return;
  if (e.data?.type === "iris-chat.ready") {
    frameReusesMessages = e.data.reuseMessages === true;
    if (view) { view.sentMessages = null; view.sentEmbedded = null; }
    frameReady = true;
    // 요소 선택 중에 대화 화면이 새로 떴으면 새 문서에 다시 연결
    if (chatPicking) setChatPickMode(true);
    syncLoading();
    postState();
    if (view?.restoreOffset != null) {
      const offset = view.restoreOffset;
      view.restoreOffset = null;
      restoreFrameOffset($frame, offset);
    }
    if (focusWanted) focusFrame();
  } else if (e.data?.type === "iris-chat.healthy") {
    clearTimeout(frameWatch?.timer);
    frameWatch = null;
    if (view?.managed) { view.healthy = true; syncLoading(); }
  } else if (e.data?.type === "iris-chat.managed-relay") {
    if (view?.managed && e.data.key === view.key) {
      if (ctx.wsSend({ ...e.data, type: "agentchat.managed-relay" }) === false) {
        onManagedRelay({ key: view.key, socketId: e.data.socketId, event: "close", code: 1006 });
      }
    }
  } else if (e.data?.type === "iris-chat.a2ui-action-error" && e.data?.key === view?.key) {
    ctx.showToast(`보내지 못했습니다: ${e.data.reason || "알 수 없는 오류"}`, { level: "warn" });
  } else if (isInputRequest(e.data?.type)) {
    relayInput(e.data);
  } else if (e.data?.type === "iris-chat.open-cli" && view && e.data.key === view.key && cliPanel.isAvailable()) {
    if (!cliPanel.focus()) $root.querySelector("[data-achat-cli]").click();
  } else if (e.data?.type === "iris-chat.open-a2ui" && view && e.data.key === view.key) {
    openA2uiTab();
  } else if (e.data?.type === "iris-chat.open-subagent" && view && !view.agentId && e.data.key === view.key) {
    const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId);
    const sub = subagentsOf(a).find((s) => s.id === e.data.agentId);
    if (sub) openSubagent({ paneId: view.paneId, agentId: sub.id, parentLabel: a?.tabLabel || (a?.cwd ? String(a.cwd).split("/").pop() : a?.agent) || "", description: sub.description, agentType: sub.agentType });
  } else if (e.data?.type === "iris-chat.fork" && view && !view.agentId && !view.managed && e.data.key === view.key) {
    if (e.data.attachment && typeof e.data.attachment.text === "string") startFork(e.data.attachment);
  } else if (e.data?.type === "iris-chat.link-menu" && view && e.data.key === view.key) {
    showLinkMenu(e.data);
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
  } else if (e.data?.type === "iris-chat.context-edit" && view && e.data.key === view.key) {
    if (typeof e.data.id === "string" && typeof e.data.content === "string" && e.data.content.trim()) {
      editContext(view.key, e.data.id, e.data.content);
      postState();
    }
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
const INPUT_TYPES = new Set(["iris-chat.send", "iris-chat.cancel", "iris-chat.commands", "iris-chat.files", "iris-chat.answer", "iris-chat.permission", "iris-chat.mode", "iris-chat.setting", "iris-chat.taskread"]);
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
    else if (d.type !== "iris-chat.cancel") $frame.contentWindow?.postMessage({ type: d.type, id, ok: false, reason, error: reason }, location.origin);
    return;
  }
  if (d.type === "iris-chat.send") {
    if (typeof d.text !== "string") return;
    // 같이 보낸 칩. 보내기에 성공해야 뺌(실패하면 칩이 남아 다시 보낼 수 있게)
    const ids = Array.isArray(d.contextIds) ? d.contextIds.filter((x) => typeof x === "string") : [];
    if (ids.length) pendingContexts.set(id, { owner: view.key, ids });
    ctx.wsSend({ type: "agentchat.send", key: view.key, text: d.text, id });
  } else if (d.type === "iris-chat.cancel") ctx.wsSend({ type: "agentchat.cancel", key: view.key });
  else if (d.type === "iris-chat.permission") {
    const sent = view.embedded && d.key === view.key && typeof d.requestId === "string" && d.requestId
      && d.response && typeof d.response === "object" && !Array.isArray(d.response)
      && ctx.wsSend({ type: "agentchat.permission", key: view.key, id, requestId: d.requestId, response: d.response }) !== false;
    if (!sent) $frame.contentWindow?.postMessage({ type: d.type, id, ok: false, reason: "답을 보내지 못했습니다" }, location.origin);
  }
  else if (d.type === "iris-chat.setting") {
    const { setting, value } = d;
    const validValue = setting === "config"
      ? value !== null && typeof value === "object" && !Array.isArray(value)
      : ["mode", "model", "thinking"].includes(setting) && (typeof value === "string" && value.length > 0 || value === null && setting !== "mode");
    const sent = view.embedded && d.key === view.key && validValue
      && ctx.wsSend({ type: "agentchat.setting", key: view.key, id, setting, value }) !== false;
    if (!sent) $frame.contentWindow?.postMessage({ type: d.type, id, ok: false, reason: "설정 변경을 요청하지 못했습니다" }, location.origin);
  }
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
// - frameReady 는 여기서 되돌리지 않음. iris-chat.ready 가 load 보다 먼저 오는 경우가 있어 되돌리면 로딩 표시가 남음
// - 되돌림은 주소를 바꿀 때(render·releaseFrame)
function bindFrameKeys() {
  try { $frame.contentWindow?.addEventListener("keydown", forwardFrameKey, true); } catch {}
}

function postState({ agentUpdate = false } = {}) {
  if (!$frame || !frameReady || !view) return;
  const a = (ctx.getLastAgents() || []).find((x) => x.paneId === view.paneId) || null;
  const state = {
    key: view.key, paneId: view.paneId, agentId: view.agentId, kind: view.kind, cwd: a?.cwd || "",
    file: view.file || null, gen: view.gen || null,
    hasOlder: view.hasOlder, loadingOlder: view.loadingOlder,
    running: view.embedded ? view.embedded.status === "running" : !view.agentId && a?.status === "working",
    // 서브에이전트 보기도 입력창을 씀. 보낸 글은 서버가 부모 pane 에 전달 부탁으로 넣음
    readOnly: false,
    cliAvailable: cliPanel.isAvailable(),
    hasA2ui: !!view.hasA2ui,
    contexts: view.agentId ? [] : (contexts.get(view.key) || []),
    agent: view.agentId ? null : (view.agent || null),
    prompt: view.agentId ? null : (view.prompt || null),
    draft: view.agentId ? null : (view.draft || null),
    codexModels: view.codexModels || codexModelsSeen,
    agyModels: view.agyModels || agyModelsSeen,
    // 지금 돌고 있는 Claude 서브에이전트. Paseo 입력창 위 버튼으로 열면 iris-chat.open-subagent 로 돌아옴
    subagents: view.agentId ? [] : subagentsOf(a),
    // 백그라운드 셸·Monitor(server/agent-chat-tasks.js). 입력창 위 버튼과 도구 카드 출력
    tasks: view.tasks,
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  };
  const agentFields = JSON.stringify([state.cwd, state.running, state.subagents]);
  if (agentUpdate && agentFields === view.sentAgentFields && !forkAttach) return;
  // 새 기록과 이전 기록 조회는 모두 새 배열을 만듦. 구버전 프레임에는 항상 전체 기록 전송
  if (!frameReusesMessages || view.sentMessages !== view.messages) state.messages = view.messages;
  if (view.embedded && (!frameReusesMessages || view.sentEmbedded !== view.embedded)) state.embedded = view.embedded;
  $frame.contentWindow.postMessage({ type: "iris-chat.state", state }, location.origin);
  view.sentAgentFields = agentFields;
  view.sentMessages = view.messages;
  view.sentEmbedded = view.embedded;
  if (forkAttach && forkAttach.paneId === view.paneId && !view.agentId && view.loaded && !$frame.hidden) {
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
  if (!view.managed && (ui.phase !== "ready" || !ui.url)) {
    const building = ui.phase === "building" || ui.phase === "none";
    showEmpty(building ? "대화 화면을 준비하는 중" : "대화 화면을 열 수 없습니다",
      ui.message || (building ? "Paseo 대화 화면을 처음 받아 빌드합니다" : ""), canTerm);
    $loading.hidden = true;
    return;
  }
  if (view.reason && !view.loaded) { showEmpty("대화 기록을 표시할 수 없습니다", view.reason, canTerm); $loading.hidden = true; return; }
  if ((view.expectManaged || view.expectEmbedded) && !view.managed && !view.embedded) {
    showEmpty("대화를 연결하는 중", "", canTerm);
    $loading.hidden = true;
    return;
  }
  $empty.hidden = true;
  $frame.hidden = false;
  const url = view.managed ? managedFrameUrl(view) : ui.url;
  const build = view.managed?.build || ui.build || url;
  if ($frame.getAttribute("src") !== url || frameBuild !== build) {
    frameReady = false;
    frameBuild = build;
    $frame.setAttribute("src", url);
    watchFrame();
  }
  syncLoading();
  postState();
}

function managedFrameUrl(view) {
  const { build, ...ids } = view.managed;
  return `/paseo-ui/build/${encodeURIComponent(build)}/?${new URLSearchParams({ managed: view.key, ...ids })}`;
}

// 화면이 뜨고 이 대화 기록을 받을 때까지 덮음. pane 을 바꾼 직후 iframe 에 남은 이전 대화도 가림
function syncLoading() {
  $loading.hidden = !view || $frame.hidden || (frameReady && view.loaded && (!view.managed || view.healthy));
  watchLoading();
  acknowledgeSeen();
}

// 덮개가 오래 남으면 안 온 쪽을 다시 받음: 기록이면 다시 구독, iframe 준비 신호면 iframe 을 다시 띄움
// - 그때마다 서버 기록에 남김(agentchat.stall). 몇 번 해도 안 되면 덮개 대신 실패 안내
// - 안내 뒤에도 기록·준비 신호가 오면 render 가 대화를 다시 보임
const LOADING_STALL_MS = 10 * 1000;
const LOADING_RETRIES = 3;
let loadingStall = null;            // { key, tries, timer }
function watchLoading() {
  if ($loading.hidden || !view) { clearTimeout(loadingStall?.timer); loadingStall = null; return; }
  if (loadingStall?.key === view.key) return;
  clearTimeout(loadingStall?.timer);
  loadingStall = { key: view.key, tries: 0, timer: setTimeout(onLoadingStall, LOADING_STALL_MS) };
}
function onLoadingStall() {
  const s = loadingStall;
  if (!s || !view || view.key !== s.key || $loading.hidden) { loadingStall = null; return; }
  const missing = [!frameReady && "frame", !view.loaded && "history"].filter(Boolean);
  ctx.wsSend({ type: "agentchat.stall", key: view.key, build: ui.build || "", missing, tries: s.tries });
  if (s.tries >= LOADING_RETRIES) {
    loadingStall = null;
    showEmpty("대화를 불러오지 못했습니다", missing.includes("frame") ? "대화 화면을 열지 못했습니다" : "대화 기록을 받지 못했습니다", !view.agentId);
    $loading.hidden = true;
    return;
  }
  s.tries++;
  s.timer = setTimeout(onLoadingStall, LOADING_STALL_MS);
  if (!view.loaded) subscribe();
  if (!frameReady) { $frame.removeAttribute("src"); render(); }
}

// 입력창 도구 결과(명령 목록·파일 후보)를 iframe 에 그대로 돌려줌
function frameForKey(key) {
  if (view?.key === key) return $frame;
  for (const entry of [...frameCache.values()].reverse()) {
    if (entry.key === key && entry.frame) return entry.frame;
  }
  return null;
}

function onToolReply(m) {
  const frame = frameForKey(m.key);
  if (!frame) return;
  const { type, key, ...rest } = m;
  frame.contentWindow?.postMessage({ ...rest, type: type.replace("agentchat.", "iris-chat.") }, location.origin);
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
  const frame = frameForKey(m.key);
  if (m.id != null) frame?.contentWindow?.postMessage({ type: "iris-chat.sent", id: m.id, ok: m.ok !== false, reason: m.reason || "" }, location.origin);
  if (m.ok === false && !(shown && m.id != null)) ctx.showToast(`보내지 못했습니다: ${m.reason || "알 수 없는 오류"}`, { level: "warn" });
}

// Herdr 터미널 연결은 사용자가 조작 화면을 연 동안에만 유지
function createCliPanel(root, send, getKey, onError) {
  const button = root.querySelector("[data-achat-cli]");
  const panel = root.querySelector(".achat-cli");
  let active;

  function close(notify = true) {
    if (active) {
      const { term, observer, key, id } = active;
      active = null;
      observer.disconnect();
      term.dispose();
      if (notify) send({ type: "agentchat.cli", action: "close", key, id });
    }
    panel.hidden = true;
    root.classList.remove("achat-cli-open");
    button.setAttribute("aria-expanded", "false");
    button.textContent = "CLI 조작";
  }

  button.addEventListener("click", () => {
    if (active) { close(); button.focus(); return; }
    const key = getKey();
    if (!key || button.hidden) return;
    const id = crypto.randomUUID();
    const emit = (action, data) => send({ type: "agentchat.cli", key, id, action, ...data });
    const term = new window.Terminal({ scrollback: 500, cursorBlink: true });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    root.classList.add("achat-cli-open");
    panel.hidden = false;
    term.open(panel);
    fit.fit();
    const observer = new ResizeObserver(() => { if (active?.id === id) fit.fit(); });
    active = { key, id, term, observer };
    term.onData(data => emit("input", { data }));
    term.onResize(size => emit("resize", size));
    observer.observe(panel);
    button.setAttribute("aria-expanded", "true");
    button.textContent = "대화로 돌아가기";
    if (emit("open", { cols: term.cols, rows: term.rows }) === false) {
      close(false);
      onError("Iris 서버에 연결되지 않았습니다");
      return;
    }
    term.focus();
  });
  return {
    isAvailable() { return !button.hidden; },
    available(value) { button.hidden = !value; if (!value) close(); },
    reset() { close(); button.hidden = true; },
    focus() { if (!active) return false; active.term.focus(); return true; },
    receive(message) {
      if (!active || message.key !== active.key || message.id !== active.id) return;
      if (message.ended) {
        close(false);
        button.focus();
        if (message.reason) onError(message.reason);
      } else if (message.bytes) {
        active.term.write(Uint8Array.from(atob(message.bytes), c => c.charCodeAt(0)));
      }
    },
  };
}
