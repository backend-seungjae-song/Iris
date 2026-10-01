const { randomUUID } = require("node:crypto");

// 확장이 만든 탭도 기존 브라우저 탭 경로를 사용한다. 응답은 요청한 창·프로필과 대조한다.
function createExtensionTabs({ ipcMain, webContents, BrowserWindow, isTrustedSender, timeoutMs = 10000 }) {
  const pending = new Map();
  const resultChannel = "ac-extension-tab-created";
  const finish = (key, error, tab) => {
    const job = pending.get(key);
    if (!job) return;
    pending.delete(key);
    clearTimeout(job.timer);
    error ? job.reject(error) : job.resolve(tab);
  };
  const onResult = (event, result) => {
    const job = pending.get(result?.requestId);
    if (!job || !isTrustedSender(event) || event.sender !== job.host) return;
    if (result.error) { finish(result.requestId, new Error(String(result.error))); return; }
    const guest = Number.isSafeInteger(result.webContentsId) && webContents.fromId(result.webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== job.host
      || guest.session !== job.session || job.previous.has(guest.id)) {
      finish(result.requestId, new Error("새 브라우저 탭의 프로필을 확인하지 못했습니다."));
      return;
    }
    const window = BrowserWindow.fromWebContents(job.host);
    finish(result.requestId, null, { id: guest.id, windowId: window?.id ?? -1, index: result.index ?? 0,
      active: job.active, highlighted: job.active, pinned: false, incognito: false,
      url: guest.getURL() || job.url, title: guest.getTitle(), status: guest.isLoading() ? "loading" : "complete" });
  };
  ipcMain.on(resultChannel, onResult);
  return {
    create(session, properties = {}) {
      const unsupported = Object.keys(properties).filter((key) => !["url", "active", "openerTabId", "windowId"].includes(key));
      if (unsupported.length) return Promise.reject(new Error(`지원하지 않는 tabs.create 옵션: ${unsupported.join(", ")}`));
      let url;
      try { url = new URL(properties.url || "about:blank"); } catch { return Promise.reject(new Error("탭 주소가 올바르지 않습니다.")); }
      if (!["https:", "http:"].includes(url.protocol) && url.href !== "about:blank") {
        return Promise.reject(new Error("확장은 HTTP(S) 주소와 빈 탭만 열 수 있습니다."));
      }
      const guests = webContents.getAllWebContents().filter((guest) => !guest.isDestroyed()
        && guest.getType() === "webview" && guest.session === session && guest.hostWebContents && !guest.hostWebContents.isDestroyed());
      const focused = BrowserWindow.getFocusedWindow?.();
      const candidates = guests.filter((guest) => properties.windowId === undefined
        || BrowserWindow.fromWebContents(guest.hostWebContents)?.id === properties.windowId);
      const opener = properties.openerTabId !== undefined ? candidates.find((guest) => guest.id === properties.openerTabId)
        : candidates.find((guest) => BrowserWindow.fromWebContents(guest.hostWebContents) === focused) || candidates[0];
      if (!opener) return Promise.reject(new Error("이 프로필의 브라우저 탭을 먼저 열어 주세요."));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const job = { resolve, reject, session, host: opener.hostWebContents, previous: new Set(guests.map((guest) => guest.id)),
          url: url.href, active: properties.active !== false };
        job.timer = setTimeout(() => finish(requestId, new Error("새 탭의 응답을 받지 못했습니다.")), timeoutMs);
        pending.set(requestId, job);
        try { job.host.send("ac-extension-create-tab", { requestId, openerWc: opener.id, url: url.href, active: job.active }); }
        catch (error) { finish(requestId, error); }
      });
    },
    dispose() {
      ipcMain.removeListener(resultChannel, onResult);
      for (const key of pending.keys()) finish(key, new Error("확장 프로그램 연결이 종료됐습니다."));
    },
  };
}

module.exports = { createExtensionTabs };
