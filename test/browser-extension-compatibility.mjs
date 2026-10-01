import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createExtensionCompatibility, matchesHost } = require("../native/electron/browser-extension-compatibility.cjs");
const id = "a".repeat(32);
function fixture(t, permissions = ["webRequest", "webNavigation"], hosts = ["https://allowed.test/*"]) {
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
  const compatibility = createExtensionCompatibility({ app, webContents: { getAllWebContents: () => [guest], fromId: () => guest },
    createTab: async (sess, properties) => { created.push({ sess, properties }); if (properties.fail) throw new Error("create failed"); return { id: 10, url: properties.url }; }, error: () => {},
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
  await assert.rejects(f.invoke("subscribe", { token: "2", name: "webRequest.onResponseStarted" }), /권한/);
  f.compatibility.dispose();
});

test("host wildcard cannot match sibling domains, script schemes, or file paths", () => {
  assert.equal(matchesHost("https://*.allowed.test/*", "https://sub.allowed.test/path"), true);
  assert.equal(matchesHost("https://*.allowed.test/*", "https://allowed.test.evil.test/path"), false);
  assert.equal(matchesHost("<all_urls>", "file:///private/data"), false);
  assert.equal(matchesHost("<all_urls>", "chrome-extension://other/page"), false);
});
