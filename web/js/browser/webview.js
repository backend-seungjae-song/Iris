// 브라우저 webview 수명주기. 탭별 live webview의 정책·재우기·깨우기·상태와 탭 대화상자를 조율한다.
//
// 소유 범위
//   webview LRU/유휴 정책과 스로틀 예약, 탭별 alert·confirm·prompt 대기 상태.
//
// 제공 API
//   탭 id·URL·활성 webview query, 정책/보호 query, 사용·폐기·복원·상태 command,
//   탭 대화상자 query·갱신·렌더 command.
//
// 의존 대상
//   browser/state·browser/webview-store·center/tab-store를 import한다. main이 소유하는 DOM/core 값과
//   webview-factory 소유 생성·wc 회수 callback, 탭 렌더·런타임 AI/space 상태는 init에서 받는다.
//
// 유지 조건
//   AI 상태가 불명확하면 전부 보호하고, 활성·녹화·미디어·질문·pinned·AI·최근 탭은 회수하지 않는다.
//   잠든 탭은 잠들기 전 URL·프로필로 깨우며, 질문 응답은 질문을 낸 탭의 wc로 보낸다.
//
// 영향 범위
//   acHost의 webviewPolicy·setWebviewThrottleState와 DOM #wv-dialog, browser/webview-factory의 생성·wc
//   회수, main.js의 탭 렌더 조립과 browser/{profiles,record,tabs,pick}의 query 계약.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/webview.js

import {
  aiRecentTabIds, getAiBusyTabs, getAiRecentKnown, getAiTargets, getAiTargetsKnown,
} from "./ai-state.js";
import { bmActiveId, bmTabs, getBrowserState } from "./state.js";
import { callHook } from "../core/hooks.js";
import { activeIdFor } from "./active-tab.js";
import {
  ensureWebviewStatus, getDiscardedWebview, getWebview, getWebviewEntries, getWebviewIds,
  getWebviewLastUsedAt, getWebviewLastUsedEntries, getWebviewStatus, recordDiscardedWebview,
  recordWebviewUse, removeDiscardedWebview, removeWebview,
} from "./webview-store.js";
import { getActiveTabId, getCenterSpace, getCurrentTabs } from "../center/tab-store.js";

let $, esc, wsSend, BROWSER_MODE, bNote, renderBmTabs, renderTabs;
let getSpaces;
let createWebview, forgetTabWc, showToast;
let profileIdForStored = (value) => String(value || "");
let spaceDefaultProfile = () => "";
let recTracked = () => false;
let getRecording = () => false;

export let WEBVIEW_POLICY = {};
export let WEBVIEW_LRU = false;
export let WEBVIEW_IDLE_MS = 15 * 60000;
export let WEBVIEW_RECENT = 3;
let webviewThrottleTimer = null;
const tabDialogs = {}; // tabId → { kind, message, wc }

export function initWebview(deps) {
  ({ $, esc, wsSend, BROWSER_MODE, bNote, renderBmTabs, renderTabs,
    getSpaces,
    createWebview, forgetTabWc, showToast } = deps);

  WEBVIEW_POLICY = (() => {
    try { return (window.acHost && acHost.webviewPolicy && acHost.webviewPolicy()) || {}; } catch { return {}; }
  })();
  WEBVIEW_LRU = WEBVIEW_POLICY.lru === true;
  WEBVIEW_IDLE_MS = Math.max(60000, Number(WEBVIEW_POLICY.idleMin || 15) * 60000);
  WEBVIEW_RECENT = Math.max(0, Number(WEBVIEW_POLICY.recent ?? 3) || 0);

  if (WEBVIEW_LRU) setInterval(sweepIdleWebviews, Math.min(60000, Math.max(15000, WEBVIEW_IDLE_MS / 4)));
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".wv-dialog [data-ans]"); if (!b) return;
    // 답은 지금 그려져 있는 그 탭으로 간다. 활성 탭으로 보내면 다른 탭이 묻고 있을 때 잘못된 곳에 답한다.
    const el = e.target.closest(".wv-dialog");
    const id = (el && el.dataset.tab) || activeBrowserId();
    if (id) answerTabDialog(id, b.dataset.ans);
  });
}

export function bindWebviewProfiles(deps) {
  ({ profileIdForStored, spaceDefaultProfile } = deps);
}

export function bindWebviewRecording(deps) {
  ({ recTracked, getRecording } = deps);
}

export function storedBrowserTab(tabId) {
  const m = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(m)) {
    const tab = (m[sp] || []).find((x) => x && x.id === tabId);
    if (tab) return { sp, tab };
  }
  return null;
}

// 살려 둘 기준은 "최근 5분 안에 AI 가 실제로 썼는가" 하나다. 점유 여부(held)나 영속 tab.ai 는
// 기준으로 쓰지 않는다. 고정은 세션이 살아 있는 내내 남고 tab.ai 는 지워지지 않아서, 둘 다
// 과거에 한 번 쓴 탭을 계속 살려 둔다. 재워도 명령이 오면 깨워 쓰므로
// (server/browser-commands.js 의 asleep 분기) 좁혀도 자동화가 끊기지 않는다.
// 구조가 아직 안 왔거나 일부라도 불명확하면 null을 돌려 전체 보존한다(애매한 탭을 유휴로 오판해
// 자동화를 끊지 않는다). ai-targets 자체는 더 이상 보호 대상을 정하지 않지만, 그것이 망가졌다는
// 것은 서버 상태 전체를 신뢰할 수 없다는 뜻이라 여기서 그대로 fail-safe 로 쓴다.
export function authoritativeAiProtection() {
  const aiTargetsKnown = getAiTargetsKnown(), aiTargets = getAiTargets();
  if (!aiTargetsKnown || !Array.isArray(aiTargets)) return null;
  if (!getAiRecentKnown()) return null;   // 최근 사용 신호를 한 번도 못 받았다 → 전체 보존
  const ids = aiRecentTabIds(), groups = new Set();
  for (const target of aiTargets) {
    if (!target || typeof target !== "object" || !Array.isArray(target.held)) return null;
    if (target.tabId != null && typeof target.tabId !== "string" && typeof target.tabId !== "number") return null;
    // 여기서 target.tabId·held 를 보호 대상에 넣지 않는다. 넣으면 위 기준이 다시 held 가 된다.
    // 계약 검사만 하고 지나간다.
    // held 원소는 탭 id 문자열(서버 heldTabsOf)이어야 한다. null·객체·배열 등 계약 밖 원소는 실제
    // AI 탭 id가 빠진 malformed 신호이므로, 삼키지(String(obj)/skip) 말고 전체 보존으로 전환한다.
    // 타입 검사를 null 스킵보다 먼저 둔다: {held:[null]}도 malformed로 잡아 fail-safe가 우회되지 않게.
    for (const id of target.held) {
      if (typeof id !== "string" && typeof id !== "number") return null;
    }
  }
  const m = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(m)) {
    for (const tab of (m[sp] || [])) {
      if (!tab) continue;
      // tab.ai 는 여기서도 보지 않는다. 한 번 붙으면 지워지지 않는 표식이라 기준이 될 수 없다.
      if (ids.has(tab.id) && tab.group) groups.add(sp + "\n" + tab.group);
    }
  }
  // AI가 잡은 탭 하나가 속한 그룹은 탭 단위 idle과 무관하게 통째로 백그라운드 작업 단위다.
  for (const sp of Object.keys(m)) for (const tab of (m[sp] || [])) {
    if (tab && tab.group && groups.has(sp + "\n" + tab.group)) ids.add(tab.id);
  }
  return ids;
}

// 이 키가 지금 살아 있는 스페이스인가. 서버는 살아 있는 스페이스의 상태를 그 workspace_id로
// 실어 보내고, 소유자가 없는(=접었거나 닫은) 스페이스의 것은 폴더 키 그대로 보낸다. 그래서
// "목록에 있는 id인가"만 보면 된다. 공유 창은 스페이스가 아니라 늘 살아 있는 것으로 본다.
export function isLiveSpaceKey(sp) {
  return sp === "__shared__" || (getSpaces() || []).some((s) => s.id === sp);
}

// 접은 스페이스의 탭은 기록만 남기고 메모리에서 내린다. 보관 기능의 목적이 그것이다.
// 지우는 것이 아니라 재우는 것이라, 그 스페이스를 다시 열면 같은 위치에서 열린다.
export function sleepDeadSpaceWebviews() {
  let changed = false;
  for (const id of getWebviewIds()) {
    const stored = storedBrowserTab(id);
    if (!stored || isLiveSpaceKey(stored.sp)) continue;
    if (tabDialogs[id] || getRecording()) continue;   // 확인 창이 떠 있거나 녹화 중이면 건드리지 않는다
    changed = discardWebview(id, Date.now()) || changed;
  }
  if (changed) { if (BROWSER_MODE) renderBmTabs(); else renderTabs(); scheduleWebviewThrottling(); }
  return changed;
}

export function recentWebviewIds() {
  return new Set([...getWebviewLastUsedEntries()]
    .filter(([id]) => !!getWebview(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, WEBVIEW_RECENT)
    .map(([id]) => id));
}

export function webviewProtected(tabId, aiProtected, recent) {
  if (aiProtected == null) return true; // authoritative 상태 미수신/불명확: fail-safe
  const rec = getWebview(tabId), status = getWebviewStatus(tabId) || {}, stored = storedBrowserTab(tabId);
  if (!rec || !stored) return true;
  // 녹화 보호는 녹화 대상 탭에만 적용한다. recording 하나로 모든 탭을 보호하면 녹화를 켜는 순간
  // 잠든 탭이 전부 깨어나고 그 복구 이동이 기록에 섞인다.
  if (tabId === activeBrowserId() || recTracked(tabId) || status.audible || status.loading || tabDialogs[tabId]) return true;
  if (rec.el && rec.el.dataset && rec.el.dataset.acHeld != null) return true; // 스크린샷 합성 hold
  if (stored.tab.pinned || aiProtected.has(tabId) || getAiBusyTabs().has(tabId)) return true;
  return !!(recent && recent.has(tabId));
}

export function syncWebviewThrottling() {
  webviewThrottleTimer = null;
  if (!window.acHost || !acHost.setWebviewThrottleState) return;
  const aiProtected = authoritativeAiProtection();
  const recent = recentWebviewIds();
  const webviews = [];
  for (const [tabId, rec] of getWebviewEntries()) {
    if (!rec || !rec.ready || !rec.el) continue;
    let wc = 0; try { wc = rec.el.getWebContentsId(); } catch {}
    if (wc) webviews.push({ wc, tabId, protected: webviewProtected(tabId, aiProtected, recent) });
  }
  const protectedTabIds = new Set(aiProtected || []);
  for (const id of getAiBusyTabs().keys()) protectedTabIds.add(id);
  try {
    acHost.setWebviewThrottleState({
      webviews,
      protectedTabIds: [...protectedTabIds],
      unknownAi: aiProtected == null,
    });
  } catch {}
}

export function scheduleWebviewThrottling() {
  if (webviewThrottleTimer) return;
  webviewThrottleTimer = setTimeout(syncWebviewThrottling, 40);
}

export function markWebviewUsed(tabId) {
  if (!tabId) return;
  recordWebviewUse(tabId, Date.now());
  scheduleWebviewThrottling();
}

export function discardWebview(tabId, now) {
  const rec = getWebview(tabId), stored = storedBrowserTab(tabId);
  if (!rec || !stored) return false;
  const url = rec.url || stored.tab.url || "about:blank";
  const profile = rec.el && rec.el.dataset ? rec.el.dataset.profile : profileIdForStored(stored.tab.profile);
  recordDiscardedWebview(tabId, { url, profile, discardedAt: now });
  forgetTabWc(rec, tabId);
  try { rec.el.remove(); } catch {}
  removeWebview(tabId);
  setTabStatus(tabId, { sleeping: true, loading: false });
  return true;
}

// 지금 이 탭에 실제 크로미움을 올릴 것인가. 크롬처럼 보고 있는 탭 하나만 올린다.
// 순수 판정이라 DOM 없이 부를 수 있고 검사가 그대로 부른다.
export function shouldMaterializeTab(tabId, activeId, lruOn) {
  if (!lruOn) return true;               // 재우기를 통째로 끈 롤백 모드(IRIS_WEBVIEW_LRU=0)
  return !!tabId && tabId === activeId;
}

// 아직 한 번도 만들어진 적 없는 탭을 잠자는 탭으로 등록한다. 크롬이 복원한 탭을 누르기 전까지
// 만들지 않는 것과 같다. 그 전에는 목록의 한 줄일 뿐이고 크로미움 프로세스는 없다.
// discardWebview 와 다르다: 저것은 살아 있던 것을 내리는 일(회수)이고, 이것은 처음부터 올리지 않는
// 일이다. 그래서 정리할 wc·DOM 도 없고, discardedAt 은 0 이다(한 번도 안 쓴 탭이라 가장 오래된 것과 같다).
export function sleepStoredTab(tabId, tab, sp) {
  if (!tabId || getWebview(tabId) || getDiscardedWebview(tabId)) return false;
  const url = (tab && tab.url) || "about:blank";
  const profile = tab && tab.profile != null ? profileIdForStored(tab.profile) : spaceDefaultProfile(sp);
  recordDiscardedWebview(tabId, { url, profile, discardedAt: 0 });
  setTabStatus(tabId, { sleeping: true, loading: false });
  return true;
}

export function wakeWebview(tabId) {
  if (!tabId || getWebview(tabId)) return getWebview(tabId) || null;
  const stored = storedBrowserTab(tabId); if (!stored) return null;
  const sleeping = getDiscardedWebview(tabId);
  // 잠든 탭은 잠들기 전 그 세션으로 돌아와야 한다. 여기서 지금의 기본 계정으로 다시 풀면, 그
  // 사이 스페이스 기본이 바뀌었거나 계정 목록이 잠깐 비어 있었을 때 다른 파티션에 붙는다.
  // 사용자에게는 "쓰던 중에 갑자기 로그아웃"으로 보이고(목록은 정상이다), 원래 세션은 디스크에
  // 그대로 있다. 재우기는 앱 내부 동작이지 사용자가 계정을 바꾼 것이 아니다.
  const profile = (sleeping && sleeping.profile != null)
    ? sleeping.profile
    : (stored.tab.profile == null ? spaceDefaultProfile(stored.sp) : profileIdForStored(stored.tab.profile));
  const url = (sleeping && sleeping.url) || stored.tab.url;
  removeDiscardedWebview(tabId);
  setTabStatus(tabId, { sleeping: false });
  const rec = createWebview(tabId, profile, url && url !== "about:blank" ? url : undefined);
  // 잠자던 탭을 다시 여는 것은 앱 내부 동작이지 사용자의 이동이 아니다. 표시해 두지 않으면 그 복구
  // 이동이 녹화에 `goto` 로 남는다. 녹화를 켜는 순간 재우기가 풀려 잠든 탭이 한꺼번에 깨므로,
  // 기록 첫머리가 사용자가 하지 않은 이동 수십 줄로 채워진다.
  if (rec) rec.restoring = true;
  markWebviewUsed(tabId);
  if (sleeping) {
    bNote.textContent = "잠자던 탭을 다시 여는 중… 입력·스크롤 상태는 페이지에 따라 복원되지 않을 수 있습니다.";
    bNote.hidden = false;
    try { showToast("잠자던 탭을 다시 엽니다 · 페이지 입력/스크롤은 초기화될 수 있습니다."); } catch {}
  }
  return rec;
}

export function sweepIdleWebviews() {
  if (!WEBVIEW_LRU) return;
  const aiProtected = authoritativeAiProtection();
  if (aiProtected == null) { scheduleWebviewThrottling(); return; }
  const now = Date.now(), recent = recentWebviewIds();
  const candidates = getWebviewIds()
    .map((id) => [id, getWebviewLastUsedAt(id) || now])
    .sort((a, b) => a[1] - b[1]);
  let changed = false;
  for (const [id, lastUsed] of candidates) {
    if (now - lastUsed < WEBVIEW_IDLE_MS) continue;
    if (webviewProtected(id, aiProtected, recent)) continue;
    changed = discardWebview(id, now) || changed;
  }
  if (changed) {
    if (BROWSER_MODE) renderBmTabs(); else renderTabs();
    scheduleWebviewThrottling();
  }
}

// 페이지가 묻고 있는 것(alert/confirm/prompt). 창에 붙는 네이티브 시트로 두면 다른 탭을 보고
// 있어도 그 위에 뜨고 창 전체가 막힌다. 그래서 질문은 탭에
// 속한 상태로 들고 그 탭 안에서 답한다.
export function hasTabDialog(tabId) {
  return !!tabDialogs[tabId];
}

export function setTabDialog(tabId, dialog) {
  tabDialogs[tabId] = dialog;
  return dialog;
}

export function clearTabDialog(tabId) {
  delete tabDialogs[tabId];
}

// 묻는 탭이 활성 탭이 아니어도 반드시 띄운다. 활성 탭일 때만 그리면, 활성 탭 판정이
// 어긋나는 순간 답할 방법이 사라지고 그 페이지는 멈춘 채로 남는다. 사용자에게는
// 버튼이 동작하지 않는 것으로 보인다(확인 결과: 확인창이 뜬 탭에서 클릭이 전부 동작하지 않음).
export function pendingDialogTabId() {
  const id = activeBrowserId();
  if (id && tabDialogs[id]) return id;          // 보고 있는 탭이 묻고 있으면 그것부터
  return Object.keys(tabDialogs)[0] || null;    // 아니면 기다리는 것 중 하나를 띄운다
}

export function renderTabDialog() {
  const el = $("#wv-dialog"); if (!el) return;
  const id = pendingDialogTabId();
  const d = id ? tabDialogs[id] : null;
  if (!d) { el.hidden = true; el.innerHTML = ""; el.removeAttribute("data-tab"); return; }
  // 어느 사이트가 묻는지를 먼저 밝힌다. 내용만 있으면 무엇이 띄운 창인지 알 수 없다.
  let host = "";
  const webview = getWebview(id);
  try { host = new URL((webview && webview.url) || "").host; } catch (e2) {}
  // 보고 있지 않은 탭이 묻는 경우에는 그 사실을 밝힌다. 그러지 않으면 지금 화면이 물은 것으로 오해한다.
  const other = id !== activeBrowserId();
  const btns = d.kind === "alert"
    ? '<button class="hot" data-ans="ok">확인</button>'
    : '<button data-ans="cancel">아니오</button><button class="hot" data-ans="ok">네</button>';
  el.hidden = false;
  el.dataset.tab = id;
  el.innerHTML = '<div class="wd-card" role="dialog" aria-modal="true">'
    + '<div class="wd-host">' + esc(host || "이 페이지") + (other ? " (다른 탭)" : "") + '</div>'
    + '<div class="wd-msg">' + esc(d.message) + "</div>"
    + (d.kind === "prompt" ? '<input class="wd-in" id="wd-in" value="' + esc(d.def || "") + '" />' : "")
    + '<div class="wd-btns">' + btns + "</div></div>";
  const inp = el.querySelector("#wd-in");
  const ok = el.querySelector('[data-ans="ok"]');
  if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.click(); });
  // 커서는 사람이 눌러서 뜬 창일 때만 가져온다.
  // 두 단계다. AI 가 조작하다가 뜬 창(d.byAi)은 가져가지 않는다. 그 페이지 안 입력칸에 커서가 있어도
  // 호스트에서는 볼 수 없어서, 원인으로 구분하지 않으면 그 위치를 유지할 방법이 없다.
  // 사람이 눌러 뜬 창이라도 터미널·다른 입력칸에 커서가 있으면
  // 건드리지 않는다. 버튼은 커서가 없어도 눌린다.
  if (!d.byAi && !typingElsewhere(id)) { if (inp) { inp.focus(); inp.select(); } else if (ok) ok.focus(); }
}

// 지금 사용자가 입력 중인 곳에 커서가 있는가. 묻는 그 탭의 화면에 있으면 아니다.
function typingElsewhere(askingTabId) {
  const at = document.activeElement;
  if (!at || at === document.body) return false;
  if (at.tagName === "WEBVIEW") {
    const asking = getWebview(askingTabId);
    return !(asking && (asking === at || asking.el === at));
  }
  return at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName);
}

function answerTabDialog(tabId, answer) {
  const d = tabDialogs[tabId]; if (!d) return;
  const inp = $("#wd-in");
  wsSend({ type: "browser-dialog-answer", wc: d.wc, answer, ...(inp ? { text: inp.value } : {}) });
  delete tabDialogs[tabId];
  renderTabDialog(); renderBmTabs();
}

export function setTabStatus(tabId, patch) {
  const cur = ensureWebviewStatus(tabId);
  let changed = false;
  for (const k of Object.keys(patch)) if (cur[k] !== patch[k]) { cur[k] = patch[k]; changed = true; }
  if (changed) {
    try { renderBmTabs(); } catch {}
    if (Object.prototype.hasOwnProperty.call(patch, "audible") || Object.prototype.hasOwnProperty.call(patch, "sleeping")) scheduleWebviewThrottling();
  }
}

export function normalizeUrl(u) {
  u = u.trim(); if (!u) return "";
  if (/^https?:\/\//i.test(u) || /^about:/i.test(u) || /^file:/i.test(u)) return u;
  if (/^localhost(:\d+)?(\/|$)/i.test(u) || /^\d+\.\d+\.\d+\.\d+/.test(u)) return "http://" + u;
  // 주소처럼 보이지 않으면 검색어로 처리한다. 크롬 주소창과 같은 판단이다. 공백이 있거나 점 뒤에 TLD 모양이
  // 없으면 주소가 아니다("사과 가격", "todo 정리" 같은 입력에 https:// 를 붙이면 로드에 실패한다).
  const looksHost = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(u);
  if (!looksHost) return "https://www.google.com/search?q=" + encodeURIComponent(u);
  return "https://" + u;
}

export function newTabId() {
  try { return "browser:" + crypto.randomUUID(); } catch (e) {}
  return "browser:" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function activeBrowserId() {
  // 한 탭에 묶인 창(탭을 빼내 만든 창)은 그 탭이 활성이다. activeBySpace 는 스페이스마다 하나뿐이라
  // 그 값을 따르면 같은 스페이스에서 뺀 창들이 전부 같은 페이지를 표시한다. 묶였는지는
  // 그 기능이 안다.
  if (BROWSER_MODE) {
    return activeIdFor({
      boundTab: callHook("detach.boundTab"),
      spaceActive: bmActiveId(),
      hidden: callHook("detach.hidden"),
      order: bmTabs().map((t) => t.id),
    });
  }
  const t = getCurrentTabs().find((x) => x.id === getActiveTabId(getCenterSpace())); return (t && t.kind === "browser") ? t.id : null;
}

export function activeWv() {
  const id = activeBrowserId(); return id ? getWebview(id) : null;
}

// 뒤로·앞으로 단추는 갈 곳이 없으면 누를 수 없게 둔다. 미러 탭은 기록을 원격 쪽이 갖고 있어 웹뷰에 물을 수
// 없으므로 누를 수 있게 남긴다. 기록을 묻는 함수가 없는 요소(웹뷰가 아닌 곳)는 갈 곳이 없는 것으로 본다.
export function syncNavButtons() {
  const r = activeWv();
  const mirrored = !!(r && callHook("mirror.tabUrl", r.tabId));
  const can = (fn) => {
    if (!r || mirrored) return true;
    try { return typeof r.el?.[fn] === "function" ? !!r.el[fn]() : false; } catch { return true; }
  };
  const back = document.getElementById("wv-back"), fwd = document.getElementById("wv-fwd");
  if (back) back.disabled = !can("canGoBack");
  if (fwd) fwd.disabled = !can("canGoForward");
}
