const { contextBridge, ipcRenderer } = require("electron");

// Iris 내부 확장 워커에만 메인 프로세스와의 IPC 제공
const own = contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol === "chrome-extension:" && globalThis.location.pathname === "/iris-google-auth.js" });
if (own) {
  contextBridge.exposeInMainWorld("__irisGoogleAuthRules", {
    listen: (callback) => { ipcRenderer.on("iris-google-auth-rules", (_event, rules) => callback(rules)); },
  });
  contextBridge.exposeInMainWorld("__irisBrowserTabZoom", {
    listen: (callback) => { ipcRenderer.on("iris-browser-tab-zoom", (_event, tabId, requestId) => callback(tabId, requestId)); },
    reply: (requestId, error) => {
      if (Number.isSafeInteger(requestId)) ipcRenderer.send(`iris-browser-tab-zoom-reply-${requestId}`, error);
    },
  });
}
