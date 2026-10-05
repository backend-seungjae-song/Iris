// Iris Electron 셸. Chromium 렌더러로 로컬 서버(localhost:4271) UI를 감싼다.
// WKWebView(WebKit)에서 Chromium으로 바꾼 이유:
//  1) 한글 IME: xterm.js 조합 입력이 WebKit에서는 누락되고 Chromium에서는 정상이다(Chrome에서 확인).
//  2) 실제 브라우저: <webview>(Chromium)로 실제 Chrome 페이지 임베드와 Orca식 요소 선택.
// 백엔드(herdr 소켓·PTY·fs·원격)는 별도 Node 서버가 담당. 이 앱은 그 UI의 Chromium 창.
const { app } = require("electron");
const path = require("path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { stateHome } = require("../../server/state-home.cjs");
const { readFeatureState, featureOn } = require("../../server/feature-state-read.cjs");
const { artifactDir } = require("../../server/artifacts-home.cjs");
const { pinUserDataHome } = require("./user-data-home.cjs");

// 상태 폴더. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 개발 회차의 QA 장부·매크로·탭
// 기록이 설치된 앱의 것과 섞여, 어느 환경의 기록인지 구분할 수 없다.
// 어디인지는 state-home.cjs 한 곳이 정한다.
const IRIS_HOME = stateHome();
// 쿠키·로그인 세션이 사는 폴더도 상태 폴더에 매단다. cookie-import는 require 시점에 이전 실행의
// 스테이징 DB를 재생하므로, 그 모듈과 이를 전이 로드하는 password-import보다 먼저 고정해야 한다.
// 설치본이면 아무것도 하지 않는다.
const pinnedUserData = pinUserDataHome(app, IRIS_HOME);
// 이미 실행 중인 앱의 쿠키 DB를 두 번째 프로세스의 시작 복원이 건드리면 안 된다.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

if (pinnedUserData) console.log(`[iris] 개발 갈래 쿠키 폴더: ${pinnedUserData}`);

const { BrowserWindow, Menu, Notification, shell, ipcMain, clipboard, session, dialog, webContents, screen, safeStorage, globalShortcut, systemPreferences, desktopCapturer, nativeImage } = require("electron");
const { execFile } = require("node:child_process");
const nativeAx = require("./cdp-native-ax.cjs");
const { applyHardening, isAudioInputPermission, setNativeUserAgent, WEBAUTHN_SCRIPT, BOTCHECK_SCRIPT, OPENER_SCRIPT, dialogScript } = require("./browser-hardening.cjs");
const chromeAuth = require("./chrome-auth.cjs");
const { runChromeAuth } = chromeAuth;
const cookieImport = require("./cookie-import.cjs");
const passwordImport = require("./password-import.cjs");
const { boundsVisible: windowBoundsVisible } = require("./window-bounds.cjs");
const { ServerHost } = require("./server-host.cjs");
const { createAudioDiagnostics } = require("./audio-diagnostics.cjs");
const { createCertificateTrust } = require("./certificate-trust.cjs");
const { createChromeImportRegistry } = require("./chrome-import-registry.cjs");
const { createCredentialService } = require("./credential-service.cjs");
const captureHoldState = require("./capture-hold.cjs");
const { isTrustedSender: matchesTrustedSender, isTrustedMainFrame } = require("./ipc-trust.cjs");
const uiStateStore = require("./ui-state-store.cjs");
const visibilityRegistry = require("./visibility-registry.cjs");
const { createWebviewThrottle } = require("./webview-throttle.cjs");
const { createProfileSessionPolicy, isProfilePartition: matchesProfilePartition } = require("./profile-session-policy.cjs");
const { createWebviewLifecycle } = require("./webview-lifecycle.cjs");
const { createWebviewContextMenu } = require("./webview-context-menu.cjs");
const { createWebviewContextActions } = require("./webview-context-actions.cjs");
const { createMenu } = require("./menu.cjs");
const { createDownloadHook } = require("./download-hook.cjs");
const { consoleOpenTarget } = require("./local-link.cjs");
const { createFsIpc } = require("./fs-ipc.cjs");
const { createCredentialIpc } = require("./credential-ipc.cjs");
const { createMainWindow, setRelayKeymap, DEFAULT_RELAY } = require("./main-window.cjs");
const { createBrowserWindowManager } = require("./browser-window-manager.cjs");
const { createMemoWindowManager } = require("./memo-window-manager.cjs");
const { NATIVE_CAPABILITIES } = require("./capabilities.cjs");
const { bootNativeCapabilities } = require("./capability-host.cjs");
const { createPickMode } = require("./pick-mode.cjs");
const switcherCore = require("./switcher-core.cjs");
const { createWindowCatalog } = require("./window-catalog.cjs");
const { createWindowIcons } = require("./window-icons.cjs");
const { createWindowMedia } = require("./window-media.cjs");
const { acceleratorFor, createSwitcherHost, irisKeyAction } = require("./switcher-host.cjs");
const { createChromeHandoffIpc } = require("./chrome-handoff-ipc.cjs");
const { createAiLoginPolicy } = require("./ai-login-policy.cjs");
const { localLoginFor } = require("../../server/local-login.cjs");
const { port: acPort } = require("../../server/env.cjs");
const { createTouchDragArm } = require("./touch-drag-arm.cjs");
const { setupCdpControl, ctlSend, setLoginProvider, setViewportNotify, setCaptureHold, setShownKnownProbe, applyViewportTo, setTouchDrag, forgetSecrets, clearAutoViewport, setShownProbe, setDefaultViewport, noteChildSession, dropChildSession, noteFrameOrigin, injectOverlayAllFrames, hoverAtPoint, diagSince,
  registerSessionPrimer, noteNavigation, forgetAttachPolicy, reconsiderAttach, pinHiddenViewportById, runCdp, aiDriving, aiDrivingAnywhere,
  holdAiCausality, setPaintableProbe, setContextActionProvider } = require("./cdp-control.cjs"); // AI→브라우저 CDP 제어 실행기
const downloadState = require("./download-state.cjs");


// Iris 제품명은 일부 모바일 감지기가 휴대폰으로 오인한다. Electron 런타임 표시는 유지한다.
try {
  app.userAgentFallback = require("./browser-hardening.cjs").cleanUserAgent(app.userAgentFallback);
  setNativeUserAgent(app.userAgentFallback);
} catch {}

const IRIS_PARTITION = "persist:acbrowser"; // 브라우저 탭·분리창 공유 영속 세션
// 이름이 Iris로 바뀐 뒤에도 "acbrowser"를 쓰는 이유는, 이 문자열이 Electron이 로그인 세션을
// 저장한 폴더 이름이기 때문이다. 바꾸면 사용자가 로그인해 둔 계정이 전부 빈 세션으로 시작한다.
// 보지 않는 탭은 대기 상태로 전환한다. 기본값은 켜짐이다. 한 번 연 탭의 webview를 계속 유지하면
// 앱을 켜 둔 동안 계속 쌓인다(확인 결과: 렌더러 16개 · 1.6 GB). 대기 전환은 삭제가 아니라 기록만
// 남기는 것이고, AI가 사용 중인 탭·소리 나는 탭·최근에 쓴 탭은 전환하지 않는다. 되돌리려면 IRIS_WEBVIEW_LRU=0.
const WEBVIEW_LRU_ENABLED = process.env.IRIS_WEBVIEW_LRU !== "0";
const WEBVIEW_IDLE_MIN = (() => {
  const n = Number(process.env.IRIS_WEBVIEW_IDLE_MIN);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const WEBVIEW_RECENT_COUNT = (() => {
  const n = Number(process.env.IRIS_WEBVIEW_RECENT);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 20) : 2;
})();
// 회귀 시 기존 정책(모든 webview/팝업 + Chromium 전역 스위치로 스로틀 해제)을 한 번에 복원한다.
const NO_THROTTLE_OPT = process.env.IRIS_NO_THROTTLE_OPT === "1";
const webviewThrottle = createWebviewThrottle({
  noThrottleOpt: NO_THROTTLE_OPT,
  fromId: (id) => webContents.fromId(id),
});
// 내려받을 파일의 이름과 저장 위치는 download-hook.cjs 가 소유한다.
const { installDownloadHook, noteExplicitSave } = createDownloadHook({
  fs, path, downloadState,
  allWindows: () => BrowserWindow.getAllWindows(),
  aiDriving,
  // 내려받기가 실패한 사유를 남긴다. 기록 없이 취소되면 호출자가 사이트가 막은 것으로 잘못 판단한다.
  noteBlockedDownload: (wc, item) => {
    try {
      downloadState.blocked({
        name: item.getFilename(), url: String(item.getURL() || "").slice(0, 300), wc: wc.id,
        why: "받을 자리를 정하지 않아 취소했습니다. browser_download 로 자리를 먼저 정하고 다시 누르세요.",
      });
    } catch {}
  },
});

// 위치·화면 공유·마이크·파일 쓰기. 기능을 켠 뒤 사이트마다 사람이 허용해야 한다. 저장은 ui-state.json 의 sitePermissions.
const sitePermissions = require("./site-permissions.cjs").createSitePermissions({
  read: () => readUiState().sitePermissions,
  write: (patch) => writeUiState(patch),
  // 창이 떠 있는 동안 에이전트의 OS 창 조작은 막는다. 기본 버튼은 [차단], 창을 닫으면 기억하지 않는다.
  confirm: async ({ site, name, asks }) => {
    nativeAx.holdNativeInput("사이트 권한");
    try {
      const result = await dialog.showMessageBox({
        type: "question", title: `${name} 권한`, message: `${site} 에서 ${asks}`,
        detail: "허용하거나 차단하면 이 사이트에 기억합니다. 설정의 보안에서 지울 수 있습니다.",
        buttons: ["허용", "차단", "지금은 안 함"], defaultId: 1, cancelId: 2, noLink: true,
      });
      return result.response === 0 ? true : result.response === 1 ? false : null;
    } finally { nativeAx.holdNativeInput(null); }
  },
});
const profileSessionPolicy = createProfileSessionPolicy({
  sitePermissions,
  frameWebContents: (frame) => { try { return webContents.fromFrame(frame); } catch { return null; } },
  // 공유할 화면을 매번 사람이 고른다(화면이 하나여도). 창 단위 공유는 지원하지 않는다.
  pickDisplaySource: async ({ site }) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    if (!sources.length) return null;
    nativeAx.holdNativeInput("화면 공유");
    try {
      const result = await dialog.showMessageBox({
        type: "question", title: "화면 공유", message: `${site} 에 공유할 화면을 고르세요`,
        buttons: [...sources.map((src) => src.name), "취소"], defaultId: sources.length, cancelId: sources.length, noLink: true,
      });
      return sources[result.response] || null;
    } finally { nativeAx.holdNativeInput(null); }
  },
  basePartition: IRIS_PARTITION,
  fromPartition: (partition) => session.fromPartition(partition),
  hardenBrowserSession: applyHardening,
  userAgentForPartition: (partition) => cookieImport.userAgentForPartition(partition),
  // 처리할 앱이 없으면 묻지 않는다. 기본 버튼은 [취소]다(크롬과 같음). 사이트가 사람이 Enter 를 치는 순간에
  // 창을 띄워 [열기]를 누르게 만들 수 있기 때문이다. 창이 떠 있는 동안 에이전트의 OS 창 조작은 막는다.
  confirmExternalOpen: async ({ url, site, unsure }) => {
    let appName = "";
    try { appName = app.getApplicationNameForProtocol(url) || ""; } catch {}
    if (!appName) return false;
    nativeAx.holdNativeInput("앱 열기");
    try {
      const result = await dialog.showMessageBox({
        type: "question",
        title: "앱 열기",
        message: `${appName} 앱을 열까요?`,
        detail: unsure ? `${site} 페이지 또는 그 안에 들어 있는 다른 사이트에서 요청했습니다.` : `${site} 에서 요청했습니다.`,
        buttons: ["열기", "취소"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return result.response === 0;
    } finally { nativeAx.holdNativeInput(null); }
  },
  chooseWebauthnAccount: async (details) => {
    const accounts = details.accounts;
    const result = await dialog.showMessageBox({
      type: "question",
      title: "패스키 계정 선택",
      message: `${details.relyingPartyId}에 로그인할 계정을 선택하세요`,
      buttons: [...accounts.map((account) => String(account.displayName || account.name || "계정")), "취소"],
      cancelId: accounts.length,
      noLink: true,
    });
    return accounts[result.response]?.credentialId;
  },
  audioInputPermission: isAudioInputPermission,
  aiDriving,
  systemPreferences,
  platform: process.platform,
  installSessionHook: installDownloadHook,
});
const { attachGoogleAuthUserAgent } = require("./google-auth-user-agent.cjs");
app.on("web-contents-created", (_event, contents) => {
  // 팝업도 생성 직후부터 같은 정책을 받아야 첫 OAuth 탐색이 옛 UA로 시작하지 않는다.
  if (contents.getType() === "webview" || profileSessionPolicy.ownsSession(contents.session)) {
    // 인증 호스트를 떠나 정체성 전용 attach 를 내려놓으면 부착 정책이 그 탭을 다시 판정한다.
    attachGoogleAuthUserAgent(contents, { onRelease: (wc) => reconsiderAttach(wc.id) });
  }
});
const audioDiagnostics = createAudioDiagnostics({ app, env: process.env });
const AUDIO_DIAG_ENABLED = audioDiagnostics.isEnabled();
function audioDiagLog(event, details = {}) { audioDiagnostics.log(event, details); }
function startAudioDiagnostics() { audioDiagnostics.start(); }

// 터미널 붙여넣기용 클립보드 읽기(동기). sandbox preload는 clipboard 모듈이 없어 메인이 대신 읽는다.
// 읽기·쓰기 모두 이 앱의 렌더러만 받는다. webview 게스트가 사용자 클립보드를 읽거나 덮어쓰지 못하게 한다.
ipcMain.on("ac-clipboard-read", (e) => { if (!isTrustedSender(e)) { e.returnValue = ""; return; } try { e.returnValue = clipboard.readText(); } catch { e.returnValue = ""; } });
// 터미널 복사 쓰기. 렌더러의 navigator.clipboard.writeText가 Electron webview 컨텍스트에서
// 실패해 빈 값이 복사되는 문제가 있다. 붙여넣기와 동일하게 메인 프로세스 clipboard로 쓴다.
ipcMain.handle("ac-clipboard-write", (e, text) => { if (!isTrustedSender(e)) return false; try { clipboard.writeText(String(text ?? "")); return true; } catch { return false; } });
if (process.platform === "win32") ipcMain.handle("ac-terminal-shell", async (event, paneId) => {
  if (!isTrustedSender(event) || typeof paneId !== "string" || !/^[\w:-]{1,128}$/.test(paneId)) return null;
  try {
    const { HerdrClient } = await import("../../server/herdr.js");
    const info = await new HerdrClient().call("pane.process_info", { pane_id: paneId });
    const pid = (info?.process_info || info)?.shell_pid;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const r = await require("../../server/win-native.cjs").request({ op: "processes", pids: [pid] });
    const name = String(r.ok && r.processes.find((p) => p.pid === pid)?.name || "").replace(/\.exe$/i, "").toLowerCase();
    return /^(powershell|pwsh)$/.test(name) ? "powershell" : name === "cmd" ? "cmd" : /^(bash|zsh|sh)$/.test(name) ? "posix" : null;
  } catch { return null; }
});

let switcherHost = null;
// 창이 보내온 단축키 표. webview 포커스에서의 중계 판정이 이 표를 본다. 창의 판정과 같은 표를
// 봐야 화면에서 바꾼 키가 페이지 위에서도 동작한다. 도착하기 전까지는 main-window 의 기본표를 쓴다.
ipcMain.on("ac-keymap", (e, map) => {
  if (!isTrustedSender(e)) return;
  if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > 200) return;
  setRelayKeymap(map);
  switcherHost?.keymapChanged();
  pickMode.registerGlobalShortcut(acceleratorFor(map["pick-toggle"] || DEFAULT_RELAY["pick-toggle"]));
});
// 신뢰 발신자는 이 앱의 렌더러(APP_URL origin)다. webview 게스트(임의 사이트)나 원격 프레임은 거부한다.
// 렌더러 오염 시에도 파일조작 IPC가 워크스페이스 밖으로 확대되지 않도록 경계에서 강제.
function isTrustedSender(e) {
  return matchesTrustedSender(e, APP_URL);
}

const webviewContextActions = createWebviewContextActions();
setContextActionProvider((host) => webviewContextActions.get(host));
ipcMain.on("ac-context-action-register", (e, action) => {
  if (!isTrustedSender(e)) return;
  webviewContextActions.register(e.sender, action);
});

function setThrottleReason(contents, reason, on) {
  return webviewThrottle.setReason(contents, reason, on);
}
function clearThrottleState(contents) {
  return webviewThrottle.clearContents(contents);
}
function reconcilePopupThrottling() {
  return webviewThrottle.reconcilePopups();
}
function registerPopup(tabId, contents) {
  return webviewThrottle.registerPopup(tabId, contents);
}
function unregisterPopup(tabId) {
  return webviewThrottle.unregisterPopup(tabId);
}
ipcMain.on("ac-webview-policy", (e) => {
  e.returnValue = isTrustedSender(e)
    ? { lru: WEBVIEW_LRU_ENABLED, idleMin: WEBVIEW_IDLE_MIN, recent: WEBVIEW_RECENT_COUNT, noThrottleOpt: NO_THROTTLE_OPT }
    : { lru: false, idleMin: 15, recent: 3, noThrottleOpt: true };
});
ipcMain.on("ac-webview-throttle-state", (e, payload) => {
  if (!isTrustedSender(e)) return;
  webviewThrottle.reportRenderer(e.sender, payload);
});
if (AUDIO_DIAG_ENABLED) {
  ipcMain.on("ac-audio-media-event", (e, details) => {
    try {
      if (!isTrustedSender(e)) return;
      const event = String((details && details.event) || "");
      if (event !== "started" && event !== "paused") return;
      const wcId = Number(details && details.wcId);
      const guest = webContents.fromId(wcId);
      if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== e.sender) return;
      const tabId = String((details && details.tabId) || "").slice(0, 160);
      let origin = "";
      try {
        const url = new URL(guest.getURL());
        origin = url.origin === "null" ? url.protocol : url.origin;
      } catch {}
      audioDiagLog("media-" + event, { tabId, wcId, origin });
    } catch {}
  });
}
// 파일 트리가 파일 시스템을 다루는 세 동작은 fs-ipc.cjs 가 소유한다.
createFsIpc({ ipcMain, shell, fs, path, os, isTrustedSender });
// 새 스페이스의 작업 폴더 선택 — macOS 폴더 창. 신뢰 렌더러만(webview 게스트가 파일 시스템 탐색 창을
// 띄우지 못하게). 고른 경로만 반환하고 이 IPC 자체는 아무것도 읽거나 쓰지 않는다.
ipcMain.handle("ac-pick-folder", async (e, arg) => {
  try {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const owner = BrowserWindow.fromWebContents(e.sender);
    const defaultPath = typeof arg?.defaultPath === "string" && path.isAbsolute(arg.defaultPath) ? arg.defaultPath : undefined;
    const opts = { properties: ["openDirectory", "createDirectory"], title: "스페이스로 열 폴더", buttonLabel: "열기", ...(defaultPath ? { defaultPath } : {}) };
    const r = owner && !owner.isDestroyed() ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
});
// 탭 화면 크기 지정(반응형 확인). DevTools의 기기 툴바는 <webview> 대상에서는 버튼 자체가 뜨지
// 않아서 같은 동작을 앱이 CDP로 수행한다. 실제 적용은 cdp-control의 applyViewportTo가
// 한 곳에서 맡는다. 주소줄에서 호출하든 AI가 iris-browser로 호출하든 같은 결과여야 하기 때문이다.
ipcMain.handle("ac-viewport", async (e, arg) => {
  try {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const target = webContents.fromId(Number(arg?.wcId));
    if (!target || target.isDestroyed() || target.getType() !== "webview") return { ok: false, error: "그 탭을 찾을 수 없습니다." };
    if (arg && arg.touchDrag !== undefined) return await touchDragArm.arm(target, !!arg.touchDrag && arg.rect);
    return await applyViewportTo(target, arg || {});
  } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
});
const touchDragArm = createTouchDragArm({ screen, BrowserWindow, setTouchDrag });
// AI가 iris-browser viewport로 크기를 바꿨을 때 그 탭을 품은 창의 주소줄 버튼도 같이 바꾼다.
setViewportNotify((wcId, vp) => {
  try {
    const guest = webContents.fromId(Number(wcId));
    const host = guest && !guest.isDestroyed() && guest.hostWebContents;
    if (host && !host.isDestroyed()) host.send("ac-viewport-changed", { wc: Number(wcId), vp: vp || null });
  } catch {}
});
// 캡처 유지. 지금 보고 있지 않은 탭도 캡처되게 한다.
// 그려지지 않는 화면은 어떤 방법으로도 가져올 수 없다(확인 결과: 기본·fromSurface:false·screencast·
// capturePage 네 경로 모두 실패). 그리려면 그 webview가 합성 대상이어야 한다. 그래서 캡처하는 순간에만
// 화면 위에 올리되 보이는 부분은 1px로 잘라 둔다(web/js/main.js). 탭은 바뀌지 않고, 끝나면 되돌린다.
// 이 유지를 요청하는 곳이 여럿이다. 키 입력 도달, 조작 뒤 그리기, 즉시 알림 촬영이 그렇다. 렌더러의
// 유지 상태는 플래그 하나라, 먼저 끝난 쪽이 해제하면 아직 사용 중인 쪽의 화면도 함께 꺼진다.
// 그래서 요청 수를 세어 마지막 요청이 해제하게 한다.
setCaptureHold(async (wcId, on) => {
  const id = Number(wcId);
  const guest = webContents.fromId(id);
  if (guest && !guest.isDestroyed() && on) setThrottleReason(guest, "capture", true);
  const host = guest && !guest.isDestroyed() && guest.hostWebContents;
  if (!host || host.isDestroyed()) {
    if (guest && !guest.isDestroyed() && !on) { captureHoldState.clear(id); setThrottleReason(guest, "capture", false); }
    return false;
  }
  // 처음 잡을 때와 마지막으로 놓을 때만 렌더러를 건드린다. 그 사이는 이미 올라와 있다.
  const { edge } = captureHoldState.update(id, on);
  if (!edge) return true;
  // 창은 변경하지 않는다. 가려진 창이 합성을 멈추는 문제는 창을 앞으로 올려서가 아니라
  // disable-backgrounding-occluded-windows 로 해결한다(이 파일 아래쪽 스위치). 창을 올려서 해결하면
  // 사용자가 보던 화면을 덮고 되돌릴 API 가 없어 원래 상태로 복구할 수 없다.
  // 최소화·앱 숨김처럼 스위치로 해결되지 않는 경우는 실패로 알리고, 창을 임의로 앞에 내지 않는다.
  host.send("ac-capture-hold", { wc: id, on: !!on });
  await new Promise((r) => setTimeout(r, on ? 260 : 60));   // 레이아웃과 첫 프레임이 나올 시간
  if (!on) setThrottleReason(guest, "capture", false);
  return true;
});
// 탭이 화면에 나왔다는 통지. 보이지 않을 때 대신 넣어 준 화면 크기를 그대로 두면 사용자가 그 탭으로
// 이동했을 때 창 크기와 어긋나게 그려지므로, 나오는 즉시 해제한다(사용자가 직접 정한 크기는 유지한다).
// 서버가 지목 메시지를 수락하는 증명. 파일은 서버가 만들고 권한은 0600이며, 앱만 렌더러에 전달한다.
// (루프백이라는 사실만으로는 앱과 임의의 로컬 프로세스를 구분할 수 없어, 증명이 없으면 어떤 프로세스든
// 자기 자신에게 임의의 탭을 지목하고 곧바로 조작할 수 있다.)
ipcMain.on("ac-ui-token", (e) => {
  try { e.returnValue = fs.readFileSync(path.join(IRIS_HOME, "ui-token"), "utf8").trim(); }
  catch { e.returnValue = ""; }
});
// 창(호스트)마다 현재 그려지는 탭은 하나이므로, 호스트별로 마지막 보고만 보관하면 판정할 수 있다.
ipcMain.on("ac-tab-shown", (_e, m) => {
  try {
    const wc = Number(m && m.wc);
    const before = visibilityRegistry.shownForHost(_e.sender.id);
    if (before && before !== wc) {
      const old = webContents.fromId(before);
      if (old && !old.isDestroyed()) setThrottleReason(old, "shown:" + _e.sender.id, false);
    }
    if (!wc) {   // 이 창은 지금 브라우저 탭을 안 보여준다
      visibilityRegistry.dropHost(_e.sender.id);
      if (before) pinHiddenViewportById(before, webContents);
      return;
    }
    if (!visibilityRegistry.hasHost(_e.sender.id)) {
      // 그 창이 사라지면 보이는 탭 정보도 함께 지운다. 남겨 두면 보이지 않는 탭을 보이는 것으로 판단해
      // 캡처 유지를 건너뛰고 키 입력이 전달되지 않는다.
      try { _e.sender.once("destroyed", () => {
        const last = visibilityRegistry.shownForHost(_e.sender.id);
        const guest = last && webContents.fromId(last);
        if (guest && !guest.isDestroyed()) setThrottleReason(guest, "shown:" + _e.sender.id, false);
        visibilityRegistry.dropHost(_e.sender.id);
      }); } catch {}
    }
    visibilityRegistry.report(_e.sender.id, wc);
    const shown = webContents.fromId(wc);
    if (shown && !shown.isDestroyed() && shown.hostWebContents === _e.sender) setThrottleReason(shown, "shown:" + _e.sender.id, true);
    clearAutoViewport(wc, webContents);
    if (m.w > 200 && m.h > 200) setDefaultViewport(m.w, m.h);   // 안 보이는 탭에 물려줄 기준 크기
    // 방금 화면에서 내려간 탭에 그 크기를 물려준다("보이는 탭" 갱신 뒤라야 이 판정이 맞다).
    // 안 물려주면 그 탭의 페이지는 폭 0이 되고, 배경에서 일어나는 이동(결제 리다이렉트가
    // 대표적)이 폰으로 판정된다.
    if (before && before !== wc) pinHiddenViewportById(before, webContents);
  } catch {}
});
// 그 탭을 담은 창이 현재 프레임을 낼 수 있는지 판정한다. 가림은 스위치로 해결되지만 최소화·숨김은
// 해결되지 않는다(확인 결과: 그 둘은 스위치를 켜도 초당 0프레임). 창을 임의로 펼치지 않고 원인을 알린다.
setPaintableProbe((wcId) => {
  try {
    if (typeof app.isHidden === "function" && app.isHidden()) return { ok: false, why: "앱 숨김(⌘H)" };
    const guest = webContents.fromId(Number(wcId));
    if (!guest || guest.isDestroyed()) return { ok: true };
    // 팝업 창은 host 가 없고, 그때는 그 webContents 가 곧 창이다. 이 경우를 보지 않으면 팝업이
    // 최소화돼도 판정이 통과한다.
    const host = !guest.isDestroyed() && guest.hostWebContents;
    const win = host && !host.isDestroyed()
      ? BrowserWindow.fromWebContents(host)
      : BrowserWindow.fromWebContents(guest);
    if (!win || win.isDestroyed()) return { ok: true };   // 판정 못 하면 막지 않는다
    if (win.isMinimized()) return { ok: false, why: "최소화" };
    // 창 단위 isVisible 은 쓰지 않는다. 배경에 만드는 창이 표시되기 전 잠시 false 라서 정상 생성
    // 과정을 실패로 판정한다. 앱 전체 숨김은 위에서 이미 확인한다.
    return { ok: true };
  } catch { return { ok: true }; }
});
setShownProbe((wc) => visibilityRegistry.isShown(wc));
setShownKnownProbe(() => visibilityRegistry.isKnown());
function isProfilePartition(partition) {
  return matchesProfilePartition(partition);
}
function guardWebviewPartition(webPreferences) {
  return profileSessionPolicy.guardWebviewPartition(webPreferences);
}
async function purgePartition(part) {
  return profileSessionPolicy.purgePartition(part);
}
function hardenSession(sess, partition = IRIS_PARTITION) {
  return profileSessionPolicy.hardenSession(sess, partition);
}
// ── 로컬 개발 서버의 자체서명 인증서 ──────────────────────────────────────
//
// 이런 페이지는 로드 실패로 끝나고 사용자가 대응할 방법이 없었다. 그렇다고 자동으로 신뢰하면
// 안 된다. 인증서를 신뢰할지는 사용자가 정한다.
// 그래서 묻는다. 묻는 창은 이미 있는 확인창 통로를 그대로 쓴다(서버의 /dialog-ask → Iris 카드).
//
// 범위는 좁게 잡는다(Orca 와 같은 기준): 루프백·localhost·*.localhost 이고, 오류가
// ERR_CERT_AUTHORITY_INVALID 인 경우만이다. 만료·이름 불일치·취소는 묻지 않는다. 로컬 개발
// 인증서의 정상적인 형태가 아니고, 반복해서 물으면 사용자가 확인 없이 수락하게 된다.
const certificateTrust = createCertificateTrust({ appUrl: () => APP_URL, fetchImpl: fetch });
function installCertificateTrust() {
  certificateTrust.installCertificateTrust(app);
}
function chromeProfileCid(entry) { return chromeImportRegistry.profileCid(entry); }
// 프로필의 정체성은 로그인한 계정이 정한다. 이름은 사용자가 언제든 바꾸고 서로 겹칠 수 있어
// 정체성이 될 수 없다.
// gaia_id가 있으면 그것이 가장 단단하고(계정 이름을 바꿔도 불변), 없으면 이메일, 그것도 없으면
// 디렉터리로 내려간다.
// 무엇을 가져왔는지는 가져온 쪽이 기록한다. 파티션 이름에 프로필 id가 들어 있는지 문자열로
// 추정하면 안 된다. 파티션은 `persist:acprof:<앱 프로필 id>`라 Chrome 프로필 id를 포함하지 않으므로,
// 그 방식에서는 이미 가져온 프로필도 전부 가져오지 않은 것으로 표시됐다.
const chromeImportRegistry = createChromeImportRegistry({ stateDir: IRIS_HOME, fs, path });
function noteChromeImport(entry, partition) {
  chromeImportRegistry.note(entry, partition);
}
// ── 자격증명 저장소(자체 자동완성용) ────────────────────────────────────────
// 파티션 → [{ origin, url, username, password }]. safeStorage(macOS Keychain 기반)로 디스크 암호화.
// Electron webview엔 네이티브 자동완성이 없어, 임포트한 로그인을 여기 보관하고 webview-preload가 채운다.
// 읽기·쓰기 판정은 cred-store.cjs가 소유한다. 읽지 못한 파일 위에 덮어쓰지 않기 위해서이고,
// 그 판정은 electron 없이 시험할 수 있어야 하기 때문이다.
const credentialService = createCredentialService({
  stateDir: IRIS_HOME,
  fs,
  safeStorage,
  sharePartitions: process.env.IRIS_CRED_SHARE_PARTITIONS === "1",
  log: (m) => { try { console.error(m); } catch {} },
});
// 렌더러가 자격증명 저장소에 접근하는 다섯 경로는 credential-ipc.cjs 가 소유한다.
// 로그인 편의 기능(자동완성·가져오기·저장) 스위치. 기본값은 꺼짐이다. 비밀번호를 한곳에 모으는
// 기능은 사용자가 직접 켠 뒤에 시작한다.
// 판정을 여기 두는 이유: 렌더러 쪽 플래그로 두면 화면에서만 사라지고 main 은 계속 값을 제공한다.
function loginConvenienceOn() { return readUiState().loginConvenience === true; }
// 처음 가져올 때 경고를 표시했는지. 한 번 표시한 뒤로는 띄우지 않는다.
function loginWarningSeen() { return readUiState().loginWarningSeen === true; }
ipcMain.handle("ac-login-convenience", (e, arg) => {
  if (!isTrustedSender(e)) return { on: false, warned: false };
  if (arg && typeof arg.on === "boolean") writeUiState({ loginConvenience: arg.on });
  if (arg && arg.warned === true) writeUiState({ loginWarningSeen: true });
  return { on: loginConvenienceOn(), warned: loginWarningSeen() };
});
// 설정 보안 분류가 쓴다. 인자 없으면 조회, {kind,on} 이면 사용 여부 변경, {clear:kind} 이면 그 기능의 사이트 기록 삭제.
ipcMain.handle("ac-site-permissions", (e, arg) => {
  if (!isTrustedSender(e)) return [];
  if (arg && typeof arg.kind === "string" && typeof arg.on === "boolean") sitePermissions.setFeature(arg.kind, arg.on);
  if (arg && typeof arg.clear === "string") sitePermissions.clearSites(arg.clear);
  return sitePermissions.summary();
});
const { setCreds } = createCredentialIpc({
  ipcMain, credentialService, isTrustedSender, isProfilePartition,
  purgePartition, basePartition: IRIS_PARTITION, loginConvenienceOn,
});
require("./browser-navigation-history.cjs").createBrowserNavigationHistory({
  app,
  ipcMain,
  webContentsFromId: (id) => webContents.fromId(id),
  isTrustedSender,
  isAllowedTarget: (event, target) => target.getType() === "webview"
    && target.hostWebContents === event.sender
    && profileSessionPolicy.ownsSession(target.session),
});
createChromeHandoffIpc({
  app,
  BrowserWindow,
  screen,
  ipcMain,
  shell,
  session,
  isTrustedSender,
  isProfilePartition,
  runChromeAuth,
  cookieImport,
  chromeProfileCid,
  chromeImportRegistry,
  profileSessionPolicy,
  passwordImport,
  setCreds,
  noteChromeImport,
});
// 프로필 경계를 넘어 계정을 합쳐 보여줄지 정한다. 기본값은 합치지 않는 것이다. 한 프로필에서 가져온
// 계정이 다른 프로필 탭과 AI 로그인 후보에 나타나면, 프로필을 나눈 의미가 조회 단계에서 사라진다.
// 이전 동작(하나의 정체성이 여러 Chrome 프로필에 흩어져 있던 경우도 합쳐 보여주던 동작)은
// IRIS_CRED_SHARE_PARTITIONS=1로 복원한다. 저장된 자격증명 자체는 어느 쪽이든 그대로 남는다.
createAiLoginPolicy({
  fs,
  path,
  stateDir: IRIS_HOME,
  ipcMain,
  isTrustedSender,
  credentialService,
  cookieImport,
  chromeImportRegistry,
  chromeProfileCid,
  isProfilePartition,
  setLoginProvider,
  ctlSend,
  partitionForSession: (sess) => profileSessionPolicy.partitionForSession(sess),
  localLoginFor,
});

// 나가기 전 세션 저장소 비우기는 storage-lifecycle.cjs 가 소유한다.
const { createStorageLifecycle } = require("./storage-lifecycle.cjs");
const storageLifecycle = createStorageLifecycle({
  forEachHardened: (fn) => profileSessionPolicy.forEachHardened(fn),
  flushPartition: async (partition) => {
    const sess = session.fromPartition(partition);
    try { await sess.flushStorageData(); } catch {}
    try { await sess.cookies.flushStore(); } catch {}
  },
  isReady: () => app.isReady(),
  quit: () => app.quit(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (...a) => console.log(...a),
});
const flushAcStorage = () => storageLifecycle.flush();
app.on("before-quit", (event) => storageLifecycle.handleBeforeQuit(event));

// 앱이 렌더링하는 링크의 확장자 표. 정본은 렌더러(web/js/center/file-routing.js)이고 여기는 복사본이다.
// webview 안에서 누른 링크는 렌더러 이벤트로 오지 않아서 그쪽 판정도 같은 표를 봐야 한다.
// 아직 안 받았으면 아무것도 가로채지 않는다: 모르면 브라우저가 그리는 쪽이 기본이다.
let appDrawnLinkExts = [];
ipcMain.on("ac-app-drawn-link-exts", (e, list) => {
  if (!isTrustedSender(e)) return;
  if (!Array.isArray(list) || list.length > 50) return;
  appDrawnLinkExts = list
    .filter((x) => typeof x === "string" && /^[a-z0-9]{1,12}$/i.test(x))
    .map((x) => x.toLowerCase());
});
function appDrawsLink(url) {
  if (!appDrawnLinkExts.length) return false;
  let pathname = "";
  try { pathname = new URL(String(url)).pathname; } catch { return false; }
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  return appDrawnLinkExts.includes(decodeURIComponent(pathname.slice(dot + 1)).toLowerCase());
}
// 분리 브라우저 창에는 글자 탭 영역이, 메모 창에는 브라우저가 없으므로 콘솔 창이 열고 그 창을 앞으로 가져온다.
ipcMain.on("ac-open-in-console", (e, target) => {
  if (!isTrustedSender(e)) return;
  // 파일 경로, 그리고 메모 창에서 누른 웹 링크(브라우저는 콘솔 창에만 있다).
  const t = consoleOpenTarget(target);
  if (!t) return;
  try {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("ac-open-local", { target: t });
    win.focus();
  } catch {}
});

// 웹뷰 주입·자식 타깃·팝업 정책은 webview-lifecycle.cjs 가 소유한다.
createWebviewLifecycle({
  app,
  noThrottleOpt: NO_THROTTLE_OPT,
  getAppUrl: () => APP_URL,
  clearThrottleState,
  forgetSecrets,
  dialogScript,
  webAuthnScript: WEBAUTHN_SCRIPT,
  botcheckScript: BOTCHECK_SCRIPT,
  openerScript: OPENER_SCRIPT,
  registerSessionPrimer,
  noteNavigation,
  forgetAttachPolicy,
  noteFrameOrigin,
  dropChildSession,
  noteChildSession,
  randomUuid: () => crypto.randomUUID(),
  // 사용자가 눌러서 뜬 팝업과 자동화가 실행해 뜬 팝업을 구분한다. 보고 있는 탭인지로는 구분할 수 없다.
  // 사용자가 콘솔에서 터미널을 입력하는 동안 자동화가 그 창의 활성 탭을 조작하는 경우가 많아, 그 판정은
  // 자동화가 연 팝업까지 사용자 조작으로 판정한다. 인과는 명령이 실행되는 순간에만 성립한다.
  aiDriving,
  aiDrivingAnywhere,
  holdAiCausality,
  registerPopup,
  unregisterPopup,
  setThrottleReason,
  reconcilePopupThrottling,
  ctlSend,
  // 페이지 안에서의 우클릭. Electron 은 기본 메뉴를 제공하지 않으므로 만들지 않으면 아무 일도 없다.
  // 검색 주소는 렌더러의 주소창과 같은 곳으로 간다(web/js/browser/webview.js).
  attachContextMenu: createWebviewContextMenu({
    Menu, clipboard,
    searchUrlFor: (q) => "https://www.google.com/search?q=" + encodeURIComponent(q),
    getContextActions: (host) => webviewContextActions.get(host),
    // 「다른 이름으로 저장」은 요청대로 저장한다. 로컬 파일을 앱으로 넘기는 규칙에서 제외한다.
    noteExplicitSave,
  }).attach,
  appDrawsLink,
  // https 문서는 앱 주소로 referrer 를 보내지 않아 대개 빈 값이다. 그때는 탭 주소로 대신하고,
  // 탭 안에 다른 출처 프레임이 있으면 그 프레임의 요청일 수 있다고 표시한다.
  openAppUrl: (wc, url, referrerUrl) => {
    let from = /^https?:/i.test(String(referrerUrl || "")) ? referrerUrl : "";
    let unsure = false;
    if (!from) {
      try {
        from = wc.getURL();
        const top = new URL(from).origin;
        unsure = wc.mainFrame.framesInSubtree.some((f) => { try { return new URL(f.url).origin !== top; } catch { return true; } });
      } catch {}
    }
    profileSessionPolicy.requestExternalOpen(wc, url, from, { unsure })
      .then((ok) => { if (ok) return shell.openExternal(url); })
      .catch(() => {});
  },
  // Electron 은 이 이벤트 안에서 동기로 정해야 해서 동기 확인 창을 쓴다. 자동화 중이면 묻지 않고 머문다.
  confirmLeave: (wc, win) => {
    if (aiDriving(wc.id)) return false;
    let parent = win;
    try { if (!parent && wc.hostWebContents) parent = BrowserWindow.fromWebContents(wc.hostWebContents); } catch {}
    let site = "";
    try { site = new URL(wc.getURL()).origin; } catch {}
    const opts = {
      type: "question",
      message: "사이트에서 나가시겠습니까?",
      detail: `${site && site !== "null" ? site + "\n" : ""}변경사항이 저장되지 않을 수 있습니다.`,
      buttons: ["나가기", "취소"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const response = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
    return response === 0;
  },
});

// 개발 인스턴스와 설치된 앱이 같은 포트를 쓰면 포트 점유를 두고 충돌한다. 포트를 갈라
// 두면 그 문제가 발생하지 않는다. 설치된 앱은 기본값 4271, 개발은 IRIS_PORT로 자기 포트를 쓴다.
const APP_PORT = acPort();
const APP_URL = "http://127.0.0.1:" + APP_PORT;

// 앱은 하나만 실행한다. 이 처리가 없으면 이미 실행 중인 상태에서 다시 실행했을 때 두 앱이 동시에 살고,
// 각자 직전 창(분리 브라우저·공유 창)을 복원해 창이 두 배로 늘어난다. 그중 하나는 서버 상태를 받지 못해
// 빈 창이 된다. 두 번째 실행은 새 앱 대신 기존 창을 앞으로 가져온다.
// 창이 더 필요하면 앱을 다시 실행하지 않고 앱 안에서 분리 창을 연다(🌐 · 공유 창).

app.on("second-instance", () => {
  const current = getMainWindow();
  const w = current && !current.isDestroyed() ? current : BrowserWindow.getAllWindows()[0];
  if (!w) return;
  try { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } catch {}
});

// 분리 브라우저 창(?mode=browser). 콘솔 UI 없이 브라우저만 표시한다. 콘솔 UI를 mode=browser로 다시 로드해
// 렌더러가 서버 공유 상태의 활성 스페이스 브라우저 탭을 미러링한다(단일 창, 이미 있으면 포커스만).
// 분리 브라우저 창 열림 상태 persist. 재기동 시 직전에 열려 있었으면 자동으로 다시 연다.
// 상태 변화 시점에 저장하므로 하드 종료(kill)에도 마지막 상태가 남는다. app 종료로 인한 창 닫힘은
// 플래그를 지우지 않는다(appQuitting 가드) → 다음 실행에서 다시 열린다.
function readUiState() { return uiStateStore.readUiState(IRIS_HOME); }
// 원자적 쓰기: temp에 쓰고 rename 한다. kill이나 디스크 부족으로 인한 truncate(파일 손상)에서 다른 키가 유실되는 것을 막는다.
function writeUiState(patch) {
  uiStateStore.writeUiState(IRIS_HOME, patch);
}
let appQuitting = false;
app.on("before-quit", () => { appQuitting = true; });
// 창 위치와 제목은 window-layout.cjs 가 소유한다.
const { createWindowLayout } = require("./window-layout.cjs");
const windowLayout = createWindowLayout({
  screen,
  windowBoundsVisible,
  readUiState: () => readUiState(),
  writeUiState: (patch) => writeUiState(patch),
  // 창 위치가 그렇게 결정된 이유를 밖에서 확인할 수 있게 기록한다. 이 결함은 모니터를 분리했다
  // 연결해야 재현되고, 기록이 없으면 다음 수정이 추측이 된다(창 전환과 같은 이유).
  fs, path,
});

const mainWindow = createMainWindow({
  app,
  BrowserWindow,
  dialog,
  shell,
  webContents,
  windowLayout,
  guardWebviewPartition,
  pinHiddenViewportById,
  preloadPath: path.join(__dirname, "preload.cjs"),
  webviewPreloadPath: path.join(__dirname, "webview-preload.cjs"),
  appUrl: APP_URL,
  audioDiagEnabled: AUDIO_DIAG_ENABLED,
  noThrottleOpt: NO_THROTTLE_OPT,
  markAppAlive: () => { appQuitting = false; },
  console,
  setTimeout,
  clearTimeout,
  setImmediate,
});
function getMainWindow() { return mainWindow.getWindow(); }

const browserWindowManager = createBrowserWindowManager({
  BrowserWindow,
  aiDrivingAnywhere,
  preloadPath: path.join(__dirname, "preload.cjs"),
  webviewPreloadPath: path.join(__dirname, "webview-preload.cjs"),
  audioDiagEnabled: AUDIO_DIAG_ENABLED,
  windowLayout,
  writeUiState,
  guardWebviewPartition,
  pinHiddenViewportById,
  webContents,
  shell,
  loadUrlWithRetry: mainWindow.loadUrlWithRetry,
  getAppUrl: () => APP_URL,
  noThrottleOpt: NO_THROTTLE_OPT,
  isPickActive: () => pickMode.isActive(),
  isAppQuitting: () => appQuitting,
  markAppAlive: () => { appQuitting = false; },
  log: (...args) => console.log(...args),
});

const memoWindowManager = createMemoWindowManager({
  BrowserWindow,
  ipcMain,
  preloadPath: path.join(__dirname, "preload.cjs"),
  windowLayout,
  readUiState,
  writeUiState,
  loadUrlWithRetry: mainWindow.loadUrlWithRetry,
  getAppUrl: () => APP_URL,
  isTrustedSender,
  isAppQuitting: () => appQuitting,
  markAppAlive: () => { appQuitting = false; },
  randomUuid: () => crypto.randomUUID(),
  log: (...args) => console.log(...args),
});

const pickMode = createPickMode({
  app,
  screen,
  globalShortcut,
  BrowserWindow,
  ipcMain,
  execFile,
  browserWindowManager,
  getMainWindow,
  isTrustedSender,
  injectOverlayAllFrames,
  hoverAtPoint,
  diagSince,
  runCdp,
  webContents,
});
const windowCatalog = createWindowCatalog({
  execFile,
  readCoreSource: () => fs.readFileSync(path.join(__dirname, "switcher-core.cjs"), "utf8"),
  log: (...args) => console.warn(...args),
});
const windowIcons = createWindowIcons({
  execFile,
  log: (...args) => console.warn(...args),
});
const windowMedia = createWindowMedia({
  desktopCapturer,
  systemPreferences,
  nativeImage,
  log: (...args) => console.warn(...args),
});
// ⌥Tab 토글을 받는 창: 콘솔 창과 브라우저 모드 창(분리 탭 창 포함). 메모 창·에뮬레이터 분리 창은 제외
function takesSwitcherToggle(w) {
  if (!w || w.isDestroyed()) return false;
  if (w === getMainWindow()) return true;
  try { return new URL(w.webContents.getURL()).searchParams.get("mode") === "browser"; } catch { return false; }
}
let lastSwitchWindow = null;
app.on("browser-window-focus", (_e, w) => { if (takesSwitcherToggle(w)) lastSwitchWindow = w; });
switcherHost = createSwitcherHost({
  core: switcherCore,
  catalog: windowCatalog,
  iconRunner: windowIcons,
  mediaRunner: windowMedia,
  fs,
  path,
  stateHome,
  globalShortcut,
  defaultRelay: DEFAULT_RELAY,
  killProbe: (pid) => { process.kill(pid, 0); return true; },
  ownPid: process.pid,
  // 이 앱의 자기 창은 앱이 직접 올린다. 자기 창이 아니면 false 를 돌려 기존 경로로 보낸다.
  raiseOwnWindow: (target) => {
    if (!target) return false;
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const title = (w) => { try { return w.getTitle(); } catch { return null; } };
    const sameBounds = (w) => {
      try {
        const b = w.getBounds();
        return Array.isArray(target.bounds) && b.x === target.bounds[0] && b.y === target.bounds[1];
      } catch { return false; }
    };
    const win = wins.find((w) => title(w) === target.matchTitle) || wins.find(sameBounds);
    if (!win) return false;
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // 다른 데스크톱에 있는 창은 show·focus 만으로는 안 온다.
      //
      // 창을 key 로 만드는 것과 앱을 활성으로 만드는 것은 다른 동작이다. macOS 가 데스크톱을
      // 전환하는 것은 앱이 활성이 될 때이고, 그때 key 창이 있는 데스크톱으로 이동한다. focus 만
      // 호출하면 앱이 활성이 되지 않은 채 key 만 바뀌어 화면은 그대로인데, 예외가 발생하지
      // 않으므로 성공으로 기록된다.
      // 확인 결과: 선택한 창이 없는 데스크톱에서 opt+Tab 을 두 번 눌렀더니 두 번 모두
      // how="own-window" 로 성공이 기록되고 데스크톱은 그대로였다. 올리지 못했으므로 다음 시도의
      // 앞 창도 여전히 목록 밖이고, selectTarget 은 첫 창부터 다시 고른다(R9).
      // 그러면 누를 때마다 같은 창만 선택되고 화면은 바뀌지 않는다.
      // 이 동작을 osascript 가 맡던 때는 데스크톱을 순회해 전환했다. 그 경로를 앱으로 옮기면서
      // 함께 빠진 처리가 이것이다.
      app.focus({ steal: true });
      win.focus();
      return true;
    } catch { return false; }
  },
  // 고른 창 없이 전역 우선 사용으로 받은 ⌥Tab. 콘솔·브라우저 창이 앞이면 그 창에 토글,
  // 그 밖(메모·에뮬레이터 분리 창·다른 앱)이면 마지막으로 쓴 콘솔·브라우저 창을 앞으로(irisKeyAction)
  irisKey: () => {
    const { action, win } = irisKeyAction(
      { focused: BrowserWindow.getFocusedWindow(), lastSwitch: lastSwitchWindow, main: getMainWindow() }, takesSwitcherToggle);
    if (action === "toggle") { win.webContents.send("ac-switcher-toggle"); return; }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    // 창 focus 만으로는 앱이 활성이 되지 않아 다른 데스크톱의 창이 오지 않는다(raiseOwnWindow 주석).
    app.focus({ steal: true });
    win.focus();
  },
  isTrustedSender: matchesTrustedSender,
  isTrustedMediaSender: (event) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return false;
    return isTrustedMainFrame(event, APP_URL, window.webContents);
  },
  expectedAppUrl: APP_URL,
  shell,
  broadcast: (payload) => {
    for (const target of BrowserWindow.getAllWindows()) {
      try { if (!target.isDestroyed()) target.webContents.send("ac-switcher-state", payload); } catch {}
    }
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
// 창 전환 요청은 host 한 경계로만 들어간다. 신뢰 판정도 host가 매 호출 첫 단계에서 한다.
ipcMain.handle("ac-window-switcher", (e, payload) => switcherHost.handle(e, payload));
// 픽 전달 직후 콘솔 창으로 포커스를 되돌린다. 클릭이 브라우저 창을 활성화해도 사용자는 채팅을 계속 입력한다.
// 콘솔 창을 닫아도 브라우저 창이 남으면 앱이 계속 뜬다. 그때 부르면 콘솔을 다시 만든다
function showConsoleWindow() {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); return; }
  mainWindow.createWindow();
}
ipcMain.on("ac-refocus-console", () => { try { showConsoleWindow(); } catch {} });
// 메인 창 ⌘⇧R = 앱 강제 재로딩(메인 + 열려 있는 브라우저 창 전부). 캐시를 무시하고 다시 읽는다.
// 녹화 전문 저장. 채팅에 모두 넣기에 긴 기록은 파일로 두고 경로만 넘긴다(로컬 전용).
ipcMain.handle("ac-save-recording", (e, text) => {
  try {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const dir = artifactDir("recordings", IRIS_HOME);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rec-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md");
    fs.writeFileSync(file, String(text || ""), "utf8");
    return { ok: true, path: file };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.on("ac-app-reload", () => {
  const win = getMainWindow();
  try { win?.webContents.reloadIgnoringCache(); } catch {}
  for (const b of browserWindowManager.allBrowserWindows()) { try { b.webContents.reloadIgnoringCache(); } catch {} }
  for (const b of memoWindowManager.allMemoWindows()) { try { b.webContents.reloadIgnoringCache(); } catch {} }
});
const osNoticeIds = new Map();
const osNoticeHandles = new Map();
ipcMain.on("ac-notify", (event, message) => {
  if (!isTrustedSender(event) || BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
  const id = String(message && message.id || "").slice(0, 100);
  if (!id || osNoticeIds.has(id)) return;
  const now = Date.now();
  for (const [key, at] of osNoticeIds) if (now - at > 600000) osNoticeIds.delete(key);
  osNoticeIds.set(id, now);
  const target = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
  const notice = new Notification({ title: String(message.title || "Iris").slice(0, 60),
    body: String(message.body || "").slice(0, 300) });
  osNoticeHandles.set(id, notice);
  notice.on("close", () => osNoticeHandles.delete(id));
  notice.on("click", () => {
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show(); target.focus();
    app.focus({ steal: true });
    target.webContents.send("ac-notice-activate", { id });
  });
  notice.show();
});
ipcMain.on("ac-open-browser", (_e, opts) => { try { browserWindowManager.createBrowserModeWindow(false, opts); } catch {} });
ipcMain.on("ac-open-shared-browser", (_e, opts) => { try { browserWindowManager.createBrowserModeWindow(true, opts); } catch {} });
ipcMain.on("ac-dock-browser", () => { browserWindowManager.dockBrowserModeWindows(); });
memoWindowManager.registerMemoIpc();
// 네이티브 기능은 표를 통해서만 등록된다. 이 위치에 기능 이름이 나오지 않는 것이 핵심이다.
// 기능을 제거해도 이 줄은 그대로다. 넘기는 ctx 는 앱 셸이 가진 공용 요소뿐이다.
bootNativeCapabilities({
  items: NATIVE_CAPABILITIES,
  isOn: (id) => featureOn(readFeatureState(IRIS_HOME), id, NATIVE_CAPABILITIES.some((c) => c.id === id && c.optIn)),
  ctx: {
    BrowserWindow,
    ipcMain,
    preloadPath: path.join(__dirname, "preload.cjs"),
    webviewPreloadPath: path.join(__dirname, "webview-preload.cjs"),
    // 상태 폴더와 CDP 연결도 앱 셸의 공용 요소다. 기능이 각자 경로를 조합하거나 세션을 새로 열지 않는다.
    stateDir: IRIS_HOME,
    runCdp,
    windowLayout,
    guardWebviewPartition,
    isProfilePartition: matchesProfilePartition,
    pinHiddenViewportById,
    webContents,
    screen,
    shell,
    loadUrlWithRetry: mainWindow.loadUrlWithRetry,
    getAppUrl: () => APP_URL,
    noThrottleOpt: NO_THROTTLE_OPT,
    isTrustedSender,
    app,
    sessionFromPartition: (partition) => session.fromPartition(partition),
    forEachHardened: (callback) => profileSessionPolicy.forEachHardened(callback),
    onSessionHardened: (listener) => profileSessionPolicy.onSessionHardened(listener),
    notice: (message) => {
      for (const target of BrowserWindow.getAllWindows()) {
        try { if (!target.isDestroyed()) target.webContents.send("ac-native-notice", message); } catch {}
      }
    },
    isAppQuitting: () => appQuitting,
    markAppAlive: () => { appQuitting = false; },
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  },
  onError: (id, e) => console.error(`[capability] ${id} 실패`, e),
});

// 메뉴 막대와 쿠키 가져오기 흐름을 담당하는 모듈은 menu.cjs 다.
const appMenu = createMenu({
  Menu, BrowserWindow, dialog, platform: process.platform, getMainWindow, appUrl: APP_URL,
  isBrowserModeWindow: (w) => browserWindowManager.hasBrowserModeWindow(w),
  isMemoWindow: (w) => memoWindowManager.hasMemoWindow(w),
  allBrowserWindows: () => browserWindowManager.allBrowserWindows(),
  allMemoWindows: () => memoWindowManager.allMemoWindows(),
  cookieImport,
});

// 가림 판정은 항상 끈다. 창이 덮이면 macOS가 합성을 멈춰서, 배경 탭을 1%로 겹쳐 두는 캡처
// 방식이 실패한다(확인 결과: 정적 파일 한 장에서 25초가 걸렸다). 그때마다 Iris 창을 앞으로
// 올려 맞추는 방식은 사용자가 보던 화면을 덮고 되돌아가지 않았다.
// 그래서 창을 올리는 대신 가림 판정을 끈다.
// 이 둘은 창 단위 가림 판정만 끈다. webContents별 조건부 스로틀(webview-throttle)은 그대로 동작한다.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion"); // Windows 쪽 같은 판정
// 나머지 둘은 프로세스 전체를 항상 비스로틀로 만들어 그 조건부 정책을 무력화하므로 롤백 스위치에만 남긴다.
if (NO_THROTTLE_OPT) {
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}
audioDiagnostics.applyTestSwitches(app.commandLine);
// 서버는 앱의 자식 프로세스다(native/electron/server-host.cjs). 창을 만들기 전에 먼저 실행한다.
// 창이 먼저 뜨면 첫 loadURL이 반드시 실패하고, 사용자는 빈 화면을 본 뒤 재시도로 채워지는 것을 본다.
// 이미 떠 있는 서버가 있으면 띄우지 않고 붙는다(전환기의 launchd 서버, 또는 개발 인스턴스).
// 네트워크 정책이 다른 서버 안내 후 종료. 기동 시·기동 이후 공통
function quitForServerPolicy(pid) {
  dialog.showMessageBoxSync({
    type: "error",
    buttons: ["종료"],
    message: `${APP_PORT}번에 이전 버전 Iris 서버가 있습니다`,
    detail: `그 서버${pid ? `(pid ${pid})` : ""}는 외부 접속을 받을 수 있는 이전 네트워크 정책으로 실행 중입니다.\n`
      + `그 서버를 종료한 뒤 앱을 다시 실행해 주세요.`,
  });
  app.quit();
}
const serverHost = new ServerHost({
  app, port: APP_PORT, stateDir: IRIS_HOME,
  onPolicyMismatch: (health) => quitForServerPolicy(health?.pid),
});
// 앱이 종료될 때 자식 프로세스도 함께 종료한다. 여기서 종료하지 않으면 서버만 남아, 다음에 실행한
// 앱이 이전 서버에 붙어 수정이 반영되지 않는다.
if (process.platform === "win32") app.on("will-quit", (event) => serverHost.handleWindowsQuit(event));
else app.on("will-quit", () => { try { serverHost.stop(); } catch {} });
app.on("will-quit", () => { try { switcherHost.stop(); } catch {} });

app.whenReady().then(async () => {
  const webauthn = require("./webauthn-platform.cjs").configurePlatformWebAuthn(app);
  console.log(`[webauthn] ${webauthn.reason}`);
  pickMode.registerGlobalShortcut();
  switcherHost.start(); // ready 기준 +3초·+8초 재결합 창을 여기서 연다.
  const started = await serverHost.start();
  // 네트워크 정책이 다른 이전 서버는 연결 선택지 없이 종료. 외부 수신 가능 서버 연결 방지
  if (started && started.policyMismatch) {
    quitForServerPolicy(started.conflict?.pid);
    return;
  }
  // 그 포트에 다른 상태 폴더를 쓰는 서버가 있으면 창을 바로 열면 안 된다. 열면 사용자는 자기
  // 탭·북마크가 사라진 화면을 보고 다른 인스턴스의 상태를 수정하게 된다. 개발 인스턴스가 4271에
  // 떠 있을 때 실제로 발생한다. 무엇이 그 포트에 있는지 알리고 사용자가 결정하게 한다.
  if (started && started.conflict) {
    const c = started.conflict;
    const answer = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["종료", "그래도 연결"],
      defaultId: 0,
      cancelId: 0,
      message: `${APP_PORT}번을 다른 서버가 쓰고 있습니다`,
      detail: `그 서버(pid ${c.pid})는 ${c.stateDir || "알 수 없는 곳"}을 상태 폴더로 씁니다.\n`
        + `이 앱의 상태 폴더는 ${IRIS_HOME} 입니다.\n\n`
        + `그대로 연결하면 그쪽 탭·북마크·계정이 보이고, 여기서 고친 것은 그쪽에 저장됩니다.\n`
        + `보통은 그 서버를 내리거나 IRIS_PORT로 포트를 갈라야 합니다.`,
    });
    if (answer === 0) { app.quit(); return; }
  }
  // 기존 Chrome 가져오기 기록도 새 UA 계약으로 올린다. 세션을 만들지는 않으므로 각 프로필의
  // 첫 webview가 붙기 전에 hardenSession이 올바른 값을 읽는다.
  for (const imported of chromeImportRegistry.list()) {
    if (imported && isProfilePartition(imported.partition)) {
      cookieImport.rememberBrowserUserAgent(imported.partition, imported.browser);
    }
  }
  appMenu.build();
  startAudioDiagnostics();
  // 사용자의 실제 Chrome이 원격 디버깅 플래그로 실행 중이면 그 창에서는 구글 로그인이 막힌다.
  // 알리지 않으면 "브라우저가 안전하지 않다"는 메시지의 원인을 찾기 어려우므로, 시작할 때 한 번 알린다.
  try {
    const bad = chromeAuth.findPoisonedChrome();
    if (bad.length) {
      console.log("[chrome] 경고: 원격 디버깅 플래그가 붙은 Chrome이 떠 있습니다 — 그 창에선 구글 로그인이 거부됩니다. Chrome을 완전히 종료 후 재실행하세요. pid=" + bad.map((b) => b.pid).join(","));
      setTimeout(() => { try { const win = getMainWindow(); if (win && !win.isDestroyed()) dialog.showMessageBox(win, { type: "warning", message: "Chrome이 원격 디버깅 상태로 실행 중입니다", detail: "그 Chrome 창에서는 구글 로그인이 거부됩니다(\"브라우저 또는 앱이 안전하지 않을 수 있습니다\").\n\nChrome을 완전히 종료했다 다시 켜면 풀립니다.\npid " + bad.map((b) => b.pid).join(", ") }); } catch {} }, 1500);
    }
  } catch {}
  hardenSession(session.fromPartition(IRIS_PARTITION), IRIS_PARTITION); // ①③ UA 정리 + Client Hints (첫 내비 전) + 다운로드 관찰
  installCertificateTrust();
  mainWindow.createWindow();
  setupCdpControl(webContents); // 서버(4271)에 CDP 실행기로 붙어 iris-browser 명령을 활성 webview에 실행
  const storageFlushTimer = setInterval(() => { void flushAcStorage(); }, 10000); // 강제 종료 시 유실 구간을 줄인다
  if (storageFlushTimer.unref) storageFlushTimer.unref();
  // 재기동 자동 리스폰: 분리 브라우저 창이 직전에 열려 있었으면 자동 재오픈한다.
  // 다른 스페이스 브라우저까지 복구된다는 우려로 자동 열기를 막았으나, 분리창은 서버 상태의
  // activeSpace만 미러링하므로 "지금 그 스페이스의 활성 탭"만 되살아난다(다른 스페이스 강제복구 아님).
  // 재오픈된 창의 reconcileBrowserMode가 webview를 되살리고 렌더러가 활성 탭 wc를 자동 보고 → 사용자
  // 클릭 없이 CDP 제어 재개. 닫아둔 상태(browserOpen=false)면 열지 않는다. 서버만 재시작된 경우엔
  // 라이브 webview가 ws.onopen에서 wc를 재보고하므로 그대로 재인식된다.
  if (readUiState().browserOpen) setTimeout(() => { try { if (readUiState().browserOpen) browserWindowManager.createBrowserModeWindow(false); } catch {} }, 1500);
  if (readUiState().sharedOpen) setTimeout(() => { try { if (readUiState().sharedOpen) browserWindowManager.createBrowserModeWindow(true); } catch {} }, 1700); // 타이머 발화 시 재확인(그 사이 사용자가 닫았으면 열지 않음)
  for (const [index, record] of memoWindowManager.memoWindowSnapshot().records.entries()) {
    setTimeout(() => { try { if (memoWindowManager.hasMemoRecord(record.instanceId)) memoWindowManager.createMemoModeWindow(record); } catch {} }, 1850 + index * 80);
  }
  // Dock 클릭. 다른 창이 남아 있어도 콘솔이 없으면 다시 연다
  app.on("activate", () => { const win = getMainWindow(); if (!win || win.isDestroyed()) mainWindow.createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
// SIGTERM(예: kill로 재기동)에 graceful quit 한다. before-quit/close 핸들러가 실행되어 창 bounds가 저장된다.
// 막히면 1.5s 후 강제 종료. (SIGKILL/kickstart -k는 어떤 핸들러도 못 돌므로 마지막 debounce 저장분은 유실될 수 있음.)
process.on("SIGTERM", () => { try { app.quit(); } catch {} setTimeout(() => process.exit(0), 1500); });
