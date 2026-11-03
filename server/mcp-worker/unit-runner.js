// 명령 단위 실행 공통 · 일반 MCP 명령(browser-service)·QA 명령(qa-service)·host 작업(host-task-service)이 같이 씀
// 처리기가 부른 기본 명령들을 메인의 탭 대기열 안에서 한 단위로 보냄

export function commandResponse(output) {
  if (output && typeof output === "object" && Object.hasOwn(output, "ok")) {
    const { commandState: _commandState, ...response } = output;
    return response;
  }
  return { ok: true, data: output ?? null };
}

// 응답에 현재 문서·debugger 세대를 실어 보내는 기본 명령 · 처리기가 스스로 세대를 올린 뒤(붙임·탐색·재설정) 이어 호출함
const GENERATION_COMMANDS = new Set(["cdp.attach", "cdp.detachIdle", "cdp.gate", "cdp.sync", "cdp.reset", "wc.nav", "wc.navHistory"]);

// 응답의 세대만 바꾼 새 target token
export function refreshedToken(token, generations) {
  const next = { ...token };
  for (const field of ["documentGeneration", "debuggerGeneration"]) {
    if (Number.isSafeInteger(generations?.[field])) next[field] = generations[field];
  }
  return next;
}

// 메인이 등록 때 알린 기능 · 조회 실패는 없음으로 취급
export async function mainHasFeatures(call, features) {
  try {
    const status = await call("browser.status", {});
    return features.every(feature => status?.executor?.features?.includes(feature) === true);
  } catch { return false; }
}

// 마지막 호출에 last 를 달아 단위를 닫음 · 마지막 호출이 끝나지 못했으면(오류·확인 창 차단) 명시 종료를 보냄
// outside 이면 단위 표시에 outside 를 달아 메인이 탭 대기열·host 가 탭 잠금 단위 보유 밖에서 실행하게 함 (확인 창을 푸는 명령)
// context 는 처리기에 {args, base} 와 함께 넘기는 값 (이벤트 구독 등)
// 실행 전에 거절된 세대 불일치 · host 의 token 대조(STALE_TARGET 오류)와 메인 중계 검사(실행 전 거절 응답) 둘 다
// 명령 도중 클릭·SPA 주소 변경·debugger 재부착으로 세대가 오르면 생김 · 실행되지 않았으므로 새 token 으로 다시 보내도 안전
// 이동 전 snapshot ref 는 메인의 stale_ref 검사가 따로 막음
const STALE_RELAY = /대상의 문서 또는 debugger 세대가 바뀌었습니다|현재 문서 세대의 target token이 아닙니다/;
export const staleTarget = (raw) => raw?.ok === false && (raw.code === "STALE_TARGET" || STALE_RELAY.test(String(raw.error || "")));
const STALE_RETRIES = 4;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// relayCall 하나를 보내고 세대 불일치면 refreshToken 으로 받은 현재 token 으로 다시 보냄
// 서버의 세대 표는 메인 알림으로 늦게 갱신될 수 있어 재시도마다 조금씩 기다림
export async function relayWithFreshToken(send, token, refreshToken) {
  let current = token;
  for (let attempt = 0; ; attempt++) {
    let raw, thrown;
    try { raw = await send(current); }
    catch (error) {
      if (error?.code !== "STALE_TARGET") throw error;
      thrown = error;
    }
    const stale = thrown || staleTarget(raw);
    if (!stale || typeof refreshToken !== "function" || attempt >= STALE_RETRIES) {
      if (thrown) throw thrown;
      return { raw, token: current };
    }
    await pause(50 * (attempt + 1));
    const fresh = await refreshToken();
    if (fresh) current = fresh;
  }
}

export async function runUnitHandler({ handler, command, args, relayCall, token: initialToken, refreshToken, outside = false, context = {} }) {
  const unitOf = (phase) => ({ command, phase, ...(outside ? { outside: true } : {}) });
  // cdp.attach 가 debugger 세대를 올리면 이후 호출은 응답의 새 세대 token 으로 보냄
  let token = initialToken;
  let closed = false;
  let sent = false;
  let moments;
  let finished = false;
  const base = async (baseCommand, baseArgs, { last = false } = {}) => {
    if (closed) throw new Error("이미 닫힌 명령 단위입니다.");
    sent = true;
    if (last) closed = true;
    const reply = await relayWithFreshToken(next => relayCall(baseCommand, baseArgs, unitOf(last ? "last" : "run"), next),
      token, refreshToken);
    token = reply.token;
    const raw = reply.raw;
    const response = commandResponse(raw);
    // 붙이거나 떼거나 탐색하며 문서·debugger 세대가 바뀌면 이후 호출은 응답의 새 세대 token 으로 보냄
    if (GENERATION_COMMANDS.has(baseCommand) && raw?.commandState === "completed" && response.ok) {
      token = refreshedToken(token, response.data);
    }
    if (last && raw?.commandState === "completed") finished = true;
    if (response?.data && Array.isArray(response.data.moments)) moments = response.data.moments;
    return { raw, response };
  };
  try {
    const result = await handler({ args, base, ...context });
    // 옛 attachMoments 처럼 비운 관찰 순간이 있으면 처리기 응답의 같은 이름 칸(observe 의 moments)도 덮어씀
    if (moments && result?.ok && result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
      return { ...result, data: { ...result.data, moments } };
    }
    return result;
  } finally {
    if (sent && !finished) await relayCall("unit.end", {}, unitOf("end"), token).catch(() => {});
  }
}
