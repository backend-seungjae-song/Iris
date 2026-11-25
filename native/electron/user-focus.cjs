// 브라우저 탭에 진짜 입력을 보내도 사용자 키보드 포커스가 그대로인지 판정하는 모듈
//
// 소유 범위
//   탭(webview guest)과 그 탭을 담은 창의 포커스 상태 조회, 진짜 누르기·CDP 글/키 허용 판정
//
// 제공 API
//   focusState(wc, { windowFocused, timeoutMs }) → Promise<{ owns, idle, windowFocused }>
//   canPress(state), canSendKeys(state): 값만 받는 판정
//   ownsUserFocus(wc) → Promise<boolean>: canSendKeys(await focusState(wc))
//   claimWindowFocus(wc) → Promise<boolean>: 그 창의 앱 셸에서 이 탭 webview 에 focus(). canPress 일 때만 부를 것
//   borrowWindowFocus(wc) → Promise<boolean>: 지금 포커스 요소를 저장하고 이 탭 webview 에 focus()
//   returnWindowFocus(wc) → Promise<"restored"|"blurred"|"moved"|null>: 저장한 요소로 포커스 반환
//   armAiFocus(wc) → Promise<boolean>: 뒤에 깐 AI 탭 조작 시작. 지금 포커스 요소를 저장하고, 그 탭 webview 가 포커스를 받으면 바로 다음 태스크에서 되돌리는 감시를 켬
//   releaseAiFocus(wc) → Promise<"restored"|"blurred"|"kept"|null>: 조작 끝. 감시를 끄고, 포커스가 아직 그 탭에 있고 그 탭이 뒤에 깔린 채일 때만 되돌림
//
// 의존 대상
//   wc.hostWebContents.executeJavaScript 하나와 호출부가 주는 windowFocused(host). Electron require 없음
//
// 유지 조건
//   wc.isFocused() 사용 금지: webview 에서는 창 전체 포커스 반환(크로미움 CrossProcessFrameConnector::HasFocus)
//   owns: 앱 셸 문서의 activeElement 가 이 탭의 webview. 키 입력이 가는 곳과 같이 움직임(실측)
//   idle: 그 창에 포커스된 요소 없음(activeElement 가 body 이거나 없음)
//   진짜 누르기는 그 탭을 담은 창 안의 포커스만 옮김(크로미움 SetFocusedFrameTree, 실측 probe/twowin)
//   → 누르기 허용: owns, 또는 idle 이면서 사용자가 그 창을 쓰고 있지 않음
//   CDP insertText·dispatchKeyEvent 는 그 창의 포커스 위젯으로 감 → 글/키 허용: owns 일 때만
//   앱 셸이 응답하지 않거나 오류면 owns·idle 모두 false(사용자 포커스를 옮기지 않는 쪽)
//   claimWindowFocus 는 그 창 안의 포커스만 바꿈. OS 창 활성화 없음(webview 요소 focus 는 렌더러 동작)
//   빌리기: QA 탭이 사용자가 쓰는 창(세션 탭 그룹)에 있을 때 진짜 입력 동안만 포커스를 가져오고 바로 반환
//   빌린 사이 사용자가 친 키는 QA 탭으로 감(사용자 2026-10-28 세션 탭 진행 선택)
//   반환 직전 포커스가 이 탭이 아니면 사용자가 옮긴 것이라 그대로 둠("moved")
//   뒤에 깐 AI 탭(사용자가 누를 수 없음)은 CDP 누르기가 창 안 포커스를 옮기므로 arm 으로 저장하고 감시해 포커스가 옮겨진 직후 되돌리고, release 가 남은 것을 되돌림
//   탭마다 따로 저장(wc id 표). 다른 AI 탭이 아직 되돌리는 중이라 포커스가 뒤 탭 webview 에 있으면 그 탭의 저장값을 이어받음
//   사용자가 그 탭을 앞으로 올려(ai-behind 해제) 직접 쓰는 포커스는 되돌리지 않음
//   빌리기·claim 은 의도한 포커스 이동이라 __irisQaBorrowed 로 감시에서 제외
//   뒤에 깐 탭의 CDP insertText·키는 그 창의 포커스 위젯으로 가므로(실측: 포커스가 다른 칸이면 그 칸에 글이 들어감) 누르기만 빌리지 않음
//   webview 사이 이동은 앞 요소 blur 뒤 focus 해야 게스트 키 입력도 옮겨 감(blur 없으면 글자가 앞 탭에 남음, 실측)
//
// 영향 범위
//   cdp-control.cjs 가 AI 입력 명령(click·dblclick·type·fill)과 QA 입력(qa-input)의 경로를 정할 때 호출

const DEFAULT_TIMEOUT_MS = 500;
const UNKNOWN = Object.freeze({ owns: false, idle: false, windowFocused: true });

function focusProbeExpression(wcId) {
  return `(() => { const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return "idle";
    try { return a.tagName === "WEBVIEW" && a.getWebContentsId() === ${Number(wcId)} ? "owns" : "other"; }
    catch (e) { return "other"; } })()`;
}

async function focusState(wc, { windowFocused = () => true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    const host = wc && !wc.isDestroyed() && wc.hostWebContents;
    if (!host || host.isDestroyed()) return UNKNOWN;
    const probe = Promise.resolve(host.executeJavaScript(focusProbeExpression(wc.id))).catch(() => null);
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const where = await Promise.race([probe, late]);
    if (where !== "owns" && where !== "idle" && where !== "other") return UNKNOWN;
    let focusedWin = true;
    try { focusedWin = windowFocused(host) !== false; } catch { focusedWin = true; }
    return { owns: where === "owns", idle: where === "idle", windowFocused: focusedWin };
  } catch {
    return UNKNOWN;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// QA 입력의 포커스 처리. quiet: 사용자가 최근 키를 치지 않았음
// - 사용자가 같은 창 다른 곳에서 치는 중에 빌리면 사용자 키가 QA 탭으로 감(사용자 2026-10-29) → 기다림
// pointerBehind: 뒤에 깐 AI 탭에 보내는 누르기. 포커스 에뮬레이션으로 도달하므로 빌리거나 기다리지 않음
function qaFocusPlan(state, quiet, pointerBehind = false) {
  if (pointerBehind || canSendKeys(state)) return "trusted";
  if (canPress(state)) return "claim";
  return quiet ? "borrow" : "wait";
}

const USER_QUIET_MS = 1500;
function userQuiet(lastKeyAt, now, quietMs = USER_QUIET_MS) {
  return !(lastKeyAt > 0) || now - lastKeyAt >= quietMs;
}

function canPress(state) { return !!state && (state.owns || (state.idle && !state.windowFocused)); }
function canSendKeys(state) { return !!state && state.owns === true; }

async function ownsUserFocus(wc, opts) { return canSendKeys(await focusState(wc, opts)); }

function claimExpression(wcId) {
  return `(() => { for (const el of document.querySelectorAll("webview")) {
    try { if (el.getWebContentsId() === ${Number(wcId)}) { document.__irisQaBorrowed = ${Number(wcId)};
      el.focus({ preventScroll: true }); return document.activeElement === el; } }
    catch (e) {} } return false; })()`;
}

async function claimWindowFocus(wc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    const host = wc && !wc.isDestroyed() && wc.hostWebContents;
    if (!host || host.isDestroyed()) return false;
    const done = Promise.resolve(host.executeJavaScript(claimExpression(wc.id))).catch(() => false);
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    return (await Promise.race([done, late])) === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function borrowExpression(wcId) {
  return `(() => { const prev = document.activeElement;
    for (const el of document.querySelectorAll("webview")) {
      try { if (el.getWebContentsId() === ${Number(wcId)}) {
        document.__irisQaPrevFocus = prev === el ? null : prev;
        document.__irisQaBorrowed = ${Number(wcId)};
        if (prev && prev !== el && typeof prev.blur === "function") prev.blur();
        el.focus({ preventScroll: true }); return document.activeElement === el; } }
      catch (e) {} } return false; })()`;
}

// 뒤에 깐 AI 탭 조작 중 감시. 같은 표현식 안에서 쓰는 보조 함수를 한 곳에 둠
const AI_FOCUS_HELPERS = `const S = document.__irisAiFocus || (document.__irisAiFocus = { prev: new Map(), handler: null });
    const behind = (el) => !!el && el.tagName === "WEBVIEW" && el.classList.contains("ai-behind");
    const idOf = (el) => { try { return el.getWebContentsId(); } catch (e) { return 0; } };
    const back = (prev, el) => { if (typeof el.blur === "function") el.blur();
      if (prev && prev.isConnected !== false && typeof prev.focus === "function") prev.focus({ preventScroll: true }); };`;

function armExpression(wcId) {
  return `(() => { const id = ${Number(wcId)}; ${AI_FOCUS_HELPERS}
    if (!S.handler) {
      // webview 가 포커스를 받을 때는 그 요소에 focus·focusin 이 오지 않고(실측) 앞 포커스 요소의 focusout 만 오며,
      // 그 시점 activeElement 는 아직 앞 요소라 다음 태스크에서 확인
      S.check = () => { for (const [wc, prev] of S.prev) {
        if (document.__irisQaBorrowed === wc) continue;
        for (const el of document.querySelectorAll("webview")) if (behind(el) && idOf(el) === wc && document.activeElement === el) back(prev, el); } };
      S.handler = () => setTimeout(S.check, 0);
      document.addEventListener("focusout", S.handler, true);
    }
    const a = document.activeElement;
    if (!S.prev.has(id)) {
      let prev = a && a !== document.body && a !== document.documentElement ? a : null;
      if (behind(a)) { prev = null; for (const v of S.prev.values()) if (v) { prev = v; break; } }
      S.prev.set(id, prev);
    }
    return true; })()`;
}

function releaseExpression(wcId) {
  return `(() => { const id = ${Number(wcId)}; ${AI_FOCUS_HELPERS}
    if (!S.prev.has(id)) return "kept";
    const prev = S.prev.get(id); S.prev.delete(id);
    if (!S.prev.size && S.handler) { document.removeEventListener("focusout", S.handler, true); S.handler = null; }
    if (document.__irisQaBorrowed === id) document.__irisQaBorrowed = 0;
    let wv = null;
    for (const el of document.querySelectorAll("webview")) if (idOf(el) === id) { wv = el; break; }
    if (!wv || document.activeElement !== wv || !behind(wv)) return "kept";
    back(prev, wv);
    return prev ? "restored" : "blurred"; })()`;
}

function returnExpression(wcId) {
  return `(() => { const prev = document.__irisQaPrevFocus; document.__irisQaPrevFocus = null; document.__irisQaBorrowed = 0;
    const a = document.activeElement;
    let mine = false; try { mine = !!a && a.tagName === "WEBVIEW" && a.getWebContentsId() === ${Number(wcId)}; } catch (e) {}
    if (!mine) return "moved";
    if (prev && prev !== document.body && prev !== document.documentElement && prev.isConnected !== false && typeof prev.focus === "function") {
      if (typeof a.blur === "function") a.blur();
      prev.focus({ preventScroll: true }); return "restored"; }
    if (typeof a.blur === "function") a.blur(); return "blurred"; })()`;
}

async function runInHost(wc, expression, timeoutMs, fallback) {
  let timer = null;
  try {
    const host = wc && !wc.isDestroyed() && wc.hostWebContents;
    if (!host || host.isDestroyed()) return fallback;
    const done = Promise.resolve(host.executeJavaScript(expression)).catch(() => fallback);
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
    return await Promise.race([done, late]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function borrowWindowFocus(wc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return (await runInHost(wc, borrowExpression(wc && wc.id), timeoutMs, false)) === true;
}
async function armAiFocus(wc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return (await runInHost(wc, armExpression(wc && wc.id), timeoutMs, false)) === true;
}
async function releaseAiFocus(wc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const out = await runInHost(wc, releaseExpression(wc && wc.id), timeoutMs, null);
  return ["restored", "blurred", "kept"].includes(out) ? out : null;
}
async function returnWindowFocus(wc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const out = await runInHost(wc, returnExpression(wc && wc.id), timeoutMs, null);
  return ["restored", "blurred", "moved"].includes(out) ? out : null;
}

module.exports = { qaFocusPlan, userQuiet, focusState, canPress, canSendKeys, ownsUserFocus, claimWindowFocus, borrowWindowFocus, armAiFocus, releaseAiFocus, returnWindowFocus, focusProbeExpression };
