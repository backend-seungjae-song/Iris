// 소유 범위: 페이지 번역 capability, 주소창 UI, 네이티브 bridge와 범용 context-menu의 연결.
// 제공 API: smoke 러너의 비동기 기본 run.
// 의존 대상: controller의 순수 export와 hook, Electron 비의존 context-action registry.
// 유지 조건: 실제 Google 번역 적용은 test/page-translate-native.mjs와 앱 화면 검사에서 확인한다.
import { EventEmitter } from "node:events";
import { check, checkAsync, read } from "../core.mjs";
import { callHook } from "../../../web/js/core/hooks.js";

const CAPABILITIES = read("web/js/core/capabilities.js");
const PAGE = read("web/js/browser/page-translate.js");
const UI = read("web/js/browser/page-translate-ui.js");
const WEB_MAIN = read("web/js/main.js");
const PRELOAD = read("native/electron/preload.cjs");
const NATIVE_MAIN = read("native/electron/main.cjs");
const NATIVE_CAPABILITIES = read("native/electron/capabilities.cjs");
const NATIVE_TRANSLATE = read("native/electron/page-translate.cjs");
const MENU = read("native/electron/webview-context-menu.cjs");
const ACTIONS = read("native/electron/webview-context-actions.cjs");
function segment(src, from, to) { const start = src.indexOf(from); if (start < 0) return ""; const end = src.indexOf(to, start + from.length); return src.slice(start, end < 0 ? src.length : end); }

export default async function run() {
  console.log("[page-translate] 페이지 번역");
  const pageModule = await import("../../../web/js/browser/page-translate.js");
  check("번역 기능은 두 브라우저 창에서 동적으로 로드되고 주소창 CSS를 소유한다", () => {
    const ids = [...CAPABILITIES.matchAll(/id:\s*"pagetranslate"/g)];
    const block = segment(CAPABILITIES, 'id: "pagetranslate"', "  },");
    return ids.length === 1 && /windows:\s*\["main",\s*"browser"\]/.test(block) && /native:\s*true/.test(block)
      && ["browser/page-translate.js", "browser/page-translate-ui.js", "browser/page-translate-settings.js", "42-page-translate.css"].every((name) => block.includes(name))
      && /load:\s*\(\)\s*=>\s*import\("\.\.\/browser\/page-translate\.js"\)/.test(block) && !/\brail:|\bpanel:/.test(block);
  });
  check("번역 hook은 범용 native action listener에서 호출된다", () => {
    return /provide\("pagetranslate\.page",/.test(PAGE)
      && /callHook\(\s*message\.name\s*,\s*message\s*\)/.test(WEB_MAIN)
      && /onContextAction\s*&&\s*acHost\.onContextAction/.test(WEB_MAIN);
  });
  check("controller는 widget 주입 없이 네이티브 번역과 원문 복원을 요청한다", () => {
    return /host\.pageTranslate\(\{\s*wc:\s*webview\.getWebContentsId\(\),\s*op,\s*source:\s*state\.source,\s*target:\s*state\.target\s*\}\)/.test(PAGE)
      && !/executeJavaScript|TranslateElement|translate_a\/element|buildPageTranslateScript|\.reload\(/.test(PAGE)
      && /run\(active,\s*"restore"\)/.test(PAGE);
  });
  check("번역 UI는 외국어 상태에서 주소창 버튼을 표시하고 입력 포커스를 보존한다", () => {
    return /button\.id\s*=\s*"wv-translate"/.test(UI) && /tools\.prepend\(button\)/.test(UI)
      && /button\.hidden\s*=\s*!state\.visible/.test(UI) && /if\s*\(focus\)/.test(UI)
      && /controls\.open\(\{\s*focus:\s*false\s*\}\)/.test(PAGE);
  });
  check("preload는 번역 IPC를 노출하고 native capability가 해당 경계를 등록한다", () => {
    return /pageTranslate:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\("ac-page-translate",\s*payload\)/.test(PRELOAD)
      && /ipcMain\.handle\("ac-page-translate"/.test(NATIVE_TRANSLATE)
      && /id:\s*"pagetranslate"/.test(NATIVE_CAPABILITIES) && /page-translate\.cjs/.test(NATIVE_CAPABILITIES)
      && /bootNativeCapabilities\(/.test(NATIVE_MAIN);
  });

  await checkAsync("켜진 capability만 번역 action 세 개를 등록한다", async () => {
    const registrations = [], entries = [], requests = [];
    const previousWindow = globalThis.window;
    const storage = new Map();
    globalThis.window = new EventTarget();
    window.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
    let capability;
    try {
      if (registrations.length) throw new Error("import만으로 action이 등록됐다");
      capability = pageModule.initCapability({ getWebviewEntries: () => entries, acHost: {
        registerContextAction: (action) => registrations.push(action),
        pageTranslate: (request) => { requests.push(request); return Promise.resolve({ ok: true, code: "translated" }); },
      } });
      if (registrations.length !== 3 || registrations[0].name !== "pagetranslate.page" || registrations[0].label !== "이 페이지 번역"
          || registrations[1].name !== "pagetranslate.autoOn" || registrations[2].name !== "pagetranslate.autoOff") throw new Error(JSON.stringify(registrations));
      const webview = new EventTarget();
      Object.assign(webview, { getURL: () => "file:///tmp/page.html", getWebContentsId: () => 71, getAttribute: () => "persist:test" });
      entries.push(["file", { el: webview, wc: 71 }]);
      const refused = await callHook("pagetranslate.page", { guestWebContentsId: 71 });
      if (refused?.ok !== false || refused.code !== "unsupported" || requests.length) throw new Error("비웹 문서가 네이티브 번역을 실행했다");
      webview.getURL = () => "https://example.test/article";
      const passed = await callHook("pagetranslate.page", { guestWebContentsId: 71 });
      if (!passed.ok || requests.length !== 1 || requests[0].wc !== 71 || requests[0].op !== "translate") throw new Error(JSON.stringify({ passed, requests }));
      return true;
    } finally { capability?.dispose(); globalThis.window = previousWindow; }
  });
  check("guest 판별과 기존 자동 번역 키는 프로필과 origin을 보존한다", () => {
    const el = { getURL: () => "https://example.test:8443/a", getAttribute: () => "persist:test", getWebContentsId: () => 72 };
    const entries = new Map([["tab", { el }]]);
    if (pageModule.findGuestWebview(() => entries, 72) !== el || pageModule.findGuestWebview(() => entries, 0)) throw new Error("guest 판별 실패");
    return pageModule.autoTranslatePreferenceKey(el) === 'iris.pageTranslate.auto.v1:' + JSON.stringify(["persist:test", "https://example.test:8443"]);
  });
  check("비정상 네이티브 결과와 throw하는 getter는 unsupported로 정규화한다", () => {
    for (const value of [null, "bad", { ok: false, code: "unknown", detail: 17 }, new Proxy({}, { get() { throw new Error("hostile getter"); } })]) {
      const result = pageModule.normalizedResult(value);
      if (result.ok || result.code !== "unsupported" || typeof result.detail !== "string") throw new Error(JSON.stringify(result));
    }
    return true;
  });
  await checkAsync("context action registry는 값 검증·멱등 등록·host 정리를 지킨다", async () => {
    const { createWebviewContextActions } = await import("../../../native/electron/webview-context-actions.cjs");
    const registry = createWebviewContextActions(), host = new EventEmitter();
    Object.assign(host, { id: 41, dead: false, isDestroyed: () => host.dead });
    if (registry.register(host, { name: "bad name", label: "x" }) || registry.register(host, { name: "feature.action", label: "x\ny" })) throw new Error("잘못된 action을 받았다");
    registry.register(host, { name: "feature.action", label: "처음" }); registry.register(host, { name: "feature.action", label: "변경" });
    if (registry.get(host).length !== 1 || registry.get(host)[0].label !== "변경") throw new Error("멱등 등록 실패");
    host.emit("did-start-loading"); if (registry.get(host).length) throw new Error("reload 뒤 action이 남았다");
    registry.register(host, { name: "feature.action", label: "재등록" }); host.dead = true; host.emit("destroyed");
    return registry.get(host).length === 0;
  });
  check("범용 메뉴 bridge는 신뢰받은 host의 실제 guest id를 전달한다", () => {
    return /ipcMain\.on\("ac-context-action-register"[\s\S]*?isTrustedSender\(e\)[\s\S]*?register\(e\.sender, action\)/.test(NATIVE_MAIN)
      && /registerContextAction:\s*\(action\)\s*=>\s*ipcRenderer\.send\("ac-context-action-register"/.test(PRELOAD)
      && /getContextActions\(host\)/.test(MENU)
      && /host\.send\("ac-context-action",\s*\{\s*name:\s*action\.name,\s*guestWebContentsId:\s*wc\.id\s*\}\)/.test(MENU);
  });
  check("context-menu shell과 registry는 번역이나 본문 변경을 소유하지 않는다", () => {
    const shell = MENU + "\n" + ACTIONS;
    return !/executeJavaScript|insertCSS|insertText|pagetranslate|translate\.google|이 페이지 번역/.test(shell);
  });
}
