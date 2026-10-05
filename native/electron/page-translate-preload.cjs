const { webFrame } = require("electron");

// 번역 컨텍스트만 Google에 연결한다. 페이지의 CSP와 Node 접근 권한은 바꾸지 않는다.
webFrame.setIsolatedWorldInfo(1777, {
  name: "Iris page translation",
  securityOrigin: "https://translate.googleapis.com",
  csp: "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src https://translate.googleapis.com https://translate-pa.googleapis.com; style-src 'none'; img-src 'none'",
});
