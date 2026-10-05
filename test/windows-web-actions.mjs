import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import * as paths from "../web/js/core/host-path.js";

function evaluate(file, start, end, name, deps) {
  const source = sliceBetween(readFileSync(file, "utf8"), start, end, name).replace(/\bexport /g, "");
  return runInNewContext(source + `\n;${name}`, { ...paths, ...deps });
}
function windows() { globalThis.acHost = { platform: "win32" }; }
const noop = () => {};

test("Explorer trash action finds dirty descendants across Windows case and separator differences", async () => {
  windows();
  const dirty = { id: "dirty", kind: "file", path: "c:/WORK/sub/../changed.md", label: "changed.md" };
  const sibling = { id: "sibling", kind: "file", path: "C:\\work-other\\safe.md", label: "safe.md" };
  const prompts = [], deleted = [];
  let menu, createDir;
  const identity = { ok: true, dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, canonicalPath: "C:\\work" };
  const open = evaluate("web/js/explorer/context-menu.js", "export function openFileCtx", "export function ctxItems", "openFileCtx", {
    window: { acHost: { filePathIdentity: async (p) => ({ ...identity, canonicalPath: p }), trashItem: async (p) => { deleted.push(p); return { ok: true }; } } },
    getTabSpaces: () => ["space"], getTabs: () => [dirty, sibling], isFileLikeKind: () => true, isTabDirty: () => true,
    hasActiveCloseDialog: () => false, chooseDirtyAction: async (title, note) => { prompts.push(note); return "cancel"; },
    createEntryMenuItems: (dir) => { createDir = dir; return []; }, relPath: (p) => p, fileClip: null,
    showCtx: (x, y, items) => { menu = items; }, showToast: noop, copyText: async () => true,
  });
  open(0, 0, "C:\\work", true);
  await menu.find((item) => item.label === "삭제(휴지통)").act();
  assert.deepEqual(prompts, ["changed.md"]);
  assert.deepEqual(deleted, []);
  assert.equal(menu.find((item) => item.label === "탐색기에서 보기") != null, true);
  open(0, 0, "C:\\work\\file.md", false);
  assert.equal(createDir, "C:\\work");
});

test("Windows folder rename retargets descendants, watch ownership and active ID without sibling changes", () => {
  windows();
  const moved = { id: "file:old", kind: "file", path: "c:/WORK/dir/sub/a.md", label: "a.md" };
  const sibling = { id: "file:sibling", kind: "file", path: "C:\\work\\dir-other\\b.md", label: "b.md" };
  const watched = [], untracked = [], active = [];
  const move = evaluate("web/js/center/tab-close.js", "export function retargetFileTabs", "function discardTabFingerprint", "retargetFileTabs", {
    getMonacoModels: () => new Map(), getMonacoViewState: () => new Map(), getMonacoEditor: () => null, getMonacoRuntime: () => null,
    getTabSpaces: () => ["space"], getTabs: () => [moved, sibling], isFileLikeKind: () => true,
    trackFileWatch: (sp, tab) => watched.push(tab.path), untrackFileWatch: (p) => untracked.push(p),
    getActiveTabId: () => "file:old", setActiveTab: (sp, id) => active.push(id), tabIoRegistry: new Map(), callHook: noop,
    renderTabs: noop, showActiveTab: noop, persistFileTabs: noop,
  });
  move("C:\\work\\DIR", "D:\\target");
  assert.equal(moved.path, "D:\\target\\sub\\a.md");
  assert.equal(moved.label, "a.md");
  assert.deepEqual(active, ["file:D:\\target\\sub\\a.md"]);
  assert.deepEqual(watched, ["D:\\target\\sub\\a.md"]);
  assert.deepEqual(untracked, ["c:/WORK/dir/sub/a.md"]);
  assert.equal(sibling.path, "C:\\work\\dir-other\\b.md");
});

test("Windows open files subscribe to complete drive and UNC parent directories", () => {
  windows();
  let callback, request;
  const watch = evaluate("web/js/center/tabs.js", "export function syncWatchDirs", "export function setLastWatchKey", "syncWatchDirs", {
    watchTimer: null, lastWatchKey: "", setTimeout: (fn) => { callback = fn; return 1; },
    getTabSpaces: () => ["space"], getTabs: () => [{ kind: "file", path: "C:\\a.md" }, { kind: "file", path: "\\\\server\\share\\dir\\a.md" }],
    isFileLikeKind: () => true, expandedDirs: () => [], wsSend: (m) => { request = m; },
  });
  watch(); callback();
  assert.equal(request.type, "fs.watch");
  assert.deepEqual(Array.from(request.dirs), ["C:\\", "\\\\server\\share\\dir"]);
});

test("Windows directory notifications reload named files with Windows separators", () => {
  windows();
  const reloaded = [];
  const changed = evaluate("web/js/main.js", "function handleDirChangedMessage", "function handleFileMessage", "handleDirChangedMessage", {
    dirCache: new Map(), callHook: noop, getTabSpaces: () => ["space"],
    getTabs: () => [{ kind: "file", path: "C:\\work\\a.md" }, { kind: "file", path: "C:\\work\\b.md" }, { kind: "file", path: "C:\\work-other\\a.md" }],
    isFileLikeKind: () => true, requestReload: (p) => reloaded.push(p),
  });
  changed({ dir: "c:\\WORK", names: ["a.md"] });
  assert.deepEqual(reloaded, ["C:\\work\\a.md"]);
});
