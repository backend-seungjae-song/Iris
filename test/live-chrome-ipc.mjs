import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { initLiveChromeIpc, SETTINGS_URL } = require("../native/electron/live-chrome-ipc.cjs");

class FakeSender extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sent = [];
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.sent.push([channel, payload]); }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}

function fixture(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  let callbacks;
  const backend = {
    async connect() { calls.push(["connect"]); return { ok: true, state: "connected", restored: 0 }; },
    async openTab(payload) { calls.push(["openTab", payload]); return { ok: true, id: "owned-1", owner: payload.owner, target: { kind: "owned-page", id: "owned-1" } }; },
    async command(id, command, args) { calls.push(["command", id, command, args]); return { ok: true }; },
    async closeTab(id) { calls.push(["closeTab", id]); return { ok: true, id }; },
    async beginNativeInteraction(id) { calls.push(["native", id]); return { ok: true, mode: "native", id, target: { kind: "owned-page", id } }; },
    async disconnect() { calls.push(["disconnect"]); return { ok: true, state: "disconnected" }; },
    ...overrides.backend,
  };
  const ctx = {
    app: { once() {} },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    shell: { async openExternal(url) { calls.push(["openExternal", url]); } },
    isTrustedSender: () => true,
    ...overrides.ctx,
  };
  const manager = initLiveChromeIpc(ctx, {
    createBackend(options) { callbacks = options; return backend; },
    openNativeFn: overrides.openNativeFn,
  });
  const invoke = (name, sender, payload) => handlers.get(name)({ sender }, payload);
  return { handlers, calls, backend, manager, invoke, callbacks: () => callbacks };
}

test("IPC는 초기화만으로 연결하지 않고 renderer owner를 sender.id로 고정한다", async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.deepEqual([...f.handlers.keys()].sort(), [
    "ac-live-chrome-close",
    "ac-live-chrome-command",
    "ac-live-chrome-connect",
    "ac-live-chrome-disconnect",
    "ac-live-chrome-native",
    "ac-live-chrome-open",
    "ac-live-chrome-open-native",
    "ac-live-chrome-open-settings",
  ]);

  const sender = new FakeSender(17);
  assert.equal((await f.invoke("ac-live-chrome-connect", sender)).ok, true);
  const opened = await f.invoke("ac-live-chrome-open", sender, {
    url: "https://example.com/",
    owner: "renderer-controlled-owner",
    screencast: { maxWidth: 900, maxHeight: 700 },
  });
  assert.equal(opened.id, "owned-1");
  assert.deepEqual(f.calls.find(([name]) => name === "openTab"), ["openTab", {
    url: "https://example.com/",
    owner: "renderer:17",
    screencast: { maxWidth: 900, maxHeight: 700 },
  }]);
});

test("다른 trusted renderer도 소유하지 않은 논리 탭은 명령·종료할 수 없다", async () => {
  const f = fixture();
  const owner = new FakeSender(1);
  const foreign = new FakeSender(2);
  await f.invoke("ac-live-chrome-connect", owner);
  await f.invoke("ac-live-chrome-open", owner, { url: "https://example.com/" });
  await f.invoke("ac-live-chrome-connect", foreign);

  for (const [channel, payload] of [
    ["ac-live-chrome-command", { id: "owned-1", command: "Page.reload", args: {} }],
    ["ac-live-chrome-close", { id: "owned-1" }],
    ["ac-live-chrome-native", { id: "owned-1" }],
  ]) {
    const result = await f.invoke(channel, foreign, payload);
    assert.equal(result.ok, false);
    assert.equal(result.code, "tab-not-owned");
  }
  assert.equal(f.calls.some(([name]) => ["command", "closeTab", "native"].includes(name)), false);
});

test("back/forward는 소유 탭의 Page history 안에서만 이동한다", async () => {
  const f = fixture({
    backend: {
      async command(id, command, args) {
        f.calls.push(["command", id, command, args]);
        if (command === "Page.getNavigationHistory") {
          return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
        }
        return {};
      },
    },
  });
  const sender = new FakeSender(6);
  await f.invoke("ac-live-chrome-connect", sender);
  await f.invoke("ac-live-chrome-open", sender, { url: "https://example.com/" });
  const result = await f.invoke("ac-live-chrome-command", sender, { id: "owned-1", command: "Navigation.back" });
  assert.deepEqual(result, { ok: true, navigated: true });
  assert.deepEqual(f.calls.filter(([name]) => name === "command"), [
    ["command", "owned-1", "Page.getNavigationHistory", {}],
    ["command", "owned-1", "Page.navigateToHistoryEntry", { entryId: 10 }],
  ]);
});

test("frame과 탭 상태는 해당 탭 owner에게만 전달한다", async () => {
  const f = fixture();
  const owner = new FakeSender(7);
  const foreign = new FakeSender(8);
  await f.invoke("ac-live-chrome-connect", owner);
  await f.invoke("ac-live-chrome-connect", foreign);
  await f.invoke("ac-live-chrome-open", owner, { url: "https://example.com/" });
  owner.sent.length = 0;
  foreign.sent.length = 0;

  await f.callbacks().onFrame({ id: "owned-1", data: "ZnJhbWU=", metadata: { deviceWidth: 1200 } });
  f.callbacks().onState({ state: "tab-unavailable", id: "owned-1" });
  assert.deepEqual(owner.sent, [
    ["live-chrome-frame", { id: "owned-1", data: "ZnJhbWU=", metadata: { deviceWidth: 1200 } }],
    ["live-chrome-state", { state: "tab-unavailable", id: "owned-1" }],
  ]);
  assert.deepEqual(foreign.sent, []);
});

test("예상 밖 오류의 endpoint와 프로필 경로를 renderer에 노출하지 않는다", async () => {
  const f = fixture({
    backend: { async connect() { throw new Error("ws://127.0.0.1:9222 /tmp/iris-private-fixture/Profile 1"); } },
  });
  const result = await f.invoke("ac-live-chrome-connect", new FakeSender(3));
  assert.deepEqual(result, {
    ok: false,
    code: "connection-failed",
    message: "Chrome 연결을 시작하지 못했습니다.",
  });
  assert.equal(JSON.stringify(result).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(result).includes("/tmp/iris-private-fixture"), false);
});

test("실제 Chrome 열기는 검증한 URL만 전달하고 CDP 연결을 시작하지 않는다", async () => {
  const opened = [];
  const f = fixture({ openNativeFn: async (url) => { f.calls.push(["openNative", url]); opened.push(url); } });
  const sender = new FakeSender(12);
  assert.deepEqual(await f.invoke("ac-live-chrome-open-native", sender, { url: "https://accounts.google.com/ServiceLogin" }),
    { ok: true, requested: true });
  assert.deepEqual(opened, ["https://accounts.google.com/ServiceLogin"]);
  assert.equal(f.calls.some(([name]) => name === "connect"), false);
  assert.deepEqual(f.calls.slice(-2), [
    ["disconnect"],
    ["openNative", "https://accounts.google.com/ServiceLogin"],
  ]);

  const rejected = await f.invoke("ac-live-chrome-open-native", sender, { url: "https://name:secret@example.com/" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "unsafe-url");
  assert.equal(opened.length, 1);
});

test("Chrome 설정 handler는 정확한 주소와 항상 쓸 수 있는 복사 안내를 돌려준다", async () => {
  const f = fixture();
  const result = await f.invoke("ac-live-chrome-open-settings", new FakeSender(4));
  assert.equal(result.url, SETTINGS_URL);
  assert.equal(result.attempted, true);
  assert.match(result.message, /주소창/);
  assert.deepEqual(f.calls.find(([name]) => name === "openExternal"), ["openExternal", SETTINGS_URL]);

  const failed = fixture({ ctx: { shell: { async openExternal() { throw new Error("no protocol"); } } } });
  const fallback = await failed.invoke("ac-live-chrome-open-settings", new FakeSender(5));
  assert.equal(fallback.ok, false);
  assert.equal(fallback.url, SETTINGS_URL);
  assert.match(fallback.message, /주소창/);
});

test("마지막 renderer가 사라지면 제어 연결만 끊는다", async () => {
  const f = fixture();
  const sender = new FakeSender(10);
  await f.invoke("ac-live-chrome-connect", sender);
  sender.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.at(-1), ["disconnect"]);
});
