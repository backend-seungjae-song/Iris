// 메인 콘솔 창의 생성·로드 재시도·webContents 이벤트 배선을 한곳에서 맡는다.
//
// 소유 범위
//   현재 메인 BrowserWindow와 그 창 하나의 load retry timer, 생성·로드·닫힘 수명주기와
//   메인/게스트 webContents 이벤트 배선.
//
// 제공 API
//   createMainWindow(deps) 함수 하나만 제공한다. 만들어진 API는 창 생성·일반 창 URL 로드와
//   현재 메인 창 접근자이며, BrowserWindow나 timer 원시 값은 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. app·BrowserWindow·shell·webContents와 preload 경로,
//   window-layout·프로필 partition guard·숨은 viewport·브라우저 정책과 timer 함수를 main.cjs에서 받는다.
//
// 유지 조건
//   서버가 늦게 떠도 1.2초 간격으로 다시 연결하고 성공하면 멈춘다. 닫힌 창의 예약은 해제하며,
//   저장된 모니터가 없으면 원래 위치를 window-layout에 맡겨 기다린다. 창 제목과 위치 계산도
//   window-layout만 소유하고, 메인 창을 다시 만드는 것은 새 앱 생존으로 판정한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron API·preload·window-layout·profile-session-policy·CDP viewport다.
//   양방향 소비자는 main.cjs의 단일 인스턴스·ready/activate·IPC·메뉴 조립과 browser/memo window manager이며,
//   여기가 어긋나면 서버 재접속·창 자리·제목·webview 단축키·인증 주입이 함께 끊긴다.
//   현재 목록 확인: node bin/importers.mjs native/electron/main-window.cjs

// webview 에 포커스가 있을 때 중계할 단축키 표. 이름만 보내고 무엇을 할지는 창이 정한다.
//
// 여기 기본값은 web/js/core/keymap.js 의 선언과 같아야 한다. 두 벌로 둔 이유는, 이 파일이
// 메인 프로세스(CJS)이고 그 표는 창(ESM)이라 서로 호출할 수 없는데도 창이 뜨기 전 첫 순간에
// 중계가 동작해야 하기 때문이다. 두 벌이 갈라지면 표시된 단축키와 실제 동작이 달라지므로,
// bin/smoke 가 두 벌이 같은지 대조한다. 한쪽만 고치면 검사가 실패한다.
const DEFAULT_RELAY = {
  "screen-toggle": { alt: true, code: "Tab" },
  "screen-toggle-back": { alt: true, shift: true, code: "Tab" },
  "screen-main": { alt: true, code: "Digit1" },
  "screen-browser": { alt: true, code: "Digit2" },
  "tab-prev": { alt: true, key: "ArrowLeft" },
  "tab-next": { alt: true, key: "ArrowRight" },
  "agent-prev": { alt: true, key: "ArrowUp" },
  "agent-next": { alt: true, key: "ArrowDown" },
  "space-prev": { alt: true, shift: true, key: "ArrowUp" },
  "space-next": { alt: true, shift: true, key: "ArrowDown" },
  "rec-toggle": { mod: true, shift: true, key: "a" },
  "pick-toggle": { mod: true, shift: true, key: "e" },
  "sketch": { mod: true, shift: true, key: "d" },
  "detach": { mod: true, shift: true, key: "o" },
  "file-search": { mod: true, shift: true, key: "p" },
  "memo-archive": { mod: true, shift: true, key: "s" },
  "new-tab": { mod: true, key: "t" },
  "reopen-tab": { mod: true, shift: true, key: "t" },
  "find-in-page": { mod: true, key: "f" },
  "find-next": { mod: true, key: "g" },
  "find-prev": { mod: true, shift: true, key: "g" },
  "focus-url": { mod: true, key: "l" },
  "nav-back": { mod: true, key: "[" },
  "nav-forward": { mod: true, key: "]" },
  "print-page": { mod: true, key: "p" },
  "devtools": { key: "F12" },
};
// 창이 보내온 표. 잠긴 항목은 창이 이미 걸러 내므로, 여기서는 중계 대상 이름만 받아 덮어쓴다.
let relayKeymap = { ...DEFAULT_RELAY };
function setRelayKeymap(map) {
  const next = { ...DEFAULT_RELAY };
  if (map && typeof map === "object") {
    for (const [id, b] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_RELAY, id)) continue;
      if (!b || typeof b !== "object") continue;
      if (!b.code && !b.key) continue;
      next[id] = { mod: !!b.mod, alt: !!b.alt, shift: !!b.shift, ...(b.code ? { code: String(b.code) } : { key: String(b.key) }) };
    }
  }
  relayKeymap = next;
}
// Electron 의 input 은 metaKey 가 아니라 meta 다. ⌘ 와 ⌃ 는 같은 자리로 취급하며, 표와 같은 규칙이다.
function matchRelay(input) {
  const mod = !!(input.meta || input.control);
  for (const [id, b] of Object.entries(relayKeymap)) {
    if (mod !== !!b.mod) continue;
    if (!!input.alt !== !!b.alt) continue;
    if (!!input.shift !== !!b.shift) continue;
    if (b.code) { if (String(input.code || "") === b.code) return id; continue; }
    const k = String(input.key || "");
    if (!k) continue;
    if (k.length === 1 ? k.toLowerCase() === String(b.key).toLowerCase() : k === b.key) return id;
  }
  return null;
}

function createMainWindow({
  app, BrowserWindow, shell, webContents, windowLayout, guardWebviewPartition,
  pinHiddenViewportById, preloadPath, webviewPreloadPath, appUrl: APP_URL,
  audioDiagEnabled: AUDIO_DIAG_ENABLED, noThrottleOpt: NO_THROTTLE_OPT,
  markAppAlive, console,
  setTimeout, clearTimeout, setImmediate,
}) {
  let win;

  // APP_URL 창 로드 재시도(서버가 아직 뜨지 않았을 때). 분리 브라우저 창 등이 예외로 종료되지 않게 한다.
  function loadUrlWithRetry(w, url) {
    if (!w || w.isDestroyed()) return;
    w.loadURL(url).catch(() => { if (!w.isDestroyed()) setTimeout(() => loadUrlWithRetry(w, url), 1200); });
  }

  function createWindow() {
    markAppAlive(); // 창 생성은 앱 생존으로 판정한다(취소된 quit로 남은 플래그 해제)
    const opts = {
      width: 1180,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: "#0A1620",
      titleBarStyle: "hiddenInset", // 트래픽 라이트를 콘텐츠 위에(웹 .titlebar 드래그 영역과 맞물림)
      title: "Iris — 콘솔",
      acceptFirstMouse: true, // 다른 창에서 돌아온 첫 클릭도 에이전트 선택까지 전달한다.
      webPreferences: {
        webviewTag: true,      // 브라우저 패널용 <webview>(실물 Chromium) 허용
        spellcheck: false,
        preload: preloadPath, // 분리/재도킹 IPC 브릿지
        // 렌더러는 localhost UI만 로드하고 서버와 WS로만 통신하므로 node 통합이 필요 없다(보안).
        nodeIntegration: false,
        contextIsolation: true,
        ...(AUDIO_DIAG_ENABLED ? { additionalArguments: ["--ac-audio-diag"] } : {}),
      },
    };
    const saved = windowLayout.applySavedBounds(opts, "mainBounds"); // 꺼졌을 당시 위치·크기 복원
    // 풀스크린은 저장 모니터에 보이는 창을 먼저 배치 후 전환(숨긴 창 setFullScreen→메인 모니터 오작동 회피).
    const fs = !!(saved && saved.fullscreen);
    const max = !!(saved && saved.maximized && !fs);
    if (max) opts.show = false;
    win = new BrowserWindow(opts);
    if (max) { win.maximize(); win.once("ready-to-show", () => { try { win.show(); } catch {} }); }
    if (fs) win.once("ready-to-show", () => { try { win.setFullScreen(true); } catch {} });
    windowLayout.ownWindowTitle(win, opts.title);
    // 저장된 모니터가 아직 연결되지 않았으면 그 위치를 보관한 채 기다린다(위 awaitingDisplay 설명).
    if (saved && !windowLayout.boundsVisible(saved)) windowLayout.restoreWhenDisplayReturns(win, saved, () => windowLayout.placeSavedBounds(win, saved));
    windowLayout.trackWindowBounds(win, "mainBounds");
    win.on("closed", cancelLoadRetry);   // 닫힌 창에 로드를 거는 재시도가 남지 않게
    loadWithRetry();

    // 외부 링크는 기본 브라우저로(콘솔 창을 벗어나는 내비게이션 방지). webview 내부는 영향 없음.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(APP_URL)) return { action: "allow" };
      shell.openExternal(url);
      return { action: "deny" };
    });
    // 디버그: 렌더러 콘솔을 메인 stdout(→ 로그 파일)으로 파이프. [browser]/[오류] 추적용.
    // Electron이 console-message 시그니처를 (event, level, message)→(event{message,...}) 단일 객체로 바꿈.
    // 구·신 양쪽 호환: 3번째 인자가 문자열이면 구 API, 아니면 이벤트 객체의 .message 사용.
    win.webContents.on("console-message", (a, b, c) => {
      const message = (typeof c === "string") ? c : (a && typeof a.message === "string" ? a.message : "");
      if (/^\[browser\]|error|Error|픽|pick/i.test(message)) console.log("[renderer]", message);
    });
    // 브라우저 패널의 모든 <webview>에 요소-선택 전달용 preload를 붙인다(sendToHost IPC 브릿지).
    win.webContents.on("will-attach-webview", (_ev, webPreferences) => {
      webPreferences.preload = webviewPreloadPath;
      guardWebviewPartition(webPreferences);   // 알려진 파티션만 허용해 임의 세션이 붙지 않게 한다
      // 로그인·인증 흐름은 iframe 안에서 도는 경우가 많다(AWS 등). preload가 최상위 문서에만 걸리면
      // 그 안의 패스키 요청도 자동완성도 잡히지 않는다. sandbox preload라 Node가 열리는 게 아니라
      // preload가 프레임마다 도는 것뿐이다.
      webPreferences.nodeIntegrationInSubFrames = true;
      // 확인 창(alert/confirm/prompt)의 네이티브 시트를 끈다. 그 시트는 탭이 아니라 창에 붙어서,
      // 다른 탭이 띄운 요청도 현재 보고 있는 페이지 위에 뜨고 창 전체를 막는다.
      // 대신 CDP로 그 이벤트를 그대로 받으므로 내용은 잃지 않는다. 무엇을 묻는지 읽어
      // 탭 안에서 응답을 고르게 한다.
      webPreferences.disableDialogs = true;
      // 기본은 Chromium 스로틀을 허용하고 보호 탭만 창 단위 참조로 해제한다.
      // IRIS_NO_THROTTLE_OPT=1은 예전 전역 해제 동작을 그대로 복원한다.
      webPreferences.backgroundThrottling = !NO_THROTTLE_OPT;
    });
    // 화면 크기는 여기서 전달한다. 게스트가 화면에 붙은 뒤라야 그릴 표면이 있다. 탭이 만들어지는
    // 순간에 호출하면 Electron 이 종료된다. 보이지 않는 탭은 폭이 0이라 페이지가 모바일로 판정한다.
    win.webContents.on("did-attach-webview", (_ev, guest) => {
      // 방금 붙은 게스트에는 브라우저 탭이 아닌 것도 있다(rail 화면이 담는 webview). 그런 게스트는
      // 자기 위치에 그대로 보이므로 크기를 전달할 필요가 없다. 폭이 0 인 것만 보정한다.
      try { if (guest && !guest.isDestroyed()) setImmediate(() => pinHiddenViewportById(guest.id, webContents, { onlyIfCollapsed: true })); } catch {}
    });
  }

  // 서버가 아직 안 떠 있으면(로그인 직후 등) 잠시 후 재시도.
  //
  // 재시도는 창이 살아 있는 동안만 한다. 서버가 내려가 있으면 이 타이머가 계속 돌고, 그 상태에서
  // 사용자가 창을 닫으면 다음 차례에 이미 파괴된 창에 loadURL을 호출한다. 그 호출은 예외를 동기적으로
  // 던져서 .catch로 잡히지 않고, 메인 프로세스의 uncaught exception이 되어 Electron이 오류 창을
  // 띄운다. 타이머가 남아 있으면 창을 닫아도 1.2초마다 다시 뜨므로 앱을 강제 종료해야 한다.
  // 그래서 (1) 창이 없거나 파괴됐으면 멈추고 (2) 동기 예외도 함께 받고 (3) 창이 닫히면
  // 예약된 타이머를 해제한다.
  let loadRetryTimer = null;
  function cancelLoadRetry() { if (loadRetryTimer) { clearTimeout(loadRetryTimer); loadRetryTimer = null; } }
  function scheduleLoadRetry() {
    if (!win || win.isDestroyed() || loadRetryTimer) return;
    loadRetryTimer = setTimeout(() => { loadRetryTimer = null; loadWithRetry(); }, 1200);
  }
  function loadWithRetry() {
    if (!win || win.isDestroyed()) return cancelLoadRetry();
    try { win.loadURL(APP_URL).catch(() => scheduleLoadRetry()); }
    catch { scheduleLoadRetry(); }
  }
  // did-fail-load 도 재시도(초기 커넥션 거부).
  app.on("web-contents-created", (_e, contents) => {
    contents.on("did-fail-load", (_ev, code) => {
      if (contents === win?.webContents && code !== -3) scheduleLoadRetry();
    });
    // 브라우저(webview) 확대/축소: Cmd +/-/0. 포커스가 webview에 있어도 동작하도록 메인에서 처리.
    if (contents.getType() === "webview") {
      contents.on("before-input-event", (ev, input) => {
        if (input.type !== "keyDown") return;
        const k = input.key;
        // webview에 포커스가 있으면 렌더러 document keydown이 안 뜨므로, 콘솔 단축키를 메인에서
        // 가로채 이름으로 렌더러에 전달한다. document 핸들러와는 포커스로 상호배타 → 이중 처리 없음.
        const send = (name) => { const ow = BrowserWindow.fromWebContents(contents.hostWebContents) || win; if (ow && !ow.isDestroyed()) ow.webContents.send("ac-shortcut", name); ev.preventDefault(); }; // 포커스된 webview의 소유 창(메인/브라우저)으로 라우팅
        // 어떤 동작이 어느 조합에 걸려 있는지는 창이 보관한 표가 정한다. 그 표가 도착하기 전(창이
        // 아직 뜨지 않은 첫 순간)에는 아래 기본표를 쓴다. 기본표가 표의 기본값과 다르면 검사가 실패한다.
        const hit = matchRelay(input);
        if (hit) return send(hit);
        // 아래는 표에서 잠근 항목이다. 포커스에 따라 동작이 달라지거나 여기서 직접 처리해야 하므로
        // 이름으로 중계하지 않는다.
        if (!(input.meta || input.control)) return; // 이하 cmd/ctrl 계열만
        const kl = (k || "").toLowerCase();
        if (kl === "w" && !input.shift && input.control && !input.meta) return send("close-tab"); // 탭 닫기=ctrl+w(cmd+w 아님)
        // 브라우저 리로드(webview 포커스 시): ⌘R=리로드, ⌘⇧R=강제 리로드. ⌘⌃R(전체 새로고침)·⌥ 계열은 제외.
        if (kl === "r" && !input.control && !input.alt) { return send(input.shift ? "force-reload-tab" : "reload-tab"); }
        if (k === "=" || k === "+") { contents.setZoomLevel(contents.getZoomLevel() + 0.5); ev.preventDefault(); }
        else if (k === "-" || k === "_") { contents.setZoomLevel(contents.getZoomLevel() - 0.5); ev.preventDefault(); }
        else if (k === "0") { contents.setZoomLevel(0); ev.preventDefault(); }
      });
    }
  });

  return { createWindow, loadUrlWithRetry, getWindow: () => win };
}

module.exports = { createMainWindow, setRelayKeymap, DEFAULT_RELAY };
