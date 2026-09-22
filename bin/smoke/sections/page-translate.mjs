// 소유 범위: 페이지 번역 capability의 off/on 경계, 범용 menu bridge, guest 지목,
//   주입 singleton·scheme·실패 code·Google loader·한국어 대상·원문 복원용 지속 상태 정리.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core의 check/checkAsync/read, page-translate의 순수 export,
//   webview-context-actions의 Electron 비의존 registry.
// 유지 조건: 이 검사는 실제 외부 Google endpoint가 아니라 우리 경계를 판정한다.
//   endpoint와 widget DOM의 런타임 동작·reload 복원은 dev 앱에서 직접 확인해야 한다.
// 영향 범위: web/js/{core/capabilities,browser/page-translate,main}.js,
//   native/electron/{preload,main,webview-context-actions,webview-context-menu}.cjs.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/page-translate.mjs
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { check, checkAsync, read } from "../core.mjs";
import { callHook } from "../../../web/js/core/hooks.js";

const CAPABILITIES = read("web/js/core/capabilities.js");
const PAGE = read("web/js/browser/page-translate.js");
const WEB_MAIN = read("web/js/main.js");
const PRELOAD = read("native/electron/preload.cjs");
const NATIVE_MAIN = read("native/electron/main.cjs");
const MENU = read("native/electron/webview-context-menu.cjs");
const ACTIONS = read("native/electron/webview-context-actions.cjs");
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");

function segment(src, from, to) {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end < 0 ? src.length : end);
}

class FakeHost extends EventEmitter {
  constructor(id) { super(); this.id = id; this.dead = false; }
  isDestroyed() { return this.dead; }
  destroy() { this.dead = true; this.emit("destroyed"); }
}

let pageModule;
const translationEntries = new Map();

function createBootstrapHarness({ href = "https://example.test/article", text = "Hello world", changeText = true,
  storageThrows = false } = {}) {
  let currentHref = href;
  let scriptAppends = 0;
  const timers = [];
  const classes = new Set();
  const textNode = { nodeValue: text, parentElement: { tagName: "P" } };
  const select = {
    value: "",
    // 실물처럼 대상 언어 옵션이 포함되어 있어야 부트스트랩이 값을 넣는다(옵션 준비 대기 로직).
    options: [{ value: "" }, { value: "ko" }],
    dispatchEvent() {
      classes.add("translated-ltr");
      if (changeText) textNode.nodeValue = "한국어 번역";
    },
  };
  const container = {
    id: "",
    style: {},
    setAttribute() {},
    querySelector: () => select,
    remove() {},
  };
  const classList = {
    add: (name) => classes.add(name),
    contains: (name) => classes.has(name),
    remove: (name) => classes.delete(name),
  };
  const documentElement = { classList, appendChild() {} };
  const body = { style: { top: "" }, appendChild() {} };
  const document = {
    body,
    head: { appendChild() { scriptAppends++; } },
    documentElement,
    querySelectorAll: () => [],
    createTreeWalker() {
      let used = false;
      return { nextNode: () => used ? null : (used = true, textNode) };
    },
    createElement(tag) {
      if (tag === "div") return container;
      return { id: "", async: false, src: "", remove() {} };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(document, "cookie", { set() {} });
  const location = {};
  for (const [name, readValue] of [
    ["href", () => currentHref],
    ["protocol", () => new URL(currentHref).protocol],
    ["hostname", () => new URL(currentHref).hostname],
  ]) Object.defineProperty(location, name, { get: readValue });
  const window = {
    addEventListener() {},
    removeEventListener() {},
    google: { translate: { TranslateElement: function TranslateElement() {} } },
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { get() {
      if (storageThrows) throw new DOMException("storage blocked", "SecurityError");
      return { removeItem() {} };
    } });
  }
  const context = vm.createContext({
    window,
    document,
    location,
    NodeFilter: { SHOW_TEXT: 4 },
    Event: class Event { constructor(type, options) { this.type = type; this.bubbles = options?.bubbles; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout(fn, delay) {
      const timer = { fn, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.active = false; },
  });

  return {
    classes,
    textNode,
    get scriptAppends() { return scriptAppends; },
    setHref(next) { currentHref = next; },
    run() { return vm.runInContext(pageModule.buildPageTranslateScript(), context); },
    invokeLoader() {
      const name = Object.keys(window).find((key) => key.startsWith("__irisGoogleTranslateCallbackV1_"));
      if (!name) throw new Error("loader callback이 없다");
      window[name]();
    },
    runTimers(limit = 200) {
      let count = 0;
      while (timers.length && count++ < limit) {
        const timer = timers.shift();
        if (timer.active) timer.fn();
      }
      if (count >= limit) throw new Error("타이머가 종결되지 않았다");
    },
  };
}

export default async function run() {
console.log("[page-translate] 페이지 번역");

check("pagetranslate capability는 rail 없이 두 브라우저 창에서 동적으로만 실린다", () => {
  const ids = [...CAPABILITIES.matchAll(/id:\s*"pagetranslate"/g)];
  if (ids.length !== 1) throw new Error(`capability id가 ${ids.length}개다`);
  const block = segment(CAPABILITIES, 'id: "pagetranslate"', "  },");
  return /windows:\s*\["main",\s*"browser"\]/.test(block)
    && /files:\s*\["browser\/page-translate\.js"\]/.test(block)
    && /load:\s*\(\)\s*=>\s*import\("\.\.\/browser\/page-translate\.js"\)/.test(block)
    && !/\brail:|\bpanel:/.test(block)
    && !/^\s*import\s+[^(].*page-translate/m.test(CAPABILITIES);
});

check("pagetranslate.page 훅 caller/provider가 정확히 짝을 이룬다", () => {
  const providerName = /const PROVIDER_NAME\s*=\s*"([^"]+)"/.exec(bare(PAGE))?.[1];
  const provider = [...bare(PAGE).matchAll(/provide\(\s*PROVIDER_NAME\s*,/g)].length;
  const caller = [...bare(WEB_MAIN).matchAll(/callHook\(\s*message\.name\s*,\s*message\s*\)/g)].length;
  if (providerName !== "pagetranslate.page" || provider !== 1 || caller !== 1) {
    throw new Error(`name=${providerName}, provider=${provider}, generic caller=${caller}`);
  }
  if (!/onContextAction\s*&&\s*acHost\.onContextAction/.test(bare(WEB_MAIN))) {
    throw new Error("native action listener가 generic caller에 연결되지 않았다");
  }
  return true;
});

await checkAsync("capability가 켜질 때만 context action을 등록한다", async () => {
  const mod = await import(new URL("../../../web/js/browser/page-translate.js", import.meta.url).href);
  pageModule = mod;
  const registrations = [];
  // 모듈 import 자체는 capability off와 같은 상태다. 이때 등록 부작용이 없어야 한다.
  if (registrations.length) throw new Error("import만으로 action이 등록됐다");
  mod.initCapability({
    acHost: { registerContextAction: (action) => registrations.push(action) },
    getWebviewEntries: () => translationEntries,
    showToast: () => {},
  });
  if (registrations.length !== 1) throw new Error(`등록이 ${registrations.length}회다`);
  const action = registrations[0];
  if (action.name !== "pagetranslate.page" || action.label !== "이 페이지 번역") {
    throw new Error(JSON.stringify(action));
  }
  return true;
});

await checkAsync("non-http(s) guest는 주입을 실행하지 않고 거부한다", async () => {
  let executions = 0;
  translationEntries.clear();
  translationEntries.set("file", { wc: 71, el: {
    getURL: () => "file:///tmp/page.html",
    executeJavaScript: async () => { executions++; return { ok: true }; },
  } });
  const result = await callHook("pagetranslate.page", { guestWebContentsId: 71 });
  if (result?.ok !== false || result.code !== "unsupported" || executions !== 0) {
    throw new Error(JSON.stringify({ result, executions }));
  }
  return true;
});

await checkAsync("진행 중인 같은 page는 기존 결과를 기다리고 다른 page는 already-running을 받는다", async () => {
  let resolveExecution;
  let executions = 0;
  let url = "https://example.test/one";
  const execution = new Promise((resolve) => { resolveExecution = resolve; });
  const webview = {
    getURL: () => url,
    executeJavaScript: () => { executions++; return execution; },
  };
  translationEntries.clear();
  translationEntries.set("http", { wc: 72, el: webview });

  const first = callHook("pagetranslate.page", { guestWebContentsId: 72 });
  let sameSettled = false;
  const same = callHook("pagetranslate.page", { guestWebContentsId: 72 }).then((result) => {
    sameSettled = true;
    return result;
  });
  await Promise.resolve();
  if (sameSettled) throw new Error("같은 page 재호출이 기존 Promise를 기다리지 않았다");

  url = "https://example.test/two";
  const other = await callHook("pagetranslate.page", { guestWebContentsId: 72 });
  if (other?.code !== "already-running") throw new Error(`다른 page 결과: ${JSON.stringify(other)}`);

  resolveExecution({ ok: true, code: "translated", detail: "ko" });
  const [firstResult, sameResult] = await Promise.all([first, same]);
  if (!firstResult.ok || !sameResult.ok || executions !== 1) {
    throw new Error(JSON.stringify({ firstResult, sameResult, executions }));
  }
  return true;
});

await checkAsync("normalizedResult는 비정상 입력을 구조화된 unsupported로 안전하게 바꾼다", async () => {
  for (const value of [null, "bad", { ok: false, code: "unknown", detail: 17 }]) {
    const result = pageModule.normalizedResult(value);
    if (result.ok !== false || result.code !== "unsupported" || typeof result.detail !== "string") {
      throw new Error(JSON.stringify(result));
    }
  }
  const hostile = new Proxy({}, { get() { throw new Error("hostile getter"); } });
  const result = pageModule.normalizedResult(hostile);
  return result.ok === false && result.code === "unsupported";
});

await checkAsync("storage getter가 throw해도 번역 Promise는 반드시 결착된다", async () => {
  const harness = createBootstrapHarness({ storageThrows: true });
  const observed = harness.run().then((result) => ({ result }), (error) => ({ error }));
  let callbackError = null;
  try { harness.invokeLoader(); } catch (error) { callbackError = error; }
  const outcome = await observed;
  if (outcome.error) throw outcome.error;
  if (callbackError) throw callbackError;
  const result = outcome.result;
  if (!result?.ok) throw new Error(JSON.stringify(result));
  return true;
});

await checkAsync("translated class만 생겨서는 성공이 아니고 문구 변화까지 있어야 한다", async () => {
  const classOnly = createBootstrapHarness({ changeText: false });
  const failed = classOnly.run();
  classOnly.invokeLoader();
  classOnly.runTimers();
  const failedResult = await failed;
  if (failedResult.ok || failedResult.code !== "timeout") throw new Error(JSON.stringify(failedResult));

  const changed = createBootstrapHarness({ changeText: true });
  const passed = changed.run();
  changed.invokeLoader();
  const passedResult = await passed;
  if (!passedResult.ok) throw new Error(JSON.stringify(passedResult));

  const alreadyKorean = createBootstrapHarness({ text: "이미 한국어인 문서", changeText: false });
  const koreanResult = alreadyKorean.run();
  alreadyKorean.invokeLoader();
  if (!(await koreanResult).ok) throw new Error("이미 대상 언어인 문서를 실패로 판정했다");
  return true;
});

await checkAsync("SPA href가 바뀌면 이전 done 상태를 버리고 다시 번역한다", async () => {
  const harness = createBootstrapHarness();
  const first = harness.run();
  harness.invokeLoader();
  if (!(await first).ok) throw new Error("첫 번역 실패");

  harness.setHref("https://example.test/next");
  harness.textNode.nodeValue = "New SPA content";
  const second = harness.run();
  harness.invokeLoader();
  if (!(await second).ok || harness.scriptAppends !== 2) {
    throw new Error(`script 주입 ${harness.scriptAppends}회`);
  }
  return true;
});

await checkAsync("부트스트랩의 같은 href 재호출은 in-flight Promise를 재사용한다", async () => {
  const harness = createBootstrapHarness();
  const first = harness.run();
  const second = harness.run();
  if (first !== second || harness.scriptAppends !== 1) throw new Error("in-flight Promise를 재사용하지 않았다");
  harness.invokeLoader();
  const [a, b] = await Promise.all([first, second]);
  return a.ok && b.ok;
});

await checkAsync("context action registry는 값 검증·멱등 등록·host 정리를 지킨다", async () => {
  const mod = await import(new URL("../../../native/electron/webview-context-actions.cjs", import.meta.url).href);
  const create = mod.createWebviewContextActions || mod.default?.createWebviewContextActions;
  const registry = create();
  const host = new FakeHost(41);
  if (registry.register(host, { name: "bad name", label: "x" })) throw new Error("잘못된 이름을 받았다");
  if (registry.register(host, { name: "feature.action", label: "x\ny" })) throw new Error("줄바꿈 label을 받았다");
  if (!registry.register(host, { name: "feature.action", label: "첫 이름" })) throw new Error("정상 등록 실패");
  if (!registry.register(host, { name: "feature.action", label: "새 이름" })) throw new Error("멱등 재등록 실패");
  const actions = registry.get(host);
  if (actions.length !== 1 || actions[0].label !== "새 이름") throw new Error(JSON.stringify(actions));
  host.emit("did-start-loading");
  if (registry.get(host).length) throw new Error("renderer reload 뒤 이전 action이 남았다");
  if (!registry.register(host, { name: "feature.action", label: "다시 등록" })) throw new Error("reload 뒤 재등록 실패");
  host.destroy();
  if (registry.get(host).length) throw new Error("destroyed host의 action이 남았다");
  return true;
});

check("menu bridge는 trusted host 등록과 실제 guest id만 전달한다", () => {
  const main = bare(NATIVE_MAIN), menu = bare(MENU), preload = bare(PRELOAD);
  if (!/ipcMain\.on\("ac-context-action-register"[\s\S]*?isTrustedSender\(e\)[\s\S]*?register\(e\.sender, action\)/.test(main)) {
    throw new Error("trusted sender 등록 경계가 없다");
  }
  if (!/registerContextAction:\s*\(action\)\s*=>\s*ipcRenderer\.send\("ac-context-action-register"/.test(preload)
      || !/onContextAction:\s*\(listener\)/.test(preload)) throw new Error("preload 범용 bridge가 없다");
  if (!/getContextActions\(host\)/.test(menu)
      || !/host\.send\("ac-context-action",\s*\{\s*name:\s*action\.name,\s*guestWebContentsId:\s*wc\.id\s*\}\)/.test(menu)) {
    throw new Error("menu 조회 또는 guest id payload가 어긋났다");
  }
  return true;
});

check("http(s) scheme guard가 host와 guest 양쪽에 있다", () => {
  const guards = PAGE.match(/protocol\s*!==\s*"http:"\s*&&\s*(?:location\.)?protocol\s*!==\s*"https:"/g) || [];
  if (guards.length !== 2) throw new Error(`scheme guard가 ${guards.length}개다`);
  return /new URL\(url\)\.protocol/.test(PAGE) && /location\.protocol/.test(PAGE);
});

check("page singleton과 host in-flight 상태가 각각 한 자리에 있다", () => {
  return /__irisPageTranslateV1/.test(PAGE)
    && /existing\s*&&\s*existing\.status\s*===\s*"running"/.test(PAGE)
    && /code:\s*"already-running"/.test(PAGE)
    && /const translating = new WeakMap\(\)/.test(PAGE);
});

check("CSP·network·timeout·unsupported·already-running이 서로 다른 failure code다", () => {
  for (const code of ["csp", "network", "timeout", "unsupported", "already-running"]) {
    if (!new RegExp(`["']${code}["']`).test(PAGE)) throw new Error(`${code} code가 없다`);
  }
  const applied = segment(PAGE, "function waitForApplied", "state.promise = new Promise");
  if (!/fail\("timeout",\s*"translation was not applied"\)/.test(applied)) {
    throw new Error("번역 적용 timeout mapping이 없다");
  }
  return /securitypolicyviolation/.test(PAGE) && /script\.onerror/.test(PAGE);
});

check("loader URL·한국어 대상·widget selector가 한 경로로 고정됐다", () => {
  return /https:\/\/translate\.google\.com\/translate_a\/element\.js\?cb=/.test(PAGE)
    && /TARGET_LANGUAGE\s*=\s*"ko"/.test(PAGE)
    && /includedLanguages:\s*targetLanguage/.test(PAGE)
    && /select\.goog-te-combo/.test(PAGE);
});

check("실패 artifact와 googtrans 지속 상태를 정리한다", () => {
  return /cleanFailureArtifacts/.test(PAGE)
    && /script\.remove\(\)/.test(PAGE)
    && /container\.remove\(\)/.test(PAGE)
    && /document\.cookie\s*=\s*"googtrans"/.test(PAGE)
    && /removeItem\("googtrans"\)/.test(PAGE);
});

check("success toast는 ok=true 결과에만 대응한다", () => {
  const init = segment(PAGE, "export function initCapability", "return {};");
  return /if\s*\(result\.ok\)\s*showToast\("페이지를 한국어로 번역했습니다\."\)/.test(init)
    && /else\s*\{[\s\S]*FAILURE_MESSAGES\[result\.code\]/.test(init);
});

check("context-menu shell과 registry는 번역이나 page mutation을 소유하지 않는다", () => {
  const shell = bare(MENU + "\n" + ACTIONS);
  if (/executeJavaScript|insertCSS|insertText/.test(shell)) throw new Error("shell에 page mutation API가 있다");
  if (/pagetranslate|translate\.google|이 페이지 번역/.test(shell)) throw new Error("shell이 번역 기능 이름을 안다");
  return true;
});
}
