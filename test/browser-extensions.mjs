import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { createBrowserExtensions, extensionPageURL, initCapability } = require("../native/electron/browser-extensions.cjs");
const { discoverChromeExtensions, copyExtension } = require("../native/electron/browser-extension-catalog.cjs");
const { isProfilePartition } = require("../native/electron/profile-session-policy.cjs");
const BASE = "persist:acbrowser";
const OTHER = "persist:acprof:other";
const idFor = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));

function fixture(t, manifest = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-browser-extensions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "테스트 확장", version: "1.0", browser_action: { default_popup: "popup.html" }, ...manifest }));
  writeFileSync(path.join(source, "popup.html"), "<p>popup</p>");
  return { root, source, state: path.join(root, "state") };
}

function fakeSession({ fail = false } = {}) {
  const registry = new Map();
  const calls = [];
  return {
    registry, calls, isPersistent: () => true,
    extensions: {
      getAllExtensions: () => [...registry.values()], getExtension: (id) => registry.get(id) || null,
      removeExtension: (id) => registry.delete(id),
      async loadExtension(directory) {
        calls.push(directory);
        if (fail) throw new Error("지원하지 않는 확장");
        const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
        const id = idFor(manifest.key ? Buffer.from(manifest.key, "base64") : directory);
        const extension = { id, name: manifest.name, manifest, path: directory };
        registry.set(id, extension);
        return extension;
      },
    },
  };
}

function setup(state, sessions = new Map([[BASE, fakeSession()]]), extras = {}) {
  const sender = { isDestroyed: () => false };
  const guest = { id: 3, session: sessions.get(BASE), getType: () => "webview", isDestroyed: () => false, hostWebContents: sender };
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.getURL = () => this.url; this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; }; this.destroyed = false; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit("closed"); }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    static fromWebContents() { return null; }
  }
  const notices = [], dialogs = [], templates = [];
  let listener;
  const deps = {
    stateHomeImpl: () => state, app: { whenReady: () => Promise.resolve() }, BrowserWindow: FakeWindow, isProfilePartition,
    webContents: { fromId: (id) => id === 3 ? guest : null },
    sessionFromPartition: (partition) => sessions.get(partition),
    forEachHardened: async (visit) => { for (const partition of sessions.keys()) await visit(partition); },
    onSessionHardened: (visit) => { listener = visit; return () => {}; }, isTrustedSender: (event) => event.sender === sender,
    discoverChromeExtensions: () => [], notice: (notice) => notices.push(notice),
    nativeUI: { Menu: { buildFromTemplate: (template) => { templates.push(template); return { popup() {} }; } }, dialog: { showMessageBox: async (...args) => dialogs.push(args) } },
    ...extras,
  };
  return { manager: createBrowserExtensions(deps), deps, guest, sender, event: { sender }, windows, templates, dialogs, notices, hardened: (...args) => listener(...args) };
}

test("selected extension copy persists, restores only its profile, and can be disabled and removed", async (t) => {
  const { source, state } = fixture(t);
  const first = setup(state, new Map([[BASE, fakeSession()], [OTHER, fakeSession()]]));
  await first.manager.ready;
  const record = await first.manager.install(BASE, { path: source });
  assert.equal(first.deps.sessionFromPartition(BASE).calls.length, 1);
  assert.equal(first.deps.sessionFromPartition(OTHER).calls.length, 0);
  assert.ok(first.deps.sessionFromPartition(BASE).calls[0].startsWith(realpathSync(state)));
  assert.equal(readFileSync(path.join(source, "popup.html"), "utf8"), "<p>popup</p>");
  const restored = setup(state, new Map([[BASE, fakeSession()], [OTHER, fakeSession()]]));
  await restored.manager.ready;
  assert.equal(restored.deps.sessionFromPartition(BASE).calls.length, 1);
  assert.equal(restored.deps.sessionFromPartition(OTHER).calls.length, 0);
  await restored.manager.setEnabled(BASE, record.key, false);
  assert.equal(restored.deps.sessionFromPartition(BASE).registry.size, 0);
  const disabled = setup(state);
  await disabled.manager.ready;
  assert.equal(disabled.deps.sessionFromPartition(BASE).calls.length, 0);
  await disabled.manager.setEnabled(BASE, record.key, true);
  await disabled.manager.remove(BASE, record.key);
  assert.equal(disabled.deps.sessionFromPartition(BASE).registry.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "browser-extensions/registry.json")))[BASE], []);
});

test("restore waits for app readiness and newly hardened profiles restore their selection", async (t) => {
  const { source, state } = fixture(t);
  const original = setup(state, new Map([[OTHER, fakeSession()]]));
  await original.manager.ready;
  await original.manager.install(OTHER, { path: source });
  let resolve;
  const ready = new Promise((finish) => { resolve = finish; });
  const restored = setup(state, new Map(), { app: { whenReady: () => ready } });
  const session = fakeSession();
  restored.hardened(OTHER, session);
  await Promise.resolve();
  assert.equal(session.calls.length, 0);
  resolve();
  await restored.manager.ready;
  await restored.manager.restore(OTHER, session);
  assert.equal(session.calls.length, 1);
});

test("trusted host and registered guest session are both required", async (t) => {
  const { state } = fixture(t);
  const host = setup(state);
  await host.manager.ready;
  assert.equal(host.manager.targetFor(host.event, 3).partition, BASE);
  assert.throws(() => host.manager.targetFor({ sender: {} }, 3));
  host.guest.hostWebContents = {};
  assert.throws(() => host.manager.targetFor(host.event, 3));
  host.guest.hostWebContents = host.sender;
  host.guest.session = fakeSession();
  assert.throws(() => host.manager.targetFor(host.event, 3));
  assert.throws(() => host.manager.targetFor(host.event, "3"));
});

test("popup shares guest session, has no preload or Node, and blocks escape navigation", async (t) => {
  const { source, state } = fixture(t);
  const host = setup(state);
  await host.manager.ready;
  const record = await host.manager.install(BASE, { path: source });
  const extension = host.guest.session.extensions.getExtension(record.id);
  const target = host.manager.targetFor(host.event, 3);
  const popup = await host.manager.openPage(target, extension, "popup.html");
  assert.deepEqual(popup.options.webPreferences, { session: host.guest.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
  assert.equal(popup.shown, true);
  assert.deepEqual(popup.openHandler({ url: "https://example.com" }), { action: "deny" });
  let prevented = false;
  popup.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://example.com");
  assert.equal(prevented, true);
  assert.equal(await host.manager.openPage(target, extension, "popup.html"), popup);
  assert.equal(await host.manager.openPage(target, extension, "options.html"), popup);
  assert.equal(popup.url, `chrome-extension://${record.id}/options.html`);
  await host.manager.setEnabled(BASE, record.key, false);
  assert.equal(popup.destroyed, true);
  for (const page of ["https://example.com", "//example.com", "../other.html", "%2e%2e/other.html", "folder\\other.html"]) assert.equal(extensionPageURL(record.id, page), null);
});

test("installation failure creates no saved selection; restore failure remains visible", async (t) => {
  const { source, state } = fixture(t);
  const failed = setup(state, new Map([[BASE, fakeSession({ fail: true })]]));
  await failed.manager.ready;
  await assert.rejects(failed.manager.install(BASE, { path: source }), /지원하지 않는 확장/);
  assert.deepEqual(readdirSync(path.join(state, "browser-extensions/files")), []);
  const successful = setup(state);
  await successful.manager.ready;
  await successful.manager.install(BASE, { path: source });
  const restored = setup(state, new Map([[BASE, fakeSession({ fail: true })]]));
  await restored.manager.ready;
  assert.equal(restored.notices.length, 1);
  await restored.manager.showMenu(restored.event, { guestWebContentsId: 3 });
  assert.ok(restored.templates[0][1].submenu.some((item) => item.label === "로드 실패 내용"));
});

test("Chrome catalog chooses latest valid version and copies never follow symlinks", (t) => {
  const { root, source } = fixture(t);
  const chrome = path.join(root, "Chrome");
  const extensionRoot = path.join(chrome, "Default", "Extensions", "a".repeat(32));
  for (const version of ["1.0_0", "2.0_0", "9.0_0"]) {
    const directory = path.join(extensionRoot, version);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "manifest.json"), version === "9.0_0" ? "bad json" : JSON.stringify({ manifest_version: 3, name: version, version: version.split("_")[0] }));
  }
  writeFileSync(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "개인" } } } }));
  assert.equal(discoverChromeExtensions(chrome)[0].name, "개인");
  assert.equal(discoverChromeExtensions(chrome)[0].candidates[0].version, "2.0");
  symlinkSync(path.join(root, "Chrome"), path.join(source, "outside"));
  assert.throws(() => copyExtension(source, path.join(root, "copied")), /링크/);
});

test("preexisting extensions belong to their original owner and cannot be overwritten", async (t) => {
  const key = Buffer.from("fixture public key").toString("base64");
  const { source, state } = fixture(t, { key });
  const host = setup(state);
  await host.manager.ready;
  const id = idFor(Buffer.from(key, "base64"));
  host.guest.session.registry.set(id, { id, name: "기존 확장", path: source });
  await assert.rejects(host.manager.install(BASE, { path: source }), /이미 설치/);
  assert.equal(host.guest.session.calls.length, 0);
  assert.equal(host.guest.session.registry.size, 1);
  await host.manager.showMenu(host.event, { guestWebContentsId: 3 });
  assert.ok(host.templates[0].some((item) => item.label === "기존 확장 (다른 기능에서 관리)" && item.enabled === false));
});

test("Chrome extension ID mismatch unloads the imported copy and preserves no selection", async (t) => {
  const { source, state } = fixture(t);
  const host = setup(state);
  await host.manager.ready;
  await assert.rejects(host.manager.install(BASE, { path: source, sourceId: "a".repeat(32) }), /확장 ID/);
  assert.equal(host.guest.session.registry.size, 0);
  assert.deepEqual(readdirSync(path.join(state, "browser-extensions/files")), []);
});

test("registry write failure rolls back install, enable, disable, and remove", async (t) => {
  const { source, state } = fixture(t);
  const host = setup(state);
  await host.manager.ready;
  const record = await host.manager.install(BASE, { path: source });
  const registry = path.join(state, "browser-extensions/registry.json");
  const withWriteFailure = async (operation) => {
    renameSync(registry, `${registry}.backup`);
    mkdirSync(registry);
    try { await assert.rejects(operation(), /directory|EISDIR|ENOTDIR/i); }
    finally { rmSync(registry, { recursive: true }); renameSync(`${registry}.backup`, registry); }
  };
  await withWriteFailure(() => host.manager.setEnabled(BASE, record.key, false));
  assert.equal(host.guest.session.registry.size, 1);
  await withWriteFailure(() => host.manager.remove(BASE, record.key));
  assert.equal(host.guest.session.registry.size, 1);
  await host.manager.setEnabled(BASE, record.key, false);
  await withWriteFailure(() => host.manager.setEnabled(BASE, record.key, true));
  assert.equal(host.guest.session.registry.size, 0);
  await withWriteFailure(() => host.manager.install(BASE, { path: source }));
  assert.equal(host.guest.session.registry.size, 0);
  assert.deepEqual(readdirSync(path.join(state, "browser-extensions/files")), [record.key]);
  assert.equal(JSON.parse(readFileSync(registry))[BASE][0].enabled, false);
});

test("disable and remove never unload another owner's replacement extension", async (t) => {
  const { source, state } = fixture(t);
  const host = setup(state);
  await host.manager.ready;
  const record = await host.manager.install(BASE, { path: source });
  const replacement = { id: record.id, name: "다른 기능", path: source };
  host.guest.session.registry.set(record.id, replacement);
  await host.manager.setEnabled(BASE, record.key, false);
  assert.equal(host.guest.session.registry.get(record.id), replacement);
  await host.manager.remove(BASE, record.key);
  assert.equal(host.guest.session.registry.get(record.id), replacement);
});

test("IPC rejects untrusted renderer before opening the native menu", async (t) => {
  const { state } = fixture(t);
  const host = setup(state);
  let handler;
  const manager = initCapability({ ...host.deps, ipcMain: { handle: (name, callback) => { assert.equal(name, "ac-browser-extensions-menu"); handler = callback; } } });
  await manager.ready;
  const result = await handler({ sender: {} }, { guestWebContentsId: 3, path: "/arbitrary" });
  assert.equal(result.ok, false);
  assert.equal(host.templates.length, 0);
});
