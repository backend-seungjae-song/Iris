// 분리한 모듈. main 은 연결만 하고 그 안의 상태는 각 모듈이 소유한다.
import {
  initRail, cycleRail, railScreens, setRailScreen, registerPanel, registerScreen, applyRailVisibility,
} from "./devtool/rail.js";
import { featureHidden } from "./core/features.js";
import { CAPABILITIES } from "./core/capabilities.js";
import { callHook, hasHook } from "./core/hooks.js";
import { isFileLikeTabKind } from "./core/tab-views.js";
import { bootCapabilities } from "./core/capability-boot.js";
import { toggleSidebar } from "./panel/layout.js";
import { initLayoutEngine } from "./core/layout-engine.js";
import { initViewport, updateSizeBtn, viewportByTab, viewportLayout } from "./panel/viewport.js";
import {
  initTouchDrag, isSizeDragging, openSizeMenu, startSizeDrag, syncTouchDrag, toggleDevTools,
} from "./panel/touch-drag.js";
import { fitTerminal, getXterm, initTerminal, scheduleCropDetect, setPtyStarted } from "./panel/terminal.js";
import { initHerdrTabs, renderHerdrTabs } from "./panel/herdr-tabs.js";
import { agentMark } from "./core/glyphs.js";
import {
  initXterm, initXtermWiring, sendPtyResize, startPty,
} from "./panel/xterm-wiring.js";
import { initMarkdown, mdToHtml } from "./core/markdown.js";
import { cycleAgent, initKeynav } from "./core/keynav.js";
import { initScreenSwitch } from "./core/screen-switch.js";

import { getWs, getWsGeneration, initWs, wsSend as transportWsSend } from "./core/ws.js";
import { initDock, reconcileBrowserMode, reconcileDocTabs, toggleDock } from "./browser/dock.js";
import { initBrowserTabs, renderBmTabs } from "./browser/tabs.js";
import { initFindInPage } from "./browser/find-in-page.js";
import { bookmarks, initBookmarks, wireUrlBar } from "./browser/bookmarks.js";


import {
  closeProfileMenu, getProfileChromeSource, getProfiles, getSpaceDefaults, initProfiles, openProfileMenu,
  profileById, profileIdForStored, profileOfTab,
} from "./browser/profiles.js";
import { boundSpace, bsMutate, getBrowserState, initBrowserState } from "./browser/state.js";
import {
  markAiRecentUnknown, markAiTargetsUnknown, setAiBusyTabs, setAiRecentUse, setAiTargets, setTabHandles,
} from "./browser/ai-state.js";
import { applyBrowserState, reconcileAiTabs, wakeTabHere } from "./browser/ai-tabs.js";
import {
  autofillBlocked, createWebview, forgetTabWc, goUrl, initWebviewFactory, navigate, navigateOn,
  reportActiveBrowserWc, reportTabWc, spaceOfTabId, updateActiveWebview, updateWebviewMeta,
} from "./browser/webview-factory.js";
import { getWebview, getWebviewEntries, getWebviewIds } from "./browser/webview-store.js";
import {
  activeWv, clearTabDialog, initWebview, newTabId, renderTabDialog, scheduleWebviewThrottling,
  setTabDialog,
} from "./browser/webview.js";
import { initFilePalette, spaceRootFor, handleFilePaletteTree } from "./center/file-palette.js";
import {
  APP_DRAWN_LINK_EXTS, consoleSpace, openBrowser, openDownloadedLocal, openDroppedLocal, openFile, openLocalLink,
} from "./center/file-routing.js";
import { initCenterFileDrop } from "./center/file-drop.js";
import {
  askConfirm, getPendingSpaceFocus, initContextMenu, openFileCtx, setPendingSpaceFocus,
  showCtx,
} from "./explorer/context-menu.js";
import {
  extOf, focusCreatedAfterList, handlePendingRevealFs, getSpaceList, initTree, mergeGitStatus,
  renderFileTree, renderSpaces, requestDir, setPendingCreateFocus,
} from "./explorer/tree.js";
import {
  agentByPane, agentKey, agentsOfSpace, getLastAgents, getSpaces, getTabsForSpace, nameOf,
  replaceHerdrState,
} from "./herdr/state.js";
import { initAgents, renderAgents, revealAgentRow, setChangedInfo } from "./herdr/agents.js";
import { initHerdrSync, markHerdrUserSelect, scheduleHerdrSync } from "./herdr/sync.js";
import { initTabClose, removeTabsNow, closeTabs, retargetFileTabs } from "./center/tab-close.js";
import {
  closedTabsForView, initClosedTabs, queueReopenedBrowserHistory, reopenClosedTab, setClosedBrowserTabs,
} from "./center/closed-tabs.js";
import { getOverrides as getKeymapOverrides, setOverrides as setKeymapOverrides } from "./core/keymap.js";
import { artifactsMessage } from "./devtool/artifacts-page.js";
import { enterKeymapPage, initKeymapPage, renderKeymapPage } from "./devtool/keymap-page.js";
import {
  initTextEditor, ensureMonacoLib, markFileDirty, monacoTheme,
} from "./center/text-editor.js";
import {
  addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, getTabSpaces, setActiveTab,
  setCenterSpace,
} from "./center/tab-store.js";
import {
  applyExternalChange, curTabs, ensureTabViewPanes,
  fileReloadReason, getRenderedFileOwner, getRenderedFileToken, initCenterTabs,
  persistFileTabs, renderTabs, requestReload, restoreFileTabs, retryStuckFileTabs, sendTabIo,
  setLastWatchKey, settleTabIo, showActiveTab, startTabRename, switchCenterSpace,
  syncWatchDirs, tabIoOwner, tabIoRegistry, tabRejectGenerationIo, trackFileWatch, untrackFileWatch,
  withFileViewTransition,
} from "./center/tabs.js";

// [계측] 오류 발생 위치를 스택까지 남긴다. main의 콘솔 필터는 [browser] 접두어만 통과시킨다.
window.addEventListener("error", (e) => {
  try {
    const st = (e.error && e.error.stack || "").split("\n").slice(0, 5).join(" | ");
    console.log("[browser] uncaught:", e.message, "@" + (e.lineno || "?") + ":" + (e.colno || "?"), st);
  } catch (x) {}
});
const $ = (s) => document.querySelector(s);
const esc = (s) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 파일 계열 탭인지 판정한다. 순수 함수이고, init 인자로 즉시 평가되므로 위쪽에 둔다.
const isFileLikeKind = (k) => k === "file" || isFileLikeTabKind(k);
// 이 로거는 core 유틸이므로 다른 core 유틸 옆에 둔다. 함수 본문에서만 불릴 때는 위치가 문제되지 않지만,
// 분리한 모듈이 init 인자로 이 값을 즉시 받으면 TDZ 에 걸린다
// (확인 결과: initHandoff 가 355행에서 blog 를 평가 → Cannot access 'blog' before
// initialization 으로 렌더러가 중단된다. smoke·node --check·pnpm test 는 모두 통과한다).
// 이후 모듈을 분리할 때도 같은 순서를 지킨다.
const blog = (...a) => { try { console.log("[browser]", ...a); } catch {} };
const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
const statusClass = (s) => ["working","idle","blocked","done","unknown"].includes(s) ? s : "idle";
const countSubs = (n) => (n || []).reduce((a, x) => a + 1 + countSubs(x.children), 0);
// Monaco 안에서도 앱 전체의 에이전트·rail 이동 키가 같게 동작하게 하는 공용 연결.
// 메모와 일반 파일 편집기가 함께 쓰고, 실제 이동 명령은 main과 rail이 소유한다.
function bindAgentKeys(ed) {
  try {
    const M = monaco.KeyMod, C = monaco.KeyCode;
    ed.addCommand(M.Alt | C.UpArrow, () => cycleAgent(-1));
    ed.addCommand(M.Alt | C.DownArrow, () => cycleAgent(1));
    // ⌘⌥↑↓ = rail 이동. Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있어 어느 쪽으로 눌러도 같게 건다.
    ed.addCommand(M.CtrlCmd | M.Alt | C.UpArrow, () => cycleRail(-1));
    ed.addCommand(M.CtrlCmd | M.Alt | C.DownArrow, () => cycleRail(1));
    ed.addCommand(M.WinCtrl | M.Alt | C.UpArrow, () => cycleRail(-1));
    ed.addCommand(M.WinCtrl | M.Alt | C.DownArrow, () => cycleRail(1));
  } catch {}
}

let isLocal = true;
// 서버(같은 기계)가 알려주는 홈 경로. 터미널에 찍힌 `~/…`를 창이 짐작하지 않고 이 값으로 편다.
let hostHome = "";
// 분리 브라우저 창 여부(?mode=browser). 이 창은 콘솔 크롬 없이 브라우저만 전체 창으로 띄우고
// 서버 공유 상태(sbState)의 활성 스페이스 브라우저 탭을 미러링한다. bm* 헬퍼는 런타임에 sbState 참조.
const APP_PARAMS = new URLSearchParams(location.search);
const BROWSER_MODE = APP_PARAMS.get("mode") === "browser";
const MEMO_MODE = APP_PARAMS.get("mode") === "memo";
const AUX_MODE = BROWSER_MODE || MEMO_MODE;
// 이 창의 종류. 기능은 표에 자기가 속한 창을 적고, 앱 셸은 그 표를 읽는다.
const WINDOW_MODE = BROWSER_MODE ? "browser" : (MEMO_MODE ? "memo" : "main");
const livesHere = (cap) => (cap.windows || ["main"]).includes(WINDOW_MODE);
if (MEMO_MODE) document.body.classList.add("memo-mode");
// 창→스페이스 결속. 기존 분리창은 결속이 없어 활성 스페이스를 미러링하고(종전 동작 그대로),
// 공유 창은 ?space=__shared__로 떠서 콘솔이 스페이스를 바꿔도 자기 스페이스를 계속 본다.
const BOUND_SPACE = APP_PARAMS.get("space") || null;
// 탭 하나만 담는 창은 주소에 그 탭을 적는다. 창의 범위를 주소가 정하는 기존 방식(mode·space)에
// 값을 하나 더한 것이라, 이 값이 없으면 스페이스 전체를 보는 창이 된다.
const BOUND_TAB = APP_PARAMS.get("tab") || null;
initBrowserState({ BOUND_SPACE, BROWSER_MODE, wsSend });
let curTarget = null;            // 선택된 세션 pane_id
let lastAgentBySpace = {};       // spaceId → 마지막으로 머문 에이전트 paneId (스페이스 복귀 시 복원용)
// spaceId -> 마지막으로 머문 herdr 탭 tabId. lastAgentBySpace는 에이전트가 붙은 탭만 담아서,
// 세션이 검출되지 않은 빈 탭에 머물다 스페이스를 떠나면 복귀 시 첫 에이전트로 이동한다. 탭 단위로 따로 기억한다.
let lastTabBySpace = {};

function wsSend(o) {
  // 오래된 호출 모양도 fs.write만큼은 correlation 통로에 합류시킨다. sendTabIo 자체는 socket.send를
  // 직접 써 재귀하지 않으며, 반환 Promise는 이후 저장/닫기 흐름에서 그대로 소비할 수 있다.
  if (o && o.type === "fs.write" && !o.requestId) {
    const owner = o.space && o.tabId ? { space: o.space, tabId: o.tabId } : tabIoOwner(o.path);
    const pending = sendTabIo({ ...o, space: owner.space, tabId: owner.tabId, reason: "save" });
    pending.catch(() => {});
    return pending;
  }
  if (o && o.type === "pick-mode" && o.op === "toggle") o = { ...o, hasSheetContext: !!callHook("pick.sheetContext"), hasDocxContext: !!callHook("pick.docxContext") };
  transportWsSend(o);
}

// ── 스페이스 열쇠 ──
// 화면과 herdr 사이에서 스페이스를 가리키는 이름은 workspace_id다. 그 id는 복원할 때 달라지고,
// 절대경로는 폴더를 옮기면 달라진다. 그래서 로컬 저장분도 서버가 준 폴더 객체 키로 적는다.
let spaceKeyById = {};
const spk = (id) => (id && spaceKeyById[id]) || id;                         // 저장할 때
const spid = (k) => (getSpaces().find((s) => spk(s.id) === k) || {}).id || k;    // 읽어올 때
// merge가 있으면 목적지에 이미 있을 때 합친다. 없으면 현재 값을 남긴다(설정값은 하나뿐이라
// 합칠 수 없다). 어느 쪽이든 옮기다가 버리지는 않는다.
function storedObjRemap(lsKey, map, merge) {
  let o = {}; try { o = JSON.parse(localStorage.getItem(lsKey) || "{}"); } catch { return; }
  let changed = false;
  for (const [from, to] of Object.entries(map)) {
    if (from === to || !Object.prototype.hasOwnProperty.call(o, from)) continue;
    if (!Object.prototype.hasOwnProperty.call(o, to)) o[to] = o[from];
    else if (merge) o[to] = merge(o[to], o[from]);
    delete o[from]; changed = true;
  }
  if (changed) try { localStorage.setItem(lsKey, JSON.stringify(o)); } catch {}
}
// 파일 탭은 목록이라 합칠 수 있다. 복원한 스페이스에서 열려 있던 파일을 뒤에 붙인다.
function mergeFileTabs(dst, src) {
  const files = [...(dst?.files || [])];
  for (const f of (src?.files || [])) if (!files.includes(f)) files.push(f);
  return { files, active: dst?.active || src?.active || null };
}
// 이 창이 스페이스 열쇠로 들고 있는 저장분을 한 표대로 옮긴다. 두 번 해도 결과가 같다.
// 표의 방향은 두 가지다. 이전 workspace_id → 폴더(첫 이관), 이전 폴더 → 새 폴더(키 교정)다.
// 열쇠는 그냥 문자열이라 두 경우 모두 같은 코드로 처리된다.
function remapWindowStores(map) {
  if (!map || !Object.keys(map).length) return;
  storedObjRemap("ac.filetabs", map, mergeFileTabs);
  storedObjRemap("ac.spaceDefaultProfile", map);
  callHook("memo.remapDrafts", map);
  try {
    const cs = localStorage.getItem("ac.centerspace");
    if (cs && map[cs]) localStorage.setItem("ac.centerspace", map[cs]);
  } catch {}
  const before = JSON.stringify(spaceOrder);
  spaceOrder = spaceOrder.map((x) => map[x] || x).filter((x, i, a) => a.indexOf(x) === i);
  if (JSON.stringify(spaceOrder) !== before) { try { localStorage.setItem("ac.spaceOrder", JSON.stringify(spaceOrder)); } catch {} }
  let colChanged = false;
  for (const set of [collapsed.groups, collapsed.spaces]) {
    for (const id of [...set]) if (map[id]) { set.delete(id); set.add(map[id]); colChanged = true; }
  }
  if (colChanged) saveCollapsed();
}
// 서버가 workspace→현재 객체 키와 레거시 키→해당 객체 키 표를 주면 로컬 저장분도 같이 옮긴다.
function applySpaceKeys(map, remaps) {
  remapWindowStores(remaps);
  spaceKeyById = map || {};
  remapWindowStores(spaceKeyById);
}

// ── Space 순서 (드래그, localStorage) ──
// 순서는 폴더 객체 키로 남긴다. 스페이스를 보관했다 복원해도 순서가 유지된다.
let spaceOrder = [];
try { spaceOrder = JSON.parse(localStorage.getItem("ac.spaceOrder") || "[]"); } catch {}
function orderedSpaces() {
  const spaces = getSpaces();
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const out = [];
  for (const k of spaceOrder) { const id = spid(k); if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); } }
  for (const s of spaces) if (byId.has(s.id)) out.push(s);
  return out;
}
function saveOrder(list) { spaceOrder = list.map((s) => spk(s.id)); localStorage.setItem("ac.spaceOrder", JSON.stringify(spaceOrder)); }

// ── 접힘 상태 ──
// 접힘 상태는 기기에 남는다. 창을 다시 열 때마다 초기화되면 매번 다시 접어야 한다
// (실행 창·에이전트 그룹·폴더 등). 폴더 경로·그룹 id는 그대로 키가 된다.
const COLLAPSE_KEY = "ac.collapsed";
const collapsed = (() => {
  const base = { panels: new Set(), spaces: new Set(), dirs: new Set(), groups: new Set() };
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
    for (const k of Object.keys(base)) if (Array.isArray(raw[k])) base[k] = new Set(raw[k]);
  } catch {}
  return base;
})();
let collapseSaveTimer = null;
function saveCollapsed() {
  clearTimeout(collapseSaveTimer);
  collapseSaveTimer = setTimeout(() => {
    const o = {}; for (const k of Object.keys(collapsed)) o[k] = [...collapsed[k]];
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(o)); } catch {}
  }, 200);
}
const dirCache = new Map();
let selectedSpaceId = null;
let activeFile = null;

// ── Explorer(포커스 스페이스 파일 트리, 좌상) + Spaces 목록(좌중) ──
// 최상위 DOM 조회와 파일 트리 click listener 의 초기화 위치. 상태와 연결은 explorer/tree.js 가 소유한다.
initTree({
  $, esc, wsSend, statusClass, orderedSpaces,
  getIsLocal: () => isLocal,
  getSelectedSpaceId: () => selectedSpaceId,
  getActiveFile: () => activeFile,
  setActiveFile: (value) => { activeFile = value; },
  saveCollapsed, syncWatchDirs, collapsed, dirCache,
});

// ── 공용 토스트 ──
let toastTimer = null;

function showToast(msg) { const t = $("#copied-toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1600); }
// main 이 조용히 취소한 일을 사람에게 한 줄로 알린다. 그게 없으면 버튼이 안 먹는 것으로만 보인다.
try { window.acHost?.onNativeNotice?.((m) => { if (m && m.text) showToast(String(m.text)); }); } catch {}
function copyText(text) { try { window.acHost?.writeClipboard(String(text)); } catch {} try { navigator.clipboard?.writeText(String(text)); } catch {} }
// docx/sheet 패널에 지금 연 파일의 경로를 보여주고 누르면 복사한다. 브라우저 탭의 주소줄과 같은
// 역할. 전체
// 경로는 title(hover)로도 볼 수 있게 그대로 노출한다.
function filePathBarHtml(path) {
  if (!path) return "";
  return `<button class="fv-path" data-copy-path="${esc(path)}" title="${esc(path)}(눌러서 경로 복사)">${esc(path)}</button>`;
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-path]"); if (!btn) return;
  copyText(btn.dataset.copyPath); showToast("경로를 복사했습니다");
});
// 유지되는 알림. 사라지는 토스트와 달리 사용자가 확인을 누를 때까지 남고, 해당 위치로 이동시킨다.
let noticeSeq = 0;
// 앱임을 증명하는 토큰. 여러 곳에서 쓰므로 한 번만 읽어 둔다(동기 IPC).
let _uiToken = null;
function uiToken() {
  if (_uiToken === null) { try { _uiToken = (window.acHost && acHost.uiToken && acHost.uiToken()) || ""; } catch (e) { _uiToken = ""; } }
  return _uiToken;
}
// choices: 부르는 쪽이 정한 답 목록. 없으면 [확인](=나중에) 하나다.
// 선택지를 서버가 정해 두면 "다 했어요/못 하겠어요"밖에 못 고르는데, 사람이 답할 것은
// 그 둘만 있는 것이 아니라, 예/아니오처럼 상황마다 다른 답이 필요하다.
function noticeChoices(cs, withGo) {
  if (!cs || !cs.length) return "";
  // data-pick 은 메뉴 시스템이 이미 쓰는 이름이라, 알림 답은 다른 이름을 쓴다.
  return cs.map((c, i) => `<button class="${i === 0 && !withGo ? "hot" : ""}" data-ans="${esc(c)}">${esc(c)}</button>`).join("");
}
function showNotice({ title, body, warn, action, answer, hot, choices }) {
  // 방송은 모든 창이 받는다. 모든 창이 알림을 띄우면 같은 알림이 분리 브라우저 창마다
  // 겹쳐 뜬다. 알림은 콘솔 본 창 하나에서만 보인다.
  if (BROWSER_MODE) return;
  const stack = $("#noticestack"); if (!stack) return;
  const id = "nt" + (++noticeSeq);
  const el = document.createElement("div");
  el.className = "notice" + (warn ? " warn" : "") + (hot ? " call" : "");
  el.innerHTML = `<div class="nt">${esc(title)}</div><div class="nb">${esc(body || "")}</div>`
    + `<div class="na">${action ? `<button class="hot" data-go="1">${esc(action.label)}</button>` : ""}${
        choices && choices.length ? noticeChoices(choices, !!action) : `<button data-close="1">확인</button>`}</div>`;
  if (answer) el.dataset.wait = "1";   // 답을 기다리는 알림은 새 알림에 밀려 사라지면 안 된다
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-go]") && action) {
      try { action.run(); } catch {}
      try { answer && answer("갔음"); } catch {}
      if (!answer) { el.remove(); return; }
      // 그 탭으로 간 것은 출발이지 완료가 아니다. 여기서 알림을 닫아 버리면 AI는 사람이 일을 마쳤는지
      // 답을 받지 못한 채 종료되므로, 종료를 알릴 경로를 남긴다.
      const picks = choices && choices.length ? noticeChoices(choices, false) : "";
      el.querySelector(".nb").textContent = (body || "")
        + (picks ? ". 보고 나서 아래에서 골라 주세요. AI가 기다리고 있습니다."
                 : ". 끝나면 [다 했어요]를 눌러 주세요. AI가 기다리고 있습니다.");
      el.querySelector(".na").innerHTML = picks
        || `<button class="hot" data-done="1">다 했어요</button><button data-fail="1">못 하겠어요</button>`;
      return;
    }
    const pick = e.target.closest("[data-ans]");
    if (pick) { try { answer && answer(pick.dataset.ans); } catch {} el.remove(); return; }
    if (e.target.closest("[data-done]")) { try { answer && answer("다 했음"); } catch {} el.remove(); return; }
    if (e.target.closest("[data-fail]")) { try { answer && answer("못 했음"); } catch {} el.remove(); return; }
    if (e.target.closest("[data-close]")) { try { answer && answer("나중에"); } catch {} el.remove(); }
  });
  stack.appendChild(el);
  while (stack.children.length > 4) {
    const victim = [...stack.children].find((c) => !c.dataset.wait);
    if (!victim) break;
    victim.remove();
  }
  return id;
}
// 해당 탭으로 이동시킨다. 알림만 주고 찾아가게 하면 알림의 역할을 하지 못한다.
// 알림의 "그 탭으로" 동작. 순서가 중요하다. 그 탭이 있는 스페이스로 먼저 옮기고, 그 스페이스의
// 브라우저 탭으로 들어간다. 콘솔 탭 목록에 그 탭이 없으면(다른 스페이스에서 AI가 만든 탭)
// 활성 id만 바뀌어 아무것도 뜨지 않거나 파일 탭 영역에 다른 내용이 표시된다.
function gotoTabById(tabId) {
  if (!tabId) return;
  const sp = spaceOfTabId(tabId); if (!sp) return;
  // 브라우저가 분리돼 있으면 그 창이 탭을 소유한다. 창을 띄우고 그쪽에서 전환한다. 다만 콘솔(과 herdr)
  // 쪽 스페이스도 함께 옮겨야 한다. 여기서 바로 빠져나가면 탭만 바뀌고 스페이스는 그대로여서,
  // 이동한 탭과 작업 환경이 서로 다른 스페이스에 남는다.
  if (!BROWSER_MODE && getBrowserState().docked === false) {
    if (sp !== selectedSpaceId) focusSpace(sp);
    bsMutate({ op: "space.active", space: sp });
    bsMutate({ op: "tab.switch", space: sp, id: tabId });
    try { window.acHost && acHost.openBrowser && acHost.openBrowser(); } catch {}
    return;
  }
  if (!BROWSER_MODE) {
    focusSpace(sp);   // 사이드바 선택·파일 트리·센터까지 그 스페이스로 (centerSpace도 여기서 바뀐다)
    // 콘솔 탭 목록에 그 브라우저 탭이 없으면 여기서 만들어 넣는다(webview는 reconcile이 붙인다).
    ensureTabSpace(sp);
    if (!getTabs(sp).find((x) => x.id === tabId)) {
      const bm = ((getBrowserState().tabsBySpace || {})[sp] || []).find((x) => x.id === tabId);
      addTab(sp, { id: tabId, kind: "browser", label: (bm && (bm.name || bm.title)) || "브라우저", path: null });
    }
  }
  setActiveTab(sp, tabId);
  bsMutate({ op: "tab.switch", space: sp, id: tabId });   // 브라우저 상태의 활성 탭도 같이 옮긴다
  renderTabs(); showActiveTab(); renderBmTabs();
}

// ── 파일 트리 우클릭 컨텍스트 메뉴(VSCode식) ──
// 최상위 연결 위치. 메뉴·대화상자·파일 클립보드와 listener 는 explorer/context-menu.js 가 소유한다.
initContextMenu({
  $, esc, wsSend, showToast, copyText,
  isFileLikeKind,
  getIsLocal: () => isLocal,
  getSelectedSpaceId: () => selectedSpaceId,
  orderedSpaces, saveOrder, focusSpace,
});

// ── Agents (Space별 그룹) ──
// 최상위 Agents listener 등록 위치. 렌더·drag·우클릭·이름변경 연결을 같은 phase에 등록한다.
initAgents({
  $, esc, cssEsc, statusClass, wsSend,
  getIsLocal: () => isLocal,
  getCurTarget: () => curTarget,
  setCurTarget: (value) => { curTarget = value; },
  orderedSpaces, spk, saveCollapsed, selectSession, collapsed,
  copyText, showToast,
  getSelectedSpaceId: () => selectedSpaceId,
});

// ── 패널 접기 ──
// 접고 편 상태는 다음에도 유지되어야 한다. 창을 열 때마다 초기화되면 매번 다시 접어야 한다
//. 실행 도크만 따로 기억하던 것을 모든 패널로 넓힌다. 저장 키는 패널 id.
function panelOpenKey(id) { return "ac.panel." + id; }
function setPanelOpen(id, open, remember) {
  const p = $("#" + id); if (!p) return;
  p.classList.toggle("collapsed", !open);
  const head = p.querySelector(".panel-head");
  head?.querySelector(".caret")?.classList.toggle("open", open);
  if (remember) localStorage.setItem(panelOpenKey(id), open ? "1" : "0");
  // 메모 편집기는 펼쳤을 때 처음 만든다. 아래 memoVisible 주석 참고(시작 경로에 Monaco를 로드하지 않는다).
  if (id === "panel-memo" && open) callHook("memo.renderPreview");
}
document.querySelectorAll(".panel-head").forEach((h) => h.addEventListener("click", (e) => {
  if (e.target.closest(".add")) return;
  const id = h.dataset.panel; const p = $("#" + id); if (!p) return;
  setPanelOpen(id, p.classList.contains("collapsed"), true);
}));
// 저장된 접힘 상태 복원. 저장이 없으면 마크업의 기본값을 그대로 둔다(실행 도크는 기본 접힘).
(function restorePanels() {
  for (const h of document.querySelectorAll(".panel-head")) {
    const id = h.dataset.panel; if (!id) continue;
    let v = localStorage.getItem(panelOpenKey(id));
    if (v == null && id === "panel-run") v = localStorage.getItem("ac.runDock"); // 이전 키 호환
    if (v == null) continue;
    setPanelOpen(id, v === "1", false);
  }
})();

initLayoutEngine({ $ });

// ── 우측 터미널 (xterm.js 엔진) ──
const tName = $("#t-name"), tSub = $("#t-sub"), tDot = $("#t-dot");
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
initTerminal({ $, wsSend });
initHerdrTabs({ $, wsSend, showToast, getIsLocal: () => isLocal, getSelectedSpaceId: () => selectedSpaceId,
  onLayoutChange: () => sendPtyResize() });
// xterm 입출력 연결은 이 위치에서 초기화한다. 복붙 기능(화면 밖 드래그·복사
// 정리·자동 복사·파일 드롭)는 chatcopy 기능이 소유하고, 여기서는 훅만 부른다.
function terminalWs() { return getWs(); }
function terminalCurTarget() { return curTarget; }
initXtermWiring({ blog, wsSend, showToast, getWs: terminalWs, getCurTarget: terminalCurTarget });
// 사이드바에서 에이전트를 고르면 파일트리·센터는 그 Space로 동기화하고, 실물 herdr 터미널은
// 계속 라이브로 보인다(세션 네비게이션은 herdr 자체 키바인딩). curTarget은 조종(요소선택 지시
// 전송)·파일트리 컨텍스트로만 쓴다.
// 에이전트가 속한 Space로 사이드바·파일트리·센터·실행패널을 함께 전환한다.
// selectSession(사용자 클릭)과 applyHerdrFocus(herdr 역동기화)가 같은 전환을 하므로 한 곳에 둔다.
function switchToSpaceOf(a) {
  selectedSpaceId = a.workspaceId;
  callHook("run.refresh"); // 스페이스 변경 → 실행 패널도 새 프로젝트로(stale 실행 방지, M3)
  callHook("git.sync"); // 소스 제어가 열려 있으면 순서·현재 레포 표시를 새 스페이스에 맞춘다
  const s = orderedSpaces().find((x) => x.id === a.workspaceId);
  if (s && s.folder) requestDir(s.folder);
  renderSpaces(); renderFileTree(); switchCenterSpace(a.workspaceId);
  getSpaceList().querySelector(`.space-row[data-space="${cssEsc(a.workspaceId)}"]`)?.scrollIntoView({ block: "nearest" });
  // 스페이스가 바뀌면 에이전트 목록도 그 스페이스 기준으로 다시 그리고, 현재 에이전트를 표시한다.
  // 스페이스만 바뀌고 에이전트 섹션이 그대로면 현재 위치를 알 수 없다.
  renderAgents(); revealAgentRow(a.paneId || curTarget);
}
function selectSession(target, fromSpace) {
  markHerdrUserSelect(); // 사용자 클릭 직후 잠깐은 herdr 역동기화가 선택을 뒤집지 못하게.
  curTarget = target;
  const a = agentByPane(target);
  if (a && a.workspaceId) lastAgentBySpace[a.workspaceId] = target; // 이 스페이스의 마지막 활성 탭 기억
  tName.textContent = a ? nameOf(a) : target;
  tSub.innerHTML = a ? `${agentMark(a.agent)}<span>${escHtml(a.status)}</span>` : "";
  tDot.className = "dot " + statusClass(a?.status);
  initXterm();
  // 임베드된 herdr(같은 세션)를 이 에이전트 pane으로 이동 → 터미널 화면이 그 에이전트로 전환.
  wsSend({ type: "focus", target });
  if (window.innerWidth > 820) setTimeout(() => { fitTerminal(); getXterm().focus(); }, 0);
  // herdr식 연동: 에이전트를 고르면 그 에이전트의 Space도 함께 포커싱(하이라이트+스크롤).
  // fromSpace=true면 Space 쪽에서 이미 온 호출이라 되돌아가는 렌더를 생략(루프 방지).
  if (!fromSpace && a && a.workspaceId && a.workspaceId !== selectedSpaceId) {
    switchToSpaceOf(a);
  }
  renderAgents();
  revealAgentRow(target);   // 클릭으로 고른 것도 앞뒤가 보이게 한다(목록 끝에 붙지 않도록)
  if (window.innerWidth <= 820) { $("#right").scrollIntoView(); $("#sidebar").classList.remove("mobile-open"); }
}
// Space를 고르면: 그 Space의 파일트리(Explorer)·센터 작업공간·첫 에이전트를 함께 포커싱.
// VSCode 창이 스페이스마다 각각 존재하는 모델.
function focusSpace(id) {
  selectedSpaceId = id;
  callHook("git.sync"); // 소스 제어 열려 있으면 새 스페이스 repo를 위로 올리고 그 레포만 갱신
  callHook("run.refresh"); // 실행 패널을 새 스페이스 스크립트로 갱신
  const s = orderedSpaces().find((x) => x.id === id);
  if (s && s.folder) requestDir(s.folder); // Explorer 루트 로드
  renderSpaces(); renderFileTree();
  getSpaceList().querySelector(`.space-row[data-space="${cssEsc(id)}"]`)?.scrollIntoView({ block: "nearest" });
  switchCenterSpace(id); // 센터 탭을 이 스페이스 작업공간으로 전환
  const ags = agentsOfSpace(id);
  // 1순위: 이 스페이스에서 마지막으로 머문 herdr 탭(세션 없는 빈 탭 포함). 아직 존재할 때만.
  // 이미 그 탭이 포커스면 보내지 않는다 - 불필요한 herdr 왕복과 에코를 만들지 않기 위해.
  const wsTabs = getTabsForSpace(id);
  const wantTab = lastTabBySpace[id];
  const tabExists = wantTab && wsTabs.some((x) => x.tabId === wantTab);
  if (tabExists && !wsTabs.some((x) => x.tabId === wantTab && x.focused)) wsSend({ type: "tab-focus", tabId: wantTab });
  if (ags.length) {
    // 2순위: 마지막 에이전트. 기억한 탭이 있으면 그 탭에 속한 에이전트를 고른다.
    const byTab = tabExists ? ags.find((x) => x.tabId === wantTab) : null;
    const remembered = lastAgentBySpace[id];
    const pick = byTab ? byTab.paneId
      : (remembered && ags.some((x) => x.paneId === remembered)) ? remembered : ags[0].paneId;
    selectSession(pick, true);
    revealAgentRow(pick);
  } else renderAgents();
}
// ── herdr → 우리 툴 역방향 상태 동기화 ──────────────────────────────────────
function herdrSyncCurTarget() { return curTarget; }
function setHerdrSyncCurTarget(value) { curTarget = value; }
function herdrSyncSelectedSpaceId() { return selectedSpaceId; }
initHerdrSync({
  getCurTarget: herdrSyncCurTarget, setCurTarget: setHerdrSyncCurTarget,
  getSelectedSpaceId: herdrSyncSelectedSpaceId, statusClass, switchToSpaceOf,
  lastAgentBySpace, tName, tSub, tDot,
});
// (ANSI 렌더/컴포저는 xterm.js 엔진으로 대체. initXterm/renderTerm 상단 정의)
function setRightCollapsed(on) {
  $("#right").classList.toggle("collapsed", on);
  document.body.classList.toggle("right-collapsed", on);
  setTimeout(() => { try { sendPtyResize(); } catch {} }, 60);
}
$("#right-collapse").addEventListener("click", () => setRightCollapsed(!$("#right").classList.contains("collapsed")));
$("#right-restore").addEventListener("click", () => setRightCollapsed(false));

// 영역 폭·높이 조절과 배치는 core/layout-engine.js 가 맡는다(경계 막대 · 편집 모드).

// 터미널 드래그 선택→자동복사는 xterm.onSelectionChange(initXterm)가 처리한다.

// ── 가운데: VSCode식 탭 (파일 + 브라우저). 스페이스마다 각각의 작업공간 ──
const tabstrip = $("#tabstrip"), centerEmpty = $("#center-empty"), fileview = $("#fileview"), browserview = $("#browserview");
function centerTabsWs() { return getWs(); }
function centerTabsWsGeneration() { return getWsGeneration(); }
function centerTabsHostHome() { return hostHome; }
function centerTabsCurTarget() { return curTarget; }
function centerTabsSelectedSpaceId() { return selectedSpaceId; }
// docx 탭 렌더와 표 뷰어는 뷰어 기능이 통째로 소유한다(web/js/viewer/boot.js).
// 여기서 만들어 가운데 탭·도크·닫기에 함수로 넘기면 뷰어를 꺼도 4200줄이
// 함께 실렸고, 조립 순서(이 블록이 가운데 탭보다 먼저여야 한다는 것)가 이 파일의 사정이 됐다.
// 지금 앱 셸은 이름만 부른다: viewer.renderDocxPanelBody · viewer.cleanupDocxRender.

// listener 등록 순서를 보존하는 가운데 탭 DOM·파일 I/O 조립 경계.
initCenterTabs({
  $, esc, wsSend, showToast, BROWSER_MODE, isFileLikeKind, acHost: window.acHost,
  tabstrip, centerEmpty, fileview, browserview,
  updateActiveWebview, newBrowserTab, agentByPane,
  getHostHome: centerTabsHostHome, getCurTarget: centerTabsCurTarget,
  getLastAgents, getSelectedSpaceId: centerTabsSelectedSpaceId,
  spk, spid, getWs: centerTabsWs, getWsGeneration: centerTabsWsGeneration,
});
if (!AUX_MODE || BROWSER_MODE) initCenterFileDrop({
  tabstrip, centerBody: $("#center-body"), document, window, acHost: window.acHost,
  browserview, browserWindow: BROWSER_MODE, openFile, openDroppedLocal, showToast, callHook,
  isBrowserTab: (id) => curTabs().some((tab) => tab.id === id && tab.kind === "browser"),
});
// ── ⌘⇧P 파일 검색 팔레트 (VSCode Quick Open 방식: 파일명 fuzzy) + 터미널 경로 ⌘클릭 열기 ──
initFilePalette({ esc, wsSend, getLastAgents });
// 🌐 브라우저 열기: 기본 분리형(요구5). 활성 스페이스를 서버에 알리고 브라우저 탭을 서버 상태에
// 만든 뒤 분리 창을 연다(이미 있으면 포커스). 도킹 상태면 콘솔 센터에 탭을 만든다(서버에도 반영).
// 새 탭 기본 페이지 = 구글이 주는 그 화면 그대로(직접 만든 대체 페이지가 아니라). 검색 자동완성·도구가
// 다 붙어 있어 그쪽이 쓰기 편하다. 붙여넣기가 씹히던 건 이 주소 때문이 아니라 about:blank를 거치는
// 두 단계 이동 때문이며, 즉시 src 설정과 주소창 편집 중 보호로 처리한다.
const DEFAULT_URL = "https://www.google.com/";
// 크롬처럼, 갓 연 탭에서는 주소창을 비워 둔다. 사용자가 직접 google.com으로 이동한 경우와 구분하려고
// 이 탭의 첫 이동인지로 판정한다. 두 번째 이동부터는 주소를 그대로 보여준다.
const GOOGLE_ROOT = /^https?:\/\/(www\.)?google\.[a-z.]+\/?(\?.*)?$/i;
const isNewTab = (u, rec) => !u || u === "about:blank" || (GOOGLE_ROOT.test(u) && !!rec && (rec.navs || 0) <= 1);
// 새 브라우저 탭(구글): 탭바 + 버튼. 도킹된 콘솔이면 콘솔 센터에도 만들고, 분리창이면 서버
// mutation만 보내 reconcileBrowserMode가 webview를 만든다.
function newBrowserTab(url, opts) {
  // 그룹에서 부르는 경우처럼 어느 스페이스인지 이미 아는 호출은 그 값을 그대로 쓴다. 창이 보고
  // 있는 스페이스와 그룹이 사는 스페이스가 어긋나면 만든 탭이 그룹에 안 들어간다.
  const sp = (opts && opts.space) || (BROWSER_MODE ? boundSpace() : consoleSpace());
  if (!sp) return;
  const target = url || DEFAULT_URL;
  const background = !!(opts && opts.background);
  const id = newTabId();
  // 페이지가 스스로 연 새 탭(target=_blank·가운데클릭)은 연 탭의 세션을 그대로 이어야 한다.
  // 안 그러면 방금까지 로그인돼 있던 사이트가 로그아웃 상태로 열린다(확인 결과: AWS 콘솔은 서비스를
  // 새 탭으로 연다). 그 경우엔 부르는 쪽이 profile을 준다.
  // 사람이 여는 새 탭(＋·⌘T·링크 열기)은 그 스페이스의 기본 계정으로 뜬다. 여기서 지금 보고 있는
  // 탭을 물려받으면 첫 탭의 계정이 그 스페이스에 영원히 복제돼, 기본 계정을 바꿔도 새 탭은 계속
  // 이전 계정으로 뜬다. 설정이 반영되지 않는다(확인 결과: Acme 기본은 Acme-Personal인데
  // 탭 4개가 전부 옛 기본 계정 하나로 박혀 있었다).
  // 기본 계정이 없으면 값을 박지 않는다(undefined). 그래야 나중에 기본을 정할 때 그 탭도 따라온다.
  const spDef = getSpaceDefaults()[sp];
  const inherit = opts && opts.profile !== undefined
    ? profileIdForStored(opts.profile)
    : ((spDef && profileById(spDef)) ? spDef : undefined);
  if (!BROWSER_MODE && getBrowserState().docked) {
    setCenterSpace(sp);
    ensureTabSpace(sp);
    addTab(sp, { id, kind: "browser", label: "브라우저", path: null });
    if (!background) setActiveTab(sp, id);
    createWebview(id, inherit, target); // 바로 목적지로 이동한다(중간 about:blank 단계 없음)
    renderTabs(); showActiveTab();
  }
  const mut = { op: "tab.open", space: sp, id, url: target, title: url ? "새 탭" : "Google", background };
  if (inherit !== undefined) mut.profile = inherit;
  // 그룹 탭은 처음부터 그 그룹 안에서 태어나야 한다. 뒤 mutation으로 옮기면 두 방송 사이에
  // 그룹 없는 탭으로 그려지는 순간이 생긴다.
  if (opts && opts.group) mut.group = opts.group;
  bsMutate(mut);
  // 빈 새 탭은 주소를 넣기 위해 연다. 주소창에 포커스를 두고 전체 선택하면 붙여넣기 한 번으로 링크가 들어간다.
  if (!url && !background) setTimeout(() => { try { urlInput.focus(); urlInput.select(); } catch (e2) {} }, 30);
  return id;   // 부르는 쪽이 방금 만든 탭을 가리킬 수 있어야 한다(녹화 대상 승계 등)
}
// 게스트의 "새 탭으로 열기"(target=_blank·가운데클릭). 별도 Electron 창이 뜨면 흰 화면만 보이므로
// main이 disposition을 보고 이 경로로 돌린다.
try { window.acHost && acHost.onOpenTab && acHost.onOpenTab((m) => {
  if (!m || !m.url) return;
  // 연 탭(opener)의 프로필을 찾아 넘긴다. 찾지 못하면 활성 탭 기준으로 상속한다.
  // 새 탭은 *요청한 탭에 지금 표시되는* 프로필로 뜬다. 저장값이 비어 스페이스 기본값을 따르는
  // 중이었다면 그 실제 값을 상속한다. 화면에 보이는 프로필과 새 탭의 세션이 달라지면 안 된다.
  let profile, openerSpace, openerGroup, openerTab = null;
  if (m.openerWc) {
    const hit = getWebviewEntries().find(([, rec]) => rec && rec.wc === m.openerWc)?.[0];
    if (hit) {
      openerTab = hit;
      openerSpace = spaceOfTabId(hit) || undefined;
      const browserState = getBrowserState();
      const owner = openerSpace && ((browserState.tabsBySpace && browserState.tabsBySpace[openerSpace]) || []).find((t) => t.id === hit);
      openerGroup = owner && owner.group ? owner.group : undefined;
      profile = profileOfTab(hit);
    }
  }
  const createdId = newBrowserTab(m.url, {
    background: m.background, profile, space: openerSpace, group: openerGroup,
  });
  // 녹화 중이던 탭이 연 탭은 같은 흐름이므로(결제창이 대표적) 기록 대상에 넣는다.
  // 무관한 탭이 연 것은 넣지 않는다. 그래야 기록에 남의 조작이 안 섞인다.
  if (createdId && openerTab && callHook("record.tracked", openerTab)) callHook("record.adopt", createdId);
}); } catch (e2) {}
// 네이티브 우클릭 메뉴가 보낸 범용 action을 기능 hook으로 넘긴다. shell은 action 이름의 뜻을
// 모른다. 기능이 꺼져 provider가 없으면 callHook 계약대로 조용히 아무 일도 하지 않는다.
try { window.acHost && acHost.onContextAction && acHost.onContextAction((message) => {
  if (!message || typeof message.name !== "string") return;
  callHook(message.name, message);
}); } catch (e2) {}
// 페이지 안에서 누른 로컬 링크. 브라우저가 못 그리는 것(표·문서·압축파일)과 앱이 그리기로 한
// 것(마크다운)이 여기로 온다. 처리하지 않으면 같은 탭에서는 내려받기로 빠지고 새 탭에서는 동작하지 않는다.
try { window.acHost && acHost.onOpenLocal && acHost.onOpenLocal((m) => {
  if (m && m.target) openLocalLink(m.target);
}); } catch (e2) {}
// 로컬에서 받은 파일: 뷰어가 맡는 종류만 연다. 그 판정은 등록표가 한다.
try { window.acHost && acHost.onDownloaded && acHost.onDownloaded((m) => {
  if (m && m.path) openDownloadedLocal(m.path);
}); } catch (e2) {}
// 앱이 그리는 링크 확장자 표를 main 에 넘긴다. webview 안에서 누른 링크는 렌더러 이벤트로 오지
// 않아서 그쪽 판정도 같은 표를 봐야 한다. 단축키 표(setKeymap)를 넘기는 이유와 같다.
try { window.acHost && acHost.setAppDrawnLinkExts && acHost.setAppDrawnLinkExts(APP_DRAWN_LINK_EXTS); } catch (e2) {}
initTabClose({
  esc, showToast, fileview, tabstrip, BROWSER_MODE, isFileLikeKind,
  tabIoRegistry, sendTabIo,
  renderTabs, showActiveTab, persistFileTabs, syncWatchDirs,
  trackFileWatch, untrackFileWatch, forgetTabWc,
  renderBmTabs, reconcileDocTabs, scheduleWebviewThrottling,
  openFileCtx, showCtx, startTabRename,
  exportBrowserHistory: (wcId) => window.acHost?.browserHistoryExport?.(wcId),
});

initTextEditor({
  $, esc, cssEsc, extOf, fileview, tabstrip,
  withFileViewTransition, bindAgentKeys, wsSend, isFileLikeKind, showToast,
  getRenderedFileOwner,
  getRenderedFileToken,
});

initMarkdown({ esc });

function memoReqId(prefix) {
  try { return prefix + ":" + crypto.randomUUID(); } catch { return prefix + ":" + Date.now() + ":" + Math.random().toString(36).slice(2); }
}

// ── 브라우저: 실물 Chrome <webview>(Electron) + Orca식 요소 선택 코그 ──
// 스크린캐스트 재구현을 폐기하고 Chromium <webview>를 그대로 임베드한다. 요소 선택 모드에서
// 페이지 요소를 클릭하면 설명 없이 그 요소 컨텍스트(태그·selector·텍스트·CSS·좌표·URL)가
// 현재 터미널(에이전트)로 전달된다. Orca Design Mode를 콘솔에 옮긴 기능이다.
// 다중 브라우저: 브라우저 탭마다 자체 <webview>. 🌐를 누를 때마다 새 탭+webview가 생기고,
// 활성 탭의 webview만 보인다. 모든 nav/pick/zoom은 활성 webview(activeWv)를 대상으로 한다.
const urlInput = $("#url"), bNote = $("#browser-note"), wvStack = $("#wv-stack");
// 값만 넘긴다. 연결은 아래 두 곳에서 각자 호출한다.
initBookmarks({ $, esc, urlInput, openBrowser, navigate });
initWebview({
  $, esc, wsSend, BROWSER_MODE, bNote, renderBmTabs, renderTabs,
  getSpaces,
  createWebview, forgetTabWc, showToast,
});
// ── 탭 화면 크기 ──
initViewport({ $, showToast, acHost: window.acHost });
// ── 마우스 드래그를 터치로 ──
initTouchDrag({
  $, blog, wsSend, showToast, acHost: window.acHost, BROWSER_MODE, toggleDock,
});

function profilesLocal() { return isLocal; }
initProfiles({
  $, esc, cssEsc, BROWSER_MODE, bNote, spid, forgetTabWc, createWebview, navigateOn,
  showToast, orderedSpaces, getIsLocal: profilesLocal,
});
initWebviewFactory({
  wsSend, BROWSER_MODE, BOUND_SPACE, bNote, urlInput, wvStack, isNewTab, showToast, blog,
  acHost: window.acHost,
});
$("#wv-profile").addEventListener("click", (e) => { e.stopPropagation(); if ($("#profile-menu")) closeProfileMenu(); else openProfileMenu(); });
// 주소창 입력·제안 목록 연결은 browser/bookmarks.js 가 소유한다. 제안 상태가 그 모듈에 있다.
wireUrlBar({ goUrl });
$("#wv-back").addEventListener("click", () => { const r = activeWv(); if (callHook("mirror.command", r, "back")) return;
  try { if (r && r.el.canGoBack()) r.el.goBack(); } catch (e) { blog("back err", e.message); } });
$("#wv-fwd").addEventListener("click", () => { const r = activeWv(); if (callHook("mirror.command", r, "forward")) return;
  try { if (r && r.el.canGoForward()) r.el.goForward(); } catch (e) { blog("fwd err", e.message); } });
$("#wv-reload").addEventListener("click", () => { const r = activeWv(); if (callHook("mirror.command", r, "reload")) return;
  try { if (r) r.el.reload(); } catch (e) {} });
$("#wv-devtools").addEventListener("click", () => toggleDevTools());
$("#wv-size").addEventListener("click", (e) => { e.stopPropagation(); openSizeMenu(); });
for (const [el, axis] of [[$("#wvh-r"), "r"], [$("#wvh-b"), "b"], [$("#wvh-c"), "c"]]) {
  if (el) el.addEventListener("mousedown", (e) => startSizeDrag(e, axis));
}
// 창·패널 크기가 바뀌면 가운데 정렬을 다시 잡는다.
try { new ResizeObserver(() => { if (!isSizeDragging()) viewportLayout(); }).observe($("#wv-stack")); } catch {}
// 마우스→터치는 그 화면 위에 있을 때만 켠다. 해제 신호를 여러 겹으로 둔다. 하나라도 놓치면
// 켜진 채 남아 창 전체 커서가 터치로 동작한다.
$("#wv-stack").addEventListener("mouseenter", () => syncTouchDrag(true));
$("#wv-stack").addEventListener("mouseleave", () => syncTouchDrag(false));
window.addEventListener("blur", () => syncTouchDrag(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) syncTouchDrag(false); });
// AI가 iris-browser viewport로 바꾼 것도 버튼·화면에 반영한다. 버튼이 실제와 다른 크기를 표시하지 않게 한다.
window.acHost?.onViewportChanged?.(({ wc, vp }) => {
  if (isSizeDragging()) return;               // 내가 끄는 중이면 내 값이 최신이다
  const hit = getWebviewEntries().find(([, rec]) => rec && rec.wc === wc);
  if (!hit) return;
  if (vp) viewportByTab[hit[0]] = { w: vp.w, h: vp.h };
  else delete viewportByTab[hit[0]];
  updateSizeBtn(); viewportLayout();
});
// 캡처 처리: 그려지지 않은 것은 어떤 방법으로도 캡처할 수 없다(확인 결과: 네 경로 모두 실패). 그 탭이 지금
// 보이는 탭이 아니어도 찍히게, 찍는 동안만 그 webview를 화면 위에 올려 합성 대상으로 만든다. 탭을 바꾸지
// 않으므로 사용자의 보기 상태는 그대로다. 1% 불투명도만으로는 페이지가 비쳐 보여서, 화면에 남는 부분을
// clip-path로 왼쪽 위 1px로 줄인다. 페이지는 전체가 그려져 캡처된다(확인 결과). 다른 방법은 실패했다.
// 불투명도 0과 clip 면적 0은 그리지 않았고, 다른 요소 뒤에 두는 방법은 단색 배경이 덮으면 그리지 않았다.
window.acHost?.onCaptureHold?.(({ wc, on }) => {
  const hit = getWebviewEntries().find(([, rec]) => rec && rec.wc === wc);
  if (!hit) return;
  const el = hit[1].el || hit[1];
  if (!el || !el.style) return;
  if (on) {
    if (el.dataset.acHeld) return;
    el.dataset.acHeld = el.getAttribute("style") || " ";
    el.style.cssText += ";position:fixed;left:0;top:0;width:100vw;height:100vh;"
      + "opacity:0.01;clip-path:inset(0 calc(100% - 1px) calc(100% - 1px) 0);"
      + "pointer-events:none;z-index:2147483646;visibility:visible;display:flex;";
  } else {
    const prev = el.dataset.acHeld;
    if (prev == null) return;
    delete el.dataset.acHeld;
    if (prev.trim()) el.setAttribute("style", prev); else el.removeAttribute("style");
  }
});
// 분리창 탭바는 browser/tabs.js 가 소유한다. 값 주입은 여기서 하고 연결은 아래에서 호출한다.
initBrowserTabs({
  $, esc, cssEsc, showToast, showCtx, renderTabs, startTabRename, newBrowserTab,
  tabstrip, browserview, closeTabs, isFileLikeKind, getPickMode: () => !!callHook("pick.mode"), BROWSER_MODE,
});
// ── 분리 브라우저 창(?mode=browser) 렌더 + 도킹/분리 ──────────────────────────
initDock({
  $, acHost: window.acHost, BROWSER_MODE, BOUND_SPACE, MEMO_MODE,
  bNote, browserview, fileview, urlInput,
  isFileLikeKind, isNewTab, newBrowserTab,
});

// 페이지 내 찾기(⌘F). 지금 탭의 webview 는 browser/webview 가 소유하므로 접근자로 넘겨야
// webview → webview-factory → find-in-page 고리가 안 생긴다.
initFindInPage({ $, activeWv });

// ── 키보드 내비 (#7 스왑: ⌥↑↓ 에이전트, ⌥⇧↑↓ Spaces) ──
function keynavSelectedSpaceId() { return selectedSpaceId; }
function keynavIsLocal() { return isLocal; }
// 메인 화면 ↔ 스페이스 브라우저 전환은 screen-switch 가 소유한다. 키 연결(keynav)과
// webview 포커스 중계(dock 의 ac-shortcut 표) 둘이 같은 명령을 부르므로 먼저 세운다.
initScreenSwitch({
  BROWSER_MODE, BOUND_SPACE, MEMO_MODE, acHost: window.acHost,
});
initClosedTabs({ wsSend, openFile, showToast });
// 설정 화면. 최근 닫은 탭은 여기 없다. 브라우저에서 쓰는 것은 브라우저에 둔다.
// 보안 스위치와 ⌥Tab 창의 진짜 상태는 main 이 들고 있다. 여기 사본은 화면을 그리기 위한 것이고,
// 값이 실제로 나가느냐를 정하는 것은 main 의 판정이다.
let loginConv = { on: false, warned: false };
let switcherModel = null;
async function syncLoginConvenience() {
  try { loginConv = (await window.acHost?.loginConvenience()) || loginConv; } catch {}
  renderKeymapPage();
}
async function syncSwitcher(payload) {
  if (!window.acHost?.windowSwitcher) return switcherModel;
  try {
    const result = await window.acHost.windowSwitcher(payload);
    if (payload?.op === "media" && result && result.icons && result.thumbs && Array.isArray(result.missing)) {
      switcherModel = { ...(switcherModel || {}), media: result };
    } else if (result && (Array.isArray(result.windows) || result.status)) {
      switcherModel = {
        ...(switcherModel || {}),
        ...result,
        status: result.status
          ? { ...(switcherModel?.status || {}), ...result.status }
          : switcherModel?.status,
      };
    }
  } catch {}
  renderKeymapPage();
  return switcherModel;
}
initKeymapPage({
  $, wsSend, showToast,
  getRailScreens: railScreens,
  setRailScreen,
  getSwitcher: () => switcherModel,
  pickWindow: (id) => syncSwitcher({ op: "pick", id }),
  unpickWindow: (ref) => syncSwitcher({ op: "unpick", ...(ref || {}) }),
  moveWindow: (ref, dir) => syncSwitcher({ op: "move", ...(ref || {}), dir }),
  // 새로 열거: 사람이 화면에 들어오거나 「다시 읽기」를 눌렀을 때만 쓴다.
  refreshWindows: async () => {
    await syncSwitcher({ op: "list", refresh: true });
    return syncSwitcher({ op: "media" });
  },
  // host가 든 것만: revision 방송으로 바뀐 행을 AX 재열거 없이 받는다.
  reloadWindows: () => syncSwitcher({ op: "list" }),
  openPermissions: (kind) => syncSwitcher({ op: "open-permissions", kind }),
  enableCapability: enableCapabilityNow,
  refreshRail: applyRailVisibility,
  getSecurityToggles: () => [{
    id: "login-convenience",
    name: "로그인 편의 기능",
    desc: "비밀번호 자동완성 · Chrome에서 가져오기 · 이 브라우저에서 새로 로그인한 것 저장. 끄면 셋이 모두 멈추고, 금고에 이미 있는 것도 꺼내 쓰지 않습니다(지우기는 그대로 됩니다).",
    on: !!loginConv.on,
    warn: loginConv.on ? "" : "켜면 이 기기 Keychain으로 잠근 금고에 비밀번호가 모입니다. AI가 브라우저를 조작하는 동안에는 전달되지 않습니다.",
  }],
  setSecurityToggle: async (id) => {
    if (id !== "login-convenience") return;
    try { loginConv = (await acHost.loginConvenience({ on: !loginConv.on })) || loginConv; } catch {}
  },
});
window.acHost?.onSwitcherState?.((state) => {
  if (!state) return;
  switcherModel = {
    ...(switcherModel || {}),
    status: { ...(switcherModel?.status || {}), ...state },
  };
  renderKeymapPage();
});
syncSwitcher({ op: "status" });
syncLoginConvenience();
// 최근 닫은 탭은 브라우저 주소줄이 소유한다.
initKeynav({
  wsSend, BROWSER_MODE, MEMO_MODE, acHost: window.acHost,
  orderedSpaces, selectSession, focusSpace, newBrowserTab,
  getCurTarget: terminalCurTarget, getSelectedSpaceId: keynavSelectedSpaceId,
  getIsLocal: keynavIsLocal, lastTabBySpace,
});

// ── AC1: 복귀 변경 식별 ──
let awaySnap = null;
const snap = () => new Map(getLastAgents().map((a) => [agentKey(a), a.status]));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { awaySnap = snap(); return; }
  if (!awaySnap) return;
  const cur = snap(), info = new Map();
  for (const [k, s] of cur) { if (!awaySnap.has(k)) info.set(k, "새로 시작"); else if (awaySnap.get(k) !== s) info.set(k, "변경"); }
  let gone = 0; for (const k of awaySnap.keys()) if (!cur.has(k)) gone++;
  awaySnap = null; setChangedInfo(info);
  const bar = $("#changebar");
  if (info.size || gone) { $("#changebar-text").textContent = `돌아온 사이: 변경 ${info.size}${gone ? `, 종료 ${gone}` : ""}`; bar.classList.add("show"); } else bar.classList.remove("show");
  renderAgents();
});
$("#changebar-clear").addEventListener("click", () => { setChangedInfo(new Map()); $("#changebar").classList.remove("show"); renderAgents(); });

// 브라우저는 상단 🌐 버튼으로만 연다(빈 공간 클릭으로 여는 동작은 제거했다).

// ── WebSocket ──
function handleWsOpen() {
  // 서버가 다시 뜨면 그쪽 탭 목록은 비어 있다. 여기서 다시 보고하지 않으면 열려 있는 탭이
  // `iris-browser tabs`에서 모두 사라진다(확인). 활성 탭 하나만 재보고하면 나머지가 목록에서 누락된다.
  $("#conn").classList.add("on"); if (getXterm()) startPty();
  // 프로필 목록(이름만)을 알린다. AI가 "다른 계정으로 열어라"를 하려면 어떤 로그인 칸이 있는지
  // 알아야 하는데, 목록은 창의 localStorage에만 있어 서버·AI 쪽에서는 보이지 않았다. 비밀은 안 나간다.
  if (!MEMO_MODE) try { setTimeout(() => wsSend({ type: "browser-profiles", profiles: getProfiles().map((p) => ({ id: p.id, name: p.name })) }), 200); } catch (e) {}
  // 이 연결이 앱 UI임을 먼저 증명한다. 지목(권한 확대)은 이 증명이 있는 연결만 보낼 수 있다.
  // 루프백이라는 것만으로는 앱과 아무 로컬 프로세스가 구별되지 않기 때문이다.
  try { const t = uiToken(); if (t) wsSend({ type: "ui-auth", token: t }); } catch (e) {}
  if (!MEMO_MODE) setTimeout(() => { for (const tid of getWebviewIds()) reportTabWc(getWebview(tid), tid); reportActiveBrowserWc(); }, 300);
  // 파일/docx/sheet 탭도 브라우저 탭과 같은 이유로 재연결마다 다시 요청해야 한다. 연결이
  // 끊겼거나 막 뜬 그 틈에 연 파일은 요청 자체가 안 나가 "불러오는 중…"에 영원히 갇힌다.
  if (!MEMO_MODE) setTimeout(retryStuckFileTabs, 300);
  // fs.watch 등록도 연결 객체에 묶여 서버 쪽에 있다. 재연결이면 중복전송 키를 비우고 다시 보낸다.
  if (!MEMO_MODE) { setLastWatchKey(""); setTimeout(syncWatchDirs, 300); }
}

function handleWsClose(generation) {
  tabRejectGenerationIo(generation);
  callHook("memo.disconnect");
  $("#conn").classList.remove("on"); $("#meta").textContent = "재연결 중…"; setPtyStarted(false);
  if (MEMO_MODE) return;
  markAiTargetsUnknown(); // authoritative held 상태를 다시 받을 때까지 LRU/스로틀 모두 fail-safe 보존
  markAiRecentUnknown();  // 최근 사용 신호도 마찬가지다. 끊긴 동안의 사용을 관측하지 못했으므로 재우지 않는다
  scheduleWebviewThrottling();
}

function handleWsBinary(data) {
  // 바이너리 프레임 = 실물 herdr 터미널의 PTY 출력. xterm에 바이트 그대로 쓴다.
  if (getXterm()) { getXterm().write(new Uint8Array(data), () => {
    scheduleCropDetect();
    // 화면 밖 드래그가 도는 중이면 이 프레임을 누적에 이어 붙여야 한다. 안 실렸으면 아무 일도 없다.
    callHook("chatcopy.captureAfterWrite");
  }); }
}

function dispatchWs(handler) {
  return (m) => {
    const generation = getWsGeneration();
    if (MEMO_MODE) { callHook("memo.windowMessage", m); return; }
    let responseIoEntry = null;
    if (m.requestId) {
      (() => {
        const entry = tabIoRegistry.get(m.requestId); if (!entry) return;
        if (entry.generation !== generation) return;
        responseIoEntry = entry;
        settleTabIo(m.requestId, m, null);
      })();
    }
    handler(m, responseIoEntry);
  };
}

function ignoreWsMessage() {}

function handleCapsMessage(m) {
  isLocal = !!m.local;
  if (typeof m.home === "string" && m.home) hostHome = m.home; // `~/…` 경로 해석용(서버가 아는 홈)
  renderAgents();
}

function handleStateMessage(m) {
      replaceHerdrState(m); if (m.tabs) for (const w of Object.keys(m.tabs)) { const f = (m.tabs[w] || []).find((x) => x.focused); if (f) lastTabBySpace[w] = f.tabId; } if (typeof m.local === "boolean") isLocal = m.local; renderHerdrTabs();
      renderSpaces(); renderAgents();
      callHook("git.syncOnly"); // 스페이스·pane이 열리고 닫히면 소스 제어의 레포 목록도 따라간다(새 폴더만 물어본다)
      // 방금 만든 스페이스가 이 갱신에 들어왔으면 그때 들어간다(생성 응답이 목록보다 먼저 온다).
      if (getPendingSpaceFocus() && orderedSpaces().some((s) => s.id === getPendingSpaceFocus())) {
        const id = getPendingSpaceFocus(); setPendingSpaceFocus(null); focusSpace(id);
      }
      restoreFileTabs(); // 재시작 시 열려있던 파일 탭 복원(1회, ws 연결 후)
      // 역방향 동기화: herdr에서 현재 포커스된 pane으로 우리 선택을 맞춘다(loop-safe, debounce).
      const agents = getLastAgents();
      const foc = agents.find((a) => a.focused);
      if (foc && !BROWSER_MODE) scheduleHerdrSync(foc.paneId); // 분리창은 콘솔 포커스 동기화 안 함
      if (curTarget) { const a = agentByPane(curTarget); if (a) { tName.textContent = nameOf(a); tSub.innerHTML = `${agentMark(a.agent)}<span>${escHtml(a.status)}</span>`; tDot.className = "dot " + statusClass(a.status); } }
      const running = agents.filter((a) => a.status === "working").length;
      $("#meta").textContent = `${agents.length} · ${running}▶`;
}

function handleBrowserStateMessage(m) { applyBrowserState(m.state); }

function handleFsMessage(m) {
      if (handlePendingRevealFs(m)) { focusCreatedAfterList(m.path); return; }
      dirCache.set(m.path, m.error ? [] : (m.entries || []));
      syncWatchDirs();
      if (m.git) mergeGitStatus(m.git); // 파일별 git 상태 병합
      renderFileTree();
      focusCreatedAfterList(m.path);
}

function handleFsOpMessage(m) {
      if (m.error) { showToast("파일 조작 실패: " + m.error); }
      else {
        if (m.from && m.newPath) retargetFileTabs(m.from, m.newPath); // rename/move: 열린 탭 경로 갱신
        if (m.parent && (m.op === "create-file" || m.op === "create-dir")) {
          setPendingCreateFocus({ path: m.newPath, parent: m.parent, isDir: m.op === "create-dir" });
          collapsed.dirs.delete(m.parent); saveCollapsed();
        }
        if (Array.isArray(m.refresh)) { for (const d of m.refresh) { dirCache.delete(d); requestDir(d); } renderFileTree(); }
        if (m.op === "create-file" && m.newPath) { openFile(m.newPath); showToast("파일을 만들었습니다"); }
        else if (m.op === "create-dir" && m.newPath) showToast("폴더를 만들었습니다");
        else if (m.op === "create-sheet" && m.newPath) { openFile(m.newPath); showToast("새 스프레드시트를 만들었습니다"); }
        else if (m.op === "copy" && m.newPath && m.open) { openFile(m.newPath); showToast("사본을 만들었습니다"); }
      }
}

function handleBrowserDialogMessage(m) {
      // 질문은 그것을 띄운 탭에 속한다. 다른 탭을 보고 있어도 그 탭이 대신 막히는 일은 없다.
      const hit = getWebviewEntries().find(([, rec]) => rec && rec.wc === m.wc)?.[0];
      if (hit) {
        if (m.open) setTabDialog(hit, { kind: m.kind || "alert", message: String(m.message || ""), wc: m.wc, def: String(m.def || ""), byAi: !!m.byAi });
        else clearTabDialog(hit);
        renderBmTabs(); renderTabDialog();
        if (m.open) { try { showToast("한 탭이 답을 기다립니다: " + String(m.message || m.kind).slice(0, 50)); } catch {} }
      }
}

function handleDirChangedMessage(m) {
      // 트리에 보이는 폴더면 목록을 다시 받는다(생성·삭제·이름변경이 그대로 보이게).
      if (dirCache.has(m.dir)) { dirCache.delete(m.dir); requestDir(m.dir); renderFileTree(); }
      // 그 폴더에 열어둔 파일이 있으면 내용을 다시 읽는다. 이름 정보가 없으면 그 폴더의 열린 파일 전부.
      const chNames = Array.isArray(m.names) ? m.names : [];
      const chSeen = new Set();
      for (const sp of getTabSpaces()) for (const ft of getTabs(sp)) {
        if (!isFileLikeKind(ft.kind) || !ft.path || chSeen.has(ft.path)) continue;
        const fdir = ft.path.slice(0, ft.path.lastIndexOf("/")) || "/";
        if (fdir !== m.dir) continue;
        const base = ft.path.slice(ft.path.lastIndexOf("/") + 1);
        if (chNames.length && !chNames.includes(base)) continue;
        chSeen.add(ft.path); requestReload(ft.path);
      }
}

function handleFileMessage(m, responseIoEntry) {
      const id = "file:" + m.path;
      if (responseIoEntry && responseIoEntry.reason === "discard") return;
      if (m.reason === "watch" || (!m.requestId && fileReloadReason.get(m.path) === "watch")) {
        fileReloadReason.delete(m.path);
        for (const sp of getTabSpaces()) {
          const ft = getTabs(sp).find((x) => x.id === id); if (!ft) continue;
          if (m.error) { ft.gone = true; if (ft.id === getActiveTabId(getCenterSpace())) showActiveTab(); }
          else {
            ft.gone = false; ft.hasDiskSnapshot = true;
            // 내용이 같으면 기준만 맞춘다. 그래야 자기 저장이 돌아온 응답이 충돌로 처리되지 않는다.
            if (m.content !== ft.content) applyExternalChange(ft, m.content, m.revision);
            else if (typeof m.revision === "string") ft.revision = m.revision;
          }
        }
        return;
      }
      // 확장자만으론 못 거른 바이너리(서버가 판정). 깨진 글자를 띄우는 대신 그 파일을 Finder에서
      // 보여주고, 방금 연 빈 탭은 닫는다. 아무것도 표시할 수 없는 탭을 남기지 않는다.
      if (m.binary) {
        const binaryTarget = responseIoEntry && responseIoEntry.tabRef;
        try { window.acHost && acHost.revealInFinder && acHost.revealInFinder(m.path); } catch (e) {}
        if (binaryTarget) removeTabsNow([{ space: responseIoEntry.owner.space, tabId: responseIoEntry.tabId, tabRef: binaryTarget }]);
        showToast("뷰어로 열 수 없는 형식입니다. Finder에서 보여줍니다");
        return;
      }
      // 편집 중(draft 존재)인 탭은 내용을 덮어쓰지 않는다(사용자 입력 보존). 최초 로드만 반영.
      for (const sp of getTabSpaces()) {
        const t = getTabs(sp).find((x) => x.id === id);
        if (t && !m.error) t.hasDiskSnapshot = true;
        if (t && t.draft == null) {
          t.content = m.error ? "[열 수 없음] " + m.error : m.content;
          // 저장할 때 "내가 읽은 뒤 바뀌었는가"를 대조할 기준. 편집 중인 탭은 자기 기준을 지킨다.
          if (typeof m.revision === "string") t.revision = m.revision;
        }
      }
      const at = curTabs().find((x) => x.id === id && x.id === getActiveTabId(getCenterSpace()));
      if (at) {
        if (at.draft == null) showActiveTab();
        if (at.id === getActiveTabId(getCenterSpace())) markFileDirty(at);
      }
}

function handleFileSavedMessage(m, responseIoEntry) {
      for (const t of [responseIoEntry && responseIoEntry.tabRef]) {
        const saving = t && t._saving;
        if (!saving || saving.requestId !== m.requestId) continue;
        if (m.error) continue;
        t.hasDiskSnapshot = true;
        t.content = saving.snapshot;
        // 방금 내가 쓴 것이 새 기준이다. 이걸 안 옮기면 다음 저장이 자기 저장을 충돌로 본다.
        if (typeof m.revision === "string") t.revision = m.revision;
        if (t.draft === saving.snapshot) t.draft = null;
        t._saving = null;
        if (t === getTabs(getCenterSpace()).find((tab) => tab.id === getActiveTabId(getCenterSpace()))) markFileDirty(t);
        else renderTabs();
        callHook("git.refreshFor", t.path);
      }
      if (m.error && !m.requestId) showToast("저장 실패: " + m.error);
}

function handlePtyStartedMessage() {
  // 실제 herdr 세션에 연결한다. 현재 크기를 즉시 반영한다.
  sendPtyResize();
}

function handlePtyExitMessage() {
  if (getXterm()) getXterm().write("\r\n\x1b[2m[herdr 세션 detach됨, 재연결 시도…]\x1b[0m\r\n");
  setPtyStarted(false); setTimeout(() => { if (getXterm()) startPty(); }, 800);
}

function handleControlErrorMessage(m) {
  if (getXterm()) getXterm().write(`\r\n\x1b[31m[오류] ${m.message}\x1b[0m\r\n`);
}

function handleSpaceErrorMessage(m) {
      showToast(m.message || "스페이스 조작 실패");
}

function handleSpaceCreatedMessage(m) {
      // 방금 만든 스페이스로 바로 들어간다. 스페이스를 만든 이유가 그 안에서 작업하기 위해서다.
      // 목록은 recompute 브로드캐스트로 갱신되므로, 아직 안 왔으면 다음 state에서 잡는다.
      setPendingSpaceFocus(m.workspaceId || null);
      if (getPendingSpaceFocus() && orderedSpaces().some((s) => s.id === getPendingSpaceFocus())) {
        focusSpace(getPendingSpaceFocus()); setPendingSpaceFocus(null);
      }
      showToast(`스페이스 "${m.label}" 생성됨`);
}

function handleControlActiveMessage(m) {
      // 탭별 조작 상태. 어느 탭을 어느 세션이 지금 만지고 있는지 그대로 받는다(병렬이면 여럿).
      setAiBusyTabs(new Map((m.tabs || []).map((t) => [t.tabId, t.labels || []])));
      // 같은 메시지에 최근 5분 사용도 함께 온다. 재우기 판정의 근거다. 둘을 한 메시지로 묶어
      // 두 신호가 서로 다른 시점의 그림을 말하지 않게 한다.
      setAiRecentUse(m.recentAi);
      document.body.classList.toggle("ai-busy", !!m.active);
      if (BROWSER_MODE) renderBmTabs(); else renderTabs();
      scheduleWebviewThrottling();
}


// 메모 알림 처리는 web/js/panel/memo-messages.js 가 소유한다. 알림이 늘어나는 이유와
// 조립부가 바뀌는 이유는 다르다.
// 스페이스 이름은 메모 화면의 것이 아니다. 메모 화면을 꺼도 메모 창 제목은 유지되어야 한다.
function handleSpaceKeyMovedMessage(m) {
      // 서버가 잘못된 폴더 키를 바로잡았다. 이 창이 이전 폴더에 갖고 있던 저장분도 함께 옮긴다.
      // 안 옮기면 그 스페이스의 파일 탭·순서·접힘만 아무도 안 보는 열쇠에 남는다.
      if (m.from && m.to) remapWindowStores({ [m.from]: m.to });
}

function handleSpaceKeysMessage(m) {
      // 이 창의 저장분(파일 탭·기본 프로필·순서·접힘)도 같은 열쇠로 옮긴다. state보다 먼저 온다.
      applySpaceKeys(m.map || {}, m.remaps || {});
}

function handleTabHandlesMessage(m) {
      setTabHandles(m.map);
}

function handleKeymapMessage(m) {
      // 서버가 정본이다. 창은 받아서 자기 판정에 쓰고, 메인 프로세스에도 같은 표를 넘긴다.
      // 페이지에 포커스가 있을 때의 중계가 그쪽에서 나기 때문이다. 안 넘기면 바꾼 키가
      // 앱 UI 위에서만 먹고 페이지 위에서는 안 먹는 반쪽이 된다.
      setKeymapOverrides(m.overrides);
      try { window.acHost && acHost.setKeymap && acHost.setKeymap(getKeymapOverrides()); } catch {}
      renderKeymapPage();
}

function handleClosedTabsMessage(m) {
      // 브라우저 탭 되돌리기 스택은 서버가 정본이다. 어느 창에서 닫았든 같은 값을 본다.
      setClosedBrowserTabs(m.tabs);
}

function handleTabReopenHistoryMessage(m) {
      queueReopenedBrowserHistory(m);
}

function handleWakeTabMessage(m) {
      // 서버가 잠든 탭에 명령을 보내려는 시점이다. 소유한 창만 만든다(wakeTabHere 안에서 판정).
      wakeTabHere(m.tabId);
}

function handleAiTargetsMessage(m) {
      setAiTargets(m.targets);
      reconcileAiTabs();   // 새로 쥔 탭이 생겼으면 보고 있지 않은 스페이스라도 띄운다
      renderBmTabs();
      scheduleWebviewThrottling();
}

function handleAiLoginNoteMessage(m) {
      const host = (() => { try { return new URL(m.origin).host; } catch { return m.origin || "이 사이트"; } })();
      const go = m.tabId ? { label: "그 탭으로", run: () => gotoTabById(m.tabId) } : null;
      if (m.kind === "filled") {
        showNotice({ title: "AI가 로그인 정보를 채웠습니다", body: `${host} · ${m.username || ""}`, action: go });
      } else if (m.kind === "none") {
        showNotice({ warn: true, title: "저장된 로그인이 없습니다", action: go,
          body: `${host}에서 AI가 로그인하려 했지만 저장된 계정이 없습니다. 직접 로그인해 주세요.` });
      } else if (m.kind === "blocked") {
        showNotice({ warn: true, title: "AI 로그인이 허용되지 않았습니다", action: go,
          body: `${host}에 저장된 계정(${(m.accounts || []).join(", ") || "-"})은 있지만 AI 사용이 허용돼 있지 않습니다. [🔑 로그인]에서 허용하거나 직접 로그인해 주세요.` });
      }
}

function handleAiAskMessage(m) {
      // AI가 대신할 수 없는 상황(결제·본인확인·캡차)에서 사용자를 호출한다. 강제로 화면을 바꾸지 않는다.
      // 부르고, 갈 길을 주고, 갔는지 아닌지만 알려준다.
      const reply = (a) => wsSend({ type: "ai-ask-answer", id: m.id, answer: a });
      // 대상이 탭일 수도 앱(시뮬레이터)일 수도 있다. 이동 위치와 문구가 그에 따라 달라진다.
      // 앱 이야기를 하면서 "그 탭으로"라고 적으면 사람이 어디를 봐야 하는지 알 수 없다.
      const isApp = m.where === "app";
      const goTo = isApp
        // 에뮬레이터 기능이 그 기기의 탭을 갖고 있으면 그 탭으로 옮긴다. 없으면 서버가 시뮬레이터를 앞으로 가져온다.
        ? { label: "그 앱으로", run: () => { if (!callHook("emulator.focus", m.device || "")) wsSend({ type: "focus-app", device: m.device || "" }); } }
        : (m.tabId ? { label: "그 탭으로", run: () => gotoTabById(m.tabId) } : null);
      showNotice({ hot: true, title: m.title || "AI가 사람을 부릅니다",
        body: m.text || (isApp ? "이 앱에서 사람이 직접 해야 하는 단계입니다."
                               : "이 탭에서 사람이 직접 해야 하는 단계입니다."),
        action: goTo, choices: m.choices, answer: reply });
}

function handleHerdrMessage(m) { if (!m.connected) $("#meta").textContent = "herdr 끊김"; }
function handleErrorMessage() { $("#meta").textContent = "오류"; }

const WS_DISPATCH = {
  "hb": dispatchWs(ignoreWsMessage),
  "caps": dispatchWs(handleCapsMessage),
  "state": dispatchWs(handleStateMessage),
  "browser-state": dispatchWs(handleBrowserStateMessage),
  "fs": dispatchWs(handleFsMessage),
  "fs-op": dispatchWs(handleFsOpMessage),
  "browser-dialog": dispatchWs(handleBrowserDialogMessage),
  "dir-changed": dispatchWs(handleDirChangedMessage),
  "tree": dispatchWs(handleFilePaletteTree),
  "file": dispatchWs(handleFileMessage),
  "file-saved": dispatchWs(handleFileSavedMessage),
  "pty.started": dispatchWs(handlePtyStartedMessage),
  "pty.exit": dispatchWs(handlePtyExitMessage),
  "control-error": dispatchWs(handleControlErrorMessage),
  "space-error": dispatchWs(handleSpaceErrorMessage),
  "space-created": dispatchWs(handleSpaceCreatedMessage),
  "control-active": dispatchWs(handleControlActiveMessage),
  "keymap": dispatchWs(handleKeymapMessage),
  "artifacts": dispatchWs(artifactsMessage),
  "artifacts-entries": dispatchWs(artifactsMessage),
  "artifacts-day": dispatchWs(artifactsMessage),
  "artifacts-preview": dispatchWs(artifactsMessage),
  "closed-tabs": dispatchWs(handleClosedTabsMessage),
  "tab-reopen-history": dispatchWs(handleTabReopenHistoryMessage),
  "wake-tab": dispatchWs(handleWakeTabMessage),
  "space-key-moved": dispatchWs(handleSpaceKeyMovedMessage),
  "space-keys": dispatchWs(handleSpaceKeysMessage),
  "tab-handles": dispatchWs(handleTabHandlesMessage),
  "ai-targets": dispatchWs(handleAiTargetsMessage),
  "ai-login-note": dispatchWs(handleAiLoginNoteMessage),
  "ai-ask": dispatchWs(handleAiAskMessage),
  "herdr": dispatchWs(handleHerdrMessage),
  "error": dispatchWs(handleErrorMessage),
};

// ── 보관함 ──
// 보관한 세션 목록. 복원은 서버가 스페이스를 확보하고 저장해 둔 이름으로 탭을 만든 뒤
// 그 안에서 `claude --resume <uuid>`(codex면 `codex resume`)를 친다.
(function wireRail() {
  const rail = $("#actrail"); if (!rail || BROWSER_MODE) return; // 분리 브라우저 창엔 rail 없음
  initRail({
    browserMode: BROWSER_MODE,
    toggleSidebar,
    screens: {
      keymap: { enter: enterKeymapPage },
    },
  });
})();

// 켜 둔 것만 여기서 로드한다. 이 위치는 rail 밖이다. rail 연결 함수 안에 두면 rail 이
// 없는 창에서 기능이 통째로 안 실리는 것이 rail 코드의 부작용으로 정해져 있었다. 지금은 조건으로
// 적는다: 분리 브라우저 창에는 이 창의 화면·패널이 없으므로 싣지 않는다.
// WS 를 열기 전에 기다린다. 처리기가 늦게 꽂히면 그 사이에 온 메시지는 아무도 안 받는다.
// 부팅 인자를 한 번만 적는다. 처음 로드할 때와 나중에 켤 때가 같은 연결이어야 한다.
// 갈라 적으면 한쪽만 고쳐져서 "껐다 켜면 다르게 동작한다"가 된다.
function capabilityBootArgs(items) {
  return {
    items,
    // 메모 창에서는 메모가 그 창의 전부이므로, 꺼져 있어도 로드해야 창이 성립한다.
    // 창 자체가 그 기능인 경우는 표에 명시한다. 꺼져 있어도 그 창에서는 로드한다.
    isOn: (id) => {
      const cap = CAPABILITIES.find((c) => c.id === id);
      return (cap && (cap.alwaysIn || []).includes(WINDOW_MODE)) || !featureHidden().has(id);
    },
    ctx: {
      $, esc, wsSend, showToast, browserMode: BROWSER_MODE,
      getWebviewEntries, updateWebviewMeta,
      // 탭 분리가 쓰는 값: 네이티브 브리지, 이 창이 묶인 탭, 화면 재배치.
      // 띠만 다시 그리면 모자란다. 어느 탭이 떨어져 나갔는지가 바뀌면 이 창이 비출 탭도 바뀌는데,
      // 그 판정은 reconcileBrowserMode 안에 있다. 띠만 그리면 칩은 사라지고 화면은 그대로 그
      // 페이지다.
      acHost: window.acHost, boundTab: BOUND_TAB,
      redrawBrowser: () => { if (BROWSER_MODE) reconcileBrowserMode(); else renderBmTabs(); },
      // 뷰어 기능이 쓰는 앱 셸의 DOM·알림·판정. 기능이 직접 import 할 수 있는 것은 넘기지 않는다.
      fileview, filePathBarHtml, isFileLikeKind, showNotice,
      // 그 영역은 뷰어가 만드는 것이라 앱 셸이 미리 참조하지 않는다. 최상위에서 참조하면
      // 아직 만들어지지 않아 null 이 들어간다. 사용하는 시점에 찾는다. 이름을 docxview 로
      // 두지 않는 것은 그것이 뷰어 모듈의 내부 이름이어서, 앱 셸이 같은 이름을 함수로
      // 두면 "남의 사설 상태를 부른다"로 읽히기 때문이다(검사가 잡는다).
      get docxPane() { return $("#docxview"); },
      openBrowserTab: newBrowserTab, setPendingSpaceFocus,
      getCurrentAgent: () => (typeof agentByPane === "function" && typeof curTarget !== "undefined") ? agentByPane(curTarget) : null,
      spaceRootFor,
      getSelectedSpaceId: () => selectedSpaceId,
      getSpaces,
      getLastAgents,
      getCurTarget: terminalCurTarget,
      getProfileChromeSource, autofillBlocked,
      closedTabsForView, reopenClosedTab, uiToken,
      renderTabs, showActiveTab,
      copyText, MEMO_MODE, orderedSpaces, spk, memoReqId,
      cssEsc, forgetTabWc, createWebview, navigateOn,
      openBrowser, consoleSpace, newTabId,
      getIsLocal: () => isLocal, askConfirm,
      // 메모 모듈 집합이 쓰는 값. 이 창의 종류(창 모드·주소 인자)와 편집기 도구를 함께 넘긴다.
      blog, AUX_MODE, bindAgentKeys, storedObjRemap, appParams: APP_PARAMS,
      wsIsOpen: () => !!getWs() && getWs().readyState === 1,
      mdToHtml, ensureMonacoLib, monacoTheme, acHost: window.acHost,
      memoSnapshotState: window.IrisMemoSnapshotState,
    },
    // 영역도 그 기능이 만든다. 연결보다 먼저 붙는다. 소스 제어처럼 init 에서 자기 영역을
    // 찾는 기능이 있어, 순서가 뒤집히면 그 기능만 대상 없이 연결된다.
    onPanel: registerPanel,
    onScreen: registerScreen,
    // 처리기는 현재 표에 그대로 등록한다. ws.js 가 메시지마다 이 객체를 다시 읽는다.
    onWs: (type, fn, id) => {
      // 같은 메시지를 두 기능이 등록하면 나중 것이 덮어쓴다. 먼저 등록한 기능은 그 메시지를
      // 영영 못 받고 아무 말도 없다. 먼저 것을 지키고 나중 것을 거절하며 소리를 낸다.
      if (WS_DISPATCH[type]) { console.error("[capability] 이미 임자가 있는 메시지:", type, "←", id); return false; }
      WS_DISPATCH[type] = dispatchWs(fn);
    },
    onError: (id, e) => { console.error("[capability]", id, e); showToast(`${id} 기능을 싣지 못했습니다`); },
  };
}

// 한 번 실은 것은 다시 싣지 않는다. 끄는 것은 화면에서 내리는 일이지 모듈을 내리는 일이 아니라서,
// 껐다 켠 기능은 이미 연결된 상태로 남아 있다. 이를 확인하지 않고 다시 연결하면 listener 가 두 벌
// 붙고 화면·메시지 등록이 거절당한다(확인 결과: "[rail] 이미 등록된 화면 이름").
const bootedCapabilities = new Set();

for (const id of await bootCapabilities(capabilityBootArgs(CAPABILITIES.filter(livesHere)))) {
  bootedCapabilities.add(id);
}
// 로드된 기능이 가운데 영역을 표에 적어 둔다. 그 영역을 지금 만든다. 그리는 쪽이
// showActiveTab 을 안 거치고 바로 그리는 길이 있어서, 순서에 기대면 그 길이 빈다.
ensureTabViewPanes();

// 켜는 것은 즉시 로드할 수 있다. 아직 로드되지 않은 모듈을 지금 로드하는 것이기 때문이다. 끄는 쪽은
// 한 번 로드한 ESM 을 내릴 수 없어 다음 재로딩을 기다린다.
// 실었으면 true 를 돌려주고, 그 말로 설정 화면이 사람에게 무엇을 말할지 정한다.
async function enableCapabilityNow(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap || !livesHere(cap) || featureHidden().has(id)) return false;
  if (bootedCapabilities.has(id)) return true;   // 이미 로드되어 있다. 화면만 복원하면 된다
  const loaded = await bootCapabilities(capabilityBootArgs([cap]));
  for (const one of loaded) bootedCapabilities.add(one);
  ensureTabViewPanes();
  return loaded.includes(id);
}

initWs({
  url: `ws://${location.host}`,
  onOpen: handleWsOpen,
  onClose: handleWsClose,
  onBinary: handleWsBinary,
  dispatch: WS_DISPATCH,
});
// 실제 herdr 터미널을 로드 즉시 띄운다. 에이전트 선택 전에도 herdr 세션이 보인다.
// ws.onopen에서 startPty()가 붙는다(연결이 이미 열려 있으면 initXterm 내부 startPty가 처리).
// 분리 브라우저 창(browser-mode)은 터미널을 띄우지 않는다. 두 번째 PTY(중복 herdr attach)를 막는다.
if (!AUX_MODE) setTimeout(() => { try { initXterm(); } catch {} }, 0);
// 여기까지 와야 이 파일의 let/const가 전부 초기화된다. 그 뒤에 메모 편집기를 만든다.
