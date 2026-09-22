// 분리 브라우저 창 두 종류의 생성과 열린 창 장부를 한곳에서 맡는다.
//
// 소유 범위
//   활성 스페이스 브라우저 창과 공유 브라우저 창의 두 registry, 생성·중복 억제·닫힘 수명주기.
//
// 제공 API
//   createBrowserWindowManager(deps) 함수 하나만 내준다. 만들어진 API는 창 생성·조회·닫기 명령이며
//   원시 Set이나 Electron 객체 registry를 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. BrowserWindow·shell·webContents와 preload 경로, 창 레이아웃,
//   프로필 partition guard·숨은 viewport·UI 상태·앱 종료/픽 상태 접근자를 main.cjs 에서 받는다.
//
// 유지 조건
//   같은 종류는 한 창만 두고 다시 열면 기존 창을 focus한다. webview partition·하위 프레임 preload·
//   숨은 viewport 연결을 유지하며, 앱 종료가 아닌 마지막 close만 자동 재오픈 기록을 false로 바꾼다.
//   창 제목과 위치는 window-layout이 소유한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron 창 API·preload 경로, profile-session-policy·window-layout·CDP viewport다.
//   양방향 소비자는 pick-mode의 창 조회·포커스 제어, 메뉴·reload·startup 복원·브라우저 IPC이며,
//   여기가 일치하지 않으면 프로필 세션·요소 선택·창 위치·재기동 복원이 함께 끊긴다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/browser-window-manager.cjs

function createBrowserWindowManager({
  BrowserWindow, preloadPath, webviewPreloadPath, audioDiagEnabled, windowLayout, writeUiState,
  aiDrivingAnywhere = () => false,
  guardWebviewPartition, pinHiddenViewportById, webContents, shell, loadUrlWithRetry, getAppUrl,
  noThrottleOpt, isPickActive, isAppQuitting, markAppAlive, log,
}) {
  const browserModeWins = new Set();   // 활성 스페이스를 미러링하는 기존 분리창
  const sharedBrowserWins = new Set(); // 스페이스와 무관한 공유 브라우저 창(예약 스페이스에 고정)
  const SHARED_SPACE = "__shared__";

  // opts.background: 창은 만들되 앞으로 내지 않는다. AI 가 만든 탭을 띄울 창이 필요해서 부르는
  // 경로가 이 뜻으로 호출한다. 그 자리에서 focus 를 주면 사용자가 입력하던 키가 이 창으로 넘어가고
  // 보던 화면이 덮인다. 사용자가 ⌥2·🌐 로 부른 경로는 그대로 앞으로 낸다.
  // showInactive 만으로는 부족하다. 그것은 초점 없이 띄운다는 뜻이지 뒤에 둔다는 뜻이 아니어서,
  // 그렇게 띄운 창이 다른 앱의 활성 창 위에 표시된다. 같은 앱 안이면 직전 맨 위 창을 다시
  // 올려 되돌릴 수 있지만, 다른 앱이 앞일 때는 되돌릴 대상 자체가 없다.
  // 대신 창 층위를 한 칸 내린다. 그러면 어느 앱의 보통 창보다도 아래에 표시된다.
  // 확인 결과: 층위를 내린 창은 다른 앱 활성 창 아래에 표시됐고, 그 상태로도 초당 120프레임을
  // 그렸으며 캡처도 됐다. 사용자가 그 창을 부르면 층위를 되돌린다.
  function sinkWindow(win) {
    try {
      win.setAlwaysOnTop(true, "normal", -1);
      // 이 창이 초점을 받으면 층위를 되돌린다. 없으면 한 번 내린 창이 계속 뒤에 남는다.
      // 다만 초점이 곧 사용자 조작은 아니다. 페이지가 스스로 window.focus() 를 부를 수 있고,
      // 그러면 AI 명령이 실행되는 도중에 이 창이 앞으로 올라온다. AI 명령이 실행 중이면
      // 되돌리지 않는다. 사용자가 ⌥2·🌐 로 부르는 경로는 raiseWindow 가 따로 처리한다.
      win.on("focus", () => { try { if (!aiDrivingAnywhere()) win.setAlwaysOnTop(false); } catch {} });
    } catch {}
  }
  // 사용자가 그 창을 부르면 층위를 되돌리고, 뒤에 두느라 건너뛴 풀스크린도 그때 적용한다.
  // 적용하지 않으면 창을 옮기거나 닫는 순간 false 로 덮여 저장된 풀스크린이 사라진다.
  const pendingFullscreen = new WeakSet();
  function raiseWindow(win) {
    try { if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false); } catch {}
    if (!pendingFullscreen.has(win)) return;
    pendingFullscreen.delete(win);
    try { win.setFullScreen(true); } catch {}
  }
  function createBrowserModeWindow(shared, opts) {
    const background = !!(opts && opts.background);
    const wins = shared ? sharedBrowserWins : browserModeWins;
    for (const w of wins) { if (!w.isDestroyed()) { if (!background) { raiseWindow(w); w.focus(); } return w; } }
    markAppAlive(); // 창을 새로 여는 중 = 앱은 살아있음(취소된 quit로 굳은 플래그 해제)
    const bwOpts = {
      width: 1100, height: 820, backgroundColor: "#0A1620", titleBarStyle: "hiddenInset",
      title: shared ? "Iris — 공유 브라우저" : "Iris — 브라우저",
      // macOS 기본은 비활성 창의 첫 클릭을 창 활성화로만 소비해 요소 선택에 두 번 눌러야 한다.
      // 활성화 클릭도 콘텐츠에 그대로 전달한다(아래 setFocusable과 함께 한 번에 선택되게 한다).
      acceptFirstMouse: true,
      webPreferences: {
        webviewTag: true, spellcheck: false, preload: preloadPath,
        nodeIntegration: false, contextIsolation: true,
        ...(audioDiagEnabled ? { additionalArguments: ["--ac-audio-diag"] } : {}),
      },
    };
    const BOUNDS_KEY = shared ? "sharedBrowserBounds" : "browserBounds";
    const bwSaved = windowLayout.applySavedBounds(bwOpts, BOUNDS_KEY); // 분리창도 꺼졌을 당시 위치·크기 복원
    // 풀스크린은 저장된 모니터에 "보이는" 창을 먼저 배치한 뒤 전환해야 그 모니터로 풀스크린된다(숨긴 창에
    // setFullScreen→macOS가 메인 모니터로 감). 최대화는 같은 모니터라 hidden→maximize→show로 플래시 없이.
    const bwFs = !!(bwSaved && bwSaved.fullscreen);
    const bwMax = !!(bwSaved && bwSaved.maximized && !bwFs);
    if (bwMax || background) bwOpts.show = false;
    const bw = new BrowserWindow(bwOpts);
    if (background) sinkWindow(bw);   // 띄우기 전에 내려야 한 프레임도 위에 서지 않는다
    if (bwMax) { bw.maximize(); bw.once("ready-to-show", () => { try { if (background) bw.showInactive(); else bw.show(); } catch {} }); }
    else if (background) bw.once("ready-to-show", () => { try { bw.showInactive(); } catch {} });
    // 풀스크린은 macOS Space 를 차지하며 창을 앞으로 내는 동작이므로, 앞으로 내지 않기로 한
    // 창에는 적용하지 않는다. 저장된 위치·크기로만 띄우고 사용자가 직접 열 때 적용한다.
    if (bwFs && !background) bw.once("ready-to-show", () => { try { bw.setFullScreen(true); } catch {} });
    else if (bwFs && background) pendingFullscreen.add(bw);
    windowLayout.ownWindowTitle(bw, bwOpts.title);
    if (bwSaved && !windowLayout.boundsVisible(bwSaved)) windowLayout.restoreWhenDisplayReturns(bw, bwSaved, () => windowLayout.placeSavedBounds(bw, bwSaved));
    windowLayout.trackWindowBounds(bw, BOUNDS_KEY);
    wins.add(bw);
    writeUiState(shared ? { sharedOpen: true } : { browserOpen: true }); // 재기동 자동 재오픈용
    // 이 창의 <webview>에도 요소선택/anti-detection preload 부착(메인 창과 동일 배선).
    bw.webContents.on("will-attach-webview", (_ev, webPreferences) => {
      webPreferences.preload = webviewPreloadPath;
      guardWebviewPartition(webPreferences);
      webPreferences.nodeIntegrationInSubFrames = true;
      webPreferences.disableDialogs = true;
      // 기본은 Chromium 스로틀을 허용한다. 활성/AI/미디어/녹화 탭은 렌더러의 사유별 보고가
      // attach 뒤 즉시 해제하며, IRIS_NO_THROTTLE_OPT=1이면 예전 전역 해제 정책으로 롤백한다.
      webPreferences.backgroundThrottling = !noThrottleOpt;
    });
    bw.webContents.on("did-attach-webview", (_ev, guest) => {
      // 방금 붙은 게스트에는 브라우저 탭이 아닌 것도 온다(rail 화면이 담는 webview). 그것은
      // 자기 영역에 그대로 보이므로 크기를 물려받을 이유가 없고, 폭이 0 인 것만 보정한다.
      try { if (guest && !guest.isDestroyed()) setImmediate(() => pinHiddenViewportById(guest.id, webContents, { onlyIfCollapsed: true })); } catch {}
    });
    bw.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(getAppUrl())) return { action: "allow" };
      shell.openExternal(url); return { action: "deny" };
    });
    // 분리 브라우저 창의 렌더러 콘솔도 메인 stdout으로 파이프(NAVDIAG 등 진단, 메인창과 동일 연결).
    bw.webContents.on("console-message", (a, b, c) => {
      const message = (typeof c === "string") ? c : (a && typeof a.message === "string" ? a.message : "");
      if (/^\[browser\]|error|Error|픽|pick/i.test(message)) log("[bw]", message);
    });
    loadUrlWithRetry(bw, getAppUrl() + "/?mode=browser" + (shared ? "&space=" + encodeURIComponent(SHARED_SPACE) : "")); // 서버가 아직 안 떴어도 재시도(자동 리스폰 시 안전)
    try { if (isPickActive()) bw.setFocusable(false); } catch {} // 픽 모드 중에 새로 열린 창도 동일 규칙
    // 사용자가 닫음(종료 아님) → 다음 실행 자동오픈 안 함
    bw.on("closed", () => {
      try { bw.setFocusable(true); } catch {}
      wins.delete(bw);
      if (!isAppQuitting() && wins.size === 0) writeUiState(shared ? { sharedOpen: false } : { browserOpen: false });
    });
    return bw;
  }

  return {
    createBrowserModeWindow,
    allBrowserWindows: () => [...browserModeWins, ...sharedBrowserWins],
    firstBrowserModeWindow: () => [...browserModeWins].find((w) => !w.isDestroyed()) || null,
    hasBrowserModeWindow: (w) => browserModeWins.has(w),
    dockBrowserModeWindows: () => {
      for (const w of [...browserModeWins]) { try { w.close(); } catch {} }
      writeUiState({ browserOpen: false });
    },
  };
}

module.exports = { createBrowserWindowManager };
