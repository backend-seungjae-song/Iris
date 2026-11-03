// 페이지·읽기·캡처 명령 worker 경로 시험용: 가짜 페이지 시나리오 · 옛 처리기 실행기(cdp-control.cjs cdpExecRaw·cdpExecInner 원문을 vm 에서 실행) · worker 경로 대역
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { createWorkerHostTaskService } from "../../server/mcp-worker/host-task-service.js";
import { createWorkerBrowserService } from "../../server/mcp-worker/browser-service.js";
import { CONTROL_SOURCE, LEGACY_PARTS, pageOf, slice } from "./input-route-scenarios.mjs";

const require = createRequire(import.meta.url);
const refRegistry = require("../../native/electron/cdp-ref-registry.cjs");
const { createPageCommands } = require("../../native/electron/cdp-cmd-page.cjs");
const { createInspectCommands } = require("../../native/electron/cdp-cmd-inspect.cjs");
const { createCaptureCommands } = require("../../native/electron/cdp-cmd-capture.cjs");
const { createCdpCaptureTools } = require("../../native/electron/cdp-capture-tools.cjs");
const { createObservation } = require("../../native/electron/cdp-observation.cjs");
const { withLayout } = require("../../native/electron/cdp-layout.cjs");
const legacyHints = require("../../native/electron/cdp-hints.cjs");

// 실행마다 새 폴더를 쓰는 임시 위치 · IRIS_TEST_SCRATCH 로 바꿀 수 있음
export const SCRATCH = path.join(process.env.IRIS_TEST_SCRATCH || path.join(os.tmpdir(), "iris-page-route-test"), "/");
const WC_ID = 7;
const TOKEN = { wcId: WC_ID, documentGeneration: 3, debuggerGeneration: 4 };
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4 fake");
const value = (v) => ({ result: { value: v } });
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

// vm 에서 원문 그대로 실행하는 DRAW_MARKS (worker 사본 문자열과 대조)
export const LEGACY_DRAW_MARKS = (() => {
  const context = vm.createContext({});
  vm.runInContext(`${slice(CONTROL_SOURCE, "const DRAW_MARKS = function (spec) {", "// 요소를 찾은 프레임까지")}\nthis.__v = DRAW_MARKS;`, context);
  return context.__v;
})();

// 이미지 대역: 파일/버퍼 내용으로 크기와 비트맵을 정함 (diffPng·samePng 의 알고리즘은 메인에 그대로 있고 여기서는 같은 입력을 같게 넘기는지만 봄)
const imageOf = (bytes) => ({
  getSize: () => ({ width: 2, height: 1 }),
  toBitmap: () => Buffer.from([bytes[0] || 0, bytes[0] || 0, bytes[0] || 0, 255, bytes[1] || 0, bytes[1] || 0, bytes[1] || 0, 255]),
  toPNG: () => Buffer.from("PNG:" + Buffer.from(bytes).toString("hex")),
});
const fakeNativeImage = {
  createFromPath: (p) => imageOf(fs.readFileSync(p)),
  createFromBuffer: (b) => imageOf(b),
  createFromBitmap: (bitmap) => ({ toPNG: () => Buffer.from("BMP:" + Buffer.from(bitmap).toString("hex")) }),
};
class FakeWindow {
  constructor() { this.webContents = { executeJavaScript: async () => "data:image/png;base64," + PNG.toString("base64") }; }
  async loadURL() {}
  destroy() {}
}

// 장면 기본값: 보이는 탭, 그림 가능
const shownEnv = { attached: true, shown: true, paint: { ok: true }, url: "https://example.test/a", title: "예시", moments: [{ kind: "toast", text: "저장됨" }] };
const hiddenEnv = { ...shownEnv, shown: false };

// 기본 페이지 대역 · 공통 촬영 질의에 답함
const defaultEvaluate = (expression) => {
  if (expression.includes("b.style.zoom")) return value(JSON.stringify({ bz: "", hz: "", bt: "", on: false }));
  if (expression.includes("scrollX,y:scrollY")) return value(JSON.stringify({ x: 0, y: 0, width: 1280, height: 900, ratio: 2 }));
  if (expression === "document.readyState") return value("complete");
  return {};
};
const capturePage = (over = {}) => pageOf({
  evaluate: (expr, sid, params, n) => (over.evaluate ? over.evaluate(expr, sid, params, n) : null) ?? defaultEvaluate(expr),
  extra: {
    "Page.captureScreenshot": () => ({ data: PNG.toString("base64") }),
    "Page.getLayoutMetrics": () => ({ cssContentSize: { width: 1280, height: 900 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 900 } }),
    ...(over.extra || {}),
  },
  innerWidth: over.innerWidth,
});

const evalValue = (v) => value(v);
const jsonValue = (v) => value(JSON.stringify(v));

// 시나리오: args 는 값 또는 (dir) => 값. setup(dir) 은 실행 폴더 안에 파일을 만듦
export const SCENARIOS = [
  // 페이지
  { name: "goto-shown", cmd: "goto", args: { url: "https://example.test/next" }, env: shownEnv, page: () => capturePage() },
  { name: "goto-schemeless", cmd: "goto", args: { url: "example.test/x" }, env: shownEnv, page: () => capturePage() },
  { name: "goto-hidden-tab-hold", cmd: "goto", args: { url: "https://example.test/next" }, env: hiddenEnv, page: () => capturePage() },
  { name: "goto-no-url", cmd: "goto", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "goto-load-error", cmd: "goto", args: { url: "https://bad.test/" }, env: { ...shownEnv, loadError: "ERR_NAME_NOT_RESOLVED (-105) loading 'https://bad.test/'" }, page: () => capturePage() },
  { name: "goto-to-google-auth", cmd: "goto", args: { url: "https://accounts.google.com/signin" }, env: { ...shownEnv, google: "accounts.google.com" }, page: () => capturePage() },
  { name: "goto-on-blocked-host", cmd: "goto", args: { url: "https://example.test/back" }, env: { ...shownEnv, blockedHost: true }, page: () => capturePage() },
  { name: "wait-ms", cmd: "wait", args: { ms: 5 }, env: shownEnv, page: () => capturePage() },
  { name: "wait-ready", cmd: "wait", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "wait-loading-then-ready", cmd: "wait", args: {}, env: shownEnv,
    page: () => capturePage({ evaluate: (() => { let n = 0; return (expr) => (expr === "document.readyState" ? value(++n < 2 ? "loading" : "complete") : null); })() }) },
  { name: "wait-nocdp-ms", cmd: "wait", args: { ms: 5 }, env: { ...shownEnv, blockedHost: true }, page: () => capturePage() },
  { name: "wait-nocdp-loading", cmd: "wait", args: {}, env: { ...shownEnv, blockedHost: true, loading: [true, false] }, page: () => capturePage() },
  { name: "back-ok", cmd: "back", args: {}, env: { ...shownEnv, canBack: true, backUrl: "https://example.test/prev" }, page: () => capturePage() },
  { name: "back-none", cmd: "back", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "forward-ok", cmd: "forward", args: {}, env: { ...shownEnv, canForward: true, forwardUrl: "https://example.test/fwd" }, page: () => capturePage() },
  { name: "forward-none", cmd: "forward", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "back-hidden-tab-hold", cmd: "back", args: {}, env: { ...hiddenEnv, canBack: true, backUrl: "https://example.test/prev" }, page: () => capturePage() },
  { name: "reload-ok", cmd: "reload", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "reload-on-blocked-host", cmd: "reload", args: {}, env: { ...shownEnv, blockedHost: true }, page: () => capturePage() },
  { name: "viewport-set", cmd: "viewport", args: { width: 390, height: 844, dpr: 3 }, env: { ...shownEnv, viewportResult: { ok: true, width: 390, height: 844, device: "phone", dpr: 3, reloaded: false } }, page: () => capturePage() },
  { name: "viewport-clear", cmd: "viewport", args: { clear: true }, env: { ...shownEnv, viewportResult: { ok: true, cleared: true, reloaded: false } }, page: () => capturePage() },
  { name: "viewport-in-band-failure", cmd: "viewport", args: { width: 1, height: 1 }, env: { ...shownEnv, viewportResult: { ok: false, error: "크기가 너무 작습니다" } }, page: () => capturePage() },
  // 읽기
  { name: "eval-value", cmd: "eval", args: { expression: "1+1" }, env: shownEnv, page: () => capturePage({ evaluate: (expr) => (expr === "1+1" ? evalValue(2) : null) }) },
  { name: "eval-undefined", cmd: "eval", args: { expression: "void 0" }, env: shownEnv, page: () => capturePage({ evaluate: () => ({ result: {} }) }) },
  { name: "eval-exception", cmd: "eval", args: { expression: "boom()" }, env: shownEnv,
    page: () => capturePage({ evaluate: () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } }) }) },
  { name: "eval-on-blocked-host", cmd: "eval", args: { expression: "1" }, env: { ...shownEnv, blockedHost: true }, page: () => capturePage() },
  { name: "eval-redacts-secret", cmd: "eval", args: { expression: "pw" }, env: { ...shownEnv, secret: "hunter2-pw" }, page: () => capturePage({ evaluate: () => evalValue("비밀번호 hunter2-pw") }) },
  { name: "text-cdp", cmd: "text", args: {}, env: shownEnv, page: () => capturePage({ evaluate: (expr) => (expr.includes("__acDocs") ? value("본문 글") : null) }) },
  { name: "text-iframe", cmd: "text", args: {}, frames: ["frame-1"], env: shownEnv,
    page: () => capturePage({ evaluate: (expr, sid) => (expr.includes("__acDocs") ? value(sid ? "프레임 글" : "본문 글") : null) }) },
  { name: "text-nocdp", cmd: "text", args: {}, env: { ...shownEnv, blockedHost: true, exec: () => "로그인 화면 글" }, page: () => capturePage() },
  { name: "text-nocdp-exec-fails", cmd: "text", args: {}, env: { ...shownEnv, blockedHost: true, exec: () => { throw new Error("nope"); } }, page: () => capturePage() },
  { name: "locate-unique", cmd: "locate", args: { sel: "#save" }, env: shownEnv,
    page: () => capturePage({ evaluate: (expr) => (expr.includes("const spec") ? jsonValue({ how: "css", total: 1, visibleCount: 1, count: 1, url: "https://example.test/a", title: "예시", tag: "button", role: "button", name: "저장", visible: true, inViewport: true, occluded: false, text: "저장", disabled: false }) : null) }) },
  { name: "locate-empty", cmd: "locate", args: {}, env: shownEnv, page: () => capturePage({ evaluate: (expr) => (expr.includes("const spec") ? jsonValue({ error: "locator가 비어 있다 — testid·role/name·sel 중 하나가 필요하다" }) : null) }) },
  { name: "locate-iframe-ambiguous", cmd: "locate", args: { role: "button", name: "결제" }, frames: ["frame-1"], env: shownEnv,
    page: () => capturePage({ evaluate: (expr, sid) => (expr.includes("const spec") ? jsonValue({ how: "role+name", total: 1, visibleCount: 1, count: 1, url: "https://example.test/a", title: "예시", tag: "button", role: "button", name: sid ? "결제" : "결제 취소", visible: true, inViewport: true, occluded: false, text: "", disabled: false }) : null) }) },
  { name: "observe-default", cmd: "observe", args: {}, env: { ...shownEnv, observed: { console: [{ level: "error", text: "x" }], exceptions: [], network: [], dialogs: [], moments: [], fileChooser: null, counts: { consoleErrors: 1 } } }, page: () => capturePage() },
  { name: "observe-no-screenshot-clear", cmd: "observe", args: { screenshot: false, clear: true, level: "all", limit: 5 },
    env: { ...shownEnv, download: { dir: "/d", once: true, last: null, pending: "a.zip" }, observed: { console: [], exceptions: [], network: [], dialogs: [], moments: [], fileChooser: { mode: "multiple" }, counts: {} } }, page: () => capturePage() },
  { name: "observe-screenshot-fails", cmd: "observe", args: {}, env: { ...shownEnv, observed: { console: [], exceptions: [], network: [], dialogs: [], moments: [], fileChooser: null, counts: {} } },
    page: () => capturePage({ extra: { "Page.captureScreenshot": () => { throw new Error("capture 불가"); } } }) },
  // 캡처
  { name: "diff-ok", cmd: "diff", args: (dir) => ({ before: `${dir}/a.png`, after: `${dir}/b.png`, threshold: 10 }), setup: (dir) => { fs.writeFileSync(`${dir}/a.png`, Buffer.from([10, 20])); fs.writeFileSync(`${dir}/b.png`, Buffer.from([10, 90])); }, env: shownEnv, page: () => capturePage() },
  { name: "diff-missing-file", cmd: "diff", args: (dir) => ({ before: `${dir}/none.png`, after: `${dir}/none2.png` }), env: shownEnv, page: () => capturePage() },
  { name: "screenshot-shown", cmd: "screenshot", args: {}, env: shownEnv, page: () => capturePage() },
  { name: "screenshot-path-dpr", cmd: "screenshot", args: (dir) => ({ path: `${dir}/out/custom.png`, dpr: 3 }), env: shownEnv, page: () => capturePage() },
  { name: "screenshot-marks-caption", cmd: "screenshot", args: { mark: [{ sel: "#save", label: "저장", color: "#1B6B4A" }, { ref: "@e1" }, { sel: "#none" }], mask: ["#pw"], caption: "확인" },
    refs: { "@e1": { backendDOMNodeId: 11, role: "button", name: "저장", sid: null } }, env: shownEnv,
    page: () => capturePage({ evaluate: (expr) => (expr.includes("getBoundingClientRect") && expr.includes("__acQA") ? ({ result: { value: expr.includes("#none") ? null : { x: 1, y: 2, w: 30, h: 40 } } }) : expr.includes("__ac_marks__") && expr.includes("boxes") ? value(2) : null) }) },
  { name: "screenshot-ref-no-snapshot", cmd: "screenshot", args: { mark: [{ ref: "@zz" }] }, env: shownEnv, page: () => capturePage() },
  { name: "screenshot-ref-in-iframe-skipped", cmd: "screenshot", args: { mark: [{ ref: "@e1" }] }, refs: { "@e1": { backendDOMNodeId: 21, role: "button", name: "결제", sid: "frame-1" } }, env: shownEnv, page: () => capturePage() },
  { name: "screenshot-element-missing", cmd: "screenshot", args: { element: "#nope" }, env: shownEnv, page: () => capturePage({ evaluate: (expr) => (expr.includes("const el = __acQ(") ? value(null) : null) }) },
  { name: "screenshot-zoomed-page", cmd: "screenshot", args: {}, env: shownEnv,
    page: () => capturePage({ evaluate: (expr) => (expr.includes("b.style.zoom") ? value(JSON.stringify({ bz: "1.5", hz: "", bt: "", on: true })) : null) }) },
  { name: "screenshot-hidden-layout", cmd: "screenshot", args: {}, env: hiddenEnv, page: () => capturePage({ innerWidth: 0 }) },
  { name: "screenshot-full-stitch", cmd: "screenshot", args: { full: true }, env: shownEnv, page: () => capturePage({ evaluate: (expr) => (expr.includes("scrollTo(0,") && expr.includes("new Promise") ? value(0) : null) }) },
  { name: "screenshot-held-fallback", cmd: "screenshot", args: {}, env: hiddenEnv,
    page: () => capturePage({ extra: { "Page.captureScreenshot": (() => { let n = 0; return () => { if (++n === 1) throw new Error("slow"); return { data: PNG.toString("base64") }; }; })() } }) },
  { name: "screenshot-all-fail-capturepage", cmd: "screenshot", args: {}, env: shownEnv, screencast: false,
    page: () => capturePage({ extra: { "Page.captureScreenshot": () => { throw new Error("slow"); } } }) },
  { name: "screenshot-screencast", cmd: "screenshot", args: {}, env: shownEnv, screencast: true,
    page: () => capturePage({ extra: { "Page.captureScreenshot": () => { throw new Error("slow"); } } }) },
  { name: "screenshot-same-as", cmd: "screenshot", args: (dir) => ({ sameAs: `${dir}/prev.png` }), setup: (dir) => { fs.writeFileSync(`${dir}/prev.png`, PNG); }, env: shownEnv, page: () => capturePage() },
  { name: "screenshot-window-not-drawing", cmd: "screenshot", args: {}, env: { ...shownEnv, paint: { ok: false, why: "최소화" } }, page: () => capturePage() },
  { name: "screenshot-nocdp", cmd: "screenshot", args: {}, env: { ...shownEnv, blockedHost: true }, page: () => capturePage() },
  { name: "pdf-ok", cmd: "pdf", args: { landscape: true, scale: 5, pages: "1-2", background: false }, env: shownEnv, page: () => capturePage() },
  { name: "pdf-empty", cmd: "pdf", args: {}, env: { ...shownEnv, emptyPdf: true }, page: () => capturePage() },
  { name: "shotsizes-default", cmd: "shotsizes", args: { settle: 1 }, env: shownEnv, page: () => capturePage() },
  { name: "shotsizes-custom-bad", cmd: "shotsizes", args: { sizes: ["1024x768", "엉뚱"], settle: 1, caption: "반응형", dpr: 2 }, env: shownEnv, page: () => capturePage() },
];

const resolveArgs = (scenario, dir) => (typeof scenario.args === "function" ? scenario.args(dir) : scenario.args);
const mask = (env, v) => (env.secret ? JSON.parse(JSON.stringify(v ?? null).split(env.secret).join("••••")) : v);
const failure = (error) => ({ ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) });

// 실행 폴더 안에 쓰인 파일을 이름·내용 해시로 나열 (시각 이름은 가림)
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push({ file: normalize(path.relative(root, full)), bytes: fs.readFileSync(full).toString("hex") });
    }
  };
  walk(root);
  return out;
}
const normalize = (text) => String(text).replace(/\b(shot|diff|page)-\d{10,}/g, "$1-<T>");
const normalizer = (root) => (text) => normalize(String(text).split(root).join("<RUN>"));
// 기다린 시간은 실행마다 달라 가림 (고정 시간 wait 의 값은 인자와 같아야 하므로 그대로 둠)
function normalizeDeep(value, root, scenario) {
  const n = normalizer(root);
  const text = n(JSON.stringify(value));
  return JSON.parse(scenario && scenario.args?.ms == null ? text.replace(/"waited_ms":\d+/g, '"waited_ms":"<T>"') : text);
}

class Emitter {
  constructor() { this.listeners = new Map(); }
  on(event, fn) { this.listeners.set(event, [...(this.listeners.get(event) || []), fn]); }
  removeListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) || []).filter((item) => item !== fn)); }
  emit(event, ...args) { for (const fn of [...(this.listeners.get(event) || [])]) fn({}, ...args); }
}

// 메인 쪽 환경 대역: 옛 경로와 worker 경로가 같은 webContents·촬영 도구·페이지를 씀
function createWorld(scenario, root) {
  const env = scenario.env;
  const effects = [];
  const page = scenario.page();
  const events = new Emitter();
  const shotsDir = path.join(root, "artifacts", "shots");
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, "work");
  fs.mkdirSync(dir, { recursive: true });
  if (scenario.setup) scenario.setup(dir);
  const args = clone(resolveArgs(scenario, dir));
  refRegistry.clear(WC_ID);
  if (scenario.refs) refRegistry.recordSnapshot(WC_ID, new Map(Object.entries(scenario.refs)));
  const loading = [...(env.loading || [])];

  const raw = async (method, params, sid) => {
    effects.push(["cdp", method, clone(params ?? {}), sid || null]);
    return clone(await page(method, params ?? {}, sid || null));
  };
  const state = { url: env.url, title: env.title };
  const wc = {
    id: WC_ID,
    isDestroyed: () => false,
    debugger: { isAttached: () => env.attached !== false },
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => (loading.length ? loading.shift() : false),
    async loadURL(url) { effects.push(["wc.loadURL", url]); if (env.loadError) throw new Error(env.loadError); state.url = url; },
    reload() { effects.push(["wc.reload"]); setImmediate(() => events.emit("did-navigate")); },
    goBack() { effects.push(["wc.goBack"]); },
    goForward() { effects.push(["wc.goForward"]); },
    navigationHistory: {
      canGoBack: () => env.canBack === true,
      canGoForward: () => env.canForward === true,
      goBack() { effects.push(["wc.goBack"]); state.url = env.backUrl; setImmediate(() => events.emit("did-navigate")); },
      goForward() { effects.push(["wc.goForward"]); state.url = env.forwardUrl; setImmediate(() => events.emit("did-navigate")); },
    },
    on: (event, fn) => events.on(event, fn),
    removeListener: (event, fn) => events.removeListener(event, fn),
    executeJavaScript: async (source, gesture) => { effects.push(["wc.exec", source, gesture]); return clone(env.exec ? env.exec(source) : null); },
    capturePage: async (rect) => { effects.push(["wc.capturePage", rect ?? null]); return { toPNG: () => PNG }; },
    printToPDF: async (options) => { effects.push(["wc.printToPDF", clone(options)]); return env.emptyPdf ? Buffer.alloc(0) : PDF; },
  };

  const tools = createCdpCaptureTools({ refRegistry, fs, path, nativeImage: fakeNativeImage, BrowserWindow: FakeWindow });
  const screencastShot = async () => {
    effects.push(["screencastShot"]);
    if (scenario.screencast !== true) throw new Error("screencast-slow");
    return PNG;
  };
  const googleHost = (url) => !!env.google && String(url).includes(env.google);
  const observed = (level, limit) => { effects.push(["obs.observe", level, limit]); return clone(env.observed); };
  return { env, effects, page, wc, tools, screencastShot, shotsDir, dir, args, raw, state, googleHost, observed, root };
}

// 옛 경로: cdp-control.cjs 의 cdpExecRaw·cdpExecInner 원문을 vm 에서 실행 · 바깥 상태는 대역
export async function runLegacy(scenario, root) {
  const world = createWorld(scenario, root);
  const { env, effects, wc, tools, shotsDir, raw, args } = world;
  const send = (method, params) => raw(method, params, null);
  send.on = (sid) => (method, params) => raw(method, params, sid || null);
  send.frames = () => [null, ...(scenario.frames || [])];
  send.ask = (sid, method, params) => send.on(sid)(method, params).catch(() => null);
  send.all = async (method, params) => (await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)))).filter((r) => r != null);

  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${LEGACY_PARTS.prelude}${LEGACY_PARTS.consts}`, context);
  const observation = createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  const captureHold = async (_id, on) => { effects.push(["hold", on]); return true; };
  const handlers = Object.assign(Object.create(null), {
    ...createPageCommands({ applyViewport: async (_wc, viewportArgs) => { effects.push(["viewport.apply", clone(viewportArgs)]); return clone(env.viewportResult); } }),
    ...createInspectCommands({
      buildSnapshot: null, refRegistry, loginHint: legacyHints.loginHint, humanHint: legacyHints.humanHint,
      observation: { observe: (_id, level, limit) => world.observed(level, limit), clearDiagnostics: () => effects.push(["obs.clear"]) },
      downloadState: { snapshot: () => clone(env.download ?? { dir: null, once: false, last: null, pending: null }) },
      cdpExecRaw: (mod, id, cmd, cmdArgs) => sandbox.__cdpExecRaw(mod, id, cmd, cmdArgs),
      webContentsMod: () => ({ fromId: () => wc }),
      fs, path, shotsDir,
    }),
    ...createCaptureCommands({
      withLayout, rectOf: tools.rectOf, readZoom: tools.readZoom, setZoom: tools.setZoom, DRAW_MARKS: LEGACY_DRAW_MARKS,
      viewportClip: tools.viewportClip, waitRenderIdle: tools.waitRenderIdle, captureHold, stitchFullPage: tools.stitchFullPage,
      screencastShot: world.screencastShot, resetCdpSession: () => { effects.push(["resetCdpSession"]); },
      pruneShots: tools.pruneShots, diffPng: tools.diffPng, samePng: tools.samePng,
      deviceEmulation: { apply: async (_wc, viewportArgs) => { effects.push(["viewport.apply", clone(viewportArgs)]); return clone(env.viewportResult); } },
      cdpExecRaw: (mod, id, cmd, cmdArgs) => sandbox.__cdpExecRaw(mod, id, cmd, cmdArgs),
      webContentsMod: () => ({ fromId: () => wc }),
      fs, path, shotsDir,
    }),
  });
  Object.assign(sandbox, {
    qaLedgerAnchor: async () => ({ ok: true }),
    contextActionCommand: async () => ({}),
    commandWebContentsMods: new WeakMap(),
    detachIdle: () => { effects.push(["detachIdle"]); },
    detachAiSession: () => { effects.push(["detachAiSession"]); return false; },
    isTabShown: () => env.shown === true,
    pressAllowed: async () => false,
    paintableProbe: () => env.paint,
    captureHold,
    observation,
    attachPolicy: { blocked: () => env.blockedHost === true, touch() {}, release() {} },
    isGoogleAuthUrl: world.googleHost,
    identityOwnsDebugger: () => false,
    cdpSession: { primed: () => false },
    enterAiCommand: (id, cmd) => { const read = ["snapshot", "text", "url", "tabs", "shotsizes", "screenshot", "diff", "a11y", "locate", "expect", "observe"].includes(cmd); if (!read) effects.push(["ai.enter"]); return read ? null : id; },
    leaveAiCommand: (ticket) => { if (ticket != null) effects.push(["ai.leave"]); },
    ensureAttached: () => send,
    ensureQaReady: async (_s, _w, cmd) => { effects.push(["ensureReady", cmd]); },
    runCdpCmd: async (s, w, cmd, cmdArgs) => handlers[cmd](s, w, cmdArgs),
    commandHandlers: handlers,
    fs, path, SHOTS_DIR: shotsDir, pruneShots: tools.pruneShots,
  });
  vm.runInContext(`${LEGACY_PARTS.exec}\nthis.__cdpExecRaw = cdpExecRaw;`, context);
  const webContentsMod = { fromId: () => wc };
  let response;
  try {
    const out = await sandbox.__cdpExecRaw(webContentsMod, WC_ID, scenario.cmd, args);
    if (env.moments && out && typeof out === "object" && !Array.isArray(out)) out.moments = clone(env.moments);
    response = { ok: true, data: mask(env, clone(out)) };
  } catch (error) { response = failure(error); }
  return { response: normalizeDeep(response, root, scenario), effects: normalizeDeep(effects, root, scenario), files: normalizeDeep(listFiles(path.join(root, "artifacts")).concat(listFiles(path.join(root, "work"))), root, scenario) };
}

const done = (data) => ({ ok: true, data, commandState: "completed" });
const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}), commandState: "completed" });
const CDP_FREE = ["goto", "url", "back", "forward", "reload", "wait", "text", "screenshot", "login", "dialogs", "download", "nativewin", "nativekey", "nativeclick"];

// worker 경로: 메인 기본 명령 대역 · 같은 webContents·촬영 도구·페이지를 써서 효과를 옛 경로와 같은 모양으로 기록
export function createWorkerRun(scenario, root, { blockAt = null, blockCommand = null, bumpAfterSend = false, features = ["worker-command-unit", "worker-page-commands"], routes, staleOnce = null } = {}) {
  const world = createWorld(scenario, root);
  const { env, effects, wc, tools, page, args } = world;
  const relays = [];
  let sends = 0;
  let blocked = false;
  let generation = TOKEN.documentGeneration;
  let stale = staleOnce;
  const gens = () => ({ documentGeneration: generation, debuggerGeneration: TOKEN.debuggerGeneration });
  const block = () => ({ ok: false, dialogOpen: { kind: "alert", message: "열림" }, error: "확인 창", commandState: "blocked" });
  const hostApi = {
    withCommand: (_command, run) => run(),
    call: async (operation, input) => {
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: TOKEN, tab: { url: "https://example.test/a" } } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features } };
      if (operation !== "browser.executeWithDialog") return {};
      const { command, args: baseArgs, unit } = input.relay;
      relays.push({ command, args: baseArgs, unit, targetToken: input.targetToken });
      if (command === "unit.end") return done({ ended: true });
      if (command === blockCommand) blocked = true;
      if (blocked) return block();
      // 세대 검사: result.redact·cdp.sync 만 면제 (메인 target-validator)
      const exempt = command === "result.redact" || command === "cdp.sync";
      if (!exempt && input.targetToken.documentGeneration !== generation && !command.startsWith("img.")) {
        return fail("대상의 문서 또는 debugger 세대가 바뀌었습니다.", "STALE_TARGET");
      }
      const out = await baseCommand(command, baseArgs);
      if (unit?.phase === "last" && out.ok && env.moments && out.data && typeof out.data === "object") {
        return { ...out, data: { ...out.data, moments: clone(env.moments) } };
      }
      return out;
    },
  };
  const info = () => ({ wcId: WC_ID, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), zoom: 1, canGoBack: false, canGoForward: false, ...gens() });
  async function baseCommand(command, baseArgs) {
    switch (command) {
      case "cdp.gate": {
        const noCdp = env.blockedHost === true || (baseArgs.command === "goto" && world.googleHost(baseArgs.url ? (/^[a-z][a-z0-9+.-]*:/i.test(baseArgs.url) ? baseArgs.url : "https://" + baseArgs.url) : ""));
        if (noCdp) {
          effects.push(["detachAiSession"]);
          if (!CDP_FREE.includes(baseArgs.command)) {
            return fail(`로그인 호스트에서는 CDP 를 붙이지 않아 ${baseArgs.command} 를 실행할 수 없습니다. 쓸 수 있는 것: ${CDP_FREE.join(" ")}. 사람이 로그인해야 하면 browser_ask_user 로 넘기세요.`, "cdp_blocked");
          }
          return done({ noCdp: true, ...gens() });
        }
        return done({ noCdp: false, ...gens() });
      }
      case "cdp.sync": return done(gens());
      case "ai.enter": effects.push(["ai.enter"]); return done({ ticket: "t1" });
      case "ai.leave": effects.push(["ai.leave"]); return done({ left: true });
      case "viewport.ensureReady": effects.push(["ensureReady", baseArgs.command]); return done({ ready: true });
      case "viewport.apply": effects.push(["viewport.apply", clone(baseArgs)]); return done(clone(env.viewportResult));
      case "focus.state": return done({ canSendKeys: false, canPress: false, shown: env.shown === true, shownKnown: true, paint: env.paint });
      case "hold.capture": effects.push(["hold", baseArgs.on !== false]); return done({ held: true });
      case "cdp.frames": return done({ frames: scenario.frames || [], ...gens() });
      case "cdp.reset": effects.push(["resetCdpSession"]); return done(gens());
      case "wc.info": return done(info());
      case "wc.nav": {
        if (baseArgs.action === "load") { try { await wc.loadURL(baseArgs.url); } catch (error) { return fail(error.message); } if (env.navBumpsGeneration !== false) generation += 1; return done(info()); }
        if (baseArgs.action === "reload") {
          const settled = new Promise((resolve) => { const handler = () => { wc.removeListener("did-navigate", handler); resolve(); }; wc.on("did-navigate", handler); });
          wc.reload(); await settled; generation += 1; return done(info());
        }
        return fail("지원하지 않는 탐색 동작입니다.");
      }
      case "wc.navHistory": {
        const back = baseArgs.dir === "back";
        const nh = wc.navigationHistory;
        const can = back ? nh.canGoBack() : nh.canGoForward();
        if (!can) return done({ moved: false, ...gens() });
        const settled = new Promise((resolve) => { const handler = () => { wc.removeListener("did-navigate", handler); resolve(); }; wc.on("did-navigate", handler); });
        if (back) nh.goBack(); else nh.goForward();
        await settled; generation += 1;
        return done({ moved: true, url: wc.getURL(), ...gens() });
      }
      case "wc.exec": effects.push(["wc.exec", baseArgs.source, baseArgs.userGesture === true]); try { return done(clone(env.exec ? env.exec(baseArgs.source) : null)); } catch (error) { return fail(error.message); }
      case "wc.capture": return done({ data: (await wc.capturePage(baseArgs.rect)).toPNG().toString("base64"), format: "png" });
      case "wc.pdf": { const bytes = await wc.printToPDF(baseArgs.options || {}); return done({ data: bytes.toString("base64"), format: "pdf" }); }
      case "cdp.screencastShot": { try { return done({ data: (await world.screencastShot()).toString("base64") }); } catch (error) { return fail(error.message); } }
      case "img.stitch": return done({ data: Buffer.from((await tools.composeTiles(baseArgs.tiles, baseArgs.W, baseArgs.H, baseArgs.px))).toString("base64") });
      case "img.diff": try { return done(tools.diffPng(baseArgs.before, baseArgs.after, baseArgs.out, baseArgs.threshold)); } catch (error) { return fail(error.message); }
      case "img.same": return done({ same: !!tools.samePng(baseArgs.prev, Buffer.from(baseArgs.data, "base64")) });
      case "obs.read": return done(world.observed(baseArgs.level, baseArgs.limit));
      case "obs.clear": effects.push(["obs.clear"]); return done({ cleared: true });
      case "download.state": return done(clone(env.download ?? { dir: null, once: false, last: null, pending: null }));
      case "ref.resolve":
        try { const entry = refRegistry.resolveRef(WC_ID, baseArgs.ref); return done({ backendDOMNodeId: entry.backendDOMNodeId, sid: entry.sid ?? null }); }
        catch (error) { return fail(error.message, error.code); }
      case "result.redact": return done({ value: mask(env, clone(baseArgs.value)) });
      case "cdp.send": {
        sends += 1;
        if (blockAt === sends) { blocked = true; return block(); }
        if (stale && baseArgs.method === stale.method && stale.remaining-- > 0) { generation += 1; return fail("대상의 문서 또는 debugger 세대가 바뀌었습니다.", "STALE_TARGET"); }
        effects.push(["cdp", baseArgs.method, clone(baseArgs.params ?? {}), baseArgs.sessionId || null]);
        try {
          const out = done(clone(await page(baseArgs.method, baseArgs.params ?? {}, baseArgs.sessionId || null)));
          if (bumpAfterSend) generation += 1;
          return out;
        } catch (error) { return fail(String(error.message || error)); }
      }
      default: throw new Error(`예상하지 않은 중계 명령 ${command}`);
    }
  }
  const service = createWorkerBrowserService({ hostApi, activity: { run: (_kind, _id, run) => run() }, ...(routes ? { routes } : {}) });
  const hostTaskService = createWorkerHostTaskService({ hostApi, ...(routes ? { routes } : {}) });
  return {
    effects, relays, root,
    run: async ({ hostTask = false } = {}) => {
      const previous = process.env.IRIS_STATE_DIR;
      process.env.IRIS_STATE_DIR = root;
      try {
        // hostTask: journal 의 screenshot 처럼 host 가 Electron 실행을 worker 에 맡기는 요청 (host-task-service.js)
        const response = clone(hostTask
          ? await hostTaskService.dispatch({ task: { type: "legacyRelay", target: { tabId: "tab-a", wcId: WC_ID, targetToken: TOKEN }, relay: { command: scenario.cmd, args, timeoutMs: 30000 } },
            identity: { session: "pane", run: "run-1" }, commandId: "c/1", callId: 1 })
          : await service.dispatch({ command: scenario.cmd, args, identity: { session: "pane" }, commandId: "c/1" }));
        return { response: normalizeDeep(response, root, scenario), effects: normalizeDeep(effects, root, scenario), files: normalizeDeep(listFiles(path.join(root, "artifacts")).concat(listFiles(path.join(root, "work"))), root, scenario) };
      } finally {
        if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous;
      }
    },
  };
}

export { CONTROL_SOURCE, LEGACY_PARTS, TOKEN, WC_ID };
