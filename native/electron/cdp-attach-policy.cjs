// 탭에 CDP(webContents.debugger)를 붙여 둘지 정하는 단일 소유 모듈.
//
// 소유 범위
//   webContents ID별 AI 조작 창(마지막 명령 시각 + 유휴 창)과 유휴 판정 타이머, 부착 금지 호스트 판정.
//
// 제공 API
//   createCdpAttachPolicy(deps)가 touch · release · reconsider · forget · engaged · wants · blocked ·
//   allowAttach 를 준다. 원시 Map 이나 타이머는 내주지 않는다.
//
// 의존 대상
//   시계·타이머와 호출자가 주입하는 판정(유지 조건 keepers, 금지 URL, 현재 URL, 실제 detach).
//   Electron 이나 CDP 를 직접 참조하지 않으므로 검사가 경계 시각을 직접 정한다.
//
// 유지 조건
//   붙여 두는 시간은 AI 명령이 들어온 뒤 유휴 창 안이거나 keepers 중 하나가 참인 동안뿐이다.
//   금지 호스트 문서에서는 어느 조건이어도 붙이지 않는다. 유휴 판정은 타이머 한 개로만 하고, 명령마다
//   같은 타이머를 미룬다. release 는 창을 즉시 닫고 판정을 바로 실행한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs 의 명령 진입·종료와 webview-lifecycle 의 탐색 훅이다. 소비자는
//   cdp-session 의 attach 관문과 detachIdle 이다. 여기가 틀리면 사람이 쓰는 탭에 CDP 가 남거나(봇 판정),
//   AI 가 쓰는 도중 세션이 끊겨 snapshot ref 가 무효가 된다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/cdp-attach-policy.cjs

// LLM 한 회차 사이의 간격은 수 초에서 수십 초다. 명령 단위로 떼면 매 회차 ref 가 죽으므로 창을 둔다.
const DEFAULT_IDLE_MS = 30000;

function createCdpAttachPolicy({
  now = Date.now,
  idleMs = DEFAULT_IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  keepers = [],
  blockedUrl = () => false,
  currentUrl = () => "",
  detach = () => {},
} = {}) {
  const until = new Map();   // wcId → AI 조작 창이 끝나는 시각
  const timers = new Map();  // wcId → 유휴 판정 타이머

  function key(wcId) {
    const id = Number(wcId);
    return Number.isFinite(id) ? id : null;
  }

  function engaged(wcId) {
    const id = key(wcId);
    if (id === null) return false;
    const end = until.get(id);
    if (end == null) return false;
    if (end > now()) return true;
    until.delete(id);
    return false;
  }

  function kept(id) {
    for (const keeper of keepers) {
      try { if (keeper(id)) return true; } catch {}
    }
    return false;
  }

  function wants(wcId) {
    const id = key(wcId);
    if (id === null) return false;
    return engaged(id) || kept(id);
  }

  function blocked(wcId) {
    const id = key(wcId);
    if (id === null) return false;
    let url = "";
    try { url = String(currentUrl(id) || ""); } catch { url = ""; }
    return !!blockedUrl(url);
  }

  function allowAttach(wcId) { return !blocked(wcId); }

  function check(id) {
    timers.delete(id);
    if (blocked(id) || !wants(id)) { try { detach(id); } catch {} }
  }

  function schedule(id, delay) {
    const previous = timers.get(id);
    if (previous) clearTimer(previous);
    const timer = setTimer(() => check(id), Math.max(0, delay));
    try { timer.unref?.(); } catch {}
    timers.set(id, timer);
  }

  // AI 명령이 이 탭에 들어왔다. 창을 지금부터 유휴 창만큼 미루고 판정을 그 끝으로 옮긴다.
  function touch(wcId) {
    const id = key(wcId);
    if (id === null) return;
    until.set(id, now() + idleMs);
    schedule(id, idleMs);
  }

  // 사람에게 넘기는 순간. 창을 즉시 닫고 유지 조건이 없으면 바로 뗀다.
  function release(wcId) {
    const id = key(wcId);
    if (id === null) return;
    until.delete(id);
    const previous = timers.get(id);
    if (previous) clearTimer(previous);
    check(id);
  }

  // 유지 조건이 꺼졌거나 금지 호스트로 들어갔다. 다음 틱에 판정한다.
  function reconsider(wcId) {
    const id = key(wcId);
    if (id === null) return;
    schedule(id, 0);
  }

  function forget(wcId) {
    const id = key(wcId);
    if (id === null) return;
    until.delete(id);
    const previous = timers.get(id);
    if (previous) clearTimer(previous);
    timers.delete(id);
  }

  return { touch, release, reconsider, forget, engaged, wants, blocked, allowAttach };
}

module.exports = { createCdpAttachPolicy, DEFAULT_IDLE_MS };
