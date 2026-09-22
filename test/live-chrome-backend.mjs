import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLiveChromeBackend, LiveChromeError } = require("../native/electron/live-chrome-backend.cjs");
const turn = () => new Promise((resolve) => setImmediate(resolve));

class FakeRoot {
  constructor(log, { targetId = "owned-target", known = [], fail = [] } = {}) {
    this.log = log;
    this.targetId = targetId;
    this.known = new Set(known);
    this.fail = new Set(fail);
    this.listeners = new Map();
    this.latestSessionId = "";
    this.detached = false;
  }
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  off(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, value) { for (const fn of this.listeners.get(name) || []) fn(value); }
  emitNested(method, params) {
    this.emit("Target.receivedMessageFromTarget", {
      sessionId: this.latestSessionId,
      message: JSON.stringify({ method, params }),
    });
  }
  async send(method, params = {}) {
    this.log.push(["root.send", method, params]);
    if (method === "Target.createTarget") {
      this.known.add(this.targetId);
      return { targetId: this.targetId };
    }
    if (method === "Target.getTargetInfo") {
      if (!this.known.has(params.targetId)) return {};
      return { targetInfo: {
        targetId: params.targetId,
        type: "page",
        url: "about:blank",
        browserContextId: "ctx-1",
      } };
    }
    if (method === "Target.attachToTarget") {
      this.latestSessionId = `exact-${params.targetId}`;
      return { sessionId: this.latestSessionId };
    }
    if (method === "Target.sendMessageToTarget") {
      const message = JSON.parse(params.message);
      this.log.push(["target.send", message.method, message.params]);
      queueMicrotask(() => this.emit("Target.receivedMessageFromTarget", {
        sessionId: params.sessionId,
        message: JSON.stringify(this.fail.has(message.method)
          ? { id: message.id, error: { message: `${message.method} failed` } }
          : { id: message.id, result: {} }),
      }));
      return {};
    }
    if (method === "Target.closeTarget") {
      this.known.delete(params.targetId);
      const sessionId = `exact-${params.targetId}`;
      this.emit("Target.detachedFromTarget", { sessionId });
      return { success: true };
    }
    return {};
  }
  async detach() { this.detached = true; this.log.push(["root.detach"]); }
}

class FakeBrowser {
  constructor(log, root = new FakeRoot(log)) {
    this.log = log;
    this.root = root;
    this.listeners = new Map();
    this.disconnectCount = 0;
    this.closeCount = 0;
  }
  on(name, fn) { this.listeners.set(name, fn); }
  off(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  emit(name) { this.listeners.get(name)?.(); }
  target() {
    this.log.push(["browser.target"]);
    return { createCDPSession: async () => {
      this.log.push(["browser-target.createCDPSession"]);
      return this.root;
    } };
  }
  pages() { throw new Error("must not enumerate pages"); }
  targets() { throw new Error("must not enumerate targets"); }
  async disconnect() { this.disconnectCount++; this.log.push(["browser.disconnect"]); }
  async close() { this.closeCount++; throw new Error("must not close browser"); }
}

const nestedMethods = (log) => log.filter(([kind]) => kind === "target.send").map(([, method]) => method);

test("명시 connect만 수행하고 Puppeteer targetFilter는 browser target만 받는다", async () => {
  const calls = [];
  const backend = createLiveChromeBackend({
    connectFn: async (options) => { calls.push(options); throw new Error("Permission denied by user"); },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await backend.connect(), {
    ok: false,
    code: "permission-denied",
    message: "Chrome에서 원격 디버깅 연결을 허용해 주세요.",
  });
  assert.equal(calls[0].channel, "chrome");
  assert.equal(calls[0].defaultViewport, null);
  assert.equal(calls[0].networkEnabled, false);
  assert.equal(calls[0].issuesEnabled, false);
  assert.equal(calls[0].targetFilter({ type: () => "browser" }), true);
  for (const type of ["tab", "page", "service_worker", "other"]) {
    assert.equal(calls[0].targetFilter({ type: () => type, url: () => "about:blank" }), false);
  }
});

test("root Target.createTarget으로 만든 정확한 ID만 Page/Input tunnel로 제어한다", async () => {
  const log = [];
  const root = new FakeRoot(log, { known: ["foreign-blank"] });
  const browser = new FakeBrowser(log, root);
  let options;
  const backend = createLiveChromeBackend({ connectFn: async (value) => { options = value; return browser; } });
  assert.equal((await backend.connect()).ok, true);
  await assert.rejects(
    backend.openTab({ url: "https://name:secret@example.com/", owner: "tab-a" }),
    (error) => error instanceof LiveChromeError && error.code === "unsafe-url",
  );
  assert.equal(log.some((entry) => entry[1] === "Target.createTarget"), false);

  const opened = await backend.openTab({ url: "https://example.com/path", owner: "tab-a" });
  assert.equal(opened.ok, true);
  assert.equal(opened.target.kind, "owned-page");
  assert.equal("newPage" in browser, false, "browser.newPage가 없어도 동작해야 한다");
  assert.deepEqual(log.find((entry) => entry[1] === "Target.createTarget"),
    ["root.send", "Target.createTarget", { url: "about:blank" }]);
  assert.deepEqual(log.find((entry) => entry[1] === "Target.getTargetInfo"),
    ["root.send", "Target.getTargetInfo", { targetId: "owned-target" }]);
  assert.deepEqual(log.find((entry) => entry[1] === "Target.attachToTarget"),
    ["root.send", "Target.attachToTarget", { targetId: "owned-target", flatten: false }]);
  assert.equal(log.some((entry) => JSON.stringify(entry).includes("foreign-blank")), false);
  assert.equal(options.targetFilter({ type: () => "page", url: () => "about:blank" }), false,
    "탭 생성 중에도 외부 blank target을 받으면 안 된다");

  await backend.command(opened.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 });
  for (const method of ["Storage.getCookies", "Network.setCookie", "Browser.close", "Target.getTargets", "Runtime.evaluate"]) {
    await assert.rejects(backend.command(opened.id, method, {}),
      (error) => error instanceof LiveChromeError && error.code === "command-not-allowed");
  }
  const nested = nestedMethods(log);
  assert.deepEqual(nested.slice(0, 3), ["Page.enable", "Page.startScreencast", "Page.navigate"]);
  assert.ok(nested.every((method) => method.startsWith("Page.") || method.startsWith("Input.")));
  assert.equal(nested.some((method) => /^(Runtime|Network|Emulation)\./.test(method)), false);
  assert.equal(browser.closeCount, 0);
});

test("초기화 실패는 방금 만든 target만 닫고 root session을 회수한다", async () => {
  const log = [];
  const root = new FakeRoot(log, { targetId: "just-created", known: ["foreign-blank"], fail: ["Page.enable"] });
  const backend = createLiveChromeBackend({ connectFn: async () => new FakeBrowser(log, root) });
  await backend.connect();
  await assert.rejects(backend.openTab({ url: "https://example.com/", owner: "tab-a" }));
  assert.deepEqual(log.filter((entry) => entry[1] === "Target.closeTarget"), [
    ["root.send", "Target.closeTarget", { targetId: "just-created" }],
  ]);
  assert.equal(root.detached, true);
});

test("프레임 소비 뒤 ack하여 한 탭에 backpressure를 건다", async () => {
  const log = [];
  const root = new FakeRoot(log);
  let release;
  const consumed = new Promise((resolve) => { release = resolve; });
  const frames = [];
  const backend = createLiveChromeBackend({
    connectFn: async () => new FakeBrowser(log, root),
    onFrame: async (frame) => { frames.push(frame); await consumed; },
  });
  await backend.connect();
  const { id } = await backend.openTab({ url: "https://example.com/", owner: "tab-a" });
  log.length = 0;
  root.emitNested("Page.screencastFrame", { data: "ZmFrZQ==", sessionId: 41, metadata: { timestamp: 1 } });
  await turn();
  assert.equal(frames[0].id, id);
  assert.equal(nestedMethods(log).includes("Page.screencastFrameAck"), false);
  release();
  await turn();
  assert.deepEqual(log.find((entry) => entry[1] === "Page.screencastFrameAck"),
    ["target.send", "Page.screencastFrameAck", { sessionId: 41 }]);
});

test("native handoff는 stop→front→root detach→browser disconnect 순서를 지킨다", async () => {
  const log = [];
  const browser = new FakeBrowser(log);
  const backend = createLiveChromeBackend({ connectFn: async () => browser });
  await backend.connect();
  const opened = await backend.openTab({ url: "https://accounts.google.com/", owner: "tab-google" });
  log.length = 0;
  const native = backend.beginNativeInteraction(opened.id);
  await assert.rejects(backend.command(opened.id, "Input.insertText", { text: "blocked" }),
    (error) => error instanceof LiveChromeError && error.code === "native-interaction");
  assert.equal((await native).mode, "native");
  const relevant = log.filter((entry) =>
    entry[0] === "root.detach" || entry[0] === "browser.disconnect" ||
    (entry[0] === "target.send" && ["Page.stopScreencast", "Page.bringToFront"].includes(entry[1])))
    .map((entry) => entry[1] || entry[0]);
  assert.deepEqual(relevant, ["Page.stopScreencast", "Page.bringToFront", "root.detach", "browser.disconnect"]);
  assert.equal(log.some((entry) => entry[1] === "Target.closeTarget"), false);
  assert.equal(browser.closeCount, 0);
});

test("native front 실패도 Iris 연결을 반드시 끊는다", async () => {
  const log = [];
  const browser = new FakeBrowser(log, new FakeRoot(log, { fail: ["Page.bringToFront"] }));
  const backend = createLiveChromeBackend({ connectFn: async () => browser });
  await backend.connect();
  const opened = await backend.openTab({ url: "https://example.com/", owner: "tab-a" });
  await assert.rejects(backend.beginNativeInteraction(opened.id),
    (error) => error instanceof LiveChromeError && error.code === "target-unavailable");
  assert.equal(browser.disconnectCount, 1);
});

test("disconnect는 target을 닫지 않고, 명시 reconnect만 정확한 ID를 복원한다", async () => {
  const log = [];
  const first = new FakeBrowser(log, new FakeRoot(log, { targetId: "retained" }));
  const second = new FakeBrowser(log, new FakeRoot(log, { known: ["retained"] }));
  const browsers = [first, second];
  let connects = 0;
  const backend = createLiveChromeBackend({ connectFn: async () => browsers[connects++], idFn: () => "logical" });
  await backend.connect();
  const opened = await backend.openTab({ url: "https://example.com/", owner: "tab-a" });
  await backend.disconnect();
  assert.equal(log.some((entry) => entry[1] === "Target.closeTarget"), false);
  log.length = 0;
  assert.equal((await backend.connect()).restored, 1);
  await backend.command(opened.id, "Page.reload", {});
  assert.deepEqual(log.find((entry) => entry[1] === "Target.getTargetInfo"),
    ["root.send", "Target.getTargetInfo", { targetId: "retained" }]);
  assert.equal(log.some((entry) => entry[1] === "Target.createTarget"), false);
  assert.deepEqual(log.find((entry) => entry[1] === "Page.reload"),
    ["target.send", "Page.reload", { ignoreCache: false }]);
  await backend.disconnect();
});

test("예기치 않은 disconnect 뒤 자동 reconnect하지 않는다", async () => {
  const log = [];
  const browser = new FakeBrowser(log);
  let connects = 0;
  const backend = createLiveChromeBackend({ connectFn: async () => { connects++; return browser; } });
  await backend.connect();
  await backend.openTab({ url: "https://example.com/", owner: "tab-a" });
  log.length = 0;
  browser.emit("disconnected");
  await turn();
  assert.equal(connects, 1);
  assert.equal(log.some((entry) => entry[1] === "Target.closeTarget"), false);
});

test("closeTab은 저장한 소유 target ID만 닫는다", async () => {
  const log = [];
  const browser = new FakeBrowser(log);
  const backend = createLiveChromeBackend({ connectFn: async () => browser });
  await backend.connect();
  const opened = await backend.openTab({ url: "https://example.com/", owner: "tab-a" });
  await assert.rejects(backend.closeTab("foreign"),
    (error) => error instanceof LiveChromeError && error.code === "tab-not-owned");
  log.length = 0;
  assert.equal((await backend.closeTab(opened.id)).ok, true);
  assert.deepEqual(log.find((entry) => entry[1] === "Target.closeTarget"),
    ["root.send", "Target.closeTarget", { targetId: "owned-target" }]);
  assert.equal(browser.root.detached, true, "target detach event가 먼저 와도 root session을 회수해야 한다");
  assert.equal(browser.closeCount, 0);
});

test("동의 대기 중 disconnect는 늦게 열린 연결을 회수한다", async () => {
  const log = [];
  const browser = new FakeBrowser(log);
  let finish;
  const pending = new Promise((resolve) => { finish = () => resolve(browser); });
  const backend = createLiveChromeBackend({ connectFn: async () => pending });
  const connecting = backend.connect();
  await turn();
  const disconnecting = backend.disconnect();
  finish();
  assert.equal((await connecting).code, "connection-cancelled");
  assert.deepEqual(await disconnecting, { ok: true, state: "disconnected" });
  assert.equal(browser.disconnectCount, 1);
});

test("browser target API가 없는 connector 결과도 회수한다", async () => {
  const log = [];
  const incompatible = { async disconnect() { log.push("disconnect"); } };
  const backend = createLiveChromeBackend({ connectFn: async () => incompatible });
  assert.equal((await backend.connect()).code, "connector-incompatible");
  assert.deepEqual(log, ["disconnect"]);
});
