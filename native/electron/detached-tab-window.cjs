// 탭 띠에서 빼낸 탭을 담는 창. 크롬처럼 탭을 끌어내거나 "창으로 빼기"로 만들고, 그 창 안에서
// 새 탭을 더 만들 수 있다. 창은 스페이스(공유 브라우저 포함)에만 속한다.
//
// 소유 범위
//   창 id → { BrowserWindow, 스페이스, 탭 id 목록 } 과 그 창의 수명주기, 떨어져 나간 탭 목록의 방송.
//   탭 하나는 많아야 한 창에만 속한다.
//
// 제공 API
//   createDetachedTabWindows(deps) 하나만 내준다. 만들어진 API 는 열기·닫기·목록이며
//   BrowserWindow 나 원시 Map 을 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. BrowserWindow·창 정책 조각·APP URL·신뢰 발신자 판정을
//   main.cjs 에서 받는다. 브라우저 상태(탭 목록)는 서버와 렌더러가 소유하므로 알지 못한다.
//
// 유지 조건
//   이 창의 <webview> 는 분리 브라우저 창과 같은 정책을 받아야 한다. 프리로드·파티션 가드·
//   서브프레임·대화상자 차단·스로틀 중 하나라도 빠지면 그 창에서만 요소 선택이 동작하지 않거나,
//   더 나쁘게는 파티션 가드가 없는 webview 가 생긴다. 검사가 두 자리를 대조한다.
//   떨어진 탭은 옮긴 것이 아니라 감춘 것이다. 브라우저 상태의 탭 기록은 그대로 두고, 어느
//   탭이 지금 어느 창에 있는지만 이 모듈이 안다. 그래서 창을 닫으면 그 창의 탭이 사라지지 않고
//   원래 띠로 돌아온다. 창을 닫아 탭을 잃는 경로는 만들지 않는다. 창의 탭이 모두 빠지면 창을 닫는다.
//   기록을 남기지 않는다. 앱을 다시 켜면 떨어진 탭은 없고 전부 자기 스페이스에 있다.
//   끌기로 만든 창은 포커스를 가져가지 않는다(activate: false → showInactive). 가져가면 끌던
//   창이 포커스를 잃고 그 순간 마우스 이벤트가 끊긴다. 끌기가 끝나지 못한 채 멈추고, 나중에
//   그 창을 누르는 순간 멈춰 있던 끌기가 다시 시작된다(분리했던 탭이 돌아오며 드래그가
//   이어졌다).
//
// 영향 범위
//   공급자는 main.cjs 의 Electron 창·webview 정책 조각·window-layout 이다. 양방향 소비자는
//   preload 의 detachTab·reattachTab·claimDetachedTab·onDetachedTabs 와 web/js/browser 의 탭 띠다.
//   여기가 일치하지 않으면 띠에서 감춰진 탭이 어느 창에도 없는 상태(탭 실종)가 된다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/detached-tab-window.cjs

const CHANNEL = "ac-detached-tabs";

// 끌기는 이 기능이 소유하며, 기능 표가 세운 경계 뒤에서 가져온다. 밖에서 require 하면 탭 분리를
// 꺼도 끌기 연결이 살아 있게 된다.
const { createTabDrag } = require("./tab-drag.cjs");

function createDetachedTabWindows({
  BrowserWindow, ipcMain, preloadPath, webviewPreloadPath, windowLayout,
  guardWebviewPartition, pinHiddenViewportById, webContents, shell,
  loadUrlWithRetry, getAppUrl, noThrottleOpt, isTrustedSender, isAppQuitting,
  markAppAlive, log, screen,
}) {
  const wins = new Map(); // 창 id -> { win, space, tabs: Set<tabId> }
  let seq = 0;

  function winOfTab(tabId) {
    for (const [wid, rec] of wins) if (rec.tabs.has(tabId)) return wid;
    return null;
  }

  function snapshot() {
    const out = [];
    for (const [wid, rec] of wins) for (const tabId of rec.tabs) out.push({ tabId, space: rec.space, win: wid });
    return out;
  }

  // 어느 탭이 떨어져 있는지는 모든 창이 함께 알아야 한다. 띠를 그리는 쪽이 그 값으로 감춘다.
  function broadcast() {
    const payload = { tabs: snapshot() };
    for (const target of BrowserWindow.getAllWindows()) {
      try { if (!target.isDestroyed()) target.webContents.send(CHANNEL, payload); } catch {}
    }
    return payload;
  }

  // 탭을 지금 속한 창에서 뺀다. 그 창이 비면 닫는다(닫힘 처리에서 방송).
  function removeFromWindow(tabId) {
    const wid = winOfTab(tabId);
    if (!wid) return false;
    const rec = wins.get(wid);
    rec.tabs.delete(tabId);
    if (!rec.tabs.size) { try { rec.win.close(); } catch {} }
    return true;
  }

  // 분리 브라우저 창과 같은 정책이다. 달라지면 이 창의 webview 만 다른 규칙으로 동작한다.
  function applyWebviewPolicy(win) {
    win.webContents.on("will-attach-webview", (_ev, webPreferences) => {
      webPreferences.preload = webviewPreloadPath;
      guardWebviewPartition(webPreferences);
      webPreferences.nodeIntegrationInSubFrames = true;
      webPreferences.disableDialogs = true;
      webPreferences.backgroundThrottling = !noThrottleOpt;
      webPreferences.transparent = false;
    });
    win.webContents.on("did-attach-webview", (_ev, guest) => {
      // 방금 붙은 게스트에는 브라우저 탭이 아닌 것도 온다(rail 화면이 담는 webview). 그것은
      // 자기 영역에 그대로 보이므로 크기를 물려받을 이유가 없고, 폭이 0 인 것만 보정한다.
      try { if (guest && !guest.isDestroyed()) setImmediate(() => pinHiddenViewportById(guest.id, webContents, { onlyIfCollapsed: true })); } catch {}
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(getAppUrl())) return { action: "allow" };
      shell.openExternal(url); return { action: "deny" };
    });
  }

  function openDetachedTab({ space, tabId, title, activate = true }) {
    const id = String(tabId || "").trim();
    const sp = String(space || "").trim();
    if (!id || !sp) return null;

    // 이미 혼자 떨어져 있는 탭이면 그 창을 앞으로. 다른 탭과 함께 있는 창이면 거기서 빼서 새 창으로.
    const curWid = winOfTab(id);
    if (curWid) {
      const cur = wins.get(curWid);
      if (cur.tabs.size === 1 && !cur.win.isDestroyed()) {
        try { if (activate) { cur.win.show(); cur.win.focus(); } else cur.win.showInactive(); } catch {}
        return cur.win;
      }
      cur.tabs.delete(id);
    }

    markAppAlive();
    const name = String(title || "").trim().slice(0, 120);
    const opts = {
      width: 1000, height: 760, minWidth: 420, minHeight: 320,
      // 띄우는 일은 아래에서 직접 한다. 끌기 중에는 포커스를 가져가면 안 된다.
      show: false,
      backgroundColor: "#0A1620", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", acceptFirstMouse: true,
      title: name ? `Iris — ${name}` : "Iris — 분리한 탭",
      webPreferences: {
        webviewTag: true, spellcheck: false, preload: preloadPath,
        nodeIntegration: false, contextIsolation: true,
      },
    };
    const win = new BrowserWindow(opts);
    try { if (activate) win.show(); else win.showInactive(); } catch {}
    windowLayout.ownWindowTitle(win, opts.title);
    applyWebviewPolicy(win);
    win.webContents.on("console-message", (a, b, c) => {
      const message = (typeof c === "string") ? c : (a && typeof a.message === "string" ? a.message : "");
      if (/^\[browser\]|error|Error/i.test(message)) log("[detached]", message);
    });

    const wid = `w${++seq}`;
    wins.set(wid, { win, space: sp, tabs: new Set([id]) });

    const query = new URLSearchParams({ mode: "browser", space: sp, win: wid, tab: id });
    loadUrlWithRetry(win, getAppUrl() + "/?" + query.toString());

    // 창을 닫는 것은 탭을 버리는 것이 아니라 되돌리는 것이다. 앱이 통째로 나가는 중이면
    // 되돌릴 화면도 없으므로 방송하지 않는다.
    win.on("closed", () => {
      wins.delete(wid);
      if (!isAppQuitting()) broadcast();
    });
    broadcast();
    return win;
  }

  // 탭을 원래 띠로 돌려보낸다. 그 탭만 있던 창이면 창이 닫힌다.
  function reattachTab(tabId) {
    const id = String(tabId || "").trim();
    if (!removeFromWindow(id)) return false;
    broadcast();
    return true;
  }

  // 탭을 분리 창에 넣는다. 그 창에서 새로 만든 탭과, 다른 분리 창에서 끌어온 탭이 여기로 온다.
  // 같은 스페이스의 탭만 받는다. 탭 기록은 스페이스에 있으므로 창이 다른 스페이스 탭을 담으면 띠가 비게 된다.
  function claimTab(winId, tabId, space) {
    const rec = wins.get(String(winId || ""));
    const id = String(tabId || "").trim();
    if (!rec || rec.win.isDestroyed() || !id) return false;
    if (space != null && String(space) !== rec.space) return false;
    if (rec.tabs.has(id)) return true;
    removeFromWindow(id);
    rec.tabs.add(id);
    broadcast();
    return true;
  }

  // 끌기가 쓰는 판정. 그 탭 하나만 담은 창이면 그 창(창째로 끈다), 아니면 null(탭만 끈다).
  function soloWindowFor(tabId) {
    const wid = winOfTab(String(tabId || ""));
    const rec = wid && wins.get(wid);
    return rec && rec.tabs.size === 1 && !rec.win.isDestroyed() ? rec.win : null;
  }

  function registerDetachedTabIpc() {
    ipcMain.handle("ac-detach-tab", (e, arg) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        const win = openDetachedTab({
          space: arg && arg.space, tabId: arg && arg.tabId, title: arg && arg.title,
        });
        return win ? { ok: true } : { ok: false, error: "분리할 탭을 알 수 없습니다" };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    ipcMain.handle("ac-reattach-tab", (e, arg) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        return { ok: reattachTab(arg && arg.tabId) };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    ipcMain.handle("ac-claim-detached-tab", (e, arg) => {
      try {
        if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
        return { ok: claimTab(arg && arg.win, arg && arg.tabId, arg && arg.space) };
      } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
    // 새로 뜬 창은 직접 요청해 현재 상태를 받는다. 방송만 있으면 늦게 뜬 창이 받지 못한다.
    ipcMain.handle("ac-detached-tabs", (e) => {
      if (!isTrustedSender(e)) return { tabs: [] };
      return { tabs: snapshot() };
    });
  }

  // 끌기가 창을 만들고 닫는 일은 이 모듈이 이미 알고 있으므로 그것만 넘긴다.
  const tabDrag = createTabDrag({
    BrowserWindow, ipcMain, screen, isTrustedSender,
    openDetachedTab: (a) => openDetachedTab(a),
    closeDetachedTab: (tabId) => reattachTab(tabId),
    moveDetachedTab: (tabId, winId, space) => claimTab(winId, tabId, space),
    detachedWindowFor: (tabId) => soloWindowFor(tabId),
    log,
  });

  return { openDetachedTab, reattachTab, claimTab, detachedTabs: snapshot, registerDetachedTabIpc, tabDrag };
}

// 이 기능이 자기 연결을 직접 등록한다. 앱 셸(main.cjs)이 이 팩토리를 부르고 IPC 를 걸어 주던 두 줄을
// 여기로 옮겼다. 앱 셸이 기능을 알면 그 기능을 뺄 때 앱 셸도 함께 고쳐야 하기 때문이다.
// 넘어오는 ctx 는 앱 셸이 가진 공용 조각들이며, 기능 이름이 붙은 것은 하나도 없다.
function initCapability(ctx) {
  const windows = createDetachedTabWindows(ctx);
  windows.registerDetachedTabIpc();
  windows.tabDrag.registerTabDragIpc();
  return windows;
}

module.exports = { createDetachedTabWindows, initCapability };
