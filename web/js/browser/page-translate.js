// 주소창 번역과 자동 번역 설정.
// 소유 범위: webview 수명, 번역 상태, 프로필별 설정, 번역 메뉴 hook.
// 제공 API: initCapability, autoTranslatePreferenceKey, findGuestWebview, normalizedResult.
// 의존 대상: page-translate-ui/settings, core/hooks, acHost.pageTranslate와 webview 목록.
// 유지 조건: 번역 클릭 또는 저장한 자동 번역 설정이 있을 때만 본문을 외부로 보낸다.
// 영향 범위: native/electron/page-translate.cjs, core/capabilities.js, 페이지 번역 검사.
import { provide } from "../core/hooks.js";
import { createTranslateControls } from "./page-translate-ui.js";
import { TRANSLATE_SETTINGS_PREFIX, languageCode, languageOptions, translationSettings, saveTranslationSettings, detectPageLanguage } from "./page-translate-settings.js";

const AUTO_STORAGE_PREFIX = "iris.pageTranslate.auto.v1:";
const FAILURE_MESSAGES = {
  csp: "페이지 보안 정책 때문에 번역 서비스를 불러올 수 없습니다.",
  network: "번역 서비스에 연결하지 못했습니다.",
  timeout: "페이지 번역 시간이 초과되었습니다.",
  unsupported: "이 페이지는 번역할 수 없습니다.",
  "already-running": "페이지 번역이 이미 진행 중입니다.",
  storage: "자동 번역 설정을 저장하지 못했습니다.",
};
function pageUrl(webview) {
  try { return String(webview.getURL() || ""); } catch { return ""; }
}
function origin(webview) {
  try { const url = new URL(pageUrl(webview)); return /^https?:$/.test(url.protocol) ? url.origin : ""; } catch { return ""; }
}
function partition(webview) { return webview?.getAttribute("partition") || ""; }
export function autoTranslatePreferenceKey(webview) {
  const site = origin(webview);
  return site ? AUTO_STORAGE_PREFIX + JSON.stringify([partition(webview), site]) : "";
}
export function findGuestWebview(entries, guestWebContentsId) {
  const wanted = Number(guestWebContentsId);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  for (const [, record] of typeof entries === "function" ? entries() : []) {
    if (!record?.el) continue;
    let actual = Number(record.wc);
    if (!Number.isInteger(actual) || actual <= 0) {
      try { actual = Number(record.el.getWebContentsId()); } catch { actual = 0; }
    }
    if (actual === wanted) return record.el;
  }
  return null;
}
export function normalizedResult(value) {
  try {
    if (!value || typeof value !== "object") return { ok: false, code: "unsupported", detail: "invalid result" };
    return {
      ok: value.ok === true,
      code: value.ok === true ? String(value.code || "translated") : Object.hasOwn(FAILURE_MESSAGES, value.code) ? value.code : "unsupported",
      detail: String(value.detail || ""),
    };
  } catch { return { ok: false, code: "unsupported", detail: "invalid result" }; }
}

export function initCapability(ctx) {
  const host = ctx.acHost;
  const showToast = ctx.showToast || (() => {});
  const states = new WeakMap();
  const listeners = new Map();
  let active = null;
  let disposed = false;
  let storage;
  try { storage = window.localStorage; } catch {}
  const entries = () => typeof ctx.getWebviewEntries === "function" ? Array.from(ctx.getWebviewEntries()) : [];
  const prefs = (webview) => translationSettings(storage, partition(webview));
  const legacyEnabled = (webview) => {
    try { return storage?.getItem(autoTranslatePreferenceKey(webview)) === "ko"; } catch { return false; }
  };
  const controls = typeof document !== "undefined" ? createTranslateControls({
    onTranslate: () => run(active, "translate"),
    onRestore: () => run(active, "restore"),
    onPreference: changePreference,
    onTargetChange: changeTarget,
    onSourceChange(value) {
      const state = states.get(active);
      if (!state) return;
      state.source = languageCode(value);
      state.suppressed = false;
      render();
      void run(active, "translate");
    },
  }) : { update() {}, open() {}, close() {}, dispose() {} };

  function render() {
    const state = states.get(active);
    const settings = prefs(active);
    controls.update({
      visible: !!state && !!origin(active) && (state.hasText || state.manual) && (state.source !== state.target || state.manual || state.status !== "idle"),
      sourceLanguage: state?.source || "auto",
      targetLanguage: state?.target || settings.target,
      status: state?.status || "idle",
      error: state?.error || "",
      alwaysLanguage: settings.always.includes(state?.source),
      neverLanguage: settings.never.includes(state?.source),
      neverSite: settings.neverSites.includes(origin(active)),
      languages: languageOptions(),
    });
  }
  function report(result) {
    showToast(FAILURE_MESSAGES[result.code] || FAILURE_MESSAGES.unsupported, { level: "err" });
  }
  async function request(webview, op, state) {
    if (!origin(webview) || typeof host?.pageTranslate !== "function") return { ok: false, code: "unsupported" };
    try {
      return await host.pageTranslate({ wc: webview.getWebContentsId(), op, source: state.source, target: state.target });
    } catch (error) { return { ok: false, code: "network", detail: String(error?.message || error) }; }
  }
  async function run(webview, op) {
    const state = states.get(webview);
    if (!state || !origin(webview)) return { ok: false, code: "unsupported" };
    if (state.pending) return state.pending;
    if (op === "translate" && state.source === state.target) op = "restore";
    const generation = state.generation;
    const href = pageUrl(webview);
    state.manual = true;
    state.suppressed = op === "restore";
    state.status = "translating";
    state.error = "";
    render();
    const promise = (async () => {
      const raw = await request(webview, op, state);
      const result = normalizedResult(raw);
      if (disposed || generation !== state.generation) return result;
      if (href !== pageUrl(webview)) {
        Object.assign(state, { status: "idle", manual: false, hasText: false, source: "auto", attempted: false, error: "" });
        render();
        schedule(webview, state);
        return result;
      }
      state.status = result.ok ? op === "restore" ? "original" : "translated" : "error";
      state.error = result.ok ? "" : FAILURE_MESSAGES[result.code] || FAILURE_MESSAGES.unsupported;
      if (result.ok && raw.language && languageCode(raw.language) !== "auto") state.source = languageCode(raw.language);
      render();
      if (!result.ok && active === webview) controls.open({ focus: false });
      return result;
    })();
    state.pending = promise;
    try { return await promise; } finally { if (state.pending === promise) state.pending = null; }
  }
  function excluded(webview, state, settings) {
    return settings.neverSites.includes(origin(webview)) || settings.never.includes(state.source);
  }
  function maybeOffer(webview, state) {
    const settings = prefs(webview);
    if (!state.hasText || state.suppressed || excluded(webview, state, settings) || state.source === state.target) return;
    if (!state.attempted && (settings.always.includes(state.source) || legacyEnabled(webview))) {
      state.attempted = true;
      void run(webview, "translate");
    } else if (webview === active && !state.offered && state.status === "idle") {
      state.offered = true;
      controls.open({ focus: false });
    }
  }
  async function inspect(webview, state) {
    if (disposed || webview.isConnected === false || !origin(webview) || state.pending || state.status === "translated") return;
    const generation = state.generation;
    const href = pageUrl(webview);
    const result = await request(webview, "detect", state);
    if (disposed || generation !== state.generation || href !== pageUrl(webview) || result?.ok !== true || state.manual) return;
    const detected = detectPageLanguage(result);
    state.source = detected.language;
    state.hasText = detected.hasText;
    if (!state.hasText && ++state.detectAttempts < 4) schedule(webview, state, 500);
    render();
    maybeOffer(webview, state);
  }
  function schedule(webview, state, delay = 0) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { void inspect(webview, state); }, delay);
  }
  function observe() {
    const records = entries();
    const live = new Set(records.map(([, record]) => record?.el));
    for (const [webview, removers] of listeners) {
      if (live.has(webview)) continue;
      const state = states.get(webview);
      if (state) { state.generation++; clearTimeout(state.timer); }
      removers.forEach((remove) => remove());
      listeners.delete(webview);
      states.delete(webview);
    }
    for (const [, record] of records) {
      const webview = record?.el;
      if (!webview?.addEventListener || states.has(webview)) continue;
      const state = { target: prefs(webview).target, generation: 0, detectAttempts: 0, source: "auto", hasText: false, status: "idle", manual: false, offered: false, attempted: false, suppressed: false, pending: null, timer: null };
      states.set(webview, state);
      const removers = [];
      listeners.set(webview, removers);
      const listen = (name, fn) => {
        webview.addEventListener(name, fn);
        removers.push(() => webview.removeEventListener(name, fn));
      };
      const reset = () => {
        state.generation++;
        clearTimeout(state.timer);
        Object.assign(state, { target: prefs(webview).target, detectAttempts: 0, source: "auto", hasText: false, status: "idle", manual: false, offered: false, attempted: false, suppressed: false, pending: null, error: "" });
        if (webview === active) controls.close();
        render();
      };
      listen("did-start-navigation", (event) => { if (event.isMainFrame && !event.isInPlace) reset(); });
      listen("dom-ready", () => { reset(); schedule(webview, state); });
      listen("did-finish-load", () => schedule(webview, state));
      listen("did-navigate-in-page", (event) => { if (event.isMainFrame) schedule(webview, state, 150); });
      if (record.ready) schedule(webview, state);
    }
    const next = entries().find(([, record]) => record?.el?.classList?.contains("active"))?.[1]?.el || null;
    if (next !== active) { controls.close(); active = next; }
    render();
    const state = states.get(active);
    if (state) maybeOffer(active, state);
  }
  function save(webview, settings) {
    try { saveTranslationSettings(storage, partition(webview), settings); return true; }
    catch { report({ code: "storage" }); return false; }
  }
  function changePreference(key, enabled) {
    const webview = active;
    const state = states.get(webview);
    if (!state) return;
    const settings = prefs(webview);
    const field = { alwaysLanguage: "always", neverLanguage: "never", neverSite: "neverSites" }[key];
    if (!field) return;
    const value = field === "neverSites" ? origin(webview) : state.source;
    if (!value || value === "auto") return;
    settings[field] = settings[field].filter((entry) => entry !== value);
    if (enabled) settings[field].push(value);
    if (enabled && field !== "neverSites") {
      const opposite = field === "always" ? "never" : "always";
      settings[opposite] = settings[opposite].filter((entry) => entry !== value);
    }
    if (!save(webview, settings)) { render(); return; }
    if (enabled && key === "alwaysLanguage") { state.suppressed = false; state.attempted = false; }
    render();
    maybeOffer(webview, state);
  }
  function changeTarget(value) {
    const state = states.get(active);
    const target = languageCode(value);
    if (!state || target === "auto") return;
    const settings = prefs(active);
    settings.target = target;
    if (!save(active, settings)) { render(); return; }
    state.target = target;
    render();
    void run(active, "translate");
  }
  function fromMessage(message) {
    observe();
    return findGuestWebview(ctx.getWebviewEntries, message?.guestWebContentsId);
  }
  provide("pagetranslate.page", async (message) => {
    const webview = fromMessage(message);
    const state = states.get(webview);
    if (state) { state.manual = true; render(); if (active === webview) controls.open(); }
    const result = await run(webview, "translate");
    if (!result.ok) report(result);
    return result;
  });
  provide("pagetranslate.autoOn", async (message) => {
    const webview = fromMessage(message);
    const key = autoTranslatePreferenceKey(webview);
    if (!key) return { ok: false, code: "unsupported" };
    const settings = prefs(webview);
    settings.neverSites = settings.neverSites.filter((site) => site !== origin(webview));
    settings.never = settings.never.filter((language) => language !== states.get(webview)?.source);
    if (!save(webview, settings)) return { ok: false, code: "storage" };
    try { storage.setItem(key, "ko"); } catch { report({ code: "storage" }); return { ok: false, code: "storage" }; }
    return { ok: true, code: "auto-enabled", translation: await run(webview, "translate") };
  });
  provide("pagetranslate.autoOff", (message) => {
    const webview = fromMessage(message);
    try { storage.removeItem(autoTranslatePreferenceKey(webview)); } catch { report({ code: "storage" }); return { ok: false, code: "storage" }; }
    const state = states.get(webview);
    const settings = prefs(webview);
    const site = origin(webview);
    if (site && !settings.neverSites.includes(site)) settings.neverSites.push(site);
    if (!save(webview, settings)) return { ok: false, code: "storage" };
    if (state) state.suppressed = true;
    render();
    return { ok: true, code: "auto-disabled" };
  });
  host?.registerContextAction?.({ name: "pagetranslate.page", label: "이 페이지 번역" });
  host?.registerContextAction?.({ name: "pagetranslate.autoOn", label: "이 사이트 항상 번역" });
  host?.registerContextAction?.({ name: "pagetranslate.autoOff", label: "이 사이트 자동 번역 끄기" });
  observe();
  const stack = ctx.$?.("#wv-stack");
  let observer;
  if (stack && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(observe);
    observer.observe(stack, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  const onStorage = (event) => {
    if (!event.key || (!event.key.startsWith(TRANSLATE_SETTINGS_PREFIX) && !event.key.startsWith(AUTO_STORAGE_PREFIX))) return;
    render();
    for (const [, record] of entries()) {
      const state = states.get(record?.el);
      if (state) { state.attempted = false; maybeOffer(record.el, state); }
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return { dispose() {
    disposed = true;
    observer?.disconnect();
    listeners.forEach((removers) => removers.forEach((remove) => remove()));
    listeners.clear();
    for (const [, record] of entries()) clearTimeout(states.get(record?.el)?.timer);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    controls.dispose();
  } };
}
