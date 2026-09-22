// 창을 저장된 위치로 복원하고 그 위치를 유지한다.
//
// 소유 범위
//   저장된 위치로 복원하지 못한 창의 대기 목록, 창별 제목, 위치 저장 debounce.
//
// 제공 API
//   createWindowLayout(deps) 가 boundsVisible · applySavedBounds · ownWindowTitle ·
//   setOwnedWindowTitle · restoreWhenDisplayReturns · watchDisplayLoss · placeSavedBounds ·
//   snapshotWindowBounds · trackWindowBounds · isAwaiting 를 제공한다.
//   대기 목록 자체는 제공하지 않는다.
//   그리고 무슨 일이 있었는지 남기는 진단 파일 하나(window-layout-diag.json).
//
// 의존 대상
//   Electron 을 require 하지 않는다. screen · 가시성 판정 · UI 상태 읽기/쓰기를 주입받는다.
//   시계도 주입받는다(now). 모니터 구성이 막 바뀐 직후인지는 시각으로만 구분할 수 있고,
//   그 판정을 검사가 1.5초 기다리지 않고 실행할 수 있어야 하기 때문이다.
//   w 는 호출자가 넘기는 BrowserWindow 이고 on·once·setBounds·setTitle 등만 쓴다.
//   진단 파일을 쓰려면 fs·path 를 받는다. 주지 않으면 아무것도 기록하지 않고 그대로 동작한다.
//   검사는 그 경로 없이 실행할 수 있어야 한다. 상태 폴더는 정본(state-home.cjs)에서 직접 받는다.
//
// 유지 조건
//   기다리는 동안 임시 위치를 저장하지 않는다. 저장하면 모니터가 돌아와도 원래 위치가
//   이미 지워져 있다.
//   이 방어는 시작할 때만이 아니라 실행 중에도 적용해야 한다. 앱이 켜져 있는 동안 모니터를 분리하면
//   macOS 가 창을 남은 화면으로 옮기는데, 창을 만드는 순간만 확인하면 그 경우를 놓친다
//   (확인 결과: 모니터를 3→1→3 으로 바꾸면 창들의 위치가 서로 바뀐다).
//   모니터 구성이 바뀐 직후의 이동은 사용자가 옮긴 것으로 보지 않는다. OS 가 옮긴 것과 사용자가
//   끈 것은 이벤트로 구분되지 않고 시각으로만 구분된다.
//   사용자가 직접 창을 옮기면 그 순간 대기를 종료한다. 모니터가 다시 연결되지 않을 수 있다.
//   제목을 막는 것은 BrowserWindow 의 이벤트다. webContents 쪽에 걸면 아무 일도 일어나지 않는다
// (확인 결과: webContents 쪽에 걸면 창 셋의 제목이 그대로 "Iris" 였다).
//   현재 제목은 창 객체에 보관한다. 그러지 않으면 페이지가 제목을 바꿀 때 최초 제목으로 되돌아간다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron screen·ui-state-store·window-bounds.cjs 판정이다.
//   양방향 소비자는 메인 창·분리 브라우저 창·메모 창 셋 전부다. 셋이 각각 이 함수들을 호출하고,
//   여기가 어긋나면 다음 실행에서 창들이 한 화면에 겹쳐 쌓인다.
//   현재 목록 확인: node bin/importers.mjs native/electron/window-layout.cjs
//
// 진단 파일이 있는 이유
//   이 영역의 결함은 모니터를 실제로 분리했다 연결해야 재현되고, 그 작업은 사용자만 할 수 있다.
//   그때 무슨 일이 있었는지 남지 않으면 다음 수정이 추측이 된다. 보고만 듣고 고쳐
//   같은 증상이 다시 나타난 적이 있다. 창 전환도 같은 이유로
//   window-switcher-diag.json 을 남기며, 같은 방식이다.
//   이 기록은 유실돼도 되므로 쓰기 실패는 무시한다. 판정은 이 파일을 읽지 않는다.

const { stateHome: canonicalStateHome } = require("../../server/state-home.cjs");

function createWindowLayout({ screen, windowBoundsVisible, readUiState, writeUiState,
  fs = null, path = null, stateHome = canonicalStateHome, now = () => Date.now() }) {
  // ── 진단 기록 ──────────────────────────────────────────────────────────────
  // 무엇이 언제, 어떤 모니터 구성에서 일어났는가. 판정에는 쓰지 않는다.
  const DIAG_MAX = 120;
  const diagEvents = [];
  const diagFile = () => {
    if (!fs || !path || typeof stateHome !== "function") return null;
    try { return path.join(stateHome(), "window-layout-diag.json"); } catch { return null; }
  };
  function displaySnapshot() {
    try {
      return screen.getAllDisplays().map((d) => ({
        id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor,
        internal: d.internal === true,
      }));
    } catch { return null; }
  }
  // 창을 식별하는 이름. 열쇠가 있으면 열쇠, 없으면 제목을 쓴다. 메모 창은 열쇠가 없다.
  function diagName(w, key) {
    if (key) return key;
    try { return (w && w.__irisTitle) || null; } catch { return null; }
  }
  let diagWriteQueued = false;
  function flushDiag() {
    const file = diagFile();
    if (!file) return;
    diagWriteQueued = false;
    try {
      fs.writeFileSync(file, JSON.stringify({
        at: new Date(now()).toISOString(),
        displays: displaySnapshot(),
        settleMs: DISPLAY_SETTLE_MS,
        displayChangedAt: displayChangedAt ? new Date(displayChangedAt).toISOString() : null,
        awaiting: [...awaitingDisplay.keys()].map((w) => diagName(w, null)),
        events: diagEvents,
      }, null, 2));
    } catch {}
  }
  // 이벤트는 모아서 쓴다. 창을 끄는 동안 move 가 수십 번 발생하는데 그때마다 파일을 쓰면
  // 진단 기록 자체가 성능 문제의 원인이 된다.
  function note(kind, fields) {
    try {
      diagEvents.push({ at: new Date(now()).toISOString(), kind, ...fields });
      while (diagEvents.length > DIAG_MAX) diagEvents.shift();
      if (diagWriteQueued) return;
      diagWriteQueued = true;
      setTimeout(flushDiag, 300);
    } catch {}
  }

  // 창 레이아웃(위치·크기·최대화) persist·복원. 재기동 시 종료 당시 상태로 복구한다(기본 중앙 소형창 방지).
  // 저장 bounds가 현재 어떤 디스플레이 작업영역과도 안 겹치면(모니터 구성 변경) 기본값으로 폴백.
  // 판정 자체는 window-bounds.cjs에 있다(그것만 따로 시험하려고 뗐다).
  function boundsVisible(b) {
    try { return windowBoundsVisible(b, screen.getAllDisplays()); } catch { return false; }
  }
  // 반환값의 `restored`는 저장된 위치에 실제로 배치했는지를 뜻한다. false인데 record가 있으면 그 창의
  // 모니터가 아직 없다는 뜻이고, caller는 restoreWhenDisplayReturns로 그 위치를 보관한다.
  function applySavedBounds(opts, key) {
    const b = readUiState()[key];
    if (b && boundsVisible(b)) {
      opts.x = b.x; opts.y = b.y; opts.width = b.width; opts.height = b.height;
      // 최대화/풀스크린으로 저장됐다면 normalBounds 위치가 그 창이 실제로 있던 모니터와 다를 수 있다
      // (macOS: 메인의 normal 위치를 유지한 채 보조 모니터에서 최대화 → getNormalBounds는 메인 좌표).
      // 저장된 display로 normalBounds를 재배치한 뒤 caller가 maximize → 그 모니터에서 최대화된다.
      try {
        if ((b.maximized || b.fullscreen) && b.display) {
          const ds = screen.getAllDisplays();
          const target = ds.find((d) => d.id === b.display.id) || ds.find((d) => d.workArea.x === b.display.x && d.workArea.y === b.display.y);
          if (target) {
            const wa = target.workArea;
            const outside = b.x < wa.x || b.y < wa.y || b.x + b.width > wa.x + wa.width || b.y + b.height > wa.y + wa.height;
            if (outside) { // normal 위치가 이 모니터 밖이면 이 모니터 작업영역 중앙으로
              opts.x = wa.x + Math.max(0, Math.round((wa.width - b.width) / 2));
              opts.y = wa.y + Math.max(0, Math.round((wa.height - b.height) / 2));
            }
          }
        }
      } catch {}
    }
    note("launch", {
      key, saved: b || null,
      placed: !!(b && boundsVisible(b)),
      why: !b ? "저장된 자리 없음" : (boundsVisible(b) ? null : "지금 화면 어디와도 안 겹친다"),
      opts: { x: opts.x, y: opts.y, width: opts.width, height: opts.height },
    });
    return b || null; // caller가 maximized/fullscreen 복원
  }
  // 창 제목은 앱이 소유한다.
  //
  // 창 넷 중 셋의 제목이 그대로 "Iris" 였다(확인 결과, browser_native_windows). 생성자에 제목을
  // 지정했는데도 그런 이유는, 이 창들이 같은 페이지를 열고 그 페이지의 <title>이 창 제목을
  // 덮어쓰기 때문이다. 그러면 Mission Control·창 전환·Dock 어디에서도 창을 구분할 수 없다.
  // 팝업 창은 이미 이 방식으로 제목을 유지한다(그쪽은 주소를 넣는다).
  //
  // 막을 수 있는 자리가 둘로 보이지만 하나만 동작한다. preventDefault가 네이티브 창 제목을 실제로
  // 막는 것은 BrowserWindow의 이벤트이고, webContents 쪽에 걸면 아무 일도 일어나지 않는다
  // (확인 결과: 그렇게 걸면 창 셋의 제목이 그대로 "Iris" 였다). 막은 뒤 제목을 다시 설정하는 것은
  // 그래도 남는 경로(다른 코드의 setTitle, 로드 전 제목)를 덮기 위해서다.
  //
  // 현재 제목은 창 객체에 보관한다. 메모 창은 사용자가 메모 이름을 바꾸면 제목이 달라지는데,
  // 그 값을 보관하지 않으면 페이지가 제목을 바꿀 때 최초 제목으로 되돌아간다.
  function ownWindowTitle(w, title) {
    w.__irisTitle = title;
    const stamp = () => { try { if (!w.isDestroyed()) w.setTitle(w.__irisTitle); } catch {} };
    try { w.on("page-title-updated", (ev) => { ev.preventDefault(); stamp(); }); } catch {}
    stamp();
  }
  function setOwnedWindowTitle(w, title) {
    if (!w || w.isDestroyed()) return;
    w.__irisTitle = title;
    try { w.setTitle(title); } catch {}
  }
  // 저장된 위치로 복원하지 못한 창 목록. 필요한 이유는 다음과 같다.
  //
  // 로그인이나 절전 해제 직후에는 외장 모니터가 아직 연결되지 않는다. 그 모니터에 있던 창은 저장된
  // 위치가 현재 화면 어디와도 겹치지 않아 기본 위치로 배치되고, 여러 창이 한 화면에 겹쳐 쌓인다.
  // 0.5초 뒤에는 그 임시 위치가 저장되어 원래 위치를 덮어쓰므로, 한 번 어긋나면 모니터가
  // 돌아와도 복원되지 않는다. 그래서 모니터가 연결될 때까지 원래 위치를 보관한 채 기다리고, 기다리는
  // 동안은 임시 위치를 저장하지 않는다. 사용자가 직접 창을 옮기면 그 순간 대기를 종료한다.
  // 모니터가 다시 연결되지 않는 경우에 새 위치를 저장해야 하기 때문이다.
  const awaitingDisplay = new Map(); // BrowserWindow -> { record, place }

  // 모니터 구성이 막 바뀐 직후의 창 이동은 사용자가 아니라 OS 가 옮긴 것이다. macOS 는
  // 모니터가 분리되면 그 화면에 있던 창을 남은 화면으로 곧바로 옮기는데, 창 입장에서는
  // 사용자가 끈 것과 구분되지 않는다. move 도 will-move 도 동일하게 발생한다. 구분할 수 있는 것은
  // 시각뿐이라 짧은 유예 구간을 둔다. 이 동안에는 위치를 저장하지도, 사용자가 옮긴 것으로 보지도 않는다.
  // 그 사이에 사용자가 실제로 창을 옮기면 그 한 번을 저장하지 못하지만, 반대로 판정하면 위치 전체가
  // 뒤바뀐 채로 저장된다.
  const DISPLAY_SETTLE_MS = 1500;
  let displayChangedAt = 0;
  function displaysSettling() { return now() - displayChangedAt < DISPLAY_SETTLE_MS; }

  function restoreWhenDisplayReturns(w, record, place) {
    if (!w || w.isDestroyed() || !record) return;
    awaitingDisplay.set(w, { record, place });
    note("hold", { win: diagName(w, null), record });
    // 사용자가 직접 옮긴 경우다. 다만 모니터가 막 바뀐 직후의 이동은 OS 가 옮긴 것이므로 제외한다.
    const giveUp = () => {
      if (displaysSettling()) return;
      if (awaitingDisplay.has(w)) note("giveUp", { win: diagName(w, null), why: "사람이 옮겼다" });
      awaitingDisplay.delete(w);
    };
    w.on("will-move", giveUp); w.on("will-resize", giveUp);
    w.once("closed", () => awaitingDisplay.delete(w));
  }

  // 실행 중에 모니터가 분리되는 경우.
  //
  // 위의 대기 목록은 창을 만드는 순간만 확인한다. 그래서 앱이 켜져 있는 동안 모니터를 분리하면
  // 아무 곳에서도 처리되지 않는다. macOS 가 창을 남은 화면으로 옮기고, 0.5초 뒤 그 임시 위치가
  // 저장되어 원래 위치를 덮어쓴다. 모니터를 다시 연결해도 복원할 근거가 없어 창들의 위치가
  // 뒤바뀐 채로 남는다(확인 결과: 모니터를 3→1→3 대수로 바꾸면 창들의 위치가 서로 바뀌었다).
  //
  // 저장된 위치를 읽는 방법은 창마다 다르다(메인·브라우저는 ui-state, 메모는 자기 기록).
  // 그래서 읽는 함수를 창이 주입한다. 여기서 저장소를 알면 메모 창의 형식까지 이 파일이 알아야 한다.
  const watching = new Map(); // BrowserWindow -> () => 저장된 위치
  function watchDisplayLoss(w, readSaved) {
    if (!w || w.isDestroyed() || typeof readSaved !== "function") return;
    watching.set(w, readSaved);
    w.once("closed", () => watching.delete(w));
  }
  function holdForDisplay(w, record) {
    restoreWhenDisplayReturns(w, record, () => placeSavedBounds(w, record));
  }
  try {
    screen.on("display-removed", () => {
      displayChangedAt = now();
      note("display-removed", { displays: displaySnapshot() });
      for (const [w, readSaved] of [...watching]) {
        if (w.isDestroyed()) { watching.delete(w); continue; }
        if (awaitingDisplay.has(w)) continue;
        let saved = null;
        try { saved = readSaved(); } catch {}
        // 저장된 위치가 여전히 어느 화면엔가 들어가면 그 창의 모니터는 분리되지 않은 것이다. 판정은
        // 시작할 때 쓰는 것과 같다. 두 경우가 확인하는 조건이 같기 때문이다.
        if (!saved || boundsVisible(saved)) continue;
        holdForDisplay(w, saved);
      }
    });
  } catch {}
  try {
    screen.on("display-metrics-changed", () => {
      displayChangedAt = now();
      note("display-metrics-changed", { displays: displaySnapshot() });
    });
  } catch {}
  try {
    screen.on("display-added", () => {
      displayChangedAt = now();
      note("display-added", { displays: displaySnapshot(), awaiting: awaitingDisplay.size });
      for (const [w, entry] of [...awaitingDisplay]) {
        if (w.isDestroyed()) { awaitingDisplay.delete(w); continue; }
        if (!boundsVisible(entry.record)) {   // 붙은 모니터가 그 창의 모니터는 아니다
          note("stillWaiting", { win: diagName(w, null), record: entry.record });
          continue;
        }
        awaitingDisplay.delete(w);
        note("place", { win: diagName(w, null), record: entry.record });
        try { entry.place(); } catch (e) { note("placeFailed", { win: diagName(w, null), error: String((e && e.message) || e) }); }
      }
    });
  } catch {}
  function placeSavedBounds(w, b) {
    try {
      w.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
      if (b.fullscreen) w.setFullScreen(true);
      else if (b.maximized) w.maximize();
    } catch {}
  }
  function snapshotWindowBounds(w) {
    try {
      if (!w || w.isDestroyed() || awaitingDisplay.has(w)) return null;
      // 모니터가 막 바뀐 상태다. 지금 창이 있는 위치는 OS 가 옮긴 것이지 사용자가 정한 위치가
      // 아니다. 대기 목록에 없는 창(모니터는 유지됐지만 배치가 밀린 창)도 여기서 함께 막힌다.
      if (displaysSettling()) return null;
      // getNormalBounds()는 최대화/풀스크린 중에도 normal(윈도우드) 좌표를 반환한다(Electron 보증).
      // 그 창이 실제로 있는 모니터를 담으므로 그대로 저장한다. (이전에 prev 보존으로 바꿨다가 다른
      // 모니터 최대화 시 옛 좌표가 굳는 버그가 생겨 원복.)
      const nb = w.getNormalBounds ? w.getNormalBounds() : w.getBounds();
      // 창이 '지금 실제로' 걸쳐 있는 디스플레이(최대화 중엔 getBounds가 그 모니터의 최대화 영역이라 정확).
      // normalBounds(nb)는 최대화 시 옛 모니터 좌표를 유지할 수 있어, 모니터 식별은 getBounds로 따로 한다.
      let display = null;
      try { const d = screen.getDisplayMatching(w.getBounds()); display = { id: d.id, x: d.workArea.x, y: d.workArea.y }; } catch {}
      return {
        bounds: { x: nb.x, y: nb.y, width: nb.width, height: nb.height },
        maximized: w.isMaximized(), fullscreen: w.isFullScreen(), display,
      };
    } catch { return null; }
  }
  function trackWindowBounds(w, key) {
    // 이 창의 저장된 위치는 ui-state 의 이 열쇠 하나이므로 여기서 바로 등록한다. 호출하는 쪽이
    // 따로 한 줄을 더 적게 하면, 창이 늘어날 때 그 줄이 빠져 그 창만 보호되지 않는다.
    watchDisplayLoss(w, () => readUiState()[key]);
    let t = null;
    const save = () => {
      try {
        const record = snapshotWindowBounds(w);
        if (!record) {   // 임시로 배치된 위치이므로 원래 위치를 덮지 않는다
          note("skipSave", {
            key,
            why: awaitingDisplay.has(w) ? "대기표에 있다" : (displaysSettling() ? "모니터가 막 바뀌었다" : "자리를 못 읽었다"),
            actual: (() => { try { return w.isDestroyed() ? null : w.getBounds(); } catch { return null; } })(),
          });
          return;
        }
        note("save", { key, record });
        writeUiState({ [key]: { ...record.bounds, maximized: record.maximized,
          fullscreen: record.fullscreen, display: record.display } });
      } catch {}
    };
    const debounced = () => { clearTimeout(t); t = setTimeout(save, 500); };
    w.on("resize", debounced); w.on("move", debounced);
    w.on("maximize", save); w.on("unmaximize", save); w.on("close", save);
    w.on("enter-full-screen", save); w.on("leave-full-screen", save); // 풀스크린 상태도 즉시 저장
  }

  return { boundsVisible, applySavedBounds, ownWindowTitle, setOwnedWindowTitle,
    restoreWhenDisplayReturns, watchDisplayLoss, placeSavedBounds, snapshotWindowBounds,
    trackWindowBounds, isAwaiting: (w) => awaitingDisplay.has(w),
    // 기록은 제공하되 배열을 그대로 주지 않는다. 밖에서 지우면 진단 기록이 비게 된다.
    diagEvents: () => diagEvents.map((e) => ({ ...e })) };
}

module.exports = { createWindowLayout };
