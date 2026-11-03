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
const { createCdpSession } = require("../native/electron/cdp-session.cjs");
const { createCdpTransport } = require("../native/electron/cdp-transport.cjs");
const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, ".working", "20261101-1716-mcp-app-separation", "scratch", "f9a");

const waitFor = async (check, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("조건을 기다리다 시간이 초과됐습니다.");
};

test("CDP 미부착 탭은 실행기 재연결 뒤 첫 MCP 명령에 성공한다", { timeout: 30_000 }, async () => {
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "relay-reconnect-"));
  const stateDir = path.join(fixture, "state");
  const workspace = path.join(fixture, "workspace");
  for (const directory of [stateDir, workspace]) fs.mkdirSync(directory, { recursive: true });

  process.env.IRIS_STATE_DIR = stateDir;
  process.env.IRIS_PORT = "42983";
  process.env.PORT = "42983";
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
          : request.method === "pane.list" ? { panes: [{ workspace_id: "X", pane_id: "A", cwd: workspace }] } : { tabs: [] };
      queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`)));
      return true;
    };
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(() => connected?.());
    return socket;
  };

  let requestHandler, wss;
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
  await import(`../server/index.js?electron-reconnect=${path.basename(fixture)}`);
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
    const response = { statusCode: 200, writeHead(code) { this.statusCode = code; return this; },
      end(raw = "") { try { resolve({ status: this.statusCode, body: JSON.parse(String(raw) || "{}") }); } catch (error) { reject(error); } } };
    requestHandler(input, response);
  });

  const electronSockets = [];
  const reconnects = [];
  let accepted = 0;
  const renderer = new EventEmitter();
  renderer.readyState = 1;
  renderer.send = raw => {
    const message = JSON.parse(String(raw));
    if (message.type === "browser-tabs-resync") queueMicrotask(() => renderer.emit("message", Buffer.from(JSON.stringify({
      type: "browser-tab-wc", wc: 101, tabId: "tab-a", space: "X", url: "https://e2e.test/", win: "console",
    }))));
  };
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
      this.serverSocket.close = () => this.disconnect();
      this.send = raw => queueMicrotask(() => this.serverSocket.emit("message", Buffer.from(raw)));
      electronSockets.push(this);
      queueMicrotask(() => {
        wss.clients.add(this.serverSocket);
        wss.emit("connection", this.serverSocket, { socket: { remoteAddress: "127.0.0.1" } });
        this.readyState = 1;
        this.emit("open");
      });
    }
    disconnect() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      wss.clients.delete(this.serverSocket);
      this.serverSocket.emit("close");
      this.emit("close");
    }
    close() { this.disconnect(); }
    terminate() { this.disconnect(); }
  }

  let session;
  const transport = createCdpTransport({
    WebSocket: ElectronSocket,
    port: 42983,
    cdpExec: async (_webContents, _wcId, command) => command === "url"
      ? { url: "https://e2e.test/" } : { ok: true, url: "https://e2e.test/" },
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    tabGoneCode: "tab_gone",
    execPath: "/fixture/Iris.app",
    pid: 7001,
    relayControl: {
      acceptGeneration: async () => { accepted += 1; return { accepted: true }; },
      retireGeneration: async () => ({ retired: true }),
      isBaseCommand: () => true,
    },
    onRegistered: () => session.replayExecutorState(),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    setTimeoutFn: callback => { reconnects.push(callback); return { unref() {} }; },
    log() {}, error() {},
  });
  session = createCdpSession({
    observation: { dialogOpen: () => null },
    hiddenViewport: {}, overlay: {}, refRegistry: {}, upload: {}, deviceEmulation: {},
    ctlSend: transport.ctlSend,
    tagError: (error, code) => Object.assign(error, { code }),
    sessionDetachedCode: "session_detached",
  });
  let attached = 0;
  const guest = { id: 101, debugger: { isAttached: () => false, attach: () => { attached += 1; } } };
  session.registerSessionPrimer(guest.id, () => {});
  const sendRenderer = message => renderer.emit("message", Buffer.from(JSON.stringify(message)));
  sendRenderer({ type: "browser-sync", mutation: { op: "group.create", space: "X", id: "ai:A", name: "A" } });
  sendRenderer({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: "tab-a", url: "https://e2e.test/", group: "ai:A" } });
  sendRenderer({ type: "browser-tab-wc", wc: guest.id, tabId: "tab-a", space: "X", url: "https://e2e.test/", win: "console" });
  transport.setupCdpControl({ fromId: id => Number(id) === guest.id ? guest : null });
  const browserRuntime = await import("../server/browser-runtime.js");
  await waitFor(async () => accepted >= 1 && (await request("GET", "/mcp-worker/status")).body.accepting);
  await waitFor(() => browserRuntime.hasTab("tab-a") && browserRuntime.wcOfTabId("tab-a") === guest.id);

  electronSockets[0].disconnect();
  assert.ok(reconnects.length > 0);
  reconnects.shift()();
  await waitFor(() => accepted >= 2);
  await waitFor(() => browserRuntime.hasTab("tab-a") && browserRuntime.wcOfTabId("tab-a") === guest.id);

  const result = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: "tab-a" } })).body;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data?.url, "https://e2e.test/");
  assert.equal(attached, 0);
  electronSockets.at(-1)?.disconnect();
  renderer.close();
});
