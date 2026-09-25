// 렌더러 ↔ 메인 IPC 브릿지 (contextIsolation 유지). 브라우저 탭 외부 분리/재도킹용.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
function subscribe(channel, cb) {
  const handler = (_e, data) => { try { cb(data); } catch {} };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld("acHost", {
  // 클립보드 텍스트 읽기. 터미널 Cmd+V가 kitty 인코딩에 막히는 문제를 우회한다(직접 붙여넣기).
  // preload가 sandbox라 clipboard 모듈이 없으므로, 메인 프로세스에 동기 IPC로 요청한다.
  readClipboard: () => ipcRenderer.sendSync("ac-clipboard-read"),
  // 드롭된 파일의 절대경로. Electron 32+에서 File.path가 제거돼 sandbox preload에서도 쓰는 webUtils를 사용한다.
  // 터미널에 파일(이미지 등)을 드래그하면 iTerm2처럼 절대경로를 삽입해 Claude Code가 로드하게 한다.
  getDroppedPath: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  // 터미널 선택 복사. 메인 프로세스 clipboard에 직접 쓴다(렌더러 navigator.clipboard 실패 우회).
  // 썼으면 true 로 풀리는 Promise 를 돌려준다. 복사 알림은 이 결과를 보고 띄운다.
  writeClipboard: (text) => ipcRenderer.invoke("ac-clipboard-write", text),
  // 분리 브라우저 창(?mode=browser)을 연다(기본 분리형). 이미 있으면 포커스만.
  // opts.background:true 면 창을 만들되 앞으로 내지 않는다. AI 탭 때문에 호출하는 쪽이 쓴다.
  openBrowser: (opts) => ipcRenderer.send("ac-open-browser", opts || null),
  // 로컬 메모는 같은 문서도 여러 창으로 열 수 있고, 공유 메모는 호출할 때마다 새 인스턴스를 만든다.
  openLocalMemo: (args) => ipcRenderer.invoke("ac-open-local-memo", args),
  openSharedMemo: () => ipcRenderer.invoke("ac-open-shared-memo"),
  memoWindows: () => ipcRenderer.invoke("ac-memo-window-list"),
  setMemoViewMode: (mode) => ipcRenderer.send("ac-memo-view-mode", mode),
  setMemoAlwaysOnTop: (enabled) => ipcRenderer.invoke("ac-memo-always-on-top", !!enabled),
  setMemoWindowTitle: (title) => ipcRenderer.send("ac-memo-window-title", title),
  closeMemoWindow: () => ipcRenderer.send("ac-memo-close-window"),
  onMemoWindowsChanged: (cb) => ipcRenderer.on("ac-memo-windows-changed", (_e, value) => cb(value)),
  // 분리 브라우저 창에서 도킹 → 그 창을 닫고 콘솔 센터로 되돌린다.
  dockBrowser: () => ipcRenderer.send("ac-dock-browser"),
  // webview 포커스 중 눌린 브라우저 단축키(⌘⇧E/⌘⇧D)를 메인이 가로채 콜백에 이름으로 전달한다.
  onShortcut: (cb) => ipcRenderer.on("ac-shortcut", (_e, name) => cb(name)),
  // 선택 기능이 webview 우클릭 메뉴에 보탤 범용 action. 등록은 host renderer만 할 수 있고,
  // click은 action 이름과 실제 guest id만 돌아온다. 번역 등 기능의 뜻은 이 bridge가 모른다.
  registerContextAction: (action) => ipcRenderer.send("ac-context-action-register", action),
  onContextAction: (listener) => {
    const handler = (_e, message) => { try { listener(message); } catch {} };
    ipcRenderer.on("ac-context-action", handler);
    return () => ipcRenderer.removeListener("ac-context-action", handler);
  },
  // 현재 적용 중인 단축키 표를 메인에 알린다. webview 에 포커스가 있으면 렌더러 keydown 이 발생하지
  // 않으므로 그쪽 판정도 같은 표를 봐야 한다. 보내지 않으면 화면에서 바꾼 키가 페이지 위에서 동작하지 않는다.
  setKeymap: (map) => ipcRenderer.send("ac-keymap", map),
  windowSwitcher: (payload) => ipcRenderer.invoke("ac-window-switcher", payload),
  onSwitcherState: (cb) => ipcRenderer.on("ac-switcher-state", (_e, value) => cb(value)),
  // 탭별 프로필 파티션 세션 하드닝(UA/Client Hints) 보장. webview attach 전에 호출한다.
  ensureProfile: (partition) => ipcRenderer.send("ac-ensure-profile", partition),
  // Chrome 확장 로더는 고정 descriptor만 다룬다. renderer는 path나 extension id를 정하지 못한다.
  enableExtensionLoader: () => ipcRenderer.invoke("ac-extension-loader-enable"),
  waitForExtension: (partition) => ipcRenderer.invoke("ac-extension-loader-wait", partition),
  // 실제 Chrome 미러. frame/meta payload는 화면에 전달할 뿐 로그로 남기지 않는다.
  browserHistoryExport: (wcId) => ipcRenderer.invoke("ac-browser-history-export", wcId),
  // restore는 webview의 최초 src load 전에 main에 맡겨야 한다. 동기 stage는 marker만 받고,
  // 실제 복원 완료는 attach 뒤 비동기 finish에서 기다린다.
  browserHistoryStage: (history) => ipcRenderer.sendSync("ac-browser-history-stage", history),
  browserHistoryFinish: (token) => ipcRenderer.invoke("ac-browser-history-finish", token),
  liveChromeConnect: () => ipcRenderer.invoke("ac-live-chrome-connect"),
  liveChromeOpen: (payload) => ipcRenderer.invoke("ac-live-chrome-open", payload),
  liveChromeCommand: (payload) => ipcRenderer.invoke("ac-live-chrome-command", payload),
  liveChromeClose: (payload) => ipcRenderer.invoke("ac-live-chrome-close", payload),
  liveChromeNative: (payload) => ipcRenderer.invoke("ac-live-chrome-native", payload),
  liveChromeDisconnect: () => ipcRenderer.invoke("ac-live-chrome-disconnect"),
  liveChromeOpenNative: (payload) => ipcRenderer.invoke("ac-live-chrome-open-native", payload),
  liveChromeOpenSettings: () => ipcRenderer.invoke("ac-live-chrome-open-settings"),
  onLiveChromeFrame: (cb) => ipcRenderer.on("live-chrome-frame", (_e, payload) => cb(payload)),
  onLiveChromeState: (cb) => ipcRenderer.on("live-chrome-state", (_e, payload) => cb(payload)),
  mirrorStart: (payload) => ipcRenderer.invoke("ac-mirror-start", payload),
  mirrorInput: (payload) => ipcRenderer.invoke("ac-mirror-input", payload),
  mirrorResize: (payload) => ipcRenderer.invoke("ac-mirror-resize", payload),
  mirrorStop: (payload) => ipcRenderer.invoke("ac-mirror-stop", payload),
  onMirrorFrame: (cb) => ipcRenderer.on("mirror-frame", (_e, payload) => cb(payload)),
  onMirrorMeta: (cb) => ipcRenderer.on("mirror-meta", (_e, payload) => cb(payload)),
  // 설치된 Chrome/Brave/Edge 프로필 목록(그대로 가져오기용).
  listChromeProfiles: () => ipcRenderer.invoke("ac-list-chrome-profiles"),
  // 지정 Chrome 프로필의 쿠키(로그인 세션)를 지정 탭 파티션으로 가져온다.
  importChromeProfile: (id, partition, withPasswords) => ipcRenderer.invoke("ac-import-chrome-profile", { id, partition, withPasswords: withPasswords === true }),
  // 패스키 로그인은 이 창에서 끝낼 수 없다(플랫폼 인증기 없음). 연결된 실제 Chrome 계정
  // 프로필을 일반 창으로 열고, 닫힌 뒤 현재 사이트 범위의 쿠키만 돌려받는다.
  chromeAuth: (url, partition, chromeSource, fields) =>
    ipcRenderer.invoke("ac-chrome-auth", { url, partition, chromeSource, fields }),
  onChromeAuthStage: (cb) => ipcRenderer.on("ac-chrome-auth-stage", (_e, s) => cb(s)),
  // 이 주소를 기본 브라우저로 연다. 호출하는 버튼은 아직 없다(main.cjs 쪽 주석 참고).
  openInChrome: (url) => ipcRenderer.send("ac-open-in-chrome", url),
  // 파일 트리 컨텍스트 메뉴. 파일 위치를 Finder에서 보여준다.
  revealInFinder: (p) => ipcRenderer.send("ac-reveal-in-finder", p),
  // 파일/폴더를 macOS 휴지통으로(되돌릴 수 있는 삭제). 결과 { ok, error }.
  trashItem: (p) => ipcRenderer.invoke("ac-trash-item", p),
  // 여러 개를 한 번에 휴지통으로. 결과 { ok, moved, failed:[{path,error}] }.
  // 하나씩 호출하면 수천 개에서 창이 그 왕복에 묶인다.
  trashItems: (list) => ipcRenderer.invoke("ac-trash-items", list),
  // 삭제 preflight가 경로 별칭과 대기 중 외부 변경을 판별할 때 쓰는 read-only identity.
  filePathIdentity: (p) => ipcRenderer.invoke("ac-path-identity", p),
  // 탭 화면 크기 지정(반응형 확인). wcId = webview.getWebContentsId(). 결과 { ok, error }.
  setViewport: (opts) => ipcRenderer.invoke("ac-viewport", opts),
  // AI가 iris-browser viewport로 바꿨을 때 주소줄 버튼이 실제 상태와 일치하도록 알린다.
  onViewportChanged: (cb) => ipcRenderer.on("ac-viewport-changed", (_e, m) => cb(m)),
  // 캡처 순간에만 그 탭을 합성 대상으로 유지해 달라는 요청(보이지 않는 탭도 캡처되게).
  onCaptureHold: (cb) => ipcRenderer.on("ac-capture-hold", (_e, m) => cb(m)),
  // 이 탭이 화면에 나왔다는 통지. 보이지 않을 때 대신 넣어 준 화면 크기를 해제한다.
  tabShown: (wc, w, h) => ipcRenderer.send("ac-tab-shown", { wc, w, h }),
  // webview LRU/스로틀 정책은 메인 프로세스 env가 정본이다. 렌더러는 값을 읽고 보호 집합만 보고한다.
  webviewPolicy: () => ipcRenderer.sendSync("ac-webview-policy"),
  setWebviewThrottleState: (state) => ipcRenderer.send("ac-webview-throttle-state", state),
  // AudioService 진단 모드에서만 존재한다. 기본 실행은 미디어 이벤트 IPC를 만들지 않는다.
  ...(process.argv.includes("--ac-audio-diag") ? {
    audioMediaEvent: (event, tabId, wcId) => ipcRenderer.send("ac-audio-media-event", { event, tabId, wcId }),
  } : {}),
  // 지목(권한 확대) 메시지를 서버가 받아 주게 하는 증명. 앱만 읽을 수 있는 파일에서 온다.
  uiToken: () => ipcRenderer.sendSync("ac-ui-token"),
  // 자체 자동완성. 파티션·origin의 저장된 로그인이며, webview-preload 요청을 렌더러가 중계한다.
  // 목록에는 아이디만 온다. 비번은 사용자가 그 계정을 고른 순간 credsPassword로 하나만 꺼낸다.
  getCreds: (partition, origin) => ipcRenderer.invoke("ac-get-creds", { partition, origin }),
  credsPassword: (partition, origin, username) => ipcRenderer.invoke("ac-creds-password", { partition, origin, username }),
  // 이 브라우저에서 새로 로그인한 자격증명을 저장소에 넣는다. 사용자가 저장을 누른 뒤에만 호출된다.
  saveCred: (partition, login) => ipcRenderer.invoke("ac-cred-save", { partition, ...(login || {}) }),
  // 로그인 편의 기능 스위치. 인자 없이 호출하면 현재 상태를 읽고, {on} 을 주면 변경한다.
  loginConvenience: (arg) => ipcRenderer.invoke("ac-login-convenience", arg || {}),
  // 계정 페이지. 파티션별 저장된 자격증명 요약(비번 제외)과 삭제.
  credsSummary: (partition) => ipcRenderer.invoke("ac-creds-summary", partition),
  clearCreds: (partition) => ipcRenderer.invoke("ac-clear-creds", partition),
  purgePartition: (partition) => ipcRenderer.invoke("ac-purge-partition", partition),
  // 탭 하나를 자기 창으로 분리한다(Chrome의 탭 분리). 되돌리기는 그 창을 닫는 것과 같다.
  // 창을 닫아 탭을 잃는 경로를 만들지 않으려고 닫기를 되돌리기로 정의했다.
  detachTab: (arg) => ipcRenderer.invoke("ac-detach-tab", arg || {}),
  reattachTab: (tabId) => ipcRenderer.invoke("ac-reattach-tab", { tabId }),
  detachedTabs: () => ipcRenderer.invoke("ac-detached-tabs"),
  onDetachedTabs: (fn) => {
    const h = (_e, payload) => { try { fn(payload && payload.tabs || []); } catch {} };
    ipcRenderer.on("ac-detached-tabs", h);
    return () => ipcRenderer.removeListener("ac-detached-tabs", h);
  },
  // 탭 끌기. Chrome의 TabDragController 에 해당하며, 판정과 창 조작은 main 이 한다.
  // 렌더러는 자기 띠가 화면 어디에 있는지 알려 주고, 커서 좌표를 보내는 일만 한다.
  tabStripRect: (rect) => ipcRenderer.send("ac-tabstrip-rect", rect || null),
  tabDragStart: (arg) => ipcRenderer.invoke("ac-tabdrag-start", arg || {}),
  tabDragMove: (pt) => ipcRenderer.invoke("ac-tabdrag-move", pt || {}),
  tabDragEnd: () => ipcRenderer.invoke("ac-tabdrag-end"),
  // 연결된 Chrome의 로그인 변화를 점검한다. native가 기존 로그인 출처와 복구 필요 여부를 판정한다.
  refreshChromeCookies: (partition, url) => ipcRenderer.invoke("ac-refresh-chrome-cookies", { partition, url }),
  // 고른 요소를 그 시점에 잘라 캡처한다. 나중에 캡처하면 화면이 달라져 있다.
  pickShot: (wc, sel) => ipcRenderer.invoke("ac-pick-shot", { wc, sel }),
  // 스케치. 캡처는 바이트로 받고(창은 file:// 을 읽지 못한다), 그린 결과는 상태 폴더에 저장한다.
  sketchShot: (wc) => ipcRenderer.invoke("ac-sketch-shot", { wc }),
  sketchSave: (bytes) => ipcRenderer.invoke("ac-sketch-save", { bytes }),
  // 창 레이아웃 기능을 끌 때 단축키·타이머·이 기능이 켠 로그인 항목을 되돌린다.
  deskLayoutDisable: () => ipcRenderer.invoke("ac-desklayout-disable"),
  // AI 자동완성 로그인 허용 목록. 사이트·아이디만 오가며 비번은 이 경로로 전달하지 않는다.
  aiLoginList: () => ipcRenderer.invoke("ac-ai-login-list"),
  aiLoginSources: (sources) => ipcRenderer.invoke("ac-ai-login-sources", { sources }),
  aiLoginSet: (origin, username, allowed) => ipcRenderer.invoke("ac-ai-login-set", { origin, username, allowed }),
  // 요소 선택 모드: 포커스 없는 창도 커서를 따라가야 하므로 OS 커서 좌표를 메인에서 받는다.
  openSharedBrowser: () => ipcRenderer.send("ac-open-shared-browser"),
  setPickMode: (on) => ipcRenderer.send("ac-pick-mode", !!on),
  // 선택 오버레이·기록기를 그 탭의 iframe 안까지 주입한다. executeJavaScript 는 최상위 프레임만 대상으로 한다.
  framesInject: (wc, key, src, on) => ipcRenderer.send("ac-frames-inject", { wc, key, src, on: !!on }),
  // 포커스 없는 창의 커서 추적. Chromium이 좌표에 맞는 프레임으로 전달한다(iframe 안까지).
  framesHover: (wc, x, y) => ipcRenderer.send("ac-frames-hover", { wc, x, y }),
  // 녹화에 합칠 관찰 기록(콘솔·예외·네트워크 실패·확인창).
  recDiag: (wcs, since) => ipcRenderer.invoke("ac-rec-diag", { wcs, since }),
  onCursor: (cb) => ipcRenderer.on("ac-cursor", (_e, pt) => cb(pt)),
  onRecNative: (cb) => ipcRenderer.on("ac-rec-native", (_e, ev) => cb(ev)), // 게스트 JS로 못 보는 시스템 이벤트(다운로드 등)
  // main 이 사용자에게 한 줄 알리는 경로. 취소된 동작이 버튼 오작동으로 보이지 않게 한다.
  onNativeNotice: (cb) => ipcRenderer.on("ac-native-notice", (_e, m) => cb(m)),
  onOpenTab: (cb) => ipcRenderer.on("ac-open-tab", (_e, m) => cb(m)), // 게스트의 "새 탭으로 열기"를 별도 창이 아니라 앱의 탭으로 처리
  // 페이지 안에서 누른 로컬 링크. 브라우저가 렌더링하지 못하는 것(표·문서)과 앱이 렌더링하는 것(마크다운).
  onOpenLocal: (cb) => ipcRenderer.on("ac-open-local", (_e, m) => cb(m)),
  // 로컬에서 받은 파일. 뷰어가 맡는 종류면 연다. 그 판정은 렌더러가 한다.
  onDownloaded: (cb) => ipcRenderer.on("ac-downloaded", (_e, m) => cb(m)),
  // 분리 브라우저 창에는 글자 탭 영역이 없으므로 그 파일은 콘솔 창이 연다.
  openInConsole: (target) => ipcRenderer.send("ac-open-in-console", target),
  // 앱이 렌더링하는 링크 확장자 표. 등록표는 렌더러가 소유하고 main 은 복사본만 본다.
  // webview 안에서 누른 링크는 렌더러 이벤트로 오지 않아서 그쪽도 같은 표를 봐야 한다(setKeymap 과 같은 이유).
  setAppDrawnLinkExts: (list) => ipcRenderer.send("ac-app-drawn-link-exts", list),

  // 모바일 에뮬레이터. 스트림 함수는 Orca preload(emulator-bridge.ts)와 같은 이름·채널이다.
  // 해제 함수를 돌려준다. 탭을 닫거나 창을 옮길 때마다 구독이 쌓이면 프레임이 여러 번 그려진다.
  emulator: {
    rpc: (method, params) => ipcRenderer.invoke("ac-emulator-rpc", { method, params }),
    getSettings: () => ipcRenderer.invoke("ac-emulator-settings-get"),
    setSettings: (patch) => ipcRenderer.invoke("ac-emulator-settings-set", patch),
    pickSdkFolder: () => ipcRenderer.invoke("ac-emulator-pick-sdk"),
    androidAction: (action) => ipcRenderer.invoke("ac-emulator-android-action", action),
    xcodeAction: (action) => ipcRenderer.invoke("ac-emulator-xcode-action", action),
    startFrameStream: (args) => ipcRenderer.invoke("emulator:frameStreamStart", args),
    stopFrameStream: (args) => ipcRenderer.invoke("emulator:frameStreamStop", args),
    startVideoStream: (args) => ipcRenderer.invoke("emulator:videoStreamStart", args),
    stopVideoStream: (args) => ipcRenderer.invoke("emulator:videoStreamStop", args),
    onFrameStreamFrame: (cb) => subscribe("emulator:frameStreamFrame", cb),
    onFrameStreamError: (cb) => subscribe("emulator:frameStreamError", cb),
    onVideoStreamMeta: (cb) => subscribe("emulator:videoStreamMeta", cb),
    onVideoStreamFrame: (cb) => subscribe("emulator:videoStreamFrame", cb),
    onPaneFocus: (cb) => subscribe("emulator:pane-focus", cb),
    onAutoAttach: (cb) => subscribe("ui:emulatorAutoAttach", cb),
    openWindow: (args) => ipcRenderer.invoke("ac-emulator-window-open", args),
    closeWindow: (args) => ipcRenderer.invoke("ac-emulator-window-close", args),
    onWindowClosed: (cb) => subscribe("ac-emulator-window-closed", cb),
  },

  refocusConsole: () => ipcRenderer.send("ac-refocus-console"),
  appReload: () => ipcRenderer.send("ac-app-reload"),
  saveRecording: (text) => ipcRenderer.invoke("ac-save-recording", text),
});
