import { registerTabView } from "../web/js/core/tab-views.js";
import { sliceBetween, sliceFrom } from "../bin/slice-anchor.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { addTab, getActiveTabId, getCenterSpace, getCurrentTabs, getTabs, isTabVisible, replaceTabs, setActiveTab, setCenterSpace } from "../web/js/center/tab-store.js";
import { paneActives, paneFocus, paneMove, paneRemove, paneTakeCollapsed, paneLayout, paneRestore, paneSnapshot, paneSync, paneSplit, paneTabs } from "../web/js/center/pane-store.js";
const source = readFileSync(new URL("../web/js/center/tabs.js", import.meta.url), "utf8");
function body(name, until) {
  return sliceBetween(source, `export function ${name}`, until).replace('export ', '');
}
let seq = 0;
function harness() {
  const space = `render-${++seq}`;
  const tabs = [{ id: "f", kind: "file", label: "a.txt" }, { id: "b", kind: "browser", label: "site" }];
  replaceTabs(space, tabs); setCenterSpace(space); setActiveTab(space, "f");
  const fileview = { hidden: true, dataset: {} }, browserview = { hidden: true, dataset: {} }, centerEmpty = { hidden: false };
  const calls = [];
  const files = [0, 1].map(() => ({ hidden: true, dataset: {} }));
  const notices = [0, 1].map(() => ({ hidden: true }));
  const shared = { hidden: true, dataset: {} };
  const values = {
    BROWSER_MODE: false, callHook() {}, cancelPendingReveal() {}, getCenterSpace, curTabs: getCurrentTabs, paneActives, paneLayout,
    filePane: index => files[index], paneNotices: () => notices, preserveRemainingPane() {}, keepAwakeMark: () => "",
    fileview, browserview, centerEmpty, paintCenterEmptyTitle() {}, tabViews: () => [{ panelId: "shared" }], tabViewOf: kind => kind === "diff" ? { panelId: "shared", render: t => calls.push(`diff:${t.id}`) } : null,
    ensureTabViewPane: () => shared, isFileLikeKind: kind => kind === "file", tabNeedsContent: () => false,
    withFileViewTransition: (tab, options, draw) => { calls.push(tab?.id || null); draw(1); },
    renderFileViewBody: tab => calls.push(`file:${tab.id}`), startPendingReveal() {}, updateActiveWebview: () => calls.push("browser"),
    syncPaneView() {}, schedulePaneLayout() {},
  };
  const show = vm.runInNewContext(body("showActiveTab", "// 파일 탭을 만드는 유일한 곳") + '\nshowActiveTab;', values);
  return { space, tabs, show, fileview, files, notices, shared, browserview, centerEmpty, calls };
}
test("파일 | 브라우저 두 본문은 포커스 전환 뒤에도 함께 표시", () => {
  const h = harness(); paneSplit(h.space, h.tabs, "b"); h.show();
  assert.equal(h.files[0].hidden, false); assert.equal(h.browserview.hidden, false);
  assert.equal(h.files[0].dataset.pane, "0"); assert.equal(h.browserview.dataset.pane, "1");
  assert.equal(h.centerEmpty.hidden, true);
  paneFocus(h.space, 0); h.show();
  assert.equal(h.browserview.hidden, false); assert.equal(isTabVisible(h.space, "b"), true);
  assert.equal(h.calls.filter(x => x === "file:f").length, 2);
  assert.equal(h.calls.filter(x => x === "browser").length, 2);
});
test("텍스트 파일을 분할하면 같은 파일의 칸별 지면을 동시에 표시", () => {
  const h = harness(); paneSplit(h.space, h.tabs, "f", true); h.show();
  assert.equal(h.files[0].hidden, false); assert.equal(h.files[1].hidden, false);
  assert.equal(h.files[0].dataset.pane, "0"); assert.equal(h.files[1].dataset.pane, "1");
  assert.equal(h.calls.filter(x => x === "file:f").length, 2);
});
test("같은 panelId와 브라우저 화면은 포커스 칸만 차지하고 다른 칸에 안내", () => {
  for (const kind of ["diff", "browser"]) {
    const h = harness();
    const tabs = [{ id: "a", kind }, { id: "b", kind }];
    replaceTabs(h.space, tabs); setActiveTab(h.space, "a"); paneSplit(h.space, tabs, "b");
    h.show();
    const panel = kind === "browser" ? h.browserview : h.shared;
    assert.equal(panel.dataset.pane, "1"); assert.equal(h.notices[0].hidden, false);
    assert.equal(h.notices[1].hidden, true);
    paneFocus(h.space, 0); h.show();
    assert.equal(panel.dataset.pane, "0"); assert.equal(h.notices[1].hidden, false);
    assert.equal(h.notices[0].hidden, true);
  }
});
test("분할 전에는 활성 종류만 표시, 빈 스페이스에는 안내 표시", () => {
  const h = harness(); h.show(); assert.equal(h.browserview.hidden, true);
  setActiveTab(h.space, "b"); h.show(); assert.equal(h.files[0].hidden, true);
  replaceTabs(h.space, []); setActiveTab(h.space, null); h.show();
  assert.equal(h.centerEmpty.hidden, false); assert.equal(h.browserview.hidden, true);
});
test("tab-store의 보이는 브라우저가 비포커스여도 webview 대상 유지", () => {
  const h = harness(); paneSplit(h.space, h.tabs, "b"); paneFocus(h.space, 0);
  const text = readFileSync(new URL("../web/js/browser/webview.js", import.meta.url), "utf8");
  const chunk = sliceBetween(text, 'export function activeBrowserId()', 'export function activeWv()').replace('export ', '');
  const active = vm.runInNewContext(chunk + '\nactiveBrowserId;', { BROWSER_MODE: false, paneActives, paneLayout, getCenterSpace, getCurrentTabs });
  assert.equal(active(), "b");
});
test("칸별 탭 줄은 자기 종류·활성 탭만 그림", () => {
  const h = harness(); addTab(h.space, { id: "c", kind: "browser", label: "second" });
  paneSplit(h.space, getTabs(h.space), "b");
  paneMove(h.space, getTabs(h.space), "c", 1, 0);
  const rows = [0, 1].map(() => ({ strip: { innerHTML: "" }, kinds: {} }));
  const render = vm.runInNewContext(body("renderTabs", 'function preserveRemainingPane') + '\nrenderTabs;', {
    BROWSER_MODE: false, callHook() {}, getCenterSpace, getBrowserState: () => ({ docked: true }),
    curTabs: getCurrentTabs, paneLayout, paneActives, paneTabs, paneSync() {}, paneRows: () => rows, syncPaneView() {},
    preserveRemainingPane() {}, lastByKind: new Map(), tabGroup: t => t.kind === 'browser' ? 'browser' : 'file', renderKindBar() {},
    isTabDirty: () => false, esc: x => x, aiBusyLabels: () => [], keepAwakeMark: () => "", TAB_KIND: {}, TAB_CLOSE: '',
    revealActiveTab() {}, syncAiGlow() {}, updateCenterVisibility() {},
    setHtml: (el, html) => { el.innerHTML = html; return true; },
  });
  render();
  assert.match(rows[0].strip.innerHTML, /data-tab="f"/); assert.doesNotMatch(rows[0].strip.innerHTML, /data-tab="b"/);
  assert.match(rows[1].strip.innerHTML, /data-tab="b"/); assert.match(rows[1].strip.innerHTML, /data-tab="c"/);
  assert.doesNotMatch(rows[1].strip.innerHTML, /data-tab="f"/);
});
test("탭 메뉴의 다른 탭 모두 닫기와 모두 닫기는 해당 칸에 한정", () => {
  const h = harness(); addTab(h.space, { id: "c", kind: "browser" }); paneSplit(h.space, getTabs(h.space), "b"); paneMove(h.space, getTabs(h.space), "c", 1, 0);
  const text = readFileSync(new URL("../web/js/center/tab-close.js", import.meta.url), "utf8");
  const chunk = sliceBetween(text, 'function snapshotCloseTarget', 'function resolveLiveCloseTargets') + sliceFrom(text, 'export function closeAllTabs', text.length).replace(/export /g, '');
  const events = new Map(), strip = { closest: () => ({ dataset: { pane: "1" } }), addEventListener: (name, fn) => events.set(name, fn) };
  let menu, closed;
  const closeEvents = [];
  const wire = vm.runInNewContext(chunk + '\nwireTabStrip;', {
    BROWSER_MODE: false, getCenterSpace, getCurrentTabs, getTabs, getBrowserState: () => ({ tabsBySpace: {} }), paneTabs, paneLayout,
    paneIndex: (space, id) => paneLayout(space).panes.findIndex(p => p.ids.has(id)),
    isTabDirty: tab => tab.id === "b", isFileLikeKind: () => false, callHook: () => [],
    showToast: message => closeEvents.push(message),
    closeTabs: targets => { closed = targets; closeEvents.push("close"); }, showCtx: (_x, _y, items) => { menu = items; },
  });
  wire(strip);
  events.get('contextmenu')({ target: { closest: () => ({ dataset: { tab: 'b' } }) }, preventDefault() {}, stopPropagation() {} });
  menu.find(item => item.label === '다른 탭 모두 닫기').act();
  assert.deepEqual(closed.map(t => t.tabId), ['c']);
  closeEvents.length = 0;
  menu.find(item => item.label === '모두 닫기').act();
  assert.deepEqual(closed.map(t => t.tabId), ['b', 'c']);
  assert.deepEqual(closeEvents, ['저장하지 않은 편집이 1개 있습니다', 'close']);
});
test("포인터 이동 문턱 전에는 덮개를 만들지 않고 클릭을 유지", () => {
  const text = readFileSync(new URL("../web/js/centersplit/boot.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const h = harness(), handlers = new Map(), docEvents = new Map();
  const center = { dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000 }) };
  const strip = { addEventListener: (name, fn) => handlers.set(name, fn) };
  const chip = { dataset: { tab: 'b' } };
  let drag, renders = 0;
  const ready = vm.runInNewContext(text + '\nstripReady;', {
    getCenterSpace, getTabs, paneLayout, paneMove: (space, tabs, id, target) => target === 1 && paneSplit(space, tabs, id),
    beginDrag: options => { drag = options; }, renderTabs: () => { renders++; }, showActiveTab() {}, persistFileTabs() {},
    document: { getElementById: () => center, addEventListener: (name, fn) => docEvents.set(name, fn), removeEventListener: name => docEvents.delete(name) },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  ready(strip, 0);
  handlers.get('mousedown')({ button: 0, clientX: 10, clientY: 10, target: { closest: s => s === '.ctab' ? chip : null } });
  docEvents.get('mousemove')({ buttons: 1, clientX: 12, clientY: 10 });
  assert.equal(drag, undefined);
  docEvents.get('mouseup')(); assert.equal(docEvents.size, 0);
  handlers.get('mousedown')({ button: 0, clientX: 10, clientY: 10, target: { closest: s => s === '.ctab' ? chip : null } });
  docEvents.get('mousemove')({ buttons: 1, clientX: 750, clientY: 30 });
  assert.ok(drag); assert.equal(center.dataset.splitDrop, '1');
  drag.onEnd();
  assert.equal(renders, 1); assert.deepEqual(paneActives(h.space), ['f', 'b']);
  assert.equal(center.dataset.splitDrop, undefined);
});
test("파일 복원과 첫 브라우저 상태가 모두 준비된 뒤에만 칸 저장", () => {
  for (const browserFirst of [false, true]) {
    const space = `storage-${++seq}`; replaceTabs(space, []); setCenterSpace(space);
    const saved = { ratio: 0.64, focus: 0, right: ['b'], rightActive: 'b', leftActive: 'file:/f' };
    const values = new Map([['ac.filetabs', JSON.stringify({ s: { files: ['/f'], active: 'file:/f' } })], ['ac.centerpanes', JSON.stringify({ s: saved })]]);
    const writes = [];
    const api = vm.runInNewContext(sliceFrom(source, 'let fileTabsRestored', source.length).replace(/export /g, '') + '\n({restoreFileTabs,noteBrowserPanesReady,persistCenterPanes});', {
      BROWSER_MODE: false, callHook: () => true, localStorage: { getItem: k => values.get(k), setItem: (k,v) => { writes.push(k); values.set(k,v); } },
      spid: () => space, spk: () => 's', getTabSpaces: () => [space], getCenterSpace, getTabs, setActiveTab, setCenterSpace,
      paneLayout, paneRestore, paneSnapshot, paneSync, ensureTabSpace() {}, addTab, isHostWindows: () => false, fileKindOf: () => null,
      makeFileTab: p => ({ id: `file:${p}`, kind: 'file', path: p }), requestFileContent() {}, trackFileWatch() {}, renderTabs() {}, showActiveTab() {},
    });
    api.persistCenterPanes(); assert.deepEqual(writes, []);
    if (browserFirst) { addTab(space, { id: 'b', kind: 'browser' }); api.noteBrowserPanesReady(); }
    else api.restoreFileTabs();
    api.persistCenterPanes(); assert.deepEqual(writes, []);
    if (browserFirst) api.restoreFileTabs();
    else { addTab(space, { id: 'b', kind: 'browser' }); api.noteBrowserPanesReady(); }
    api.persistCenterPanes();
    const restored = JSON.parse(values.get("ac.centerpanes")).s;
    assert.deepEqual(restored.panes.map(p => p.ids), [["file:/f"], ["b"]]);
    assert.deepEqual(restored.panes.map(p => p.active), [saved.leftActive, saved.rightActive]);
    assert.equal(restored.focus, saved.focus); assert.equal(restored.ratio, saved.ratio);
    assert.equal(paneLayout(space).ratio, 0.64);
  }
});
test("파일 탭 복원 전에는 저장하지 않아 저장된 파일 탭을 지우지 않음", () => {
  const space = `persist-${++seq}`; replaceTabs(space, []); setCenterSpace(space);
  const values = new Map([['ac.filetabs', JSON.stringify({ s: { files: ['/f'], active: 'file:/f' } })]]);
  const api = vm.runInNewContext(sliceFrom(source, 'export function persistFileTabs', source.length).replace(/export /g, '') + '\n({persistFileTabs,restoreFileTabs});', {
    BROWSER_MODE: false, callHook: (name) => name === 'split.enabled', localStorage: { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) },
    spid: () => space, spk: () => 's', getTabSpaces: () => [space], getCenterSpace, getTabs, getActiveTabId, setActiveTab, setCenterSpace,
    paneLayout, paneRestore, paneSnapshot, paneSync, ensureTabSpace() {}, addTab, isHostWindows: () => false, fileKindOf: () => null, samePath: (a, b) => a === b,
    makeFileTab: p => ({ id: `file:${p}`, kind: 'file', path: p }), requestFileContent() {}, trackFileWatch() {}, renderTabs() {}, showActiveTab() {},
  });
  api.persistFileTabs();
  assert.deepEqual(JSON.parse(values.get('ac.filetabs')).s.files, ['/f']);
  api.restoreFileTabs(); api.persistFileTabs();
  assert.deepEqual(JSON.parse(values.get('ac.filetabs')).s.files, ['/f']);
});
test("도킹 중 가운데에서 연 표·문서 탭도 저장·복원하고 분리 창은 저장하지 않음", () => {
  const load = (space, values, browserMode) => vm.runInNewContext(sliceFrom(source, 'export function persistFileTabs', source.length).replace(/export /g, '') + '\n({persistFileTabs,restoreFileTabs});', {
    BROWSER_MODE: browserMode, callHook: (name, t) => name === 'viewer.presentsTab' && !!t?.sheetMode, isFileLikeKind: k => k === 'file' || k === 'docx',
    localStorage: { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) },
    spid: () => space, spk: () => 's', getTabSpaces: () => [space], getCenterSpace, getTabs, getActiveTabId, setActiveTab, setCenterSpace,
    paneLayout, paneRestore, paneSnapshot, paneSync, ensureTabSpace() {}, addTab, isHostWindows: () => false, samePath: (a, b) => a === b,
    fileKindOf: p => /\.(xlsx|docx)$/.test(p) ? {} : null,
    makeFileTab: p => ({ id: `file:${p}`, kind: p.endsWith('.docx') ? 'docx' : 'file', path: p, sheetMode: p.endsWith('.xlsx') }),
    requestFileContent() {}, trackFileWatch() {}, renderTabs() {}, showActiveTab() {},
  });
  const space = `docs-${++seq}`, values = new Map([['ac.filetabs', '{}']]);
  replaceTabs(space, [{ id: 'file:/f', kind: 'file', path: '/f' }, { id: 'file:/b.xlsx', kind: 'file', path: '/b.xlsx', sheetMode: true },
    { id: 'file:/d.docx', kind: 'docx', path: '/d.docx' }]);
  setCenterSpace(space); setActiveTab(space, 'file:/b.xlsx');
  const main = load(space, values, false); main.restoreFileTabs(); main.persistFileTabs();
  const saved = JSON.parse(values.get('ac.filetabs')).s;
  assert.deepEqual(saved.files, ['/f']); assert.deepEqual(saved.docs, ['/b.xlsx', '/d.docx']); assert.equal(saved.active, 'file:/b.xlsx');
  const before = values.get('ac.filetabs'), detached = load(space, values, true);
  detached.restoreFileTabs(); replaceTabs(space, []); detached.persistFileTabs();
  assert.equal(values.get('ac.filetabs'), before);
  const fresh = `docs-${++seq}`; replaceTabs(fresh, []); setCenterSpace(fresh);
  load(fresh, values, false).restoreFileTabs();
  assert.deepEqual(getTabs(fresh).map(t => t.id), ['file:/f', 'file:/b.xlsx', 'file:/d.docx']);
  assert.equal(getActiveTabId(fresh), 'file:/b.xlsx');
});

test("안내가 보이는 단일 화면 탭은 비동기 응답의 렌더 대상에서 제외", () => {
  registerTabView({ kind: "shared-test", panelId: "test-shared" });
  for (const kind of ["browser", "shared-test"]) {
    const h = harness(), tabs = [{ id: "a", kind }, { id: "b", kind }];
    replaceTabs(h.space, tabs); setActiveTab(h.space, "a"); paneSplit(h.space, tabs, "b");
    assert.equal(isTabVisible(h.space, "a"), false); assert.equal(isTabVisible(h.space, "b"), true);
    paneFocus(h.space, 0);
    assert.equal(isTabVisible(h.space, "a"), true); assert.equal(isTabVisible(h.space, "b"), false);
  }
});

test("렌더 소유자와 토큰은 칸별이며 오래된 비동기 렌더는 거절", () => {
  const h = harness(); paneSplit(h.space, h.tabs, "f", true);
  const api = vm.runInNewContext('let renderedFileOwner = null, renderedFileToken = 0, fileViewTokenSeq = 0; const renderedFiles = [{owner:null,token:0},{owner:null,token:0}];\n'
    + sliceBetween(source, 'export function withFileViewTransition', 'export function switchCenterSpace').replace(/export /g, '')
    + '\n({withFileViewTransition,getRenderedFileOwner,getRenderedFileToken});', {
      paneIndex: () => paneLayout(h.space).focus, paneLayout, getCenterSpace,
      isFileLikeKind: kind => kind === 'file', callHook() {},
    });
  const tab = h.tabs[0];
  api.withFileViewTransition(tab, { pane: 0 }, () => {});
  const leftToken = api.getRenderedFileToken(0);
  api.withFileViewTransition(tab, { pane: 1 }, () => {});
  assert.equal(api.getRenderedFileOwner(0), tab); assert.equal(api.getRenderedFileOwner(1), tab);
  assert.equal(api.getRenderedFileToken(0), leftToken);
  assert.notEqual(api.getRenderedFileToken(1), leftToken);
  assert.equal(api.withFileViewTransition(tab, { pane: 1, expectedToken: leftToken }, () => assert.fail('오래된 렌더 실행')), false);
});
test("종류 선택은 혼합 칸의 실제 소속에 따라 양쪽 버튼을 활성화", () => {
  const kindBar = { hidden: true, innerHTML: '' };
  const render = vm.runInNewContext(sliceBetween(source, 'function renderKindBar', 'export function renderTabs') + '\nrenderKindBar;', {
    KIND_PICKS: [['file','파일'],['browser','브라우저']], TAB_KIND: {}, tabGroup: t => t.kind === 'browser' ? 'browser' : 'file',
  });
  render(kindBar, true, [{kind:'file'},{kind:'browser'}], 'file');
  assert.doesNotMatch(kindBar.innerHTML, / disabled/);
  render(kindBar, true, [{kind:'file'}], 'file');
  assert.match(kindBar.innerHTML, /data-kind-pick="browser"[^>]* disabled/);
});

test("단일 화면 충돌 중 탭 줄 포커스만 옮겨도 실제 화면 소유자를 갱신", () => {
  const h = harness(), tabs = [{ id: "a", kind: "browser" }, { id: "b", kind: "browser" }];
  replaceTabs(h.space, tabs); setActiveTab(h.space, "a"); paneSplit(h.space, tabs, "b"); h.show();
  const refresh = vm.runInNewContext(sliceBetween(source, 'function refreshPaneFocus', 'function wireStrip') + '\nrefreshPaneFocus;', {
    getCenterSpace, paneActives, isTabVisible, showActiveTab: h.show, persistFileTabs() {},
  });
  paneFocus(h.space, 0); refresh();
  assert.equal(h.browserview.dataset.pane, "0"); assert.equal(h.notices[1].hidden, false);
});

test("텍스트와 표를 함께 볼 때 표 탭 조회는 먼저 열린 텍스트를 건너뜀", () => {
  const text = readFileSync(new URL("../web/js/sheet/render.js", import.meta.url), "utf8");
  const tabs = [{ id: "text", kind: "file" }, { id: "sheet", kind: "file", sheetMode: true, sheet: {} }];
  const current = vm.runInNewContext(sliceBetween(text, 'export const svTab', '// ── 그리기').replace('export ', '') + '\nsvTab;', {
    getCenterSpace: () => 's', getCurrentTabs: () => tabs, isTabVisible: () => true,
  });
  assert.equal(current(), tabs[1]);
});
test("표 단축키는 다른 칸의 편집기와 주소 입력을 처리하지 않음", () => {
  const text = readFileSync(new URL("../web/js/sheet/events.js", import.meta.url), "utf8");
  const start = text.indexOf('document.addEventListener("keydown", (e) => {');
  const end = text.indexOf('    if (!fileview.contains(document.activeElement)', start);
  const sheet = { sheet: {} }, other = {}, calls = [];
  let active = other, handler;
  vm.runInNewContext(text.slice(start, end) + '\n});', {
    document: { addEventListener: (_name, fn) => { handler = fn; } }, svTab: () => sheet, currentTab: () => active,
    fileview: { contains: el => !!el.inSheet }, svSave: () => calls.push('save'), svUndo: () => calls.push('undo'),
  });
  const input = { tagName: 'INPUT', blur: () => calls.push('blur') };
  const event = { target: input, metaKey: true, key: 'z', preventDefault: () => calls.push('prevent') };
  handler(event); assert.deepEqual(calls, []);
  active = sheet; handler(event); assert.deepEqual(calls, []);
  input.inSheet = true; handler(event); assert.deepEqual(calls, ['prevent', 'undo', 'blur']);
});

test("왼쪽 빈 칸을 닫으면 남은 오른쪽 편집 상태를 한 번만 이전", () => {
  const h = harness(); paneSplit(h.space, h.tabs, "f", true);
  paneMove(h.space, h.tabs, "b", 1, 0);
  paneRemove(h.space, "f", 0);
  const transfers = [];
  const preserve = vm.runInNewContext(sliceBetween(source, 'function preserveRemainingPane', 'export function showActiveTab') + '\npreserveRemainingPane;', {
    paneTakeCollapsed, transferFilePane: from => transfers.push(from),
  });
  preserve(h.space); preserve(h.space);
  assert.deepEqual(transfers, [1]); assert.equal(paneLayout(h.space), null);
});
test("centersplit을 끄면 저장된 분할을 읽거나 지우지 않음", () => {
  const accesses = [];
  const api = vm.runInNewContext('let fileTabsRestored=true,browserPanesReady=true,centerPanesRestored=false;\n'
    + sliceFrom(source, 'function restoreCenterPanes', source.length) + '\n({restoreCenterPanes,persistCenterPanes});', {
      BROWSER_MODE: false, callHook: () => false,
      localStorage: { getItem: () => accesses.push('read'), setItem: () => accesses.push('write') },
    });
  api.restoreCenterPanes(); api.persistCenterPanes(); assert.deepEqual(accesses, []);
});

