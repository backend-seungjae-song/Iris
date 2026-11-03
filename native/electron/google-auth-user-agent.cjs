// Google 로그인 호스트에서만 wire/navigator UA를 Firefox 140으로 맞춘다.
// 쿠키나 저장소는 만지지 않는다. webContents 탐색과 auth/device UA에 필요한 최소 CDP override만 소유한다.

const { pinWhileAttached } = require("./debugger-pin.cjs");
const GOOGLE_AUTH_HOSTS = Object.freeze(["accounts.google.com", "accounts.youtube.com"]);
const states = new WeakMap();

function isGoogleAuthUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" && GOOGLE_AUTH_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function googleAuthUserAgent() {
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10.15"
    : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}; rv:140.0) Gecko/20100101 Firefox/140.0`;
}

// 탭의 현재 정체. 인증 문서를 떠나는 첫 main-frame 요청의 UA 를 정하는 규칙(google-auth-rules.cjs)이 사용
function hasAuthIdentity(state) {
  const operation = latestCdpOperation(state);
  if (operation) return operation.userAgent === googleAuthUserAgent();
  try { return state.wc.getUserAgent() === googleAuthUserAgent(); } catch { return false; }
}

function baseUserAgent(state) {
  return state.devicePayload?.userAgent || sessionUserAgent(state.wc) || null;
}

const identityListeners = new Set();
function onIdentityChange(listener) {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}
function notifyIdentity(state, removed = false) {
  const identity = removed || state.disposed ? null : { firefox: hasAuthIdentity(state), base: baseUserAgent(state) };
  for (const listener of identityListeners) { try { listener(state.wc, identity); } catch {} }
}

function clonePayload(payload) {
  const out = { ...(payload || {}) };
  if (payload && payload.userAgentMetadata) {
    out.userAgentMetadata = { ...payload.userAgentMetadata };
    if (Array.isArray(payload.userAgentMetadata.brands)) {
      out.userAgentMetadata.brands = payload.userAgentMetadata.brands.map((brand) => ({ ...brand }));
    }
    if (Array.isArray(payload.userAgentMetadata.fullVersionList)) {
      out.userAgentMetadata.fullVersionList = payload.userAgentMetadata.fullVersionList.map((brand) => ({ ...brand }));
    }
  }
  return out;
}

function sessionUserAgent(wc) {
  try {
    const ua = wc.session && wc.session.getUserAgent();
    if (ua) return ua;
  } catch {}
  try { return wc.getUserAgent(); } catch { return ""; }
}

function currentNavigationUrl(state) {
  if (state.pending) return state.pending.currentUrl;
  try { return state.wc.getURL(); } catch { return ""; }
}

function canSendOverCdp(wc) {
  try { return !wc.isDestroyed() && wc.debugger.isAttached(); } catch { return false; }
}

// 정체성 전달에만 쓰는 attach 는 소유로 표시한다. CDP 부착 정책이 AI 세션(document/observation 준비)과
// 이 attach 를 구분해, 로그인 호스트에서 AI 세션만 떼고 이것은 두게 하기 위해서다.
function ensureIdentityDebugger(state) {
  const wc = state.wc;
  if (canSendOverCdp(wc)) return true;
  try {
    wc.debugger.attach("1.3");
    pinWhileAttached(wc.debugger);
    const ready = canSendOverCdp(wc);
    if (ready) state.ownsDebugger = true;
    return ready;
  } catch {
    return false;
  }
}

// 인증 호스트를 떠났다. 소유를 내려놓고 정책에 재판정을 맡긴다(AI 창·유지 조건이 없으면 정책이 뗀다).
function releaseIdentityDebugger(state) {
  if (!state.ownsDebugger) return;
  state.ownsDebugger = false;
  if (typeof state.onRelease === "function") { try { state.onRelease(state.wc); } catch {} }
}

function latestCdpOperation(state) {
  const pending = state.cdp.pending.at(-1) || null;
  if (pending && pending.sequence > (state.cdp.confirmed?.sequence ?? -1)) return pending;
  return state.cdp.confirmed;
}

function settleCdpOperation(state, operation, succeeded) {
  if (operation.epoch !== state.cdp.epoch) return;
  const index = state.cdp.pending.indexOf(operation);
  if (index !== -1) state.cdp.pending.splice(index, 1);
  if (succeeded && operation.sequence > (state.cdp.confirmed?.sequence ?? -1)) {
    state.cdp.confirmed = operation;
  }
  notifyIdentity(state);
}

function sendTrackedOverride(state, send, payload) {
  const operation = {
    epoch: state.cdp.epoch,
    sequence: ++state.cdp.nextSequence,
    userAgent: payload.userAgent,
  };
  state.cdp.pending.push(operation);
  notifyIdentity(state);
  let sent;
  try { sent = send("Emulation.setUserAgentOverride", payload); }
  catch (error) {
    settleCdpOperation(state, operation, false);
    return Promise.reject(error);
  }
  return Promise.resolve(sent).then(
    (value) => { settleCdpOperation(state, operation, true); return value; },
    (error) => { settleCdpOperation(state, operation, false); throw error; },
  );
}

function payloadForUrl(basePayload, url) {
  return isGoogleAuthUrl(url)
    ? { userAgent: googleAuthUserAgent() }
    : clonePayload(basePayload);
}

function resetStandingCdpState(state) {
  state.cdp.epoch += 1;
  state.cdp.confirmed = null;
  state.cdp.pending = [];
  notifyIdentity(state);
}

function applyNavigationIdentity(state, url) {
  if (state.disposed) return;
  const wc = state.wc;
  let cdpReady = canSendOverCdp(wc);
  const authHost = isGoogleAuthUrl(url);

  // viewport의 base payload는 Firefox로 변환한 결과가 아니다. 그래서 auth에서 처음 켜도
  // 이후 일반 host로 돌아갈 때 session/device 정체를 그대로 복원할 수 있다.
  if (state.devicePayload) {
    // detach는 metrics뿐 아니라 standing UA도 지운다. device intent가 살아 있으면 첫 탐색에서
    // UA부터 즉시 복원한다. Runtime/Page 도메인은 켜지 않고 이 명령 하나만 보낸다.
    if (!cdpReady) cdpReady = ensureIdentityDebugger(state);
    if (cdpReady) {
      void sendDeviceUserAgentOverride(
        wc,
        wc.debugger.sendCommand.bind(wc.debugger),
        state.devicePayload,
      ).catch(() => {});
      if (!authHost) releaseIdentityDebugger(state);
      return;
    }
  }

  const firefox = googleAuthUserAgent();
  const currentCdp = latestCdpOperation(state);
  let currentWebContentsUa = "";
  try { currentWebContentsUa = wc.getUserAgent(); } catch {}
  const currentUa = currentCdp?.userAgent || currentWebContentsUa;
  let nextUa = null;
  if (authHost) nextUa = firefox;
  else if (currentUa === firefox && currentCdp) nextUa = sessionUserAgent(wc);
  if (nextUa === null || nextUa === currentUa) {
    if (!authHost) releaseIdentityDebugger(state);
    return;
  }

  // renderer가 시작한 탐색은 did-start 때 이미 WC UA를 읽었을 수 있다. CDP는 그 문서의
  // 정체를 재지정하며, setUserAgent처럼 POST 탐색을 취소·재생하지 않는다.
  if (!cdpReady) cdpReady = ensureIdentityDebugger(state);
  if (cdpReady) {
    void sendTrackedOverride(state, wc.debugger.sendCommand.bind(wc.debugger), { userAgent: nextUa }).catch(() => {});
  }
  if (!authHost) releaseIdentityDebugger(state);
}

function makeState(wc) {
  const state = {
    wc,
    pending: null,
    devicePayload: null,
    disposed: false,
    ownsDebugger: false,
    onRelease: null,
    cdp: { epoch: 0, nextSequence: 0, confirmed: null, pending: [] },
    dispose: null,
  };

  const onStart = (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || String(url).startsWith("chrome-error://")) return;
    const previous = state.pending;
    state.pending = {
      currentUrl: url,
      supersededUrls: previous ? [...previous.supersededUrls, previous.currentUrl] : [],
    };
    applyNavigationIdentity(state, url);
  };
  const onRedirect = (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || String(url).startsWith("chrome-error://")) return;
    if (state.pending) state.pending.currentUrl = url;
    else state.pending = { currentUrl: url, supersededUrls: [] };
    applyNavigationIdentity(state, url);
  };
  const onNavigate = () => {
    state.pending = null;
  };
  const onFail = (_event, _code, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !state.pending) return;
    const supersededIndex = state.pending.supersededUrls.indexOf(failedUrl);
    if (supersededIndex !== -1) {
      state.pending.supersededUrls.splice(supersededIndex, 1);
      return;
    }
    if (state.pending.currentUrl !== failedUrl) return;
    state.pending = null;
    const committedUrl = currentNavigationUrl(state);
    applyNavigationIdentity(state, committedUrl);
  };
  const onDebuggerDetach = () => {
    state.ownsDebugger = false;
    resetStandingCdpState(state);
    // 정책이나 AI 세션 정리가 debugger 를 떼도 인증 문서에는 Firefox 정체가 계속 필요하다. 떼는 쪽의
    // 정리와 같은 이벤트 안에서 겹치지 않게 다음 틱에 정체성 전용으로 다시 붙인다. setUserAgent 는
    // 진행 중인 loadURL 을 취소할 수 있어 쓰지 않는다.
    if (!isGoogleAuthUrl(currentNavigationUrl(state))) return;
    setImmediate(() => {
      if (state.disposed || canSendOverCdp(wc)) return;
      const url = currentNavigationUrl(state);
      if (isGoogleAuthUrl(url)) applyNavigationIdentity(state, url);
    });
  };
  const cleanup = (destroyed) => {
    if (state.disposed) return;
    if (!destroyed && latestCdpOperation(state)?.userAgent === googleAuthUserAgent() && canSendOverCdp(wc)) {
      const base = state.devicePayload || { userAgent: sessionUserAgent(wc) };
      void wc.debugger.sendCommand("Emulation.setUserAgentOverride", clonePayload(base)).catch(() => {});
    }
    state.disposed = true;
    state.pending = null;
    state.devicePayload = null;
    resetStandingCdpState(state);
    try { wc.off("did-start-navigation", onStart); } catch {}
    try { wc.off("will-redirect", onRedirect); } catch {}
    try { wc.off("did-navigate", onNavigate); } catch {}
    try { wc.off("did-fail-load", onFail); } catch {}
    try { wc.off("destroyed", onDestroyed); } catch {}
    try { wc.debugger.off("detach", onDebuggerDetach); } catch {}
    if (states.get(wc) === state) states.delete(wc);
    notifyIdentity(state, true);
  };
  const onDestroyed = () => cleanup(true);
  state.dispose = () => cleanup(false);

  wc.on("did-start-navigation", onStart);
  wc.on("will-redirect", onRedirect);
  wc.on("did-navigate", onNavigate);
  wc.on("did-fail-load", onFail);
  wc.once("destroyed", onDestroyed);
  try { wc.debugger.on("detach", onDebuggerDetach); } catch {}
  states.set(wc, state);
  return state;
}

function stateFor(wc) {
  const existing = states.get(wc);
  return existing && !existing.disposed ? existing : makeState(wc);
}

// onRelease(wc): 인증 호스트를 떠나 정체성 전용 attach 의 소유를 내려놓은 뒤 불린다. CDP 부착 정책이
// 이 자리에서 재판정해 AI 창·유지 조건이 없으면 뗀다.
function attachGoogleAuthUserAgent(wc, { onRelease } = {}) {
  if (!wc || typeof wc.on !== "function") throw new TypeError("webContents가 필요합니다.");
  const state = stateFor(wc);
  if (typeof onRelease === "function") state.onRelease = onRelease;
  return state.dispose;
}

// 정체성 모듈이 스스로 붙여 아직 소유 중인 debugger 인가. 정책은 이것을 AI 세션과 구분해 둔다.
function identityOwnsDebugger(wc) {
  const state = states.get(wc);
  return !!(state && !state.disposed && state.ownsDebugger && canSendOverCdp(wc));
}

// 호출 지점 직전의 pending navigation을 읽는다. metrics/touch await 사이에 탐색이 바뀌어도
// 먼저 계산해 둔 URL로 마지막 UA write가 되돌아가지 않는다.
function sendDeviceUserAgentOverride(wc, send, basePayload) {
  if (typeof send !== "function") return Promise.reject(new TypeError("CDP send가 필요합니다."));
  const state = stateFor(wc);
  state.devicePayload = clonePayload(basePayload);
  notifyIdentity(state);
  const payload = payloadForUrl(state.devicePayload, currentNavigationUrl(state));
  return sendTrackedOverride(state, send, payload);
}

function clearDeviceUserAgentOverride(wc) {
  const state = states.get(wc);
  if (state) { state.devicePayload = null; notifyIdentity(state); }
}

module.exports = {
  GOOGLE_AUTH_HOSTS,
  attachGoogleAuthUserAgent,
  clearDeviceUserAgentOverride,
  googleAuthUserAgent,
  identityOwnsDebugger,
  isGoogleAuthUrl,
  onIdentityChange,
  sendDeviceUserAgentOverride,
};
