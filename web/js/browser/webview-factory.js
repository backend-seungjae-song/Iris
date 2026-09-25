// 브라우저 탭의 <webview> 생성·이벤트 배선·탐색과 webContents 보고 경계를 맡는다.
//
// 소유 범위
//   webview DOM 생성과 탭별 20여 이벤트 배선, 탐색 command, 탭/활성 webContents 보고·해제.
//
// 제공 API
//   initWebviewFactory, 자동완성 차단 query, 생성·탐색·활성화 command와 탭/활성 WC 보고 command.
//
// 의존 대상
//   탭 레지스트리는 browser/webview-store, LRU·대화상자·활성 query는 browser/webview에서 import한다.
//   profile·기록·pick·탭 렌더·viewport도 각 도메인에서 import하고, main 소유 모드·전송·DOM/core는 init에서 받는다.
//
// 유지 조건
//   tabId 0·빈 문자열을 포함한 getAiBusyTabs 판정, iframe did-navigate-in-page 조기 반환,
//   webview 이벤트 등록·보고 순서와 dom-ready 이후에만 유효한 WC 보고 조건을 보존한다.
//
// 영향 범위
//   main.js의 browser init·탭 생성/전환·WebSocket 재보고, browser/{webview,webview-store,profiles,tabs,
//   record,pick,bookmarks,ai-tabs}, center/{tabs,tab-close}, panel/{touch-drag,viewport},
//   native/electron/webview-preload.cjs IPC와 서버 browser-tab-wc/browser-active-wc 레지스트리 계약.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/webview-factory.js

import { beginNavigation, endNavigation, failNavigation, navigationDisplay } from "./navigation-feedback.js";
import { getAiBusyTabs } from "./ai-state.js";
import { callHook } from "../core/hooks.js";
import { pushHistory, syncBookmarkStar } from "./bookmarks.js";
import { findRetarget } from "./find-in-page.js";
import {
  closeProfileMenu, partitionFor, profileIdForStored, profileOfTab, updateProfileBtn,
} from "./profiles.js";
import { boundSpace, bsMutate, getBrowserState } from "./state.js";
import { renderBmTabs, syncAiGlow } from "./tabs.js";
import {
  getLoadFailure, getWebview, getWebviewEntries, getWebviewStatus, recordWebviewUse,
  registerWebview, removeDiscardedWebview, removeLoadFailure, setLoadFailure,
} from "./webview-store.js";
import {
  activeBrowserId, activeWv, markWebviewUsed, normalizeUrl, renderTabDialog,
  scheduleWebviewThrottling, setTabStatus, syncNavButtons, wakeWebview,
} from "./webview.js";
import { takeReopenedBrowserHistory } from "../center/closed-tabs.js";
import { consoleSpace, openDroppedLocal } from "../center/file-routing.js";
import { openDroppedEntries } from "../center/file-drop.js";
import { getCenterSpace } from "../center/tab-store.js";
import { curTabs, renderTabs } from "../center/tabs.js";
import { hideCtxMenu } from "../explorer/context-menu.js";
import { injectPick, syncTouchDrag } from "../panel/touch-drag.js";
import { updateSizeBtn, viewportByTab, viewportLayout } from "../panel/viewport.js";

let wsSend, BROWSER_MODE, BOUND_SPACE, bNote, urlInput, wvStack, isNewTab, showToast, blog, acHost;

export function initWebviewFactory(deps) {
  ({
    wsSend, BROWSER_MODE, BOUND_SPACE, bNote, urlInput, wvStack, isNewTab, showToast, blog, acHost,
  } = deps);
}

function showNavigationFeedback(rec) {
  if (!rec || activeBrowserId() !== rec.tabId) return;
  const { url, note } = navigationDisplay(rec);
  if (document.activeElement !== urlInput) urlInput.value = isNewTab(url, rec) ? "" : url;
  if (getLoadFailure(rec.tabId)) bNote.textContent = getLoadFailure(rec.tabId);
  else if (note || rec.navigationNote === bNote.textContent) bNote.textContent = note;
  rec.navigationNote = note;
}

// 자동완성 차단 판정: AI가 "지금 조작 중"(control-active)일 때만 차단.
// AI가 한 번 조작한 탭을 영구 차단하면 일상 사용에서 자동완성이 뜨지 않는 불편이 커서,
// 조작 순간 차단 + 게스트 isTrusted 게이트로 완화했다. (CDP 조작은 매번 control-active를 켜므로 여전히 커버.)
// 글로우 클래스를 이 판정에 재사용하지 않는다. ai-controlling은 "지금 보고 있는 탭이
// 조작 대상인가"라는 화면 표시이고, 보는 위치에 따라 꺼진다. 차단이 보는 위치를
// 따라가면 안 된다. 판정 기준은 "명령이 실제로 흐르는 중"(ai-busy)이다.
// 판정은 탭 단위다. 서버는 어느 탭을 누가 조작하는지 탭별로 보내준다(aiBusyTabs). 그것을
// 받고도 창 전체에 걸린 .ai-busy 클래스 하나로 판정하면, 다른 스페이스나 공유
// 브라우저에서 명령 하나만 흘러도 모든 탭의 저장된 로그인 창이 함께 막힌다. 막을 이유는 그 탭이
// 조작당하는 중일 때뿐이다.
// tabId 를 모르면 창 기준으로 판정한다. 모르는 채 여는 것보다 막는 쪽이 안전하다.
export function autofillBlocked(tabId) {
  if (tabId != null) return getAiBusyTabs().has(tabId);
  return document.body.classList.contains("ai-busy");
}

export function createWebview(tabId, profileOverride, initialUrl) {
  if (getWebview(tabId)) return getWebview(tabId);
  removeDiscardedWebview(tabId);
  const reopenedHistory = takeReopenedBrowserHistory(tabId);
  const el = document.createElement("webview");
  // 탭별 구글 프로필 = 탭별 세션 파티션. "기본"은 기존 persist:acbrowser(하위호환·공유), 그 외는
  // persist:acprof:<stable-id> 독립 세션이다. 빈 기본 id도 명시 override일 수 있어 undefined만 구분한다.
  const profileId = profileOverride === undefined ? profileOfTab(tabId) : profileIdForStored(profileOverride);
  const part = partitionFor(profileId);
  try { if (window.acHost && acHost.ensureProfile) acHost.ensureProfile(part); } catch {} // main이 이 파티션 세션 하드닝(UA/Client Hints)
  el.setAttribute("partition", part);
  let historyStage = null;
  if (reopenedHistory) {
    try { historyStage = acHost.browserHistoryStage(reopenedHistory); } catch {}
  }
  const historyFallbackUrl = initialUrl || reopenedHistory?.entries?.[reopenedHistory.index]?.url || "about:blank";
  let historyToken = historyStage?.ok === true ? historyStage.token : null;
  // about:blank로 띄운 뒤 dom-ready에서 loadURL 하면 이동이 한 박자 늦게 끝난다. 그 늦은 did-navigate가
  // 주소창을 덮어써서 사용자가 방금 붙여넣은 값이 사라지므로, 처음부터 목적지로 띄운다.
  // 닫은 탭 복원은 marker를 먼저 붙인다. main의 will-attach가 src를 비운 뒤 최초 load 전에 history를
  // 넣고, marker 자체는 실제 네트워크/탐색 대상으로 쓰이지 않는다.
  el.setAttribute("allowpopups", ""); el.setAttribute("src", historyToken ? historyStage.src : historyFallbackUrl); el.dataset.tab = tabId; el.dataset.profile = profileId;
  const rec = { el, tabId, ready: false, pending: null, url: "", title: "" };  // tabId 를 들고 다녀야 상태 판정이 탭에 붙는다
  let historyRestoring = false;
  let historyResultPromise = null;
  if (historyToken) {
    // Electron의 did-attach는 첫 페이지 dom-ready보다 먼저 온다. 여기서 main의 복원 결과를 기다리기
    // 시작해야 restore 실패로 문서가 하나도 생기지 않은 경우도 main fallback과 함께 빠져나온다.
    el.addEventListener("did-attach", () => {
      if (historyResultPromise || !historyToken) return;
      historyRestoring = true;
      historyResultPromise = Promise.resolve(acHost.browserHistoryFinish(historyToken))
        .catch(() => ({ ok: false, fallbackLoaded: false }));
    }, { once: true });
  }
  wvStack.appendChild(el);
  if (reopenedHistory && initialUrl) rec.url = initialUrl;
  if (initialUrl) beginNavigation(rec, initialUrl);
  registerWebview(tabId, rec);
  recordWebviewUse(tabId, Date.now());
  const status = getWebviewStatus(tabId);
  if (status && status.sleeping) status.sleeping = false;
  // 탭 앞머리 표시(크롬과 같은 자리): 파비콘·불러오는 중·소리.
  el.addEventListener("page-favicon-updated", (e) => {
    const ic = (e.favicons || []).find((u) => /^https?:|^data:/i.test(u));
    if (ic) setTabStatus(tabId, { icon: ic });
  });
  el.addEventListener("did-start-loading", () => setTabStatus(tabId, { loading: true }));
  el.addEventListener("did-stop-loading", () => setTabStatus(tabId, { loading: false }));
  // 다른 사이트로 가면 이전 파비콘이 남아 잘못된 아이콘이 붙으므로, 이동 시작 때 지운다.
  el.addEventListener("did-start-navigation", (e) => { if (!e.isMainFrame) return;
    if ((historyToken || historyRestoring) && e.url === "about:blank") return;
    setTabStatus(tabId, { icon: "" });
    beginNavigation(rec, e.url);
    // 새로 가는 중이면 이전 실패 문구는 사실이 아니다. 지우지 않으면 성공한 화면 위에
    // "로드 실패"가 그대로 남는다.
    if (getLoadFailure(tabId)) { removeLoadFailure(tabId);
      if (activeBrowserId() === tabId && bNote.textContent && /로드 실패|인증서 문제/.test(bNote.textContent)) bNote.textContent = ""; }
    showNavigationFeedback(rec);
    callHook("challenge.navigation", rec, { phase: "start", url: e.url, isMainFrame: true });
    if (callHook("mirror.navigation", rec, { phase: "start", url: e.url, isMainFrame: true }) === true) reportTabWc(rec, tabId);
  });
  el.addEventListener("did-redirect-navigation", (e) => {
    if (!e.isMainFrame) return;
    beginNavigation(rec, e.url);
    showNavigationFeedback(rec);
  });
  const reportMedia = (event) => {
    try {
      if (window.acHost && acHost.audioMediaEvent) acHost.audioMediaEvent(event, tabId, el.getWebContentsId());
    } catch {}
  };
  el.addEventListener("media-started-playing", () => { setTabStatus(tabId, { audible: true }); reportMedia("started"); });
  el.addEventListener("media-paused", () => { setTabStatus(tabId, { audible: false }); reportMedia("paused"); });
  el.addEventListener("dom-ready", async () => {
    if (historyRestoring && !historyResultPromise) return;
    if (historyToken) {
      const token = historyToken;
      if (!historyResultPromise) {
        historyRestoring = true;
        historyResultPromise = Promise.resolve(acHost.browserHistoryFinish(token))
          .catch(() => ({ ok: false, fallbackLoaded: false }));
      }
      const pendingResult = historyResultPromise;
      historyResultPromise = null;
      const result = await pendingResult;
      historyToken = null;
      historyRestoring = false;
      if (getWebview(tabId) !== rec) return;
      if (result?.ok !== true && result?.fallbackLoaded !== true && !rec.pending) rec.pending = historyFallbackUrl;
    } else if (historyRestoring) {
      return;
    }
    rec.ready = true;
    if (rec.pending) { const u = rec.pending; rec.pending = null; navigateOn(rec, u); }
    if (callHook("pick.mode") && activeBrowserId() === tabId) injectPick(el);
    if (callHook("record.on")) callHook("record.inject", el, true); // 녹화 중 새로 뜬 탭도 기록 대상
    reportTabWc(rec, tabId);                                  // 탭별 wc 등록(세션 고정·탭 목록의 소스)
    if (activeBrowserId() === tabId) reportActiveBrowserWc(); // CDP 제어 대상 wc 보고(attach 후 유효)
    scheduleWebviewThrottling();
  });
  el.addEventListener("did-navigate", (e) => {
    if ((historyToken || historyRestoring) && e.url === "about:blank") return;
    callHook("challenge.navigation", rec, { phase: "commit", url: e.url, isMainFrame: true });
    const mirrored = callHook("mirror.navigation", rec, { phase: "commit", url: e.url, isMainFrame: true }) === true;
    if (mirrored) { reportTabWc(rec, tabId); return; }
    rec.url = e.url; reportTabWc(rec, tabId);
    refreshChromeSession(tabId, e.url);
    // 복구 중이면 이 첫 이동은 앱이 일으킨 것이므로 기록에 넣지 않는다.
    if (rec.restoring) { rec.restoring = false; } else if (callHook("record.tracked", tabId)) callHook("record.push", { k: "nav", url: e.url });
    if (callHook("record.tracked", tabId)) callHook("record.inject", el, true); // 페이지가 바뀌면 기록기를 다시 심는다(새 문서엔 주입이 안 남는다)
    rec.navs = (rec.navs || 0) + 1; // 첫 이동 = 새 탭이 기본 페이지를 여는 것
    // 주소창을 편집 중이면 건드리지 않는다. 그러지 않으면 붙여넣던 값이 이동 완료 시점에 지워진다.
    if (activeBrowserId() === tabId && document.activeElement !== urlInput) { urlInput.value = isNewTab(e.url, rec) ? "" : (e.url || ""); syncBookmarkStar(); }
    if (activeBrowserId() === tabId) syncNavButtons();
    pushHistory(e.url);
    const navSp = spaceOfTabId(tabId) || (BROWSER_MODE ? boundSpace() : getCenterSpace()); if (navSp) bsMutate({ op: "tab.navigate", space: navSp, id: tabId, url: e.url }); }); // 서버 반영(멱등 가드)
  // SPA 라우팅. Vue/React 화면 전환은 여기로만 온다.
  //
  // 이 이벤트는 iframe 안 이동에서도 뜬다. <webview> DOM 이벤트는 url·isMainFrame 을 인자가 아니라
  // 이벤트 객체의 속성으로 준다(webContents 쪽 시그니처와 다르다). `(e, url, isMainFrame)` 로
  // 받으면 두 값이 undefined 가 되어 프레임 판별이 동작하지 않는다. 그러면 결제창 iframe 이
  // 해시나 replaceState 로 움직이는 순간 그 주소가 이 탭의 주소로 덮인다. 탭의 주소는 최상위 문서의 것만이다.
  el.addEventListener("did-navigate-in-page", (e) => {
    if (e.isMainFrame === false) return;
    rec.url = e.url;
    if (activeBrowserId() === tabId && document.activeElement !== urlInput) urlInput.value = isNewTab(e.url, rec) ? "" : (e.url || "");
    if (activeBrowserId() === tabId) syncNavButtons();
    if (callHook("record.tracked", tabId)) callHook("record.push", { k: "nav", url: e.url, spa: true });
  });
  // 로드가 끝난 시점의 주소·제목을 한 번 더 보고한다. did-navigate가 안 오는 이동(about:blank 등)이
  // 있어 그것만 쓰면 탭 목록이 실제와 어긋난 채 남는다. AI는 그 목록을 보고 어느 탭인지 정한다.
  // 미러 탭은 backend URL(mirror.tabUrl)을 정본으로 쓰고, 그때는 webview 제목으로 덮지 않는다.
  el.addEventListener("did-stop-loading", () => {
    if (historyToken || historyRestoring) return;
    if (callHook("record.tracked", tabId)) callHook("record.push", { k: "load", url: rec.url || "" });
    try {
      const mirrorUrl = callHook("mirror.tabUrl", tabId) || "";
      const u = mirrorUrl || el.getURL();
      if (u && u !== rec.url && rec.navigationState !== "failed") rec.url = u;
      endNavigation(rec, u);
      showNavigationFeedback(rec);
      if (!mirrorUrl) rec.title = el.getTitle() || rec.title;
      reportTabWc(rec, tabId);
    } catch (e) {}
    callHook("mirror.loadSettled", tabId);
  });
  // 로드 실패 표시는 세 가지를 구분한다.
  // (1) 주 문서인가. 광고·위젯 iframe 하나가 실패해도 탭 전체가 "로드 실패"로 보이면 안 된다.
  //     페이지는 정상적으로 떠 있으므로 그 문구는 잘못된 안내가 된다.
  // (2) 인증서 문제인가. 일반 네트워크 오류와 원인도 대처도 다르다. TLS 오류 코드는 -200 대역이다.
  // (3) 언제 지우는가. 새 이동이 시작되면 이전 실패 문구는 사실이 아니다.
  el.addEventListener("did-fail-load", (e) => {
    if (e.errorCode === -3) {
      if (e.isMainFrame !== false && failNavigation(rec, e.validatedURL, true)) showNavigationFeedback(rec);
      return;
    }
    blog("did-fail-load", e.errorCode, e.errorDescription, e.isMainFrame === false ? "(하위 프레임)" : "");
    if (e.isMainFrame === false) return;                  // 페이지 안의 프레임 하나이며 탭의 상태가 아니다
    if (!failNavigation(rec, e.validatedURL)) return;
    const cert = e.errorCode <= -200 && e.errorCode > -300;
    const failure = (cert ? "인증서 문제로 열지 못했습니다: " : "로드 실패: ")
      + (e.errorDescription || e.errorCode) + (cert ? ". 이 사이트의 증명서를 확인할 수 없습니다." : "");
    setLoadFailure(tabId, failure);
    showNavigationFeedback(rec);
  });
  el.addEventListener("page-title-updated", (e) => { if (callHook("mirror.tabUrl", tabId)) return; rec.title = e.title || ""; reportTabWc(rec, tabId); const tab = curTabs().find((x) => x.id === tabId);
    const navSpName = spaceOfTabId(tabId) || (BROWSER_MODE ? boundSpace() : getCenterSpace());
    const state = getBrowserState();
    const hasCustom = !!((state.tabsBySpace && state.tabsBySpace[navSpName] || []).find((x) => x.id === tabId && x.name)); // 커스텀 이름이 있으면 페이지 제목으로 덮지 않음
    if (tab && !hasCustom) { tab.label = e.title ? e.title.slice(0, 22) : "브라우저"; renderTabs(); }
    const navSp = navSpName; if (navSp) bsMutate({ op: "tab.navigate", space: navSp, id: tabId, title: e.title || "" }); if (BROWSER_MODE) renderBmTabs(); });
  // 요소 선택 결과: webview preload가 sendToHost('orca-pick', pick)로 보낸다(안정 IPC 채널).
  el.addEventListener("ipc-message", async (e) => {
    if (e.channel === "ac-file-drop") {
      openDroppedEntries(e.args?.[0], openDroppedLocal, showToast); return;
    }
    if (e.channel === "orca-pick") {
      const pick = e.args && e.args[0]; if (!pick) return;
      callHook("pick.deliver", pick, tabId); return;   // 어느 탭에서 고른 것인지 함께 보낸다. 문구에 그 탭 이름이 들어간다
    }
    // 페이지 안 클릭 → 호스트 오버레이(프로필 메뉴·컨텍스트 메뉴) 닫기. webview 내부 클릭은
    // 호스트 document 이벤트로 오지 않으므로 이 릴레이가 유일한 신호다.
    if (e.channel === "ac-rec") { // 녹화 이벤트. 어느 탭에서 발생했는지 함께 남긴다(재현 대상 지목용)
      if (!callHook("record.tracked", tabId)) return;   // 녹화 대상이 아닌 탭의 조작은 이 기록에 섞지 않는다
      const ev = e.args && e.args[0] ? { ...e.args[0] } : {};
      ev.wc = rec.wc || null; ev.tabUrl = rec.url || ""; ev.tabTitle = rec.title || "";
      callHook("record.push", ev); return;
    }
    if (e.channel === "ac-user-activity") { markWebviewUsed(tabId); return; }
    if (e.channel === "ac-guest-pointerdown") { closeProfileMenu(); if (typeof hideCtxMenu === "function") hideCtxMenu(); return; }
    // 패스키·보안키 상태를 알리고, 네이티브 인증기가 없는 실행 환경에는 Chrome 경로를 제공한다.
    if (e.channel === "ac-webauthn") { callHook("handoff.webauthnNotice", e.args && e.args[0], rec && rec.url, part, el, rec); return; }
    // 사람 확인(Cloudflare Turnstile). 이 창은 통과할 수 없다. 확인 근거는 browser-hardening.cjs.
    if (e.channel === "ac-botcheck") { callHook("handoff.botCheckNotice", e.args && e.args[0], rec); return; }
    // 자체 자동완성(보안): 목록은 아이디만, 비번은 선택 시 1개만.
    //  - AI 조작 중(control-active)엔 전달 거부.
    if (e.channel === "ac-autofill-request") {
      const req = e.args && e.args[0]; if (!req || !req.origin || !window.acHost || !acHost.getCreds) return;
      if (autofillBlocked(tabId)) { el.send("ac-autofill-response", { origin: req.origin, frameId: req.frameId, accounts: [] }); return; }
      try {
        const creds = await acHost.getCreds(part, req.origin);
        rec.autofill = { origin: req.origin, creds: creds || [] }; // 아이디만 받는다. main이 비번을 빼고 준다
        // 각 계정이 AI에게 열려 있는지도 함께 보낸다. 로그인하는 자리에서 켜고 끌 수 있어야
        // 관리 페이지까지 찾아가지 않는다. 게스트엔 여전히 아이디와 이 불리언뿐이다.
        let allow = [];
        try { const inv = (window.acHost && acHost.aiLoginList) ? await acHost.aiLoginList() : [];
              allow = (creds || []).map((c) => inv.some((x) => x.origin === req.origin && x.username === c.username && x.allowed)); } catch {}
        el.send("ac-autofill-response", { origin: req.origin, frameId: req.frameId,
          accounts: (creds || []).map((c, i) => ({ i, username: c.username, ai: !!allow[i] })) }); // 게스트엔 아이디만
      } catch {}
    }
    // 드롭다운의 AI 스위치. 게스트가 스스로 권한을 만들 수는 없다. 아이디는 이쪽 캐시에서 꺼내 쓰고,
    // 실제 기록은 신뢰 렌더러가 main에 요청한다. 게스트가 보내는 것은 "몇 번째를 켜/꺼" 뿐이다.
    if (e.channel === "ac-ai-allow") {
      const req = e.args && e.args[0]; if (!req || !rec.autofill || req.origin !== rec.autofill.origin) return;
      const c = rec.autofill.creds[req.i]; if (!c || !window.acHost || !acHost.aiLoginSet) return;
      try {
        await acHost.aiLoginSet(req.origin, c.username, !!req.allow);
        el.send("ac-ai-allow-response", { origin: req.origin, frameId: req.frameId, i: req.i, allow: !!req.allow });
        if (document.body.classList.contains("af-active")) callHook("autofill.refresh");
        showToast(`${c.username}: AI 로그인 ${req.allow ? "허용" : "잠금"}`);
      } catch {}
    }
    // 이 브라우저에서 새로 로그인한 것을 수집했다. 여기서 바로 저장하지 않고, 저장 여부는 사용자가
    // 막대에서 정한다. AI가 이 탭을 조작하는 중이면 그 값은 사람이 친 것이 아니므로 버린다.
    if (e.channel === "ac-login-captured") {
      const cap = e.args && e.args[0];
      if (!cap || !cap.origin) return;
      if (autofillBlocked(tabId)) return;
      try { await callHook("savelogin.offer", cap, tabId, part); } catch {}
    }
    if (e.channel === "ac-autofill-fill") {
      const req = e.args && e.args[0]; if (!req || !rec.autofill || req.origin !== rec.autofill.origin) return;
      if (autofillBlocked(tabId)) return; // 이 탭이 조작당하는 중이면 비번 미전달(자동수확 차단)
      const c = rec.autofill.creds[req.i]; if (!c) return;
      // 비번은 여기서 처음 꺼낸다. main이 파티션·origin·아이디를 다시 확인하고 하나만 준다.
      // 렌더러에는 남기지 않는다(캐시하면 탭이 사는 내내 메모리에 머문다).
      let password = "";
      try { password = (acHost.credsPassword ? await acHost.credsPassword(part, req.origin, c.username) : "") || ""; } catch {}
      if (!password) return;
      el.send("ac-autofill-fill-response", { origin: req.origin, frameId: req.frameId, i: req.i, username: c.username, password });
    }
  });
  return rec;
}

export function navigateOn(rec, u) {
  if (!u || !rec) return;
  beginNavigation(rec, u);
  showNavigationFeedback(rec);
  if (!rec.ready) { rec.pending = u; return; }
  Promise.resolve().then(() => rec.el.loadURL(u)).catch((err) => blog("loadURL err", String(err && err.message || err)));
}

export function navigate(u) { const rec = activeWv(); if (!rec) { bNote.textContent = "브라우저 탭을 먼저 열어주세요."; return; } bNote.textContent = "여는 중… " + u; navigateOn(rec, u); }
export function goUrl() { navigate(normalizeUrl(urlInput.value)); }

// 정상 세션을 보존할지는 native의 출처 기록이 판단한다. 화면은 실제 적용 성공 뒤에만 갱신한다.
const stagedChromeRecoveryNotices = new Set();
function refreshChromeSession(tabId, url) {
  if (!acHost || !acHost.refreshChromeCookies || !/^https?:/.test(url || "")) return;
  const rec = getWebview(tabId);
  if (!rec || rec.chromeRecoveryPending) return;
  const partition = partitionFor(profileOfTab(tabId));
  rec.chromeRecoveryPending = true;
  Promise.resolve(acHost.refreshChromeCookies(partition, url)).then(result => {
    if (!result || !result.ok) return;
    if (getWebview(tabId) !== rec || rec.url !== url) return;
    if (result.staged > 0) {
      if (activeBrowserId() === tabId && !stagedChromeRecoveryNotices.has(partition)) {
        stagedChromeRecoveryNotices.add(partition);
        showToast("Chrome 로그인 복구를 준비했습니다. Iris를 다시 시작하면 적용됩니다.");
      }
      return;
    }
    if (!result.changed || !result.refreshed) return;
    stagedChromeRecoveryNotices.delete(partition);
    if (result.reason === "login-recovery") navigateOn(rec, url);
    else if (activeBrowserId() === tabId) showToast("Chrome 로그인을 갱신했습니다. 새로고침하면 적용됩니다.");
  }).catch(() => {}).finally(() => {
    rec.chromeRecoveryPending = false;
    if (getWebview(tabId) === rec && rec.url !== url) refreshChromeSession(tabId, rec.url);
  });
}


// 활성 webview를 화면에 표시(나머지 숨김) + 주소창 동기화. showActiveTab에서 호출.
export function updateActiveWebview() {
  const id = activeBrowserId();
  findRetarget();   // 이전 탭의 노란 강조와 개수를 지운다. 지우지 않으면 다른 페이지 위에 남아 잘못된 값을 표시한다
  if (id && !getWebview(id)) wakeWebview(id);
  for (const [tid, rec] of getWebviewEntries()) rec.el.classList.toggle("active", tid === id);
  callHook("mirror.activeTab", id);
  const active = id && getWebview(id);
  if (active) {
    markWebviewUsed(id);
    refreshChromeSession(id, active.url);
    showNavigationFeedback(active);
    syncBookmarkStar(); if (callHook("pick.mode")) injectPick(active.el);
  }
  syncNavButtons();
  updateProfileBtn();
  updateSizeBtn(); viewportLayout(); syncTouchDrag(false);   // 탭이 바뀌면 터치 변환은 무조건 끈다
  syncAiGlow();                                              // 이너 글로우는 조작 대상 탭에 있을 때만
  renderTabDialog();
  reportActiveBrowserWc();
  scheduleWebviewThrottling();
}

// AI→브라우저 CDP 제어용: 활성 브라우저 탭의 webContentsId를 서버에 보고한다. main의 실행기가
// 이 wc의 webview에 CDP를 실행한다. webview는 attach(dom-ready) 후에만 getWebContentsId()가 유효.
// 탭별 wc 보고/해제. 서버의 탭 레지스트리(tabReg)가 탭 목록과 고정 타깃 생존 판정의 유일한 소스다.
// 보고는 wc로 하되 정체성(tabId)을 함께 보낸다. 서버는 그것으로 키를 잡고 wc는 필드로만 들고 있다.
// webview는 dom-ready 이후에만 getWebContentsId()가 유효하므로 그 시점부터 보고한다.
export function spaceOfTabId(tabId) {
  const m = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(m)) if ((m[sp] || []).some((x) => x.id === tabId)) return sp;
  return null;
}

export function reportTabWc(rec, tabId) {
  try {
    if (!rec || !rec.el || !rec.ready) return;
    const mirrorUrl = callHook("mirror.tabUrl", tabId) || "";
    if (mirrorUrl) {
      rec.url = mirrorUrl;
      if (rec.wc) wsSend({ type: "browser-tab-gone", wc: rec.wc, tabId });
      rec.wc = null;
      return;
    }
    const wc = rec.el.getWebContentsId(); if (!wc) return;
    rec.wc = wc; rec.tabId = tabId;   // 정체성을 붙여둔다. 사라짐 보고도 정체성으로 한다
    const space = spaceOfTabId(tabId) || (BROWSER_MODE ? boundSpace() : consoleSpace());
    const win = BROWSER_MODE ? (BOUND_SPACE ? "shared" : "browser") : "console";
    wsSend({ type: "browser-tab-wc", wc, space: space || null, tabId, url: rec.url || "", title: rec.title || "", win });
  } catch {}
}

// webview가 사라졌다는 보고. 탭 정체성을 함께 보내, 서버가 wc 역인덱스에 의존하지 않게 한다(그 번호는
// 이미 다른 탭에 재발급됐을 수 있다).
export function forgetTabWc(rec, tabId) {
  // 게스트가 사라지면 지정한 화면 크기도 함께 사라지므로, 버튼에 없는 크기를 표시하지 않게 지운다.
  const tid = tabId || (rec && rec.tabId) || null;
  callHook("challenge.navigation", rec, { phase: "destroy", isMainFrame: true });
  callHook("mirror.navigation", rec, { phase: "destroy", isMainFrame: true });
  if (tid) delete viewportByTab[tid];
  try { if (rec && (rec.wc || tabId)) wsSend({ type: "browser-tab-gone", wc: rec.wc || null, tabId: tid }); } catch {}
}

export function reportActiveBrowserWc() {
  try {
    const id = activeBrowserId(); const rec = id ? getWebview(id) : null;
    // 브라우저 탭을 보고 있지 않다면(파일·터미널 탭으로 옮김) 그 사실도 알려야 한다. 알리지 않으면
    // 앱은 이전 탭이 아직 보인다고 보고, 키 입력을 붙잡기 없이 숨은 탭에 넣어 잃는다.
    if (!rec || !rec.el || !rec.ready) { try { acHost && acHost.tabShown && acHost.tabShown(0, 0, 0); } catch (e) {} }
    // 이 탭이 속한 스페이스를 함께 보고 → 서버가 스페이스별로 결속(다른 스페이스 탭이 안 덮음, #2).
    const space = BROWSER_MODE ? boundSpace() : consoleSpace();
    if (rec && callHook("mirror.tabUrl", id)) {
      try { acHost && acHost.tabShown && acHost.tabShown(0, 0, 0); } catch (e) {}
      return;
    }
    if (rec && rec.el && rec.ready && space) {
      const wc = rec.el.getWebContentsId();
      if (wc) {
        wsSend({ type: "browser-active-wc", wc, tabId: id, space });
        // 이 탭이 화면에 나왔으므로, 보이지 않는 동안 대신 넣어 준 화면 크기를 해제하도록 알린다.
        // 지금 이 화면의 실제 크기도 함께 보낸다. 안 보이는 탭에 임의의 크기(1280×800)를 주면 사람이
        // 보는 화면과 다른 레이아웃을 QA하게 되므로, 보이는 탭에서 측정한 값을 그대로 넘긴다.
        try {
          const r = rec.el.getBoundingClientRect();
          acHost && acHost.tabShown && acHost.tabShown(wc, Math.round(r.width), Math.round(r.height));
        } catch (e) {}
      }
    }
  } catch {}
}

// 외부 렌더러가 소유한 페이지의 meta도 일반 webview navigation과 같은 탭 상태 계약으로 합친다.
export function updateWebviewMeta(rec, meta = {}) {
  if (!rec || rec.tabId == null) return;
  const url = String(meta.url || rec.url || "");
  const title = String(meta.title || rec.title || "");
  const urlChanged = !!url && url !== rec.url;
  const titleChanged = title !== rec.title;
  if (url) rec.url = url;
  rec.title = title;
  const tabId = rec.tabId;
  if (activeBrowserId() === tabId && document.activeElement !== urlInput) {
    urlInput.value = rec.url;
    syncBookmarkStar();
  }
  const navSp = spaceOfTabId(tabId) || (BROWSER_MODE ? boundSpace() : getCenterSpace());
  if (navSp && (urlChanged || titleChanged)) {
    bsMutate({ op: "tab.navigate", space: navSp, id: tabId, ...(urlChanged ? { url } : {}), ...(titleChanged ? { title } : {}) });
  }
  const state = getBrowserState();
  const hasCustom = !!((state.tabsBySpace && state.tabsBySpace[navSp] || []).find((x) => x.id === tabId && x.name));
  const tab = curTabs().find((x) => x.id === tabId);
  if (titleChanged && tab && !hasCustom) { tab.label = title ? title.slice(0, 22) : "브라우저"; renderTabs(); }
  if (BROWSER_MODE && (urlChanged || titleChanged)) renderBmTabs();
  if (urlChanged) pushHistory(url);
}
