// AI 명령이 지금 그 탭을 조작 중인지 판정하는 단일 소유 모듈.
//
// 소유 범위
//   webContents ID별 실행 중인 AI 명령 수와, 마지막 명령이 끝난 뒤의 짧은 유예 종료 시각.
//
// 제공 API
//   createAiCausality({ now, graceMs })가 enter(wcId) · leave(ticket) · driving(wcId) ·
//   anyDriving() · hold(wcId) 를 준다. 원시 Map 은 내주지 않는다.
//   hold 는 명령이 아니라 그 명령이 만든 팝업·새 탭이 준비될 때까지 표식을 유지하는 수단이다.
//
// 의존 대상
//   시계 하나뿐이다. Electron 도 CDP 도 참조하지 않으므로 검사가 경계 시각을 직접 지정할 수 있다.
//
// 유지 조건
//   실행 중인 명령이 하나라도 남아 있으면 참이다. 시각만으로 판정하면 오래 걸리는 명령 도중에
//   거짓이 되고, 그때 뜬 팝업·저장 창이 사용자 조작으로 오인돼 앞으로 나온다.
//   짝이 맞지 않는 leave 는 개수를 음수로 만들지 않는다. 유예는 enter 와 leave 양쪽에서 연장한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs 의 명령 진입·종료이고, 소비자는 팝업·새 탭·파일 선택창·저장 창·
//   카메라 권한의 사용자 조작 여부 판정이다. 여기가 틀리면 사용자 조작이 조용히 취소되거나
//   AI 가 연 창이 사용자 화면을 덮는다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/ai-causality.cjs

const DEFAULT_GRACE_MS = 600;
const PRUNE_OVER = 64;

function createAiCausality({ now = Date.now, graceMs = DEFAULT_GRACE_MS } = {}) {
  const inFlight = new Map();
  const until = new Map();

  function prune() {
    if (until.size <= PRUNE_OVER) return;
    const t = now();
    for (const [key, end] of until) if (end <= t && !inFlight.get(key)) until.delete(key);
  }

  function enter(wcId) {
    const id = Number(wcId);
    if (!Number.isFinite(id)) return null;
    prune();
    inFlight.set(id, (inFlight.get(id) || 0) + 1);
    until.set(id, now() + graceMs);
    return id;
  }

  function leave(ticket) {
    if (ticket == null) return;
    const left = (inFlight.get(ticket) || 0) - 1;
    if (left > 0) inFlight.set(ticket, left); else inFlight.delete(ticket);
    until.set(ticket, now() + graceMs);
  }

  function driving(wcId) {
    const id = Number(wcId);
    if (inFlight.get(id)) return true;
    const end = until.get(id);
    if (end == null) return false;
    if (end > now()) return true;
    until.delete(id);
    return false;
  }

  // 어느 탭에서든 AI 명령이 실행 중인가. 그 순간 새로 생기는 창·webview 는 그 명령이 만든 것이고,
  // 자기 wc 에는 아직 표식이 없다. 그 자리에서 표식을 물려주려면 이 판정이 필요하다.
  function anyDriving() {
    if (inFlight.size) return true;
    const t = now();
    for (const end of until.values()) if (end > t) return true;
    return false;
  }

  // 명령이 아니라 그 결과물에 표식을 붙인다. 생성된 창이 로드되는 동안 내려받기·권한 창을
  // 열 수 있는데 그 wc 에는 명령이 실행되지 않으므로, 해제할 때까지 참으로 둔다.
  function hold(wcId) {
    const ticket = enter(wcId);
    let done = false;
    return () => { if (done) return; done = true; leave(ticket); };
  }

  return { enter, leave, driving, anyDriving, hold };
}

module.exports = { createAiCausality, DEFAULT_GRACE_MS };
