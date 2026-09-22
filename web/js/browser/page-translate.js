// 현재 webview page를 사용자가 요청한 순간 한국어로 번역한다.
//
// 소유 범위
//   pagetranslate.page hook, 우클릭 action 등록, Google widget 주입 코드와 결과/toast mapping.
//
// 제공 API
//   initCapability(ctx). 검사가 쓰는 buildPageTranslateScript와 findGuestWebview도 내준다.
//
// 의존 대상
//   ctx.acHost의 범용 context-action bridge, ctx.getWebviewEntries(), ctx.showToast().
//
// 유지 조건
//   사용자가 메뉴를 누르기 전에는 page code나 외부 resource를 로드하지 않는다. http(s) top page만
//   대상으로 하고 CSP를 완화하거나 webRequest를 바꾸지 않는다. 실패는 구조화된 code로 끝나며
//   성공 toast는 ok=true일 때만 보인다. reload 복원을 위해 googtrans 지속 상태를 남기지 않는다.
//   위젯이 부분 번역한 뒤 실패해도 text/DOM은 원복하지 않고, 원문 복원은 reload로만 한다.
//
// 영향 범위
//   core/capabilities.js의 pagetranslate 행, main.js의 범용 listener/context, 네이티브 메뉴 bridge,
//   bin/smoke/sections/page-translate.mjs.

import { provide } from "../core/hooks.js";

export const TARGET_LANGUAGE = "ko";
export const GOOGLE_TRANSLATE_LOADER = "https://translate.google.com/translate_a/element.js?cb=";
const ACTION_NAME = "pagetranslate.page";
const PROVIDER_NAME = "pagetranslate.page";

const FAILURE_MESSAGES = {
  csp: "페이지 보안 정책 때문에 번역 서비스를 불러올 수 없습니다.",
  network: "번역 서비스에 연결하지 못했습니다.",
  timeout: "페이지 번역 시간이 초과되었습니다.",
  unsupported: "이 페이지는 번역할 수 없습니다.",
  "already-running": "페이지 번역이 이미 진행 중입니다.",
};

const translating = new WeakMap();

export function findGuestWebview(entries, guestWebContentsId) {
  const wanted = Number(guestWebContentsId);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  for (const [, record] of typeof entries === "function" ? entries() : []) {
    if (!record || !record.el) continue;
    let actual = Number(record.wc);
    if (!Number.isInteger(actual) || actual <= 0) {
      try { actual = Number(record.el.getWebContentsId()); } catch { actual = 0; }
    }
    if (actual === wanted) return record.el;
  }
  return null;
}

// 이 함수 전체가 문자열이 되어 guest main world에서 실행된다. 바깥 closure를 참조하지 않는다.
function pageTranslateBootstrap(options) {
  const stateKey = "__irisPageTranslateV1";
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return Promise.resolve({ ok: false, code: "unsupported", detail: "only http(s) pages are supported" });
  }
  const currentHref = String(location.href);
  const existing = window[stateKey];
  if (existing && existing.status === "running") {
    if (existing.href === currentHref && existing.promise) return existing.promise;
    return Promise.resolve({ ok: false, code: "already-running", detail: "translation is in progress" });
  }
  if (existing && existing.status === "done" && existing.href === currentHref && existing.result) {
    return Promise.resolve(existing.result);
  }

  const targetLanguage = options.targetLanguage;
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const callbackName = "__irisGoogleTranslateCallbackV1_" + token;
  const containerId = "iris-page-translate-v1-widget-" + token;
  const scriptId = "iris-page-translate-v1-loader-" + token;
  const timers = new Set();
  let settled = false;
  let cspSeen = false;
  let script = null;
  let container = null;
  let resolveResult;
  const googleArtifactSelector = '[class*="goog-te-"], .skiptranslate, script[src*="translate.google"], script[src*="gstatic.com"]';
  const originalGoogleArtifacts = new Set(document.querySelectorAll(googleArtifactSelector));
  const rootHadTranslatedLtr = document.documentElement.classList.contains("translated-ltr");
  const rootHadTranslatedRtl = document.documentElement.classList.contains("translated-rtl");
  const originalBodyTop = document.body ? document.body.style.top : "";
  const textSamples = [];
  try {
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (textSamples.length < 8 && (node = walker.nextNode())) {
        const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const parent = node.parentElement;
        if (parent && /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
        try {
          const style = parent && getComputedStyle(parent);
          if (style && (style.display === "none" || style.visibility === "hidden")) continue;
        } catch {}
        textSamples.push({ node, text });
      }
    }
  } catch {}
  const samplesAlreadyTargetLanguage = textSamples.length > 0 && textSamples.every(({ text }) =>
    /[\uac00-\ud7a3]/.test(text) && !/[A-Za-z]/.test(text));

  const state = { status: "running", href: currentHref, promise: null, result: null };
  window[stateKey] = state;

  function later(fn, delay) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function clearTranslationPersistence() {
    try {
      const expiry = "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; path=/";
      try { document.cookie = "googtrans" + expiry; } catch {}
      try {
        const parts = location.hostname.split(".").filter(Boolean);
        for (let i = 0; i < parts.length - 1; i++) {
          document.cookie = "googtrans" + expiry + "; domain=." + parts.slice(i).join(".");
        }
      } catch {}
      try { window.localStorage.removeItem("googtrans"); } catch {}
      try { window.sessionStorage.removeItem("googtrans"); } catch {}
    } catch {}
  }

  function removeListeners() {
    document.removeEventListener("securitypolicyviolation", onCsp, true);
    window.removeEventListener("error", onResourceError, true);
  }

  function cleanFailureArtifacts() {
    try { if (script) script.remove(); } catch {}
    try { if (container) container.remove(); } catch {}
    try {
      for (const node of document.querySelectorAll(googleArtifactSelector)) {
        if (!originalGoogleArtifacts.has(node)) node.remove();
      }
    } catch {}
    try {
      if (!rootHadTranslatedLtr) document.documentElement.classList.remove("translated-ltr");
      if (!rootHadTranslatedRtl) document.documentElement.classList.remove("translated-rtl");
      if (document.body) document.body.style.top = originalBodyTop;
    } catch {}
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    try { clearTimers(); } catch {}
    try { removeListeners(); } catch {}
    try { delete window[callbackName]; } catch {
      try { window[callbackName] = undefined; } catch {}
    }
    try {
      clearTranslationPersistence();
      if (result.ok) {
        state.status = "done";
        state.result = result;
      } else {
        cleanFailureArtifacts();
        if (window[stateKey] === state) delete window[stateKey];
      }
    } finally {
      if (typeof resolveResult === "function") resolveResult(result);
    }
  }

  function fail(code, detail) {
    finish({ ok: false, code, detail: String(detail || code).slice(0, 300) });
  }

  function onCsp(event) {
    const blocked = String(event && event.blockedURI || "");
    if (!/translate\.google|gstatic\.com/i.test(blocked)) return;
    cspSeen = true;
    fail("csp", blocked || String(event.violatedDirective || "security policy"));
  }

  function onResourceError(event) {
    const target = event && event.target;
    const url = String(target && (target.src || target.href) || "");
    if (!/translate\.google|gstatic\.com/i.test(url)) return;
    later(() => fail(cspSeen ? "csp" : "network", url || "resource load failed"), 0);
  }

  function waitForSelect(remaining) {
    if (settled) return;
    // select 요소는 옵션이 채워지기 전에 먼저 생긴다(Electron 43 확인 결과). 빈 select에 값을 넣으면
    // change가 무의미하게 나가고 번역은 시작되지 않으므로, 대상 언어 옵션이 채워질 때까지 기다린다.
    const select = container && container.querySelector("select.goog-te-combo");
    const ready = select && [...select.options].some((option) => option.value === targetLanguage);
    if (!ready) {
      if (remaining <= 0) {
        fail("unsupported", select ? "target language option was not offered" : "Google language selector was not created");
        return;
      }
      later(() => waitForSelect(remaining - 1), 100);
      return;
    }
    select.value = targetLanguage;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    waitForApplied(80);
  }

  function waitForApplied(remaining) {
    if (settled) return;
    const root = document.documentElement;
    const translatedClass = root.classList.contains("translated-ltr") || root.classList.contains("translated-rtl");
    const sampleChanged = textSamples.some(({ node, text }) =>
      node.isConnected === false || String(node.nodeValue || "").replace(/\s+/g, " ").trim() !== text);
    if (translatedClass && (sampleChanged || samplesAlreadyTargetLanguage)) {
      finish({ ok: true, code: "translated", detail: targetLanguage });
      return;
    }
    if (remaining <= 0) { fail("timeout", "translation was not applied"); return; }
    later(() => waitForApplied(remaining - 1), 100);
  }

  state.promise = new Promise((resolve) => {
    resolveResult = resolve;
    document.addEventListener("securitypolicyviolation", onCsp, true);
    window.addEventListener("error", onResourceError, true);
    clearTranslationPersistence();

    container = document.createElement("div");
    container.id = containerId;
    container.setAttribute("aria-hidden", "true");
    container.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;";
    (document.body || document.documentElement).appendChild(container);

    window[callbackName] = () => {
      try {
        const api = window.google && window.google.translate && window.google.translate.TranslateElement;
        if (typeof api !== "function") { fail("unsupported", "Google TranslateElement API is unavailable"); return; }
        new api({ pageLanguage: "auto", includedLanguages: targetLanguage, autoDisplay: false }, containerId);
        waitForSelect(40);
      } catch (error) {
        fail("unsupported", error && error.message || "widget initialization failed");
      }
    };

    script = document.createElement("script");
    script.id = scriptId;
    script.async = true;
    script.src = options.loaderUrl + encodeURIComponent(callbackName);
    script.onerror = () => later(() => fail(cspSeen ? "csp" : "network", script.src), 0);
    (document.head || document.documentElement).appendChild(script);
    later(() => fail(cspSeen ? "csp" : "timeout", "Google translation callback timed out"), 15000);
  });

  return state.promise;
}

export function buildPageTranslateScript(targetLanguage = TARGET_LANGUAGE) {
  const options = { targetLanguage, loaderUrl: GOOGLE_TRANSLATE_LOADER };
  return `(${pageTranslateBootstrap.toString()})(${JSON.stringify(options)})`;
}

export function normalizedResult(value) {
  try {
    if (!value || typeof value !== "object") {
      return { ok: false, code: "unsupported", detail: "invalid result" };
    }
    if (value.ok === true) {
      return { ok: true, code: String(value.code || "translated"), detail: String(value.detail || "") };
    }
    const code = Object.hasOwn(FAILURE_MESSAGES, value.code) ? value.code : "unsupported";
    return { ok: false, code, detail: String(value.detail || "") };
  } catch {
    return { ok: false, code: "unsupported", detail: "invalid result" };
  }
}

async function translateGuest(ctx, message) {
  const webview = findGuestWebview(ctx.getWebviewEntries, message && message.guestWebContentsId);
  if (!webview) return { ok: false, code: "unsupported", detail: "target webview was not found" };
  let url = "";
  try { url = webview.getURL(); } catch {}
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      return { ok: false, code: "unsupported", detail: "only http(s) pages are supported" };
    }
  } catch {
    return { ok: false, code: "unsupported", detail: "page URL is invalid" };
  }
  const active = translating.get(webview);
  if (active) {
    if (active.href === url) return active.promise;
    return { ok: false, code: "already-running", detail: "translation is in progress" };
  }

  const promise = (async () => {
    try {
      return normalizedResult(await webview.executeJavaScript(buildPageTranslateScript(TARGET_LANGUAGE), true));
    } catch (error) {
      return { ok: false, code: "unsupported", detail: String(error && error.message || error || "execution failed") };
    }
  })();
  translating.set(webview, { href: url, promise });
  try {
    return await promise;
  } finally {
    if (translating.get(webview)?.promise === promise) translating.delete(webview);
  }
}

export function initCapability(ctx) {
  const host = ctx.acHost || null;
  const showToast = typeof ctx.showToast === "function" ? ctx.showToast : () => {};

  provide(PROVIDER_NAME, async (message) => {
    const result = await translateGuest(ctx, message);
    if (result.ok) showToast("페이지를 한국어로 번역했습니다.");
    else {
      showToast(FAILURE_MESSAGES[result.code] || FAILURE_MESSAGES.unsupported);
      try { console.warn("[pagetranslate]", result.code, result.detail || ""); } catch {}
    }
    return result;
  });

  if (host && host.registerContextAction) {
    host.registerContextAction({ name: ACTION_NAME, label: "이 페이지 번역" });
  }
  return {};
}
