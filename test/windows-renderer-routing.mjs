import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import * as paths from "../web/js/core/host-path.js";

const read = (file) => readFileSync(file, "utf8");
const evaluate = (file, start, end, name, deps) => vm.runInNewContext((end ? sliceBetween(read(file), start, end, name) : read(file).slice(read(file).indexOf(start))).replace(/\bexport /g, "") + `\n;${name}`, { ...paths, ...deps });
async function keys(platform) {
  globalThis.acHost = { platform };
  return import(`../web/js/core/keymap.js?platform=${platform}`);
}
function harness(map, platform, { browser = false, terminal = false } = {}) {
  const listeners = [], calls = [];
  const win = { acHost: { platform, appReload: () => calls.push("app") } };
  const document = { activeElement: {}, addEventListener: (_e, fn, capture) => listeners.push({ fn, capture }), getElementById: () => null };
  const init = evaluate("web/js/core/keynav.js", "let wsSend, BROWSER_MODE", "function flatAgents", "initKeynav", {
    ...map, isHostWindows: () => platform === "win32", window: win, document, location: { reload: () => calls.push("app") },
    currentSwitcherState: () => ({}), isAgentRenaming: () => false, getTerminal: () => ({ contains: () => terminal }),
    cycleRail: (n) => calls.push(`rail:${n}`), cycleAgent: (n) => calls.push(`agent:${n}`), cycleSpace: (n) => calls.push(`space:${n}`), cycleCenterTab: (n) => calls.push(`tab:${n}`),
    runSwitcherKey: (n) => { calls.push(`switch:${n}`); return "step"; }, gotoMainScreen() {}, gotoSpaceBrowser() {}, toggleDevTools() {},
    curTabs: () => [{ id: "b", kind: "browser" }], getCenterSpace: () => "s", getActiveTabId: () => "b", shouldTakeFindKey: () => false,
    activeWv: () => ({ el: { reload: () => calls.push("page"), reloadIgnoringCache: () => calls.push("page-hard") } }),
    closeCurrentHerdrPane: () => calls.push("pane"), closeActiveTab: () => calls.push("close-page"), closeTabs: () => calls.push("close-page"),
    saveActiveFile: () => calls.push("save"), startInlineRename: () => calls.push("rename"), callHook() {},
    openFilePalette() {}, reopenLastClosed() {},
  });
  init({ BROWSER_MODE: browser, MEMO_MODE: false, acHost: win.acHost });
  const press = (props) => {
    let prevented = false, stopped = false;
    const e = { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: {}, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; }, ...props };
    for (const { fn, capture } of listeners.filter((x) => x.capture)) { fn(e); if (stopped) break; }
    if (!stopped) for (const { fn } of listeners.filter((x) => !x.capture)) fn(e);
    return prevented;
  };
  return { press, calls };
}

test("Windows Iris switch and rail shortcuts reach commands; OS Alt+Tab and AltGr remain free", async () => {
  const map = await keys("win32"), h = harness(map, "win32");
  assert.equal(map.formatBinding(map.bindingOf("screen-toggle")), "Ctrl+`");
  assert.equal(h.press({ key: "`", code: "Backquote", ctrlKey: true }), true);
  assert.equal(h.press({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), true);
  h.press({ key: "ArrowLeft", ctrlKey: true, shiftKey: true });
  h.press({ key: "ArrowRight", ctrlKey: true, shiftKey: true });
  assert.deepEqual(h.calls, ["switch:1", "switch:-1", "rail:-1", "rail:1"]);
  assert.equal(h.press({ key: "Tab", code: "Tab", altKey: true }), false);
  assert.equal(h.press({ key: "Tab", code: "Tab", altKey: true, shiftKey: true }), false);
  assert.equal(map.matchBinding({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true, getModifierState: () => true }, map.bindingOf("md-quote")), false);
});

test("Windows terminal routing closes pane, renames, reloads app and preserves Ctrl+S / Ctrl+W", async () => {
  const map = await keys("win32"), h = harness(map, "win32", { terminal: true });
  h.press({ key: "w", ctrlKey: true, shiftKey: true });
  h.press({ key: "F2" });
  h.press({ key: "r", ctrlKey: true, shiftKey: true });
  assert.deepEqual(h.calls, ["pane", "rename", "app"]);
  assert.equal(h.press({ key: "s", ctrlKey: true }), false);
  assert.equal(h.press({ key: "w", ctrlKey: true }), false);
  assert.equal(h.press({ key: "r", ctrlKey: true }), false);
  assert.equal(h.press({ key: "F5" }), false);
});

test("Windows page reload and app reload agree in main and detached browser windows", async () => {
  const map = await keys("win32");
  for (const browser of [false, true]) {
    const h = harness(map, "win32", { browser });
    h.press({ key: "r", ctrlKey: true }); h.press({ key: "F5" }); h.press({ key: "r", ctrlKey: true, shiftKey: true });
    assert.deepEqual(h.calls, ["page", "page", "app"]);
  }
});

test("Darwin keeps rename Ctrl+Shift+R, Alt+Tab and does not consume F2", async () => {
  const map = await keys("darwin"), h = harness(map, "darwin");
  h.press({ key: "r", ctrlKey: true, shiftKey: true });
  assert.equal(h.press({ key: "F2" }), false);
  h.press({ key: "Tab", code: "Tab", altKey: true });
  assert.deepEqual(h.calls, ["rename", "switch:1"]);
});

test("Windows saved file restore deduplicates path variants, remaps active ID and preserves document data", () => {
  globalThis.acHost = { platform: "win32" };
  const doc = { id: "file:C:/WORK/report.docx", path: "C:/WORK/report.docx", kind: "docx", docxData: { dirty: true } };
  const tabs = [doc], reads = [], active = [], values = new Map([["ac.filetabs", JSON.stringify({ s: { files: ["C:/Work/a.md", "c:\\WORK\\a.md", "C:\\work\\report.docx"], active: "file:c:\\WORK\\a.md" } })], ["ac.centerspace", "s"]]);
  const restore = evaluate("web/js/center/tabs.js", "let fileTabsRestored", undefined, "restoreFileTabs", {
    localStorage: { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) }, spid: (k) => k, ensureTabSpace() {}, getTabs: () => tabs,
    fileKindOf: (p) => /docx$/.test(p), addTab: (_sp, t) => { tabs.push(t); return t; }, makeFileTab: (p) => ({ id: "file:" + p, kind: "file", path: p }),
    requestFileContent: (...args) => reads.push(args), trackFileWatch() {}, setActiveTab: (_sp, id) => active.push(id), setCenterSpace() {}, renderTabs() {}, showActiveTab() {},
  });
  restore(); restore();
  assert.equal(tabs.length, 2); assert.equal(reads.length, 1);
  assert.equal(active[0], "file:C:\\Work\\a.md"); assert.equal(tabs[0], doc); assert.equal(doc.docxData.dirty, true);
});

test("Windows xterm copies selected Ctrl+C, pastes Ctrl+V / Ctrl+Shift+V and leaves interrupt/save to shell", () => {
  globalThis.acHost = { platform: "win32" };
  let handler, selected = "", clipboard = "paste", sent = [];
  const xterm = { attachCustomKeyEventHandler: (fn) => { handler = fn; }, hasSelection: () => !!selected, getSelection: () => selected, paste: (s) => sent.push(["paste", s]) };
  vm.runInNewContext(sliceBetween(read("web/js/panel/xterm-wiring.js"), "  xterm.attachCustomKeyEventHandler", "  // 드래그 선택 시", "terminal-key-handler"), {
    xterm, isHostWindows: () => true, window: { acHost: { writeClipboard: (s) => sent.push(["copy", s]), readClipboard: () => clipboard } }, wsSend() {}, setTimeout() {},
  });
  const press = (key, shiftKey = false) => handler({ type: "keydown", key, ctrlKey: true, shiftKey, preventDefault() {} });
  assert.equal(press("c"), true); assert.equal(press("s"), true);
  selected = "selected";
  assert.equal(press("c"), false); assert.equal(press("c", true), false);
  assert.equal(press("v"), false); assert.equal(press("v", true), false);
  assert.deepEqual(sent, [["copy", "selected"], ["copy", "selected"], ["paste", "paste"], ["paste", "paste"]]);
  assert.equal(press("w", true), false);
  assert.equal(handler({ type: "keydown", key: "F2" }), false);
});

test("Windows path drop uses selected shell quotes, rejects expansion in cmd and does not paste after pane changes", async () => {
  const { insertDroppedPaths, quoteDroppedPath } = await import("../web/js/chatcopy/drop-path.js");
  const { setXterm } = await import("../web/js/panel/terminal.js");
  globalThis.acHost = { platform: "win32" };
  assert.equal(quoteDroppedPath("C:\\First Last\\O'Brien $x;.md", "powershell"), "'C:\\First Last\\O''Brien $x;.md'");
  assert.equal(quoteDroppedPath("C:\\First Last\\a&b.md", "cmd"), '"C:\\First Last\\a&b.md"');
  for (const p of ["C:\\%PATH%.md", "C:\\!x!.md", "C:\\x\n.md"]) assert.throws(() => quoteDroppedPath(p, "cmd"));
  const inserted = [], notices = [];
  setXterm({ paste: (s) => inserted.push(s), focus() {} });
  let pane = "one", shell = "powershell";
  const deps = { acHost: { getDroppedPath: (f) => f.path, terminalShell: async () => shell }, showToast: (s) => notices.push(s), getCurTarget: () => pane };
  await insertDroppedPaths([{ path: "C:\\First Last\\a.md" }, { path: "C:\\한글\\b.md" }], deps);
  assert.deepEqual(inserted, ["'C:\\First Last\\a.md' 'C:\\한글\\b.md' "]);
  shell = null; await insertDroppedPaths([{ path: "C:\\a.md" }], deps);
  assert.equal(inserted.length, 1); assert.match(notices.at(-1), /셸을 확인/);
  deps.acHost.terminalShell = async () => { pane = "two"; return "cmd"; };
  await insertDroppedPaths([{ path: "C:\\a.md" }], deps);
  assert.equal(inserted.length, 1); assert.match(notices.at(-1), /터미널이 바뀌/);
  globalThis.acHost = { platform: "darwin" }; pane = "one";
  await insertDroppedPaths([{ path: "/First Last/a.md" }], deps);
  assert.equal(inserted.at(-1), "/First Last/a.md ");
  setXterm(null);
});

test("native Windows webview relay sends pane/app/page actions and preserves Alt+Tab", () => {
  const appEvents = {}, sent = [], module = { exports: {} };
  vm.runInNewContext(read("native/electron/main-window.cjs"), { module, process: { platform: "win32" } });
  const contents = () => ({ handlers: {}, on(name, fn) { this.handlers[name] = fn; }, send: (_topic, name) => sent.push(name), setWindowOpenHandler() {} });
  class Window {
    constructor(opts) { this.options = opts; this.webContents = contents(); }
    on() {} isDestroyed() { return false; } loadURL() { return Promise.resolve(); }
    static fromWebContents(wc) { return wc.owner; }
  }
  const api = module.exports.createMainWindow({
    app: { on: (name, fn) => { appEvents[name] = fn; } }, BrowserWindow: Window,
    windowLayout: { applySavedBounds: () => null, ownWindowTitle() {}, trackWindowBounds() {} },
    markAppAlive() {}, appUrl: "http://localhost", console, setTimeout, clearTimeout,
  });
  api.createWindow();
  const win = api.getWindow();
  assert.equal(win.options.titleBarStyle, "default");
  const guest = contents(); guest.getType = () => "webview"; guest.hostWebContents = { owner: win };
  appEvents["web-contents-created"]({}, guest);
  const press = (props) => { let prevented = false; guest.handlers["before-input-event"]({ preventDefault: () => { prevented = true; } }, { type: "keyDown", ...props }); return prevented; };
  press({ key: "w", control: true, shift: true }); press({ key: "F2" });
  press({ key: "r", control: true }); press({ key: "F5" }); press({ key: "r", control: true, shift: true });
  press({ key: "`", code: "Backquote", control: true }); press({ key: "~", code: "Backquote", control: true, shift: true });
  assert.deepEqual(sent, ["close-pane", "rename-pane", "reload-tab", "reload-tab", "app-refresh", "screen-toggle", "screen-toggle-back"]);
  assert.equal(press({ key: "w", control: true, shift: true, isAutoRepeat: true }), true); assert.equal(sent.length, 7);
  assert.equal(press({ key: "Tab", code: "Tab", alt: true }), false);
  assert.equal(press({ key: "ArrowUp", control: true, alt: true }), false);
});

for (const newline of ["\n", "\r\n"]) test(`reload guidance smoke rejects losing Shift with ${newline === "\n" ? "LF" : "CRLF"} sources`, () => {
  const fixtureRead = (file) => read(file).replace(/\r?\n/g, newline);
  const source = fixtureRead("bin/smoke/sections/tool-screens.mjs").replace(/\r\n/g, "\n");
  const at = source.indexOf('check("다시 읽으라는 안내가 실제 조합과 같다"');
  const checkSource = source.slice(at, source.indexOf("\n});", at) + 4);
  const verify = (mutate) => vm.runInNewContext(checkSource, {
    check: (_name, fn) => fn(), sliceBetween,
    read: (file) => {
      const source = fixtureRead(file).replace(/\r\n/g, "\n");
      return file === "web/js/core/keynav.js" ? mutate(source) : source;
    },
  });
  assert.equal(verify((s) => s), true);
  assert.throws(() => verify((s) => s.replace('&& e.shiftKey && !e.altKey && k === "r") {\n      e.preventDefault();\n      try', '&& !e.altKey && k === "r") {\n      e.preventDefault();\n      try')), /앱 재로딩 조합 불일치/);
});

test("opening Windows path variants reuses the existing file and document IDs", () => {
  globalThis.acHost = { platform: "win32" };
  const doc = { id: "legacy-doc", path: "C:/WORK/report.docx", kind: "docx", docxData: { dirty: true } };
  const existing = { id: "legacy-file", path: "C:/WORK/a.md", kind: "file", content: "dirty buffer" }, tabs = [existing, doc], active = [], reads = [];
  const open = evaluate("web/js/center/file-routing.js", "export function openFileLocal", "export function openDocInSpaceBrowser", "openFileLocal", {
    getCenterSpace: () => "s", getSelectedSpaceId: () => "s", ensureTabSpace() {}, getTabs: () => tabs,
    addTab: (_sp, t) => tabs.push(t), makeFileTab: () => assert.fail("duplicate created"), requestFileContent: (p) => reads.push(p), trackFileWatch() {},
    setCenterSpace() {}, setActiveTab: (_sp, id) => active.push(id), renderTabs() {}, showActiveTab() {}, persistFileTabs() {}, syncWatchDirs() {}, window: { innerWidth: 1200 },
  });
  open("c:\\work\\a.md"); open("c:\\work\\report.docx");
  assert.deepEqual(active, ["legacy-file", "legacy-doc"]); assert.deepEqual(reads, []);
  assert.equal(existing.content, "dirty buffer"); assert.equal(doc.docxData.dirty, true);
});

test("static Windows labels and class adapt while Darwin DOM stays unchanged", async () => {
  const { applyHostUi } = await import("../web/js/core/host-ui.js");
  let classAdded = false;
  const attr = new Map([["title", "클릭 (⌘⇧E)"], ["placeholder", "Ctrl/⌘⇧S"]]);
  const text = { nodeValue: "Finder에서 파일을 끌어다 놓기", parentElement: { tagName: "DIV" } };
  const doc = { documentElement: { classList: { add: () => { classAdded = true; } } }, body: {}, querySelectorAll: () => [{ hasAttribute: (k) => attr.has(k), getAttribute: (k) => attr.get(k), setAttribute: (k, v) => attr.set(k, v) }], createTreeWalker: () => { let done = false; return { nextNode: () => done ? null : (done = true, text) }; } };
  globalThis.acHost = { platform: "darwin" }; applyHostUi(doc);
  assert.equal(classAdded, false); assert.equal(text.nodeValue, "Finder에서 파일을 끌어다 놓기");
  globalThis.acHost = { platform: "win32" }; applyHostUi(doc);
  assert.equal(classAdded, true); assert.equal(text.nodeValue, "탐색기에서 파일을 끌어다 놓기");
  assert.equal(attr.get("title"), "클릭 (Ctrl+Shift+E)"); assert.equal(attr.get("placeholder"), "Ctrl+Shift+S");
});
