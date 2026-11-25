const STEP = 0.5;
const MIN_LEVEL = Math.log(0.25) / Math.log(1.2);
const MAX_LEVEL = Math.log(5) / Math.log(1.2);

function isBlankUrl(url) {
  return url === "" || url === "about:blank";
}

function createBrowserTabZoom({ isolate, ipcMain, findContents, isTrustedSender, error = console.error }) {
  const tabs = new WeakMap();
  const irisTabs = new Map();
  let liveTabIds = new Set();

  function report(wc, notice) {
    const host = wc.hostWebContents;
    if (host && !host.isDestroyed()) {
      const message = { wc: wc.id, factor: wc.getZoomFactor() };
      if (notice) message.notice = notice;
      host.send("ac-browser-zoom-changed", message);
    }
  }

  function apply(wc, tab, action) {
    if (wc.isDestroyed()) return;
    let level = tab.zoom.level;
    if (action === "reset") level = 0;
    else if (action === "in") level = Math.min(level + STEP, MAX_LEVEL);
    else if (action === "out") level = Math.max(level - STEP, MIN_LEVEL);
    if (wc.getZoomLevel() !== level) wc.setZoomLevel(level);
    tab.zoom.level = level;
    report(wc);
  }

  async function isolateDocument(wc, tab, action = null) {
    if (wc.isDestroyed()) return;
    if (!isBlankUrl(wc.getURL())) tab.hasPage = true;
    if (tab.scope?.action) report(wc, "페이지가 이동해 확대·축소를 적용하지 못했습니다.");
    // 범위 설정 전 입력은 같은 문서의 마지막 한 번만 보류
    const pending = { action };
    tab.scope = pending;
    try {
      await isolate(wc);
      if (tab.scope !== pending || wc.isDestroyed()) return;
      apply(wc, tab, pending.action);
      tab.scope = "ready";
    } catch (failure) {
      if (tab.scope !== pending || wc.isDestroyed()) return;
      tab.scope = null;
      report(wc, pending.action ? "이 페이지의 확대·축소를 적용하지 못했습니다." : null);
      const message = String(failure?.message ?? failure);
      if (!tab.hasPage && isBlankUrl(wc.getURL()) && message.includes("Cannot access contents of the page")) return;
      error("[browser-tab-zoom]", wc.id, message);
    }
  }

  function adjust(wc, action) {
    const tab = tabs.get(wc);
    if (!tab || wc.isDestroyed()) return;
    if (action !== "in" && action !== "out" && action !== "reset") return;
    if (tab.scope === "ready") apply(wc, tab, action);
    else if (tab.scope) tab.scope.action = action;
    else void isolateDocument(wc, tab, action);
  }

  function attach(wc) {
    if (tabs.has(wc)) return;
    const tab = { zoom: { level: 0 }, scope: null, irisId: null, hasPage: false };
    tabs.set(wc, tab);
    wc.on("did-navigate", () => isolateDocument(wc, tab));
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) isolateDocument(wc, tab);
    });
    wc.on("zoom-changed", (_event, direction) => {
      if (direction === "in" || direction === "out") adjust(wc, direction);
    });
    isolateDocument(wc, tab);
  }

  function ownedContents(event, wcId) {
    if (!Number.isSafeInteger(wcId) || !isTrustedSender(event)) return null;
    const wc = findContents(wcId);
    return wc && !wc.isDestroyed() && wc.hostWebContents === event.sender ? wc : null;
  }

  function reconcileTabs(tabsBySpace) {
    if (!tabsBySpace || typeof tabsBySpace !== "object" || Array.isArray(tabsBySpace)) return;
    const nextIds = new Set(Object.values(tabsBySpace).flat().map((tab) => tab?.id));
    // 새 탭의 webview 보고가 서버 목록보다 먼저 올 수 있음
    for (const [id, zoom] of irisTabs) {
      if (!liveTabIds.has(id) || nextIds.has(id)) continue;
      zoom.level = 0;
      irisTabs.delete(id);
    }
    liveTabIds = nextIds;
  }

  ipcMain.on("ac-browser-tab-zoom-bind", (event, wcId, tabId) => {
    if (typeof tabId !== "string" || !tabId) return;
    const wc = ownedContents(event, wcId);
    const tab = wc && tabs.get(wc);
    if (!tab || tab.irisId !== null) return;
    tab.irisId = tabId;
    const remembered = irisTabs.get(tabId);
    if (!remembered) {
      irisTabs.set(tabId, tab.zoom);
      return;
    }
    tab.zoom = remembered;
    if (tab.scope === "ready") apply(wc, tab);
  });

  ipcMain.on("ac-browser-zoom", (event, wcId, action) => {
    const wc = ownedContents(event, wcId);
    if (wc) adjust(wc, action);
  });

  return { attach, adjust, reconcileTabs };
}

module.exports = { createBrowserTabZoom };
