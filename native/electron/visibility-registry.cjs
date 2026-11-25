// Electron host별 현재 보이는 guest 장부.
//
// 소유 범위
//   host webContents ID에서 그 host가 마지막으로 보고한 visible guest ID로 가는 관계.
//
// 제공 API
//   report(hostId, guestId) · dropHost(hostId) · shownForHost(hostId) · hasHost(hostId) ·
//   isShown(guestId) · isKnown() · reportBehind(hostId, guestIds) · dropBehind(hostId) ·
//   isBehind(guestId). 원시 Map은 제공하지 않는다.
//
// 의존 대상
//   다른 모듈이나 Electron에 기대지 않는다. 호출자가 host·guest의 안정된 ID를 넘긴다.
//
// 유지 조건
//   뒤에 깔린 guest(AI 가 쓰는 탭을 패널 크기로 숨겨 둔 것)는 보이는 guest 와 다른 장부다. 사람에게
//   안 보이므로 isShown 은 거짓이고, 크기 보정·캡처 유지만 건너뛴다. host마다 마지막 보고가 전체 목록이다.
//   host마다 마지막 guest 하나만 보인다고 판정하고 host 파기 시 그 관계를 지운다. 한 host를
//   지워도 다른 host의 guest는 남아야 하며, 알려진 host가 하나도 없으면 visibility는 unknown이다.
//
// 영향 범위
//   공급자는 preload의 ac-tab-shown 보고와 main.cjs의 host destroyed 수명주기이고, 양방향
//   소비자는 main.cjs throttle·hidden viewport adapter와 cdp-control.cjs의 shown/known probe다.
//   잘못 남은 관계는 배경 탭 capture hold·키 입력·viewport 보정까지 번진다.

const shownByHost = new Map();
const behindByHost = new Map();

function report(hostId, guestId) {
  shownByHost.set(hostId, guestId);
}

function dropHost(hostId) {
  const previous = shownByHost.get(hostId);
  shownByHost.delete(hostId);
  return previous;
}

function shownForHost(hostId) {
  return shownByHost.get(hostId);
}

function hasHost(hostId) {
  return shownByHost.has(hostId);
}

function isShown(guestId) {
  for (const visible of shownByHost.values()) if (visible === guestId) return true;
  return false;
}

// 새로 깔린 탭(fresh)과 이번 보고에서 빠진 탭(left)을 돌려줌: 호출부가 대체 크기 해제·재적용에 씀
function reportBehind(hostId, guestIds) {
  const before = behindByHost.get(hostId) || new Set();
  const next = new Set(guestIds);
  if (next.size) behindByHost.set(hostId, next);
  else behindByHost.delete(hostId);
  return { fresh: guestIds.filter((id) => !before.has(id)), left: [...before].filter((id) => !next.has(id)) };
}

function dropBehind(hostId) {
  behindByHost.delete(hostId);
}

function isBehind(guestId) {
  for (const ids of behindByHost.values()) if (ids.has(guestId)) return true;
  return false;
}

function isKnown() {
  return shownByHost.size > 0;
}

module.exports = { report, dropHost, shownForHost, hasHost, isShown, isKnown, reportBehind, dropBehind, isBehind };
