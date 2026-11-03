import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCdpTransport } = require("../native/electron/cdp-transport.cjs");
const { createElectronRelay } = require("../native/electron/relay/index.cjs");
const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, ".working", "20261101-1716-mcp-app-separation", "scratch", "f10a");

const waitFor = async (check, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("조건을 기다리다 시간이 초과됐습니다.");
};

test("F10a Electron 중계 계약", { timeout: 45_000 }, async (t) => {
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "relay-"));
  const stateDir = path.join(fixture, "state");
  const workspace = path.join(fixture, "workspace");
  const uploadPath = path.join(fixture, "upload.txt");
  const downloadDir = path.join(fixture, "download");
  for (const directory of [stateDir, workspace, downloadDir]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(uploadPath, "fixture");

  process.env.IRIS_STATE_DIR = stateDir;
  process.env.IRIS_PORT = "42984";
  process.env.PORT = "42984";
  process.env.IRIS_BUNDLE_ID = "development";
  process.env.REMOTE = "";

  net.connect = (_socketPath, connected) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = raw => {
      const request = JSON.parse(String(raw).trim());
      const result = request.method === "agent.list"
        ? { agents: [{ agent: "codex", agent_status: "idle", cwd: workspace, workspace_id: "X", pane_id: "A", focused: true }] }
        : request.method === "workspace.list" ? { workspaces: [{ workspace_id: "X", label: "X" }] }
          : request.method === "pane.get" ? { pane: { workspace_id: "X", pane_id: "A", cwd: workspace } }
            : request.method === "pane.list" ? { panes: [{ workspace_id: "X", pane_id: "A", cwd: workspace }] } : { tabs: [] };
      queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`)));
      return true;
    };
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(() => connected?.());
    return socket;
  };

  let requestHandler;
  let wss;
  class FakeHttpServer extends EventEmitter {
    listen(...args) { queueMicrotask(() => args.find(value => typeof value === "function")?.()); return this; }
  }
  http.createServer = handler => { requestHandler = handler; return new FakeHttpServer(); };
  const originalOn = EventEmitter.prototype.on;
  EventEmitter.prototype.on = function (event, listener) {
    if (this.constructor?.name === "WebSocketServer") wss = this;
    return originalOn.call(this, event, listener);
  };
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  const server = await import(`../server/index.js?electron-f10a=${path.basename(fixture)}`);
  EventEmitter.prototype.on = originalOn;
  globalThis.setInterval = originalInterval;
  assert.ok(requestHandler && wss);

  const request = (method, url, value) => new Promise((resolve, reject) => {
    const body = value === undefined ? "" : JSON.stringify(value);
    const input = Readable.from(body ? [body] : []);
    input.method = method;
    input.url = url;
    input.headers = {};
    input.socket = { remoteAddress: "127.0.0.1" };
    const response = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code; return this; },
      end(raw = "") {
        try { resolve({ status: this.statusCode, body: JSON.parse(String(raw) || "{}") }); }
        catch (error) { reject(error); }
      },
    };
    requestHandler(input, response);
  });

  const state = {
    url: "https://accounts.google.com/signin/v2/identifier",
    pendingUrl: "",
    title: "Google 로그인",
    bindings: new Set(),
    screencast: false,
    upload: null,
    viewport: { width: 1200, height: 800, dpr: 1 },
    deviceViewport: { width: 1200, height: 800, dpr: 1 },
    viewportRevision: 0,
    download: { dir: null, once: false, last: null },
    downloadDisarms: 0,
    nextAiTicket: 1,
    blockNextLeave: false,
    finishLeave: null,
  };
  const guest = {
    id: 101,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => false,
    getZoomFactor: () => 1,
    canGoBack: () => false,
    canGoForward: () => false,
    loadURL: async url => { state.url = String(url); state.pendingUrl = ""; },
    debugger: {
      isAttached: () => true,
      sendCommand: async (method, params = {}) => {
        if (method === "Runtime.addBinding") state.bindings.add(String(params.name));
        if (method === "Runtime.removeBinding") state.bindings.delete(String(params.name));
        if (method === "Page.startScreencast") state.screencast = true;
        if (method === "Page.stopScreencast") state.screencast = false;
        if (method === "Emulation.setDeviceMetricsOverride") {
          state.viewport = { width: params.width, height: params.height, dpr: params.deviceScaleFactor || 0 };
        }
        if (method === "Emulation.clearDeviceMetricsOverride") state.viewport = null;
        return {};
      },
    },
  };
  const codedError = (code, message) => Object.assign(new Error(message), { code });
  const relay = createElectronRelay({
    webContents: { fromId: id => Number(id) === guest.id ? guest : null },
    targetState: {
      generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }),
      ownsChildSession: () => false,
      isRegistered: () => true,
    },
    currentUrl: () => state.url,
    pendingUrl: () => state.pendingUrl,
    blockedUrl: url => new URL(url).hostname === "accounts.google.com",
    redact: (_wcId, value) => value,
    rememberSecret() {},
    codedError,
    ai: {
      enter: () => `ticket-${state.nextAiTicket++}`,
      leave: () => {
        if (!state.blockNextLeave) return;
        state.blockNextLeave = false;
        return new Promise(resolve => { state.finishLeave = resolve; });
      },
    },
    upload: {
      invalidPaths: () => [],
      arm: (_wcId, files) => { state.upload = [...files]; },
      forget: () => { state.upload = null; },
    },
    viewport: {
      explicit: () => state.deviceViewport,
      current: () => state.deviceViewport,
      revision: () => state.viewportRevision,
      apply: async (_wc, value) => {
        state.deviceViewport = value ? { ...value } : null;
        state.viewport = value ? { ...value } : null;
        state.viewportRevision += 1;
        return value;
      },
    },
    qaViewport: async (_wc, value) => {
      if (value.clear) {
        state.deviceViewport = null;
        state.viewport = null;
        state.viewportRevision += 1;
        return { clear: true };
      }
      const next = { width: value.width, height: value.height, dpr: value.dpr ?? 1 };
      state.deviceViewport = next;
      state.viewport = { ...next };
      state.viewportRevision += 1;
      return next;
    },
    qaViewportRelease() {},
    downloadState: {
      snapshot: () => ({ ...state.download }),
      arm: (dir, once) => { state.download.dir = dir; state.download.once = once; },
      disarm: () => {
        state.download.dir = null;
        state.download.once = false;
        state.downloadDisarms += 1;
      },
    },
    cancelTarget() {},
  });

  const renderer = new EventEmitter();
  renderer.readyState = 1;
  renderer.send = () => {};
  renderer.close = () => { renderer.readyState = 3; renderer.emit("close"); };
  wss.clients.add(renderer);
  wss.emit("connection", renderer, { socket: { remoteAddress: "127.0.0.1" } });

  class ElectronSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      this.serverSocket = new EventEmitter();
      this.serverSocket.readyState = 1;
      this.serverSocket.ping = () => {};
      this.serverSocket.send = raw => queueMicrotask(() => this.emit("message", Buffer.from(raw)));
      this.serverSocket.close = () => this.close();
      this.send = raw => queueMicrotask(() => this.serverSocket.emit("message", Buffer.from(raw)));
      queueMicrotask(() => {
        wss.clients.add(this.serverSocket);
        wss.emit("connection", this.serverSocket, { socket: { remoteAddress: "127.0.0.1" } });
        this.readyState = 1;
        this.emit("open");
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      wss.clients.delete(this.serverSocket);
      this.serverSocket.emit("close");
      this.emit("close");
    }
    terminate() { this.close(); }
  }

  const aliases = {
    "f10a-url": { command: "wc.info", args: () => ({}) },
    "f10a-goto": { command: "wc.nav", args: args => ({ action: "load", url: args.url }) },
    "f10a-cdp": { command: "cdp.send", args: () => ({ method: "Runtime.evaluate", params: { expression: "location.href" } }) },
    "f10a-binding": { command: "cdp.send", args: () => ({ method: "Runtime.addBinding", params: { name: "same" } }) },
    "f10a-screencast": { command: "cdp.send", args: () => ({ method: "Page.startScreencast", params: {} }) },
    "f10a-upload": { command: "upload.arm", args: () => ({ paths: [uploadPath] }) },
    "f10a-qa-viewport": { command: "viewport.qa", args: args => args },
    "f10a-temp-viewport": { command: "viewport.setTemporary", args: args => args },
    "f10a-delay-cleanup": { command: "ai.enter", args: () => ({}) },
    "f10a-download": { command: "download.configure", args: () => ({ dir: downloadDir }) },
  };
  const relayExecute = async (_webContents, wcId, command, args, meta) => {
    const alias = aliases[command];
    if (!alias) throw codedError("INVALID_REQUEST", `알 수 없는 테스트 명령: ${command}`);
    const result = await relay.execute({
      workerGeneration: meta.workerGeneration,
      commandId: meta.commandId,
      callId: meta.callId,
      command: alias.command,
      target: { ...(meta.targetToken || {}), wcId: Number(wcId) },
      args: alias.args(args || {}),
    });
    if (command === "f10a-url") return { url: result.url, title: result.title };
    if (command === "f10a-goto") return { ok: true, url: result.url };
    return result;
  };
  let transport;
  transport = createCdpTransport({
    WebSocket: ElectronSocket,
    port: 42984,
    cdpExec: relayExecute,
    codedError,
    tabGoneCode: "tab_gone",
    execPath: "/fixture/Iris.app",
    pid: 7101,
    relayControl: {
      acceptGeneration: (generation, connection, options) => relay.acceptGeneration(generation, connection, options),
      retireGeneration: (generation, options) => relay.retireGeneration(generation, options),
      isBaseCommand: command => aliases[command] != null,
    },
    onRegistered: () => transport.ctlSend({ type: "browser-target-generation", wc: guest.id,
      documentGeneration: 1, debuggerGeneration: 1 }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    log() {},
    error() {},
  });
  transport.setupCdpControl({ fromId: id => Number(id) === guest.id ? guest : null });

  const sendRenderer = message => renderer.emit("message", Buffer.from(JSON.stringify(message)));
  sendRenderer({ type: "browser-sync", mutation: { op: "group.create", space: "X", id: "ai:A", name: "A" } });
  sendRenderer({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: "tab-a", url: state.url, group: "ai:A" } });
  sendRenderer({ type: "browser-tab-wc", wc: guest.id, tabId: "tab-a", space: "X", url: state.url, win: "console" });
  await waitFor(async () => (await request("GET", "/mcp-worker/status")).body.accepting);

  const browserCommand = async (command, args = {}) => (await request("POST", "/browser-cmd", {
    cmd: command,
    session: "A",
    args: { tab: "tab-a", ...args },
  })).body;
  const recover = async () => {
    const result = await request("POST", "/mcp-worker/activate", { recover: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.worker.workerGeneration;
  };
  const delayCleanup = async () => {
    state.blockNextLeave = true;
    state.finishLeave = null;
    assert.equal((await browserCommand("f10a-delay-cleanup")).ok, true);
  };
  const finishCleanup = async (previousDisarms) => {
    await waitFor(() => typeof state.finishLeave === "function");
    state.finishLeave();
    await waitFor(() => state.downloadDisarms > previousDisarms);
  };

  await t.test("Google 로그인 호스트의 비-CDP 명령은 eb90977 결과를 유지한다", async () => {
    assert.deepEqual(await browserCommand("f10a-url"), {
      ok: true,
      data: { url: "https://accounts.google.com/signin/v2/identifier", title: "Google 로그인" },
    });
    state.pendingUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    state.url = "https://example.test/before";
    assert.deepEqual(await browserCommand("f10a-url"), {
      ok: true,
      data: { url: "https://example.test/before", title: "Google 로그인" },
    });
    const goto = await browserCommand("f10a-goto", { url: "https://example.test/after" });
    assert.deepEqual(goto, { ok: true, data: { ok: true, url: "https://example.test/after" } });
    state.url = "https://accounts.google.com/signin/v2/identifier";
    const cdp = await browserCommand("f10a-cdp");
    assert.equal(cdp.ok, false);
    assert.equal(cdp.code, "STALE_TARGET");
  });

  await t.test("이전 세대 정리는 새 binding·screencast·upload를 해제하지 않는다", async () => {
    state.url = "https://example.test/resources";
    state.pendingUrl = "";
    await delayCleanup();
    for (const command of ["f10a-binding", "f10a-screencast", "f10a-upload", "f10a-download"]) {
      assert.equal((await browserCommand(command)).ok, true, command);
    }
    const previousDisarms = state.downloadDisarms;
    await recover();
    for (const command of ["f10a-binding", "f10a-screencast", "f10a-upload"]) {
      assert.equal((await browserCommand(command)).ok, true, command);
    }
    await finishCleanup(previousDisarms);
    assert.deepEqual([...state.bindings], ["same"]);
    assert.equal(state.screencast, true);
    assert.deepEqual(state.upload, [uploadPath]);

    await browserCommand("f10a-download");
    const nextDisarms = state.downloadDisarms;
    await recover();
    await waitFor(() => state.downloadDisarms > nextDisarms);
    assert.deepEqual([...state.bindings], []);
    assert.equal(state.screencast, false);
    assert.equal(state.upload, null);
  });

  await t.test("viewport 종류가 바뀌어도 두 세대 정리 뒤 시작 크기로 복원한다", async () => {
    const original = { width: 1200, height: 800, dpr: 1 };
    state.viewport = { ...original };
    state.deviceViewport = { ...original };
    await delayCleanup();
    assert.equal((await browserCommand("f10a-qa-viewport", { width: 390, height: 844, dpr: 2 })).ok, true);
    assert.equal((await browserCommand("f10a-download")).ok, true);
    const previousDisarms = state.downloadDisarms;
    await recover();
    assert.equal((await browserCommand("f10a-temp-viewport", { width: 800, height: 600, dpr: 1 })).ok, true);
    await finishCleanup(previousDisarms);
    assert.deepEqual(state.viewport, { width: 800, height: 600, dpr: 1 });

    assert.equal((await browserCommand("f10a-download")).ok, true);
    const nextDisarms = state.downloadDisarms;
    await recover();
    await waitFor(() => state.downloadDisarms > nextDisarms);
    assert.deepEqual(state.viewport, original);
  });

  await server.workerSupervisor.shutdown();
  renderer.close();
});
