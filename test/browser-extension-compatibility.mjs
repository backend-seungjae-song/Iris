import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createExtensionCompatibility, matchesHost, prepareContentScripts, CONTENT_SHIM, commandShortcut, shortcutMatches } = require("../native/electron/browser-extension-compatibility.cjs");
const id = "a".repeat(32);
function fixture(t, permissions = ["webRequest", "webNavigation"], hosts = ["https://allowed.test/*"], options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "extension"); mkdirSync(directory);
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1", permissions, host_permissions: hosts }));
  const app = new EventEmitter();
  const guest = new EventEmitter(); guest.id = 7; guest.getType = () => "webview"; guest.isDestroyed = () => false;
  guest.mainFrame = { url: "https://allowed.test/", routingId: 5 };
  const worker = { versionId: 1, scriptURL: `chrome-extension://${id}/background.js`, scope: `chrome-extension://${id}/`,
    messages: [], handlers: new Map(), held: 0, ended: 0,
    ipc: { handle: (channel, callback) => {
      if (worker.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      worker.handlers.set(channel, callback);
    }, removeHandler: (channel) => worker.handlers.delete(channel) },
    isDestroyed: () => false, startTask: () => { worker.held++; return { end: () => worker.ended++ }; },
    send: (...args) => worker.messages.push(args),
  };
  const services = new EventEmitter(); services.getAllRunning = () => ({ 1: {} }); services.getWorkerFromVersionID = () => worker;
  const session = { serviceWorkers: services, preload: [], removed: [],
    registerPreloadScript: (script) => { session.preload.push(script); return "preload"; },
    unregisterPreloadScript: (script) => session.removed.push(script),
    webRequest: { onResponseStarted: () => { throw new Error("Native handler changed"); } },
    extensions: { getExtension: (candidate) => candidate === id ? { id, path: directory } : null },
  };
  guest.session = session;
  const created = [];
  const compatibility = createExtensionCompatibility({ app, webContents: { getAllWebContents: () => [guest], fromId: (candidate) => candidate === guest.id ? guest : undefined },
    createTab: async (sess, properties) => { created.push({ sess, properties }); if (properties.fail) throw new Error("create failed"); return { id: 10, url: properties.url }; }, error: () => {},
    ...options,
  });
  compatibility.authorizePath(session, directory);
  const invoke = (operation, payload) => worker.handlers.get("iris-extension-compatibility")({}, operation, payload);
  t.after(() => compatibility.dispose());
  return { compatibility, session, guest, worker, invoke, directory, created };
}

test("worker restarts register IPC once and discard old navigation subscriptions", async (t) => {
  const f = fixture(t);
  const status = (runningStatus) => f.session.serviceWorkers.emit("running-status-changed", { versionId: 1, runningStatus });
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" });
    status("stopping");
    status("stopped");
    status("stopped");
    assert.doesNotThrow(() => status("starting"));
    const handler = f.worker.handlers.get("iris-extension-compatibility");
    status("running");
    status("running");
    assert.equal(f.worker.handlers.size, 1);
    assert.equal(f.worker.handlers.get("iris-extension-compatibility"), handler);
    f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 1, 2);
    assert.equal(f.worker.messages.length, 0);
    assert.equal(f.worker.ended, cycle * 2);
    assert.equal((await f.invoke("tabs.create", { url: "https://allowed.test" })).id, 10);
  }
  await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" });
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 1, 2);
  assert.equal(f.worker.messages.length, 1);
  status("stopped");
  assert.equal(f.worker.handlers.size, 0);
  assert.equal(f.worker.held, f.worker.ended);
  f.compatibility.dispose();
  assert.equal(f.worker.held, f.worker.ended);
  assert.equal(f.session.serviceWorkers.listenerCount("running-status-changed"), 0);
});

test("HTTP workers, unselected copies, and absent permissions cannot use extension IPC", async (t) => {
  const f = fixture(t, []);
  await assert.rejects(f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" }), /권한/);
  f.worker.scriptURL = "https://allowed.test/worker.js";
  await assert.rejects(f.invoke("tabs.create", { url: "https://allowed.test" }), /확장 서비스 워커/);
  f.worker.scriptURL = `chrome-extension://${id}/background.js`;
  f.compatibility.revokePath(f.session, f.directory);
  await assert.rejects(f.invoke("tabs.create", { url: "https://allowed.test" }), /사용 중/);
});

test("navigation comes from same-session guest and obeys filters", async (t) => {
  const f = fixture(t);
  await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted", filter: { url: [{ hostEquals: "allowed.test", pathPrefix: "/watch" }] } });
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/home", 200, "OK", true, 1, 2);
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 1, 2);
  assert.equal(f.worker.messages.length, 1); assert.equal(f.worker.messages[0][2].frameId, 0);
  f.guest.session = {};
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 1, 2);
  assert.equal(f.worker.messages.length, 1);
});

test("tabs create holds worker during its promise and releases on success and failure", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.invoke("tabs.create", { url: "https://allowed.test" }), { id: 10, url: "https://allowed.test" });
  assert.equal(f.created[0].sess, f.session);
  assert.equal(f.worker.held, 1); assert.equal(f.worker.ended, 1);
  await assert.rejects(f.invoke("tabs.create", { fail: true }), /create failed/);
  assert.equal(f.worker.held, 2); assert.equal(f.worker.ended, 2);
});

test("last unsubscribe and disable release navigation task exactly once", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted", filter: { url: [{ urlMatches: ".*" }] } }), /필터/);
  assert.equal(f.worker.held, 0);
  await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" });
  await f.invoke("subscribe", { token: "2", name: "webNavigation.onCommitted" });
  assert.equal(f.worker.held, 1);
  await f.invoke("unsubscribe", { token: "1", name: "webNavigation.onCommitted" });
  assert.equal(f.worker.ended, 0);
  await f.invoke("unsubscribe", { token: "2", name: "webNavigation.onCommitted" });
  assert.equal(f.worker.ended, 1);
  await f.invoke("subscribe", { token: "3", name: "webNavigation.onCommitted" });
  f.compatibility.revokePath(f.session, f.directory);
  assert.equal(f.worker.held, 2); assert.equal(f.worker.ended, 2);
});

test("native webRequest remains untouched and subframe ids use frame tree", async (t) => {
  const f = fixture(t);
  const frame = { parent: f.guest.mainFrame, frameTreeNodeId: 44, routingId: 888, processId: 7 };
  f.guest.mainFrame.framesInSubtree = [frame];
  await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" });
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", false, 7, 888);
  assert.equal(f.worker.messages[0][2].frameId, 44); assert.equal(f.worker.messages[0][2].parentFrameId, 0);
  await assert.rejects(f.invoke("subscribe", { token: "2", name: "webRequest.onResponseStarted" }), /필터/);
  await assert.rejects(f.invoke("subscribe", { token: "2", name: "webRequest.onBeforeSendHeaders", filter: { urls: ["<all_urls>"] } }), /권한/);
  f.compatibility.dispose();
});

test("host wildcard cannot match sibling domains, script schemes, or file paths", () => {
  assert.equal(matchesHost("https://*.allowed.test/*", "https://sub.allowed.test/path"), true);
  assert.equal(matchesHost("https://*.allowed.test/*", "https://allowed.test.evil.test/path"), false);
  assert.equal(matchesHost("<all_urls>", "file:///private/data"), false);
  assert.equal(matchesHost("<all_urls>", "chrome-extension://other/page"), false);
});

const keyDown = (code, mods = {}) => ({ type: "keyDown", code, key: code.replace(/^Key/, "").toLowerCase(), meta: false, control: false, alt: false, shift: false, ...mods });
test("manifest 단축키는 macOS 에서 Ctrl 을 Command 로 읽고 반복 입력은 무시", () => {
  const y = commandShortcut({ suggested_key: { default: "Ctrl+Shift+Y" } }, "darwin");
  assert.equal(shortcutMatches(y, keyDown("KeyY", { meta: true, shift: true })), true);
  assert.equal(shortcutMatches(y, keyDown("KeyY", { control: true, shift: true })), false);
  assert.equal(shortcutMatches(y, { ...keyDown("KeyY", { meta: true, shift: true }), isAutoRepeat: true }), false);
  assert.equal(shortcutMatches(commandShortcut({ suggested_key: { default: "Ctrl+Shift+Y" } }, "linux"), keyDown("KeyY", { control: true, shift: true })), true);
  assert.equal(shortcutMatches(commandShortcut({ suggested_key: { mac: "MacCtrl+Comma" } }, "darwin"), { ...keyDown("Comma", { control: true }), key: "," }), true);
  assert.equal(commandShortcut({ description: "단축키 없음" }, "darwin"), null);
});

test("선언한 단축키를 누르면 그 확장 워커에만 onCommand 를 보내고 페이지에는 넘기지 않음", async (t) => {
  const f = fixture(t, []);
  writeFileSync(path.join(f.directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1",
    commands: { "trigger-translation": { suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" } }, "no-key": {} } }));
  f.guest.getURL = () => "https://allowed.test/"; f.guest.getTitle = () => "page";
  assert.deepEqual((await f.invoke("commands.getAll")).map((c) => c.name), ["trigger-translation", "no-key"]);
  const press = (input) => { let prevented = false; f.guest.emit("before-input-event", { defaultPrevented: false, preventDefault: () => { prevented = true; } }, input); return prevented; };
  const hit = process.platform === "darwin" ? { meta: true, shift: true } : { control: true, shift: true };
  assert.equal(press(keyDown("KeyY", hit)), false);
  await f.invoke("subscribe", { token: "9", name: "commands.onCommand" });
  assert.equal(press(keyDown("KeyX", hit)), false);
  assert.equal(press(keyDown("KeyY", hit)), true);
  assert.equal(f.worker.messages.length, 1);
  assert.equal(f.worker.messages[0][1], "9"); assert.equal(f.worker.messages[0][2].command, "trigger-translation");
  assert.equal(f.worker.messages[0][2].tab.id, 7);
  let skipped = false;
  f.guest.emit("before-input-event", { defaultPrevented: true, preventDefault: () => { skipped = true; } }, keyDown("KeyY", hit));
  assert.equal(skipped, false); assert.equal(f.worker.messages.length, 1);
});

test("단축키를 선언하지 않은 확장은 onCommand 를 구독할 수 없음", async (t) => {
  const f = fixture(t, []);
  await assert.rejects(f.invoke("subscribe", { token: "1", name: "commands.onCommand" }), /권한/);
});

test("content script 앞에 보정 파일을 한 번만 끼우고 페이지 world 는 제외", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-shim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { manifest_version: 3, name: "fixture", version: "1", key: "abc",
    content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }, { matches: ["<all_urls>"], js: ["main.js"], world: "MAIN" }, { matches: ["<all_urls>"], css: ["x.css"] }] };
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  assert.equal(prepareContentScripts(root), true);
  const first = readFileSync(path.join(root, "manifest.json"), "utf8");
  const saved = JSON.parse(first);
  assert.deepEqual(saved.content_scripts.map((entry) => entry.js), [[CONTENT_SHIM, "a.js"], ["main.js"], undefined]);
  assert.equal(saved.key, "abc");
  assert.match(readFileSync(path.join(root, CONTENT_SHIM), "utf8"), /storage/);
  prepareContentScripts(root);
  assert.equal(readFileSync(path.join(root, "manifest.json"), "utf8"), first);
  const none = mkdtempSync(path.join(os.tmpdir(), "iris-shim-"));
  t.after(() => rmSync(none, { recursive: true, force: true }));
  writeFileSync(path.join(none, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "n", version: "1" }));
  assert.equal(prepareContentScripts(none), false);
});

test("워커 보정은 browser 로 부르는 확장에도 빈 구현과 창 정보를 줌", async () => {
  const Module = require("node:module");
  const funcs = [];
  const exposed = {};
  const electron = { contextBridge: { executeInMainWorld: ({ func }) => { funcs.push(func); return true; }, exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: { invoke: async (_channel, operation, payload) => { invoked.push([operation, payload?.name]); return []; }, on: () => {} } };
  const invoked = [];
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? electron : load.call(this, request, ...rest); };
  const file = require.resolve("../native/electron/browser-extension-worker-preload.cjs");
  try { delete require.cache[file]; require(file); } finally { Module._load = load; delete require.cache[file]; }
  const local = {};
  const native = { addListener() { throw new Error("native"); } };
  const chrome = { runtime: { getManifest: () => ({ manifest_version: 3, permissions: ["storage", "webNavigation", "webRequest"] }) }, storage: { local }, tabs: {},
    webRequest: { onBeforeRequest: native, onResponseStarted: native, onBeforeSendHeaders: native } };
  const browser = { runtime: chrome.runtime, storage: chrome.storage, tabs: chrome.tabs, webRequest: chrome.webRequest };
  const vm = require("node:vm");
  const context = vm.createContext({ location: { protocol: "chrome-extension:" }, chrome, browser, queueMicrotask, console, ...exposed });
  vm.runInContext(`(${funcs[1]})()`, context);
  assert.equal(typeof browser.permissions.onRemoved.addListener, "function");
  assert.equal(typeof browser.contextMenus.update, "function");
  assert.equal(browser.storage.sync, local);
  assert.equal(chrome.windows.WINDOW_ID_NONE, -1);
  assert.equal((await browser.windows.getCurrent()).id, 0);
  assert.equal((await chrome.windows.getAll()).map((window) => window.id).join(), "0");
  // 권한으로 선언한 webNavigation 도 빈 구현이 아니라 Iris 가 전달하는 이벤트·프레임 목록
  browser.webNavigation.onCommitted.addListener(() => {});
  browser.webNavigation.onHistoryStateUpdated.addListener(() => {});
  await browser.webNavigation.getAllFrames({ tabId: 7 });
  // 문서 요청 webRequest 이벤트는 Iris 가 전달하고 나머지는 Electron 것 그대로
  browser.webRequest.onResponseStarted.addListener(() => {}, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  browser.runtime.onInstalled.addListener(() => {});
  assert.equal(chrome.webRequest.onBeforeSendHeaders, native);
  assert.equal(JSON.stringify(invoked), JSON.stringify([["subscribe", "webNavigation.onCommitted"], ["subscribe", "webNavigation.onHistoryStateUpdated"], ["webNavigation.getAllFrames", undefined],
    ["subscribe", "webRequest.onResponseStarted"], ["subscribe", "runtime.onInstalled"]]));
});

test("이미 멈춘 워커의 작업 종료 예외가 상태 변경 이벤트 밖으로 나가지 않음", async (t) => {
  const f = fixture(t);
  f.worker.startTask = () => ({ end: () => { throw new Error("Service worker was not found"); } });
  await f.invoke("subscribe", { token: "1", name: "webNavigation.onCommitted" });
  assert.doesNotThrow(() => f.session.serviceWorkers.emit("running-status-changed", { versionId: 1, runningStatus: "stopped" }));
  assert.equal(f.worker.handlers.size, 0);
});

test("webNavigation 프레임 목록과 문서 안 이동·로드 완료 이벤트를 탭 화면에서 전달", async (t) => {
  const f = fixture(t);
  const child = { parent: f.guest.mainFrame, frameTreeNodeId: 44, routingId: 888, processId: 7, url: "https://allowed.test/ad" };
  Object.assign(f.guest.mainFrame, { processId: 7, framesInSubtree: [f.guest.mainFrame, child] });
  f.guest.getURL = () => "https://allowed.test/watch";
  const frames = await f.invoke("webNavigation.getAllFrames", { tabId: 7 });
  assert.deepEqual(frames.map((frame) => [frame.frameId, frame.parentFrameId, frame.url]), [[0, -1, "https://allowed.test/"], [44, 0, "https://allowed.test/ad"]]);
  assert.equal((await f.invoke("webNavigation.getFrame", { tabId: 7, frameId: 44 })).url, "https://allowed.test/ad");
  assert.equal(await f.invoke("webNavigation.getAllFrames", { tabId: 999 }), null);
  const session = f.guest.session; f.guest.session = {};
  assert.equal(await f.invoke("webNavigation.getAllFrames", { tabId: 7 }), null);
  f.guest.session = session;
  for (const [token, name] of [["1", "onHistoryStateUpdated"], ["2", "onReferenceFragmentUpdated"], ["3", "onCompleted"]]) await f.invoke("subscribe", { token, name: `webNavigation.${name}` });
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 7, 5);
  f.guest.emit("did-navigate-in-page", {}, "https://allowed.test/watch#top", true, 7, 5);
  f.guest.emit("did-navigate-in-page", {}, "https://allowed.test/next", true, 7, 5);
  f.guest.emit("did-frame-finish-load", {}, false, 7, 888);
  assert.deepEqual(f.worker.messages.map(([, token, payload]) => [token, payload.url, payload.frameId]),
    [["2", "https://allowed.test/watch#top", 0], ["1", "https://allowed.test/next", 0], ["3", "https://allowed.test/ad", 44]]);
  const none = fixture(t, ["webRequest"]);
  await assert.rejects(none.invoke("webNavigation.getAllFrames", { tabId: 7 }), /권한/);
});

test("문서 요청 webRequest 이벤트를 탭 화면에서 같은 requestId 로 전달하고 필터·호스트 권한을 지킴", async (t) => {
  const f = fixture(t, ["webRequest"], ["https://*.allowed.test/*", "https://allowed.test/*"]);
  const child = { parent: f.guest.mainFrame, frameTreeNodeId: 44, routingId: 888, processId: 7, url: "https://allowed.test/ad" };
  Object.assign(f.guest.mainFrame, { processId: 7, framesInSubtree: [f.guest.mainFrame, child] });
  f.guest.getURL = () => "https://allowed.test/watch";
  await assert.rejects(f.invoke("subscribe", { token: "9", name: "webRequest.onBeforeRequest", filter: { urls: "<all_urls>" } }), /필터/);
  await f.invoke("subscribe", { token: "1", name: "webRequest.onBeforeRequest", filter: { urls: ["https://*.allowed.test/"] }, extraInfoSpec: ["blocking"] });
  await f.invoke("subscribe", { token: "2", name: "webRequest.onResponseStarted", filter: { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] } });
  await f.invoke("subscribe", { token: "3", name: "webRequest.onCompleted", filter: { urls: ["<all_urls>"], tabId: 7 } });
  await f.invoke("subscribe", { token: "4", name: "webRequest.onErrorOccurred", filter: { urls: ["<all_urls>"], tabId: 8 } });
  f.guest.emit("did-start-navigation", { url: "https://allowed.test/", isMainFrame: true, isSameDocument: false, frame: f.guest.mainFrame });
  f.guest.emit("did-start-navigation", { url: "https://allowed.test/#x", isMainFrame: true, isSameDocument: true, frame: f.guest.mainFrame });
  f.guest.emit("did-frame-navigate", {}, "https://allowed.test/watch", 200, "OK", true, 7, 5);
  f.guest.emit("did-frame-finish-load", {}, true, 7, 5);
  f.guest.emit("did-start-navigation", { url: "https://allowed.test/ad", isMainFrame: false, isSameDocument: false, frame: child });
  f.guest.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://allowed.test/ad", false, 7, 888);
  f.guest.emit("did-start-navigation", { url: "https://other.test/", isMainFrame: true, isSameDocument: false, frame: f.guest.mainFrame });
  f.guest.emit("did-frame-navigate", {}, "https://other.test/", 200, "OK", true, 7, 5);
  const seen = f.worker.messages.map(([, token, payload]) => [token, payload.requestId, payload.url, payload.type, payload.tabId, payload.frameId, payload.statusCode]);
  assert.deepEqual(seen.map((row) => row.slice(0, 1).concat(row.slice(2))), [
    ["1", "https://allowed.test/", "main_frame", 7, 0, undefined],
    ["2", "https://allowed.test/watch", "main_frame", 7, 0, 200],
    ["3", "https://allowed.test/watch", "main_frame", 7, 0, 200],
  ]);
  assert.equal(new Set(seen.map((row) => row[1])).size, 1);
  // 다른 탭 필터의 오류 이벤트는 오지 않고, 같은 탭이면 net:: 오류 이름
  await f.invoke("subscribe", { token: "5", name: "webRequest.onErrorOccurred", filter: { urls: ["<all_urls>"] } });
  f.guest.emit("did-start-navigation", { url: "https://allowed.test/ad", isMainFrame: false, isSameDocument: false, frame: child });
  f.guest.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://allowed.test/ad", false, 7, 888);
  const failed = f.worker.messages.at(-1);
  assert.deepEqual([failed[1], failed[2].type, failed[2].frameId, failed[2].parentFrameId, failed[2].error], ["5", "sub_frame", 44, 0, "net::ERR_NAME_NOT_RESOLVED"]);
  assert.equal(f.worker.messages.length, 4);
});

test("onInstalled 는 확장마다 처음 install·버전 변경 update·저장 전부터 있던 확장 chrome_update 를 한 번, onStartup 은 실행마다 한 번", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = async (file, version = "1") => {
    const f = fixture(t, [], [], { lifecyclePath: file });
    writeFileSync(path.join(f.directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version }));
    await f.invoke("subscribe", { token: "1", name: "runtime.onInstalled" });
    await f.invoke("subscribe", { token: "2", name: "runtime.onStartup" });
    // 워커가 다시 시작돼 다시 등록해도 같은 실행에서는 다시 보내지 않음
    await f.invoke("subscribe", { token: "3", name: "runtime.onInstalled" });
    await f.invoke("subscribe", { token: "4", name: "runtime.onStartup" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.worker.held, 0);
    f.compatibility.dispose();
    return f.worker.messages.map(([, token, payload]) => [token, payload]);
  };
  const legacy = path.join(root, "legacy", "lifecycle.json");
  assert.deepEqual(await run(legacy), [["1", { reason: "chrome_update" }], ["2", {}]]);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), { [id]: "1" });
  assert.deepEqual(await run(legacy), [["2", {}]]);
  assert.deepEqual(await run(legacy, "2"), [["1", { reason: "update", previousVersion: "1" }], ["2", {}]]);
  const fresh = path.join(root, "fresh.json");
  writeFileSync(fresh, "{}");
  assert.deepEqual(await run(fresh), [["1", { reason: "install" }]]);
  assert.deepEqual(await run(fresh), [["2", {}]]);
});

test("시작 중인 워커에는 onInstalled 를 보내지 않고 실행 중 상태가 된 뒤에 보냄", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(t, [], [], { lifecyclePath: path.join(root, "lifecycle.json") });
  const status = (runningStatus) => f.session.serviceWorkers.emit("running-status-changed", { versionId: 1, runningStatus });
  status("stopped");
  status("starting");
  await f.invoke("subscribe", { token: "1", name: "runtime.onInstalled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.worker.messages.length, 0);
  status("running");
  status("running");
  assert.deepEqual(f.worker.messages.map(([, token, payload]) => [token, payload]), [["1", { reason: "chrome_update" }]]);
});
