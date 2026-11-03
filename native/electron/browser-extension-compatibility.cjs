const fs = require("node:fs");
const path = require("node:path");
const { readManifest } = require("./browser-extension-catalog.cjs");

// Electron 에 chrome.storage.sync 가 없어 sync 로 설정을 읽는 content script 가 시작 단계에서 멈춤(화면 표시·단축키 없음).
// Iris 가 가진 복사본의 content script 앞에 보정 파일을 끼움. 페이지 world(MAIN)에는 chrome.storage 가 없어 제외
const CONTENT_SHIM = "iris-compat.js";
const CONTENT_SHIM_SOURCE = "(() => { try { const s = globalThis.chrome && chrome.storage; "
  + "if (s && s.local) Object.defineProperty(s, \"sync\", { configurable: true, value: s.local }); } catch {} })();\n";
function prepareContentScripts(directory) {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = readManifest(directory);
  const entries = (manifest.content_scripts || []).filter((entry) => Array.isArray(entry?.js) && entry.js.length && entry.world !== "MAIN");
  if (!entries.length) return false;
  const shimPath = path.join(directory, CONTENT_SHIM);
  let current = null;
  try { current = fs.readFileSync(shimPath, "utf8"); } catch {}
  if (current !== CONTENT_SHIM_SOURCE) fs.writeFileSync(shimPath, CONTENT_SHIM_SOURCE);
  const pending = entries.filter((entry) => entry.js[0] !== CONTENT_SHIM);
  if (!pending.length) return true;
  for (const entry of pending) entry.js = [CONTENT_SHIM, ...entry.js.filter((file) => file !== CONTENT_SHIM)];
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2)); fs.renameSync(temporary, manifestPath); }
  finally { fs.rmSync(temporary, { force: true }); }
  return true;
}

function matchesHost(pattern, raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (pattern === "<all_urls>") return true;
  const match = /^(\*|https?|file):\/\/(\*|\*\.[^/]+|[^/]+)(\/.*)$/.exec(pattern || "");
  if (!match || (match[1] !== "*" && `${match[1]}:` !== url.protocol)) return false;
  if (match[2] !== "*" && !(match[2].startsWith("*.")
    ? url.hostname === match[2].slice(2) || url.hostname.endsWith(`.${match[2].slice(2)}`)
    : url.hostname === match[2])) return false;
  const glob = new RegExp(`^${match[3].split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return glob.test(`${url.pathname}${url.search}`);
}

function navigationMatches(filter, raw) {
  if (!filter?.url) return true;
  const url = new URL(raw);
  return filter.url.some((condition) => Object.entries(condition).every(([key, value]) => {
    if (key === "schemes") return value.includes(url.protocol.slice(0, -1));
    const match = /^(host|path|url)(Contains|Equals|Prefix|Suffix)$/.exec(key);
    if (!match) return false;
    const text = match[1] === "host" ? url.hostname : match[1] === "path" ? url.pathname : url.href;
    return match[2] === "Contains" ? text.includes(value) : match[2] === "Equals" ? text === value
      : match[2] === "Prefix" ? text.startsWith(value) : text.endsWith(value);
  }));
}
function webRequestMatches(filter, details) {
  if (!filter?.urls?.some((pattern) => matchesHost(pattern, details.url))) return false;
  if (filter.types && !filter.types.includes(details.type)) return false;
  return (filter.tabId ?? details.tabId) === details.tabId && [undefined, -2, 0].includes(filter.windowId);
}

// manifest commands 의 suggested_key. macOS 에서 Ctrl 은 Command, MacCtrl 이 Control(Chrome 규칙)
const COMMAND_KEYS = { Comma: ",", Period: ".", Space: " ", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };
function commandShortcut(command, platform = process.platform) {
  const keys = command?.suggested_key;
  const raw = typeof keys === "string" ? keys : platform === "darwin" ? keys?.mac || keys?.default : keys?.[platform === "win32" ? "windows" : platform === "linux" ? "linux" : "default"] || keys?.default;
  if (typeof raw !== "string" || !raw) return null;
  const parts = raw.split("+").map((part) => part.trim());
  const key = parts.pop();
  const shortcut = { meta: false, control: false, alt: false, shift: false, key: COMMAND_KEYS[key] || key, text: raw };
  for (const part of parts) {
    if (part === "Shift") shortcut.shift = true;
    else if (part === "Alt") shortcut.alt = true;
    else if (part === "Command" || (part === "Ctrl" && platform === "darwin")) shortcut.meta = true;
    else if (part === "Ctrl" || part === "MacCtrl") shortcut.control = true;
    else return null;
  }
  return key ? shortcut : null;
}
function shortcutMatches(shortcut, input) {
  if (!shortcut || input?.type !== "keyDown" || input.isAutoRepeat) return false;
  if (!!input.meta !== shortcut.meta || !!input.control !== shortcut.control || !!input.alt !== shortcut.alt || !!input.shift !== shortcut.shift) return false;
  const code = String(input.code || "");
  const pressed = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : String(input.key || "");
  return pressed.toLowerCase() === String(shortcut.key).toLowerCase();
}
function manifestCommands(manifest) {
  return Object.entries(manifest?.commands || {}).filter(([name]) => !name.startsWith("_execute"))
    .map(([name, command]) => ({ name, description: String(command?.description || ""), shortcut: commandShortcut(command)?.text || "" }));
}

// Electron 은 runtime.onInstalled·onStartup 을 보내지 않음. 확장마다 마지막에 본 버전을 저장해 Chrome 처럼 판단
// 저장 파일이 생기기 전부터 있던 확장은 install 대신 chrome_update. install 이면 환영 탭을 여는 확장이 있음
function createLifecycle(file, error) {
  let versions = null;
  let legacy = false;
  const decided = new Map();
  const started = new Set();
  function load() {
    if (versions) return versions;
    versions = {};
    if (!file) return versions;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) versions = value;
    } catch (failure) { if (failure?.code === "ENOENT") legacy = true; else error("[extension-lifecycle]", String(failure)); }
    return versions;
  }
  function save() {
    if (!file) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(temporary, JSON.stringify(versions, null, 2)); fs.renameSync(temporary, file); }
    catch (failure) { error("[extension-lifecycle]", String(failure)); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  // 이번 실행에서 확장마다 한 번 판단. 워커가 다시 시작돼도 같은 결과를 다시 보내지 않음
  function decide(id, version) {
    if (decided.has(id)) return decided.get(id);
    const previous = load()[id];
    const installed = previous === undefined ? { reason: legacy ? "chrome_update" : "install" }
      : previous !== version ? { reason: "update", previousVersion: previous } : null;
    decided.set(id, installed ? { ...installed, pending: true } : null);
    if (previous !== version) { versions[id] = version; save(); }
    return decided.get(id);
  }
  function take(id, version, name) {
    const installed = decide(id, String(version || ""));
    if (name === "runtime.onInstalled") {
      if (!installed?.pending) return null;
      installed.pending = false;
      return installed.previousVersion ? { reason: installed.reason, previousVersion: installed.previousVersion } : { reason: installed.reason };
    }
    if (installed?.reason === "install" || started.has(id)) return null;
    started.add(id);
    return {};
  }
  return { take };
}

// 이미 멈춘 워커의 작업 종료는 Electron 이 예외를 던짐. 상태 변경 이벤트 안이면 메인 프로세스 오류 창
function endTask(task) { try { task?.end(); } catch {} }
const NAVIGATION_EVENTS = new Set(["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]);
// 문서 요청(main_frame·sub_frame)만. 하위 리소스 요청과 헤더 단계는 탭 화면 이벤트로 알 수 없음
const WEB_REQUEST_EVENTS = new Set(["onBeforeRequest", "onHeadersReceived", "onResponseStarted", "onCompleted", "onErrorOccurred"]);
let nextRequestId = 0;

function createExtensionCompatibility({ app, webContents, createTab, lifecyclePath, error = console.error }) {
  const states = new Map();
  const guestListeners = new Map();
  const lifecycle = createLifecycle(lifecyclePath, error);

  function authorized(state, worker) {
    const url = new URL(worker.scriptURL);
    if (url.protocol !== "chrome-extension:") throw new Error("확장 서비스 워커가 아닙니다.");
    const extension = state.session.extensions.getExtension(url.hostname);
    if (!extension || !state.paths.has(path.resolve(extension.path))) throw new Error("사용 중인 Iris 확장이 아닙니다.");
    return { extension, manifest: readManifest(extension.path), id: extension.id };
  }

  function hostAllowed(manifest, raw) {
    const patterns = [...(manifest.host_permissions || []), ...(manifest.permissions || []).filter((value) => value.includes("://") || value === "<all_urls>")];
    return patterns.some((pattern) => matchesHost(pattern, raw));
  }

  function deliver(state, name, payload) {
    for (const subscription of state.workers.values()) {
      if (subscription.worker.isDestroyed()) continue;
      for (const request of subscription.events.values()) {
      if (request.name !== name) continue;
      try {
        const { manifest } = authorized(state, subscription.worker);
        if (!hostAllowed(manifest, payload.url)) continue;
        if (!(name.startsWith("webRequest.") ? webRequestMatches(request.filter, payload) : navigationMatches(request.filter, payload.url))) continue;
        subscription.worker.send("iris-extension-event", request.token, payload);
      } catch (failure) { error("[extension-compatibility]", String(failure)); }
      }
    }
  }

  function registerWorker(state, worker, running = true) {
    if (!worker || state.workers.has(worker.versionId)) return;
    const subscription = { worker, events: new Map(), task: null, running, waiting: [] };
    worker.ipc.handle("iris-extension-compatibility", async (_event, operation, payload) => {
      const { manifest } = authorized(state, worker);
      if (operation === "tabs.create") {
        if (!createTab) throw new Error("확장 탭 열기를 사용할 수 없습니다.");
        const task = worker.startTask();
        try { return await createTab(state.session, payload); } finally { endTask(task); }
      }
      if (operation === "commands.getAll") return manifestCommands(manifest);
      const lifecycleName = String(payload?.name || "");
      if (lifecycleName === "runtime.onInstalled" || lifecycleName === "runtime.onStartup") {
        if (operation === "unsubscribe") return true;
        if (operation !== "subscribe" || !/^\d{1,8}$/.test(payload.token)) throw new Error("잘못된 확장 이벤트 요청입니다.");
        // 한 번 보내는 이벤트라 구독으로 저장하지 않음. 저장하면 워커를 계속 깨워 둠
        const event = lifecycle.take(authorized(state, worker).id, manifest.version, lifecycleName);
        // 시작 중(스크립트 첫 실행 중)인 워커에 보낸 메시지는 Electron 이 버림. 실행 중 상태가 된 뒤에 보냄
        const send = () => { if (!worker.isDestroyed()) worker.send("iris-extension-event", payload.token, event); };
        if (event) { if (subscription.running) setImmediate(send); else subscription.waiting.push(send); }
        return true;
      }
      const navigation = (manifest.permissions || []).includes("webNavigation");
      if (operation === "webNavigation.getAllFrames" || operation === "webNavigation.getFrame") {
        if (!navigation) throw new Error("확장 이벤트 권한이 없습니다.");
        return tabFrames(state, payload, operation === "webNavigation.getFrame");
      }
      // commands 는 권한 없이 manifest 에 선언한 확장만
      const name = String(payload?.name || "");
      const requests = name.startsWith("webRequest.");
      const allowed = name.startsWith("webNavigation.") ? navigation && NAVIGATION_EVENTS.has(name.slice("webNavigation.".length))
        : requests ? (manifest.permissions || []).includes("webRequest") && WEB_REQUEST_EVENTS.has(name.slice("webRequest.".length))
        : name === "commands.onCommand" ? manifestCommands(manifest).length > 0 : false;
      if (!allowed) throw new Error("확장 이벤트 권한이 없습니다.");
      if (!/^\d{1,8}$/.test(payload.token)) throw new Error("잘못된 확장 이벤트 요청입니다.");
      if (operation === "unsubscribe") {
        subscription.events.delete(payload.token);
        if (!subscription.events.size) { endTask(subscription.task); subscription.task = null; }
        return true;
      }
      if (operation !== "subscribe") throw new Error("지원하지 않는 확장 요청입니다.");
      const filter = payload.filter;
      if (requests && (!filter || typeof filter !== "object" || Object.keys(filter).some((key) => !["urls", "types", "tabId", "windowId"].includes(key))
        || !Array.isArray(filter.urls) || filter.urls.some((url) => typeof url !== "string")
        || (filter.types !== undefined && (!Array.isArray(filter.types) || filter.types.some((type) => typeof type !== "string")))
        || [filter.tabId, filter.windowId].some((id) => id !== undefined && !Number.isInteger(id)))) {
        throw new Error("지원하지 않는 webRequest 필터입니다.");
      }
      if (!requests && payload.filter && (Object.keys(payload.filter).some((key) => key !== "url")
        || !Array.isArray(payload.filter.url) || payload.filter.url.some((condition) => Object.keys(condition).some((key) => key !== "schemes" && !/^(host|path|url)(Contains|Equals|Prefix|Suffix)$/.test(key))))) {
        throw new Error("지원하지 않는 webNavigation 필터입니다.");
      }
      if (subscription.events.size >= 128 && !subscription.events.has(payload.token)) throw new Error("확장 이벤트가 너무 많습니다.");
      subscription.events.set(payload.token, payload);
      if (!subscription.task) subscription.task = worker.startTask();
      return true;
    });
    state.workers.set(worker.versionId, subscription);
  }

  function ensureSession(session) {
    if (states.has(session)) return states.get(session);
    const state = { session, paths: new Set(), workers: new Map() };
    states.set(session, state);
    state.preloadId = session.registerPreloadScript({ type: "service-worker", filePath: path.join(__dirname, "browser-extension-worker-preload.cjs") });
    state.statusListener = (details) => {
      if (details.runningStatus === "stopped") {
        const subscription = state.workers.get(details.versionId);
        // 같은 버전의 워커가 다시 시작되어도 이전 IPC 핸들러가 남을 수 있다.
        subscription?.worker.ipc.removeHandler("iris-extension-compatibility");
        endTask(subscription?.task);
        state.workers.delete(details.versionId);
        return;
      }
      registerWorker(state, session.serviceWorkers.getWorkerFromVersionID(details.versionId), details.runningStatus === "running");
      const subscription = state.workers.get(details.versionId);
      if (subscription && details.runningStatus === "running" && !subscription.running) {
        subscription.running = true;
        for (const send of subscription.waiting.splice(0)) send();
      }
    };
    session.serviceWorkers.on("running-status-changed", state.statusListener);
    for (const version of Object.keys(session.serviceWorkers.getAllRunning())) registerWorker(state, session.serviceWorkers.getWorkerFromVersionID(Number(version)));
    return state;
  }

  // Electron 은 chrome.commands 를 처리하지 않음. 탭의 키 입력을 manifest 단축키와 맞춰 그 확장 워커에만 전달
  function deliverCommand(state, input, wc) {
    for (const subscription of state.workers.values()) {
      if (subscription.worker.isDestroyed()) continue;
      const requests = [...subscription.events.values()].filter((request) => request.name === "commands.onCommand");
      if (!requests.length) continue;
      let manifest;
      try { ({ manifest } = authorized(state, subscription.worker)); } catch { continue; }
      const hit = Object.entries(manifest.commands || {}).find(([name, command]) => !name.startsWith("_execute") && shortcutMatches(commandShortcut(command), input));
      if (!hit) continue;
      const tab = { id: wc.id, url: wc.getURL(), title: wc.getTitle(), active: true, highlighted: true, incognito: false, index: 0, pinned: false, windowId: 0 };
      for (const request of requests) subscription.worker.send("iris-extension-event", request.token, { command: hit[0], tab });
      return true;
    }
    return false;
  }

  // 확장 frameId. 메인 프레임 0, 하위 프레임 frameTreeNodeId(Electron tabs.sendMessage 의 frameId 와 같은 값)
  function frameIdsOf(wc, frame, isMainFrame = frame === wc.mainFrame) {
    if (isMainFrame) return { frameId: 0, parentFrameId: -1 };
    return { frameId: frame?.frameTreeNodeId ?? -1, parentFrameId: !frame?.parent ? -1 : frame.parent === wc.mainFrame ? 0 : frame.parent.frameTreeNodeId ?? -1 };
  }
  function tabFrames(state, details, single) {
    const wc = webContents.fromId(Number(details?.tabId));
    if (!wc || wc.isDestroyed() || wc.session !== state.session || wc.getType() !== "webview" || !wc.mainFrame) return null;
    const frames = [wc.mainFrame, ...(wc.mainFrame.framesInSubtree || []).filter((frame) => frame !== wc.mainFrame)].map((frame) => ({
      ...frameIdsOf(wc, frame), processId: frame.processId, url: frame.url, errorOccurred: false,
      frameType: frame === wc.mainFrame ? "outermost_frame" : "sub_frame", documentLifecycle: "active" }));
    return single ? frames.find((frame) => frame.frameId === Number(details.frameId ?? 0)) ?? null : frames;
  }

  function attachGuest(_event, wc) {
    if (wc.getType() !== "webview") return;
    const keys = (event, input) => {
      if (event.defaultPrevented || input.type !== "keyDown") return;
      const state = states.get(wc.session);
      if (state && deliverCommand(state, input, wc)) event.preventDefault();
    };
    const findFrame = (isMainFrame, processId, routingId) => isMainFrame ? wc.mainFrame
      : wc.mainFrame?.framesInSubtree?.find((candidate) => candidate.processId === processId && candidate.routingId === routingId);
    // 같은 문서 안 이동의 종류 판단용. 해시만 바뀌면 onReferenceFragmentUpdated
    const lastUrls = new Map();
    const navigation = (name, url, isMainFrame, frame) => {
      const state = states.get(wc.session);
      if (!state || !url) return;
      const ids = frameIdsOf(wc, frame, isMainFrame);
      if (name === "onCommitted" || name === "onHistoryStateUpdated" || name === "onReferenceFragmentUpdated") lastUrls.set(ids.frameId, url);
      deliver(state, `webNavigation.${name}`, { tabId: wc.id, url, ...ids, timeStamp: Date.now() });
    };
    // 프레임별 진행 중 문서 요청. 같은 요청의 이벤트가 같은 requestId 를 갖게
    const pending = new Map();
    const request = (name, url, isMainFrame, frame, extra = {}) => {
      const state = states.get(wc.session);
      if (!state || !url) return;
      const ids = frameIdsOf(wc, frame, isMainFrame);
      if (name === "onBeforeRequest") pending.set(ids.frameId, { requestId: String(++nextRequestId) });
      const current = pending.get(ids.frameId);
      if (!current) return;
      Object.assign(current, extra);
      if (name === "onCompleted" || name === "onErrorOccurred") pending.delete(ids.frameId);
      // 문서 요청의 method 는 탭 화면 이벤트로 알 수 없음. 대부분인 GET
      deliver(state, `webRequest.${name}`, { ...current, url, method: "GET", tabId: wc.id, ...ids, type: isMainFrame ? "main_frame" : "sub_frame",
        frameType: isMainFrame ? "outermost_frame" : "sub_frame", documentLifecycle: "active", timeStamp: Date.now() });
    };
    const withoutHash = (url) => String(url || "").split("#")[0];
    const handlers = {
      "before-input-event": keys,
      "did-start-navigation": (details, url, isInPlace, isMainFrame, processId, routingId) => {
        if (details?.isSameDocument ?? isInPlace) return;
        const main = details?.isMainFrame ?? isMainFrame;
        const frame = details?.frame || findFrame(main, processId, routingId);
        navigation("onBeforeNavigate", details?.url ?? url, main, frame);
        request("onBeforeRequest", details?.url ?? url, main, frame);
      },
      "did-frame-navigate": (event, url, statusCode, statusText, isMainFrame, processId, routingId) => {
        const frame = event?.frame || findFrame(isMainFrame, processId, routingId);
        navigation("onCommitted", url, isMainFrame, frame);
        const status = statusCode > 0 ? { statusCode, statusLine: `HTTP/1.1 ${statusCode} ${statusText || ""}`.trim() } : {};
        request("onHeadersReceived", url, isMainFrame, frame, status);
        request("onResponseStarted", url, isMainFrame, frame);
      },
      "dom-ready": () => navigation("onDOMContentLoaded", wc.getURL(), true, wc.mainFrame),
      "did-frame-finish-load": (_event, isMainFrame, processId, routingId) => {
        const frame = findFrame(isMainFrame, processId, routingId);
        navigation("onCompleted", isMainFrame ? wc.getURL() : frame?.url, isMainFrame, frame);
        request("onCompleted", isMainFrame ? wc.getURL() : frame?.url, isMainFrame, frame);
      },
      "did-fail-load": (_event, _errorCode, errorDescription, validatedURL, isMainFrame, processId, routingId) => {
        request("onErrorOccurred", validatedURL, isMainFrame, findFrame(isMainFrame, processId, routingId), { error: `net::${errorDescription}` });
      },
      "did-navigate-in-page": (_event, url, isMainFrame, processId, routingId) => {
        const frame = findFrame(isMainFrame, processId, routingId);
        const previous = lastUrls.get(frameIdsOf(wc, frame, isMainFrame).frameId);
        navigation(previous && withoutHash(previous) === withoutHash(url) ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated", url, isMainFrame, frame);
      },
    };
    for (const [name, handler] of Object.entries(handlers)) wc.on(name, handler);
    guestListeners.set(wc, handlers);
    wc.once("destroyed", () => guestListeners.delete(wc));
  }
  app.on("web-contents-created", attachGuest);
  for (const wc of webContents.getAllWebContents()) attachGuest(null, wc);

  function authorizePath(session, directory) { ensureSession(session).paths.add(path.resolve(directory)); }
  function revokePath(session, directory) {
    const state = states.get(session);
    if (!state) return;
    state.paths.delete(path.resolve(directory));
    for (const subscription of state.workers.values()) {
      try { authorized(state, subscription.worker); }
      catch { endTask(subscription.task); subscription.task = null; subscription.events.clear(); }
    }
  }
  function dispose() {
    app.removeListener("web-contents-created", attachGuest);
    for (const [wc, handlers] of guestListeners) if (!wc.isDestroyed()) for (const [name, handler] of Object.entries(handlers)) wc.removeListener(name, handler);
    for (const state of states.values()) {
      state.session.unregisterPreloadScript(state.preloadId);
      state.session.serviceWorkers.removeListener("running-status-changed", state.statusListener);
      for (const subscription of state.workers.values()) { endTask(subscription.task); subscription.worker.ipc.removeHandler("iris-extension-compatibility"); }
    }
    states.clear();
  }
  return { ensureSession, authorizePath, revokePath, dispose };
}

module.exports = { createExtensionCompatibility, matchesHost, navigationMatches, webRequestMatches, prepareContentScripts, CONTENT_SHIM, commandShortcut, shortcutMatches };
