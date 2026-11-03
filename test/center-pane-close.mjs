import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as tabs from "../web/js/center/tab-store.js";
import * as panes from "../web/js/center/pane-store.js";
import * as paths from "../web/js/core/host-path.js";

const source = readFileSync(new URL("../web/js/center/tab-close.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/\bexport /g, "");
let seq = 0;
function harness(extra = []) {
  for (const oldSpace of tabs.getTabSpaces()) tabs.replaceTabs(oldSpace, []);
  const space = `close-${++seq}`;
  const file = { id: "file:/a.txt", kind: "file", path: "/a.txt", label: "a.txt", draft: "edited" };
  tabs.replaceTabs(space, [file, ...extra]); tabs.setCenterSpace(space); tabs.setActiveTab(space, file.id);
  assert.equal(panes.paneSplit(space, tabs.getTabs(space), file.id, () => true), true);
  const calls = [], dialogs = [], events = new Map(), strip = { dataset: { pane: "0" }, addEventListener: (name, fn) => events.set(name, fn) };
  let menu;
  const document = {
    activeElement: { focus() {} }, body: { appendChild: wrap => dialogs.push(wrap) },
    createElement: () => ({ addEventListener(name, fn) { this[name] = fn; }, remove() {}, querySelector: () => ({ focus() {} }) }),
  };
  const api = vm.runInNewContext(source + "\n({initTabClose,bindTabCloseTextEditor,closeTabs,removeTabsNow,closeActiveTab,closeAllTabs,retargetFileTabs});", {
    ...paths, ...tabs, ...panes, document, callHook: name => { calls.push(name); },
    getWebview: () => null, removeDiscardedWebview() {}, removeWebviewLastUsed() {}, removeWebviewStatus() {},
    noteClosedCenterTab: (_space, tab) => calls.push(`closed:${tab.id}`), setBrowserActiveTab() {}, bsMutate() {},
  });
  api.initTabClose({
    esc: x => x, showToast: message => calls.push(message), tabstrip: strip, BROWSER_MODE: false,
    isFileLikeKind: kind => kind === "file", tabIoRegistry: new Map(),
    renderTabs() {}, showActiveTab() {}, persistFileTabs() {}, syncWatchDirs() {}, scheduleWebviewThrottling() {},
    untrackFileWatch: () => calls.push("untrack"), trackFileWatch() {},
    openFileCtx: (_x, _y, _p, _d, items) => { menu = items; }, showCtx: (_x, _y, items) => { menu = items; },
  });
  api.bindTabCloseTextEditor({
    isTextTabDirty: tab => tab.draft != null, saveFileTab: async tab => { tab.draft = null; },
    disposeClosedFileModel: () => calls.push("dispose"),
    getMonacoModels: () => new Map(), getMonacoViewState: () => new Map(), getMonacoEditor: () => null,
  });
  const choose = choice => dialogs.at(-1).click({ target: { closest: () => ({ dataset: { act: choice } }) } });
  const target = pane => ({ space, tabRef: file, tabId: file.id, pane });
  return { api, space, file, calls, dialogs, choose, target, events, strip, getMenu: () => menu };
}

test("공유 수정본은 한 칸에서만 닫고 마지막 닫기의 취소는 보존", async () => {
  const h = harness();
  await h.api.closeTabs([h.target(0)]);
  assert.equal(h.dialogs.length, 0);
  assert.equal(tabs.getTabs(h.space)[0], h.file);
  assert.equal(panes.paneLayout(h.space), null);
  assert.equal(h.calls.includes("untrack"), false);
  assert.equal(h.calls.includes("dispose"), false);
  const pending = h.api.closeTabs([h.target(0)]);
  assert.equal(h.dialogs.length, 1); h.choose("cancel"); await pending;
  assert.equal(tabs.getTabs(h.space)[0], h.file);
  const final = h.api.closeTabs([h.target(0)]); h.choose("discard"); await final;
  assert.deepEqual(tabs.getTabs(h.space), []);
  assert.equal(h.calls.filter(x => x === "untrack").length, 1);
  assert.equal(h.calls.filter(x => x === "dispose").length, 1);
});

test("한 칸 모두 닫기는 접힌 뒤에도 다른 칸의 공유 탭을 보존", async () => {
  const other = { id: "file:/b.txt", kind: "file", path: "/b.txt" };
  const h = harness([other]);
  await h.api.closeTabs([{ space: h.space, tabRef: other, pane: 0 }, h.target(0), h.target(0)]);
  assert.deepEqual(tabs.getTabs(h.space).map(t => t.id), [h.file.id]);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.calls.filter(x => x === "untrack").length, 1);
  assert.equal(panes.paneLayout(h.space), null);
});

test("양쪽 소속을 닫는 배치는 수정본을 한 번 확인하고 최종 해제", async () => {
  const h = harness();
  const pending = h.api.closeTabs([h.target(0), h.target(1)]);
  assert.equal(h.dialogs.length, 1); h.choose("save"); await pending;
  assert.deepEqual(tabs.getTabs(h.space), []);
  assert.equal(h.calls.filter(x => x === "dispose").length, 1);
});

test("외부 전체 닫기 요청은 공유 소속이 있어도 저장 확인과 전체 제거", async () => {
  const h = harness();
  const target = h.target(0); delete target.pane;
  const pending = h.api.closeTabs([target]);
  assert.equal(h.dialogs.length, 1); h.choose("discard"); await pending;
  assert.deepEqual(tabs.getTabs(h.space), []);
});

test("공유 탭 메뉴·닫기 버튼은 포커스와 관계없이 해당 탭 줄의 칸", async () => {
  for (const action of ["menu", "button"]) {
    const h = harness([{ id: "file:/local.txt", kind: "file", path: "/local.txt" }]); panes.paneFocus(h.space, 1);
    if (action === "menu") {
      h.events.get("contextmenu")({ target: { closest: () => ({ dataset: { tab: h.file.id } }) }, preventDefault() {}, stopPropagation() {} });
      await h.getMenu().find(item => item.label === "탭 닫기").act();
    } else {
      h.events.get("click")({ target: { closest: selector => selector === ".cclose" ? { dataset: { close: h.file.id } } : null }, stopPropagation() {} });
      await Promise.resolve();
    }
    assert.equal(h.dialogs.length, 0);
    assert.equal(tabs.getTabs(h.space)[0], h.file);
    assert.equal(panes.paneLayout(h.space).panes[0].ids.has(h.file.id), false);
    assert.equal(panes.paneLayout(h.space).panes[1].ids.has(h.file.id), true);
  }
});

test("활성 탭 닫기는 포커스 칸의 소속만 제거", async () => {
  const h = harness(); panes.paneFocus(h.space, 1);
  await h.api.closeActiveTab(); await Promise.resolve();
  assert.equal(h.dialogs.length, 0);
  assert.equal(tabs.getTabs(h.space)[0], h.file);
  assert.equal(panes.paneLayout(h.space), null);
});

test("이름 변경은 양쪽 편집기에 같은 새 모델과 각 칸의 커서 상태 복원", () => {
  const h = harness(), disposed = [], oldModel = { getValue: () => "edited", dispose: () => disposed.push("old") };
  const models = new Map([[h.file.path, oldModel]]), states = new Map([[`0\0${h.file.path}`, { scrollTop: 10 }], [`1\0${h.file.path}`, { scrollTop: 30 }]]);
  const editors = [0, 1].map(index => ({ model: oldModel, getModel() { return this.model; }, saveViewState: () => ({ cursor: index }), setModel(model) { this.model = model; }, restoreViewState(state) { this.restored = state; } }));
  const replacement = {};
  h.api.bindTabCloseTextEditor({ getMonacoModels: () => models, getMonacoViewState: () => states, getMonacoEditor: index => editors[index],
    getMonacoRuntime: () => ({ editor: { createModel: () => replacement }, Uri: { file: x => x } }), monacoLangFor: () => "text" });
  h.api.retargetFileTabs("/a.txt", "/renamed.txt");
  assert.equal(editors[0].model, replacement); assert.equal(editors[1].model, replacement);
  assert.deepEqual(editors[0].restored, { cursor: 0 }); assert.deepEqual(editors[1].restored, { cursor: 1 });
  assert.equal(states.has("0\0/a.txt"), false); assert.equal(states.has("1\0/a.txt"), false);
  assert.deepEqual(states.get("0\0/renamed.txt"), { cursor: 0 }); assert.deepEqual(states.get("1\0/renamed.txt"), { cursor: 1 });
  assert.deepEqual(disposed, ["old"]);
  assert.equal(panes.paneLayout(h.space).panes.every(p => p.ids.has("file:/renamed.txt")), true);
});
