// 요소 선택 모드의 OS 커서·창 순서·픽 IPC를 한곳에서 맡는다.
//
// 소유 범위
//   픽 구독 webContents, 커서 펌프 timer, 우리 창의 focus 순서와 macOS 실제 z-order cache.
//
// 제공 API
//   createPickMode(deps) 함수 하나만 제공한다. 만들어진 API는 활성 여부 접근자와 ready 시점의
//   전역 단축키 등록 명령이며 원시 Set·timer·z-order 목록은 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. app·screen·globalShortcut·BrowserWindow·ipcMain과 현재 메인 창
//   접근자, browser-window-manager의 창 조회, CDP overlay·hover·diag·screenshot port를 main.cjs에서 받는다.
//
// 유지 조건
//   좌표는 게스트 mousemove가 아니라 OS에서 읽고, 커서 위치의 맨 앞 창이 앱의 창일 때만 그중
//   focus 순서가 위인 한 창에 보낸다. 포커스 자체를 앱 구분 기준으로 쓰지 않으며, 가려졌다가
//   올라온 첫 클릭은 entered로 표시한다. 픽 해제·창 종료·앱 종료에서 포커스 가능 상태를 복구한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron API·메인 창 접근자, browser-window-manager와 cdp-control이다.
//   양방향 소비자는 browser-window-manager의 새 창 focusable 판정, preload의 ac-cursor/shortcut bridge,
//   렌더러 pick·record 경로와 서버의 pick relay다. 어긋나면 겹친 창 하이라이트·첫 클릭·녹화 증거가 함께 깨진다.
//   현재 목록 확인: node bin/importers.mjs native/electron/pick-mode.cjs

function createPickMode({
  app, screen, globalShortcut, BrowserWindow, ipcMain, execFile, browserWindowManager,
  getMainWindow, isTrustedSender, injectOverlayAllFrames, hoverAtPoint, diagSince, runCdp, webContents,
}) {
  // 요소 선택 모드의 커서 추적. 포커스가 메인 창(채팅)에 있으면 분리 브라우저 창은 mousemove를 거의
  // 받지 못한다(확인 결과: 5초 호버에 1건, 그것도 창 경계 진입 1회). 그래서 하이라이트를 게스트의
  // mousemove가 아니라 OS 커서 좌표로 움직인다. screen.getCursorScreenPoint()는 포커스와 무관하게 읽힌다.
  // 좌표→요소 변환은 렌더러가 한다(webview의 화면상 위치를 아는 쪽이 렌더러다).
  let cursorTimer = null;
  const cursorSubs = new Set(); // 픽 모드가 켜진 창들의 webContents

  // 선택 가능한 표면이 여럿 겹쳐 있을 때는 맨 위 하나만 반응해야 한다. 커서 좌표만 보고 전달하면
  // 시뮬레이터 뒤에 깔린 브라우저 창도 함께 하이라이트된다. 기준은 하나로,
  // 커서 위치에서 실제로 맨 앞인 창이 앱의 창인지다(topmostIsOurs).
  // 포커스는 기준이 아니다. 앱이 활성일 때만 좌표를 전달하면, 에뮬레이터에 포커스를 둔 채
  // 브라우저 요소를 고르러 갈 때 하이라이트가 떴다가 곧바로 지워진다.
  // 게스트가 자기 mousemove로 그린 것을 33ms 뒤에 보낸 null이 지우기 때문이다. 포커스는 어느 창이
  // 위에 있는지와 다른 정보이고, 지금은 화면에 쌓인 순서를 직접 확인하므로 그 대리 기준이 필요 없다.
  // 앱의 창끼리 겹친 경우에만 포커스 순서를 쓴다. macOS는 포커스한 창을 위로 올리므로 그 안에서는
  // 이 순서가 곧 위아래다.
  const focusOrder = [];
  app.on("browser-window-focus", (_e, w) => {
    const i = focusOrder.indexOf(w);
    if (i >= 0) focusOrder.splice(i, 1);
    focusOrder.unshift(w);
  });
  function windowUnderCursor(pt) {
    const over = (w) => {
      try {
        if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) return false;
        const b = w.getBounds();
        return pt.x >= b.x && pt.y >= b.y && pt.x < b.x + b.width && pt.y < b.y + b.height;
      } catch { return false; }
    };
    return focusOrder.find(over) || BrowserWindow.getAllWindows().find(over) || null;
  }

  // 화면에 실제로 쌓인 순서를 확인한다. CGWindowList가 앞에서 뒤 순으로 돌려준다. 커서가 얹힌 첫 창이
  // 앱의 창이 아니면 전달하지 않는다. 포커스와는 다른 정보다. 시뮬레이터에 포커스가 있어도 커서 위치에서
  // 앱의 창이 가려져 있지 않으면 그 위치의 맨 앞은 앱의 창이다.
  // 창은 자주 움직이지 않으므로 목록은 잠시 캐시하고, 갱신은 비동기로 돌려 30Hz 펌프를 막지 않는다.
  // 커서가 앱의 창 밖이면 조회 자체를 하지 않는다(그때는 결과가 정해져 있다).
  const Z_SCRIPT = [
    "ObjC.import('CoreGraphics');ObjC.import('Foundation');",
    "var a=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,$.kCGNullWindowID));",
    "var n=a.count,o=[];",
    "for(var i=0;i<n;i++){var w=a.objectAtIndex(i);",
    "if(w.objectForKey('kCGWindowLayer').intValue!==0)continue;",
    "var b=ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds'));",
    "o.push([w.objectForKey('kCGWindowOwnerPID').intValue,b.X,b.Y,b.Width,b.Height]);}",
    "JSON.stringify(o)",
  ].join("");
  const Z_TTL_MS = 600;
  let zList = null, zAt = 0, zBusy = false;
  // 이 조회가 실패해도 커서 추적은 계속 돌아야 한다. 여기서 던진 예외가 매 틱마다 펌프를
  // 중단시키면 하이라이트가 마지막 위치에 멈춘 채로 남는다.
  function refreshZOrder() {
    if (zBusy || Date.now() - zAt < Z_TTL_MS) return;
    zBusy = true;
    try {
      execFile("osascript", ["-l", "JavaScript", "-e", Z_SCRIPT], { timeout: 2500 }, (err, out) => {
        zBusy = false; zAt = Date.now();
        if (err) return;
        try {
          const parsed = JSON.parse(String(out || "[]"));
          if (Array.isArray(parsed) && parsed.length) zList = parsed;
        } catch {}
      });
    } catch { zBusy = false; zAt = Date.now(); }
  }
  // 커서 아래 맨 앞 창이 앱의 창인지 판정한다. 아직 목록이 없으면 보류하지 않고 통과시킨다.
  // 첫 조회가 돌아오기 전 잠시 이전 동작을 유지하는 편이, 하이라이트가 전혀 뜨지 않는 것보다 낫다.
  function topmostIsOurs(pt) {
    try {
      refreshZOrder();
      if (!zList) return true;
      for (const [pid, x, y, w, h] of zList) {
        if (pt.x >= x && pt.y >= y && pt.x < x + w && pt.y < y + h) return pid === process.pid;
      }
    } catch {}
    return true;
  }
  // 직전 틱에 커서 위치의 맨 앞이 앱의 창이었는지. 다른 앱에 가려져 있다가 올라온 순간을 구분한다.
  // 창별이 아니라 하나로 둔다. 판정 대상이 커서가 이 창 안인지가 아니라 가린 앱이 있었는지이기 때문이다.
  let wasOurTopmost = true;
  function pumpCursor() {
    const pt = screen.getCursorScreenPoint();
    const ourTopmost = topmostIsOurs(pt);
    let top = windowUnderCursor(pt);
    if (top && !ourTopmost) top = null;
    // 다른 앱에 가려져 있다가 이 틱에 올라왔다. 그 직후의 첫 클릭은 창을 활성화하는 클릭이지
    // 요소를 고르는 클릭이 아니다. 시뮬레이터에서 위젯을 고르고 콘솔로 돌아오는 클릭이 그대로
    // 요소 선택으로 처리되면, 앱만 골랐는데 웹 요소가 함께 선택된다.
    const entered = ourTopmost && !wasOurTopmost;
    wasOurTopmost = ourTopmost;
    for (const wc of [...cursorSubs]) {
      if (wc.isDestroyed()) { cursorSubs.delete(wc); continue; }
      let mine = null;
      try { mine = BrowserWindow.fromWebContents(wc); } catch {}
      // 맨 위가 아니면 좌표 대신 null을 보내고, 받은 창은 하이라이트를 지운다(남아 있으면
      // 뒤쪽 창이 반응하는 것처럼 보인다).
      const on = !!(top && mine === top);
      wc.send("ac-cursor", on ? (entered ? { x: pt.x, y: pt.y, entered: true } : pt) : null);
    }
    if (!cursorSubs.size) { clearInterval(cursorTimer); cursorTimer = null; }
  }
  // 픽 모드 동안 분리 브라우저 창을 포커스 불가로 만든다. 그러면 클릭이 창을 활성화하지 못하므로
  // 채팅 포커스가 아예 안 떠나고, acceptFirstMouse 덕에 그 클릭이 곧바로 요소 선택으로 간다.
  // 복구는 픽 해제·창 종료·앱 종료 세 지점에서 보장한다(포커스 불가 상태로 남는 것 방지).
  function setBrowserWinsFocusable(focusable) {
    for (const w of browserWindowManager.allBrowserWindows()) { try { if (!w.isDestroyed()) w.setFocusable(focusable); } catch {} }
  }
  // 요소 선택은 시뮬레이터·에뮬레이터를 보는 중에 켜고 끄게 된다. 그 창에 포커스가 있으면
  // 앱 안에서 잡는 단축키는 오지 않는다. Iris로 한 번 이동해야 하고, 그 사이 보던 화면이 바뀐다.
  // 전역 단축키는 어느 앱이 앞에 있든 도달한다. 켜고 끄는 스위치 하나만 전역으로 등록한다.
  function togglePickModeGlobal() {
    // 분리된 스페이스 브라우저 창이 있으면 실제 콘텐츠(docx/sheet/webview)는 대개 메인 창이 아니라
    // 그 창에 있다. 항상 메인 창(win)으로 보내면 그 창에는 선택 대상이 없어 서버 게이트("탭을 먼저
    // 열어주세요")에 막혀 아무 일도 일어나지 않는다. 메인 창의 포커스 여부와 무관하게 전역 단축키는
    // 실제 콘텐츠가 있는 창으로 가야 한다.
    const bw = browserWindowManager.firstBrowserModeWindow();
    const win = getMainWindow();
    const w = bw || ((win && !win.isDestroyed()) ? win : BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()));
    if (w) { try { w.webContents.send("ac-shortcut", "pick-toggle"); } catch {} }
  }
  // 등록은 아래 ready 훅 한 곳에서 한다. 여기서 따로 등록하면 ready 전에 적용할 항목의 기준이
  // 둘로 갈린다.
  // 시뮬레이터·에뮬레이터에 포커스가 있어도 요소 선택을 켜고 끌 수 있게(앱 안 단축키는 그때 안 온다).
  function registerGlobalShortcut() {
    try { globalShortcut.register("CommandOrControl+Shift+E", togglePickModeGlobal); } catch {}
  }
  app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch {} });

  // 요소 선택 오버레이·조작 기록기를 그 탭의 모든 문서에 주입한다. 렌더러의 webview.executeJavaScript
  // 는 최상위 프레임에서만 실행되므로, 내용이 iframe 안에 있는 화면은
  // 클릭해도 반응이 없고 그 안의 조작이 녹화에도 남지 않는다.
  ipcMain.on("ac-frames-inject", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return;
      const wcId = Number(arg && arg.wc);
      const key = arg && typeof arg.key === "string" ? arg.key : "";
      if (!wcId || !key || !arg || typeof arg.src !== "string") return;
      injectOverlayAllFrames(wcId, key, arg.src, !!arg.on, webContents);
    } catch {}
  });
  // 앱에 포커스가 없을 때의 커서 추적. Chromium이 좌표에 맞는 프레임으로 전달한다.
  ipcMain.on("ac-frames-hover", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return;
      if (!arg || !arg.wc) return;
      hoverAtPoint(arg.wc, arg.x, arg.y, webContents);
    } catch {}
  });
  // 녹화에 합칠 관찰 기록(콘솔·예외·네트워크 실패·확인창).
  ipcMain.handle("ac-rec-diag", (e, arg) => {
    try {
      if (!isTrustedSender(e)) return {};
      const out = {};
      for (const wc of (arg && Array.isArray(arg.wcs) ? arg.wcs : [])) out[wc] = diagSince(wc, arg.since, webContents);
      return out;
    } catch { return {}; }
  });
  // 고른 요소를 그 시점에 잘라 캡처한다. 나중에 따로 캡처하면 스크롤·hover 상태가 달라져 선택 당시의
  // 화면이 아니다. 실패해도 선택 자체는 유지해야 하므로 빈 값을 돌려준다.
  ipcMain.handle("ac-pick-shot", async (e, arg) => {
    try {
      if (!isTrustedSender(e)) return null;
      const wcId = Number(arg && arg.wc); const sel = String((arg && arg.sel) || "");
      if (!wcId || !sel) return null;
      const r = await runCdp(webContents, wcId, "screenshot", { element: sel });
      return r && r.ok && r.path ? r.path : null;
    } catch { return null; }
  });
  ipcMain.on("ac-pick-mode", (e, on) => {
    const wc = e.sender;
    if (on) { cursorSubs.add(wc); if (!cursorTimer) cursorTimer = setInterval(pumpCursor, 33); } // ~30Hz
    else cursorSubs.delete(wc);
    setBrowserWinsFocusable(!on);
  });
  app.on("before-quit", () => setBrowserWinsFocusable(true));

  return { isActive: () => cursorSubs.size > 0, registerGlobalShortcut };
}

module.exports = { createPickMode };
