// 서버 공유 브라우저 상태. 서버가 보낸 현재 스냅샷과 브라우저 창의 space 결속을 한 곳에서 소유한다.
//
// 소유 범위
//   서버 공유 브라우저 상태의 현재 객체, 그 상태를 한 번이라도 받았는가,
//   그리고 분리 브라우저 창에 주입된 bound space.
//
// 제공 API
//   현재 객체 query, 객체 통째 교체·프로필/활성 탭 갱신 command, browser-mode space·탭 query,
//   서버로 mutation 을 보내는 bsMutate, 브라우저 것이 소속되는 space 판정 curBmSpace.
//
// 의존 대상
//   DOM에 기대지 않는다. init에서 URL의 BOUND_SPACE·BROWSER_MODE·wsSend를 받고,
//   center가 보고 있는 space는 tab-store에서 읽는다.
//
// 유지 조건
//   서버 스냅샷은 통째로 교체된다. 소비자는 객체 참조를 붙들지 않고 매번 getBrowserState()로
//   현재 객체를 읽어야 하며, 탭·프로필 객체 identity와 배열 순서는 받은 그대로 보존한다.
//
// 영향 범위
//   main.js의 브라우저 렌더·프로필·도킹·북마크 흐름과 center/{file-routing,tab-close},
//   browser/{bookmarks,profiles}, devtool/run.
//   이 API를 바꾸면 import 하는 파일을 함께 확인한다: grep -rl 'browser/state.js"' web/js

import { getCenterSpace } from "../center/tab-store.js";

let browserState = {
  bookmarksBySpace: {}, bookmarksCommon: [], tabsBySpace: {}, activeBySpace: {}, activeSpace: null, docked: false,
  profiles: [], profileSources: {}, defaultProfileBySpace: {}, urlHistoryBySpace: {},
};
let configuredBoundSpace = null;
let browserMode = false;
// 서버 상태를 한 번이라도 받았는가. 받지 못한 상태에서는 "목록에 없다"가 "없다"를 뜻하지 않는다.
// 프로필을 새로 만들면 새 파티션이라 로그인이 전부 사라진 것처럼 보인다(확인 결과).
let loaded = false;
let send = () => {};

export function initBrowserState(deps) {
  configuredBoundSpace = deps.BOUND_SPACE;
  browserMode = !!deps.BROWSER_MODE;
  send = deps.wsSend;
}

// 서버가 이 상태의 정본이다. 창은 값을 직접 고치지 않고 mutation만 보내고,
// 실제 반영은 browser-state 브로드캐스트 수신에서 한다(멱등).
export function bsMutate(mutation) { send({ type: "browser-sync", mutation }); }

// 브라우저 것(북마크·기록·탭)이 소속되는 space: 분리창은 활성 스페이스, 콘솔은 센터 스페이스.
export function curBmSpace() {
  return browserMode ? boundSpace() : (getCenterSpace() || boundSpace());
}

export function getBrowserState() {
  return browserState;
}

export function replaceBrowserState(state) {
  browserState = state;
  loaded = true;
  return browserState;
}

export function isBrowserStateLoaded() { return loaded; }

export function ensureBrowserStateCollections() {
  if (!browserState.bookmarksBySpace || typeof browserState.bookmarksBySpace !== "object") browserState.bookmarksBySpace = {};
  if (!Array.isArray(browserState.bookmarksCommon)) browserState.bookmarksCommon = [];
  if (!Array.isArray(browserState.profiles)) browserState.profiles = [];
  if (!browserState.profileSources || typeof browserState.profileSources !== "object") browserState.profileSources = {};
  if (!browserState.defaultProfileBySpace || typeof browserState.defaultProfileBySpace !== "object") browserState.defaultProfileBySpace = {};
  if (!browserState.urlHistoryBySpace || typeof browserState.urlHistoryBySpace !== "object") browserState.urlHistoryBySpace = {};
}

export function setBrowserProfiles(profiles) {
  browserState.profiles = profiles;
  return profiles;
}

export function setBrowserActiveTab(space, tabId) {
  if (browserState.activeBySpace) browserState.activeBySpace[space] = tabId;
  return tabId;
}

export const boundSpace = () => configuredBoundSpace || (browserState && browserState.activeSpace) || null;
export const bmTabs = () => (browserState && browserState.tabsBySpace && browserState.tabsBySpace[boundSpace()]) || [];
export const bmActiveId = () => (browserState && browserState.activeBySpace && browserState.activeBySpace[boundSpace()]) || null;
