// 분리 브라우저 창 렌더와 문서 탭 동기화, 콘솔 도킹 전환 및 관련 최상위 연결을 맡는다.
//
// 소유 범위
//   분리창이 마지막으로 쓴 bmSpace, 콘솔의 직전 docked 상태, 도킹/분리 UI·shortcut·브라우저 상태 연결.
//
// 제공 API
//   initDock, 브라우저·문서 탭 reconcile command, 콘솔 dock reconcile command와 toggleDock.
//
// 의존 대상
//   브라우저·센터·문서·메모·단축키 기능은 각 도메인 모듈에서 import하고, main 소유 모드·DOM·
//   URL 판정과 newBrowserTab 조립 함수는 init에서 받는다. docx 그리기·정리는 훅 이름으로 부른다.
//
// 유지 조건
//   서버 browser state가 단일 소스인 점, 닫힌 webview만 회수하는 순서, dirty DOCX detach 보호,
//   문서 전환의 rendered owner 가드, dock 전환 시 webview/WC 정리와 최상위 listener 등록 순서를 보존한다.
//
// 영향 범위
//   main.js의 브라우저 init 위치·shortcut과 browser/{ai-tabs,state,tabs,webview,webview-store,profiles},
//   center/{tabs,tab-close,tab-store,text-editor,file-routing}, panel/{touch-drag,viewport}.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/dock.js

import { initAiTabs } from "./ai-tabs.js";
import { renderBookmarks, renderUrlDatalist, syncBookmarkStar, wireBookmarkBar } from "./bookmarks.js";
import { gotoMainScreen, gotoSpaceBrowser, runSwitcherKey } from "../core/screen-switch.js";
import { profileIdForStored, spaceDefaultProfile, updateProfileBtn } from "./profiles.js";
import {
  bmTabs, boundSpace, bsMutate, getBrowserState, isBrowserStateLoaded,
} from "./state.js";
import { renderBmTabs, syncAiGlow, wireBrowserModeTabstrip } from "./tabs.js";
import {
  createWebview, forgetTabWc, navigateOn, reportActiveBrowserWc,
} from "./webview-factory.js";
import {
  getDiscardedWebview, getDiscardedWebviewIds, getWebview, getWebviewEntries,
  getWebviewIds, removeDiscardedWebview, removeLoadFailure, removeWebview,
  removeWebviewLastUsed, removeWebviewStatus,
} from "./webview-store.js";
import {
  WEBVIEW_LRU, activeBrowserId, activeWv, markWebviewUsed, renderTabDialog, scheduleWebviewThrottling,
  shouldMaterializeTab, sleepDeadSpaceWebviews, sleepStoredTab, wakeWebview,
} from "./webview.js";
import { openFilePalette } from "../center/file-palette.js";
import { findNext, openFind } from "./find-in-page.js";
import { consoleSpace } from "../center/file-routing.js";
import { reopenLastClosed } from "../center/closed-tabs.js";
import { closeActiveTab, closeTabs } from "../center/tab-close.js";
import {
  addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, getTabSpaces,
  removeTab, replaceTabs, setActiveTab, setCenterSpace,
} from "../center/tab-store.js";
import {
  curTabs, ensureTabViewPane, getRenderedFileOwner, makeFileTab, renderTabs, requestFileContent,
  showActiveTab, syncWatchDirs, trackFileWatch, untrackFileWatch, withFileViewTransition,
} from "../center/tabs.js";
import { renderFileViewBody } from "../center/text-editor.js";
import { cycleAgent, cycleCenterTab, cycleSpace, newHerdrTab } from "../core/keynav.js";
import { callHook } from "../core/hooks.js";
import { tabViewOf, tabViews } from "../core/tab-views.js";
import { isFileKindId } from "../core/file-kinds.js";
import { syncTouchDrag, toggleDevTools } from "../panel/touch-drag.js";
import { updateSizeBtn, viewportByTab, viewportLayout } from "../panel/viewport.js";

let $, acHost, BROWSER_MODE, BOUND_SPACE, MEMO_MODE;
let bNote, browserview, fileview, urlInput;
let isFileLikeKind, isNewTab, newBrowserTab;

// 이 값은 여기서 쓰기만 하고 어디서도 읽지 않는다(전수 확인). 지우는 것은 별개 판단이다.
let bmSpace = null;
let consoleDocked = false;

export function initDock(deps) {
  ({
    $, acHost, BROWSER_MODE, BOUND_SPACE, MEMO_MODE,
    bNote, browserview, fileview, urlInput,
    isFileLikeKind, isNewTab, newBrowserTab,
  } = deps);

  // 분리창 탭바는 browser/tabs.js 가 소유한다. 기존 `if (BROWSER_MODE) { … }` 가 있던 위치다.
  if (BROWSER_MODE) {
    document.body.classList.add("browser-mode");
    browserview.hidden = false;
    wireBrowserModeTabstrip();
  }
  // ⇱ 분리(콘솔 헤더): 도킹 해제 + 분리 창 열기.
  $("#wv-detach").addEventListener("click", () => {
    bsMutate({ op: "dock", docked: false });
    if (window.acHost && window.acHost.openBrowser) window.acHost.openBrowser();
  });
  // ⇲ 도킹(분리창 헤더 전용): dock:true → 콘솔이 센터에 브라우저 표시 + 이 분리창 닫기.
  $("#wv-dock").addEventListener("click", () => {
    bsMutate({ op: "dock", docked: true });
    if (window.acHost && window.acHost.dockBrowser) window.acHost.dockBrowser();
  });
  // webview에 포커스가 있을 때(주입 스크립트/브라우저가 키를 삼켜) 콘솔 단축키가 안 먹는 문제를
  // 메인 프로세스가 before-input-event로 가로채 이름으로 전달 → 포커스 무관하게 동작하게 한다.
  if (window.acHost && window.acHost.onShortcut) {
    window.acHost.onShortcut((name) => {
      if (MEMO_MODE) { if (name === "memo-archive") callHook("memo.archiveWindow"); return; }
      const centerSpace = getCenterSpace();
      const t = curTabs().find((x) => x.id === getActiveTabId(centerSpace));
      const isBrowser = t && t.kind === "browser";
      switch (name) {
        // 어느 창에서 왔든 서버가 하나의 상태를 뒤집는다(분리 창 포함).
        case "pick-toggle": callHook("pick.toggle"); break;
        case "detach": toggleDock(); break; // webview 포커스에서 온 ⌘⇧O. 방향은 docked 상태가 정한다
        case "sketch": callHook("sketch.open"); break; // ⌘⇧D. 이 창의 활성 탭을 찍어 그 위에 그린다
        case "rec-toggle": if (activeWv()) callHook("record.set", !callHook("record.on")); break; // ⌘⇧A 녹화 토글. 문서 탭에는 webview가 없다
        case "memo-archive": callHook("memo.archive"); break; // ⌘⇧S. webview에 포커스가 있어도 보관된다
        case "tab-prev": cycleCenterTab(-1); break;
        case "tab-next": cycleCenterTab(1); break;
        case "agent-prev": cycleAgent(-1); break;
        case "agent-next": cycleAgent(1); break;
        case "space-prev": cycleSpace(-1); break;
        case "space-next": cycleSpace(1); break;
        // ⌥Tab/⌥⇧Tab/⌥1/⌥2. webview 포커스에서 왔다. 방향 판정은 screen-switch 가 소유한다.
        case "screen-toggle": runSwitcherKey(1); break;
        case "screen-toggle-back": runSwitcherKey(-1); break;
        case "screen-main": gotoMainScreen(); break;
        case "screen-browser": gotoSpaceBrowser(); break;
        case "new-tab": (isBrowser || BROWSER_MODE) ? newBrowserTab() : newHerdrTab(); break;
        case "close-tab": if (BROWSER_MODE) closeActiveTab(); else if (t) closeTabs([{ space: centerSpace, tabId: t.id, tabRef: t }]); break;
        case "reopen-tab": reopenLastClosed(); break;   // ⌘⇧T. 브라우저·센터 중 더 최근에 닫힌 것
        case "file-search": openFilePalette(); break;
        case "find-in-page": openFind(); break;   // webview 에 포커스가 있을 때의 ⌘F
        case "find-next": findNext(true); break;
        case "find-prev": findNext(false); break;
        case "focus-url": try { urlInput.focus(); urlInput.select(); } catch {} break;
        case "nav-back": { const r = activeWv(); try { if (!callHook("mirror.command", r, "back") && r && r.el.canGoBack()) r.el.goBack(); } catch {} break; }
        case "nav-forward": { const r = activeWv(); try { if (!callHook("mirror.command", r, "forward") && r && r.el.canGoForward()) r.el.goForward(); } catch {} break; }
        case "print-page": { const r = activeWv(); try { if (r) r.el.print(); } catch {} break; }
        case "devtools": toggleDevTools(); break;
        case "reload-tab": { const r = activeWv(); if (callHook("mirror.command", r, "reload")) break;
          try { if (r) r.el.reload(); } catch {} break; }
        case "force-reload-tab": { const r = activeWv(); if (callHook("mirror.command", r, "forceReload")) break;
          try { if (r) r.el.reloadIgnoringCache(); } catch {} break; }
        case "full-refresh": location.reload(); break; // 이 창 전체 새로고침(메인 창이면 main이 브라우저 창도 함께 리로드)
      }
    });
  }

  // 북마크 = 서버 공유 상태(스페이스마다 따로·영속). URL 자동완성 이력은 기기별 localStorage 유지.
  // 두 창 동기화 규율: mutation은 오직 사용자 행동에서만 보내고(bsMutate), 수신(browser-state)은
  // 멱등 렌더만 한다 → 에코가 새 mutation을 안 만들어 무한 트리거가 없다.
  wireBookmarkBar();
  // 서버 브라우저 상태 수신 → 공유 상태 갱신 + 북마크 재렌더. 레거시 profile 이름은 첫 수신에서
  // 안정 id로 정규화하고 로컬 연결만 기존 tab.profile mutation으로 1회 영속화한다.
  initAiTabs({
    BROWSER_MODE, BOUND_SPACE, createWebview, renderTabs, reconcileBrowserMode,
    reconcileDocTabs, reconcileConsoleDock, reportActiveBrowserWc,
  });
  renderBookmarks(); renderUrlDatalist();
}

// ── 분리 브라우저 창(?mode=browser) 렌더 + 도킹/분리 ──────────────────────────
// 브라우저 탭은 서버 공유 상태(sbState)가 단일 소스. 콘솔(도킹)·분리창 모두 이 상태를 렌더한다.
export function reconcileBrowserMode() {
  if (!BROWSER_MODE) return;
  const sp = boundSpace(), tabs = bmTabs();
  // 이 창의 활성 탭이다. 한 탭에 묶인 창에서는 스페이스의 공유 활성 탭이 아니라 그 탭이다.
  // 그러지 않으면 창 둘이 같은 페이지를 표시한다.
  const act = activeBrowserId();
  bmSpace = sp;
  // herdr식 백그라운드 상주: 스페이스 전환 시 webview를 파괴하지 않는다. 어떤 스페이스에도 없는(닫힌)
  // 탭만 제거하고, 비활성 스페이스의 탭 webview는 살려둔 채 숨긴다 → 돌아오면 스크롤·입력·로그인 그대로.
  const allWant = new Set();
  const state = getBrowserState();
  for (const s of Object.keys(state.tabsBySpace || {})) for (const t of (state.tabsBySpace[s] || [])) allWant.add(t.id);
  for (const id of getWebviewIds()) if (!allWant.has(id)) {
    const webview = getWebview(id);
    forgetTabWc(webview, id); try { webview.el.remove(); } catch {}
    removeWebview(id); removeWebviewLastUsed(id); removeWebviewStatus(id); removeLoadFailure(id);
  }
  for (const id of getDiscardedWebviewIds()) if (!allWant.has(id)) { removeDiscardedWebview(id); removeWebviewLastUsed(id); removeWebviewStatus(id); removeLoadFailure(id); }
  sleepDeadSpaceWebviews();   // 접은 스페이스의 탭은 기록만 남기고 내려놓는다
  // 공유(__shared__) 탭은 전용 공유 창(BOUND_SPACE=__shared__)만 호스팅한다. 비결속 창이 "그 탭으로"
  // goto로 activeSpace=__shared__를 따라와 여기서 만들면 같은 탭에 webview가 둘 생긴다(공유 창 + 이 창).
  const hostShared = !BOUND_SPACE && sp === "__shared__";
  for (const t of tabs) { // 현재 스페이스 탭은 방문 시 생성(없으면). 이미 있으면 살려둔 채 재사용.
    if (hostShared) break;
    if (isFileKindId(t.kind)) continue;   // 문서 탭은 webview 가 아니다. 어느 것이 문서인지는 표가 안다
    let rec = getWebview(t.id);
    const wantProfile = t.profile == null ? spaceDefaultProfile(sp) : profileIdForStored(t.profile);
    const mayRepartition = isBrowserStateLoaded() && t.profile != null;
    if (rec && rec.el && mayRepartition && rec.el.dataset.profile !== wantProfile) { forgetTabWc(rec, t.id); try { rec.el.remove(); } catch {} removeWebview(t.id); rec = null; }
    if (!rec) {
      const discarded = getDiscardedWebview(t.id);
      // 크롬처럼, 지금 보고 있는 탭 하나만 실제로 만든다. 나머지는 목록의 한 줄(◌)로만 두고 누를 때
      // 깨운다. 스페이스의 탭 전부를 한꺼번에 만들면 앱을 켜는 순간 저장된 탭 수만큼
      // 크로미움 렌더러가 뜬다. 확인 결과: 탭 84개·스페이스 14개에서 메모리가
      // 부족했다. LRU(유휴 회수)는 생성 이후에 동작하므로 이 구간을 막지 못한다.
      // IRIS_WEBVIEW_LRU=0 으로 재우기를 끈 경우에는 이전처럼 전부 만든다(롤백 스위치 보존).
      if (!shouldMaterializeTab(t.id, act, WEBVIEW_LRU)) { if (!discarded) sleepStoredTab(t.id, t, sp); continue; }
      rec = discarded
        ? wakeWebview(t.id)
        : createWebview(t.id, wantProfile, t.url && t.url !== "about:blank" ? t.url : undefined);
    }
  }
  renderBmTabs();
  for (const [tid, rec] of getWebviewEntries()) rec.el.classList.toggle("active", tid === act);
  callHook("mirror.activeTab", act);
  const active = act && getWebview(act);
  if (active) {
    markWebviewUsed(act);
    urlInput.value = isNewTab(active.url, active) ? "" : (active.url || "");
    syncBookmarkStar();
  }
  bNote.hidden = tabs.length > 0;
  updateProfileBtn();
  updateSizeBtn(); viewportLayout(); syncTouchDrag(false);
  syncAiGlow();
  renderTabDialog();
  reportActiveBrowserWc();
  scheduleWebviewThrottling();
}

// 문서 탭(docx/sheet)은 이 스페이스의 브라우저가 있는 창에서만 로컬 탭 객체로 생성된다.
export function reconcileDocTabs() {
  if (!BROWSER_MODE) return;
  const sp = boundSpace();
  if (!sp) {
    browserview.hidden = false; fileview.hidden = true;
    for (const view of tabViews()) { const el = ensureTabViewPane(view); if (el) el.hidden = true; }
    return;
  }
  ensureTabSpace(sp);
  const state = getBrowserState();
  const entries = ((state.tabsBySpace && state.tabsBySpace[sp]) || []).filter((t) => t && isFileKindId(t.kind));
  const liveIds = new Set(entries.map((e) => e.id));
  // sbState 에서 사라진 문서 탭은 그 뷰어가 자기 것을 정리한다. 무엇이 저장되지 않은 상태이고
  // 무엇을 유지해야 하는지는 그 편집기를 만든 쪽만 안다. 여기서는 "아직 내리지 말라"는
  // 답만 받는다. 뷰어가 로드되지 않았으면 undefined 가 오고, 그때는 문서 탭 자체가 없다.
  for (const t of getTabs(sp).filter((x) => isFileLikeKind(x.kind) && !liveIds.has(x.id))) {
    if (callHook("viewer.dropUnlistedTab", t)) continue;
    if (t.path) untrackFileWatch(t.path, sp, t.id);
    removeTab(sp, t);
  }
  for (const e of entries) {
    if (getTabs(sp).some((t) => t.id === e.id)) continue;
    const tab = makeFileTab(e.path); tab.id = e.id;
    addTab(sp, tab);
    trackFileWatch(sp, tab);
    requestFileContent(e.path, "open", sp, tab.id);
  }
  syncWatchDirs();
  setCenterSpace(sp);
  // 한 탭에 묶인 창은 그 탭 하나가 전부다. 스페이스의 공유 활성 탭이 문서 탭이면 그 창까지
  // 브라우저를 닫고 문서를 띄우게 되어, 자기 탭이 아닌 것을 표시한다.
  const boundTab = callHook("detach.boundTab") || null;
  const activeId = boundTab ? null : ((state.activeBySpace && state.activeBySpace[sp]) || null);
  const activeTab = activeId ? getTabs(sp).find((t) => t.id === activeId) : null;
  if (activeTab) {
    setActiveTab(sp, activeId);
    browserview.hidden = true;
    if (getRenderedFileOwner() !== activeTab) {
      withFileViewTransition(activeTab, {}, (renderToken) => {
        fileview.hidden = activeTab.kind !== "file";
        for (const view of tabViews()) {
          const el = ensureTabViewPane(view); if (el) el.hidden = activeTab.kind !== view.kind;
        }
        if (activeTab.kind === "file") renderFileViewBody(activeTab, renderToken);
        else { const view = tabViewOf(activeTab.kind); if (view && view.render) view.render(activeTab, renderToken); }
      });
    }
  } else {
    browserview.hidden = false;
    if (getRenderedFileOwner()) withFileViewTransition(null, {}, () => {});
    fileview.hidden = true;
    for (const view of tabViews()) { const el = ensureTabViewPane(view); if (el) el.hidden = true; }
  }
}

// 콘솔(도킹) 렌더: docked 상태 전환을 반영한다.
export function reconcileConsoleDock() {
  if (BROWSER_MODE) return;
  const state = getBrowserState();
  const nowDocked = !!state.docked;
  if (nowDocked && !consoleDocked) {
    const sp = boundSpace() || consoleSpace();
    const stabs = (state.tabsBySpace && state.tabsBySpace[sp]) || [];
    ensureTabSpace(sp);
    setCenterSpace(sp);
    for (const st of stabs) {
      if (!getTabs(sp).find((t) => t.id === st.id)) {
        addTab(sp, { id: st.id, kind: "browser", label: st.title || "브라우저", path: null });
        const rec = createWebview(st.id);
        if (st.url && st.url !== "about:blank") navigateOn(rec, st.url);
      }
    }
    const act = (state.activeBySpace && state.activeBySpace[sp]) || (stabs[0] && stabs[0].id);
    if (act) setActiveTab(sp, act);
    renderTabs(); showActiveTab();
  } else if (!nowDocked && consoleDocked) {
    for (const sp of getTabSpaces()) {
      for (const t of getTabs(sp).filter((x) => x.kind === "browser")) {
        const webview = getWebview(t.id);
        if (webview) {
          forgetTabWc(webview, t.id);
          delete viewportByTab[t.id]; try { webview.el.remove(); } catch {} removeWebview(t.id);
        }
        removeDiscardedWebview(t.id); removeWebviewLastUsed(t.id); removeWebviewStatus(t.id);
      }
      const remaining = replaceTabs(sp, getTabs(sp).filter((x) => x.kind !== "browser"));
      const activeId = getActiveTabId(sp);
      if (activeId && !remaining.find((t) => t.id === activeId))
        setActiveTab(sp, remaining.length ? remaining[remaining.length - 1].id : null);
    }
    renderTabs(); showActiveTab();
    scheduleWebviewThrottling();
  }
  consoleDocked = nowDocked;
}

// 스페이스 브라우저의 분리/도킹 토글. 방향은 서버의 docked 상태 하나로 결정한다.
export function toggleDock() {
  if (BOUND_SPACE) { bNote.textContent = "공유 브라우저 창은 도킹 대상이 아닙니다."; return; }
  if (getBrowserState().docked) {
    bsMutate({ op: "dock", docked: false });
    try { window.acHost && acHost.openBrowser && acHost.openBrowser(); } catch {}
  } else {
    bsMutate({ op: "dock", docked: true });
    try { window.acHost && acHost.dockBrowser && acHost.dockBrowser(); } catch {}
  }
}
