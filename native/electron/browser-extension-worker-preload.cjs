const { contextBridge, ipcRenderer } = require("electron");

const extensionContext = contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol === "chrome-extension:" });
if (extensionContext) {
  contextBridge.exposeInMainWorld("__irisExtensionCompatibility", {
    invoke: (operation, payload) => ipcRenderer.invoke("iris-extension-compatibility", operation, payload),
    listen: (callback) => { ipcRenderer.on("iris-extension-event", (_event, name, payload) => callback(name, payload)); },
  });
  contextBridge.executeInMainWorld({ func: () => {
    const bridge = globalThis.__irisExtensionCompatibility;
    const listeners = new Map();
    let nextToken = 0;
    bridge.listen((token, payload) => {
      const listener = listeners.get(token);
      if (listener) { try { listener(payload); } catch (error) { console.error(error); } }
    });
    const event = (name, call = (callback, payload) => callback(payload)) => {
      const callbacks = new Map();
      return {
        addListener(callback, filter, extraInfoSpec) {
          if (typeof callback !== "function") throw new TypeError("확장 이벤트에는 함수가 필요합니다.");
          if (callbacks.has(callback)) return;
          const token = String(++nextToken);
          callbacks.set(callback, token);
          listeners.set(token, (payload) => call(callback, payload));
          void bridge.invoke("subscribe", { token, name, filter, extraInfoSpec }).catch((error) => { callbacks.delete(callback); listeners.delete(token); console.error(`Iris ${name}:`, error); });
        },
        removeListener(callback) { const token = callbacks.get(callback); if (token) { callbacks.delete(callback); listeners.delete(token); void bridge.invoke("unsubscribe", { token, name }); } },
        hasListener: (callback) => callbacks.has(callback),
        hasListeners: () => callbacks.size > 0,
      };
    };
    // Electron 미지원 API. sync 는 local 로, 메뉴는 빈 구현으로 채움 — 시작 때 예외로 워커가 등록 실패하지 않게
    if (chrome.storage?.local) Object.defineProperty(chrome.storage, "sync", { configurable: true, value: chrome.storage.local });
    if (!chrome.contextMenus) {
      const idle = { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false };
      const done = (callback) => { if (typeof callback === "function") queueMicrotask(() => callback()); return Promise.resolve(); };
      chrome.contextMenus = {
        create: (properties, callback) => { void done(callback); return properties?.id ?? ""; },
        update: (_id, _properties, callback) => done(callback),
        remove: (_id, callback) => done(callback),
        removeAll: (callback) => done(callback),
        onClicked: idle, onShown: idle, onHidden: idle,
      };
    }
    const idleEvent = { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false };
    chrome.commands ||= {};
    if (!chrome.commands.onCommand?.addListener) chrome.commands.onCommand = event("commands.onCommand", (callback, payload) => callback(payload.command, payload.tab));
    if (typeof chrome.commands.getAll !== "function") chrome.commands.getAll = (callback) => {
      const promise = bridge.invoke("commands.getAll");
      if (typeof callback === "function") void promise.then(callback, () => callback([]));
      return promise;
    };
    // Electron 은 onInstalled·onStartup 을 보내지 않음. 설치 때 기본 설정을 쓰는 확장이 설정 없이 동작
    chrome.runtime.onInstalled = event("runtime.onInstalled");
    chrome.runtime.onStartup = event("runtime.onStartup", (callback) => callback());
    // webNavigation 은 Electron 에 없음. 이벤트·프레임 목록은 Iris 메인 프로세스가 탭 화면 이벤트로 전달
    chrome.webNavigation ||= {};
    for (const name of ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
      if (!chrome.webNavigation[name]?.addListener) chrome.webNavigation[name] = event(`webNavigation.${name}`);
    }
    for (const name of ["onErrorOccurred", "onCreatedNavigationTarget", "onTabReplaced"]) chrome.webNavigation[name] ||= { ...idleEvent };
    for (const name of ["getAllFrames", "getFrame"]) {
      if (typeof chrome.webNavigation[name] !== "function") chrome.webNavigation[name] = (details, callback) => {
        const promise = bridge.invoke(`webNavigation.${name}`, details);
        if (typeof callback === "function") void promise.then(callback, () => callback(null));
        return promise;
      };
    }
    // Electron 은 서비스 워커의 webRequest 리스너에 이벤트를 넘기지 않음. 문서 요청 이벤트만 Iris 메인 프로세스가 전달
    if (chrome.webRequest) {
      for (const name of ["onBeforeRequest", "onHeadersReceived", "onResponseStarted", "onCompleted", "onErrorOccurred"]) chrome.webRequest[name] = event(`webRequest.${name}`);
    }
    if (typeof chrome.tabs.create !== "function") chrome.tabs.create = (properties, callback) => {
      const promise = bridge.invoke("tabs.create", properties);
      if (typeof callback !== "function") return promise;
      void promise.then(callback, (error) => {
        const descriptor = Object.getOwnPropertyDescriptor(chrome.runtime, "lastError");
        Object.defineProperty(chrome.runtime, "lastError", { configurable: true, get: () => ({ message: String(error.message || error) }) });
        try { callback(undefined); }
        finally { if (descriptor) Object.defineProperty(chrome.runtime, "lastError", descriptor); else delete chrome.runtime.lastError; }
      });
    };
    // 위에서 채우지 않은 것 중 선언한 권한의 API 가 Electron 에 없으면 빈 구현. 이벤트는 등록만 받고 함수는 바로 끝남(콜백도 호출)
    const manifest = chrome.runtime.getManifest?.() || {};
    const blank = () => new Proxy({}, { get(target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (!(key in target)) target[key] = /^on[A-Z]/.test(key) ? { ...idleEvent } : (...args) => {
        const callback = args.findLast((value) => typeof value === "function");
        if (callback) queueMicrotask(() => callback());
        return Promise.resolve();
      };
      return target[key];
    } });
    // windows 는 권한 없이 쓰는 API. Electron 탭의 windowId 0 과 맞춘 창 하나
    const actions = { action: "action", browser_action: "browserAction", page_action: "pageAction" };
    const names = [...(manifest.permissions || []), ...(manifest.optional_permissions || []), "permissions", "windows",
      ...Object.keys(actions).filter((key) => manifest[key]).map((key) => actions[key])];
    for (const name of new Set(names)) {
      if (/^[a-z][A-Za-z]*$/.test(name) && chrome[name] == null) chrome[name] = blank();
    }
    if (chrome.windows && !("WINDOW_ID_NONE" in chrome.windows)) {
      const window = () => ({ id: 0, focused: true, top: 0, left: 0, width: globalThis.screen?.width ?? 0, height: globalThis.screen?.height ?? 0,
        incognito: false, type: "normal", state: "normal", alwaysOnTop: false });
      const answer = (value) => (...args) => {
        const callback = args.findLast((item) => typeof item === "function");
        const result = typeof value === "function" ? value() : value;
        if (callback) queueMicrotask(() => callback(result));
        return Promise.resolve(result);
      };
      Object.assign(chrome.windows, { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
        get: answer(window), getCurrent: answer(window), getLastFocused: answer(window), getAll: answer(() => [window()]) });
    }
    // Electron 의 browser 는 chrome 과 다른 객체이고 Electron 내장 API 만 가짐. browser 로 부르는 확장도 위 보정을 받게
    const browser = globalThis.browser;
    if (browser && typeof browser === "object" && browser !== chrome) {
      for (const name of Object.keys(chrome)) if (browser[name] == null) browser[name] = chrome[name];
    }
  } });
}
