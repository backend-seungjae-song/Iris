// 가운데 탭 화면. tab-store 상태를 파일·브라우저·문서 화면으로 렌더하고 파일 I/O를 연결한다.
//
// 소유 범위
//   가운데 탭 DOM 렌더, 파일 view 전환 owner/token, 파일 탭 생성·복원·감시와 tab I/O·drag snapshot
//   레지스트리, 브라우저 열기·crop 버튼의 최상위 등록.
//
// 제공 API
//   initCenterTabs와 탭 렌더·전환·복원·파일 요청/감시 명령, WebSocket 응답용 레지스트리·settle 명령,
//   현재 file view owner/token 접근자와 외부 파일·표 snapshot 적용 함수.
//
// 의존 대상
//   탭 상태는 center/tab-store에서, browser·sheet·explorer·panel 동작은 각 도메인 모듈에서 import한다.
//   $·esc·wsSend·showToast·BROWSER_MODE 같은 core와 아직 main이 소유하는 docx/webview 렌더 함수,
//   교체되는 ws·generation·런타임 상태는 init에서 값 또는 접근자로 받는다.
//
// 유지 조건
//   file view 선커밋→cleanup→token 교체 순서, listener 등록 순서, 재연결 generation 격리와 파일 감시
//   중복 억제, 파일 탭 id·복원 형식은 그대로 유지한다. browser/tabs의 역호출은 등록 콜백으로만 연결한다.
//
// 영향 범위
//   main의 WebSocket open/close·fs/docx/sheet 응답 분기와 docx 렌더·브라우저 조립,
//   center/{file-routing,tab-close,text-editor,tab-store}, browser/{tabs,state,webview},
//   explorer/tree, panel/{memo,terminal,xterm-wiring}, sheet/{render,edit,actions}의 호출 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/center/tabs.js

import { callHook } from "../core/hooks.js";
import { icon } from "../core/glyphs.js";
import { tabViewOf, tabViews } from "../core/tab-views.js";
import { aiBusyLabels } from "../browser/ai-state.js";
import { renderBookmarks } from "../browser/bookmarks.js";
import { bsMutate, getBrowserState } from "../browser/state.js";
import { syncAiGlow } from "../browser/tabs.js";
import { getWebviewStatus } from "../browser/webview-store.js";
import { cancelPendingReveal, expandedDirs, startPendingReveal } from "../explorer/tree.js";
import { sendPtyResize, terminalBarePathToken } from "../panel/xterm-wiring.js";
import { fitTerminal, getCropEnabled, setCropEnabled } from "../panel/terminal.js";
import { fileKindOf, fileKinds, tabNeedsContent } from "../core/file-kinds.js";
import { initFileRouting, openBrowser } from "./file-routing.js";
import { openFilePalette } from "./file-palette.js";
import { reopenLastClosed } from "./closed-tabs.js";
import { bindingOf, formatBinding, subscribeKeymap } from "../core/keymap.js";
import { getSpaces } from "../herdr/state.js";
import { isTabDirty } from "./tab-close.js";
import {
  addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getCurrentTabs, getTabs,
  getTabSpaces, setActiveTab, setCenterSpace,
} from "./tab-store.js";
import { applyExternalTextToModel, getMonacoModels, renderFileViewBody } from "./text-editor.js";

let $, esc, wsSend, showToast, BROWSER_MODE, isFileLikeKind, acHost;
let tabstrip, centerEmpty, fileview, browserview;
let updateActiveWebview, newBrowserTab;
let agentByPane, getHostHome, getCurTarget, getLastAgents, getSelectedSpaceId;
let spk, spid, getWs, getWsGeneration;

let renderedFileOwner = null;
let renderedFileToken = 0;
let fileViewTokenSeq = 0;
let watchTimer = null, lastWatchKey = "";
const fileWatchRegistry = new Map(); // path → { tabs:Set<space\0tabId> }
export const fileReloadReason = new Map(); // path → "watch" (그 응답을 어떻게 다룰지)
export const tabIoRegistry = new Map(); // requestId → { generation, resolve, reject, timer, path, reason }
const TAB_IO_TIMEOUT_MS = 30000;
let tabIoSeq = 0;

export const curTabs = getCurrentTabs;

export function initCenterTabs(deps) {
  ({ $, esc, wsSend, showToast, BROWSER_MODE, isFileLikeKind, acHost,
    tabstrip, centerEmpty, fileview, browserview,
    updateActiveWebview, newBrowserTab,
    agentByPane, getHostHome, getCurTarget, getLastAgents, getSelectedSpaceId,
    spk, spid, getWs, getWsGeneration } = deps);

  // 머리줄 아이콘은 여기서 넣는다. 이모지는 OS 버전마다 모양·색·크기가 달라 옆 아이콘과 어긋나고,
  // 색이 고정이라 currentColor 로 상태를 나타낼 수 없다(rail 도 같은 이유로 선 아이콘을 쓴다).
  $("#browser-open").innerHTML = icon("globe");
  const sharedBtn = $("#shared-browser-open");
  if (sharedBtn) sharedBtn.innerHTML = icon("globeLink");
  $("#crop-toggle").innerHTML = icon("panelLeft");
  $("#right-collapse").innerHTML = icon("chevronRight");

  // 브라우저 열기 버튼과 crop 배선은 같은 phase에서 이 순서로 등록해야 한다.
  $("#browser-open").addEventListener("click", openBrowser);
  $("#shared-browser-open")?.addEventListener("click", openSharedBrowserFromButton);
  const cropBtn = $("#crop-toggle");
  function syncCropBtn() { cropBtn.classList.toggle("on", getCropEnabled()); }
  syncCropBtn();
  cropBtn.addEventListener("click", () => {
    setCropEnabled(!getCropEnabled());
    localStorage.setItem("ac.crop", getCropEnabled() ? "1" : "0");
    syncCropBtn();
    sendPtyResize();
  });

  initFileRouting({
    $, showToast, acHost, terminalBarePathToken, agentByPane, BROWSER_MODE,
    makeFileTab, requestFileContent, trackFileWatch, renderTabs, showActiveTab, persistFileTabs,
    syncWatchDirs, newBrowserTab,
    getHostHome, getCurTarget, getLastAgents, getSelectedSpaceId,
  });
  wireCenterEmpty();
}

// 열린 탭이 없을 때의 행동 줄. 단축키와 같은 함수를 부르고, 적힌 키는 단축키 표에서 읽는다
// (사용자가 바꾼 키가 그대로 보여야 한다).
function wireCenterEmpty() {
  const acts = { "file-search": openFilePalette, browser: openBrowser, "reopen-tab": reopenLastClosed };
  centerEmpty.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-empty-act]");
    const act = btn && acts[btn.dataset.emptyAct];
    if (act) act();
  });
  const paintKeys = () => {
    for (const el of centerEmpty.querySelectorAll("[data-empty-key]")) {
      el.textContent = formatBinding(bindingOf(el.dataset.emptyKey));
    }
  };
  paintKeys();
  subscribeKeymap(paintKeys);
}

function paintCenterEmptyTitle(spaceId) {
  const el = centerEmpty.querySelector("#center-empty-title"); if (!el) return;
  const s = spaceId ? getSpaces().find((x) => x.id === spaceId) : null;
  el.textContent = s && s.label ? `${s.label}에 열린 탭이 없습니다` : "열린 탭이 없습니다";
}

function openSharedBrowserFromButton() {
  try { acHost && acHost.openSharedBrowser && acHost.openSharedBrowser(); } catch {}
}

export function withFileViewTransition(incoming, options, renderBody) {
  options = options || {};
  if (options.expectedOwner !== undefined && options.expectedOwner !== renderedFileOwner) return false;
  if (options.expectedToken !== undefined && options.expectedToken !== renderedFileToken) return false;
  const outgoing = renderedFileOwner;
  // 나가는 탭은 자기 상태를 스스로 정리한다. 여기서 뷰어의 필드를 직접 다루면 뷰어를 추가할
  // 때마다 이 전환 함수도 고쳐야 한다. 무엇을 유지하고 무엇을 버릴지는 그 편집기를 만든 쪽만 안다.
  if (outgoing) callHook("viewer.leaveTab", outgoing, { force: !!options.forceDocxCleanup });
  if (incoming) callHook("viewer.enterTab", incoming, options);
  const token = ++fileViewTokenSeq;
  renderBody(token);
  renderedFileOwner = incoming && isFileLikeKind(incoming.kind) ? incoming : null;
  renderedFileToken = token;
  return true;
}

export function getRenderedFileOwner() { return renderedFileOwner; }
export function getRenderedFileToken() { return renderedFileToken; }

export function switchCenterSpace(id) {
  if (BROWSER_MODE) return; // 분리창은 콘솔 탭/센터를 렌더하지 않는다(browserview를 숨기지 않도록)
  setCenterSpace(id); ensureTabSpace(id); renderTabs(); showActiveTab(); persistFileTabs();
  if (typeof renderBookmarks === "function") renderBookmarks(); // 스페이스별 북마크 바 갱신
  bsMutate({ op: "space.active", space: id }); // 분리창이 이 스페이스로 미러링(요구3)
}

// 센터(파일/브라우저)는 비어 있어도 공간을 유지한다. 터미널이 전체 폭을 차지하지 않게 하기 위함이다.
// placeholder 표시는 showActiveTab(centerEmpty.hidden)이 소유하고, 여기서는 폭 변화 후 터미널만 다시 맞춘다.
function updateCenterVisibility() {
  setTimeout(() => fitTerminal(), 30);
}

// 탭 이름 인라인 편집(더블클릭). 브라우저 탭에만 쓴다. 커밋 시 onCommit(값), 취소 시 onCommit(null).
// 빈 문자열 커밋 = 커스텀 이름 해제(자동 제목 복귀, 서버 tab.rename이 처리).
export function startTabRename(nameEl, cur, onCommit) {
  if (!nameEl || nameEl.__renaming) return; nameEl.__renaming = true;
  const inp = document.createElement("input");
  inp.className = "ctab-rename-in"; inp.value = cur || ""; inp.maxLength = 60;
  nameEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => { if (done) return; done = true; onCommit(commit ? inp.value.trim() : null); };
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (ev) => ev.stopPropagation());
  inp.addEventListener("mousedown", (ev) => ev.stopPropagation());
  inp.addEventListener("dblclick", (ev) => ev.stopPropagation());
}

// 탭 앞머리 종류 그림과 닫기 그림.
const TAB_KIND = {
  browser: '<svg class="i ckind" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  file: '<svg class="i ckind" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
};
export const TAB_CLOSE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

export function renderTabs() {
  callHook("memo.render"); // 스페이스가 바뀌면 쪽지도 그 스페이스 것으로 (메모를 끄면 아무 일도 없다)
  const centerSpace = getCenterSpace();
  const act = getActiveTabId(centerSpace);
  // 브라우저 탭의 이름은 브라우저 상태가 정본이다. 만들 때 넣은 라벨만 쓰면 제목이 바뀌어도 반영되지 않는다.
  const bmList = (getBrowserState().tabsBySpace || {})[centerSpace] || [];
  const bmName = (id) => { const x = bmList.find((v) => v.id === id); return x ? (x.name || x.title || "브라우저") : null; };
  tabstrip.innerHTML = curTabs().map((t) => {
    const d = isTabDirty(t); // 텍스트·표 어느 쪽이든 안 저장된 편집은 탭에서 바로 보여야 한다
    const label = (t.kind === "browser" && bmName(t.id)) || t.label;
    // 지금 조작 중인 탭만 빛나고 ●가 붙는다. 조작이 끝나면 둘 다 사라진다.
    const busy = t.kind === "browser" ? aiBusyLabels(t.id) : [];
    const ai = busy.length ? `<span class="cai" title="${esc(busy.join(", "))} 세션이 지금 이 탭을 조작 중">●${busy.length > 1 ? busy.length : ""}</span>` : "";
    const status = getWebviewStatus(t.id);
    const sleeping = t.kind === "browser" && !!(status && status.sleeping);
    const sleep = sleeping ? '<span class="csleep" title="메모리를 회수한 잠자는 탭 · 클릭하면 다시 엽니다"></span>' : "";
    const lead = sleeping ? sleep : (t.kind === "browser" ? TAB_KIND.browser : TAB_KIND.file);
    return `<div class="ctab${t.id === act ? " active" : ""}${d ? " dirty" : ""}${busy.length ? " ai-held" : ""}${sleeping ? " sleeping" : ""}" data-tab="${esc(t.id)}" title="${sleeping ? "잠자는 탭 · 클릭하면 다시 엽니다" : ""}">${lead}${d ? '<span class="cdirty" title="저장 안 됨"></span>' : ""}${ai}<span class="cname">${esc(label)}</span><button class="cclose" data-close="${esc(t.id)}" aria-label="탭 닫기">${TAB_CLOSE}</button></div>`;
  }).join("");
  syncAiGlow();
  updateCenterVisibility();
}

export function showActiveTab() {
  if (BROWSER_MODE) return; // 분리창은 browserview를 항상 표시(콘솔 탭 기준으로 숨기지 않음)
  callHook("viewer.closePopups");
  cancelPendingReveal();
  const centerSpace = getCenterSpace();
  const t = curTabs().find((x) => x.id === getActiveTabId(centerSpace));
  withFileViewTransition(t && isFileLikeKind(t.kind) ? t : null, {}, (renderToken) => {
    centerEmpty.hidden = !!t;
    if (!t) paintCenterEmptyTitle(centerSpace);
    fileview.hidden = !(t && t.kind === "file");
    browserview.hidden = !(t && t.kind === "browser");
    // 나머지 화면은 그 종류를 추가한 기능이 표에 등록한다. 로드되지 않은 기능의 화면은 표에
    // 없고, 그 종류의 탭도 없다.
    for (const view of tabViews()) {
      const el = ensureTabViewPane(view); if (el) el.hidden = !(t && t.kind === view.kind);
    }
    if (t && t.kind === "file") { renderFileViewBody(t, renderToken); startPendingReveal(t); }
    else if (t) { const view = tabViewOf(t.kind); if (view && view.render) view.render(t, renderToken); }
    if (typeof updateActiveWebview === "function") updateActiveWebview(); // 활성 브라우저 webview 표시/동기화
  });
  // 탭을 활성화했는데 내용이 없고 진행 중인 요청도 에러도 없으면 요청이 전송되지 않은 것이다
  // (sendTabIo 는 소켓이 열리지 않았을 때 재시도 없이 버린다). 다른 탭에 갔다 오는 것으로는
  // 그사이 답이 이미 와 있을 때만 복구되므로, 여기서 다시 요청한다.
  // 어떤 필드가 비면 아직 받지 못한 것인지는 그 경로를 맡은 기능이 판정하고, 여기서는 요청만 한다.
  if (t && !t._contentInFlight && isFileLikeKind(t.kind) && tabNeedsContent(t.path, t)) {
    requestFileContent(t.path, "open", centerSpace, t.id);
  }
}

// 파일 탭을 만드는 유일한 곳이다. 여는 경로가 둘(직접 열기·재시작 복원)이라 각자 만들게 두면
// 한쪽만 고쳐져 새로 열 때와 재시작 복원 때의 결과가 달라진다.
// docx는 kind:"docx"로 렌더 패널만 다르고(fileview 아닌 docxview), 파일 감시·WS 응답 라우팅·탭
// 복원·닫기 확인·삭제 감지처럼 탭과 파일의 연결을 다루는 인프라는 kind:"file"과 동일하게
// 취급해야 한다. 그러지 않으면 저장이 응답을 찾지 못하거나 재시작 후 탭이 사라진다.
export function makeFileTab(path) {
  // 어떤 확장자가 표이고 문서인지는 이 파일이 판정하지 않고 등록표에 조회한다(core/file-kinds.js).
  const kind = fileKindOf(path);
  // docx는 kind:"docx"로 만들어 fileview 가 아니라 docxview 패널에 표시한다.
  // id 스킴("file:"+path)과 나머지 필드는 그대로 둔다. 파일 감시·WS 응답 라우팅·탭 복원 등
  // 기존 인프라가 이 id로 탭을 찾으므로 바꾸면 그 경로가 모두 깨진다.
  // revision 은 이 내용을 읽은 시점의 디스크 상태다. 저장할 때 그대로 돌려보내면 그사이
  // 외부에서 바뀌었는지 서버가 대조한다(server/fs-handlers.js 의 baselineRevision).
  const tab = { id: "file:" + path, kind: (kind && kind.tabKind) || "file",
    label: path.split("/").pop(), path, content: null, revision: null, hasDiskSnapshot: false };
  // 뷰어가 쓰는 필드는 그 뷰어가 선언한다. 등록된 필드는 모든 파일 탭이 함께 갖는다. 필드의
  // 유무로 탭 정체성 비교(닫기 확인의 지문)가 달라지면 안 되기 때문이다.
  for (const spec of fileKinds()) if (typeof spec.tabFields === "function") Object.assign(tab, spec.tabFields());
  // 그다음 이 경로를 맡은 뷰어의 표시 값을 설정한다.
  if (kind && kind.tabFlags) Object.assign(tab, kind.tabFlags);
  return tab;
}

// 표 파일은 서버가 셀 단위로 해석한 결과를 받는다. fs.read 로 받으면 깨진 텍스트가 된다.
export function requestFileContent(path) {
  const reason = arguments[1] || "open", space = arguments[2], tabId = arguments[3];
  const owner = tabIoOwner(path, space, tabId);
  const tab = getTabs(owner.space).find((t) => t.id === owner.tabId && t.path === path);
  // 무엇을 어떻게 읽는지도 파일 종류가 정하며, 세대 번호 같은 자체 상태도 그쪽에서 처리한다.
  const kind = fileKindOf(path, tab);
  const msg = kind ? kind.read(path, tab) : { type: "fs.read", path };
  const pending = sendTabIo({ ...msg, space: owner.space, tabId: owner.tabId, reason });
  if (tab) { tab._contentInFlight = true; pending.finally(() => { tab._contentInFlight = false; }); }
  pending.catch(() => {});
  return pending;
}

// sendTabIo는 소켓이 열려 있지 않으면 아무것도 보내지 않고 reject 한다(위 pending.catch 가 그
// reject 를 삼킨다). 재시도가 없어서 앱이 막 뜨거나 재연결하는 사이에 파일 탭을 열면 요청이
// 나가지 않고 t.sheet/t.docxData/t.content 가 null 로 남아 화면이 "불러오는 중…"에서 바뀌지
// 않는다. 재연결 시점에 자동으로 다시 요청하는 경로가 없기 때문이다. 브라우저 탭은 재연결마다
// 서버에 다시 보고하므로, 같은 방식을 파일·docx·sheet 탭에도 적용한다.
export function retryStuckFileTabs() {
  for (const sp of getTabSpaces()) {
    for (const t of getTabs(sp)) {
      if (isFileLikeKind(t.kind) && tabNeedsContent(t.path, t)) requestFileContent(t.path, "open", sp, t.id);
    }
  }
}

// 외부 변경이 화면에 반영되도록, 현재 화면이 참조하는 폴더 전부를 서버가 감시하게 한다.
// 열린 파일이 든 폴더(내용 갱신)와 트리에서 펼친 폴더(생성·삭제·이름변경 반영)다.
export function syncWatchDirs() {
  if (watchTimer) return;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    const dirs = new Set();
    for (const sp of getTabSpaces()) {
      for (const t of getTabs(sp)) if (isFileLikeKind(t.kind) && t.path) dirs.add(t.path.slice(0, t.path.lastIndexOf("/")) || "/");
    }
    for (const d of expandedDirs()) dirs.add(d);
    const list = [...dirs].filter(Boolean);
    const key = list.slice().sort().join("\n");
    if (key === lastWatchKey) return;      // 같은 집합을 반복해서 보내지 않는다
    lastWatchKey = key;
    wsSend({ type: "fs.watch", dirs: list });
  }, 150);
}

export function setLastWatchKey(value) { lastWatchKey = value; }

export function trackFileWatch(space, t) {
  if (!space || !t || !t.path) return;
  let entry = fileWatchRegistry.get(t.path);
  if (!entry) { entry = { tabs: new Set() }; fileWatchRegistry.set(t.path, entry); }
  entry.tabs.add(space + "\0" + t.id);
}

export function untrackFileWatch(path, space, tabId) {
  const entry = fileWatchRegistry.get(path);
  if (!entry) return;
  const tabKey = space + "\0" + tabId;
  entry.tabs.delete(tabKey);
  if (!entry.tabs.size) fileWatchRegistry.delete(path);
}

export function tabIoOwner(path, space, tabId) {
  if (space && tabId) return { space, tabId };
  const watched = fileWatchRegistry.get(path);
  if (watched) {
    for (const tabKey of watched.tabs) {
      const splitAt = tabKey.indexOf("\0"), sp = tabKey.slice(0, splitAt), id = tabKey.slice(splitAt + 1);
      if (splitAt >= 0 && getTabs(sp).some((t) => t.id === id && t.path === path)) return { space: sp, tabId: id };
    }
  }
  for (const sp of getTabSpaces()) {
    const t = getTabs(sp).find((x) => isFileLikeKind(x.kind) && x.path === path);
    if (t) return { space: sp, tabId: t.id };
  }
  return { space: space || getCenterSpace() || null, tabId: tabId || "file:" + path };
}

// 가운데 화면은 등록표가 주는 이름으로 만든다. index.html 이 그 div 를 미리 들고 있으면
// 기능 하나가 자기 화면을 추가할 때 앱 셸 문서도 함께 고쳐야 하고, 기능을 끄면 그 영역이
// DOM 에도 남지 않아야 한다는 계약에도 어긋난다. 앱 셸이 소유하는 것은 영역을 담는
// 컨테이너(#center-body)이고, 그 안에 무엇이 들어가는지는 표가 정한다. 이미 있으면 그대로
// 쓴다. 앱 셸 자신의 화면(fileview·docxview)은 index.html 이 갖고 있으며 중복해 만들지 않는다.
export function ensureTabViewPane(view) {
  if (!view || !view.panelId) return null;
  const had = document.getElementById(view.panelId);
  if (had) return had;
  const host = document.getElementById("center-body");
  if (!host) return null;
  const el = document.createElement("div");
  el.className = view.panelId;
  el.id = view.panelId;
  el.hidden = true;
  host.appendChild(el);
  return el;
}

// 기능이 로드된 직후 그 화면들을 한 번에 만든다. 만드는 곳이 showActiveTab 하나뿐이면
// 실행 순서에 의존하게 된다. 부팅 때 showActiveTab 이 먼저 돌면 등록표가 비어 있어 아무
// 화면도 만들어지지 않고, 그 뒤 서버 응답으로 바로 그리는 경로(devtool/diff.js 의 git 응답
// 처리)는 showActiveTab 을 거치지 않아 없는 화면에 그리게 된다.
export function ensureTabViewPanes() {
  for (const view of tabViews()) ensureTabViewPane(view);
}

export function sendTabIo(msg) {
  const requestId = "io" + (++tabIoSeq) + "-" + Date.now();
  const generation = getWsGeneration();
  const full = { ...msg, requestId };
  const socket = getWs();
  const owner = { space: msg.space || null, tabId: msg.tabId || null };
  const tabRef = owner.space ? getTabs(owner.space).find((t) => t.id === owner.tabId) || null : null;
  const pending = new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("소켓이 열려있지 않음")); return; }
    const entry = { generation, resolve, reject, path: msg.path, reason: msg.reason, owner, tabId: owner.tabId, tabRef };
    entry.timer = setTimeout(() => { settleTabIo(requestId, null, new Error("timeout")); }, TAB_IO_TIMEOUT_MS);
    tabIoRegistry.set(requestId, entry);
    try {
      socket.send(JSON.stringify(full));
    } catch (e) {
      settleTabIo(requestId, null, e);
    }
  });
  pending.requestId = requestId;
  return pending;
}

export function tabRejectGenerationIo(generation) {
  for (const [requestId, entry] of [...tabIoRegistry]) {
    if (entry.generation !== generation) continue;
    settleTabIo(requestId, null, new Error("연결 끊김"));
  }
}

export function settleTabIo(requestId, response, error) {
  const entry = tabIoRegistry.get(requestId);
  if (!entry) return;
  tabIoRegistry.delete(requestId);
  clearTimeout(entry.timer);
  if (error) entry.reject(error); else entry.resolve(response);
}

export function requestReload(path) { fileReloadReason.set(path, "watch"); requestFileContent(path, "watch"); }

// 파일이 외부에서 바뀌었을 때 호출된다.
//
// 편집 중이 아니면 내용을 교체하고, 편집 중이면 아무것도 하지 않는다. 편집 내용을 그대로 두고
// 확인도 받지 않으며, VSCode 와 같은 동작이다.
//
// 외부 변경은 t.revision 을 여기서 갱신하지 않는 것으로 드러난다. 저장할 때 이전 기준을
// 보내면 서버가 막고, 그때 한 번 확인을 받는다(text-editor 의 sendFileSave).
export function applyExternalChange(t, next, revision) {
  if (isTabDirty(t)) return;
  t.content = next; t.draft = null;
  if (typeof revision === "string") t.revision = revision;
  // 열려 있는 편집기라면 커서·되돌리기를 유지한 채 교체한다(전체를 다시 그리면 커서가 이동한다).
  const model = getMonacoModels().get(t.path);
  if (model) applyExternalTextToModel(t.path, next);
  const active = t.id === getActiveTabId(getCenterSpace());
  // 텍스트 편집기가 아닌 화면(마크다운 미리보기 등)이 이 탭을 그리고 있으면 모델만 바꿔서는
  // 화면이 갱신되지 않는다. 그 화면은 자기 DOM 을 쓰므로 이때는 다시 그린다.
  if (active && (!model || callHook("mdpreview.presents", t))) showActiveTab();
}

// 재시작 시 파일 탭 유지: 열린 파일 경로(스페이스별)·활성 탭·현재 센터 스페이스를 localStorage에 저장.
export function persistFileTabs() {
  try {
    const out = {};
    for (const sp of getTabSpaces()) {
      // docx/sheet는 여기 담지 않는다. 그 탭들의 정본은 sbState(서버)이고, 도킹·분리 두 창이
      // 같은 localStorage 키를 마지막 쓰기로 덮어써 서로의 저장분을 지울 수 있다.
      // 뷰어가 그리고 있는 탭도 담지 않으며, 그 판정은 뷰어가 한다. 뷰어가 로드되지 않았으면
      // 답이 없고, 그때는 그 파일이 텍스트로 열리므로 담는 것이 맞다.
      const files = getTabs(sp).filter((t) => t.kind === "file" && !callHook("viewer.presentsTab", t)).map((t) => t.path);
      if (files.length) out[spk(sp)] = { files, active: getActiveTabId(sp) || null };
    }
    localStorage.setItem("ac.filetabs", JSON.stringify(out));
    localStorage.setItem("ac.centerspace", spk(getCenterSpace()) || "");
  } catch {}
}

let fileTabsRestored = false;
export function restoreFileTabs() {
  if (fileTabsRestored) return; fileTabsRestored = true;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem("ac.filetabs") || "{}"); } catch {}
  for (const k of Object.keys(saved)) {
    const sp = spid(k);                          // 저장은 폴더 열쇠, 화면은 workspace_id
    ensureTabSpace(sp);
    for (const path of (saved[k].files || [])) {
      if (fileKindOf(path)) continue; // 이전 저장분 방어. 문서 탭의 정본은 sbState 다
      const id = "file:" + path;
      if (!getTabs(sp).find((t) => t.id === id)) {
        const tab = addTab(sp, makeFileTab(path)); requestFileContent(path); trackFileWatch(sp, tab);
      }
    }
    const act = saved[k].active;
    if (act && getTabs(sp).find((t) => t.id === act)) setActiveTab(sp, act);
  }
  const cs = localStorage.getItem("ac.centerspace");
  if (cs && saved[cs]) { setCenterSpace(spid(cs)); renderTabs(); showActiveTab(); }
}
