// 닫은 탭 되돌리기(⌘⇧T). 무엇을 복원할지 고르고, 종류에 맞는 처리로 넘긴다.
//
// 소유 범위
//   이 창에서 닫힌 *센터 탭*(파일·시트·문서)의 스택과, 서버가 보내준 *브라우저 탭* 스택의 사본.
//   둘 중 무엇이 더 최근인지 고르는 판정(pickReopen).
//
// 제공 API
//   noteClosedCenterTab(space, tab): 센터 탭이 닫힐 때 그 자리에서 호출한다.
//   setClosedBrowserTabs(list): 서버 closed-tabs 방송을 그대로 받는다.
//   pickReopen(browserList, centerList): 순수 판정. 검사가 이 함수를 직접 호출한다.
//   reopenLastClosed(): ⌘⇧T 가 호출하는 진입점. 복원할 것이 있으면 true.
//   closedTabsForView(): 설정 화면이 목록으로 보여줄 때 쓰는 합친 목록(최근이 앞).
//
// 의존 대상
//   initClosedTabs 로 서버에 보내는 wsSend, 파일을 여는 openFile, 토스트를 받는다.
//   center/tab-store 를 직접 읽지 않는다. 닫는 쪽이 자기가 가진 탭 객체를 그대로 넘긴다.
//
// 유지 조건
//   브라우저 탭 스택은 서버가 정본이다. 여기서 지우거나 더하지 않고, 복원도 서버에 요청하며
//   (tab-reopen) 스택에서 빼는 것도 서버가 한다. 창마다 따로 관리하면 분리 창에서 닫은
//   탭을 콘솔에서 복원할 수 없다.
//   센터 탭은 반대로 서버가 모르는 이 창만의 상태라 여기서 관리한다.
//
// 영향 범위
//   center/tab-close 의 닫기 경로, core/keynav 와 browser/dock 의 ⌘⇧T 처리,
//   main 의 closed-tabs 수신 등록, server/browser-message-handlers 의 tab-reopen.
//   현재 목록 확인: node bin/importers.mjs web/js/center/closed-tabs.js

const CENTER_KEEP = 25;   // 서버 쪽 스택과 같은 깊이
const REOPEN_HISTORY_TTL_MS = 30_000;

let wsSend = null, openFile = null, showToast = null;

// 서버가 들고 있는 브라우저 탭 스택의 사본. 오래된 것이 앞, 방금 닫은 것이 뒤.
let closedBrowser = [];
// 이 창에서 닫힌 센터 탭. 같은 순서 규칙.
const closedCenter = [];
// 서버가 browser-state보다 먼저 보내는 일회성 복원 재료. 모든 로컬 창이 메시지를 받으므로 실제로
// 그 탭을 만드는 창만 꺼내고, 나머지는 짧게 보관한 뒤 폐기한다.
const reopenedBrowserHistory = new Map();

export function initClosedTabs(deps) {
  ({ wsSend, openFile, showToast } = deps);
}

export function setClosedBrowserTabs(list) {
  closedBrowser = Array.isArray(list) ? list.filter((x) => x && x.tabId) : [];
}

export function queueReopenedBrowserHistory(message, now = Date.now()) {
  const tabId = message && message.tabId ? String(message.tabId) : "";
  const history = message && message.history;
  if (!tabId || !history || !Array.isArray(history.entries) || !history.entries.length
    || !Number.isInteger(history.index) || history.index < 0 || history.index >= history.entries.length) return false;
  reopenedBrowserHistory.set(tabId, { history, expiresAt: now + REOPEN_HISTORY_TTL_MS });
  while (reopenedBrowserHistory.size > CENTER_KEEP) reopenedBrowserHistory.delete(reopenedBrowserHistory.keys().next().value);
  return true;
}

export function takeReopenedBrowserHistory(tabId, now = Date.now()) {
  const key = String(tabId || "");
  const pending = reopenedBrowserHistory.get(key);
  reopenedBrowserHistory.delete(key);
  return pending && pending.expiresAt >= now ? pending.history : null;
}

// 복원할 수 있는 것만 남긴다. 경로가 없는 파일 탭은 다시 열 방법이 없어, 남겨 두면 ⌘⇧T 가
// 아무 일도 하지 않는 것처럼 보이고 그 한 번이 앞의 실제 탭을 복원할 기회를 쓴다.
export function noteClosedCenterTab(space, tab) {
  if (!space || !tab || !tab.path) return false;
  closedCenter.push({ space, path: String(tab.path), label: tab.label || "", kind: tab.kind || null, closedAt: Date.now() });
  while (closedCenter.length > CENTER_KEEP) closedCenter.shift();
  return true;
}

// 두 스택의 맨 위를 비교해 더 최근에 닫힌 쪽을 고른다. 시각이 같으면 브라우저 탭을 고른다.
// 한쪽으로 정해 두지 않으면 같은 밀리초에 닫힌 두 탭에서 순서가 호출마다 달라진다.
export function pickReopen(browserList, centerList) {
  const b = browserList && browserList.length ? browserList[browserList.length - 1] : null;
  const c = centerList && centerList.length ? centerList[centerList.length - 1] : null;
  if (!b && !c) return null;
  if (!c) return { kind: "browser", entry: b };
  if (!b) return { kind: "center", entry: c };
  return (c.closedAt > b.closedAt) ? { kind: "center", entry: c } : { kind: "browser", entry: b };
}

export function reopenLastClosed() {
  const pick = pickReopen(closedBrowser, closedCenter);
  if (!pick) { showToast && showToast("되살릴 닫힌 탭이 없습니다"); return false; }
  if (pick.kind === "center") {
    // 고른 항목만 제거한다. 맨 위를 pop 하면 그사이 다른 탭이 닫혔을 때 엉뚱한 항목이 빠진다.
    const i = closedCenter.lastIndexOf(pick.entry);
    if (i >= 0) closedCenter.splice(i, 1);
    openFile && openFile(pick.entry.path);
    return true;
  }
  // 브라우저 탭은 서버가 정본이다. 여기서 사본만 지우면 다음 방송에 다시 채워지므로 요청만
  // 보내고, 스택에서 제거하는 것과 여는 것은 서버가 함께 처리한다.
  wsSend && wsSend({ type: "tab-reopen", tabId: pick.entry.tabId });
  return true;
}

// 목록에서 하나를 골라 복원한다. ⌘⇧T 는 맨 위 하나를 열지만, 목록에서는 사용자가 세 번째를
// 고를 수 있어야 하므로 맨 위를 여는 것은 고른 항목을 무시하는 동작이 된다.
export function reopenClosedTab(kind, key) {
  if (kind === "center") {
    const i = closedCenter.findIndex((x) => x && x.path === key);
    if (i < 0) return false;
    const entry = closedCenter.splice(i, 1)[0];
    openFile && openFile(entry.path);
    return true;
  }
  if (!closedBrowser.some((x) => x && x.tabId === key)) return false;
  // 브라우저 탭은 서버가 정본이므로 스택에서 제거하는 것과 여는 것을 서버가 함께 처리한다.
  wsSend && wsSend({ type: "tab-reopen", tabId: key });
  return true;
}

// 설정 화면용 목록. 최근에 닫힌 것이 앞이며 복원 순서와 같다.
export function closedTabsForView() {
  return [...closedBrowser.map((x) => ({ ...x, kind: "browser" })),
    ...closedCenter.map((x) => ({ ...x, kind: "center" }))]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
}
