// native/electron/main.cjs가 팝업 등록 문자열을 갖는지는 bin/smoke.mjs가 이미 본다. 하지만 그 검사는
// 등록된 팝업이 visibleTabsFor를 통과해 실제 목록에 뜨는지는 보지 않는다. 여기서는
// 격리된 서버 모듈의 실제 WebSocket 핸들러와 /browser-cmd 요청 핸들러를 끝까지 지난다.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-popup-access-"));
  const home = path.join(root, "home"), stateDir = path.join(root, "state");
  const folders = { X: path.join(root, "workspace-x"), Y: path.join(root, "workspace-y") };
  for (const dir of [home, stateDir, folders.X, folders.Y]) fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = home;
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.IRIS_PORT = "42919";
  process.env.PORT = "42919";
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
  await import(`../server/index.js?popup-test=${path.basename(root)}`);
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
  return { stateDir, browserCmd, sendWs, sendWsAndFind };
}

test("팝업은 연 세션만 목록·지정으로 제어하고 종료하면 권한도 사라진다", { timeout: 30_000 }, async (t) => {
  const { stateDir, browserCmd, sendWs, sendWsAndFind } = await makeFixture(t);

  await t.test("1. A/B는 X, C는 Y에 묶인 독립 세션이다", async () => {
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((session) => browserCmd("tabs", session)));
    assert.deepEqual([a.data?.space, b.data?.space, c.data?.space], ["X", "X", "Y"]);
  });

  for (const mutation of [
    { op: "group.create", space: "X", id: "ai:A", name: "A" },
    { op: "group.create", space: "X", id: "ai:B", name: "B" },
    { op: "tab.open", space: "X", id: "opener-a", url: "https://a.test", group: "ai:A" },
    { op: "tab.open", space: "X", id: "opener-b", url: "https://b.test", group: "ai:B" },
    { op: "tab.open", space: "X", id: "opener-human", url: "https://human.test" },
  ]) sendWs({ type: "browser-sync", mutation });

  sendWs({ type: "browser-tab-wc", wc: 101, tabId: "opener-a", space: "X", url: "https://a.test", win: "console" });
  sendWs({ type: "browser-tab-wc", wc: 102, tabId: "opener-human", space: "X", url: "https://human.test", win: "console" });
  sendWs({ type: "browser-tab-wc", wc: 201, tabId: "popup-a", openerWc: 101,
    url: "https://popup.test", title: "팝업", win: "popup" });

  await t.test("2. opener와 팝업 등록이 실제 제어 목록까지 도달한다", async () => {
    const tabs = (await browserCmd("tabs", "A")).data.tabs;
    const opener = tabs.find((tab) => tab.tabId === "opener-a");
    const popup = tabs.find((tab) => tab.tabId === "popup-a");
    assert.ok(opener, "opener 등록이 목록에 없다");
    assert.equal(popup?.openerTabId, "opener-a");
    assert.equal(popup?.ownerSpace, "X");
    assert.equal(popup?.ownerGroup, "ai:A");
  });

  await t.test("3. A의 tabs 응답에는 팝업 핸들이 있다", async () => {
    const popup = (await browserCmd("tabs", "A")).data.tabs.find((tab) => tab.tabId === "popup-a");
    assert.ok(popup?.handle, "A가 팝업 핸들을 받지 못했다");
  });

  await t.test("4. 같은 스페이스 B와 다른 스페이스 C에는 팝업이 없다", async () => {
    for (const session of ["B", "C"]) {
      const ids = (await browserCmd("tabs", session)).data.tabs.map((tab) => tab.tabId);
      assert.ok(!ids.includes("popup-a"), `${session}에 A의 팝업이 노출됐다`);
    }
  });

  await t.test("5. 팝업 명시 지정은 A에서 통과하고 B에서 거부된다", async () => {
    const allowed = await browserCmd("target", "A", { tab: "popup-a" });
    const denied = await browserCmd("target", "B", { tab: "popup-a" });
    assert.equal(allowed.ok, true);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /이 세션이 쓸 수 있는 탭이 아닙니다/);
  });

  await t.test("6. opener wc가 재사용돼도 재등록한 팝업 소유권은 A에 남는다", async () => {
    sendWs({ type: "browser-tab-gone", tabId: "opener-a", wc: 101 });
    sendWs({ type: "browser-tab-wc", wc: 101, tabId: "opener-b", space: "X", url: "https://b.test", win: "console" });
    sendWs({ type: "browser-tab-wc", wc: 201, tabId: "popup-a", openerWc: 101,
      url: "https://popup.test/next", title: "바뀐 제목", win: "popup" });
    const [a, b] = await Promise.all([browserCmd("tabs", "A"), browserCmd("tabs", "B")]);
    assert.ok(a.data.tabs.some((tab) => tab.tabId === "popup-a"));
    assert.ok(!b.data.tabs.some((tab) => tab.tabId === "popup-a"));
    const popup = a.data.tabs.find((tab) => tab.tabId === "popup-a");
    assert.deepEqual([popup.ownerSpace, popup.ownerGroup, popup.openerTabId], ["X", "ai:A", "opener-a"]);
  });

  await t.test("7. 그룹 없는 opener의 팝업은 어느 세션에도 보이지 않는다", async () => {
    await sendWsAndFind({ type: "browser-tab-wc", wc: 202, tabId: "popup-human", openerWc: 102,
      url: "https://human-popup.test", title: "사람 팝업", win: "popup" },
    (m) => m.type === "tab-handles" && m.map?.["popup-human"]);
    for (const session of ["A", "B", "C"]) {
      const ids = (await browserCmd("tabs", session)).data.tabs.map((tab) => tab.tabId);
      assert.ok(!ids.includes("popup-human"), `${session}이 그룹 없는 opener의 팝업을 얻었다`);
    }
  });

  await t.test("8. 팝업 종료는 pin·grant·last의 persisted 유령을 남기지 않는다", async () => {
    const token = fs.readFileSync(path.join(stateDir, "ui-token"), "utf8").trim();
    const auth = await sendWsAndFind({ type: "ui-auth", token }, (m) => m.type === "ui-auth");
    assert.equal(auth.ok, true);
    await sendWsAndFind({ type: "browser-target-set", pane: "A", tabId: "popup-a" },
      (m) => m.type === "tab-granted" && m.pane === "A");
    const before = await browserCmd("tabs", "A");
    assert.ok(before.data.pinnedAll.length && before.data.granted.length, "종료 전 pin/grant 준비가 안 됐다");

    sendWs({ type: "browser-tab-gone", tabId: "popup-a", wc: 201 });
    const after = await browserCmd("tabs", "A");
    assert.ok(!after.data.tabs.some((tab) => tab.tabId === "popup-a"));
    assert.deepEqual([after.data.pinnedAll, after.data.granted], [[], []]);
    await waitFor(() => {
      const file = path.join(stateDir, "grants.json");
      return fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("popup-a");
    });
  });
});
