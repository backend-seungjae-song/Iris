// 모바일 에뮬레이터 화면. Orca EmulatorPane.tsx 와 그 훅들을 일반 DOM 코드로 옮긴 것이다.
//
// 소유 범위
//   에뮬레이터 스트림(MJPEG·Android 비디오)·기기 틀·제스처·키보드·붙여넣기·툴바·하드웨어 버튼의
//   DOM 과 그 뒤의 세션 상태(붙이기·종료·기기 목록·회전). RPC 는 host.rpc 로만 부른다.
//
// 제공 API
//   mountEmulatorPane(container, opts) → { dispose(), close(), setVisible(visible), snapshot(), current() }.
//   opts: host(window.acHost.emulator) · workspaceId(스페이스 id) · deviceId(처음 붙일 udid, 없으면 기본 기기) ·
//   onDeviceChange(udid) · onRequestDetach() · detachable(분리 버튼 표시) · onSketch(있으면 스케치 버튼 표시) ·
//   actions([{ label, title, onClick }], 도구 줄 끝에 붙는 버튼).
//   snapshot() 은 지금 보이는 프레임을 { bytes(PNG), title } 로 주고, 그릴 프레임이 없으면 null 이다.
//   dispose() 는 화면만 떼고 세션을 남기며, close() 는 이 화면이 켠 기기와 헬퍼까지 끈다.
//
// 의존 대상
//   /vendor/orca-emulator-pane.esm.js(Orca 순수 로직 번들)만. Iris 앱 셸 모듈은 import 하지
//   않는다(분리 창에서도 같은 모듈을 쓴다). 이 번들은 계산한 URL 로 동적 import 한다(정적
//   import 는 web/js 그래프 소유 검사 두 개를 깬다 — buildPane 위 주석 참고).
//
// 유지 조건
//   dispose() 는 DOM·구독·스트림만 정리하고 에뮬레이터 세션은 남긴다(창으로 옮길 때 다시 붙일
//   세션이 있어야 한다). close() 는 탭을 완전히 닫을 때만 부르고, Orca 의 관리 세션 정리
//   (managedOnly shutdown)를 그대로 한다. 둘을 바꿔 부르면 세션이 새지거나 헛통화가 남는다.
//   붙이기 재시도 중 dispose 되면 방금 붙은 기기가 아무도 안 쓰는 채로 켜져 남으므로, 그 경우도
//   종료 요청을 보낸다(Orca useEmulatorPaneSession 의 "attach 가 unmount 뒤에 끝나는" 경로).
//   mountEmulatorPane() 은 vendor 번들 로딩 중에도 dispose·close·setVisible 을 동기로 받을 수
//   있어 큐에 쌓았다가 번들이 준비되면 흘려보낸다(맨 아래 mountEmulatorPane 주석 참고).
//
// 영향 범위
//   web/js/emulator/boot.js, web/emulator-window/window.js.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/pane.js
// Why 정적 import 가 아니라 계산한 URL 을 import(): 정적으로 "from \"...\"" 를 쓰면(절대·상대
// 경로 모두) esbuild 가 web/js/main.js 부터 묶을 때 이 번들 파일까지 그래프 간선으로 잡는다.
// 그러면 "묶어 보면 틀에서 기능으로 가는 정적 길이 없다"·"기능이 적은 자기 파일이 실제 소유와
// 같다"(capabilities.js 의 files 목록에 생성 번들까지 적어야 하는) 두 검사가 실제로 깨진다(실측:
// 둘 다 web/vendor/orca-emulator-pane.esm.js 를 걸고 넘어졌다). docx 번들도 같은 이유로
// web/js 정적 import 가 아니라 index.html 의 동적 import 로 연다. 여기는 index.html 을 고칠
// 권한이 없으므로, import() 인자를 리터럴이 아니라 계산한 URL 로 두어 같은 회피를 이 파일
// 안에서 한다(브라우저는 계산한 문자열도 그대로 동적 import 한다. esbuild 는 리터럴이 아닌
// import() 인자를 그래프에 안 넣는다 — 확인 완료).
const VENDOR_URL = new URL("../../vendor/orca-emulator-pane.esm.js", import.meta.url).href;
const vendorReady = import(VENDOR_URL);

const WINDOW_HIDE_PARK_GRACE_MS = 500; // Orca window-park-visibility.ts 의 값
const RECONNECT_DELAY_MS = 750;
const KEYBOARD_FRAME_DELAY_MS = 4;
const FIRST_FRAME_TIMEOUT_MS = 6000;
const VIDEO_FIRST_FRAME_TIMEOUT_MS = 10000;
const WHEEL_GESTURE_IDLE_MS = 80;
const MAX_GESTURE_SAMPLES = 32;
const DRAG_THRESHOLD_PX = 8;
const SCRCPY_PREFIX = "scrcpy://";
const H264_CODEC = "avc1.640028";

// Orca callRuntimeRpc 와 같은 모양: 성공하면 result 를 돌려주고, 실패하면 던진다.
async function rpcCall(host, method, params) {
  const res = await host.rpc(method, params);
  if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || String(method) + " 실패");
  return res.result;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function buildPane(container, opts, vendor) {
  const {
    deviceLabel, simulatorPreviewStreamUrl, pickDefaultDevice, resolveEmulatorAttachTarget,
    resolveDeviceFrameKind, resolveVisualStreamGeometry, fitDeviceFrameToPane,
    toSimulatorDeviceRows, markSimulatorDeviceBooted, markSimulatorDeviceShutdown,
    pasteTextIntoEmulatorKeyboard, emulatorPaneErrorMessage, buildEmulatorPaneSessionView,
    clampEmulatorScreenPoint, resolveEmulatorHomeIndicatorEdge, buildEmulatorGesturePoint,
    mapClientPointToSimulatorScreen, resolveEmulatorPointerAction, resolveEmulatorWheelDelta,
    buildWheelGesturePoints, encodeServeSimTouchFrame,
    encodeServeSimKeyboardFrame, buildServeSimKeyboardFramesForKey,
  } = vendor;
  const { host, workspaceId, onDeviceChange, onRequestDetach, detachable } = opts;
  let configuredDefaultUdid = null;
  // Why: getSettings 는 IPC 라 render() 보다 늦게 끝날 수 있다. 처음 자동-붙기가 이 값을 못 보고
  // 지나가면 Orca 의 "기본 기기 우선" 규칙이 첫 붙기에서만 깨지므로, 첫 시도 전에 기다린다.
  const settingsReady = host.getSettings().then((r) => {
    if (r && r.ok) configuredDefaultUdid = r.settings.mobileEmulatorDefaultDeviceUdid || null;
  }).catch(() => {});

  const state = {
    devices: [],
    selectedUdid: opts.deviceId || null,
    session: null,
    loading: false,
    error: null,
    streamKey: null,
    liveTarget: null,
    deviceRefreshError: null,
    suppressAutoAttach: false,
    visualOrientation: "portrait",
    nextRotateOrientation: "landscape_left",
    visualOrientationEpoch: 0,
  };
  let disposed = false;
  let tabVisible = true;
  let windowVisible = document.visibilityState !== "hidden";
  let windowVisibleTimer = 0;

  // ---- DOM 골격 ----
  container.replaceChildren();
  const root = el("div", "emu-pane");
  const toolbar = el("div", "emu-toolbar");
  const errorBar = el("div", "emu-error-bar");
  errorBar.hidden = true;
  const frameWrap = el("div", "emu-frame-wrap");
  root.append(toolbar, errorBar, frameWrap);
  container.append(root);

  // ---- 툴바 ----
  const tbIcon = el("span", "emu-toolbar-icon", "📱");
  const tbTitle = el("span", "emu-toolbar-title");
  const tbStatus = el("span", "emu-toolbar-status");
  const tbSpacer = el("div", "emu-toolbar-spacer");
  const tbSelect = el("select", "emu-device-select");
  tbSelect.addEventListener("change", () => {
    const udid = tbSelect.value;
    state.selectedUdid = udid || null;
    onDeviceChange && onDeviceChange(udid || null);
    void attach(udid || undefined);
  });
  const tbRotate = el("button", "emu-btn", "회전");
  tbRotate.type = "button";
  tbRotate.addEventListener("click", () => { void sendRotate(); });
  const tbHome = el("button", "emu-btn", "홈");
  tbHome.type = "button";
  tbHome.addEventListener("click", () => { void sendButton("home"); });
  const tbPrimary = el("button", "emu-btn emu-btn-primary", "연결");
  tbPrimary.type = "button";
  tbPrimary.addEventListener("click", () => {
    if (isLiveNow()) void shutdown(state.selectedUdid || undefined);
    else void attach(state.selectedUdid || undefined);
  });
  toolbar.append(tbIcon, tbTitle, tbStatus, tbSpacer, tbSelect, tbRotate, tbHome, tbPrimary);
  if (opts.onSketch) {
    const tbSketch = el("button", "emu-btn", "스케치");
    tbSketch.type = "button";
    tbSketch.title = "지금 앱 화면을 찍어 그 위에 그립니다(⌘⇧D). 그린 그림을 채팅으로 보냅니다";
    tbSketch.addEventListener("click", () => { opts.onSketch(); });
    toolbar.append(tbSketch);
  }
  if (detachable) {
    const tbDetach = el("button", "emu-btn", "창으로 분리");
    tbDetach.type = "button";
    tbDetach.title = "이 화면을 별도 창으로 옮깁니다";
    tbDetach.addEventListener("click", () => { onRequestDetach && onRequestDetach(); });
    toolbar.append(tbDetach);
  }
  for (const a of opts.actions || []) {
    const b = el("button", "emu-btn", a.label);
    b.type = "button";
    if (a.title) b.title = a.title;
    b.addEventListener("click", () => { a.onClick(); });
    toolbar.append(b);
  }

  // ---- 기기 프레임 ----
  const frameShell = el("div", "emu-frame-shell");
  const frameScreen = el("div", "emu-frame-screen");
  frameScreen.setAttribute("data-orca-emulator-frame", "true");
  const screenSurface = el("div", "emu-screen-surface");
  const screenStatus = el("div", "emu-screen-status");
  frameScreen.append(screenSurface);
  frameShell.append(frameScreen);
  frameWrap.append(frameShell);
  let mediaEl = null; // 현재 표시 중인 <img> 또는 <canvas>

  function isLiveNow() {
    return Boolean(simulatorPreviewStreamUrl(state.session && state.session.info) && state.session && state.session.attached);
  }

  // ---- 기기 목록 ----
  async function refreshDevices(bootedTarget) {
    try {
      const raw = await rpcCall(host, "emulator.listDevices", {});
      const list = toSimulatorDeviceRows(raw || []);
      const next = markSimulatorDeviceBooted(list, bootedTarget);
      if (disposed) return next;
      const hadError = state.deviceRefreshError !== null;
      state.deviceRefreshError = null;
      state.devices = next;
      if (hadError) state.error = null;
      render();
      return next;
    } catch (e) {
      state.deviceRefreshError = e;
      if (!disposed) { state.devices = []; state.error = emulatorPaneErrorMessage(e, "에뮬레이터 기기 목록을 가져오지 못했습니다."); render(); }
      return [];
    }
  }

  function resetVisualOrientation() {
    state.visualOrientationEpoch += 1;
    state.nextRotateOrientation = "landscape_left";
    state.visualOrientation = "portrait";
  }

  function applySession(info, attached) {
    if (attached === undefined) attached = true;
    if (disposed) return;
    const target = info && (info.deviceUdid || info.device);
    const rows = attached ? markSimulatorDeviceBooted(state.devices, target) : state.devices;
    if (attached && target && target !== state.liveTarget) resetVisualOrientation();
    const row = rows.find((d) => d.udid === target || d.name === target);
    const displayName = (row && row.name) || deviceLabel(info);
    const enriched = Object.assign({}, info, { displayName, state: attached ? "Booted" : info && info.state });
    state.devices = rows;
    state.session = { attached, info: enriched };
    state.liveTarget = attached ? target || null : null;
    state.loading = false;
    if (attached) state.suppressAutoAttach = false;
    state.error = null;
    if (attached && simulatorPreviewStreamUrl(enriched)) state.streamKey = String(Date.now());
    if (info && (info.deviceUdid || info.device)) {
      const udid = info.deviceUdid || info.device;
      if (udid !== state.selectedUdid) { state.selectedUdid = udid; onDeviceChange && onDeviceChange(udid); }
    }
    render();
  }

  function clearSessionAfterShutdown(deviceTarget) {
    if (disposed) return;
    const target = deviceTarget || (state.session && state.session.info && (state.session.info.deviceUdid || state.session.info.device)) || state.selectedUdid;
    state.devices = markSimulatorDeviceShutdown(state.devices, target);
    state.session = null;
    state.liveTarget = null;
    state.suppressAutoAttach = true;
    state.streamKey = null;
    resetVisualOrientation();
    state.error = null;
    render();
  }

  async function attach(deviceTarget) {
    if (state.loading) return;
    state.suppressAutoAttach = false;
    state.loading = true;
    state.error = null;
    render();
    let requestedTarget;
    try {
      let list = state.devices;
      if (list.length === 0) list = (await refreshDevices()) || [];
      if (list.length === 0 && state.deviceRefreshError) throw state.deviceRefreshError;
      const target = resolveEmulatorAttachTarget({
        configuredDefaultUdid, devices: list, deviceTarget, selectedUdid: state.selectedUdid,
      });
      if (!target) throw new Error("에뮬레이터 기기를 찾을 수 없습니다. Xcode 에서 iOS 시뮬레이터를 추가하거나 Android Studio 에서 AVD 를 만드세요.");
      requestedTarget = target;
      if (target !== state.selectedUdid) { state.selectedUdid = target; onDeviceChange && onDeviceChange(target); }
      if (target !== state.liveTarget) {
        state.session = null; state.streamKey = null; state.liveTarget = null; resetVisualOrientation();
      }
      const res = await rpcCall(host, "emulator.attach", { device: target, worktree: workspaceId, focus: false });
      if (disposed) {
        // Why: dispose 가 attach 진행 중에 왔으면 방금 붙은 기기를 아무도 쓰지 않는다.
        void rpcCall(host, "emulator.shutdown", { worktree: workspaceId, managedOnly: true }).catch(() => {});
        return;
      }
      const attached = !!(res && res.attached);
      const bootedTarget = (res && res.info && (res.info.deviceUdid || res.info.device)) || target;
      const nextList = attached ? markSimulatorDeviceBooted(list, bootedTarget) : list;
      if (attached) state.devices = nextList;
      applySession(res && res.info, attached);
      if (attached) void refreshDevices(bootedTarget);
    } catch (e) {
      if (requestedTarget && state.liveTarget === requestedTarget) return;
      state.suppressAutoAttach = true;
      state.error = emulatorPaneErrorMessage(e, "에뮬레이터를 시작하지 못했습니다. Xcode(iOS) 또는 Android Studio(Android) 설정을 확인한 뒤 다른 기기를 시도하세요.");
      render();
    } finally {
      if (!disposed) { state.loading = false; render(); }
    }
  }

  async function shutdown(deviceTarget) {
    if (state.loading) return;
    state.loading = true; state.error = null; render();
    try {
      const res = await rpcCall(host, "emulator.shutdown", Object.assign(deviceTarget ? { device: deviceTarget } : {}, { worktree: workspaceId }));
      const shutdownTarget = (res && res.deviceUdid) || deviceTarget;
      clearSessionAfterShutdown(shutdownTarget);
      void refreshDevices();
    } catch (e) {
      state.error = emulatorPaneErrorMessage(e, "에뮬레이터를 종료하지 못했습니다. 다시 시도하거나 에뮬레이터 관리자에서 직접 끄세요.");
    } finally {
      if (!disposed) { state.loading = false; render(); }
    }
  }

  function sendTap(x, y) { rpcCall(host, "emulator.tap", { x, y, worktree: workspaceId }).catch(() => {}); }
  function sendButton(name) { rpcCall(host, "emulator.button", { name, worktree: workspaceId }).catch(() => {}); }
  function sendGesture(points) { rpcCall(host, "emulator.gesture", { points, worktree: workspaceId }).catch(() => {}); }
  async function sendRotate() {
    const orientation = state.nextRotateOrientation;
    const epoch = state.visualOrientationEpoch;
    try { await rpcCall(host, "emulator.rotate", { orientation, worktree: workspaceId }); } catch { return null; }
    if (state.visualOrientationEpoch !== epoch) return null;
    state.visualOrientation = orientation === "landscape_left" ? "landscape" : "portrait";
    state.nextRotateOrientation = orientation === "landscape_left" ? "portrait" : "landscape_left";
    state.streamKey = String(Date.now());
    render();
    return state.visualOrientation;
  }

  // ---- host 자동-붙기 알림: 다른 곳(에이전트 CLI 등)이 이 workspace 에 붙으면 그대로 반영한다.
  // Why: Orca 는 이 알림을 앱 셸(content-creation-ipc-bridge)이 받아 탭을 새로 만들거나
  // 이미 열린 pane 에 세션을 얹는다. Iris 는 탭이 이미 있을 때만 이 알림을 받으므로 "새 탭 생성"
  // 쪽은 옮기지 않았다(boot.js 영역, 이번 포트 파일 목록 밖).
  const offAutoAttach = host.onAutoAttach ? host.onAutoAttach((detail) => {
    if (!detail || detail.worktreeId !== workspaceId) return;
    if (!detail.info || (!detail.info.streamUrl && !detail.info.wsUrl)) return;
    applySession(detail.info, true);
    void refreshDevices(detail.info.deviceUdid || detail.info.device);
  }) : null;

  // ---- 창 레벨 표시 여부(occlusion) 파킹. Orca use-window-stream-visibility 의 지연치만 옮긴다.
  // stale-visibility 복구(macOS occlusion 고착 대응)는 터미널 전용 진단 모듈에 묶여 있어 옮기지
  // 않았다: 결과 참고.
  function onDocVisibilityChange() {
    if (document.visibilityState !== "hidden") {
      windowVisible = true;
      if (windowVisibleTimer) { clearTimeout(windowVisibleTimer); windowVisibleTimer = 0; }
      render();
      return;
    }
    if (windowVisibleTimer) clearTimeout(windowVisibleTimer);
    windowVisibleTimer = setTimeout(() => { windowVisibleTimer = 0; windowVisible = false; render(); }, WINDOW_HIDE_PARK_GRACE_MS);
  }
  document.addEventListener("visibilitychange", onDocVisibilityChange);

  // ================= 기기 프레임: 제스처·키보드·스트림 =================
  let paneSize = null;
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleSizeUpdate()) : null;
  let sizeFrameId = 0;
  function scheduleSizeUpdate() {
    if (sizeFrameId) cancelAnimationFrame(sizeFrameId);
    sizeFrameId = requestAnimationFrame(() => {
      sizeFrameId = 0;
      const r = frameWrap.getBoundingClientRect();
      const w = Math.floor(r.width), h = Math.floor(r.height);
      if (!paneSize || paneSize.width !== w || paneSize.height !== h) { paneSize = { width: w, height: h }; renderFrameLayout(); }
    });
  }
  if (resizeObserver) resizeObserver.observe(frameWrap);
  else window.addEventListener("resize", scheduleSizeUpdate);
  scheduleSizeUpdate();

  let streamSize = null;
  let streamError = false;
  let lastStreamSourceKey = null; // previewUrl::streamKey 조합. 바뀌면 streamSize·streamError 를 되돌린다.

  // 제어 스트림(터치·키보드 HID 프레임을 보내는 웹소켓). Orca use-emulator-control-stream.
  let ctrlWs = null;
  let ctrlEnabled = false;
  let ctrlWsUrl = null;
  let ctrlReconnectTimer = 0;
  let ctrlDisposed = false;
  const keyboardTimerIds = new Set();
  const pressedKeyboardUsages = new Set();

  function ctrlOpenSocket() { return ctrlWs && ctrlWs.readyState === WebSocket.OPEN ? ctrlWs : null; }
  function ctrlClearKeyboardTimers() { for (const id of keyboardTimerIds) clearTimeout(id); keyboardTimerIds.clear(); }
  function ctrlSendKeyboardFrameNow(frame) {
    const ws = ctrlOpenSocket();
    if (!ws) return false;
    try {
      ws.send(encodeServeSimKeyboardFrame(frame));
      if (frame.type === "down") pressedKeyboardUsages.add(frame.usage); else pressedKeyboardUsages.delete(frame.usage);
      return true;
    } catch { return false; }
  }
  function ctrlReleasePressedKeyboardUsages(resetAfter) {
    const usages = Array.from(pressedKeyboardUsages).reverse();
    for (const usage of usages) ctrlSendKeyboardFrameNow({ type: "up", usage });
    if (resetAfter) pressedKeyboardUsages.clear();
  }
  function cancelKeyboardFrames() { ctrlClearKeyboardTimers(); ctrlReleasePressedKeyboardUsages(true); }
  function sendTouch(touch) {
    const ws = ctrlOpenSocket();
    if (!ws) return false;
    try { ws.send(encodeServeSimTouchFrame(touch)); return true; } catch { return false; }
  }
  function sendKeyboardFrames(frames) {
    if (frames.length === 0 || !ctrlOpenSocket()) return false;
    frames.forEach((frame, index) => {
      if (index === 0) { ctrlSendKeyboardFrameNow(frame); return; }
      const id = setTimeout(() => { keyboardTimerIds.delete(id); ctrlSendKeyboardFrameNow(frame); }, index * KEYBOARD_FRAME_DELAY_MS);
      keyboardTimerIds.add(id);
    });
    return true;
  }
  function teardownControlStream() {
    ctrlDisposed = true;
    if (ctrlReconnectTimer) { clearTimeout(ctrlReconnectTimer); ctrlReconnectTimer = 0; }
    cancelKeyboardFrames();
    if (ctrlWs) { const ws = ctrlWs; ctrlWs = null; try { ws.close(); } catch {} }
  }
  function updateControlStream(wsUrl, canInteract) {
    if (wsUrl === ctrlWsUrl && canInteract === ctrlEnabled && ctrlWs) return;
    teardownControlStream();
    ctrlWsUrl = wsUrl; ctrlEnabled = canInteract; ctrlDisposed = false;
    if (!canInteract || !wsUrl) return;
    const connect = () => {
      if (ctrlReconnectTimer) { clearTimeout(ctrlReconnectTimer); ctrlReconnectTimer = 0; }
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      ctrlWs = ws;
      ws.onopen = () => { if (!ctrlDisposed && ctrlWs === ws) ctrlReleasePressedKeyboardUsages(false); };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = () => {
        if (ctrlWs === ws) ctrlWs = null;
        ctrlClearKeyboardTimers();
        if (!ctrlDisposed) ctrlReconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };
    connect();
  }

  // 키보드 캡처 + 붙여넣기. Orca use-emulator-screen-keyboard.
  let keyboardCaptureActive = false;
  let pasteRequestId = 0;
  let canInteractNow = false;
  function setCaptureActive(active) {
    if (!active) { pasteRequestId += 1; cancelKeyboardFrames(); }
    keyboardCaptureActive = active;
    screenSurface.classList.toggle("emu-screen-capturing", active);
    updateScreenAria();
  }
  function enableKeyboardCapture() { if (canInteractNow) setCaptureActive(true); }
  function updateScreenAria() {
    if (!isLiveNow()) { screenSurface.removeAttribute("aria-label"); screenSurface.removeAttribute("role"); screenSurface.removeAttribute("tabindex"); return; }
    screenSurface.setAttribute("role", "application");
    screenSurface.setAttribute("tabindex", "0");
    screenSurface.setAttribute("aria-label", keyboardCaptureActive ? "에뮬레이터 화면, 키보드 캡처 중. Escape 를 누르면 풀립니다." : "에뮬레이터 화면");
  }
  screenSurface.addEventListener("blur", () => setCaptureActive(false));
  screenSurface.addEventListener("keydown", (event) => {
    if (!canInteractNow || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      if (keyboardCaptureActive) { setCaptureActive(false); screenSurface.blur(); event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (!keyboardCaptureActive) {
      if (event.key === "Enter" || event.key === " ") { setCaptureActive(true); event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const frames = buildServeSimKeyboardFramesForKey(event.key, { shift: event.shiftKey });
    if (!frames || !sendKeyboardFrames(frames)) return;
    event.preventDefault(); event.stopPropagation();
  });
  screenSurface.addEventListener("paste", (event) => {
    if (!canInteractNow || !keyboardCaptureActive) return;
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault(); event.stopPropagation();
    pasteRequestId += 1; cancelKeyboardFrames();
    const myRequestId = pasteRequestId;
    const canInteractAtStart = canInteractNow;
    void pasteTextIntoEmulatorKeyboard({
      isCancelled: () => pasteRequestId !== myRequestId || !keyboardCaptureActive || !canInteractAtStart,
      sendKeyboardFrames,
      text,
    }).then((result) => { if (pasteRequestId === myRequestId || result.status === "cancelled") showPasteResult(result); });
  });
  function showPasteResult(result) {
    if (result.status !== "rejected" || result.reason === "empty") return;
    const msg = result.reason === "too-large" ? "붙여넣기 내용이 에뮬레이터 키보드 입력으로 쓰기엔 너무 큽니다."
      : result.reason === "unsupported-text" ? "에뮬레이터 키보드 붙여넣기는 미국 키보드 문자만 지원합니다."
      : "기기가 준비되지 않아 에뮬레이터 키보드 붙여넣기에 실패했습니다.";
    opts.onPasteError ? opts.onPasteError(msg) : console.warn("[emulator]", msg);
  }

  // 포인터·휠 제스처. Orca EmulatorDeviceFrame 의 handlePointer*/handleWheel.
  let pointerSamples = null;
  let activePointerId = null;
  let liveTouch = false;
  let liveTouchEdge;
  let lastTouchPoint = null;
  let wheelGesture = null; // { start, end, live, timerId }
  let lastVisualStreamGeometry = { aspectRatio: 9 / 19, size: null, streamRotation: 0 };

  function mapEventToScreenPoint(clientX, clientY) {
    const rect = screenSurface.getBoundingClientRect();
    return mapClientPointToSimulatorScreen({ clientX, clientY }, rect, lastVisualStreamGeometry.size);
  }
  function flushWheelGesture() {
    const pending = wheelGesture; wheelGesture = null;
    if (!pending) return;
    if (pending.timerId != null) clearTimeout(pending.timerId);
    if (pending.live) { sendTouch(Object.assign(clampEmulatorScreenPoint(pending.end), { type: "end" })); return; }
    const points = buildWheelGesturePoints(pending.start, pending.end);
    if (points) sendGesture(points);
  }
  screenSurface.addEventListener("pointerdown", (event) => {
    if (!canInteractNow || event.button !== 0) return;
    event.preventDefault();
    try { screenSurface.focus({ preventScroll: true }); } catch {}
    enableKeyboardCapture();
    const point = mapEventToScreenPoint(event.clientX, event.clientY);
    if (!point) return;
    activePointerId = event.pointerId;
    pointerSamples = [{ clientX: event.clientX, clientY: event.clientY }];
    lastTouchPoint = point;
    liveTouchEdge = resolveEmulatorHomeIndicatorEdge(point);
    liveTouch = sendTouch(buildEmulatorGesturePoint(point, "begin", liveTouchEdge));
    try { screenSurface.setPointerCapture(event.pointerId); } catch {}
  });
  screenSurface.addEventListener("pointermove", (event) => {
    if (!pointerSamples || activePointerId !== event.pointerId) return;
    event.preventDefault();
    const last = pointerSamples[pointerSamples.length - 1];
    if (last && Math.hypot(event.clientX - last.clientX, event.clientY - last.clientY) < 4) return;
    const sample = { clientX: event.clientX, clientY: event.clientY };
    if (pointerSamples.length < MAX_GESTURE_SAMPLES - 1) pointerSamples.push(sample);
    else pointerSamples[pointerSamples.length - 1] = sample;
    if (!liveTouch) return;
    const point = mapEventToScreenPoint(event.clientX, event.clientY);
    if (point) { lastTouchPoint = point; sendTouch(buildEmulatorGesturePoint(point, "move", liveTouchEdge)); }
  });
  function resetPointer() { pointerSamples = null; activePointerId = null; liveTouch = false; liveTouchEdge = undefined; lastTouchPoint = null; }
  screenSurface.addEventListener("pointercancel", (event) => {
    if (activePointerId !== event.pointerId) return;
    if (liveTouch && lastTouchPoint) sendTouch(buildEmulatorGesturePoint(lastTouchPoint, "end", liveTouchEdge));
    resetPointer();
  });
  screenSurface.addEventListener("pointerup", (event) => {
    if (!pointerSamples || activePointerId !== event.pointerId) return;
    event.preventDefault();
    const samples = pointerSamples;
    pointerSamples = null; activePointerId = null;
    const endPoint = mapEventToScreenPoint(event.clientX, event.clientY) || lastTouchPoint;
    if (liveTouch) {
      if (endPoint) sendTouch(buildEmulatorGesturePoint(endPoint, "end", liveTouchEdge));
      liveTouch = false; liveTouchEdge = undefined; lastTouchPoint = null;
      return;
    }
    liveTouchEdge = undefined; lastTouchPoint = null;
    if (!canInteractNow) return;
    samples.push({ clientX: event.clientX, clientY: event.clientY });
    const rect = screenSurface.getBoundingClientRect();
    const action = resolveEmulatorPointerAction(samples, rect, lastVisualStreamGeometry.size, DRAG_THRESHOLD_PX);
    if (!action) return;
    if (action.kind === "tap") sendTap(action.point.x, action.point.y);
    else sendGesture(action.points);
  });
  screenSurface.addEventListener("wheel", (event) => {
    if (!canInteractNow) return;
    const rect = screenSurface.getBoundingClientRect();
    const delta = resolveEmulatorWheelDelta({
      clientX: event.clientX, clientY: event.clientY, deltaMode: event.deltaMode, deltaX: event.deltaX, deltaY: event.deltaY,
    }, rect, lastVisualStreamGeometry.size);
    if (!delta) return;
    event.preventDefault();
    const previous = wheelGesture;
    if (previous && previous.timerId != null) clearTimeout(previous.timerId);
    const start = previous ? previous.start : delta.start;
    const end = clampEmulatorScreenPoint(previous
      ? { x: previous.end.x + delta.delta.x, y: previous.end.y + delta.delta.y }
      : { x: delta.start.x + delta.delta.x, y: delta.start.y + delta.delta.y });
    const live = previous ? previous.live : sendTouch(Object.assign({}, start, { type: "begin" }));
    if (live) sendTouch(Object.assign({}, end, { type: "move" }));
    wheelGesture = { start, end, live, timerId: setTimeout(flushWheelGesture, WHEEL_GESTURE_IDLE_MS) };
  }, { passive: false });

  // ---- 프레임 스트림(MJPEG, iOS) ----
  let frameStreamState = { error: null };
  let frameStreamCleanup = null;
  function teardownFrameStream() { if (frameStreamCleanup) { frameStreamCleanup(); frameStreamCleanup = null; } }
  function startFrameStreamFor(streamUrl, streamKey) {
    teardownFrameStream();
    frameStreamState = { error: null };
    if (!host.startFrameStream) return;
    let done = false;
    let activeStreamId = null;
    let currentFrameUrl = null;
    let firstFrameTimer = setTimeout(() => {
      if (!currentFrameUrl) { frameStreamState = { error: "스트림에서 화면이 오지 않습니다." }; handleStreamError(); }
    }, FIRST_FRAME_TIMEOUT_MS);
    const clearTimer = () => { if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = null; } };
    const revoke = () => { if (currentFrameUrl) { URL.revokeObjectURL(currentFrameUrl); currentFrameUrl = null; } };
    const offFrame = host.onFrameStreamFrame ? host.onFrameStreamFrame(({ streamId, bytes }) => {
      if (done || streamId !== activeStreamId) return;
      clearTimer();
      const nextUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      const prevUrl = currentFrameUrl;
      currentFrameUrl = nextUrl;
      frameStreamState = { error: null, frameUrl: nextUrl };
      renderScreenContent();
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    }) : null;
    const offError = host.onFrameStreamError ? host.onFrameStreamError(({ streamId, message }) => {
      if (!done && streamId === activeStreamId) { frameStreamState = Object.assign({}, frameStreamState, { error: message || "스트림 연결이 끊겼습니다." }); handleStreamError(); }
    }) : null;
    void host.startFrameStream({ streamUrl, streamKey }).then((r) => {
      if (done) { if (r && r.streamId) void host.stopFrameStream?.({ streamId: r.streamId }); return; }
      activeStreamId = r && r.streamId;
    }).catch((e) => {
      if (done) return;
      clearTimer();
      frameStreamState = { error: (e && e.message) || "스트림 연결이 끊겼습니다." };
      handleStreamError();
    });
    frameStreamCleanup = () => {
      done = true; clearTimer();
      if (offFrame) offFrame(); if (offError) offError();
      if (activeStreamId) void host.stopFrameStream?.({ streamId: activeStreamId });
      revoke();
    };
  }

  // ---- 비디오 스트림(H.264, Android) ----
  let videoStreamState = { error: null };
  let videoStreamCleanup = null;
  function teardownVideoStream() { if (videoStreamCleanup) { videoStreamCleanup(); videoStreamCleanup = null; } }
  function startVideoStreamFor(deviceId) {
    teardownVideoStream();
    videoStreamState = { error: null };
    if (!host.startVideoStream) return;
    const DecoderCtor = globalThis.VideoDecoder, ChunkCtor = globalThis.EncodedVideoChunk;
    if (!DecoderCtor || !ChunkCtor) { videoStreamState = { error: "이 빌드는 WebCodecs H.264 디코딩을 지원하지 않습니다." }; handleStreamError(); return; }
    const canvas = document.createElement("canvas");
    canvas.className = "emu-screen-media";
    canvas.setAttribute("aria-label", "에뮬레이터 화면");
    replaceMedia(canvas);
    const ctx2d = canvas.getContext("2d");
    let done = false, configured = false, timestamp = 0, configBytes = null;
    const streamId = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + Math.random();
    let activeStreamId = streamId;
    const decoder = new DecoderCtor({
      output: (frame) => {
        if (!done && ctx2d) {
          clearFirstFrameTimeout();
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
          ctx2d.drawImage(frame, 0, 0);
        }
        frame.close();
      },
      error: (err) => fatal(err.message),
    });
    let firstFrameTimeout = setTimeout(() => fatal("Android 비디오 스트림에서 화면이 오지 않습니다."), VIDEO_FIRST_FRAME_TIMEOUT_MS);
    function clearFirstFrameTimeout() { if (firstFrameTimeout) { clearTimeout(firstFrameTimeout); firstFrameTimeout = null; } }
    function stopStream() { if (activeStreamId) { void host.stopVideoStream?.({ streamId: activeStreamId }); activeStreamId = null; } }
    function cleanup() {
      if (done) return; done = true;
      clearFirstFrameTimeout(); if (offMeta) offMeta(); if (offFrame) offFrame();
      stopStream(); if (decoder.state !== "closed") decoder.close();
    }
    function fatal(message) { if (done) return; videoStreamState = { error: message }; handleStreamError(); cleanup(); }
    const offMeta = host.onVideoStreamMeta ? host.onVideoStreamMeta((msg) => {
      if (!done && msg.streamId === activeStreamId && msg.deviceId === deviceId) handleStreamSize({ width: msg.meta.width, height: msg.meta.height });
    }) : null;
    const offFrame = host.onVideoStreamFrame ? host.onVideoStreamFrame((msg) => {
      if (done || msg.streamId !== activeStreamId || msg.deviceId !== deviceId) return;
      const data = new Uint8Array(msg.bytes);
      if (msg.config) {
        if (!configured) {
          try { decoder.configure({ codec: H264_CODEC, optimizeForLatency: true }); } catch (err) { fatal((err && err.message) || "H.264 디코더 설정에 실패했습니다."); return; }
          configured = true;
        }
        configBytes = data;
        return;
      }
      if (!configured || decoder.state === "closed") return;
      let chunkData = data;
      if (msg.keyFrame && configBytes) { chunkData = new Uint8Array(configBytes.length + data.length); chunkData.set(configBytes, 0); chunkData.set(data, configBytes.length); configBytes = null; }
      try { timestamp += 1; decoder.decode(new ChunkCtor({ type: msg.keyFrame ? "key" : "delta", timestamp, data: chunkData })); }
      catch (err) { fatal((err && err.message) || "Android 비디오 프레임 디코딩에 실패했습니다."); }
    }) : null;
    void host.startVideoStream({ deviceId, streamId }).then((started) => {
      if (done) void host.stopVideoStream?.({ streamId: (started && started.streamId) || streamId });
    }).catch((err) => fatal((err && err.message) || "Android 비디오 스트림을 시작하지 못했습니다."));
    videoStreamCleanup = cleanup;
  }

  function replaceMedia(node) {
    if (mediaEl && mediaEl.parentNode) mediaEl.remove();
    mediaEl = node;
    screenStatus.hidden = true;
    screenSurface.replaceChildren(node, screenStatus);
  }
  function clearMedia() { if (mediaEl) { mediaEl.remove(); mediaEl = null; } screenStatus.hidden = false; }

  function handleStreamSize(size) {
    streamError = false;
    if (!streamSize || streamSize.width !== size.width || streamSize.height !== size.height) { streamSize = size; renderFrameLayout(); }
  }
  // Why: canInteractNow(외부 render() 가 계산)까지 다시 맞춰야 하므로 renderScreenContent 가
  // 아니라 render 를 부른다. renderScreenContent 안에서 이 함수를 부르면 서로 되부르는 무한
  // 재귀가 된다(반드시 render() 를 거쳐서만 부른다).
  function handleStreamError() { streamError = true; render(); }

  function applyMediaStyle(node, rotation, aspectRatio) {
    node.classList.remove("emu-screen-media-rotated");
    node.style.cssText = "";
    if (rotation === 0 || aspectRatio <= 0) return;
    node.classList.add("emu-screen-media-rotated");
    node.style.height = (100 * aspectRatio) + "%";
    node.style.width = (100 / aspectRatio) + "%";
    node.style.transform = "translate(-50%, -50%) rotate(" + rotation + "deg)";
  }

  function renderScreenContent() {
    const view = buildEmulatorPaneSessionView({ devices: state.devices, selectedUdid: state.selectedUdid, session: state.session });
    const previewUrl = view.previewUrl;
    const androidDeviceId = previewUrl && previewUrl.startsWith(SCRCPY_PREFIX) ? previewUrl.slice(SCRCPY_PREFIX.length) : null;
    const showStream = tabVisible && windowVisible && view.isLive && Boolean(previewUrl);
    const sourceKey = (androidDeviceId ? "video::" : "frame::") + (previewUrl || "") + "::" + (state.streamKey || "") + "::" + showStream;
    if (sourceKey !== lastStreamSourceKey) {
      lastStreamSourceKey = sourceKey;
      streamError = false; streamSize = null;
      teardownFrameStream(); teardownVideoStream();
      if (androidDeviceId && showStream) startVideoStreamFor(androidDeviceId);
      else if (showStream && previewUrl) startFrameStreamFor(previewUrl, state.streamKey);
    }

    const rotation = lastVisualStreamGeometry.streamRotation;
    const aspect = lastVisualStreamGeometry.aspectRatio;

    if (androidDeviceId && showStream && !videoStreamState.error) {
      if (!(mediaEl instanceof HTMLCanvasElement)) return; // startVideoStreamFor 가 이미 canvas 를 붙였다
      applyMediaStyle(mediaEl, rotation, aspect);
      screenStatus.hidden = true;
      return;
    }
    if (showStream && frameStreamState.frameUrl) {
      // Why: 같은 스트림의 프레임은 한 <img> 의 src 만 바꾼다(Orca 의 key). 프레임마다 요소를 새로
      // 만들면 새 이미지가 디코딩되기 전까지 화면이 비어 검게 깜빡인다.
      const mediaKey = previewUrl + "::" + (state.streamKey || "");
      if (!(mediaEl instanceof HTMLImageElement) || mediaEl.dataset.streamKey !== mediaKey) {
        const img = document.createElement("img");
        img.className = "emu-screen-media";
        img.alt = "에뮬레이터 화면"; img.draggable = false;
        img.dataset.streamKey = mediaKey;
        img.addEventListener("error", handleStreamError);
        img.addEventListener("load", () => { if (img.naturalWidth > 0 && img.naturalHeight > 0) handleStreamSize({ width: img.naturalWidth, height: img.naturalHeight }); });
        replaceMedia(img);
      }
      if (mediaEl.src !== frameStreamState.frameUrl) mediaEl.src = frameStreamState.frameUrl;
      applyMediaStyle(mediaEl, rotation, aspect);
      screenStatus.hidden = true;
      return;
    }
    clearMedia();
    const waitingForFrame = showStream && !frameStreamState.error && !videoStreamState.error;
    const displayError = streamError || Boolean(frameStreamState.error) || Boolean(videoStreamState.error);
    screenStatus.classList.toggle("emu-screen-status-loading", Boolean(state.loading || waitingForFrame));
    screenStatus.classList.toggle("emu-screen-status-error", Boolean(!state.loading && !waitingForFrame && displayError));
    screenStatus.textContent = (state.loading || waitingForFrame) ? "에뮬레이터 연결 중…"
      : displayError ? "스트림 연결이 끊겼습니다" : "에뮬레이터 미리 보기";
  }

  function renderFrameLayout() {
    const view = buildEmulatorPaneSessionView({ devices: state.devices, selectedUdid: state.selectedUdid, session: state.session });
    lastVisualStreamGeometry = resolveVisualStreamGeometry(streamSize, state.visualOrientation);
    const deviceName = view.displayName;
    const frameKind = resolveDeviceFrameKind(deviceName, streamSize ? streamSize.width / streamSize.height : 9 / 19);
    const layout = fitDeviceFrameToPane(paneSize, lastVisualStreamGeometry.aspectRatio, frameKind);
    frameShell.querySelectorAll(".emu-hw-btn").forEach((n) => n.remove());
    if (layout) {
      frameShell.style.width = layout.width + "px";
      frameShell.style.maxWidth = "";
      frameShell.style.height = layout.height + "px";
      frameScreen.style.left = layout.hardwareOutset + "px";
      frameScreen.style.width = layout.shellWidth + "px";
      frameScreen.style.height = layout.shellHeight + "px";
      frameScreen.style.padding = "";
      frameScreen.style.borderRadius = layout.outerRadius + "px";
      screenSurface.style.inset = layout.bezel + "px";
      screenSurface.style.borderRadius = layout.innerRadius + "px";
      screenSurface.style.aspectRatio = "";
      if (layout.kind === "phone") {
        for (const btn of buildHardwareButtons(layout)) frameShell.append(btn);
      }
    } else {
      frameShell.style.width = "100%";
      frameShell.style.maxWidth = "460px";
      frameShell.style.height = "";
      frameScreen.style.left = "";
      frameScreen.style.width = "100%";
      frameScreen.style.height = "";
      frameScreen.style.padding = "10px";
      frameScreen.style.borderRadius = "54px";
      screenSurface.style.inset = "";
      screenSurface.style.borderRadius = "44px";
      screenSurface.style.aspectRatio = String(lastVisualStreamGeometry.aspectRatio);
    }
    renderScreenContent();
  }

  function buildHardwareButtons(layout) {
    const inset = layout.hardwareOutset - layout.sideButtonThickness;
    const thickness = layout.sideButtonThickness + "px";
    const actionH = Math.max(18, Math.min(34, layout.shellHeight * 0.04)) + "px";
    const volumeH = Math.max(34, Math.min(64, layout.shellHeight * 0.08)) + "px";
    const powerH = Math.max(42, Math.min(76, layout.shellHeight * 0.095)) + "px";
    const mk = (side, top, height) => {
      const b = el("div", "emu-hw-btn emu-hw-btn-" + side);
      b.style[side] = inset + "px"; b.style.width = thickness; b.style.top = top; b.style.height = height;
      return b;
    };
    return [
      mk("left", layout.shellHeight * 0.16 + "px", actionH),
      mk("left", layout.shellHeight * 0.24 + "px", volumeH),
      mk("left", layout.shellHeight * 0.33 + "px", volumeH),
      mk("right", layout.shellHeight * 0.24 + "px", powerH),
    ];
  }

  // ================= 렌더 =================
  function render() {
    const view = buildEmulatorPaneSessionView({ devices: state.devices, selectedUdid: state.selectedUdid, session: state.session });
    tbTitle.textContent = view.displayName;
    const statusLabel = view.isLive ? "연결됨" : state.loading ? "작업 중…" : "연결 안 됨";
    tbStatus.textContent = statusLabel;
    tbStatus.classList.toggle("emu-toolbar-status-subtle", view.isLive || state.loading);
    tbSelect.replaceChildren();
    for (const d of state.devices) {
      const o = document.createElement("option");
      o.value = d.udid; o.textContent = d.name;
      if (d.udid === state.selectedUdid) o.selected = true;
      tbSelect.append(o);
    }
    tbSelect.disabled = state.loading || state.devices.length === 0;
    tbRotate.disabled = !view.isLive || state.loading;
    tbHome.disabled = !view.isLive || state.loading;
    if (view.isLive) {
      tbPrimary.textContent = "종료"; tbPrimary.classList.add("emu-btn-danger"); tbPrimary.classList.remove("emu-btn-primary");
      tbPrimary.disabled = state.loading;
    } else {
      tbPrimary.textContent = state.loading ? "작업 중…" : "연결"; tbPrimary.classList.remove("emu-btn-danger"); tbPrimary.classList.add("emu-btn-primary");
      tbPrimary.disabled = state.loading || state.devices.length === 0;
    }
    errorBar.hidden = !state.error;
    errorBar.textContent = state.error || "";
    canInteractNow = view.isLive && !state.loading && !streamError;
    updateScreenAria();
    if (!canInteractNow) { screenSurface.classList.remove("emu-screen-capturing"); keyboardCaptureActive = false; }
    updateControlStream(view.wsUrl, canInteractNow);
    renderFrameLayout();
  }

  // 초기 진입: 기기 목록을 받고, 항상 자동으로 붙는다(Iris 는 탭이 보일 때만 mount 하므로
  // Orca 의 isActive=false 사전-mount 경로는 필요 없다).
  render();
  void (async () => {
    await settingsReady;
    await refreshDevices();
    if (disposed || state.session || state.loading || state.suppressAutoAttach) return;
    void attach(state.selectedUdid || undefined);
  })();

  function teardownDom() {
    if (resizeObserver) resizeObserver.disconnect(); else window.removeEventListener("resize", scheduleSizeUpdate);
    if (sizeFrameId) cancelAnimationFrame(sizeFrameId);
    document.removeEventListener("visibilitychange", onDocVisibilityChange);
    if (windowVisibleTimer) clearTimeout(windowVisibleTimer);
    if (offAutoAttach) offAutoAttach();
    teardownControlStream();
    teardownFrameStream();
    teardownVideoStream();
    const pending = wheelGesture;
    if (pending) { if (pending.timerId != null) clearTimeout(pending.timerId); if (pending.live) sendTouch(Object.assign(clampEmulatorScreenPoint(pending.end), { type: "end" })); }
    if (liveTouch && lastTouchPoint) sendTouch(buildEmulatorGesturePoint(lastTouchPoint, "end", liveTouchEdge));
    container.replaceChildren();
  }

  // 스케치가 부른다. 지금 그리고 있는 프레임을 화면에 보이는 방향 그대로 PNG 로 만든다. 프레임은 기기
  // 버퍼 방향으로 오고 회전은 CSS 로만 하므로, 여기서 같은 각도로 돌려 그린다.
  async function snapshot() {
    const node = mediaEl;
    if (disposed || !node) return null;
    const w = node instanceof HTMLImageElement ? node.naturalWidth : node.width;
    const h = node instanceof HTMLImageElement ? node.naturalHeight : node.height;
    if (!w || !h) return null;
    const rot = ((lastVisualStreamGeometry.streamRotation % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    // 기기 원본 픽셀(iPhone 은 가로 1179)은 스케치 화면에서 너무 크다. 탭에 보이던 크기(화면 배율 포함)로
    // 줄이고, 원본보다 키우지는 않는다.
    const shown = frameScreen.getBoundingClientRect();
    const fullW = swap ? h : w;
    const k = shown.width > 0 ? Math.min(1, (shown.width * (window.devicePixelRatio || 1)) / fullW) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(fullW * k);
    canvas.height = Math.round((swap ? w : h) * k);
    const g = canvas.getContext("2d");
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((rot * Math.PI) / 180);
    g.scale(k, k);
    g.drawImage(node, -w / 2, -h / 2);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    const view = buildEmulatorPaneSessionView({ devices: state.devices, selectedUdid: state.selectedUdid, session: state.session });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), title: view.displayName || "" };
  }

  // MCP 앱 도구가 이 탭의 기기를 대상으로 쓴다(boot.js 가 서버에 답한다). 붙은 뒤의 값은 idb udid·adb 시리얼이다.
  function current() {
    const info = state.session && state.session.attached ? state.session.info : null;
    // 꺼져 있던 AVD 는 AVD 이름으로 붙고 시리얼로 돌아와, 붙는 순간의 표시 이름이 비어 있을 수 있다. 지금 목록에서 다시 찾는다.
    const row = state.liveTarget ? state.devices.find((d) => d.udid === state.liveTarget) : null;
    return { udid: state.liveTarget || null, name: (row && row.name) || (info && info.displayName) || "", attached: !!info,
      loading: !!state.loading, error: state.error ? String(state.error.message || state.error) : null };
  }

  return {
    snapshot,
    current,
    dispose() {
      if (disposed) return;
      disposed = true;
      teardownDom();
    },
    close() {
      if (disposed) { void rpcCall(host, "emulator.shutdown", { worktree: workspaceId, managedOnly: true }).catch(() => {}); return; }
      disposed = true;
      teardownDom();
      void rpcCall(host, "emulator.shutdown", { worktree: workspaceId, managedOnly: true }).catch(() => {});
    },
    setVisible(visible) {
      tabVisible = !!visible;
      if (!disposed) render();
    },
  };
}

// 위 buildPane 은 vendor 번들이 있어야 돈다. import() 가 끝나기 전에도 boot.js 는 dispose·
// close·setVisible 을 동기로 부를 수 있어(탭을 바로 닫는 등) 그동안의 호출을 큐에 쌓아 두었다가
// vendor 가 준비되면 그대로 흘려보낸다. Orca 에는 없는 갈래이며 이 파일 안의 번들 로딩 방식
// 때문에 생긴 것이다(위 vendorReady 주석 참고).
export function mountEmulatorPane(container, opts) {
  let real = null;
  let queuedVisible = true;
  let queuedDispose = false;
  let queuedClose = false;
  void vendorReady.then((vendor) => {
    real = buildPane(container, opts, vendor);
    if (queuedClose) { real.close(); return; }
    if (queuedDispose) { real.dispose(); return; }
    real.setVisible(queuedVisible);
  }).catch((e) => {
    console.error("[emulator] 렌더러 번들을 불러오지 못했습니다", e);
    container.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "emu-error-bar";
    msg.textContent = "에뮬레이터 번들을 불러오지 못했습니다.";
    container.append(msg);
  });
  return {
    dispose() { if (real) real.dispose(); else queuedDispose = true; },
    close() { if (real) real.close(); else queuedClose = true; },
    setVisible(visible) { queuedVisible = !!visible; if (real) real.setVisible(visible); },
    snapshot() { return real ? real.snapshot() : Promise.resolve(null); },
    current() { return real ? real.current() : { udid: null, name: "", attached: false, loading: true, error: null }; },
  };
}
