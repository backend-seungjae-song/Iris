const path = require("node:path");
const { readManifest } = require("./browser-extension-catalog.cjs");

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

function createExtensionCompatibility({ app, webContents, createTab, error = console.error }) {
  const states = new Map();
  const guestListeners = new Map();

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
        if (!navigationMatches(request.filter, payload.url)) continue;
        subscription.worker.send("iris-extension-event", request.token, payload);
      } catch (failure) { error("[extension-compatibility]", String(failure)); }
      }
    }
  }

  function registerWorker(state, worker) {
    if (!worker || state.workers.has(worker.versionId)) return;
    const subscription = { worker, events: new Map(), task: null };
    worker.ipc.handle("iris-extension-compatibility", async (_event, operation, payload) => {
      const { manifest } = authorized(state, worker);
      if (operation === "tabs.create") {
        if (!createTab) throw new Error("확장 탭 열기를 사용할 수 없습니다.");
        const task = worker.startTask();
        try { return await createTab(state.session, payload); } finally { task.end(); }
      }
      const permission = payload?.name === "webNavigation.onCommitted" ? "webNavigation" : null;
      if (!permission || !(manifest.permissions || []).includes(permission)) throw new Error("확장 이벤트 권한이 없습니다.");
      if (!/^\d{1,8}$/.test(payload.token)) throw new Error("잘못된 확장 이벤트 요청입니다.");
      if (operation === "unsubscribe") {
        subscription.events.delete(payload.token);
        if (!subscription.events.size) { subscription.task?.end(); subscription.task = null; }
        return true;
      }
      if (operation !== "subscribe") throw new Error("지원하지 않는 확장 요청입니다.");
      if (payload.filter && (Object.keys(payload.filter).some((key) => key !== "url")
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
        subscription?.task?.end();
        state.workers.delete(details.versionId);
        return;
      }
      registerWorker(state, session.serviceWorkers.getWorkerFromVersionID(details.versionId));
    };
    session.serviceWorkers.on("running-status-changed", state.statusListener);
    for (const version of Object.keys(session.serviceWorkers.getAllRunning())) registerWorker(state, session.serviceWorkers.getWorkerFromVersionID(Number(version)));
    return state;
  }

  function attachGuest(_event, wc) {
    if (wc.getType() !== "webview") return;
    const listener = (event, url, _statusCode, _statusText, isMainFrame, processId, frameRoutingId) => {
      const state = states.get(wc.session);
      const frame = event.frame || (isMainFrame ? wc.mainFrame : wc.mainFrame?.framesInSubtree?.find((candidate) => candidate.processId === processId && candidate.routingId === frameRoutingId));
      if (state) deliver(state, "webNavigation.onCommitted", { tabId: wc.id, url, frameId: isMainFrame ? 0 : frame?.frameTreeNodeId ?? -1,
        parentFrameId: !frame?.parent ? -1 : frame.parent === wc.mainFrame ? 0 : frame.parent.frameTreeNodeId ?? -1, timeStamp: Date.now() });
    };
    wc.on("did-frame-navigate", listener);
    guestListeners.set(wc, listener);
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
      catch { subscription.task?.end(); subscription.task = null; subscription.events.clear(); }
    }
  }
  function dispose() {
    app.removeListener("web-contents-created", attachGuest);
    for (const [wc, listener] of guestListeners) if (!wc.isDestroyed()) wc.removeListener("did-frame-navigate", listener);
    for (const state of states.values()) {
      state.session.unregisterPreloadScript(state.preloadId);
      state.session.serviceWorkers.removeListener("running-status-changed", state.statusListener);
      for (const subscription of state.workers.values()) { subscription.task?.end(); subscription.worker.ipc.removeHandler("iris-extension-compatibility"); }
    }
    states.clear();
  }
  return { ensureSession, authorizePath, revokePath, dispose };
}

module.exports = { createExtensionCompatibility, matchesHost, navigationMatches };
