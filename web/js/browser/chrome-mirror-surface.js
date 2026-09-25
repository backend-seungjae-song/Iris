// webview를 전용 Chrome 또는 사용자가 동의한 현재 Chrome의 frame/input 표면으로 바꾸는 capability.
// URL 판정, surface와 mirror 수명, 좌표 변환은 이 파일이 소유하고 shell은 훅 이름만 부른다.
//
// 소유 범위
//   사용자 지정 host 라우팅, 탭별 mirror surface/native 수명, frame 표시와 입력 변환.
// 제공 API
//   initCapability(ctx), URL/좌표 순수 판정, mirror.navigation·mirror.activeTab·mirror.tabUrl 훅.
// 의존 대상
//   core/hooks의 이름 연결, capability ctx의 acHost/$/showToast/getWebviewEntries, wv-stack DOM. acHost 가 없으면 미지원.
// 유지 조건
//   자동으로 webview를 가로채지 않고, 사람이 고른 host 밖으로 mirror를 넓히지 않으며,
//   내부 about:blank park를 사용자 navigation으로 저장하지 않는다.
//   frame 좌표는 PoC의 object-fit:contain 변환을 유지하고 입력 문자열이나 자격증명을 로그하지 않는다.
// 영향 범위
//   native preload/chrome-mirror/live-chrome IPC, browser/webview-factory·dock 훅, 27-chrome-mirror.css.

import { provide } from "../core/hooks.js";

const mirrorsByTab = new Map();
const tabsByMirror = new Map();
const stopByTab = new Map();
const restoringTabs = new Map();
const KEY_PREVENT_DEFAULT = new Set([
  "Enter", "Backspace", "Tab", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
]);
const LIVE_SETTINGS_URL = "chrome://inspect/#remote-debugging";

let host = null;
let select = null;
let showToast = () => {};
let getWebviewEntries = () => [];
let updateWebviewMeta = () => {};

export function isClaudeMirrorUrl(value) {
  // 미러 폐기: 순정 Electron 웹뷰가 claude.ai Cloudflare를 스스로 통과함을 확인했다
  // (독립 하네스 3/3, browser-hardening.cjs 지문 위장으로 충분). 미러(진짜 headful Chrome)는
  // 창 노출 문제만 남기고 불필요하다. claude.ai 를 미러로 가로채지 않고 순정 웹뷰로 연다.
  return false;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function liveCommandForInput(value = {}) {
  const event = value && typeof value === "object" ? value : {};
  if (event.kind === "navigation") {
    if (event.command === "back") return { command: "Navigation.back", args: {} };
    if (event.command === "forward") return { command: "Navigation.forward", args: {} };
    if (event.command === "reload" || event.command === "forceReload") {
      return { command: "Page.reload", args: { ignoreCache: event.command === "forceReload" } };
    }
    return null;
  }
  if (event.kind === "text" && typeof event.text === "string" && event.text) {
    return { command: "Input.insertText", args: { text: event.text } };
  }
  if (event.kind === "wheel" || (event.kind === "mouse" && event.type === "wheel")) {
    return { command: "Input.dispatchMouseEvent", args: {
      type: "mouseWheel", x: finite(event.x), y: finite(event.y),
      deltaX: finite(event.deltaX), deltaY: finite(event.deltaY), modifiers: finite(event.modifiers),
    } };
  }
  if (event.kind === "mouse") {
    const types = { move: "mouseMoved", press: "mousePressed", release: "mouseReleased" };
    const type = types[event.type];
    if (!type) return null;
    return { command: "Input.dispatchMouseEvent", args: {
      type, x: finite(event.x), y: finite(event.y), button: String(event.button || "none"),
      buttons: finite(event.buttons), clickCount: finite(event.clickCount), modifiers: finite(event.modifiers),
    } };
  }
  if (event.kind === "key") {
    if (!["keyDown", "keyUp", "rawKeyDown", "char"].includes(event.type)) return null;
    const keyCode = Math.max(0, Math.min(255, Math.round(finite(event.keyCode))));
    return { command: "Input.dispatchKeyEvent", args: {
      type: event.type, key: String(event.key || "").slice(0, 64), code: String(event.code || "").slice(0, 64),
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: finite(event.modifiers),
    } };
  }
  return null;
}

export function acceptsUrl(state, value) {
  const url = httpUrl(value);
  if (!state || !url) return false;
  if (state.transport === "live") return true;
  return state.mode === "claude" ? url.origin === "https://claude.ai" : url.host === state.manualHost;
}

function sameViewport(a, b) {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

function surfaceViewport(surface, useParentFallback = false) {
  const rect = surface && surface.getBoundingClientRect ? surface.getBoundingClientRect() : null;
  const parent = surface && surface.parentElement && surface.parentElement.getBoundingClientRect
    ? surface.parentElement.getBoundingClientRect() : null;
  const width = Math.round((rect && rect.width) || (useParentFallback && parent && parent.width) || 0);
  const height = Math.round((rect && rect.height) || (useParentFallback && parent && parent.height) || 0);
  if (width <= 0 || height <= 0) return null;
  // Slice 1의 viewport 보정과 같은 범위를 써야 frame 크기와 입력 좌표계가 갈리지 않는다.
  return {
    width: Math.max(320, Math.min(3840, width)),
    height: Math.max(240, Math.min(2160, height)),
  };
}

// PoC의 object-fit:contain 매핑. 표시 영역의 letterbox를 뺀 뒤 backend viewport로 환산한다.
export function toBackend(event, surface, viewport) {
  const rect = surface.getBoundingClientRect();
  const frameWidth = viewport.width;
  const frameHeight = viewport.height;
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const displayWidth = frameWidth * scale;
  const displayHeight = frameHeight * scale;
  const padX = (rect.width - displayWidth) / 2;
  const padY = (rect.height - displayHeight) / 2;
  const x = (event.clientX - rect.left - padX) / scale;
  const y = (event.clientY - rect.top - padY) / scale;
  if (x < 0 || y < 0 || x >= frameWidth || y >= frameHeight) return null;
  return { x, y };
}

function modifierBits(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
    | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function mouseButton(button) {
  return ["left", "middle", "right", "back", "forward"][button] || "none";
}

function sendInput(state, event) {
  if (!state || state.closed || !state.mirrorId || !host) return;
  if (state.transport === "live") {
    const message = liveCommandForInput(event);
    if (!message || !host.liveChromeCommand || state.nativeMode) return;
    void Promise.resolve(host.liveChromeCommand({ id: state.mirrorId, ...message })).catch(() => {});
    return;
  }
  if (!host.mirrorInput) return;
  void Promise.resolve(host.mirrorInput({ mirrorId: state.mirrorId, event })).catch(() => {});
}

function wireInput(state) {
  const surface = state.surface;
  const point = (event) => toBackend(event, surface, state.viewport);
  surface.addEventListener("pointermove", (event) => {
    const at = point(event); if (!at) return;
    if (state.pointers.has(event.pointerId)) state.pointers.get(event.pointerId).at = at;
    state.latestMove = { kind: "mouse", type: "move", ...at, button: "none",
      buttons: event.buttons, modifiers: modifierBits(event) };
    if (state.moveFrame) return;
    state.moveFrame = requestAnimationFrame(() => {
      state.moveFrame = 0;
      const move = state.latestMove;
      state.latestMove = null;
      if (move) sendInput(state, move);
    });
  });
  surface.addEventListener("pointerdown", (event) => {
    const at = point(event); if (!at) return;
    event.preventDefault();
    try { surface.setPointerCapture(event.pointerId); } catch {}
    state.pointers.set(event.pointerId, { at, button: mouseButton(event.button), clickCount: Math.max(1, Math.min(3, event.detail || 1)) });
    try { surface.focus({ preventScroll: true }); } catch { surface.focus(); }
    sendInput(state, { kind: "mouse", type: "press", ...at, button: mouseButton(event.button),
      buttons: event.buttons, clickCount: Math.max(1, Math.min(3, event.detail || 1)), modifiers: modifierBits(event) });
  });
  const releasePointer = (event) => {
    const held = state.pointers.get(event.pointerId);
    if (!held) return;
    event.preventDefault();
    const at = point(event) || held.at;
    sendInput(state, { kind: "mouse", type: "release", ...at, button: held.button,
      buttons: event.buttons, clickCount: held.clickCount, modifiers: modifierBits(event) });
    state.pointers.delete(event.pointerId);
    try { surface.releasePointerCapture(event.pointerId); } catch {}
  };
  surface.addEventListener("pointerup", releasePointer);
  surface.addEventListener("pointercancel", releasePointer);
  // 포인터 캡처가 surface 밖 release를 붙잡고, 전역 fallback은 창 포커스 변화로 캡처가 끊긴 경우를 맡는다.
  window.addEventListener("pointerup", releasePointer, true);
  state.releasePointer = releasePointer;
  surface.addEventListener("wheel", (event) => {
    event.preventDefault();
    const at = point(event); if (!at) return;
    sendInput(state, { kind: "wheel", ...at, deltaX: event.deltaX, deltaY: event.deltaY,
      modifiers: modifierBits(event) });
  }, { passive: false });
  surface.addEventListener("contextmenu", (event) => event.preventDefault());
  surface.addEventListener("dragstart", (event) => event.preventDefault());
  surface.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key === "Process" || event.key === "Dead") return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      sendInput(state, { kind: "text", text: event.key });
      event.preventDefault();
      return;
    }
    sendInput(state, { kind: "key", type: "keyDown", key: event.key, code: event.code,
      keyCode: event.keyCode, modifiers: modifierBits(event) });
    if (KEY_PREVENT_DEFAULT.has(event.key)) event.preventDefault();
  });
  surface.addEventListener("keyup", (event) => {
    if (event.isComposing || event.key === "Process" || event.key === "Dead") return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    sendInput(state, { kind: "key", type: "keyUp", key: event.key, code: event.code,
      keyCode: event.keyCode, modifiers: modifierBits(event) });
  });
  // IME 중간 조합은 보내지 않고, 브라우저가 확정한 문자열만 insertText 경로로 보낸다.
  surface.addEventListener("compositionend", (event) => {
    if (event.data) sendInput(state, { kind: "text", text: event.data });
  });
  surface.addEventListener("paste", (event) => {
    const text = event.clipboardData && event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    sendInput(state, { kind: "text", text });
  });
}

function requestResize(state, viewport) {
  state.queuedViewport = viewport;
  if (state.resizing || state.closed || !state.mirrorId || !host) return;
  if (state.transport === "live" && (!host.liveChromeCommand || state.nativeMode)) return;
  if (state.transport !== "live" && !host.mirrorResize) return;
  const next = state.queuedViewport;
  state.queuedViewport = null;
  state.resizing = true;
  const retry = () => {
    if (state.closed) return;
    if (!state.queuedViewport) state.queuedViewport = next;
    clearTimeout(state.resizeRetry);
    state.resizeRetry = setTimeout(() => {
      state.resizeRetry = 0;
      if (state.queuedViewport) requestResize(state, state.queuedViewport);
    }, 300);
  };
  const operation = state.transport === "live"
    ? Promise.resolve(host.liveChromeCommand({ id: state.mirrorId, command: "Page.stopScreencast", args: {} }))
      .then((stopped) => stopped && stopped.ok
        ? host.liveChromeCommand({ id: state.mirrorId, command: "Page.startScreencast", args: {
          format: "jpeg", quality: 75, everyNthFrame: 1, maxWidth: next.width, maxHeight: next.height,
        } })
        : stopped)
    : Promise.resolve(host.mirrorResize({ mirrorId: state.mirrorId, viewport: next }));
  void operation.then((result) => {
    if (state.closed) return;
    // live target의 실제 입력 좌표계는 Chrome 창이 정한다. screencast metadata를 받을 때만 갱신한다.
    if (result && result.ok) {
      if (state.transport !== "live") state.viewport = next;
    } else retry();
  }).catch(retry).finally(() => {
    state.resizing = false;
    if (!state.closed && state.queuedViewport && !state.resizeRetry) requestResize(state, state.queuedViewport);
  });
}

function scheduleResize(state) {
  if (!state || state.closed || state.resizeFrame) return;
  state.resizeFrame = requestAnimationFrame(() => {
    state.resizeFrame = 0;
    if (state.closed) return;
    const viewport = surfaceViewport(state.surface);
    // display:none인 비활성 surface의 0×0 관찰은 viewport 변경이 아니다.
    if (!viewport) return;
    if (sameViewport(viewport, state.viewport) || sameViewport(viewport, state.queuedViewport)) return;
    requestResize(state, viewport);
  });
}

function makeSurface(rec) {
  const surface = document.createElement("img");
  surface.className = "wv-mirror";
  surface.dataset.tab = rec.tabId;
  surface.draggable = false;
  surface.tabIndex = 0;
  surface.spellcheck = false;
  surface.setAttribute("contenteditable", "true");
  surface.setAttribute("role", "application");
  surface.setAttribute("aria-label", "진짜 Chrome 미러");
  const stack = select && select("#wv-stack");
  if (!stack) throw new Error("Chrome 미러 표면을 붙일 컨테이너가 없습니다.");
  stack.appendChild(surface);
  const state = {
    tabId: rec.tabId, rec, surface, url: "", viewport: surfaceViewport(surface, true) || { width: 1280, height: 900 },
    mirrorId: "", backendUrl: "", closed: false, parking: false, committed: false,
    transport: "dedicated", nativeMode: false, liveConnected: false, connectNeeded: false,
    reconnectFailed: false, controls: null,
    mode: "claude", manualHost: "", startTask: null, resizeFrame: 0, moveFrame: 0,
    latestMove: null, queuedViewport: null, resizing: false, resizeRetry: 0,
    pointers: new Map(), releasePointer: null, observer: null,
  };
  wireInput(state);
  try {
    state.observer = new ResizeObserver(() => scheduleResize(state));
    state.observer.observe(surface);
  } catch {}
  return state;
}

function actionBar(text) {
  const bar = document.createElement("div");
  bar.setAttribute("role", "dialog");
  bar.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10020;"
    + "display:flex;align-items:center;gap:8px;max-width:min(760px,92vw);padding:10px 12px;"
    + "border:1px solid #3a3f49;border-radius:10px;background:#17191e;color:#eceef2;"
    + "box-shadow:0 10px 32px rgba(0,0,0,.48);font-size:13px;";
  const label = document.createElement("span");
  label.textContent = text;
  label.style.cssText = "flex:1;min-width:180px;line-height:1.45;";
  bar.appendChild(label);
  bar.__label = label;
  return bar;
}

function barButton(bar, label, act) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = "white-space:nowrap;padding:6px 9px;border:1px solid #555d6b;border-radius:7px;"
    + "background:#252933;color:#f4f5f7;cursor:pointer;";
  button.onclick = act;
  bar.appendChild(button);
  return button;
}

function showConsentNotice(state, message) {
  const bar = actionBar(message || "현재 Chrome 세션에 연결하지 못했습니다.");
  const close = () => { try { bar.remove(); } catch {} };
  barButton(bar, "Chrome 설정 열기", async () => {
    const result = await host.liveChromeOpenSettings();
    bar.__label.textContent = result?.message || `Chrome 주소창에 ${LIVE_SETTINGS_URL} 를 입력해 주세요.`;
  });
  barButton(bar, "설정 주소 복사", async () => {
    let ok = false;
    try { ok = (await host.writeClipboard?.(LIVE_SETTINGS_URL)) === true; } catch {}
    bar.__label.textContent = ok
      ? `${LIVE_SETTINGS_URL} 를 복사했습니다. Chrome 주소창에 붙여넣으세요.`
      : `복사하지 못했습니다. Chrome 주소창에 ${LIVE_SETTINGS_URL} 를 입력해 주세요.`;
  });
  barButton(bar, "다시 연결", () => {
    close();
    if (state?.closed) {
      enterMirror(state.rec, state.url, true, { transport: "live", manualHost: state.manualHost });
    } else if (state?.controls?.__native) state.controls.__native.click();
  });
  barButton(bar, "닫기", close);
  document.body.appendChild(bar);
}

function makeLiveControls(state) {
  if (state.controls) return state.controls;
  const bar = actionBar("현재 Chrome 탭을 연결했습니다. 로그인 차단이나 패스키·확장 팝업은 ‘Chrome에서 직접 계속’으로 진행하세요.");
  bar.style.bottom = "18px";
  bar.style.display = state.rec.el.classList.contains("active") ? "flex" : "none";
  let native;
  const nativeAction = async () => {
    native.disabled = true;
    const reconnecting = state.nativeMode;
    if (reconnecting) state.reconnectFailed = false;
    const result = reconnecting
      ? await host.liveChromeConnect()
      : await host.liveChromeNative({ id: state.mirrorId });
    if (reconnecting) {
      if (result?.ok && !state.reconnectFailed) {
        state.nativeMode = false;
        state.liveConnected = true;
        bar.__label.textContent = "현재 Chrome 탭 화면을 다시 연결했습니다.";
        native.textContent = "Chrome에서 직접 계속";
      } else {
        bar.__label.textContent = result?.message || "이전에 만든 Chrome 탭에 다시 연결하지 못했습니다.";
        showConsentNotice(state, result?.message);
      }
    } else if (result?.ok) {
      state.nativeMode = true;
      state.liveConnected = false;
      bar.__label.textContent = "Chrome 창에서 작업 중입니다. 끝난 뒤 명시적으로 다시 연결하세요.";
      native.textContent = "다시 연결";
    } else {
      bar.__label.textContent = result?.message || "Chrome 연결을 바꾸지 못했습니다.";
    }
    native.disabled = false;
  };
  native = barButton(bar, "Chrome에서 직접 계속", nativeAction);
  bar.__native = native;
  const hide = barButton(bar, "안내 숨기기", () => { bar.style.display = "none"; });
  hide.setAttribute("aria-label", "현재 Chrome 연결 안내 숨기기");
  document.body.appendChild(bar);
  state.controls = bar;
  return bar;
}

function disposeSurface(state) {
  try { state.observer && state.observer.disconnect(); } catch {}
  if (state.resizeFrame) cancelAnimationFrame(state.resizeFrame);
  if (state.moveFrame) cancelAnimationFrame(state.moveFrame);
  clearTimeout(state.resizeRetry);
  if (state.releasePointer) window.removeEventListener("pointerup", state.releasePointer, true);
  try { state.controls?.remove(); } catch {}
  try { state.surface.remove(); } catch {}
}

function restoreWebview(state, url) {
  const target = String(url || state.url || "");
  if (!target || !state.rec || !state.rec.el) return;
  const prior = restoringTabs.get(state.tabId);
  if (prior) clearTimeout(prior.timer);
  const marker = { timer: setTimeout(() => restoringTabs.delete(state.tabId), 15000) };
  restoringTabs.set(state.tabId, marker);
  state.rec.url = target;
  try { void Promise.resolve(state.rec.el.loadURL(target)).catch(() => {
    clearTimeout(marker.timer); restoringTabs.delete(state.tabId);
  }); }
  catch { clearTimeout(marker.timer); restoringTabs.delete(state.tabId); }
}

function parkWebview(state) {
  if (state.closed || state.parking || !state.rec || !state.rec.el) return;
  state.parking = true;
  state.rec.url = state.url;
  try {
    void Promise.resolve(state.rec.el.loadURL("about:blank")).catch(() => {});
  } catch {}
}

function failStart(state, message) {
  if (mirrorsByTab.get(state.tabId) !== state) return;
  state.closed = true;
  mirrorsByTab.delete(state.tabId);
  if (state.mirrorId) tabsByMirror.delete(state.mirrorId);
  disposeSurface(state);
  if (state.mirrorId && host) {
    const stopping = state.transport === "live"
      ? host.liveChromeClose?.({ id: state.mirrorId })
      : host.mirrorStop?.({ mirrorId: state.mirrorId });
    void Promise.resolve(stopping).catch(() => {});
  }
  restoreWebview(state, state.url);
  if (state.transport === "live" && host?.liveChromeOpenSettings) showConsentNotice(state, message);
  else try { showToast("Chrome 미러를 시작하지 못했습니다: " + message); } catch {}
}

function ensureBackend(state) {
  if (state.startTask || state.closed) return;
  if (state.mirrorId && state.backendUrl === state.url) {
    if (state.committed) parkWebview(state);
    return;
  }
  state.startTask = (async () => {
    const priorStop = stopByTab.get(state.tabId);
    if (priorStop) await priorStop.catch(() => {});
    while (!state.closed) {
      const requestedUrl = state.transport === "live" ? (state.requestedUrl || state.url) : state.url;
      const requestedViewport = state.viewport;
      let result;
      if (state.transport === "live") {
        if (!state.liveConnected) {
          if (!state.connectNeeded) {
            failStart(state, "연결이 끝났습니다. 사용자가 다시 연결해야 합니다.");
            return;
          }
          state.connectNeeded = false;
          const connected = await host.liveChromeConnect();
          if (!connected?.ok) {
            failStart(state, connected?.message || "현재 Chrome에 연결하지 못했습니다.");
            return;
          }
          state.liveConnected = true;
        }
        if (state.mirrorId) {
          result = await host.liveChromeCommand({
            id: state.mirrorId, command: "Page.navigate", args: { url: requestedUrl },
          });
          if (result?.ok) result = { ok: true, mirrorId: state.mirrorId };
        } else {
          const opened = await host.liveChromeOpen({
            url: requestedUrl,
            screencast: { format: "jpeg", quality: 75, everyNthFrame: 1,
              maxWidth: requestedViewport.width, maxHeight: requestedViewport.height },
          });
          result = opened?.ok ? { ...opened, mirrorId: opened.id } : opened;
        }
      } else {
        result = await host.mirrorStart({
          tabKey: state.tabId,
          url: requestedUrl,
          viewport: requestedViewport,
          ...(state.mode === "manual" ? { manualHost: state.manualHost } : {}),
        });
      }
      if (!result || !result.ok || !result.mirrorId) {
        failStart(state, (result && (result.message || result.error)) || "알 수 없는 오류");
        return;
      }
      state.mirrorId = result.mirrorId;
      state.backendUrl = result.url || requestedUrl;
      if (state.transport === "live" && state.requestedUrl === requestedUrl && httpUrl(result.url)) {
        state.url = result.url;
        state.rec.url = result.url;
        try { updateWebviewMeta(state.rec, { url: result.url, title: "" }); } catch {}
      }
      if (state.closed) {
        try {
          if (state.transport === "live") await host.liveChromeClose({ id: state.mirrorId });
          else await host.mirrorStop({ mirrorId: state.mirrorId });
        } catch {}
        state.mirrorId = "";
        return;
      }
      tabsByMirror.set(state.mirrorId, state.tabId);
      if (state.transport === "live") makeLiveControls(state);
      if (state.committed) parkWebview(state);
      if (state.queuedViewport) requestResize(state, state.queuedViewport);
      else if (!sameViewport(requestedViewport, state.viewport) && host.mirrorResize) requestResize(state, state.viewport);
      if (requestedUrl === (state.transport === "live" ? state.requestedUrl : state.url)) return;
    }
  })().catch((error) => {
    if (!state.closed) failStart(state, error && error.message ? error.message : "알 수 없는 오류");
  }).finally(() => { state.startTask = null; });
}

function enterMirror(rec, url, committed, options = {}) {
  if (!rec || rec.tabId == null || !rec.el) return;
  let state = mirrorsByTab.get(rec.tabId);
  if (!state) {
    try {
      state = makeSurface(rec);
      mirrorsByTab.set(rec.tabId, state);
    } catch (error) {
      try { showToast(error && error.message ? error.message : "Chrome 미러 표면을 만들지 못했습니다."); } catch {}
      return;
    }
  }
  if (options.transport === "live" && state.transport !== "live") {
    state.transport = "live";
    state.connectNeeded = true;
  } else if (options.transport !== "live" && !state.mirrorId) {
    state.transport = "dedicated";
  }
  if (options.manualHost) {
    state.mode = "manual";
    state.manualHost = options.manualHost;
  } else {
    state.mode = "claude";
    state.manualHost = "";
  }
  state.url = url;
  if (state.transport === "live") state.requestedUrl = url;
  state.committed = committed === true;
  state.rec.url = url;
  state.surface.classList.toggle("active", state.rec.el.classList.contains("active"));
  ensureBackend(state);
  if (state.mirrorId && state.committed) parkWebview(state);
}

function leaveMirror(rec, options = {}) {
  if (!rec || rec.tabId == null) return;
  const state = mirrorsByTab.get(rec.tabId);
  if (!state) return;
  state.closed = true;
  mirrorsByTab.delete(state.tabId);
  if (state.mirrorId) tabsByMirror.delete(state.mirrorId);
  disposeSurface(state);
  const stopping = (async () => {
    if (state.startTask) await state.startTask.catch(() => {});
    if (!state.mirrorId || !host || state.nativeMode) return;
    try {
      if (state.transport === "live") await host.liveChromeClose?.({ id: state.mirrorId });
      else await host.mirrorStop?.({ mirrorId: state.mirrorId });
    } catch {}
  })();
  stopByTab.set(state.tabId, stopping);
  void stopping.finally(() => { if (stopByTab.get(state.tabId) === stopping) stopByTab.delete(state.tabId); });
  if (options.restoreUrl) restoreWebview(state, options.restoreUrl);
}

function mirrorNavigation(rec, event = {}) {
  if (!rec || event.isMainFrame === false) return false;
  if (event.phase === "destroy") {
    const marker = restoringTabs.get(rec.tabId);
    if (marker) clearTimeout(marker.timer);
    restoringTabs.delete(rec.tabId);
    leaveMirror(rec);
    return false;
  }
  const url = String(event.url || "");
  if (restoringTabs.has(rec.tabId)) return false;
  const state = mirrorsByTab.get(rec.tabId);
  // 우리가 park한 about:blank는 이탈이 아니다. rec.url을 Claude 주소로 되돌리고 shell의
  // 주소/히스토리/WC 갱신을 막아, 내부 park가 사용자 navigation으로 저장되지 않게 한다.
  if (state && state.parking && url === "about:blank") {
    rec.url = state.url;
    return true;
  }
  if (state && acceptsUrl(state, url)) {
    // park 뒤 주소줄에서 허용 범위의 새 URL로 이동한 경우다. backend가 목적지를 받은 뒤 다시 park한다.
    if (state && event.phase === "start") state.parking = false;
    enterMirror(rec, url, event.phase === "commit",
      { transport: state.transport, ...(state.mode === "manual" ? { manualHost: state.manualHost } : {}) });
    return true;
  }
  if (!state && isClaudeMirrorUrl(url)) {
    enterMirror(rec, url, event.phase === "commit");
    return true;
  }
  if (state) leaveMirror(rec);
  return false;
}

function syncActiveTab(tabId) {
  for (const [id, state] of mirrorsByTab) {
    const active = id === tabId;
    state.surface.classList.toggle("active", active);
    if (state.controls) state.controls.style.display = active ? "flex" : "none";
    if (active) {
      const urlInput = select && select("#url");
      if (urlInput && document.activeElement !== urlInput) urlInput.value = state.url;
      scheduleResize(state);
    }
  }
}

function receiveFrame(frame) {
  if (!frame || !frame.mirrorId || typeof frame.data !== "string") return;
  const tabId = tabsByMirror.get(frame.mirrorId);
  const state = tabId != null ? mirrorsByTab.get(tabId) : null;
  if (!state || state.closed || state.mirrorId !== frame.mirrorId) return;
  if (state.transport === "live") {
    const width = Math.round(Number(frame.metadata?.deviceWidth));
    const height = Math.round(Number(frame.metadata?.deviceHeight));
    if (width > 0 && height > 0) state.viewport = { width, height };
  }
  state.surface.src = "data:image/jpeg;base64," + frame.data;
}

function receiveLiveFrame(frame) {
  if (!frame || !frame.id) return;
  receiveFrame({ ...frame, mirrorId: frame.id });
}

function receiveLiveState(value) {
  if (!value || typeof value.state !== "string") return;
  const states = value.id ? [mirrorsByTab.get(tabsByMirror.get(value.id))] : [...mirrorsByTab.values()];
  for (const state of states) {
    if (!state || state.transport !== "live" || state.closed) continue;
    if (value.state === "tab-navigated" && httpUrl(value.url)) {
      state.url = value.url;
      state.backendUrl = value.url;
      state.rec.url = value.url;
      try { updateWebviewMeta(state.rec, { url: value.url, title: "" }); } catch {}
    } else if (value.state === "disconnected" || value.state === "tab-unavailable") {
      state.liveConnected = false;
      state.nativeMode = true;
      if (value.state === "tab-unavailable") state.reconnectFailed = true;
      if (state.controls) {
        state.controls.__label.textContent = value.state === "tab-unavailable"
          ? "이전에 만든 Chrome 탭을 찾지 못했습니다. 새 연결을 선택해 주세요."
          : "Chrome 화면 연결이 끝났습니다. 사용자가 다시 연결할 수 있습니다.";
        state.controls.__native.textContent = "다시 연결";
      }
    }
  }
}

function receiveMeta(meta) {
  if (!meta || !meta.mirrorId) return;
  const tabId = tabsByMirror.get(meta.mirrorId);
  const state = tabId != null ? mirrorsByTab.get(tabId) : null;
  if (!state || state.closed || state.mirrorId !== meta.mirrorId) return;
  const nextUrl = String(meta.url || state.url || "");
  if (nextUrl && !acceptsUrl(state, nextUrl)) {
    leaveMirror(state.rec, { restoreUrl: nextUrl });
    return;
  }
  if (nextUrl) {
    state.url = nextUrl;
    state.backendUrl = nextUrl;
  }
  try { updateWebviewMeta(state.rec, { url: state.url, title: String(meta.title || "") }); } catch {}
}

function mirrorCommand(rec, command) {
  const state = rec && mirrorsByTab.get(rec.tabId);
  if (!state || state.closed || !state.mirrorId) return false;
  sendInput(state, { kind: "navigation", command });
  return true;
}

function mirrorTabItem(rec) {
  if (!rec || rec.tabId == null) return null;
  const state = mirrorsByTab.get(rec.tabId);
  if (state) {
    return { label: "진짜 Chrome 미러 끄기", act: () => leaveMirror(state.rec, { restoreUrl: state.url }) };
  }
  let url = rec.url || "";
  try { if (!url && rec.el?.getURL) url = rec.el.getURL() || ""; } catch {}
  const parsed = httpUrl(url);
  if (!parsed) return null;
  return { label: "진짜 Chrome으로 열기", act: () => {
    if (parsed.origin === "https://claude.ai") enterMirror(rec, parsed.href, true);
    else enterMirror(rec, parsed.href, true, { manualHost: parsed.host });
  } };
}

export function initCapability(ctx = {}) {
  host = ctx.acHost;
  select = ctx.$;
  showToast = typeof ctx.showToast === "function" ? ctx.showToast : () => {};
  getWebviewEntries = typeof ctx.getWebviewEntries === "function" ? ctx.getWebviewEntries : () => [];
  updateWebviewMeta = typeof ctx.updateWebviewMeta === "function" ? ctx.updateWebviewMeta : () => {};
  // native bridge 자체가 없는 창(일반 브라우저·원격 접속)은 미러를 띄울 곳이 없으므로 조용히 미지원으로 둔다.
  // bridge 는 있는데 미러 함수가 빠졌으면 preload 와 어긋난 것이라 오류로 알린다.
  if (host == null) return {};
  if (!host.mirrorStart || !host.mirrorInput || !host.mirrorResize || !host.mirrorStop
    || !host.onMirrorFrame || !host.onMirrorMeta) {
    throw new Error("Chrome 미러 preload bridge가 없습니다.");
  }
  provide("mirror.navigation", mirrorNavigation);
  provide("mirror.activeTab", syncActiveTab);
  provide("mirror.tabUrl", (tabId) => mirrorsByTab.get(tabId)?.url || "");
  provide("mirror.command", mirrorCommand);
  provide("mirror.tabItem", mirrorTabItem);
  provide("mirror.loadSettled", (tabId) => {
    const marker = restoringTabs.get(tabId);
    if (marker) clearTimeout(marker.timer);
    restoringTabs.delete(tabId);
  });
  host.onMirrorFrame(receiveFrame);
  host.onMirrorMeta(receiveMeta);
  if (host.onLiveChromeFrame) host.onLiveChromeFrame(receiveLiveFrame);
  if (host.onLiveChromeState) host.onLiveChromeState(receiveLiveState);

  let activeId = null;
  for (const [tabId, rec] of getWebviewEntries()) {
    let url = rec && rec.url || "";
    try { if (!url && rec && rec.el) url = rec.el.getURL() || ""; } catch {}
    if (isClaudeMirrorUrl(url)) enterMirror(rec, url, true);
    if (rec && rec.el && rec.el.classList.contains("active")) activeId = tabId;
  }
  syncActiveTab(activeId);
  return {};
}
