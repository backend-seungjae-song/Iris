// browser_close_tab(closetab)이 자기 그룹 탭만 닫는지, 실제 WebSocket·/browser-cmd 핸들러로 확인한다.
// 서버 기동 하네스는 popup-tab-access.mjs 와 같다.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 10_000, interval = 20 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error("조건을 기다리다 시간 초과");
}

async function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-close-tab-"));
  const home = path.join(root, "home"), stateDir = path.join(root, "state");
  const folders = { X: path.join(root, "workspace-x"), Y: path.join(root, "workspace-y") };
  for (const dir of [home, stateDir, folders.X, folders.Y]) fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = home;
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.IRIS_PORT = "42921";
  process.env.PORT = "42921";
  process.env.REMOTE = "";

  const agents = [
    { agent: "codex", agent_status: "idle", cwd: folders.X, workspace_id: "X", pane_id: "A", focused: true },
    { agent: "codex", agent_status: "idle", cwd: folders.X, workspace_id: "X", pane_id: "B", focused: false },
    { agent: "codex", agent_status: "idle", cwd: folders.Y, workspace_id: "Y", pane_id: "C", focused: false },
  ];
  const herdrReply = (req) => {
    if (req.method === "agent.list") return { agents };
    if (req.method === "workspace.list") return { workspaces: [
      { workspace_id: "X", label: "X" }, { workspace_id: "Y", label: "Y" },
    ] };
    if (req.method === "pane.list") return { panes: req.params?.workspace_id
      ? agents.filter((a) => a.workspace_id === req.params.workspace_id) : agents };
    if (req.method === "tab.list") return { tabs: [] };
    return {};
  };

  // CI 샌드박스는 listen을 막는다. 서버 코드를 복제하지 않고, transport만 메모리 대역으로 바꿔
  // 실제 Herdr 재계산·WS message 핸들러·HTTP request 핸들러를 그대로 실행한다.
  net.connect = (_socketPath, connected) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = (raw) => {
      let req; try { req = JSON.parse(String(raw).trim()); } catch { return false; }
      queueMicrotask(() => socket.emit("data", Buffer.from(JSON.stringify({ id: req.id, result: herdrReply(req) }) + "\n")));
      return true;
    };
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(() => connected?.());
    return socket;
  };

  let requestHandler = null;
  class FakeHttpServer extends EventEmitter {
    listen(...args) {
      const callback = args.find((arg) => typeof arg === "function");
      queueMicrotask(() => { callback?.(); this.emit("listening"); });
      return this;
    }
  }
  http.createServer = (handler) => { requestHandler = handler; return new FakeHttpServer(); };

  // ws의 ESM named export는 CJS 프로퍼티를 바꿔도 이미 원래 클래스로 고정된다. 실제 클래스가
  // error 리스너를 붙이는 순간 인스턴스만 잡아, connection 이벤트도 원래 핸들러로 보낸다.
  let wss = null;
  const realOn = EventEmitter.prototype.on;
  EventEmitter.prototype.on = function (event, listener) {
    if (this.constructor?.name === "WebSocketServer") wss = this;
    return realOn.call(this, event, listener);
  };

  // 초기 Herdr connect가 재계산을 일으키므로 주기 안전망은 이 검사에 필요 없다. 남겨 두면 완료 뒤에도
  // 새 Herdr 요청 타이머를 만들어 테스트 프로세스를 붙잡는다.
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === 5_000) timer.unref?.(); // HerdrClient의 이미 응답한 요청 안전망
    return timer;
  };
  await import(`../server/index.js?close-tab-test=${path.basename(root)}`);
  globalThis.setInterval = realSetInterval;
  EventEmitter.prototype.on = realOn;
  assert.ok(requestHandler && wss, "서버 transport를 포착하지 못했다");

  const outbound = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (raw) => { try { outbound.push(JSON.parse(String(raw))); } catch {} };
  socket.ping = () => {};
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  wss.clients.add(socket);
  wss.emit("connection", socket, { socket: { remoteAddress: "127.0.0.1" } });

  const sendWs = (message) => socket.emit("message", Buffer.from(JSON.stringify(message)));
  const sendWsAndFind = async (message, predicate) => {
    const start = outbound.length;
    sendWs(message);
    return waitFor(() => outbound.slice(start).find(predicate));
  };
  const browserCmd = (cmd, session, args = {}) => new Promise((resolve, reject) => {
    const req = Readable.from([JSON.stringify({ cmd, session, args })]);
    req.method = "POST"; req.url = "/browser-cmd"; req.headers = {};
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = {
      writeHead() { return this; },
      end(raw = "") {
        try { resolve(JSON.parse(String(raw))); } catch (error) { reject(error); }
      },
    };
    requestHandler(req, res);
  });

  await waitFor(async () => (await browserCmd("tabs", "A")).data?.space === "X");
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    socket.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { stateDir, browserCmd, sendWs, sendWsAndFind, outbound };
}

test("closetab은 이 세션 그룹의 탭만 닫고 닫은 탭을 복원 목록에 남긴다", { timeout: 30_000 }, async (t) => {
  const { browserCmd, sendWs, sendWsAndFind, stateDir, outbound } = await makeFixture(t);
  for (const mutation of [
    { op: "group.create", space: "X", id: "ai:A", name: "A" },
    { op: "group.create", space: "X", id: "ai:B", name: "B" },
    { op: "tab.open", space: "X", id: "work-a", url: "https://work.test", group: "ai:A" },
    { op: "tab.open", space: "X", id: "result-a", url: "https://result.test", group: "ai:A" },
    { op: "tab.open", space: "X", id: "tab-b", url: "https://b.test", group: "ai:B" },
    { op: "tab.open", space: "X", id: "human", url: "https://human.test" },
  ]) sendWs({ type: "browser-sync", mutation });
  sendWs({ type: "browser-tab-wc", wc: 101, tabId: "work-a", space: "X", url: "https://work.test", win: "console" });
  sendWs({ type: "browser-tab-wc", wc: 102, tabId: "result-a", space: "X", url: "https://result.test", win: "console" });
  sendWs({ type: "browser-tab-wc", wc: 103, tabId: "tab-b", space: "X", url: "https://b.test", win: "console" });
  sendWs({ type: "browser-tab-wc", wc: 104, tabId: "human", space: "X", url: "https://human.test", win: "console" });
  await waitFor(async () => (await browserCmd("tabs", "A")).data.tabs.some((tab) => tab.tabId === "result-a"));

  const missing = await browserCmd("closetab", "A", {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /핸들\(tab\)을 지정/);

  for (const tab of ["tab-b", "human"]) {
    const denied = await browserCmd("closetab", "A", { tab });
    assert.equal(denied.ok, false, `${tab}을 닫았다`);
  }

  // 사용자가 지목해 준 사람 탭은 조작은 되지만 닫지 않는다
  const token = fs.readFileSync(path.join(stateDir, "ui-token"), "utf8").trim();
  assert.equal((await sendWsAndFind({ type: "ui-auth", token }, (m) => m.type === "ui-auth")).ok, true);
  const pending = await sendWsAndFind({ type: "browser-target-set", pane: "A", tabId: "human" },
    (m) => m.type === "target-pending" && m.kind === "tab");
  await browserCmd("prompt-targets", "A", { markers: [pending.delimiter] });
  assert.ok((await browserCmd("tabs", "A")).data.granted.length, "지목이 적용되지 않았다");
  const granted = await browserCmd("closetab", "A", { tab: "human" });
  assert.equal(granted.ok, false);
  assert.match(granted.error, /이 세션 그룹의 탭이 아니라 닫지 않습니다/);

  const start = outbound.length;
  const closed = await browserCmd("closetab", "A", { tab: "work-a" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const ids = (await browserCmd("tabs", "A")).data.tabs.map((tab) => tab.tabId);
  assert.ok(!ids.includes("work-a"));
  assert.ok(ids.includes("result-a"));
  const restore = await waitFor(() => outbound.slice(start).findLast((m) => m.type === "closed-tabs"));
  assert.ok(restore.tabs.some((tab) => tab.tabId === "work-a"), "⌘⇧T 복원 목록에 없다");
  const state = await waitFor(() => outbound.slice(start).findLast((m) => m.type === "browser-state"));
  assert.ok(!JSON.stringify(state).includes('"work-a"'), "상태에 닫은 탭이 남았다");
});
