const { contextBridge, ipcRenderer } = require("electron");

// Iris 내부 Google 인증 확장 워커만. 메인이 보낸 탭별 세션 규칙을 워커 스크립트에 전달
const own = contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol === "chrome-extension:" && globalThis.location.pathname === "/iris-google-auth.js" });
if (own) {
  contextBridge.exposeInMainWorld("__irisGoogleAuthRules", {
    listen: (callback) => { ipcRenderer.on("iris-google-auth-rules", (_event, rules) => callback(rules)); },
  });
}
