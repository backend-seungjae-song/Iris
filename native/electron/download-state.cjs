// 다운로드 자동 저장 계획의 단일 상태 소유 모듈.
//
// 소유 범위
//   공유 다운로드 폴더·one-shot 표식·진행 중 경로·마지막 완료 결과.
//
// 제공 API
//   arm(dir, once) · disarm() · claim(path) · complete(path, state) · blocked(info) · snapshot().
//   원시 상태 객체는 제공하지 않는다.
//
// 의존 대상
//   다른 모듈이나 Electron에 기대지 않는다. 경로 검증·예약·해제는 main.cjs가 소유한다.
//
// 유지 조건
//   폴더 선택은 모든 탭에 공유되고 one-shot은 저장 경로를 정한 뒤 한 번만 해제된다.
//   완료는 성공·실패와 무관하게 pending을 비우고 그때의 경로·상태·시각을 마지막 결과로 남긴다.
//   차단된 내려받기도 마지막 결과와 같은 자리에 사유와 함께 남긴다. 기록 없이 사라지면
//   호출자가 사이트가 막은 것으로 잘못 판단한다.
//
// 영향 범위
//   양방향 소비자는 cdp-control.cjs의 download/observe 명령과 main.cjs의 will-download 훅이다.
//   공급자인 main.cjs의 safeDownloadName·reserveDownloadPath·reservedPaths 및 Electron item done
//   순서가 이 상태 전이와 짝을 이루며, 결과는 CLI·MCP의 download/observe 응답까지 번진다.

const downloadPlan = {
  dir: null,
  once: false,
  last: null,
  pending: null,
};

function arm(dir, once) {
  downloadPlan.dir = dir;
  downloadPlan.once = once;
}

function disarm() {
  downloadPlan.dir = null;
  downloadPlan.once = false;
}

function claim(path) {
  downloadPlan.pending = path;
  if (downloadPlan.once) {
    downloadPlan.dir = null;
    downloadPlan.once = false;
  }
}

function complete(path, state) {
  downloadPlan.pending = null;
  downloadPlan.last = { path, state, at: Date.now() };
}

// 저장 위치를 정하지 않은 채 시작해 취소된 내려받기. 저장 창을 띄우지 않는 대신 사유를 남긴다.
function blocked(info) {
  downloadPlan.last = { blocked: true, ...(info || {}), at: Date.now() };
}

function snapshot() {
  return {
    dir: downloadPlan.dir,
    once: downloadPlan.once,
    last: downloadPlan.last,
    pending: downloadPlan.pending,
  };
}

module.exports = { arm, disarm, claim, complete, blocked, snapshot };
