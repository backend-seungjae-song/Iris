// 닫은 브라우저 탭의 Electron navigationHistory를 안전한 IPC 경계로 내보내고 새 webview에 복원한다.
//
// 소유 범위
//   NavigationEntry 정규화와 크기 경계, trusted host renderer → 자기 webview 접근 판정,
//   export 및 최초 src load 전 stage/attach/finish 복원 handshake.
//
// 제공 API
//   createBrowserNavigationHistory(deps), normalizeNavigationHistory(value).
//
// 의존 대상
//   main이 주입하는 app·ipcMain·webContents.fromId·trusted sender·guest ownership 판정.
//
// 유지 조건
//   http(s) 항목만 보존하고 URL·pageState를 로그에 남기지 않는다. restore는 아직 실제 탐색을
//   시작하지 않은 webview에만 허용한다. Electron guest-view-manager의 will-attach params.src를 비워
//   첫 load를 막고 did-attach에서 entries와 활성 index를 함께 복원해야 forward 이력이 유지된다.

const MAX_ENTRIES = 512;
const MAX_URL_LENGTH = 32768;
const MAX_TITLE_LENGTH = 4096;
const MAX_PAGE_STATE_LENGTH = 4 * 1024 * 1024;
const MAX_TOTAL_LENGTH = 16 * 1024 * 1024;
const HISTORY_MARKER_PREFIX = "about:blank#iris-history:";
const STAGE_TTL_MS = 10_000;
const RESTORE_TIMEOUT_MS = 10_000;
const MAX_STAGED_HISTORIES = 64;

function httpUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch { return null; }
}

function normalizeNavigationHistory(value) {
  if (!value || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > MAX_ENTRIES) return null;
  const sourceIndex = Number(value.index);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= value.entries.length) return null;

  const entries = [];
  const sourceIndexes = [];
  let totalLength = 0;
  for (let i = 0; i < value.entries.length; i++) {
    const source = value.entries[i];
    if (!source || typeof source !== "object") continue;
    const url = httpUrl(source.url);
    if (!url) continue;
    const title = typeof source.title === "string" ? source.title.slice(0, MAX_TITLE_LENGTH) : "";
    const entry = { url, title };
    if (source.pageState != null) {
      if (typeof source.pageState !== "string" || source.pageState.length > MAX_PAGE_STATE_LENGTH
        || source.pageState.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.pageState)) return null;
      entry.pageState = source.pageState;
    }
    totalLength += entry.url.length + entry.title.length + (entry.pageState ? entry.pageState.length : 0);
    if (totalLength > MAX_TOTAL_LENGTH) return null;
    entries.push(entry);
    sourceIndexes.push(i);
  }
  if (!entries.length) return null;

  let index = sourceIndexes.indexOf(sourceIndex);
  if (index < 0) {
    // 활성 항목이 about:blank/chrome-error처럼 복원 범위 밖이면 그 직전의 마지막 http(s) 항목을 쓴다.
    index = sourceIndexes.findLastIndex((candidate) => candidate < sourceIndex);
    if (index < 0) index = 0;
  }
  return { entries, index };
}

function historyMatches(target, expected) {
  try {
    const actual = normalizeNavigationHistory({
      entries: target.navigationHistory.getAllEntries(),
      index: target.navigationHistory.getActiveIndex(),
    });
    if (!actual || actual.index !== expected.index || actual.entries.length !== expected.entries.length) return false;
    return actual.entries.every((entry, index) => entry.url === expected.entries[index].url
      && (entry.pageState || "") === (expected.entries[index].pageState || ""));
  } catch { return false; }
}

function createBrowserNavigationHistory({
  app,
  ipcMain,
  webContentsFromId,
  isTrustedSender,
  isAllowedTarget,
  randomToken = () => require("node:crypto").randomBytes(18).toString("base64url"),
  restoreNavigationHistory = (target, history) => target.navigationHistory.restore(history),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!app || typeof app.on !== "function") throw new Error("app.on이 필요합니다.");
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("ipcMain.handle이 필요합니다.");
  if (typeof ipcMain.on !== "function") throw new Error("ipcMain.on이 필요합니다.");
  if (typeof webContentsFromId !== "function") throw new Error("webContentsFromId가 필요합니다.");
  if (typeof isTrustedSender !== "function") throw new Error("isTrustedSender가 필요합니다.");
  if (typeof isAllowedTarget !== "function") throw new Error("isAllowedTarget이 필요합니다.");

  function targetFor(event, rawId) {
    if (!isTrustedSender(event)) return null;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return null;
    let target = null;
    try { target = webContentsFromId(id); } catch { return null; }
    if (!target || (typeof target.isDestroyed === "function" && target.isDestroyed())) return null;
    try { return isAllowedTarget(event, target) ? target : null; } catch { return null; }
  }

  function exportHistory(event, rawId) {
    const target = targetFor(event, rawId);
    if (!target || !target.navigationHistory) return { ok: false, error: "탐색 이력을 읽을 수 없는 대상입니다." };
    try {
      const history = normalizeNavigationHistory({
        entries: target.navigationHistory.getAllEntries(),
        index: target.navigationHistory.getActiveIndex(),
      });
      return history ? { ok: true, history } : { ok: false, error: "복원할 http(s) 탐색 이력이 없습니다." };
    } catch { return { ok: false, error: "탐색 이력을 읽지 못했습니다." }; }
  }

  async function restoreHistory(event, payload) {
    const target = targetFor(event, payload && payload.wcId);
    const history = normalizeNavigationHistory(payload && payload.history);
    if (!target || !target.navigationHistory || !history) return { ok: false, error: "탐색 이력 복원 요청이 유효하지 않습니다." };
    try {
      if (typeof target.navigationHistory.length === "function" && target.navigationHistory.length() > 1) {
        return { ok: false, error: "이미 탐색을 시작한 대상에는 이력을 복원할 수 없습니다." };
      }
      await target.navigationHistory.restore(history);
      return { ok: true };
    } catch { return { ok: false, error: "탐색 이력을 복원하지 못했습니다." }; }
  }

  const staged = new Map();
  const claimsByHost = new WeakMap();
  const stagesByGuest = new WeakMap();
  const observedHosts = new WeakSet();

  function finishStage(state, result) {
    if (!state || state.result) return;
    state.result = result;
    state.resolve(result);
    if (!state.timer) {
      state.timer = setTimer(() => discardStage(state, result), STAGE_TTL_MS);
      if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    }
  }

  function discardStage(state, result = { ok: false, error: "탐색 이력 복원 시간이 지났습니다." }) {
    if (!state) return;
    finishStage(state, result);
    if (staged.get(state.token) === state) staged.delete(state.token);
    if (state.timer) { clearTimer(state.timer); state.timer = null; }
  }

  function stageHistory(event, value) {
    if (!isTrustedSender(event)) return { ok: false, error: "탐색 이력 복원 요청을 신뢰할 수 없습니다." };
    const history = normalizeNavigationHistory(value);
    if (!history) return { ok: false, error: "탐색 이력 복원 요청이 유효하지 않습니다." };
    while (staged.size >= MAX_STAGED_HISTORIES) discardStage(staged.values().next().value);
    let token = "";
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = String(randomToken());
      if (candidate && !staged.has(candidate) && /^[A-Za-z0-9_-]+$/.test(candidate)) { token = candidate; break; }
    }
    if (!token) return { ok: false, error: "탐색 이력 복원 토큰을 만들지 못했습니다." };
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const state = { token, owner: event.sender, history, completion, resolve, result: null, timer: null };
    state.timer = setTimer(() => discardStage(state), STAGE_TTL_MS);
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    staged.set(token, state);
    return { ok: true, token, src: `${HISTORY_MARKER_PREFIX}${token}` };
  }

  async function finishHistory(event, rawToken) {
    const token = String(rawToken || "");
    const state = staged.get(token);
    if (!state || state.owner !== event.sender || !isTrustedSender(event)) {
      return { ok: false, error: "탐색 이력 복원 토큰이 유효하지 않습니다." };
    }
    const result = await state.completion;
    discardStage(state, result);
    return result;
  }

  function tokenFromMarker(value) {
    const src = String(value || "");
    if (!src.startsWith(HISTORY_MARKER_PREFIX)) return "";
    const token = src.slice(HISTORY_MARKER_PREFIX.length);
    return /^[A-Za-z0-9_-]+$/.test(token) ? token : "";
  }

  function observeHost(host) {
    if (!host || observedHosts.has(host) || typeof host.on !== "function") return;
    observedHosts.add(host);
    host.on("will-attach-webview", (_attachEvent, _webPreferences, params) => {
      const token = tokenFromMarker(params && params.src);
      const state = staged.get(token);
      if (!state || state.owner !== host) {
        if (String(params && params.src || "").startsWith(HISTORY_MARKER_PREFIX)) params.src = "about:blank";
        return;
      }
      // Electron 43 guest-view-manager는 이 이벤트 뒤 params.src가 truthy일 때 loadURL을 먼저 호출한다.
      // 빈 문자열로 바꿔 새 guest를 아직 한 페이지도 load하지 않은 상태로 did-attach에 넘긴다.
      params.src = "";
      const claim = { state };
      claimsByHost.set(host, claim);
      queueMicrotask(() => {
        if (claimsByHost.get(host) === claim) claimsByHost.delete(host);
      });
    });
    host.on("did-attach-webview", (_attachEvent, guest) => {
      const state = stagesByGuest.get(guest);
      if (!state) return;
      stagesByGuest.delete(guest);
      void (async () => {
        let allowed = false;
        let restoreError = null;
        let restoreTimer = null;
        try {
          allowed = !!isAllowedTarget({ sender: host }, guest);
          if (!allowed) throw new Error("허용되지 않은 webview입니다.");
          const attempted = Promise.resolve()
            .then(() => restoreNavigationHistory(guest, state.history))
            .catch((error) => { restoreError = error; });
          await Promise.race([
            attempted,
            new Promise((resolve) => {
              restoreTimer = setTimer(() => {
                restoreError = new Error("탐색 이력 복원 시간 초과");
                try { guest.stop(); } catch {}
                resolve();
              }, RESTORE_TIMEOUT_MS);
              if (restoreTimer && typeof restoreTimer.unref === "function") restoreTimer.unref();
            }),
          ]);
        } catch (error) { restoreError = error; }
        if (restoreTimer) clearTimer(restoreTimer);
        if (historyMatches(guest, state.history)) { finishStage(state, { ok: true }); return; }
        // src를 비운 guest는 복원 실패 시 스스로 dom-ready가 되지 않는다. 허용된 guest라면 main이
        // 저장된 활성 URL을 한 번만 열어 renderer의 완료/fallback 경로까지 반드시 진행시킨다.
        let fallbackLoaded = false;
        try {
          const fallback = allowed ? state.history.entries[state.history.index].url : "about:blank";
          const loading = guest.loadURL(fallback);
          if (loading && typeof loading.catch === "function") loading.catch(() => {});
          fallbackLoaded = true;
        } catch {}
        finishStage(state, {
          ok: false,
          fallbackLoaded,
          error: restoreError ? "탐색 이력을 복원하지 못했습니다." : "복원된 탐색 이력이 원본과 다릅니다.",
        });
      })();
    });
  }

  function onWebContentsCreated(_event, contents) {
    if (!contents) return;
    if (typeof contents.getType === "function" && contents.getType() === "webview") {
      const host = contents.hostWebContents;
      const claim = host && claimsByHost.get(host);
      if (claim) {
        claimsByHost.delete(host);
        if (claim.state.timer) { clearTimer(claim.state.timer); claim.state.timer = null; }
        stagesByGuest.set(contents, claim.state);
      }
      return;
    }
    observeHost(contents);
  }

  ipcMain.on("ac-browser-history-stage", (event, history) => { event.returnValue = stageHistory(event, history); });
  ipcMain.handle("ac-browser-history-export", exportHistory);
  ipcMain.handle("ac-browser-history-restore", restoreHistory);
  ipcMain.handle("ac-browser-history-finish", finishHistory);
  app.on("web-contents-created", onWebContentsCreated);
  return { exportHistory, restoreHistory, stageHistory, finishHistory, onWebContentsCreated };
}

module.exports = {
  MAX_ENTRIES,
  HISTORY_MARKER_PREFIX,
  createBrowserNavigationHistory,
  historyMatches,
  normalizeNavigationHistory,
};
