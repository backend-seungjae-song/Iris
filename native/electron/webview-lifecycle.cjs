// 웹뷰의 CDP 주입·자식 타깃·팝업 수명주기를 한 훅에서 묶는다.
//
// 소유 범위
//   app 의 web-contents-created 훅과, 웹뷰가 여는 팝업의 허용 옵션·등록·정리 수명주기.
//
// 제공 API
//   createWebviewLifecycle(deps) 함수 하나만 제공한다. 훅이나 팝업 상태를 원시 값으로 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. app 과 CDP primer·자식 타깃 장부·스로틀·팝업 registry·전송
//   함수, 주입할 스크립트와 현재 APP URL 접근자를 main.cjs 에서 받는다.
//   페이지 우클릭 메뉴도 여기서 만들지 않는다. webview-context-menu 가 만든 attach 를 받아
//   guest 마다 한 번 건다.
//
// 유지 조건
//   foreground-tab/background-tab 은 호스트의 ac-open-tab 으로 보내고 new-window 만 Electron 팝업을
//   허용한다. openerWc 를 빼면 새 탭이 부모 프로필을 잃는다.
//   로컬 링크(file:)는 브라우저 탭으로 열지 않고 앱으로 넘긴다(ac-open-local). 표·문서는 브라우저가
//   렌더링하지 못해 아무 일도 일어나지 않는다. 넘기는 것은 여는 쪽 페이지가 로컬일 때뿐이다. 원격 페이지가
//   지정한 file: 을 받으면 외부 페이지의 요청으로 이 기계의 파일이 앱 화면에 뜬다.
//   이동을 가로채는 것은 앱이 그리기로 한 확장자(appDrawsLink)뿐이다. 그 표는 렌더러의 것이고
//   여기는 복사본만 본다. 표에 없으면 브라우저가 렌더링하는 것이 기본이다.
//   CDP 는 탭 생성·탐색만으로는 붙이지 않는다. 붙어 있는 것 자체가 봇 판정 신호라, 붙일지는
//   cdp-control 의 부착 정책(AI 조작 중·녹화 중·유지 조건)이 정한다. 여기는 CDP 세션이 생길 때
//   심을 목록(session primer)을 등록하고, CDP 가 없는 사람 탭에는 같은 스크립트를 dom-ready 에서
//   WebFrameMain.executeJavaScript 로 심는다(main world 라 CSP 를 받지 않는다). 자식 타깃은 처음
//   붙을 때만 심되 그 자식에도 자동 부착을 걸어 중첩 교차 출처 iframe까지 잇는다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron app, browser-hardening 스크립트, webview-throttle 과 cdp-control 이다.
//   양방향 소비자는 webview를 만드는 메인·분리 브라우저 창, 렌더러 ac-open-tab 프로필 상속,
//   서버의 popup tab registry다. 여기서 어긋나면 로그인 세션·확인창·프레임 자동화가 함께 끊긴다.
//   현재 목록 확인: node bin/importers.mjs native/electron/webview-lifecycle.cjs

const { isFileUrl, isLocalPage } = require("./local-link.cjs");

function createWebviewLifecycle({
  app,
  noThrottleOpt,
  getAppUrl,
  clearThrottleState,
  forgetSecrets,
  dialogScript,
  webAuthnScript,
  botcheckScript,
  registerSessionPrimer,
  // main-frame 탐색을 부착 정책에 알린다(로그인 호스트 진입 시 즉시 detach). url null 은 탐색 종료.
  noteNavigation = () => false,
  forgetAttachPolicy = () => {},
  noteFrameOrigin,
  dropChildSession,
  noteChildSession,
  randomUuid,
  registerPopup,
  unregisterPopup,
  setThrottleReason,
  reconcilePopupThrottling,
  ctlSend,
  attachContextMenu,
  aiDriving,
  aiDrivingAnywhere,
  holdAiCausality,
  // 앱이 렌더링하는 링크인지 판정한다. 확장자 표는 렌더러가 소유하고 여기는 복사본만 본다.
  appDrawsLink = () => false,
}) {
  const SAFE_POPUP_WINDOW_OPTIONS = {
    alwaysOnTop: false, closable: true, focusable: true, frame: true, fullscreen: false, kiosk: false,
    modal: false, movable: true, opacity: 1, show: true, simpleFullscreen: false, skipTaskbar: false,
    titleBarStyle: "default", transparent: false,
    webPreferences: { allowRunningInsecureContent: false, backgroundThrottling: !noThrottleOpt,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true, webviewTag: false },
  };

  // 팝업 창을 띄우는 위치. 사용자가 눌러 뜬 창은 앞으로 내고, 자동화가 연 창은 층위를 한 단계 내린다.
  // showInactive 는 포커스 없이 띄우는 것일 뿐이고 다른 앱 창 위에 표시되기 때문이다(확인 결과).
  // 층위를 내린 창은 다른 앱의 보통 창보다 아래에 있으면서도 계속 그린다(확인 결과: 초당 120프레임).
  // 사용자가 그 창을 열면 층위를 되돌린다. 되돌리지 않으면 한 번 내린 창이 계속 뒤에 남는다.
  // 팝업과 그 팝업이 또 여는 창이 같은 규칙을 써야 해서 한 자리에 둔다.
  // 그 창이 스스로 로드하는 동안에도 인과를 이어 준다. 명령은 부모 wc 에서 실행됐고 이 창은 자기 wc 라,
  // 물려주지 않으면 로드 중에 시작되는 내려받기·권한 요청이 사용자 조작으로 분류된다.
  // 로드가 끝나거나 창이 닫히면 해제한다. 끝나지 않는 페이지가 표식을 계속 점유하지 않게 상한도 둔다.
  const INHERIT_MAX_MS = 20000;
  function inheritCausality(childWc, win) {
    if (!holdAiCausality || !childWc || childWc.isDestroyed()) return;
    let release;
    try { release = holdAiCausality(childWc.id); } catch { return; }
    let done = false;
    const stop = () => { if (done) return; done = true; try { release(); } catch {} };
    const timer = setTimeout(stop, INHERIT_MAX_MS);
    const end = () => { clearTimeout(timer); stop(); };
    try {
      childWc.once("did-stop-loading", end);
      childWc.once("destroyed", end);
      if (win) win.once("closed", end);
    } catch { end(); }
  }

  function presentPopup(openerWcId, win) {
    const toFront = aiDriving ? !aiDriving(openerWcId) : true;
    if (!toFront) { try { inheritCausality(win.webContents, win); } catch {} }
    try {
      if (toFront) { win.show(); win.focus(); return; }
      win.setAlwaysOnTop(true, "normal", -1);
      // 포커스가 곧 사용자 조작은 아니다. 페이지가 window.focus() 를 호출하면 자동화가 실행하는 중에도
      // 이 창이 앞으로 나온다. 자동화가 실행 중이면 되돌리지 않는다.
      win.on("focus", () => {
        try { if (!(aiDrivingAnywhere && aiDrivingAnywhere())) win.setAlwaysOnTop(false); } catch {}
      });
      win.showInactive();
    } catch {}
  }

  app.on("web-contents-created", (_e, wc) => {
    try {
      if (wc.getType() !== "webview") return;
      // AI 명령이 실행되는 중에 생성된 webview 는 그 명령이 연 탭이다. 자기 wc 에는 명령이 없으므로
      // 물려주지 않으면 로드 중 내려받기·권한 요청이 사용자 조작으로 분류된다.
      if (aiDrivingAnywhere && aiDrivingAnywhere()) inheritCausality(wc, null);
      wc.setBackgroundThrottling(!noThrottleOpt); // 보호 사유는 렌더러/캡처 참조가 생긴 순간 아래에서 해제
      wc.once("destroyed", () => clearThrottleState(wc));
      // 페이지 우클릭 메뉴. guest 마다 한 번만 건다. 이 훅 자체가 생성 시점에 한 번 실행된다.
      try { if (attachContextMenu) attachContextMenu(wc); } catch {}
      // 페이지를 떠나면 채운 비번은 그 문서와 함께 사라지므로 가림막도 함께 제거한다(계속 쌓이지 않게 한다).
      wc.on("did-start-navigation", (_ev, _u, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) forgetSecrets(wc.id); });
      wc.once("destroyed", () => forgetSecrets(wc.id));
      // CSP가 엄격한 사이트는 preload가 넣는 인라인 <script>를 실행하지 않는다(확인 결과:
      // signin.aws.amazon.com에서 주입 스크립트가 실행되지 않아 패스키 감지가 동작하지 않았다).
      // CDP의 addScriptToEvaluateOnNewDocument는 main world에서 문서보다 먼저 돌고 CSP를 받지 않는다.
      // runImmediately는 이미 로드된 문서에도 적용되므로, 열려 있던 탭을 새로고침하지 않아도 적용된다.
      try {
        const dbg = wc.debugger;
        // alert/confirm/prompt를 이 탭 안에서 묻도록 바꾼다. wc를 스크립트에 넣어야 서버가
        // 어느 탭의 요청인지 알 수 있다. 페이지는 자기 wc를 알지 못한다.
        const dlgSrc = dialogScript(wc.id, new URL(getAppUrl()).port || 4271);
        // 아래 주입·자동 부착은 CDP 세션에 걸리므로 세션을 분리하면 함께 사라진다. 세션을 다시 붙일 때도
        // 그대로 다시 걸려야 해서 목록을 cdp-control 에 등록해 둔다. 여기서는 등록만 하고 붙이지 않는다.
        // 붙이는 시점은 첫 AI 명령·녹화 시작이고, 그때 cdp-session 이 이 목록을 실행한다.
        registerSessionPrimer(wc.id, (w, d) => {
          d.sendCommand("Page.addScriptToEvaluateOnNewDocument",
            { source: webAuthnScript, runImmediately: true }).catch(() => {});
          // 사람 확인 오류는 기존 UI에 전달한다. 실패가 곧 엔진의 불가 판정은 아니다.
          d.sendCommand("Page.addScriptToEvaluateOnNewDocument",
            { source: botcheckScript, runImmediately: true }).catch(() => {});
          d.sendCommand("Page.addScriptToEvaluateOnNewDocument",
            { source: dlgSrc, runImmediately: true }).catch(() => {});
          // 교차 출처 iframe은 별도 프로세스·별도 타깃(OOPIF)이라 위 주입이 적용되지 않는다. 그 안에서
          // 뜬 확인창은 앱의 확인창으로 바뀌지 않고, 크롬은 교차 출처 프레임의 네이티브 확인창을 무시하므로
          // confirm 이 묻지 않고 false 가 되어 그 프레임의 버튼이 동작하지 않는다(확인 결과: 다른 출처의
          // iframe 안에 뜬 주문서의 [적용하기]). 자식 타깃에 붙어 같은 스크립트를 주입한다.
          d.sendCommand("Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
          // 자동 부착은 이미 떠 있는 iframe 에도 즉시 attachedToTarget 을 내보내므로, 늦게 붙어도
          // 그 시점의 프레임 목록을 전부 받는다.
          d.sendCommand("Page.enable", {}).catch(() => {});
        }, (d, sid) => {
          // 처음 붙은 자식 프레임에만 실행된다(noteChildSession 이 걸러 준다). 여기서 다시 주입하면
          // 자동 부착을 새로 걸 때마다 그 프레임의 스크립트가 한 벌씩 늘어난다.
          // 자식 타깃도 자기 자식(중첩 iframe)을 붙일 수 있어야 한다. 한 겹만 처리하면 더 깊은 프레임이 누락된다.
          d.sendCommand("Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
          d.sendCommand("Page.addScriptToEvaluateOnNewDocument",
            { source: dlgSrc, runImmediately: true }, sid).catch(() => {});
          d.sendCommand("Page.addScriptToEvaluateOnNewDocument",
            { source: webAuthnScript, runImmediately: true }, sid).catch(() => {});
        });
        wc.once("destroyed", () => { registerSessionPrimer(wc.id, null); forgetAttachPolicy(wc.id); });
        // 수신기는 붙기 전에 걸어 둔다. debugger 는 EventEmitter 라 attach 전에도 걸 수 있고, 이렇게
        // 해야 첫 부착 직후 Target.setAutoAttach 가 즉시 내보내는 자식 타깃을 놓치지 않는다.
        dbg.on("message", (_e, method, params) => {
          if (method === "Page.frameNavigated") { noteFrameOrigin(wc.id, params && params.frame && params.frame.url); return; }
          if (method === "Target.detachedFromTarget") { dropChildSession(wc.id, params && params.sessionId); return; }
          if (method !== "Target.attachedToTarget") return;
          const sid = params && params.sessionId;
          const ti = params && params.targetInfo;
          if (sid && ti && (ti.type === "iframe" || ti.type === "page")) noteChildSession(wc.id, sid, dbg);
        });
        // 탐색 목적지를 정책에 알린다. 리다이렉트로 로그인 호스트에 들어가는 경우가 흔해(OAuth)
        // 시작 URL 만 보면 놓친다. 탐색이 끝나면 null 로 지워 다음 판정이 실제 문서 주소를 쓰게 한다.
        wc.on("did-start-navigation", (_ev, url, isInPlace, isMainFrame) => {
          if (!isMainFrame || isInPlace) return;
          try { noteNavigation(wc.id, url); } catch {}
        });
        wc.on("will-redirect", (ev, url, _isInPlace, isMainFrame) => {
          if (isMainFrame === false || (ev && ev.isMainFrame === false)) return;
          try { noteNavigation(wc.id, url); } catch {}
        });
        wc.on("did-stop-loading", () => { try { noteNavigation(wc.id, null); } catch {} });
        // CDP 가 없는 사람 탭에도 같은 스크립트가 있어야 앱 안 확인창·패스키 알림·사람 확인 실패
        // 알림이 유지된다. 문서 시작 전 창은 잃지만(dom-ready 전에 뜬 확인창은 네이티브 시트),
        // 세 스크립트는 자기 표식으로 두 번 실행을 막으므로 나중에 CDP 가 붙어도 겹치지 않는다.
        const injectHuman = (frame) => {
          if (!frame || wc.isDestroyed()) return;
          let attached = false;
          try { attached = dbg.isAttached(); } catch {}
          if (attached) return;   // CDP 세션이 있으면 document-start 주입이 이미 걸려 있다
          for (const src of [webAuthnScript, botcheckScript, dlgSrc]) {
            try { const p = frame.executeJavaScript(src, true); if (p && p.catch) p.catch(() => {}); } catch {}
          }
        };
        wc.on("dom-ready", () => injectHuman(wc.mainFrame));
        wc.on("frame-created", (_ev, details) => {
          const frame = details && details.frame;
          if (!frame || !frame.parent) return;   // 최상위 문서는 dom-ready 가 맡는다
          try { frame.once("dom-ready", () => injectHuman(frame)); } catch {}
        });
      } catch {}
      // 이 페이지가 로컬에서 온 것인지 판정한다. 원격 페이지가 여는 file: 은 허용하지 않는다. 허용하면
      // 외부 페이지가 이 기계의 파일을 앱 화면에 띄울 수 있다.
      const pageIsLocal = () => { try { return isLocalPage(wc.getURL()); } catch { return false; } };
      const toHost = (channel, payload) => {
        try {
          const host = wc.hostWebContents;
          if (host && !host.isDestroyed()) { host.send(channel, payload); return true; }
        } catch {}
        return false;
      };
      // 브라우저가 렌더링할 수 있는 것은 브라우저가 렌더링한다. 앱이 렌더링하는 것(마크다운)만 가로챈다.
      // 나머지는 렌더링하지 못하는 순간 내려받기로 분류되고, 그 경로는 download-hook 이 담당한다.
      wc.on("will-navigate", (ev, url) => {
        try {
          if (ev && ev.isMainFrame === false) return;
          const u = String(url || (ev && ev.url) || "");
          if (!isFileUrl(u) || !appDrawsLink(u) || !pageIsLocal()) return;
          if (!toHost("ac-open-local", { target: u })) return;
          ev.preventDefault();
        } catch {}
      });
      wc.setWindowOpenHandler(({ url, disposition }) => {
        if (!/^https?:/i.test(url || "")) {
          // 로컬 링크의 새 탭 요청(target=_blank·⌘클릭·가운데클릭). 여기서 차단하면 아무 일도
          // 일어나지 않아 눌리지 않는 링크로 보인다. 어디로 보낼지는 렌더러가 정한다.
          if (isFileUrl(url) && pageIsLocal()) toHost("ac-open-local", { target: String(url) });
          return { action: "deny" };  // 그 밖의 scheme 은 그대로 차단
        }
        // "새 탭으로 열기"는 앱 브라우저의 탭이어야 한다. target=_blank·가운데클릭은 disposition이
        // foreground-tab/background-tab으로 오는데, 이걸 팝업 창으로 열면 별도 Electron 창이 뜬다
        // 그러면 흰 화면만 나오는 창이 뜬다. OAuth처럼 크기·이름을 준 window.open만 new-window로 온다.
        if (disposition === "foreground-tab" || disposition === "background-tab") {
          const host = wc.hostWebContents;
          if (host && !host.isDestroyed()) {
            // 자동화가 연 새 탭은 배경으로 연다. 앞으로 열면 사용자가 보던 화면이 그 탭으로 바뀐다.
            // 사용자가 누른 새 탭은 그대로 앞에 표시한다.
            const byAi = aiDriving ? !!aiDriving(wc.id) : false;
            // 연 탭의 정체를 함께 넘긴다. 새 탭은 부모와 같은 프로필(세션)이어야 한다. 넘기지 않으면
            // 스페이스 기본 프로필로 떨어져 방금까지 로그인돼 있던 사이트가 로그아웃 상태로 열린다
            // (확인 결과: AWS 콘솔은 서비스를 새 탭으로 여는데 그때마다 세션이 달라졌다).
            host.send("ac-open-tab", { url, background: byAi || disposition === "background-tab", openerWc: wc.id });
            return { action: "deny" };
          }
        }
        // http(s) 팝업(OAuth 포함)은 opener·세션 공유 자식 창으로 허용.
        // 자동화가 여는 팝업은 처음부터 보이지 않게 만든다. 만든 뒤에 층위를 내리면 이미 한 번
        // 표시된 뒤라 되돌릴 수 없다. 표시는 아래 did-create-window 에서 한다.
        const popupByAi = aiDriving ? !!aiDriving(wc.id) : false;
        return { action: "allow",
          overrideBrowserWindowOptions: popupByAi ? { ...SAFE_POPUP_WINDOW_OPTIONS, show: false } : SAFE_POPUP_WINDOW_OPTIONS };
      });
      // 팝업 자식 창은 opener 세션을 공유하며 탐색·초점·종료를 함께 관리한다.
      // 우리 브라우저에서 직접 재현·검증: OAuth 팝업은 정상적으로 열려 콜백(code)까지 도달하고
      // postMessage(JWT)로 opener에 결과를 전달하며 토큰도 저장된다. 그러나 사이트(챗플 등)가 이 환경에서
      // 반응성 UI를 즉시 갱신하지 못해 메인 페이지는 새로고침 전까지 로그아웃 상태로 보인다(새로고침하면 다시 반영된다).
      // → 팝업이 opener 도메인(로그인 콜백)까지 도달한 뒤 닫히면 opener를 자동 reload해 저장된 로그인을 반영한다.
      wc.on("did-create-window", (childWin) => {
        try {
          const cwc = childWin.webContents; cwc.setBackgroundThrottling(!noThrottleOpt);
          // 사용자가 눌러 뜬 팝업은 앞으로 띄운다(뒤에 숨는 것 방지). 자동화가 연 팝업은 층위를 한 단계
          // 내려서 띄운다. showInactive 는 포커스 없이 띄우는 것일 뿐 다른 앱 창 위에 표시되기 때문이다
          // (확인 결과). 층위를 내린 창은 다른 앱의 보통 창보다 아래에 있으면서도 계속 그린다
          // (확인 결과: 초당 120프레임, 캡처 정상). 사람이 그 창을 부르면 층위를 되돌린다.
          presentPopup(wc.id, childWin);
          // 팝업도 조작 대상이다. 렌더러가 모르는 창이라 여기서 직접 등록하지 않으면 tabs에 나타나지 않고
          // 조작할 수 없다. 등록 폼·결제·OAuth 동의처럼 팝업으로만 뜨는 화면이 모두 제외된다.
          // 스페이스는 연 탭(opener)의 것을 그대로 물려받는다: 격리 경계가 팝업에서 새면 안 된다.
          const openerWc = wc.id;
          // 정체성은 이 창이 존재하는 동안 한 번만 만들고 다시 겹치지 않는 값이어야 한다.
          // "popup:<wc>" 를 쓰면 wc가 재발급되는 번호라, 지목받은 팝업을 닫은 뒤 같은 번호를 받은
          // 다른 팝업이 그 지목을 그대로 이어받는다(닫아도 지목은 tab.close 경로에서만 해제된다).
          // 팝업이 또 여는 팝업. 이 자식은 webview 가 아니라 창이라 위의 web-contents-created 정책이
          // 적용되지 않는다. 정책이 없는 창은 항상 앞으로 표시된다.
          // 부모와 같은 규칙을 그 자리에서 건다. http(s) 아닌 주소는 창으로 열지 않는다.
          try {
            cwc.setWindowOpenHandler(({ url: childUrl }) => {
              if (!/^https?:/i.test(String(childUrl || ""))) return { action: "deny" };
              const byAi = aiDriving ? !!aiDriving(cwc.id) : false;
              return { action: "allow",
                overrideBrowserWindowOptions: byAi ? { ...SAFE_POPUP_WINDOW_OPTIONS, show: false } : SAFE_POPUP_WINDOW_OPTIONS };
            });
            // 보이지 않게 만들었으면 표시하는 자리도 있어야 한다. 이 처리가 없으면 자동화가 연 손자 창이
            // 만들어지기만 하고 표시되지 않아 사용자가 찾을 수 없다.
            cwc.on("did-create-window", (grandWin) => presentPopup(cwc.id, grandWin));
          } catch {}
          const popupId = "popup:" + randomUuid();
          registerPopup(popupId, cwc);
          const syncPopupFocus = () => setThrottleReason(cwc, "popup-focused", childWin.isFocused());
          childWin.on("focus", syncPopupFocus);
          childWin.on("blur", syncPopupFocus);
          syncPopupFocus();
          reconcilePopupThrottling();
          // 팝업 창에는 주소창이 없다. 제목까지 페이지가 정하면 사용자가 이 창의 목적지를 확인할
          // 방법이 없다. 로그인·결제가 팝업으로 뜨므로 목적지를 확인할 수 있어야 한다.
          // 그래서 제목은 실제 주소에서 뽑아 설정하고, 페이지의 제목 변경은 막는다.
          // (Orca 는 창 위에 origin 띠를 따로 그린다. 여기서는 같은 목적을 창 제목으로 달성한다.)
          const stampOrigin = () => {
            let label = "팝업";
            try {
              const u = new URL(cwc.getURL());
              label = u.protocol === "https:" ? u.host : `${u.protocol}//${u.host} (안전하지 않음)`;
            } catch {}
            try { childWin.setTitle(label); } catch {}
          };
          try { cwc.on("page-title-updated", (ev) => { ev.preventDefault(); stampOrigin(); }); } catch {}
          cwc.on("did-navigate", stampOrigin);
          cwc.on("did-navigate-in-page", stampOrigin);
          stampOrigin();
          const reg = () => {
            let title = "";
            try { title = cwc.getTitle() || ""; } catch {}
            ctlSend({ type: "browser-tab-wc", wc: cwc.id, tabId: popupId,
              url: (() => { try { return cwc.getURL() || ""; } catch { return ""; } })(),
              title: title || "팝업 창", win: "popup", openerWc });
          };
          reg();
          cwc.on("did-navigate", reg);
          cwc.on("page-title-updated", reg);
          cwc.once("destroyed", () => {
            unregisterPopup(popupId); clearThrottleState(cwc);
            ctlSend({ type: "browser-tab-gone", wc: cwc.id, tabId: popupId });
          });
          childWin.once("closed", () => {
            unregisterPopup(popupId);
            ctlSend({ type: "browser-tab-gone", wc: cwc.id, tabId: popupId });
          });
          let reachedOpenerOrigin = false, openerHost = "";
          try { openerHost = new URL(wc.getURL()).host; } catch {}
          cwc.on("did-navigate", (_ev, u) => { try { if (openerHost && new URL(u).host === openerHost) reachedOpenerOrigin = true; } catch {} });
          childWin.on("closed", () => {
            // 콜백(opener 도메인) 도달 후 닫힘 = 로그인 완료 → 토큰 저장 완료 대기 후 opener reload. 미도달이면 skip.
            if (reachedOpenerOrigin) setTimeout(() => { try { if (!wc.isDestroyed()) wc.reload(); } catch {} }, 350);
          });
        } catch {}
      });
    } catch {}
  });
}

module.exports = { createWebviewLifecycle };
