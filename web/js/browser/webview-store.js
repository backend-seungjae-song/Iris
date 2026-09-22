// 브라우저 webview 저장소. 탭별 live webview와 그 창에서 관찰한 수명주기 상태를 소유한다.
//
// 소유 범위
//   tabId별 webview 항목·상태·discard 기록·LRU 시각·마지막 주 문서 load 실패.
//
// 제공 API
//   항목 query, id/entry 열거 query, 등록·폐기·최근 사용·실패 기록 command.
//
// 의존 대상
//   외부 모듈이나 DOM에 기대지 않는다. 항목 안의 el은 호출자가 만든 살아 있는 DOM 요소다.
//
// 유지 조건
//   레지스트리 자체는 밖으로 내주지 않는다. 다만 항목 객체와 el identity는 그대로 돌려줘 호출자가
//   executeJavaScript·reload·remove 등 기존 메서드와 항목 필드를 같은 순서로 사용할 수 있어야 한다.
//
// 영향 범위
//   browser/webview-factory의 생성·탐색·wc 보고, browser/webview의 LRU·sleep/wake,
//   main.js의 탭 reconcile·녹화·pick과 center/tab-close.js의 탭 정리.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/webview-store.js

const browserWv = {};
const tabStatus = {};
const discardedWv = {};
const webviewLastUsed = new Map();
const lastLoadFail = {};

export function getWebview(tabId) {
  return browserWv[tabId] || null;
}

export function getWebviewIds() {
  return Object.keys(browserWv);
}

export function getWebviewEntries() {
  return Object.entries(browserWv);
}

export function registerWebview(tabId, record) {
  browserWv[tabId] = record;
  return record;
}

export function removeWebview(tabId) {
  delete browserWv[tabId];
}

export function getWebviewStatus(tabId) {
  return tabStatus[tabId] || null;
}

export function ensureWebviewStatus(tabId) {
  return tabStatus[tabId] || (tabStatus[tabId] = {});
}

export function removeWebviewStatus(tabId) {
  delete tabStatus[tabId];
}

export function getDiscardedWebview(tabId) {
  return discardedWv[tabId] || null;
}

export function getDiscardedWebviewIds() {
  return Object.keys(discardedWv);
}

export function recordDiscardedWebview(tabId, record) {
  discardedWv[tabId] = record;
  return record;
}

export function removeDiscardedWebview(tabId) {
  delete discardedWv[tabId];
}

export function getWebviewLastUsedAt(tabId) {
  return webviewLastUsed.get(tabId);
}

export function getWebviewLastUsedEntries() {
  return webviewLastUsed.entries();
}

export function recordWebviewUse(tabId, at) {
  webviewLastUsed.set(tabId, at);
  return at;
}

export function removeWebviewLastUsed(tabId) {
  webviewLastUsed.delete(tabId);
}

export function getLoadFailure(tabId) {
  return lastLoadFail[tabId] || null;
}

export function setLoadFailure(tabId, message) {
  lastLoadFail[tabId] = message;
  return message;
}

export function removeLoadFailure(tabId) {
  delete lastLoadFail[tabId];
}
