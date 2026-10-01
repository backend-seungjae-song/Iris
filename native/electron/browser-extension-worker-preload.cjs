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
    const event = (name) => {
      const callbacks = new Map();
      return {
        addListener(callback, filter, extraInfoSpec) {
          if (typeof callback !== "function") throw new TypeError("확장 이벤트에는 함수가 필요합니다.");
          if (callbacks.has(callback)) return;
          const token = String(++nextToken);
          callbacks.set(callback, token);
          listeners.set(token, callback);
          void bridge.invoke("subscribe", { token, name, filter, extraInfoSpec }).catch((error) => { callbacks.delete(callback); listeners.delete(token); console.error(`Iris ${name}:`, error); });
        },
        removeListener(callback) { const token = callbacks.get(callback); if (token) { callbacks.delete(callback); listeners.delete(token); void bridge.invoke("unsubscribe", { token, name }); } },
        hasListener: (callback) => callbacks.has(callback),
        hasListeners: () => callbacks.size > 0,
      };
    };
    chrome.webNavigation ||= {};
    if (!chrome.webNavigation.onCommitted?.addListener) chrome.webNavigation.onCommitted = event("webNavigation.onCommitted");
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
  } });
}
