import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import os from "node:os";

const require = createRequire(import.meta.url);
const { createElectronRelay } = require("../native/electron/relay/index.cjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "iris-relay-f9a-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const target = { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 };

function baseDeps(guest, overrides = {}) {
  return {
    webContents: { fromId: id => Number(id) === guest.id ? guest : null },
    targetState: {
      generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }),
      ownsChildSession: () => false,
    },
    currentUrl: () => "https://example.test/login",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    rememberSecret() {},
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    ...overrides,
  };
}

function command(relay, generation, callId, name, args = {}, commandTarget = target) {
  return relay.execute({
    workerGeneration: generation,
    commandId: `${generation}/command-${callId}`,
    callId,
    command: name,
    target: commandTarget,
    args,
  });
}

async function waitFor(check, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("조건을 기다리다 시간이 초과됐습니다.");
}

test("takeover 정리는 새 세대가 같은 자원에 설정한 상태를 되돌리지 않는다", async () => {
  fs.mkdirSync(scratch, { recursive: true });
  const downloadDir = path.join(scratch, "download");
  let finishEarlierRelease;
  let earlierReleaseStarted = false;
  const state = {
    capture: false,
    captureCalls: [],
    dialog: null,
    dialogClears: 0,
    qaMode: false,
    qaModeCalls: [],
    viewport: null,
    viewportClears: 0,
    hiddenViewport: false,
    hiddenViewportReleases: 0,
    qaViewportClears: 0,
    qaViewportReleases: 0,
    download: { dir: null, once: false, last: null, pending: null },
    downloadDisarms: 0,
  };
  const guest = {
    id: 7,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      sendCommand: async (method, params) => {
        if (method === "Emulation.setDeviceMetricsOverride") {
          state.viewport = { width: params.width, height: params.height, dpr: params.deviceScaleFactor };
        }
        if (method === "Emulation.clearDeviceMetricsOverride") {
          state.viewport = null;
          state.viewportClears += 1;
        }
        return {};
      },
    },
  };
  const relay = createElectronRelay(baseDeps(guest, {
    resourceReleaseTimeoutMs: 1000,
    ai: {
      enter: () => "old-ticket",
      leave: () => {
        earlierReleaseStarted = true;
        return new Promise(resolve => { finishEarlierRelease = resolve; });
      },
    },
    captureHold: async (_wcId, on) => {
      state.captureCalls.push(on);
      state.capture = on;
      return true;
    },
    dialogPlan: { set: (_wcId, plan) => { state.dialog = plan; } },
    clearDialogPlan: () => {
      state.dialog = null;
      state.dialogClears += 1;
    },
    qaMode: async (_wc, enabled) => {
      state.qaModeCalls.push(enabled);
      state.qaMode = enabled;
      return { enabled };
    },
    viewport: {
      explicit: () => null,
      current: () => state.viewport,
      revision: () => 1,
      apply: async (_wc, value) => { state.viewport = value; return value; },
    },
    hiddenViewport: {
      ensureReady: async () => { state.hiddenViewport = true; return { ready: true }; },
      release: async () => {
        state.hiddenViewport = false;
        state.hiddenViewportReleases += 1;
      },
    },
    qaViewport: async (_wc, value) => {
      if (value.clear) {
        state.viewport = null;
        state.qaViewportClears += 1;
        return { clear: true };
      }
      state.viewport = { width: value.width, height: value.height, dpr: value.dpr };
      return state.viewport;
    },
    qaViewportRelease: async () => { state.qaViewportReleases += 1; },
    downloadState: {
      snapshot: () => ({ ...state.download }),
      arm: (dir, once) => { state.download.dir = dir; state.download.once = once; },
      disarm: () => {
        state.download.dir = null;
        state.download.once = false;
        state.downloadDisarms += 1;
      },
    },
  }));

  await relay.acceptGeneration("boot:1");
  await command(relay, "boot:1", 1, "ai.enter");
  await command(relay, "boot:1", 2, "hold.capture", { on: true });
  await command(relay, "boot:1", 3, "dialog.plan", { plan: { mode: "ok" } });
  await command(relay, "boot:1", 4, "qa.mode", { enabled: true });
  await command(relay, "boot:1", 5, "viewport.ensureReady", { command: "click" });
  await command(relay, "boot:1", 6, "viewport.qa", { width: 390, height: 844, dpr: 2 });
  await command(relay, "boot:1", 7, "viewport.setTemporary", { width: 800, height: 600, dpr: 1 });
  await command(relay, "boot:1", 8, "download.configure", { dir: downloadDir }, null);

  await relay.acceptGeneration("boot:2", null, { takeover: true });
  await waitFor(() => earlierReleaseStarted);

  await command(relay, "boot:2", 9, "hold.capture", { on: true });
  await command(relay, "boot:2", 10, "dialog.plan", { plan: { mode: "cancel" } });
  await command(relay, "boot:2", 11, "qa.mode", { enabled: true });
  await command(relay, "boot:2", 12, "viewport.ensureReady", { command: "click" });
  await command(relay, "boot:2", 13, "viewport.qa", { width: 430, height: 932, dpr: 3 });
  await command(relay, "boot:2", 14, "viewport.setTemporary", { width: 1024, height: 768, dpr: 2 });
  await command(relay, "boot:2", 15, "download.configure", { dir: downloadDir, once: true }, null);
  finishEarlierRelease();
  await waitFor(() => state.dialog?.mode === "cancel" && state.viewport?.width === 1024);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.capture, true);
  assert.deepEqual(state.captureCalls, [true]);
  assert.deepEqual(state.dialog, { mode: "cancel" });
  assert.equal(state.dialogClears, 0);
  assert.equal(state.qaMode, true);
  assert.deepEqual(state.qaModeCalls, [true, true]);
  assert.deepEqual(state.viewport, { width: 1024, height: 768, dpr: 2 });
  assert.equal(state.viewportClears, 0);
  assert.equal(state.hiddenViewport, true);
  assert.equal(state.hiddenViewportReleases, 0);
  assert.equal(state.qaViewportClears, 0);
  assert.equal(state.qaViewportReleases, 0);
  assert.equal(state.download.dir, downloadDir);
  assert.equal(state.download.once, true);
  assert.equal(state.downloadDisarms, 0);
});

test("login.input의 1회 승인은 계정 조회와 실제 입력에 함께 적용된다", async () => {
  const providerCalls = [];
  const inserted = [];
  const guest = {
    id: 7,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
    getURL: () => "https://example.test/login",
    executeJavaScript: async () => ({ ok: true, tag: "INPUT", type: "text", autocomplete: "username" }),
    sendInputEvent() {},
    insertText: async value => { inserted.push(value); },
  };
  const relay = createElectronRelay(baseDeps(guest, {
    loginProvider: async (_wc, options) => {
      providerCalls.push(options);
      return {
        origin: "https://example.test",
        accounts: [{ id: "saved-account", username: "saved-user", allowed: false }],
      };
    },
  }));
  await relay.acceptGeneration("boot:1");

  const approved = await command(relay, "boot:1", 1, "login.input", {
    accountId: "saved-account",
    origin: "https://example.test",
    field: "username",
    x: 20,
    y: 30,
    approved: true,
  });

  assert.deepEqual(approved, {
    ok: true,
    accountId: "saved-account",
    origin: "https://example.test",
    field: "username",
  });
  assert.deepEqual(providerCalls, [{ qaAccounts: true, qaApproved: true }]);
  assert.deepEqual(inserted, ["saved-user"]);

  await assert.rejects(() => command(relay, "boot:1", 2, "login.input", {
    accountId: "saved-account",
    origin: "https://example.test",
    field: "username",
    x: 20,
    y: 30,
  }), error => error.code === "NOT_FOUND");
  assert.deepEqual(inserted, ["saved-user"]);
});

test("leftovers 재시도는 새 세대의 같은 dialog plan을 해제하지 않는다", async () => {
  let clearFails = true;
  let clearAttempts = 0;
  let plan = null;
  const guest = {
    id: 7,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
  };
  const relay = createElectronRelay(baseDeps(guest, {
    dialogPlan: { set: (_wcId, value) => { plan = value; } },
    clearDialogPlan: () => {
      clearAttempts += 1;
      if (clearFails) throw new Error("fixture release failure");
      plan = null;
    },
  }));

  await relay.acceptGeneration("boot:1");
  await command(relay, "boot:1", 1, "dialog.plan", { plan: { mode: "ok" } });
  await relay.retireGeneration("boot:1", { force: true });
  await waitFor(() => clearAttempts >= 1);
  await relay.acceptGeneration("boot:2");
  await command(relay, "boot:2", 2, "dialog.plan", { plan: { mode: "cancel" } });

  clearFails = false;
  await relay.acceptGeneration("boot:2");
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(plan, { mode: "cancel" });
  assert.equal(clearAttempts >= 1, true);
});

test("capture hold 인계는 중첩 횟수를 새 세대가 이어받고 중복 획득하지 않는다", async () => {
  let finishEarlierRelease;
  let earlierReleaseStarted = false;
  let count = 0;
  const calls = [];
  const guest = {
    id: 7,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
  };
  const relay = createElectronRelay(baseDeps(guest, {
    ai: {
      enter: () => "old-ticket",
      leave: () => {
        earlierReleaseStarted = true;
        return new Promise(resolve => { finishEarlierRelease = resolve; });
      },
    },
    captureHold: async (_wcId, on) => {
      calls.push(on);
      count += on ? 1 : -1;
      return true;
    },
  }));

  await relay.acceptGeneration("boot:1");
  await command(relay, "boot:1", 1, "ai.enter");
  await command(relay, "boot:1", 2, "hold.capture", { on: true });
  await command(relay, "boot:1", 3, "hold.capture", { on: true });
  await relay.acceptGeneration("boot:2", null, { takeover: true });
  await waitFor(() => earlierReleaseStarted);
  await command(relay, "boot:2", 4, "hold.capture", { on: true });
  finishEarlierRelease();
  await new Promise(resolve => setImmediate(resolve));

  await relay.retireGeneration("boot:2");

  assert.deepEqual(calls, [true, true, false, false]);
  assert.equal(count, 0);
});

test("download 정리는 이전 세대 설정과 다른 앱 전체 설정을 해제하지 않는다", async () => {
  fs.mkdirSync(scratch, { recursive: true });
  const firstDir = path.join(scratch, "download-first");
  const nextDir = path.join(scratch, "download-next");
  const download = { dir: null, once: false, last: null, pending: null };
  let disarms = 0;
  const guest = { id: 7, hostWebContents: {}, getType: () => "webview", isDestroyed: () => false };
  const relay = createElectronRelay(baseDeps(guest, {
    downloadState: {
      snapshot: () => ({ ...download }),
      arm: (dir, once) => { download.dir = dir; download.once = once; },
      disarm: () => { download.dir = null; download.once = false; disarms += 1; },
    },
  }));

  await relay.acceptGeneration("boot:1");
  await command(relay, "boot:1", 1, "download.configure", { dir: firstDir }, null);
  download.dir = nextDir;
  download.once = true;

  await relay.retireGeneration("boot:1");

  assert.deepEqual(download, { dir: nextDir, once: true, last: null, pending: null });
  assert.equal(disarms, 0);
});
