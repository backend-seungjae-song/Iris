// 배경 탭 캡처 hold의 탭별 참조 횟수 소유 모듈.
//
// 소유 범위
//   webContents ID별 겹친 capture hold 개수와 0 아래로 내려가지 않는 상태 전이.
//
// 제공 API
//   update(id, on)은 전후 개수와 처음/마지막 edge를 돌려준다.
//   clear(id)는 호출자가 폐기하기로 한 장부를 지우고 count(id)는 현재 개수만 조회한다.
//   원시 Map은 내주지 않는다.
//
// 의존 대상
//   다른 모듈이나 Electron에 기대지 않는다. 호출자가 안정된 탭 ID와 hold/release 뜻만 넘긴다.
//
// 유지 조건
//   첫 hold와 마지막 release만 edge다. 안쪽 hold가 먼저 풀려도 바깥 hold는 남고, 짝이 없는
//   release도 개수를 음수로 만들지 않는다. 호출자가 clear를 요청한 ID의 장부만 즉시 비운다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 key·command paint·moment capture hold/finally 호출이고, 양방향
//   소비자는 main.cjs의 Electron guest/host adapter와 webview-throttle이다. edge 판정은 preload의
//   ac-capture-hold와 배경 탭 합성·키 입력·순간 UI screenshot 타이밍에도 영향을 준다.

const holdCounts = new Map();

function update(id, on) {
  const before = holdCounts.get(id) || 0;
  const after = Math.max(0, on ? before + 1 : before - 1);
  if (after > 0) holdCounts.set(id, after);
  if (after === 0) holdCounts.delete(id);
  return {
    before,
    after,
    edge: on ? before === 0 : after === 0,
  };
}

function clear(id) {
  holdCounts.delete(id);
}

function count(id) {
  return holdCounts.get(id) || 0;
}

module.exports = { update, clear, count };
