import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createBrowserNavigationHistory,
  normalizeNavigationHistory,
} = require("../native/electron/browser-navigation-history.cjs");

const P0 = "cGFnZS0w";
const P1 = "cGFnZS0x";
const P2 = "cGFnZS0y";

test("normalization preserves active index and forward entries while filtering non-http pages", () => {
  const history = normalizeNavigationHistory({
    entries: [
      { url: "chrome://newtab/", title: "internal" },
      { url: "https://one.test/a", title: "one", pageState: P0 },
      { url: "https://two.test/b", title: "two", pageState: P1 },
      { url: "https://three.test/c", title: "three", pageState: P2 },
    ],
    index: 2,
  });
  assert.deepEqual(history, {
    entries: [
      { url: "https://one.test/a", title: "one", pageState: P0 },
      { url: "https://two.test/b", title: "two", pageState: P1 },
      { url: "https://three.test/c", title: "three", pageState: P2 },
    ],
    index: 1,
  });
  assert.equal(normalizeNavigationHistory({
    entries: [{ url: "https://user:pass@example.test/", pageState: P0 }], index: 0,
  }), null);
  assert.equal(normalizeNavigationHistory({
    entries: [{ url: "https://example.test/", pageState: "not base64" }], index: 0,
  }), null);
});

test("trusted IPC exports and restores the exact back/forward stack", async () => {
  const handlers = new Map();
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const restored = [];
  const history = {
    entries: [
      { url: "https://one.test/", title: "one", pageState: P0 },
      { url: "https://two.test/", title: "two", pageState: P1 },
      { url: "https://three.test/", title: "three", pageState: P2 },
    ],
    index: 1,
  };
  const target = {
    isDestroyed: () => false,
    navigationHistory: {
      getAllEntries: () => history.entries,
      getActiveIndex: () => history.index,
      length: () => 1,
      restore: async (value) => { restored.push(value); },
    },
  };
  createBrowserNavigationHistory({
    app,
    ipcMain,
    webContentsFromId: (id) => id === 41 ? target : null,
    isTrustedSender: (event) => event.sender === "trusted",
    isAllowedTarget: (event, candidate) => event.sender === "trusted" && candidate === target,
  });

  const event = { sender: "trusted" };
  assert.deepEqual(await handlers.get("ac-browser-history-export")(event, 41), { ok: true, history });
  assert.deepEqual(await handlers.get("ac-browser-history-restore")(event, { wcId: 41, history }), { ok: true });
  assert.deepEqual(restored, [history]);

  assert.equal((await handlers.get("ac-browser-history-export")({ sender: "other" }, 41)).ok, false);
  target.navigationHistory.length = () => 2;
  assert.equal((await handlers.get("ac-browser-history-restore")(event, { wcId: 41, history })).ok, false);
  assert.equal(restored.length, 1);
});

test("staged history clears the first src and restores at did-attach before any page loads", async () => {
  const handlers = new Map();
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const host = new EventEmitter();
  host.getType = () => "window";
  const entries = [
    { url: "https://one.test/", title: "one", pageState: P0 },
    { url: "https://two.test/", title: "two", pageState: P1 },
    { url: "https://three.test/", title: "three", pageState: P2 },
  ];
  let nativeEntries = [];
  let nativeIndex = -1;
  const restored = [];
  const guest = {
    id: 52,
    getType: () => "webview",
    hostWebContents: host,
    navigationHistory: {
      getAllEntries: () => nativeEntries,
      getActiveIndex: () => nativeIndex,
      restore: async (history) => {
        restored.push(history);
        nativeEntries = structuredClone(history.entries);
        nativeIndex = history.index;
      },
    },
  };
  createBrowserNavigationHistory({
    app,
    ipcMain,
    webContentsFromId: () => guest,
    isTrustedSender: (event) => event.sender === host,
    isAllowedTarget: (event, target) => event.sender === host && target === guest,
    randomToken: () => "stage_token",
  });

  app.emit("web-contents-created", {}, host);
  const stageEvent = { sender: host, returnValue: null };
  ipcMain.emit("ac-browser-history-stage", stageEvent, { entries, index: 1 });
  assert.deepEqual(stageEvent.returnValue, {
    ok: true,
    token: "stage_token",
    src: "about:blank#iris-history:stage_token",
  });

  const params = { src: stageEvent.returnValue.src };
  host.emit("will-attach-webview", {}, {}, params);
  assert.equal(params.src, "");
  app.emit("web-contents-created", {}, guest);
  const finished = handlers.get("ac-browser-history-finish")({ sender: host }, "stage_token");
  host.emit("did-attach-webview", {}, guest);
  assert.deepEqual(await finished, { ok: true });
  assert.deepEqual(restored, [{ entries, index: 1 }]);
});

test("did-attach accepts an aborted restore only when the exact native stack is present", async () => {
  const handlers = new Map();
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const host = new EventEmitter();
  host.getType = () => "window";
  const history = { entries: [
    { url: "https://one.test/", title: "one", pageState: P0 },
    { url: "https://two.test/", title: "two", pageState: P1 },
  ], index: 1 };
  let native = { entries: [], index: -1 };
  const guest = {
    getType: () => "webview",
    hostWebContents: host,
    navigationHistory: {
      getAllEntries: () => native.entries,
      getActiveIndex: () => native.index,
      restore: async (value) => {
        native = structuredClone(value);
        throw new Error("ERR_ABORTED (-3)");
      },
    },
  };
  createBrowserNavigationHistory({
    app, ipcMain, webContentsFromId: () => guest,
    isTrustedSender: (event) => event.sender === host,
    isAllowedTarget: () => true,
    randomToken: () => "abort_token",
  });
  app.emit("web-contents-created", {}, host);
  const event = { sender: host, returnValue: null };
  ipcMain.emit("ac-browser-history-stage", event, history);
  const params = { src: event.returnValue.src };
  host.emit("will-attach-webview", {}, {}, params);
  app.emit("web-contents-created", {}, guest);
  host.emit("did-attach-webview", {}, guest);
  assert.deepEqual(await handlers.get("ac-browser-history-finish")({ sender: host }, event.returnValue.token), { ok: true });
});

test("restore failure loads the saved active URL so the blank guest cannot stall", async () => {
  const handlers = new Map();
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const host = new EventEmitter();
  host.getType = () => "window";
  const history = { entries: [
    { url: "https://one.test/", title: "one", pageState: P0 },
    { url: "https://two.test/", title: "two", pageState: P1 },
  ], index: 1 };
  const loaded = [];
  const guest = {
    getType: () => "webview",
    hostWebContents: host,
    loadURL: async (url) => { loaded.push(url); },
    navigationHistory: {
      getAllEntries: () => [],
      getActiveIndex: () => -1,
      restore: async () => { throw new Error("restore failed"); },
    },
  };
  createBrowserNavigationHistory({
    app, ipcMain, webContentsFromId: () => guest,
    isTrustedSender: (event) => event.sender === host,
    isAllowedTarget: () => true,
    randomToken: () => "failure_token",
  });
  app.emit("web-contents-created", {}, host);
  const event = { sender: host, returnValue: null };
  ipcMain.emit("ac-browser-history-stage", event, history);
  const params = { src: event.returnValue.src };
  host.emit("will-attach-webview", {}, {}, params);
  app.emit("web-contents-created", {}, guest);
  host.emit("did-attach-webview", {}, guest);
  assert.deepEqual(await handlers.get("ac-browser-history-finish")({ sender: host }, event.returnValue.token), {
    ok: false,
    fallbackLoaded: true,
    error: "탐색 이력을 복원하지 못했습니다.",
  });
  assert.deepEqual(loaded, ["https://two.test/"]);
});

test("foreign and expired history markers become one plain blank navigation", async () => {
  const handlers = new Map();
  const timers = [];
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const owner = new EventEmitter();
  owner.getType = () => "window";
  const foreign = new EventEmitter();
  foreign.getType = () => "window";
  createBrowserNavigationHistory({
    app, ipcMain, webContentsFromId: () => null,
    isTrustedSender: (event) => event.sender === owner,
    isAllowedTarget: () => false,
    randomToken: () => "short_lived_token",
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimer: () => {},
  });
  app.emit("web-contents-created", {}, owner);
  app.emit("web-contents-created", {}, foreign);
  const event = { sender: owner, returnValue: null };
  ipcMain.emit("ac-browser-history-stage", event, {
    entries: [{ url: "https://one.test/", pageState: P0 }], index: 0,
  });
  const foreignParams = { src: event.returnValue.src };
  foreign.emit("will-attach-webview", {}, {}, foreignParams);
  assert.equal(foreignParams.src, "about:blank");
  timers[0]();
  const expiredParams = { src: event.returnValue.src };
  owner.emit("will-attach-webview", {}, {}, expiredParams);
  assert.equal(expiredParams.src, "about:blank");
  assert.equal((await handlers.get("ac-browser-history-finish")({ sender: owner }, event.returnValue.token)).ok, false);
});

test("a restore that never settles is stopped and falls back after the bounded timer", async () => {
  const handlers = new Map();
  const timers = [];
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const host = new EventEmitter();
  host.getType = () => "window";
  let stopped = 0;
  const loaded = [];
  const guest = {
    getType: () => "webview",
    hostWebContents: host,
    stop: () => { stopped++; },
    loadURL: (url) => { loaded.push(url); return Promise.resolve(); },
    navigationHistory: { getAllEntries: () => [], getActiveIndex: () => -1 },
  };
  createBrowserNavigationHistory({
    app, ipcMain, webContentsFromId: () => guest,
    isTrustedSender: (event) => event.sender === host,
    isAllowedTarget: () => true,
    randomToken: () => "hung_token",
    restoreNavigationHistory: () => new Promise(() => {}),
    setTimer: (fn) => {
      const timer = { fn, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  app.emit("web-contents-created", {}, host);
  const event = { sender: host, returnValue: null };
  ipcMain.emit("ac-browser-history-stage", event, {
    entries: [{ url: "https://fallback.test/", pageState: P0 }], index: 0,
  });
  const params = { src: event.returnValue.src };
  host.emit("will-attach-webview", {}, {}, params);
  app.emit("web-contents-created", {}, guest);
  host.emit("did-attach-webview", {}, guest);
  const finished = handlers.get("ac-browser-history-finish")({ sender: host }, event.returnValue.token);
  await Promise.resolve();
  await Promise.resolve();
  const restoreTimer = timers.find((timer, index) => index > 0 && !timer.cleared);
  assert.ok(restoreTimer);
  restoreTimer.fn();
  const result = await finished;
  assert.equal(result.ok, false);
  assert.equal(result.fallbackLoaded, true);
  assert.equal(stopped, 1);
  assert.deepEqual(loaded, ["https://fallback.test/"]);
});

test("server trust boundary revalidates history without writing state", async () => {
  const isolatedState = await mkdtemp(path.join(os.tmpdir(), "iris-history-test-"));
  const prior = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = isolatedState;
  try {
    const { normalizeClosedTabHistory } = await import(`../server/browser-runtime.js?history-test=${Date.now()}`);
    const history = normalizeClosedTabHistory({
      entries: [
        { url: "file:///tmp/private", title: "private", pageState: P0 },
        { url: "https://before.test/", title: "before", pageState: P1 },
        { url: "https://active.test/", title: "active", pageState: P2 },
        { url: "https://forward.test/", title: "forward", pageState: P0 },
      ],
      index: 2,
    });
    assert.equal(history.index, 1);
    assert.deepEqual(history.entries.map((entry) => entry.url), [
      "https://before.test/", "https://active.test/", "https://forward.test/",
    ]);
    assert.deepEqual(await readdir(isolatedState), []);
  } finally {
    if (prior === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = prior;
    await rm(isolatedState, { recursive: true, force: true });
  }
});
