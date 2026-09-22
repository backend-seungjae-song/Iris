// center 탭 저장소. 스페이스별 탭 목록과 활성 탭, 현재 center space를 한 곳에서 소유한다.
//
// 소유 범위
//   space별 center 탭 목록, space별 활성 탭 id, center가 현재 보여주는 space.
//
// 제공 API
//   목록·현재 space·활성 id query와 space 초기화·탭 추가/제거/교체·활성/space 변경 command.
//
// 의존 대상
//   외부 모듈이나 DOM에 의존하지 않는다. 탭 객체 identity와 목록 순서는 호출자가 만든 그대로 보존한다.
//
// 유지 조건
//   없는 space 조회는 빈 목록이고, 제거는 같은 객체만 지우며, 활성 id는 호출자가 정한 시점에만 바뀐다.
//
// 영향 범위
//   외부 상태도 DOM도 건드리지 않는다.
//   대신 이 API 자체가 계약이라 시그니처·반환 형태를 바꾸면 import 하는 모든 파일을 함께 고쳐야 한다.
//   이 저장소에서 가장 많이 import 되는 모듈이라 그 수를 여기 적지 않는다. 적으면 금방 최신이 아니게 된다.
//   현재 목록은 아래 명령으로 확인한다.
//   node bin/importers.mjs web/js/center/tab-store.js

const tabsBySpace = {};
const activeBySpace = {};
let centerSpace = null;

export function ensureTabSpace(space) {
  if (!tabsBySpace[space]) tabsBySpace[space] = [];
  return tabsBySpace[space];
}

export function getTabs(space) {
  return (space && tabsBySpace[space]) || [];
}

export function getCurrentTabs() {
  return getTabs(centerSpace);
}

export function getTabSpaces() {
  return Object.keys(tabsBySpace);
}

export function addTab(space, tab) {
  ensureTabSpace(space).push(tab);
  return tab;
}

export function removeTab(space, tab) {
  const list = tabsBySpace[space];
  if (!list) return false;
  const index = list.indexOf(tab);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

export function replaceTabs(space, tabs) {
  tabsBySpace[space] = tabs;
  return tabs;
}

export function getActiveTabId(space) {
  return activeBySpace[space];
}

export function setActiveTab(space, tabId) {
  activeBySpace[space] = tabId;
  return tabId;
}

export function getCenterSpace() {
  return centerSpace;
}

export function setCenterSpace(space) {
  centerSpace = space;
  return space;
}
