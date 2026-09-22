import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { readHiddenSync } = require("../server/feature-state-read.cjs");
const { bootNativeCapabilities } = require("../native/electron/capability-host.cjs");
const { NATIVE_CAPABILITIES } = require("../native/electron/capabilities.cjs");

function bootActualNative(hiddenFile, t) {
  const base = process.env.IRIS_STATE_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(path.join(base, "feature-native-"));
  const stateFile = path.join(home, "features.json");
  if (hiddenFile !== null) writeFileSync(stateFile, hiddenFile);
  t.after(() => {
    if (hiddenFile !== null) unlinkSync(stateFile);
    rmdirSync(home);
  });

  // main의 실제 items/isOn 배선을 실행해야 host에 항상 true를 넘기는 회귀도 잡힌다.
  const main = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  const prefix = main.match(/bootNativeCapabilities\(\{\s*items:[\s\S]*?\n\s*ctx:/)?.[0];
  assert.ok(prefix, "main의 native 부팅 호출을 찾을 수 있어야 한다");
  const channels = new Map();
  const initialized = [];
  const errors = [];
  const originalLoad = Module._load;
  const exitListeners = new Set(process.listeners("exit"));
  for (const cap of NATIVE_CAPABILITIES) delete require.cache[cap.module];
  const tracked = new Map(NATIVE_CAPABILITIES.map((cap) => [cap.module, cap.id]));
  Module._load = function (request, parent, isMain) {
    const mod = originalLoad.call(this, request, parent, isMain);
    const id = tracked.get(request);
    if (!id) return mod;
    return { ...mod, initCapability(ctx) {
      initialized.push(id);
      return mod.initCapability(ctx);
    } };
  };
  const register = (channel, handler) => {
    assert.equal(channels.has(channel), false, `IPC 중복: ${channel}`);
    channels.set(channel, handler);
  };
  const ctx = {
    app: new EventEmitter(),
    ipcMain: { handle: register, on: register },
    BrowserWindow: { getAllWindows: () => [] },
    stateDir: home,
    isTrustedSender: () => false,
    shell: { openExternal() { throw new Error("외부 앱 실행 금지"); } },
    onSessionHardened: () => () => {},
    log() {}, error() {},
  };
  let loaded;
  try {
    loaded = vm.runInNewContext(`${prefix} ctx, onError: (id, error) => errors.push({ id, error }) })`, {
      bootNativeCapabilities, NATIVE_CAPABILITIES, readHiddenSync, IRIS_HOME: home, ctx, errors,
    });
  } finally {
    Module._load = originalLoad;
    for (const listener of process.listeners("exit")) {
      if (!exitListeners.has(listener)) process.removeListener("exit", listener);
    }
  }
  assert.deepEqual(errors, [], "켜진 실제 모듈의 init이 성공해야 한다");
  return { loaded, initialized, channels };
}

test("T2: main의 hidden 판정은 chromemirror require·init·IPC를 모두 막는다", (t) => {
  const result = bootActualNative(JSON.stringify({ version: 1, revision: 1, hidden: ["chromemirror"] }), t);
  const enabled = ["detachtab", "extensionloader", "sketch"];
  assert.deepEqual(result.loaded, enabled);
  assert.deepEqual(result.initialized, enabled);
  for (const cap of NATIVE_CAPABILITIES) {
    assert.equal(!!require.cache[cap.module], cap.id !== "chromemirror", `${cap.id} require.cache`);
  }
  assert.deepEqual([...result.channels.keys()].filter((id) => /mirror|live-chrome/.test(id)), []);
  for (const channel of ["ac-detach-tab", "ac-tabdrag-start", "ac-extension-loader-enable", "ac-sketch-shot"]) {
    assert.equal(result.channels.has(channel), true, `${channel} 등록`);
  }
});

for (const [name, content] of [
  ["hidden 없음", JSON.stringify({ version: 1, revision: 2, hidden: [] })],
  ["파일 없음", null],
  ["파일 파손", "{broken"],
]) {
  test(`T2: ${name}이면 실제 native 4개가 init되고 IPC를 등록한다`, (t) => {
    const result = bootActualNative(content, t);
    const all = NATIVE_CAPABILITIES.map((cap) => cap.id);
    assert.deepEqual(result.loaded, all);
    assert.deepEqual(result.initialized, all);
    for (const cap of NATIVE_CAPABILITIES) assert.ok(require.cache[cap.module]);
    assert.ok(result.channels.has("ac-mirror-start"));
    assert.ok(result.channels.has("ac-live-chrome-connect"));
    assert.ok(result.channels.has("ac-detach-tab"));
    assert.ok(result.channels.has("ac-extension-loader-enable"));
    assert.ok(result.channels.has("ac-sketch-shot"));
  });
}
