// 메모 전용 창의 기록·열린 창 장부·IPC 수명주기를 한곳에서 맡는다.
//
// 소유 범위
//   정규화된 memo window records와 instanceId→BrowserWindow registry, 생성·저장·닫힘·메모 IPC.
//
// 제공 API
//   createMemoWindowManager(deps) 함수 하나만 제공한다. 만들어진 API는 생성·snapshot·조회 명령이며
//   원시 Array·Map이나 Electron 객체 registry는 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. BrowserWindow·ipcMain, preload·APP URL, 신뢰 발신자 판정,
//   window-layout·UI 상태와 appQuitting 접근자를 main.cjs 에서 받고 기록 전이는 memo-window-state에 맡긴다.
//
// 유지 조건
//   같은 instanceId는 한 창만 열고, 모든 record 변경은 memo-window-state 정규화·open/patch/close와
//   open count 경로를 지난다. 앱 종료 close는 복원 기록을 남기고 사용자 X만 기록에서 뺀다.
//   모니터를 기다리는 임시 bounds는 저장하지 않으며 창 제목과 위치는 window-layout이 소유한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron 창·IPC와 ui-state-store·window-layout·memo-window-state다.
//   양방향 소비자는 preload의 메모 bridge, memo-window.js, 메뉴·reload·startup 복원이며,
//   여기가 어긋나면 창별 보기 모드·항상 위·이름·열림 카운트·재기동 복원이 함께 끊긴다.
//   현재 목록 확인: node bin/importers.mjs native/electron/memo-window-manager.cjs

const {
  closeMemoWindowRecord, memoOpenCounts, normalizeMemoWindowRecords,
  openMemoWindowRecord, patchMemoWindowRecord,
} = require("./memo-window-state.cjs");
function createMemoWindowManager({
  BrowserWindow, ipcMain, preloadPath, windowLayout, readUiState, writeUiState,
  loadUrlWithRetry, getAppUrl, isTrustedSender, isAppQuitting, markAppAlive, randomUuid, log,
}) {
  // 메모 전용 창은 브라우저 창과 달리 같은 문서를 보는 인스턴스를 제한하지 않는다. 창의 정체성과
  // 문서의 정체성을 분리해야 X는 창만 닫고 메모는 관리 페이지에 남길 수 있다.
  let memoWindowRecords = normalizeMemoWindowRecords(readUiState().memoWindows);
  const memoModeWins = new Map(); // instanceId -> BrowserWindow
  function persistMemoWindowRecords(records) {
    memoWindowRecords = normalizeMemoWindowRecords(records);
    writeUiState({ memoWindows: memoWindowRecords });
    const payload = { records: memoWindowRecords, openCounts: memoOpenCounts(memoWindowRecords) };
    for (const target of BrowserWindow.getAllWindows()) {
      try { if (!target.isDestroyed()) target.webContents.send("ac-memo-windows-changed", payload); } catch {}
    }
    return payload;
  }
  function memoRecord(instanceId) { return memoWindowRecords.find((record) => record.instanceId === instanceId) || null; }
  function memoInstanceOfWebContents(contents) {
    for (const [id, w] of memoModeWins) if (!w.isDestroyed() && w.webContents === contents) return id;
    return null;
  }
  function saveMemoWindowRecord(instanceId, w, patch = {}) {
    try {
      if (!w || w.isDestroyed() || !memoRecord(instanceId)) return;
      // 자기 모니터를 기다리는 중이면 현재 위치는 임시다. 그 값으로 원래 위치를 덮지 않는다.
      // (patch는 위치와 무관한 항목이라 그때도 그대로 반영한다. 항상 위·보기 모드가 여기 해당한다.)
      if (windowLayout.isAwaiting(w)) {
        if (Object.keys(patch).length) persistMemoWindowRecords(patchMemoWindowRecord(memoWindowRecords, instanceId, patch));
        return;
      }
      const snapshot = windowLayout.snapshotWindowBounds(w);
      if (!snapshot) return;
      persistMemoWindowRecords(patchMemoWindowRecord(memoWindowRecords, instanceId, { ...snapshot, ...patch }));
    } catch {}
  }
  function createMemoModeWindow(input = {}) {
    const kind = input.kind === "shared" ? "shared" : "local";
    const instanceId = String(input.instanceId || randomUuid());
    const existing = memoModeWins.get(instanceId);
    if (existing && !existing.isDestroyed()) { existing.focus(); return existing; }
    const candidate = {
      instanceId, kind,
      ...(kind === "local" ? { spaceKey: String(input.spaceKey || ""), noteId: String(input.noteId || ""),
        spaceLabel: String(input.spaceLabel || "").slice(0, 120) } : {}),
      bounds: input.bounds, display: input.display, maximized: !!input.maximized, fullscreen: !!input.fullscreen,
      alwaysOnTop: !!input.alwaysOnTop, viewMode: input.viewMode === "preview" ? "preview" : "raw",
    };
    const next = openMemoWindowRecord(memoWindowRecords, candidate);
    const record = next.find((item) => item.instanceId === instanceId);
    if (!record) return null;
    markAppAlive();
    const opts = {
      width: 520, height: 420, minWidth: 340, minHeight: 240,
      backgroundColor: "#0A1620", titleBarStyle: "hiddenInset", acceptFirstMouse: true,
      alwaysOnTop: record.alwaysOnTop,
      title: kind === "shared" ? "Iris — 공유 메모" : "Iris — 메모",
      webPreferences: { spellcheck: false, preload: preloadPath, nodeIntegration: false, contextIsolation: true },
    };
    if (record.bounds && windowLayout.boundsVisible(record.bounds)) Object.assign(opts, record.bounds);
    const restoreFullscreen = !!record.fullscreen;
    const restoreMaximized = !!record.maximized && !restoreFullscreen;
    if (restoreMaximized) opts.show = false;
    const mw = new BrowserWindow(opts);
    windowLayout.ownWindowTitle(mw, opts.title);
    // 메모 창도 자기 모니터가 아직 없으면 그 위치를 보관한 채 기다린다. 저장 형태만 다르고(bounds가
    // 따로 있다) 이유는 같다. 임시 위치가 원래 위치를 덮으면 복원할 수 없다.
    if (record.bounds && !windowLayout.boundsVisible(record.bounds)) {
      const want = { ...record.bounds, maximized: record.maximized, fullscreen: record.fullscreen };
      windowLayout.restoreWhenDisplayReturns(mw, want, () => windowLayout.placeSavedBounds(mw, want));
    }
    // 복원하는 중에 그 모니터가 분리되는 경우도 함께 처리한다. 메모 창의 위치는 ui-state 가 아니라
    // 자기 기록에 있으므로 읽는 함수를 여기서 주입한다. 주입하지 않으면 이 창만 제외된다.
    windowLayout.watchDisplayLoss(mw, () => {
      const cur = memoRecord(instanceId);
      if (!cur || !cur.bounds) return null;
      return { ...cur.bounds, maximized: cur.maximized, fullscreen: cur.fullscreen };
    });
    memoModeWins.set(instanceId, mw);
    persistMemoWindowRecords(next);
    if (restoreMaximized) { mw.maximize(); mw.once("ready-to-show", () => { try { mw.show(); } catch {} }); }
    if (restoreFullscreen) mw.once("ready-to-show", () => { try { mw.setFullScreen(true); } catch {} });
    const query = new URLSearchParams({ mode: "memo", kind, instance: instanceId });
    if (kind === "local") {
      query.set("space", record.spaceKey); query.set("note", record.noteId);
      if (record.spaceLabel) query.set("spaceLabel", record.spaceLabel);
    }
    query.set("view", record.viewMode); query.set("top", record.alwaysOnTop ? "1" : "0");
    loadUrlWithRetry(mw, getAppUrl() + "/?" + query.toString());
    mw.webContents.on("before-input-event", (ev, key) => {
      if (key.type !== "keyDown" || !(key.meta || key.control) || !key.shift || String(key.key || "").toLowerCase() !== "s") return;
      ev.preventDefault();
      try { mw.webContents.send("ac-shortcut", "memo-archive"); } catch {}
    });
    mw.webContents.on("console-message", (a, b, c) => {
      const message = typeof c === "string" ? c : (a && typeof a.message === "string" ? a.message : "");
      if (/^\[memo\]|error|Error/i.test(message)) log("[memo-window]", message);
    });
    let saveTimer = null;
    const schedule = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveMemoWindowRecord(instanceId, mw), 500); };
    mw.on("resize", schedule); mw.on("move", schedule);
    mw.on("maximize", schedule); mw.on("unmaximize", schedule);
    mw.on("enter-full-screen", schedule); mw.on("leave-full-screen", schedule);
    mw.on("close", () => { clearTimeout(saveTimer); saveMemoWindowRecord(instanceId, mw); });
    mw.on("closed", () => {
      clearTimeout(saveTimer); memoModeWins.delete(instanceId);
      persistMemoWindowRecords(closeMemoWindowRecord(memoWindowRecords, instanceId, { appQuitting: isAppQuitting() }));
    });
    return mw;
  }
  function registerMemoIpc() {
    ipcMain.handle("ac-open-local-memo", (e, arg) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        const spaceKey = String(arg && arg.spaceKey || "").trim(), noteId = String(arg && arg.noteId || "").trim();
        if (!spaceKey || !noteId || spaceKey === "__shared__") return { ok: false, error: "잘못된 메모 문서" };
        const instanceId = randomUuid();
        const opened = createMemoModeWindow({ kind: "local", instanceId, spaceKey, noteId,
          spaceLabel: String(arg && arg.spaceLabel || "").slice(0, 120) });
        return opened ? { ok: true, instanceId } : { ok: false, error: "메모 창을 열지 못했습니다" };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    ipcMain.handle("ac-open-shared-memo", (e) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        const instanceId = randomUuid(), opened = createMemoModeWindow({ kind: "shared", instanceId });
        return opened ? { ok: true, instanceId } : { ok: false, error: "공유 메모 창을 열지 못했습니다" };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    ipcMain.handle("ac-memo-window-list", (e) => isTrustedSender(e)
      ? { records: memoWindowRecords, openCounts: memoOpenCounts(memoWindowRecords) } : { records: [], openCounts: {} });
    ipcMain.on("ac-memo-view-mode", (e, mode) => {
      if (!isTrustedSender(e)) return;
      const instanceId = memoInstanceOfWebContents(e.sender), target = instanceId && memoModeWins.get(instanceId);
      if (instanceId && target) saveMemoWindowRecord(instanceId, target, { viewMode: mode === "preview" ? "preview" : "raw" });
    });
    ipcMain.handle("ac-memo-always-on-top", (e, enabled) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        const instanceId = memoInstanceOfWebContents(e.sender), target = instanceId && memoModeWins.get(instanceId);
        if (!instanceId || !target || target.isDestroyed()) return { ok: false, error: "메모 창을 찾지 못했습니다" };
        target.setAlwaysOnTop(!!enabled);
        const alwaysOnTop = target.isAlwaysOnTop();
        saveMemoWindowRecord(instanceId, target, { alwaysOnTop });
        return { ok: true, alwaysOnTop };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    ipcMain.on("ac-memo-window-title", (e, title) => {
      if (!isTrustedSender(e)) return;
      const instanceId = memoInstanceOfWebContents(e.sender), target = instanceId && memoModeWins.get(instanceId);
      windowLayout.setOwnedWindowTitle(target, "Iris — " + String(title || "메모").slice(0, 80));
    });
    ipcMain.on("ac-memo-close-window", (e) => {
      if (!isTrustedSender(e)) return;
      const instanceId = memoInstanceOfWebContents(e.sender), target = instanceId && memoModeWins.get(instanceId);
      try { if (target && !target.isDestroyed()) target.close(); } catch {}
    });
  }

  return {
    registerMemoIpc,
    createMemoModeWindow,
    memoWindowSnapshot: () => ({ records: normalizeMemoWindowRecords(memoWindowRecords), openCounts: memoOpenCounts(memoWindowRecords) }),
    hasMemoRecord: (instanceId) => !!memoRecord(instanceId),
    allMemoWindows: () => [...memoModeWins.values()],
    hasMemoWindow: (window) => [...memoModeWins.values()].includes(window),
  };
}

module.exports = { createMemoWindowManager };
