import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as host from "../web/js/core/host-path.js";
import { openDroppedEntries } from "../web/js/center/file-drop.js";
import { terminalLinkSpans } from "../web/js/panel/xterm-wiring.js";
import { initFileRouting, openTerminalPath, openTerminalTarget, openTerminalLink, openDroppedLocal } from "../web/js/center/file-routing.js";
import { initFilePalette } from "../web/js/center/file-palette.js";
import { initBrowserState } from "../web/js/browser/state.js";
import { registerFileKind, clearFileKinds } from "../web/js/core/file-kinds.js";
import { replaceHerdrState } from "../web/js/herdr/state.js";

const windows = () => { globalThis.window = { acHost: { platform: "win32" }, innerWidth: 1200 }; };
const cells = (s) => [...s].map((ch, i) => ({ ch, x: i + 1, endX: i + 1, y: 1 }));

test("Windows drive and UNC normalization retains roots and rejects drive-relative input", () => {
  windows();
  for (const p of ["C:\\work\\a.js", "c:/work/a.js", "\\\\server\\share\\a.js", "//server/share/a.js"]) assert.equal(host.isAbsolutePath(p), true, p);
  for (const p of ["C:a.js", "\\work\\a.js", "\\\\server", "src\\a.js", "/work/a.js"]) assert.equal(host.isAbsolutePath(p), false, p);
  for (const p of ["C:\\work\\..\\a.js", "C:/work/./src/a.js", "C:\\..\\..\\a.js", "\\\\server\\share\\dir\\..\\a.js", "\\\\server\\share\\..\\a.js"]) {
    assert.equal(host.normalizePath(p), path.win32.normalize(p), p);
    assert.equal(host.pathDirname(p), path.win32.dirname(path.win32.normalize(p)), p);
  }
  assert.equal(host.pathDirname("C:\\a.js"), "C:\\");
  assert.equal(host.pathDirname("\\\\server\\share\\a.js"), "\\\\server\\share\\");
  assert.equal(host.pathBasename("C:\\work\\안내.md"), "안내.md");
  assert.equal(host.pathWithin("C:\\WORK", "c:/work/sub/a.js"), true);
  assert.equal(host.pathWithin("C:\\WORK", "c:/work-other/a.js"), false);
  assert.equal(host.pathWithin("\\\\server\\share", "\\\\SERVER\\other\\a.js"), false);
  assert.equal(host.pathWithin("C:\\work", "C:\\work\\..\\other\\a.js"), false);
});

test("Windows file URLs round trip spaces, Korean, percent, query and hash filename characters", () => {
  windows();
  for (const p of ["C:\\First Last\\한글#?%.md", "\\\\server\\share\\First Last\\한글#?%.pdf"]) {
    const url = host.toFileUrl(p);
    assert.equal(url, pathToFileURL(p, { windows: true }).href);
    assert.equal(host.fromFileUrl(url + "?view=1#part"), p);
  }
  assert.equal(host.fromFileUrl("file://localhost/C:/work/a.js"), "C:\\work\\a.js");
  assert.equal(host.fromFileUrl("file:///C:/work/%ZZ.md"), null);
  assert.equal(host.fromFileUrl("https://example.test/a.js"), null);
});

test("file drop accepts Windows absolute paths and refuses relative, directory and NUL input", () => {
  windows();
  const opened = [], notices = [];
  openDroppedEntries([{ path: "C:\\work\\a.js" }, { path: "\\\\server\\share\\a.md" }, { path: "C:a.js" }, { path: "src\\a.js" }, { path: "C:\\a\0.js" }, { error: "directory" }], (p) => opened.push(p), (m) => notices.push(m));
  assert.deepEqual(opened, ["C:\\work\\a.js", "\\\\server\\share\\a.md"]);
  assert.equal(notices.length, 4);
});

test("Windows terminal links retain complete drive, UNC, relative and markdown targets", () => {
  windows();
  for (const token of ["C:\\work\\한글.js:12", "c:/work/a.js:12", "\\\\server\\share\\a.md", "src\\a.js", "[안내](C:\\work\\a.md)"]) {
    const row = cells(token), links = terminalLinkSpans((y) => y === 1 ? row : null, 1);
    assert.equal(links.length, 1, token);
    assert.equal(links[0].text, token.startsWith("[") ? "C:\\work\\a.md" : token);
  }
});

test("terminal routing resolves Windows paths, enforces relative workspace boundary and converts browser URLs", () => {
  windows();
  const opened = [], urls = [], notices = [], mutations = [];
  initBrowserState({ BROWSER_MODE: false, wsSend: (m) => mutations.push(m) });
  initFilePalette({ esc: (s) => s, wsSend() {}, getLastAgents: () => [] });
  replaceHerdrState({ agents: [], workspaces: [{ id: "win", folder: "C:\\work" }] });
  initFileRouting({ $: () => ({ classList: { add() {}, remove() {} } }), showToast: (m) => notices.push(m), acHost: null,
    terminalBarePathToken: (s) => s, agentByPane: () => null, BROWSER_MODE: false,
    makeFileTab: (p) => ({ id: "file:" + p, path: p }), requestFileContent: (p) => opened.push(p), trackFileWatch() {},
    renderTabs() {}, showActiveTab() {}, persistFileTabs() {}, syncWatchDirs() {}, newBrowserTab: (url) => urls.push(url),
    getHostHome: () => "C:\\Users\\test", getCurTarget: () => null, getLastAgents: () => [], getSelectedSpaceId: () => "win" });
  openTerminalPath("src\\a.js:12");
  openTerminalTarget("D:\\other\\b.js");
  openTerminalPath("\\\\server\\share\\c.js");
  openTerminalLink("file:///C:/work/link.md");
  openTerminalPath("~\\notes\\d.md");
  assert.deepEqual(opened, ["C:\\work\\src\\a.js", "D:\\other\\b.js", "\\\\server\\share\\c.js", "C:\\work\\link.md", "C:\\Users\\test\\notes\\d.md"]);
  openTerminalPath("..\\other\\outside.js");
  openTerminalPath("C:relative.js");
  assert.equal(opened.length, 5);
  assert.equal(notices.length, 2);
  const count = opened.length, urlCount = urls.length;
  registerFileKind({ id: "docx-test", test: (p) => /\.docx$/.test(p) });
  for (const ext of ["pdf", "docx", "png"]) openTerminalPath(`..\\other\\outside.${ext}`);
  assert.equal(opened.length, count);
  assert.equal(urls.length, urlCount);
  assert.equal(mutations.length, 0);
  assert.equal(notices.filter((m) => m.includes("작업 폴더 밖")).length, 4);
  openTerminalPath("src\\inside.pdf");
  assert.equal(urls.at(-1), "file:///C:/work/src/inside.pdf");
  openTerminalPath("src\\inside.docx");
  assert.equal(mutations.at(-1).mutation.path, "C:\\work\\src\\inside.docx");
  openTerminalPath("src\\inside.png");
  assert.equal(notices.at(-1).includes("탐색기"), true);
  clearFileKinds();
  openDroppedLocal("C:\\work\\First Last.pdf");
  assert.equal(urls.at(-1), "file:///C:/work/First%20Last.pdf");
});

test("missing or Darwin bridge preserves POSIX path and drop behavior", () => {
  for (const acHost of [undefined, { platform: "darwin" }]) {
    globalThis.window = { acHost };
    assert.equal(host.isHostWindows(), false);
    assert.equal(host.pathBasename("/work/a.md"), "a.md");
    assert.equal(host.isAbsolutePath("C:\\work\\a.md"), false);
    assert.equal(host.toFileUrl("/work/First Last.md"), "file:///work/First%20Last.md");
    assert.equal(host.fromFileUrl("file:///work/a.md#part"), "/work/a.md");
    const opened = [];
    openDroppedEntries([{ path: "/work/a.md" }, { path: "C:\\work\\a.md" }], (p) => opened.push(p), () => {});
    assert.deepEqual(opened, ["/work/a.md"]);
  }
});
