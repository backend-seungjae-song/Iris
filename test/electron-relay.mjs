import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createElectronRelay, BASE_COMMANDS } = require("../native/electron/relay/index.cjs");
const { createAiCausality } = require("../native/electron/ai-causality.cjs");
const { createUploadController } = require("../native/electron/cdp-upload.cjs");

const EXPECTED_COMMANDS = [
  "cdp.send", "cdp.batch", "cdp.frames", "cdp.reset", "cdp.subscribe", "cdp.unsubscribe",
  "wc.info", "wc.nav", "wc.exec", "wc.input", "wc.capture", "wc.captureToFile", "wc.pdf", "wc.pdfToFile",
  "tab.state", "hold.capture", "focus.state", "focus.prepare", "focus.return", "ai.enter", "ai.leave",
  "viewport.get", "viewport.apply", "viewport.setTemporary", "viewport.restore", "obs.read", "obs.drain", "obs.clear",
  "dialog.state", "dialog.answer", "dialog.plan", "upload.arm", "download.state", "download.configure",
  "login.accounts", "login.fill", "login.input", "native.click", "native.key", "native.drag", "native.window",
  "native.windowClick", "native.windowKey", "qa.mode", "qa.anchor", "viewport.ensureReady", "viewport.qa",
  "img.render", "contextaction", "cdp.attach", "ref.record", "ref.resolve", "cdp.detachIdle", "result.redact",
  "cdp.gate", "cdp.sync", "wc.navHistory", "cdp.screencastShot", "img.stitch", "img.diff", "img.same",
  "obs.pending", "obs.since", "ax.tree",
].sort();

function coded(code, message) { return Object.assign(new Error(message), { code }); }

function harness({ currentUrl = "https://example.test/page", pendingUrl = "", generations, childOwner = 7 } = {}) {
  const attaches = [];
  const gates = [];
  const images = [];
  const refRecords = [];
  const sent = [];
  const captures = [];
  const inserted = [];
  const captureHolds = [];
  const focusReturns = [];
  const emitted = [];
  const dialogPlans = [];
  const qaModes = [];
  const qaViewports = [];
  const qaViewportReleases = [];
  const hiddenViewports = [];
  const nativeCalls = [];
  const viewport = { explicit: { width: 390, height: 844, dpr: 2 }, current: null, revision: 0 };
  const appliedViewports = [];
  const download = { dir: null, once: false, last: null, pending: null };
  const dialog = { value: null };
  let diagnostics = { console: [], exceptions: [], network: [], dialogs: [], moments: [] };
  let eventListener = null;
  let deliverEvents = true;
  const pendingEventDeliveries = [];
  let humanChooserCalls = 0;
  let childSessionActive = true;
  let liveUrl = currentUrl;
  const dbg = {
    attached: true,
    isAttached() { return this.attached; },
    sendCommand(method, params, sessionId) {
      sent.push({ method, params: params || {}, sessionId });
      if (sessionId === "child-1" && !childSessionActive) return Promise.reject(new Error("No session with given id"));
      if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "secret-value" } });
      if (method === "Page.addScriptToEvaluateOnNewDocument") return Promise.resolve({ identifier: "script-1" });
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [
        { nodeId: "1", ignored: false, role: { type: "role", value: "RootWebArea" }, name: { type: "computedString", value: "secret-value", sources: [{ type: "attribute" }] },
          childIds: ["2"], backendDOMNodeId: 5, frameId: "F1", properties: [{ name: "url", value: { type: "string", value: "x" } }] },
        { nodeId: "2", ignored: true, ignoredReasons: [{ name: "notRendered" }], parentId: "1", properties: [{ name: "focusable", value: { type: "booleanOrUndefined", value: false } }, { name: "focusable", value: { value: true } }] },
      ] });
      return Promise.resolve({ ok: true, echoed: "secret-value" });
    },
  };
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    debugger: dbg,
    hostWebContents: { id: 1, isDestroyed: () => false, executeJavaScript: async () => "owns" },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => liveUrl,
    getTitle: () => "Example",
    isLoading: () => false,
    canGoBack: () => true,
    canGoForward: () => false,
    getZoomFactor: () => 1.25,
    loadURL: async (url) => { sent.push({ nav: "loadURL", url }); },
    goBack: () => sent.push({ nav: "back" }),
    goForward: () => sent.push({ nav: "forward" }),
    reload: () => sent.push({ nav: "reload" }),
    stop: () => sent.push({ nav: "stop" }),
    executeJavaScript: async (source) => {
      sent.push({ exec: source });
      if (source.includes("elementFromPoint")) return { ok: true, tag: "INPUT", type: "password", autocomplete: "current-password" };
      return { nested: "secret-value" };
    },
    sendInputEvent: (event) => sent.push({ input: event }),
    insertText: async (value) => { inserted.push(value); },
    capturePage: async (rect) => {
      captures.push(rect || null);
      return { toPNG: () => Buffer.from("png") };
    },
    printToPDF: async () => Buffer.from("pdf"),
  });
  const shell = { id: 1, isDestroyed: () => false, getType: () => "window", getURL: () => "http://127.0.0.1/" };
  const webContents = { fromId: (id) => Number(id) === 7 ? guest : Number(id) === 1 ? shell : null };
  const ai = createAiCausality({ graceMs: 0 });
  const upload = createUploadController({
    isAbsolute: () => true,
    existsSync: () => true,
    showOpenDialog: async () => { humanChooserCalls++; return { canceled: true, filePaths: [] }; },
    windowFromWebContents: () => null,
    recordUpload() {},
    clearChooser() {},
    setTimeoutFn: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
  });
  const deps = {
    webContents,
    targetState: {
      generations: () => typeof generations === "function" ? generations() : generations || { documentGeneration: 3, debuggerGeneration: 4 },
      ownsChildSession: (wcId, sid) => childSessionActive && Number(wcId) === childOwner && sid === "child-1",
      frames: () => ["child-1"],
      reset: () => ({ documentGeneration: 3, debuggerGeneration: 5 }),
    },
    currentUrl: () => liveUrl,
    pendingUrl: () => pendingUrl,
    blockedUrl: (url) => String(url).includes("accounts.google.com"),
    redact: (_wcId, value) => JSON.parse(JSON.stringify(value).replaceAll("secret-value", "••••••••")),
    rememberSecret() {},
    observation: {
      subscribeEvents(fn) { eventListener = fn; return () => { if (eventListener === fn) eventListener = null; }; },
      observe: () => diagnostics,
      clearDiagnostics: () => { diagnostics = { console: [], exceptions: [], network: [], dialogs: [], moments: [] }; },
      drainMoments: () => ({ list: [{ text: "secret-value" }], commit() {} }),
      dialogOpen: () => dialog.value,
      closeDialog: () => { dialog.value = null; },
    },
    upload,
    downloadState: {
      snapshot: () => ({ ...download }),
      arm: (dir, once) => { download.dir = dir; download.once = once; },
      disarm: () => { download.dir = null; download.once = false; },
    },
    qaAnchor: async () => ({ ok: true, data: { revision: 2 } }),
    attach: (wc, command) => { attaches.push([wc.id, command]); return { documentGeneration: 3, debuggerGeneration: 5 }; },
    refs: {
      record: (wcId, map) => { refRecords.push([wcId, map]); },
      resolve: (wcId, ref) => {
        const entry = refRecords.at(-1)?.[1]?.get(ref);
        if (!refRecords.length) throw coded("no_snapshot", "이 탭에서 먼저 snapshot을 실행하세요(ref 맵 없음).");
        if (!entry) throw coded("not_found", "알 수 없는 ref: " + ref);
        return entry;
      },
    },
    detachIdle: (wc) => { sent.push({ detachIdle: wc.id }); dbg.attached = false; },
    gate: (wc, command, args) => {
      gates.push([wc.id, command, args.url ?? null]);
      if (String(args.url || "").includes("accounts.google.com")) return { noCdp: true, documentGeneration: 3, debuggerGeneration: 6 };
      return { noCdp: false, documentGeneration: 3, debuggerGeneration: 5 };
    },
    screencastShot: async (wc, ms) => { images.push(["screencast", wc.id, ms]); return Buffer.from("cast"); },
    stitch: async (tiles, width, height, px) => { images.push(["stitch", tiles.length, width, height, px]); return Buffer.from("stitched"); },
    diff: (before, after, out, threshold) => { images.push(["diff", before, after, out, threshold]); return { changed: 1, total: 4, ratio: 25 }; },
    same: (prev, buffer) => { images.push(["same", prev, buffer.toString()]); return buffer.toString() === "png"; },
    ai,
    captureHold: async (wcId, on) => { captureHolds.push([wcId, on]); return true; },
    focus: {
      state: async () => ({ canSendKeys: false, canPress: true, shown: false, shownKnown: true }),
      prepare: async () => "borrowed",
      return: async (wc) => { focusReturns.push(wc.id); return "restored"; },
    },
    viewport: {
      explicit: () => viewport.explicit,
      current: () => viewport.current,
      revision: () => viewport.revision,
      apply: async (wc, args) => {
        viewport.current = args.clear ? null : { ...args };
        viewport.revision++;
        appliedViewports.push([wc.id, args]);
        return { ok: true, ...args };
      },
    },
    contextAction: async () => ({ ok: true }),
    renderImage: async () => Buffer.from("rendered"),
    loginProvider: async () => ({ origin: "https://example.test", accounts: [
      { username: "user@example.test", password: "secret-value", allowed: true },
    ] }),
    dialogPlan: { set: (wcId, plan, text) => { dialogPlans.push([wcId, plan, text]); } },
    clearDialogPlan: (wcId) => { dialogPlans.push([wcId, null, null]); },
    qaMode: async (wc, enabled) => { qaModes.push([wc.id, enabled]); return { ok: true }; },
    qaViewport: async (wc, args) => {
      viewport.current = args.clear ? null : { width: args.width, height: args.height, dpr: args.dpr ?? 1 };
      viewport.revision++;
      qaViewports.push([wc.id, args]);
      return { ok: true, ...args };
    },
    qaViewportRelease: async (wc) => { qaViewportReleases.push(wc.id); },
    hiddenViewport: {
      ensureReady: async (wc, command) => { hiddenViewports.push(["ensure", wc.id, command]); return { ready: true }; },
      release: async (wc) => { hiddenViewports.push(["release", wc.id]); return { released: true }; },
    },
    nativeAx: {
      describe: async () => { nativeCalls.push(["describe"]); return { ok: true, windows: [] }; },
      click: async (button) => { nativeCalls.push(["click", button]); return { ok: true, clicked: button }; },
      key: async (key) => { nativeCalls.push(["key", key]); return { ok: true, key }; },
    },
    cancelTarget: (wcId) => { sent.push({ cancel: wcId }); dbg.attached = false; },
    emitEvent: (event, onDelivered) => {
      emitted.push(event);
      if (deliverEvents) {
        onDelivered?.(true);
        return true;
      }
      pendingEventDeliveries.push(onDelivered);
      return false;
    },
    codedError: coded,
  };
  const relay = createElectronRelay(deps);
  const target = { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 };
  const request = (command, args = {}, extra = {}) => relay.execute({
    workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command, target, args, ...extra,
  });
  return { attaches, gates, images, refRecords, relay, deps, guest, shell, dbg, sent, captures, inserted, captureHolds, focusReturns, emitted,
    dialogPlans, qaModes, qaViewports, qaViewportReleases, hiddenViewports, nativeCalls, download, appliedViewports,
    upload, ai, target, request, fireEvent: (...args) => eventListener?.(...args), humanChooserCalls: () => humanChooserCalls,
    setDialog: (value) => { dialog.value = value; }, setChildSessionActive: (value) => { childSessionActive = value; },
    setCurrentUrl: (value) => { liveUrl = value; },
    setEventDelivery: (value) => { deliverEvents = value; },
    flushEventDeliveries: () => { for (const delivered of pendingEventDeliveries.splice(0)) delivered?.(true); } };
}

test("계약의 기본 명령 집합을 빠짐없이 고정한다", () => {
  assert.deepEqual([...BASE_COMMANDS].sort(), EXPECTED_COMMANDS);
});

test("공통 대상 검증은 앱 셸, stale 세대, 다른 탭 child session, 로그인 URL을 거부한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command: "wc.info",
    target: { wcId: 1, documentGeneration: 3, debuggerGeneration: 4 }, args: {} }), (e) => e.code === "STALE_TARGET");
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command: "cdp.send",
    target: { wcId: 7, documentGeneration: 2, debuggerGeneration: 4 }, args: { method: "Page.enable" } }), (e) => e.code === "STALE_TARGET");
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command: "cdp.send",
    target: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4, childSessionId: "other-child" }, args: { method: "Page.enable" } }),
  (e) => e.code === "STALE_TARGET");
  const login = harness({ pendingUrl: "https://accounts.google.com/o/oauth2/auth" });
  await login.relay.acceptGeneration("boot:1");
  await assert.rejects(() => login.request("cdp.batch", { commands: [] }), (e) => e.code === "STALE_TARGET");
  const loginCurrent = harness({ currentUrl: "https://accounts.google.com/signin" });
  await loginCurrent.relay.acceptGeneration("boot:1");
  await assert.rejects(() => loginCurrent.request("cdp.subscribe", { subscriptionId: "sub-1" }), (e) => e.code === "STALE_TARGET");
  assert.equal(h.sent.length, 0);
});

test("공통 대상 검증은 등록된 사이트 팝업을 허용하고 앱 셸 창은 거부한다", async () => {
  const h = harness();
  const popup = { ...h.guest, id: 8, hostWebContents: undefined, getType: () => "window" };
  h.deps.webContents.fromId = (id) => Number(id) === 8 ? popup : Number(id) === 1 ? h.shell : Number(id) === 7 ? h.guest : null;
  h.deps.targetState.isRegistered = (wcId) => Number(wcId) === 8;
  h.deps.targetState.generations = () => ({ documentGeneration: 3, debuggerGeneration: 4 });
  await h.relay.acceptGeneration("boot:1");

  const info = await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1",
    command: "wc.info", target: { wcId: 8, documentGeneration: 3, debuggerGeneration: 4 }, args: {} });
  assert.equal(info.wcId, 8);
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/2", callId: "1",
    command: "wc.info", target: { wcId: 1, documentGeneration: 3, debuggerGeneration: 4 }, args: {} }),
  (error) => error.code === "STALE_TARGET");
});

test("결과, 관찰, 이벤트, 오류와 login.input에서 비밀을 가린다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  assert.doesNotMatch(JSON.stringify(await h.request("cdp.send", { method: "Runtime.evaluate" })), /secret-value/);
  assert.doesNotMatch(JSON.stringify(await h.request("wc.exec", { source: "'secret-value'" })), /secret-value/);
  h.deps.observation.observe = () => ({ console: [{ text: "secret-value" }] });
  assert.doesNotMatch(JSON.stringify(await h.request("obs.read")), /secret-value/);
  await h.request("cdp.subscribe", { subscriptionId: "sub-1", methods: ["Runtime.consoleAPICalled"] });
  h.fireEvent(7, "Runtime.consoleAPICalled", { value: "secret-value" }, "");
  assert.doesNotMatch(JSON.stringify(h.emitted), /secret-value/);
  h.dbg.sendCommand = async () => { throw new Error("secret-value failed"); };
  await assert.rejects(() => h.request("cdp.send", { method: "Page.enable" }), (e) => !String(e.message).includes("secret-value"));

  const out = await h.request("login.input", { accountId: "user@example.test", origin: "https://example.test",
    field: "password", x: 20, y: 30 });
  assert.equal(out.ok, true);
  assert.equal(h.inserted.at(-1), "secret-value");
  assert.doesNotMatch(JSON.stringify(out), /secret-value/);
});

test("login.input은 비밀번호 조회를 기다린 뒤 바뀐 페이지에 입력하지 않는다", async () => {
  const h = harness();
  let releaseProvider;
  h.deps.loginProvider = () => new Promise((resolve) => { releaseProvider = resolve; });
  await h.relay.acceptGeneration("boot:1");
  const input = h.request("login.input", { accountId: "user@example.test", origin: "https://example.test",
    field: "password", x: 20, y: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  h.setCurrentUrl("https://changed.test/");
  releaseProvider({ accounts: [{ username: "user@example.test", password: "changed-page-secret", allowed: true }] });

  await assert.rejects(() => input, (error) => error.code === "STALE_TARGET");
  assert.deepEqual(h.inserted, []);
});

test("login.input은 두 번째 필드 확인을 기다리는 동안 바뀐 페이지에도 입력하지 않는다", async () => {
  const h = harness();
  let probeCount = 0;
  let releaseSecondProbe;
  h.guest.executeJavaScript = async (source) => {
    if (!source.includes("elementFromPoint")) return {};
    probeCount++;
    if (probeCount === 1) return { ok: true, tag: "INPUT", type: "password", autocomplete: "current-password" };
    return new Promise((resolve) => { releaseSecondProbe = resolve; });
  };
  await h.relay.acceptGeneration("boot:1");
  const input = h.request("login.input", { accountId: "user@example.test", origin: "https://example.test",
    field: "password", x: 20, y: 30 });
  while (!releaseSecondProbe) await new Promise((resolve) => setImmediate(resolve));
  h.setCurrentUrl("https://changed.test/");
  releaseSecondProbe({ ok: true, tag: "INPUT", type: "password", autocomplete: "current-password" });

  await assert.rejects(() => input, (error) => error.code === "STALE_TARGET");
  assert.deepEqual(h.inserted, []);
});

test("retire는 세대 자원을 반환하고 사람 viewport와 download 상태를 유지한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const ai = await h.request("ai.enter");
  await h.request("hold.capture", { on: true });
  await h.request("focus.prepare");
  await h.request("viewport.setTemporary", { width: 800, height: 600, dpr: 1 });
  await h.request("cdp.subscribe", { subscriptionId: "sub-1", methods: ["Runtime.consoleAPICalled"] });
  await h.request("cdp.send", { method: "Runtime.addBinding", params: { name: "workerBinding" } });
  await h.request("cdp.send", { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "1" } });
  await h.request("cdp.send", { method: "Page.startScreencast", params: {} });
  h.setDialog({ type: "confirm", message: "continue?" });
  await h.request("upload.arm", { paths: ["/tmp/file.txt"], timeoutMs: 60000 });
  const downloadBefore = await h.request("download.state");

  const retired = await h.relay.retireGeneration("boot:1");

  assert.equal(retired.retired, true);
  assert.equal(h.ai.driving(7), false);
  assert.deepEqual(h.captureHolds.at(-1), [7, false]);
  assert.deepEqual(h.focusReturns, [7]);
  assert.ok(h.sent.some((call) => call.method === "Emulation.setDeviceMetricsOverride" && call.params.width === 390));
  assert.ok(h.sent.some((call) => call.method === "Runtime.removeBinding" && call.params.name === "workerBinding"));
  assert.ok(h.sent.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument" && call.params.identifier === "script-1"));
  assert.ok(h.sent.some((call) => call.method === "Page.stopScreencast"));
  assert.deepEqual(await h.deps.downloadState.snapshot(), downloadBefore);
  assert.equal(h.upload.armed(7), false);
  await h.upload.serveFileChooser(async () => {}, h.guest, { backendNodeId: 4, mode: "selectSingle" });
  assert.equal(h.humanChooserCalls(), 1);
  await assert.rejects(() => h.request("ai.leave", { ticket: ai.ticket }), (e) => e.code === "STALE_WORKER");
  await h.relay.acceptGeneration("boot:2");
});

test("capture hold를 두 번 얻고 한 번 반환하면 retire가 남은 한 번을 반환한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("hold.capture", { on: true });
  await h.request("hold.capture", { on: true });
  await h.request("hold.capture", { on: false });

  await h.relay.retireGeneration("boot:1");

  assert.deepEqual(h.captureHolds, [[7, true], [7, true], [7, false], [7, false]]);
});

test("wc.nav back, forward, reload는 main-frame 탐색 완료를 기다린다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const cases = [
    ["back", "did-navigate", []],
    ["forward", "did-navigate-in-page", [{}, "https://example.test/next", true]],
    ["reload", "did-fail-load", [{}, -3, "aborted", "https://example.test/page", true]],
  ];

  for (const [action, event, args] of cases) {
    let settled = false;
    const navigation = h.request("wc.nav", { action }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `${action}이 탐색 이벤트 전에 끝났습니다.`);
    h.guest.emit(event, ...args);
    assert.equal((await navigation).wcId, 7);
  }
});

test("⑦ 처리기가 쓸 메인 상태 기본 명령을 같은 target 검증 경로로 실행한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");

  assert.equal((await h.request("wc.info")).zoom, 1.25);
  assert.equal((await h.request("viewport.apply", { width: 1280, height: 800, dpr: 1 })).width, 1280);
  assert.deepEqual(await h.request("dialog.plan", { plan: { queue: ["ok", "cancel"] }, text: "answer" }),
    { plan: { queue: ["ok", "cancel"] }, text: "answer" });
  assert.equal((await h.request("qa.mode", { enabled: true })).ok, true);
  assert.equal((await h.request("viewport.ensureReady", { command: "click" })).ready, true);
  assert.equal((await h.request("viewport.qa", { width: 390, height: 844, dpr: 2 })).width, 390);
  const accounts = await h.request("login.accounts");
  assert.deepEqual(accounts.accounts, [{ id: "user@example.test", username: "user@example.test", allowed: true, local: false }]);
  assert.doesNotMatch(JSON.stringify(accounts), /secret-value/);
  assert.equal((await h.request("login.fill", { username: "user@example.test" })).origin, "https://example.test");
  assert.deepEqual(await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/2", callId: "1",
    command: "download.configure", args: { dir: "/tmp", once: true } }),
  { mode: "armed", dir: "/tmp", once: true, last: null });
  assert.equal((await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/3", callId: "1",
    command: "native.window", args: {} })).ok, true);
  assert.equal((await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/4", callId: "1",
    command: "native.windowClick", args: { button: "Save" } })).clicked, "Save");
  assert.equal((await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/5", callId: "1",
    command: "native.windowKey", args: { key: "escape" } })).key, "escape");
});

test("focus.state는 사용자 포커스와 표시 탭 상태를 읽고 세대 자원을 만들지 않는다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");

  assert.deepEqual(await h.request("focus.state"), {
    canSendKeys: false,
    canPress: true,
    shown: false,
    shownKnown: true,
  });
  await h.relay.retireGeneration("boot:1");
  assert.deepEqual(h.focusReturns, []);
});

test("retire는 worker가 만든 dialog, download, QA mode, viewport 자원을 회수한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("dialog.plan", { plan: { mode: "ok" } });
  await h.request("qa.mode", { enabled: true });
  await h.request("viewport.ensureReady", { command: "click" });
  await h.request("viewport.qa", { width: 390, height: 844, dpr: 2 });
  await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/2", callId: "1",
    command: "download.configure", args: { dir: "/tmp" } });

  await h.relay.retireGeneration("boot:1");

  assert.deepEqual(h.dialogPlans.at(-1), [7, null, null]);
  assert.deepEqual(h.qaModes.at(-1), [7, false]);
  assert.deepEqual(h.qaViewports.at(-1), [7, { clear: true }]);
  assert.deepEqual(h.hiddenViewports.at(-1), ["release", 7]);
  assert.equal(h.download.dir, null);
});

test("retire는 QA viewport 뒤에 적용된 일반 viewport를 지우지 않는다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("viewport.qa", { width: 390, height: 844, dpr: 2 });
  await h.request("viewport.apply", { width: 1440, height: 900, dpr: 1 });

  await h.relay.retireGeneration("boot:1");

  assert.notDeepEqual(h.qaViewports.at(-1), [7, { clear: true }]);
  assert.deepEqual(h.qaViewportReleases, [7]);
  assert.deepEqual(h.appliedViewports.at(-1), [7, { width: 1440, height: 900, dpr: 1 }]);
});

test("retire는 QA viewport와 값이 같은 일반 viewport 재적용도 지우지 않는다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const size = { width: 800, height: 600, dpr: 1 };
  await h.request("viewport.qa", size);
  await h.request("viewport.apply", size);

  await h.relay.retireGeneration("boot:1");

  assert.notDeepEqual(h.qaViewports.at(-1), [7, { clear: true }]);
  assert.deepEqual(h.qaViewportReleases, [7]);
});

test("retire는 사라진 child session의 binding, script, screencast를 반환 완료로 처리한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const childTarget = { ...h.target, childSessionId: "child-1" };
  await h.request("cdp.send", { method: "Runtime.addBinding", params: { name: "childBinding" } }, { target: childTarget });
  await h.request("cdp.send", { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "1" } }, { target: childTarget });
  await h.request("cdp.send", { method: "Page.startScreencast", params: {} }, { target: childTarget });
  h.setChildSessionActive(false);

  const retired = await h.relay.retireGeneration("boot:1");

  assert.equal(retired.retired, true);
  assert.equal(h.sent.filter((call) => call.sessionId === "child-1" && ["Runtime.removeBinding",
    "Page.removeScriptToEvaluateOnNewDocument", "Page.stopScreencast"].includes(call.method)).length, 0);
});

test("retire는 같은 debugger의 이전 문서에 등록한 CDP 자원을 제거한다", async () => {
  const generation = { documentGeneration: 3, debuggerGeneration: 4 };
  const h = harness({ generations: () => ({ ...generation }) });
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.send", { method: "Runtime.addBinding", params: { name: "rootBinding" } });
  await h.request("cdp.send", { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "1" } });
  await h.request("cdp.send", { method: "Page.startScreencast", params: {} });
  generation.documentGeneration++;

  await h.relay.retireGeneration("boot:1");

  assert.ok(h.sent.some((call) => call.method === "Runtime.removeBinding" && call.params.name === "rootBinding"));
  assert.ok(h.sent.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"));
  assert.ok(h.sent.some((call) => call.method === "Page.stopScreencast"));
});

test("qa.anchor도 generation, commandId, run 경계를 요구한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "wrong/1", callId: "1", command: "qa.anchor",
    args: { run: "run-1", runId: "run-1", op: "read" } }), (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command: "qa.anchor",
    args: { run: "run-1", runId: "run-2", op: "read" } }), (e) => e.code === "RUN_DENIED");
  assert.deepEqual(await h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/1", callId: "1", command: "qa.anchor",
    args: { run: "run-1", runId: "run-1", op: "read" } }), { revision: 2 });
});

test("이벤트 상한을 넘으면 EVENT_OVERFLOW로 구독을 끝낸다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.subscribe", { subscriptionId: "sub-1" });
  h.setEventDelivery(false);
  for (let i = 0; i <= 1000; i++) h.fireEvent(7, "Runtime.consoleAPICalled", { i }, "");
  assert.deepEqual({
    workerGeneration: h.emitted.at(-1).workerGeneration,
    subscriptionId: h.emitted.at(-1).subscriptionId,
    eventSeq: h.emitted.at(-1).eventSeq,
    error: h.emitted.at(-1).error.code,
  }, {
    workerGeneration: "boot:1",
    subscriptionId: "sub-1",
    eventSeq: 1001,
    error: "EVENT_OVERFLOW",
  });
  const count = h.emitted.length;
  h.fireEvent(7, "Runtime.consoleAPICalled", { i: 1002 }, "");
  assert.equal(h.emitted.length, count);
});

test("전송 완료된 이벤트는 구독 상한에 누적하지 않는다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.subscribe", { subscriptionId: "sub-1" });

  for (let i = 0; i < 1001; i++) h.fireEvent(7, "Runtime.consoleAPICalled", { i }, "");

  assert.equal(h.emitted.length, 1001);
  assert.equal(h.emitted.some((event) => event.error?.code === "EVENT_OVERFLOW"), false);
  h.fireEvent(7, "Runtime.consoleAPICalled", { i: 1001 }, "");
  assert.equal(h.emitted.at(-1).eventSeq, 1002);
});

test("전송 대기 이벤트가 전달되면 같은 구독에서 상한을 다시 쓸 수 있다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.subscribe", { subscriptionId: "sub-1" });
  h.setEventDelivery(false);
  for (let i = 0; i < 1000; i++) h.fireEvent(7, "Runtime.consoleAPICalled", { batch: 1, i }, "");
  h.flushEventDeliveries();
  for (let i = 0; i < 1000; i++) h.fireEvent(7, "Runtime.consoleAPICalled", { batch: 2, i }, "");
  h.setEventDelivery(true);
  h.flushEventDeliveries();
  h.fireEvent(7, "Runtime.consoleAPICalled", { batch: 3 }, "");

  assert.equal(h.emitted.some((event) => event.error?.code === "EVENT_OVERFLOW"), false);
  assert.equal(h.emitted.at(-1).eventSeq, 2001);
});

test("구독 이벤트 봉투는 worker 세대와 구독 ID, 단조 순번을 함께 보낸다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.subscribe", { subscriptionId: "sub-1", methods: ["Runtime.consoleAPICalled"] });

  h.fireEvent(7, "Runtime.consoleAPICalled", { value: "first" }, "child-1");
  h.fireEvent(7, "Runtime.consoleAPICalled", { value: "second" }, "child-1");

  assert.deepEqual(h.emitted.map((event) => ({
    workerGeneration: event.workerGeneration,
    subscriptionId: event.subscriptionId,
    eventSeq: event.eventSeq,
    method: event.method,
    childSessionId: event.childSessionId,
  })), [
    { workerGeneration: "boot:1", subscriptionId: "sub-1", eventSeq: 1,
      method: "Runtime.consoleAPICalled", childSessionId: "child-1" },
    { workerGeneration: "boot:1", subscriptionId: "sub-1", eventSeq: 2,
      method: "Runtime.consoleAPICalled", childSessionId: "child-1" },
  ]);
});

test("retire는 진행 명령의 실제 종료 전까지 새 세대를 허용하지 않는다", async () => {
  const h = harness();
  let finish;
  h.guest.executeJavaScript = () => new Promise((resolve) => { finish = resolve; });
  await h.relay.acceptGeneration("boot:1");
  const active = h.request("wc.exec", { source: "work()" });
  await new Promise((resolve) => setImmediate(resolve));
  const retiring = h.relay.retireGeneration("boot:1");
  await assert.rejects(() => h.relay.acceptGeneration("boot:2"), (e) => e.code === "BUSY");
  finish({ done: true });
  await active;
  await retiring;
  assert.deepEqual(h.sent.find((entry) => entry.cancel), { cancel: 7 });
  await h.relay.acceptGeneration("boot:2");
});

test("force retire는 진행 명령을 기다리지 않고 새 세대를 허용한다", async () => {
  const h = harness();
  let finish;
  h.guest.executeJavaScript = () => new Promise((resolve) => { finish = resolve; });
  await h.relay.acceptGeneration("boot:1");
  const active = h.request("wc.exec", { source: "work()" });
  await new Promise((resolve) => setImmediate(resolve));

  const forced = await h.relay.retireGeneration("boot:1", { force: true });

  assert.equal(forced.forced, true);
  assert.deepEqual(forced.leftovers, ["active-command:7"]);
  await h.relay.acceptGeneration("boot:2");
  finish({ done: true });
  await assert.rejects(active, (error) => error.code === "STALE_WORKER");
});

test("실행기 소켓이 바뀌면 같은 worker 세대의 이전 자원을 회수하고 다시 받는다", async () => {
  const h = harness();
  const firstConnection = {};
  const secondConnection = {};
  await h.relay.acceptGeneration("boot:1", firstConnection);
  await h.request("hold.capture", { on: true });

  const accepted = await h.relay.acceptGeneration("boot:1", secondConnection);

  assert.deepEqual(accepted, { accepted: true, workerGeneration: "boot:1" });
  assert.deepEqual(h.captureHolds.at(-1), [7, false]);
  assert.equal((await h.request("wc.info")).wcId, 7);
});

test("cdp.attach 는 붙임 보장 뒤 바뀐 세대를 돌려주고 ref.record 는 검사한 ref 만 registry 에 기록한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  assert.deepEqual(await h.request("cdp.attach", { command: "snapshot" }), { documentGeneration: 3, debuggerGeneration: 5 });
  assert.deepEqual(h.attaches, [[7, "snapshot"]]);
  const entry = { backendDOMNodeId: 11, role: "button", name: "확인", sid: null, nth: 2 };
  assert.deepEqual(await h.request("ref.record", { refs: [["@e1", entry]] }), { recorded: 1 });
  assert.equal(h.refRecords[0][0], 7);
  assert.deepEqual(h.refRecords[0][1].get("@e1"), entry);
  for (const bad of [[["e1", entry]], [["@e1", { ...entry, backendDOMNodeId: "x" }]], [["@e1", { ...entry, role: 1 }]], "no"]) {
    await assert.rejects(h.request("ref.record", { refs: bad }), (e) => e.code === "INVALID_REQUEST");
  }
  assert.equal(h.refRecords.length, 1);
});

test("ref.resolve 는 registry 항목을 읽고 옛 resolveRef 의 오류 code 를 그대로 돌려준다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  await assert.rejects(h.request("ref.resolve", { ref: "@e1" }), (e) => e.code === "no_snapshot" && /snapshot/.test(e.message));
  await h.request("ref.record", { refs: [["@e1", { backendDOMNodeId: 11, role: "button", name: "확인", sid: "child-1" }], ["@e2", { backendDOMNodeId: 12, role: "link", name: "홈" }]] });
  assert.deepEqual(await h.request("ref.resolve", { ref: "@e1" }), { backendDOMNodeId: 11, sid: "child-1" });
  assert.deepEqual(await h.request("ref.resolve", { ref: "@e2" }), { backendDOMNodeId: 12, sid: null });
  await assert.rejects(h.request("ref.resolve", { ref: "@e9" }), (e) => e.code === "not_found" && /@e9/.test(e.message));
  await assert.rejects(h.request("ref.resolve", {}), (e) => e.code === "not_found" && /undefined/.test(e.message));
});

test("ax.tree 는 접근성 트리를 엔진이 읽는 필드만 남기고 비밀 가리기·자식 세션 규칙은 cdp.send 와 같다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const result = await h.request("ax.tree");
  assert.deepEqual(result, { nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "••••••••" }, childIds: ["2"], backendDOMNodeId: 5 },
    { nodeId: "2", ignored: true, properties: [{ name: "focusable", value: { value: false } }] },
  ] });
  assert.deepEqual(h.sent.at(-1), { method: "Accessibility.getFullAXTree", params: {}, sessionId: undefined });
  await h.request("ax.tree", { sessionId: "child-1" });
  assert.equal(h.sent.at(-1).sessionId, "child-1");
  await assert.rejects(h.request("ax.tree", { sessionId: "other-child" }), (e) => e.code === "STALE_TARGET");
  const login = harness({ currentUrl: "https://accounts.google.com/signin" });
  await login.relay.acceptGeneration("boot:1");
  await assert.rejects(login.request("ax.tree"), (e) => e.code === "STALE_TARGET");
});

test("cdp.detachIdle 은 붙어 있을 때만 떼고 뗀 뒤의 세대를 돌려준다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  assert.deepEqual(await h.request("cdp.detachIdle"), { wasAttached: true, documentGeneration: 3, debuggerGeneration: 4 });
  assert.deepEqual(await h.request("cdp.detachIdle"), { wasAttached: false, documentGeneration: 3, debuggerGeneration: 4 });
  assert.equal(h.sent.filter((item) => item.detachIdle).length, 1);
});

test("releaseCommand 는 그 명령이 얻고 돌려주지 못한 AI 표식과 capture hold 만 반환한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const asA = (command, args = {}) => h.request(command, args, { commandId: "boot:1/a", callId: "1" });
  const asB = (command, args = {}) => h.request(command, args, { commandId: "boot:1/b", callId: "1" });
  const a = await asA("ai.enter");
  const b = await asB("ai.enter");
  await asA("hold.capture", { on: true });
  await asB("hold.capture", { on: true });
  await asB("hold.capture", { on: false });
  assert.equal(h.ai.driving(7), true);
  await h.relay.releaseCommand("boot:1", "boot:1/a");
  // a 의 표식과 hold 는 반환 · b 의 표식은 그대로
  assert.deepEqual(h.captureHolds, [[7, true], [7, true], [7, false], [7, false]]);
  await assert.rejects(asA("ai.leave", { ticket: a.ticket }), (e) => e.code === "NOT_FOUND");
  assert.deepEqual(await asB("ai.leave", { ticket: b.ticket }), { left: true });
  // 정상 반환한 명령에는 할 일이 없음
  await h.relay.releaseCommand("boot:1", "boot:1/b");
  assert.equal(h.captureHolds.length, 4);
  // 다른 세대·모르는 명령은 무시
  await h.relay.releaseCommand("boot:9", "boot:9/z");
  await h.relay.releaseCommand("boot:1", "boot:1/none");
});

const LAYOUT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const MARK = { temporaryLayout: true };
const layoutCalls = (h) => h.sent.filter((item) => item.method?.startsWith("Emulation.")).map((item) => [item.method, item.params]);

test("releaseCommand 는 명령이 걸고 못 지운 임시 layout 덮어쓰기를 지운다", async () => {
  const h = harness();
  h.deps.viewport.explicit = () => null;
  await h.relay.acceptGeneration("boot:1");
  const as = (command, args) => h.request(command, args, { commandId: "boot:1/a", callId: "1" });
  await as("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT, ...MARK });
  await h.relay.releaseCommand("boot:1", "boot:1/a");
  assert.deepEqual(layoutCalls(h), [["Emulation.setDeviceMetricsOverride", LAYOUT], ["Emulation.clearDeviceMetricsOverride", {}]]);
});

test("명령이 스스로 지운 layout 은 반환하지 않고 사람이 정한 viewport 가 있으면 그 값으로 되돌린다", async () => {
  const h = harness();
  h.deps.viewport.explicit = () => null;
  await h.relay.acceptGeneration("boot:1");
  const as = (id) => (command, args) => h.request(command, args, { commandId: `boot:1/${id}`, callId: "1" });
  const a = as("a");
  await a("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT, ...MARK });
  await a("cdp.send", { method: "Emulation.clearDeviceMetricsOverride", params: {}, ...MARK });
  await h.relay.releaseCommand("boot:1", "boot:1/a");
  assert.equal(layoutCalls(h).length, 2);
  // 사람 viewport 가 있음
  h.deps.viewport.explicit = () => ({ width: 390, height: 844, dpr: 2 });
  const b = as("b");
  await b("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT, ...MARK });
  await h.relay.releaseCommand("boot:1", "boot:1/b");
  assert.deepEqual(layoutCalls(h).slice(2), [["Emulation.setDeviceMetricsOverride", LAYOUT],
    ["Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: false }]]);
  // 표시 없는 Emulation 호출은 반환 대상이 아님 (크기가 같아도)
  await as("c")("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT });
  await h.relay.releaseCommand("boot:1", "boot:1/c");
  assert.equal(layoutCalls(h).length, 5);
  // 표시가 있으면 다른 크기도 반환
  h.deps.viewport.explicit = () => null;
  await as("d")("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: { ...LAYOUT, width: 800, height: 600 }, ...MARK });
  await h.relay.releaseCommand("boot:1", "boot:1/d");
  assert.deepEqual(layoutCalls(h).slice(5), [["Emulation.setDeviceMetricsOverride", { ...LAYOUT, width: 800, height: 600 }], ["Emulation.clearDeviceMetricsOverride", {}]]);
});

test("retire 는 단위가 닫히지 못한 layout 덮어쓰기도 지운다", async () => {
  const h = harness();
  h.deps.viewport.explicit = () => null;
  await h.relay.acceptGeneration("boot:1");
  await h.request("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT, ...MARK }, { commandId: "boot:1/z", callId: "1" });
  await h.relay.retireGeneration("boot:1");
  assert.equal(layoutCalls(h).at(-1)[0], "Emulation.clearDeviceMetricsOverride");
});

test("result.redact 는 최종 응답을 같은 탭 키의 비밀 가리기에 거친다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  assert.deepEqual(await h.request("result.redact", { value: { ok: false, error: "값 secret-value 에서 멈춤" } }),
    { value: { ok: false, error: "값 •••••••• 에서 멈춤" } });
});

test("숨은 탭 click 중 확인 창이 막아 단위가 end 로 닫히면 덮어쓰기가 풀리고 사람 viewport 는 유지된다", async () => {
  const { createCommandUnits } = require("../native/electron/relay/command-units.cjs");
  for (const human of [null, { width: 390, height: 844, dpr: 2 }]) {
    const h = harness();
    h.deps.viewport.explicit = () => human;
    await h.relay.acceptGeneration("boot:1");
    const units = createCommandUnits({
      queues: new Map(), execute: (request) => h.relay.execute(request), redact: (_k, v) => v, attachMoments: (_k, _c, v) => v,
      resetSession() {}, codedError: coded, tailGraceMs: 5,
      onClose: ({ generation, commandId }) => h.relay.releaseCommand(generation, commandId),
    });
    const call = (command, args, phase) => units.run({ workerGeneration: "boot:1", commandId: "boot:1/click", callId: command, command, target: h.target, args },
      { unit: { command: "click", phase }, key: 7 });
    await call("cdp.send", { method: "Emulation.setDeviceMetricsOverride", params: LAYOUT, ...MARK }, "run");
    // 확인 창 때문에 worker 가 withLayout 의 해제 호출을 못 보내고 end 로 닫음
    await call("unit.end", {}, "end");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const calls = layoutCalls(h);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], human ? ["Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: false }]
      : ["Emulation.clearDeviceMetricsOverride", {}]);
  }
});

test("cdp.gate 는 메인의 noCdp 판정과 붙임 결과를 그대로 돌려준다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  assert.deepEqual(await h.request("cdp.gate", { command: "goto", url: "https://example.test/" }), { noCdp: false, documentGeneration: 3, debuggerGeneration: 5 });
  assert.deepEqual(await h.request("cdp.gate", { command: "goto", url: "https://accounts.google.com/x" }), { noCdp: true, documentGeneration: 3, debuggerGeneration: 6 });
  assert.deepEqual(h.gates, [[7, "goto", "https://example.test/"], [7, "goto", "https://accounts.google.com/x"]]);
});

test("cdp.sync 와 result.redact 는 세대가 바뀐 뒤에도 실행되고 다른 명령은 STALE_TARGET 이다", async () => {
  const h = harness({ generations: { documentGeneration: 9, debuggerGeneration: 4 } });
  await h.relay.acceptGeneration("boot:1");
  assert.deepEqual(await h.request("cdp.sync"), { documentGeneration: 9, debuggerGeneration: 4 });
  assert.deepEqual(await h.request("result.redact", { value: { a: "secret-value" } }), { value: { a: "••••••••" } });
  for (const command of ["cdp.send", "wc.info", "hold.capture", "ai.enter", "cdp.gate"]) {
    await assert.rejects(h.request(command, { method: "Runtime.evaluate", command: "goto" }), (e) => e.code === "STALE_TARGET", command);
  }
  // 앱 셸은 세대와 관계없이 거부
  await assert.rejects(h.request("cdp.sync", {}, { target: { wcId: 1, documentGeneration: 9, debuggerGeneration: 4 } }), (e) => e.code === "STALE_TARGET");
});

test("wc.navHistory 는 기록이 없으면 moved:false, 있으면 이동이 끝난 뒤의 주소와 세대를 돌려준다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  h.guest.canGoBack = () => false;
  assert.deepEqual(await h.request("wc.navHistory", { dir: "back" }), { moved: false, documentGeneration: 3, debuggerGeneration: 4 });
  h.guest.canGoBack = () => true;
  const moving = h.request("wc.navHistory", { dir: "back" });
  await new Promise((resolve) => setImmediate(resolve));
  h.guest.emit("did-navigate");
  assert.deepEqual(await moving, { moved: true, url: "https://example.test/page", documentGeneration: 3, debuggerGeneration: 4 });
  assert.deepEqual(h.sent.filter((item) => item.nav), [{ nav: "back" }]);
  h.guest.navigationHistory = { canGoBack: () => false, canGoForward: () => true, goForward: () => h.sent.push({ nav: "nh-forward" }) };
  const forward = h.request("wc.navHistory", { dir: "forward" });
  await new Promise((resolve) => setImmediate(resolve));
  h.guest.emit("did-navigate");
  assert.equal((await forward).moved, true);
  assert.equal(h.sent.some((item) => item.nav === "nh-forward"), true);
  await assert.rejects(h.request("wc.navHistory", { dir: "up" }), (e) => e.code === "INVALID_REQUEST");
});

test("이미지 기본 명령은 대상 탭 없이 인자 검사 뒤 메인 도구를 부른다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const none = { target: {} };
  assert.deepEqual(await h.request("cdp.screencastShot", { ms: 50 }), { data: Buffer.from("cast").toString("base64") });
  assert.deepEqual(h.images.at(-1), ["screencast", 7, 100]);
  assert.deepEqual(await h.request("img.stitch", { tiles: [{ y: 0, d: "AA" }, { y: 60, d: "BB" }], W: 100, H: 200, px: 2 }, none), { data: Buffer.from("stitched").toString("base64") });
  assert.deepEqual(h.images.at(-1), ["stitch", 2, 100, 200, 2]);
  await assert.rejects(h.request("img.stitch", { tiles: [], W: 1, H: 1 }, none), (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(h.request("img.stitch", { tiles: [{ y: 0, d: "AA" }], W: 0, H: 1 }, none), (e) => e.code === "INVALID_REQUEST");
  assert.deepEqual(await h.request("img.diff", { before: "/a.png", after: "/b.png", out: "/c.png", threshold: 10 }, none), { changed: 1, total: 4, ratio: 25 });
  assert.deepEqual(h.images.at(-1), ["diff", "/a.png", "/b.png", "/c.png", 10]);
  assert.deepEqual(await h.request("img.diff", { before: "/a.png", after: "/b.png", out: "/c.png" }, none), { changed: 1, total: 4, ratio: 25 });
  assert.equal(h.images.at(-1)[4], 24);
  await assert.rejects(h.request("img.diff", { before: "a.png", after: "/b.png", out: "/c.png" }, none), (e) => e.code === "INVALID_REQUEST");
  assert.deepEqual(await h.request("img.same", { prev: "/a.png", data: Buffer.from("png").toString("base64") }, none), { same: true });
  assert.deepEqual(await h.request("img.same", { prev: "/a.png", data: Buffer.from("other").toString("base64") }, none), { same: false });
  await assert.rejects(h.request("img.same", { prev: "a.png", data: "AA" }, none), (e) => e.code === "INVALID_REQUEST");
});

test("⑦ 네이티브 조각: login.fill 은 사람 개입이 필요할 때만 붙임을 풀고 비밀은 지워서 돌려준다", async () => {
  const h = harness();
  const released = [];
  const remembered = [];
  h.deps.releaseAttach = (wcId) => released.push(wcId);
  h.deps.rememberSecret = (wcId, secret, options) => remembered.push([wcId, secret, options]);
  await h.relay.acceptGeneration("boot:1");
  h.deps.loginProvider = async () => ({ ok: true, origin: "https://example.test", username: "user", secret: "pw-x" });
  const filled = await h.request("login.fill", { username: "user" });
  assert.equal("secret" in filled, false);
  assert.deepEqual(remembered, [[7, "pw-x", { allowShort: true }]]);
  assert.deepEqual(released, []);
  for (const result of [{ ok: false, needUser: true, origin: "https://example.test", reason: "no-saved" }, { ok: false, needUser: true, reason: "not-allowed" }]) {
    h.deps.loginProvider = async () => ({ ...result });
    assert.equal((await h.request("login.fill", {})).needUser, true);
  }
  assert.deepEqual(released, [7, 7]);
  h.deps.loginProvider = async () => ({ ok: false, choose: true, accounts: ["a"] });
  assert.equal((await h.request("login.fill", {})).choose, true);
  assert.deepEqual(released, [7, 7]);
});

test("⑦ 네이티브 조각: download.configure 는 폴더를 만들 수 없으면 INVALID_REQUEST 와 옛 문구를 돌려준다", async () => {
  const h = harness();
  await h.relay.acceptGeneration("boot:1");
  const blocker = new URL("./mcp-worker-native-route.mjs", import.meta.url).pathname;
  await assert.rejects(() => h.relay.execute({ workerGeneration: "boot:1", commandId: "boot:1/9", callId: "1",
    command: "download.configure", args: { dir: `${blocker}/sub` } }),
  (error) => error.code === "INVALID_REQUEST" && /^폴더를 만들 수 없습니다: /.test(error.message));
  assert.equal(h.download.dir, null, "무장하지 않음");
});
