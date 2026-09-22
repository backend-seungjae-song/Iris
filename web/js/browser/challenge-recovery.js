// claude.ai 보안확인 복구. Cloudflare managed challenge 전면 인터스티셜에 갇힌 탭을 감지해
// 목적지로 깨끗이 재진입시킨다.
//
// 소유 범위
//   challenge.navigation 훅 하나. claude.ai/api/challenge_redirect 착지 감지, 대기 시간이 지나도
//   그 자리에 그대로면 wedge 로 보고, 같은 webview 를 목적지로 다시 읽는다. 재진입 상한과
//   그 뒤의 조용한 알림.
//
// 제공 API
//   initCapability(ctx). 이 기능의 진입점으로 challenge.navigation 훅을 채운다.
//   challengeTarget(url) · createChallengeRecoveryStateMachine(...). 검사·재사용을 위해 함께 내준다.
//
// 의존 대상
//   앱 셸의 challenge.navigation 발화(browser/webview-factory.js), ctx.showToast, ctx.blog.
//   rail·슬롯·화면·서버 파일 없음.
//
// 유지 조건
//   진짜 Chrome 을 spawn 하지 않는다. 포커스를 빼앗기 때문이다. 별도 로그인도 없다.
//   같은 webview 를 목적지로 다시 읽을 뿐이다(fresh challenge 를 새로 받는다).
//   정상 challenge(대기 시간 안에 스스로 빠져나감)는 건드리지 않는다. timer 가 fire 하기 전에
//   상태가 지워진다. challenge_redirect 가 아닌 URL 은 challengeTarget 가 null 이라 아무 일도 없다.
//   쿠키·__cf_chl 토큰·raw 쿼리는 로그하지 않고 origin+pathname 만 남긴다. 예외 메시지도
//   원문을 남기지 않는다(그 안에 URL 이 들 수 있다).
//   같은 wedge episode 안에서 상한(MAX_RENAV)에 도달하면 멈추고(gaveUp) 사람에게 넘긴다.
//   목적지로 재진입할 때 잠깐 뜨는 성공 commit 이 카운터를 리셋해 무한 재진입이 되지 않게,
//   리셋은 "비-challenge 페이지에 확인 시간(okMs)만큼 머물렀다"로만 한다.
//   같은 challenge 로 start 가 다시 와도 돌던 timer 를 폐기하지 않는다. 자체 reload 하는 wedge 를
//   누적 체류로 잡기 위해서다.
//
// 영향 범위
//   browser/webview-factory.js 가 top navigation 마다 challenge.navigation 을 발화한다(start·commit·destroy).
//   core/capabilities.js 표의 challengerecovery 줄이 이 파일을 로드한다.

import { provide } from "../core/hooks.js";

const CHALLENGE_WAIT_MS = 15000; // 정상 challenge 는 이 안에 리다이렉트로 빠져나간다. 넘으면 wedge.
const OK_CONFIRM_MS = 10000;     // 비-challenge 페이지에 이만큼 머물면 진짜 탈출로 보고 상한 리셋.
const MAX_RENAV = 2;             // 한 episode 에서 재진입 상한. 넘으면 멈추고 조용한 알림.
const CLAUDE_ORIGIN = "https://claude.ai";

// challenge_redirect URL 이면 그 안의 to= 목적지(claude.ai 만)를 돌려준다. 아니면 null.
// to= 는 절대 URL 일 수도, /new 같은 상대경로일 수도 있어 claude.ai 기준으로 해석한다.
export function challengeTarget(url) {
  let wrapper;
  try { wrapper = new URL(String(url || "")); } catch { return null; }
  if (wrapper.protocol !== "https:" || wrapper.hostname !== "claude.ai" || wrapper.port ||
      wrapper.pathname !== "/api/challenge_redirect") return null;
  const raw = wrapper.searchParams.get("to");
  if (!raw) return null;
  try {
    const target = new URL(raw, CLAUDE_ORIGIN);
    return target.origin === CLAUDE_ORIGIN ? target.href : null;
  } catch { return null; }
}

// navigation 의미와 timer 는 여기가 가진다. 앱 셸은 top navigation 을 훅으로 넘길 뿐이며, 쿠키 값이나
// source profile 은 이 상태 머신에 들어오지 않는다.
export function createChallengeRecoveryStateMachine({
  waitMs = CHALLENGE_WAIT_MS,
  okMs = OK_CONFIRM_MS,
  maxRenav = MAX_RENAV,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  recover, // (rec, target, attempt) => void. attempt 은 1..maxRenav+1 (maxRenav+1 은 "멈춤" 신호)
  currentUrl = (rec) => {
    try { return String(rec.el.getURL() || rec.url || ""); } catch { return String(rec.url || ""); }
  },
} = {}) {
  // rec -> { chalTarget, chalTimer, okTimer, attempt, gaveUp }
  const info = new WeakMap();

  function seat(rec) {
    let s = info.get(rec);
    if (!s) { s = { chalTarget: null, chalTimer: null, okTimer: null, attempt: 0, gaveUp: false }; info.set(rec, s); }
    return s;
  }
  function clearChal(s) { if (s.chalTimer) { clearTimer(s.chalTimer); s.chalTimer = null; } s.chalTarget = null; }
  function clearOk(s) { if (s.okTimer) { clearTimer(s.okTimer); s.okTimer = null; } }

  function fireWedge(rec, s, target) {
    if (info.get(rec) !== s || s.chalTarget !== target) return; // 그새 바뀜
    s.chalTimer = null;
    if (challengeTarget(currentUrl(rec)) !== target) { s.chalTarget = null; return; } // 이미 빠져나감
    s.chalTarget = null;
    if (s.gaveUp) return;
    s.attempt += 1;
    try { if (recover) recover(rec, target, s.attempt); } catch {}
    if (s.attempt > maxRenav) s.gaveUp = true;
  }

  function armChal(rec, s, target) {
    // 같은 challenge 로 다시 와도 돌던 timer 는 그대로 둔다(누적 체류로 wedge 를 잡는다).
    if (s.chalTarget === target && s.chalTimer) return;
    clearChal(s);
    s.chalTarget = target;
    s.chalTimer = setTimer(() => fireWedge(rec, s, target), waitMs);
  }

  function armOk(rec, s) {
    if (s.okTimer) return; // 이미 확인 대기 중
    s.okTimer = setTimer(() => {
      s.okTimer = null;
      // 확인 시간 동안 challenge 로 돌아가지 않았으면 탈출로 보고 상한을 새 episode 로 리셋한다.
      if (!s.chalTarget && challengeTarget(currentUrl(rec)) === null) { s.attempt = 0; s.gaveUp = false; }
    }, okMs);
  }

  function navigation(rec, event = {}) {
    if (!rec || event.isMainFrame === false) return;
    const phase = event.phase === "destroy" ? "destroy" : event.phase === "start" ? "start" : "commit";
    const url = String(event.url || "");
    const target = challengeTarget(url);
    const s = seat(rec);

    if (phase === "destroy") { clearChal(s); clearOk(s); info.delete(rec); return; }

    if (target) {
      // challenge 로 (다시) 들어왔다. 성공 확인 대기를 취소하고 wedge timer 를 (없으면) 건다.
      clearOk(s);
      armChal(rec, s, target);
      return;
    }

    // 비-challenge navigation.
    clearChal(s);
    if (phase === "commit" && /^https:\/\/claude\.ai\//.test(url)) armOk(rec, s); // 탈출 여부는 okMs 뒤 확인
  }

  return {
    navigation,
    attemptsFor: (rec) => (info.get(rec) || {}).attempt || 0,
    gaveUpFor: (rec) => !!(info.get(rec) || {}).gaveUp,
    stateFor: (rec) => info.get(rec) || null,
    maxRenav,
  };
}

let recovery = null;
let toast = () => {};
let log = () => {};

// 로그에 토큰·쿼리를 남기지 않고 origin+pathname 만 남긴다.
function safeLabel(url) {
  try { const u = new URL(String(url || "")); return u.origin + u.pathname; } catch { return "(url)"; }
}

function renavigate(rec, target, attempt) {
  if (!rec || !rec.el) return;
  const safe = safeLabel(target);
  if (attempt > MAX_RENAV) {
    // episode 에서 처음 상한을 넘는 순간에만 알린다. 이후 같은 episode 에서는 알리지 않는다(gaveUp).
    log(`[challenge-recovery] ${safe} 재진입 ${MAX_RENAV}회 실패: 멈추고 사람에게 넘김`);
    try { toast("claude.ai 보안 확인이 계속 막힙니다. 새로고침으로 다시 시도해 주세요."); } catch {}
    return;
  }
  log(`[challenge-recovery] wedge 감지 → 재진입 ${attempt}/${MAX_RENAV}: ${safe}`);
  try {
    // 캐시 우회로 새 challenge 를 받는다. 같은 webview 라 포커스는 움직이지 않는다.
    // loadURL 은 Promise 를 돌려주고 실패는 rejection 이므로, 삼키지 말고 잡아 남긴다(원문 URL 은 남기지 않는다).
    Promise.resolve(rec.el.loadURL(target, { extraHeaders: "pragma: no-cache\ncache-control: no-cache" }))
      .catch((e) => log(`[challenge-recovery] 재진입 실패(${safe}): ${(e && e.name) || "load 오류"}`));
  } catch (e) {
    log(`[challenge-recovery] 재진입 실패(${safe}): ${(e && e.name) || "예외"}`);
  }
}

export function initCapability(ctx = {}) {
  toast = typeof ctx.showToast === "function" ? ctx.showToast : () => {};
  log = typeof ctx.blog === "function" ? ctx.blog : (...a) => { try { console.log(...a); } catch {} };
  recovery = createChallengeRecoveryStateMachine({ recover: renavigate });
  provide("challenge.navigation", (rec, event) => recovery.navigation(rec, event));
  return {};
}
