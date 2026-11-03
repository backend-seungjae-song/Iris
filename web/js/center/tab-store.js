// center 탭 저장소. 스페이스별 탭 목록과 활성 탭, 현재 center space를 한 곳에서 소유한다.
//
// 소유 범위
//   space별 center 탭 목록, space별 활성 탭 id, center가 현재 보여주는 space.
//
// 제공 API
//   목록·현재 space·활성 id query와 space 초기화·탭 추가/제거/교체·활성/space 변경 command.
//
// 의존 대상
//   pane-store의 칸 상태, tab-views의 화면 등록표, viewer.presentsTab 훅
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

import { callHook } from "../core/hooks.js";
import { tabViewOf } from "../core/tab-views.js";
import { paneActive, paneLayout, paneSelect, paneSync, paneVisible } from "./pane-store.js";

const tabsBySpace = {};
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
  paneSync(space, getTabs(space));
  return tab;
}

export function removeTab(space, tab) {
  const list = tabsBySpace[space];
  if (!list) return false;
  const index = list.indexOf(tab);
  if (index < 0) return false;
  list.splice(index, 1);
  paneSync(space, list);
  return true;
}

export function replaceTabs(space, tabs) {
  tabsBySpace[space] = tabs;
  paneSync(space, tabs);
  return tabs;
}

export function getActiveTabId(space) {
  return paneActive(space);
}

export function setActiveTab(space, tabId, index) {
  paneSync(space, getTabs(space));
  paneSelect(space, tabId, index);
  return tabId;
}

export function getCenterSpace() {
  return centerSpace;
}

export function setCenterSpace(space) {
  centerSpace = space;
  return space;
}

export function isTabVisible(space, tabId) {
  if (!paneVisible(space, tabId)) return false;
  const layout = paneLayout(space);
  if (!layout || layout.panes[layout.focus].active === tabId) return true;
  const tabs = getTabs(space);
  const tab = tabs.find((t) => t.id === tabId);
  const focused = tabs.find((t) => t.id === layout.panes[layout.focus].active);
  const panel = (t) => !t ? null : t.kind === "browser" ? "browserview"
    : t.kind === "file" ? (callHook("viewer.presentsTab", t) ? "fileview" : null)
      : tabViewOf(t.kind)?.panelId;
  const key = panel(tab);
  return !key || key !== panel(focused);
}
