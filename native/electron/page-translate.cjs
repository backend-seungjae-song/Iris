const { randomUUID } = require("node:crypto");

const WORLD_ID = 1777;
const LOADER = "https://translate.googleapis.com/translate_a/element.js?cb=__irisTranslateReady&clc=__irisTranslateCSS&jlc=__irisTranslateJS&hl=ko";
const LANGUAGES = new Set("af sq am ar hy as ay az bm eu be bn bho bs bg ca ceb ny zh-CN zh-TW co hr cs da dv doi nl en eo et ee fil fi fr fy gl ka de el gn gu ht ha haw he hi hmn hu is ig ilo id ga it ja jv kn kk km rw gom ko kri ku ckb ky lo la lv ln lt lg lb mk mai mg ms ml mt mi mr mni-Mtei lus mn my ne no or om ps fa pl pt pa qu ro ru sm sa gd nso sr st sn sd si sk sl so es su sw sv tl tg ta tt te th ti ts tr tk ak uk ur ug uz vi cy xh yi yo zu und auto".split(" "));
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

function assetKind(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (url.hostname === "translate.googleapis.com" && (url.pathname === "/translate_a/element.js" || url.pathname.startsWith("/_/translate_http/_/js/"))) return "script";
    if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/_/translate_http/_/ss/")) return "style";
  } catch {}
  return null;
}

async function fetchAsset(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!assetKind(url)) throw new Error("unsupported translation resource");
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    credentials: "omit", redirect: "error", headers: { "Google-Translate-Element-Mode": "library" },
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) throw new Error("translation resource unavailable");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) { await reader.cancel(); throw new Error("translation resource too large"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function translationBootstrap(token) {
  if (window.__irisTranslation && !window.__irisTranslation.error) return { ok: true, token: window.__irisTranslation.token };
  window.__irisTranslation?.restore();
  let library;
  const state = { token, ready: false, finished: false, error: "", resources: [], generation: 0, language: "" };
  window.__irisTranslation = state;
  window.__irisTranslateJS = (url) => state.resources.push({ kind: "script", url });
  window.__irisTranslateCSS = (url) => state.resources.push({ kind: "style", url });
  window.__irisTranslateReady = () => {
    try {
      library = google.translate.TranslateService({ key: "", serverParams: "", timeInfo: { fetchStart: Date.now(), fetchEnd: Date.now() }, useSecureConnection: true });
      const deadline = Date.now() + 3000;
      const poll = () => {
        try {
          if (library.isAvailable()) state.ready = true;
          else if (Date.now() < deadline) setTimeout(poll, 50);
          else state.error = "timeout";
        } catch { state.error = "network"; }
      };
      poll();
    } catch { state.error = "network"; }
  };
  state.translate = (source, target) => {
    if (!state.ready) return { ok: false, code: "network" };
    const generation = ++state.generation;
    state.finished = false; state.error = "";
    try {
      library.translatePage(source, target, (_progress, finished, error) => {
        if (state.generation !== generation) return;
        state.finished = Boolean(finished);
        if (error) { state.error = error === 2 ? "unsupported" : "network"; library.restore(); }
        if (finished && !error) state.language = library.getDetectedLanguage?.() || source;
      });
      return { ok: true, generation };
    } catch { state.error = "network"; return { ok: false, code: "network" }; }
  };
  state.restore = () => {
    ++state.generation;
    library?.restore();
    state.finished = false; state.error = "";
    return { ok: true, code: "original" };
  };
  return { ok: true, token };
}

function createPageTranslate(deps) {
  const sessions = new Set();
  const registered = new Set();
  const pending = new Map();
  const cache = new Map();
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const preload = require.resolve("./page-translate-preload.cjs");
  function register(partition) {
    if (!deps.isProfilePartition(partition)) return;
    const session = deps.sessionFromPartition(partition);
    if (registered.has(session)) return;
    session.registerPreloadScript({ type: "frame", filePath: preload });
    registered.add(session); sessions.add(session);
  }
  deps.onSessionHardened(register);
  const ready = deps.app.whenReady().then(() => deps.forEachHardened(register));
  function target(event, id) {
    if (!deps.isTrustedSender(event) || !Number.isSafeInteger(id) || id <= 0) return null;
    const guest = deps.webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== event.sender || !sessions.has(guest.session)) return null;
    try { if (!/^https?:$/.test(new URL(guest.getURL()).protocol)) return null; } catch { return null; }
    return guest;
  }
  async function asset(url, signal) {
    const found = cache.get(url);
    if (found && Date.now() - found.at < 86400000) return found.text;
    const text = await fetchAsset(url, { fetchImpl, signal });
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), text });
    return text;
  }
  async function handle(event, payload = {}) {
    await ready;
    if (!payload || typeof payload !== "object") return { ok: false, code: "unsupported" };
    const wc = target(event, payload.wc);
    if (!wc || !["detect", "translate", "restore"].includes(payload.op)) return { ok: false, code: "unsupported" };
    if (payload.op === "detect") {
      try { return await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: "({ok:true,code:'detected',language:document.documentElement.lang||document.querySelector('meta[http-equiv=\"content-language\"]')?.content||'',text:(document.body?.innerText||'').slice(0,12000)})" }]); }
      catch { return { ok: false, code: "navigated" }; }
    }
    const run = (code) => wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
    if (payload.op === "restore") {
      pending.get(wc)?.abort();
      try { return await run("window.__irisTranslation?.restore()||{ok:true,code:'original'}"); }
      catch { return { ok: false, code: "navigated" }; }
    }
    const source = payload.source || "auto", language = payload.target || "ko";
    if (!LANGUAGES.has(source) || !LANGUAGES.has(language) || ["auto", "und"].includes(language)) return { ok: false, code: "unsupported" };
    if (source === language) {
      pending.get(wc)?.abort();
      try { return await run("window.__irisTranslation?.restore()||{ok:true,code:'original'}"); }
      catch { return { ok: false, code: "navigated" }; }
    }
    if (pending.has(wc)) return { ok: false, code: "already-running" };
    const controller = new AbortController(); pending.set(wc, controller);
    const href = wc.getURL();
    const deadline = Date.now() + 30000;
    let navigated = false, timedOut = false, activeToken = null, activeGeneration = null;
    let navigationRestore = Promise.resolve();
    const restoreActive = () => {
      if (!activeToken || wc.isDestroyed()) return Promise.resolve();
      return run(`(()=>{const state=window.__irisTranslation;if(state?.token===${JSON.stringify(activeToken)}&&(${activeGeneration === null ? "true" : `state.generation===${activeGeneration}`}))return state.restore();return null})()`).catch(() => null);
    };
    const cancelNavigation = (_event, _url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      navigated = true; controller.abort();
      navigationRestore = restoreActive();
    };
    const cancelDestroyed = () => { navigated = true; controller.abort(); };
    const operationTimer = setTimeout(() => { timedOut = true; controller.abort(); navigationRestore = restoreActive(); }, 30000);
    wc.on("did-start-navigation", cancelNavigation);
    wc.once("destroyed", cancelDestroyed);
    try {
      const initialized = await run(`(${translationBootstrap.toString()})(${JSON.stringify(randomUUID())})`);
      const token = initialized.token;
      activeToken = token;
      const scoped = async (code) => {
        if (controller.signal.aborted) throw new Error("canceled");
        if (wc.isDestroyed() || wc.getURL() !== href) throw new Error("navigated");
        const result = await run(`(()=>{const state=window.__irisTranslation;if(!state||state.token!==${JSON.stringify(token)})return {navigated:true};return (${code});})()`);
        if (result?.navigated) throw new Error("navigated");
        return result;
      };
      let status = await scoped("({ready:state.ready,error:state.error})");
      if (!status.ready) {
        const loader = await asset(LOADER, controller.signal);
        await scoped(`(()=>{${loader}\n;return null})()`);
        let resources = 0;
        while (Date.now() < deadline) {
          const queue = await scoped("state.resources.splice(0)");
          for (const resource of queue) {
            if (++resources > 8 || assetKind(resource.url) !== resource.kind) throw new Error("unsupported");
            const text = await asset(resource.url, controller.signal);
            if (resource.kind === "script") await scoped(`(()=>{${text}\n;return null})()`);
            else { await scoped("null"); await wc.insertCSS(text); }
          }
          status = await scoped("({ready:state.ready,error:state.error})");
          if (status.ready || status.error) break;
          await sleep(50);
        }
      }
      if (!status.ready || status.error) return { ok: false, code: status.error || "timeout" };
      await scoped("state.restore()");
      const started = await scoped(`state.translate(${JSON.stringify(source === "und" ? "auto" : source)},${JSON.stringify(language)})`);
      if (!started.ok) return started;
      activeGeneration = started.generation;
      while (Date.now() < deadline) {
        status = await scoped("({finished:state.finished,error:state.error,language:state.language,generation:state.generation})");
        if (status.generation !== started.generation) return { ok: false, code: "canceled" };
        if (status.error) return { ok: false, code: status.error };
        if (status.finished) return { ok: true, code: "translated", language: status.language, detail: language };
        await sleep(100);
      }
      await scoped("state.restore()");
      return { ok: false, code: "timeout" };
    } catch (error) {
      const code = navigated ? "navigated" : timedOut ? "timeout" : controller.signal.aborted ? "canceled" : ["unsupported", "navigated"].includes(error.message) ? error.message : "network";
      return { ok: false, code };
    } finally {
      clearTimeout(operationTimer);
      await navigationRestore;
      wc.removeListener("did-start-navigation", cancelNavigation);
      wc.removeListener("destroyed", cancelDestroyed);
      if (pending.get(wc) === controller) pending.delete(wc);
    }
  }
  deps.app.once("will-quit", () => { for (const controller of pending.values()) controller.abort(); });
  return { handle, ready };
}

function initCapability(ctx) {
  const service = createPageTranslate(ctx);
  ctx.ipcMain.handle("ac-page-translate", (event, payload) => service.handle(event, payload));
  return service;
}

module.exports = { initCapability, createPageTranslate, assetKind, fetchAsset };
