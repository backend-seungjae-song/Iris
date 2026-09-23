// 작업 화면 배치에 기능이 기여하는 영역의 등록표. 앱 셸의 배치 엔진(layout-engine.js)은 이 표만 읽고
// 기능 이름을 모른다.
//
// 제공 API
//   registerLayoutRegion({ id, label, el, visible, size }) · layoutRegions() · notifyLayout() · onLayoutChange(fn)
//   el: 영역 요소(.app 의 자식). visible(): 지금 자리를 차지하는가. size: 처음 놓일 때의 폭(px).
//   영역의 보임이 바뀌면 기능이 notifyLayout() 을 부른다.
//
// 유지 조건
//   영역 요소는 기능이 .app 에 한 번 붙이고 옮기지 않는다. 엔진은 위치와 크기만 정한다.
//
// 영향 범위
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/core/layout-regions.js

const regions = new Map();
const subs = new Set();

export function registerLayoutRegion(def) {
  if (!def || !/^[\w.-]{1,40}$/.test(String(def.id)) || regions.has(def.id)) return false;
  regions.set(def.id, def);
  notifyLayout();
  return true;
}

export function layoutRegions() { return [...regions.values()]; }

export function notifyLayout() { for (const fn of subs) { try { fn(); } catch {} } }

export function onLayoutChange(fn) { subs.add(fn); return () => subs.delete(fn); }
