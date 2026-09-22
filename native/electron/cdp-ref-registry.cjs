// CDP snapshot ref와 navigation 세대를 함께 소유하는 registry.
//
// 소유 범위
//   탭별 마지막 snapshot ref map, 현재 navigation 세대, snapshot을 기록한 navigation 세대.
//
// 제공 API
//   bumpNavigation(id) · navigationEpoch(id) · recordSnapshot(id, refMap) · resolveRef(id, ref),
//   clearSnapshot(id) · clear(id). 원시 Map은 내주지 않는다.
//
// 의존 대상
//   다른 모듈에 기대지 않는다. 탭 ID와 snapshot-engine이 만든 refMap만 값으로 받는다.
//
// 유지 조건
//   ref는 탭 하나와 그 탭의 navigation 세대 하나에만 유효하다. snapshot이 없거나 페이지가
//   이동한 뒤에는 기존 코드·문구로 실패하고, 다른 탭이나 이전 문서의 노드를 돌려주지 않는다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 navigation 이벤트와 snapshot-engine 결과이고, 양방향 소비자는
//   cdp-control.cjs의 snapshot 기록·ref 입력 명령·세션 reset/destroy·키보드 focus 세대 판정이다.
//   반환한 ref entry는 click·fill·overlay·screenshot 경로와 OOPIF session 선택에도 영향을 준다.

const refMaps = new Map();
const navEpochs = new Map();
const snapEpochs = new Map();

function refError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function navigationEpoch(id) {
  return navEpochs.get(id) || 0;
}

function bumpNavigation(id) {
  navEpochs.set(id, navigationEpoch(id) + 1);
}

function recordSnapshot(id, refMap) {
  refMaps.set(id, refMap);
  snapEpochs.set(id, navigationEpoch(id));
}

function resolveRef(id, ref) {
  const refMap = refMaps.get(id);
  if (!refMap || !snapEpochs.has(id)) {
    throw refError("no_snapshot", "이 탭에서 먼저 snapshot을 실행하세요(ref 맵 없음).");
  }
  if (snapEpochs.get(id) !== navigationEpoch(id)) {
    throw refError("stale_ref", "페이지가 이동되어 ref가 만료됐습니다 — 재-snapshot 필요.");
  }
  const entry = refMap.get(ref);
  if (!entry) throw refError("not_found", "알 수 없는 ref: " + ref);
  return entry;
}

function clearSnapshot(id) {
  refMaps.delete(id);
  snapEpochs.delete(id);
}

function clear(id) {
  refMaps.delete(id);
  navEpochs.delete(id);
  snapEpochs.delete(id);
}

module.exports = {
  bumpNavigation,
  navigationEpoch,
  recordSnapshot,
  resolveRef,
  clearSnapshot,
  clear,
};
