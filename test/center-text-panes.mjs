import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/js/center/text-editor.js", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../web/js/center/md-preview.js", import.meta.url), "utf8");
const code = (text) => text.replace(/^import .*;\n/gm, "").replace(/export /g, "");
function classes() {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value),
    toggle(value, on) { if (on) values.add(value); else values.delete(value); } };
}
function element() {
  return { dataset: {}, style: {}, classList: classes(), setAttribute() {}, remove() { this.removed = true; } };
}
function root() {
  const listeners = new Map();
  const el = { ...element(), listeners, addEventListener: (name, fn) => listeners.set(name, fn), querySelectorAll: () => [],
    querySelector(selector) { return this.nodes?.[selector] || null; },
    set innerHTML(value) {
      if (this.nodes?.['[data-md-preview]']) this.nodes['[data-md-preview]'].isConnected = false;
      this.html = value;
      const name = { textContent: "" }, controls = { querySelector: () => null, insertAdjacentHTML() {} };
      const bar = { save: null, querySelector(selector) { return selector === '.fv-name' ? name : this.save; }, insertBefore(button) { this.save = button; } };
      const wrap = { ...element(), parentElement: this, appendChild(child) { this.host = child; } };
      this.nodes = { '.editor-wrap': wrap, '[data-editor-tools]': controls, '.fv-bar': bar, '.fv-name': name };
      if (value.includes('data-md-preview')) this.nodes['[data-md-preview]'] = { hidden: true, isConnected: true, innerHTML: "" };
    }, get innerHTML() { return this.html; } };
  return el;
}
function harness({ preview = false, main = false } = {}) {
  const roots = [root(), root()], chips = [0, 1].map(() => ({ ...element(), querySelector: () => null, insertBefore() {} }));
  const redraws = [];
  const owners = [null, null], tokens = [0, 0], hooks = new Map(), models = [], editors = [], hosts = new Map(), saves = [], timers = new Map();
  const layout = { focus: 0, panes: [{ active: null }, { active: null }] };
  let tabs = [], timerId = 0, draws = 0;
  const callHook = (name, ...args) => hooks.get(name)?.(...args);
  const fakeRequire = (paths, done) => done(); fakeRequire.config = () => {};
  const monaco = {
    Uri: { file: path => ({ fsPath: path }) }, KeyMod: { CtrlCmd: 1, WinCtrl: 2 }, KeyCode: { KeyS: 3 },
    languages: { getLanguages: () => [] },
    editor: {
      defineTheme() {}, setTheme() {}, registerLinkOpener() {},
      createModel(value, language, uri) {
        const listeners = new Set();
        const model = { uri, value, disposed: false, getValue() { return this.value; }, isDisposed() { return this.disposed; },
          getFullModelRange() { return {}; }, setValue(value) { this.value = value; for (const listener of listeners) listener(); },
          pushEditOperations(_, changes) { this.setValue(changes[0].text); }, dispose() { this.disposed = true; }, listeners };
        models.push(model); return model;
      },
      create(host) {
        let unsubscribe;
        const editor = { host, model: null, commands: [], view: null, focused: 0, contentListeners: [], modelListeners: [],
          addCommand(key, fn) { this.commands.push(fn); }, updateOptions(options) { this.options = options; },
          onDidDispose() { return { dispose() {} }; }, onDidFocusEditorText() {},
          onDidChangeModel(fn) { this.modelListeners.push(fn); }, onDidChangeModelContent(fn) { this.contentListeners.push(fn); },
          getModel() { return this.model; }, setModel(model) {
            unsubscribe?.(); this.model = model;
            const changed = () => { for (const fn of this.contentListeners) fn(); };
            if (model) { model.listeners.add(changed); unsubscribe = () => model.listeners.delete(changed); }
            for (const fn of this.modelListeners) fn();
          }, saveViewState() { return this.view; }, restoreViewState(view) { this.view = view; }, focus() { this.focused++; } };
        editors.push(editor); return editor;
      },
    },
  };
  const context = {
    pathBasename: path => path.split('/').at(-1), fileKindOf: () => null, isMarkdownExtension: ext => ext === 'md', markdownWebLink: () => null,
    callHook, editorPref: () => false, toggleEditorPref() {}, subscribeEditorPrefs() {}, monacoPrefOpts: () => ({}),
    registerEditorHost: host => hosts.set(host.id, host), updateEditorHost: (id, patch) => Object.assign(hosts.get(id) || {}, patch),
    bindKeymapAction() {}, shortcutLabel: () => '', subscribeKeymap() {}, bindTabCloseTextEditor() {},
    getActiveTabId: () => layout.panes[layout.focus].active, isTabVisible: (space, id) => layout.panes.some(pane => pane.active === id),
    getCenterSpace: () => 'space', getCurrentTabs: () => tabs, paneLayout: () => layout, filePane: pane => roots[pane],
    paneRows: () => main ? [{}, {}] : [], paneIndex: (space, id) => layout.panes[layout.focus].active === id ? layout.focus : Math.max(0, layout.panes.findIndex(pane => pane.active === id)), renderTabs() { redraws.push('tabs'); }, showActiveTab() { redraws.push('body'); },
    document: { documentElement: { getAttribute: () => 'dark' }, createElement: () => element(), querySelectorAll: () => chips },
    getComputedStyle: () => ({ getPropertyValue: () => '' }), monaco, window: { require: fakeRequire, monaco }, require: fakeRequire,
  };
  const api = vm.runInNewContext(code(source) + '\n({ initTextEditor, renderFileView, getMonacoEditor, getMonacoModels, getMonacoViewState, applyExternalTextToModel, disposeClosedFileModel, saveActiveFile, fileHostEditable, transferFilePane });', context);
  const transition = (tab, options, draw) => { const pane = options.pane; owners[pane] = tab; tokens[pane]++; layout.panes[pane].active = tab.id; draw(tokens[pane]); return true; };
  api.initTextEditor({ $() { throw Error('global selector'); }, esc: value => value, cssEsc: value => value,
    extOf: path => path.split('.').at(-1), fileview: root(), withFileViewTransition: transition, bindAgentKeys() {},
    wsSend: message => { saves.push(message); return Promise.resolve({}); }, isFileLikeKind: kind => kind === 'file', showToast() {},
    getRenderedFileOwner: pane => owners[pane], getRenderedFileToken: pane => tokens[pane], openWebLink() {} });
  if (preview) vm.runInNewContext(code(previewSource) + '\ninitCapability();', {
    provide: (name, fn) => hooks.set(name, fn), mdToHtml: text => { draws++; return `<p>${text}</p>`; },
    isMarkdownExtension: ext => ext === 'md', extOf: path => path.split('.').at(-1), getCenterSpace: () => 'space', paneLayout: () => layout, getCurrentTabs: () => tabs,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { api, roots, chips, owners, tokens, layout, models, editors, hosts, saves, timers, redraws, callHook, draws: () => draws, flush,
    open: async (tab, pane) => { if (!tabs.includes(tab)) tabs.push(tab); api.renderFileView(tab, { pane }); await flush(); },
    setTabs: values => { tabs = values; },
    tick: () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); } };
}
const tab = (path, content = 'initial') => ({ id: `file:${path}`, kind: 'file', path, content, label: path });

test('같은 파일 두 칸은 편집기·호스트가 따로 있고 모델·dirty·저장은 공유', async () => {
  const h = harness(), file = tab('/shared.txt');
  await h.open(file, 0); h.layout.focus = 1; await h.open(file, 1);
  const left = h.api.getMonacoEditor(0), right = h.api.getMonacoEditor(1);
  assert.notEqual(left, right); assert.notEqual(left.host, right.host); assert.equal(left.getModel(), right.getModel());
  assert.equal(h.models.length, 1); assert.equal(h.hosts.size, 2); assert.equal(h.api.getMonacoEditor(), right);
  left.getModel().setValue('edited');
  assert.equal(file.draft, 'edited'); assert(h.chips.every(chip => chip.classList.contains('dirty')));
  assert(h.roots.every(root => root.querySelector('.fv-bar').save));
  await h.api.saveActiveFile(); assert.equal(h.saves[0].path, '/shared.txt'); assert.equal(h.saves[0].content, 'edited');
  h.api.applyExternalTextToModel(file.path, 'disk'); assert.equal(file.draft, 'edited');
});

test('칸별 커서·스크롤은 파일을 바꾸고 돌아와도 따로 복구하며 마지막 폐기에서 지움', async () => {
  const h = harness(), shared = tab('/shared.txt'), other = tab('/other.txt');
  await h.open(shared, 0); await h.open(shared, 1);
  h.editors[0].view = { line: 3, scroll: 10 }; h.editors[1].view = { line: 9, scroll: 80 };
  await h.open(other, 0); await h.open(other, 1);
  assert.equal(h.api.getMonacoViewState().get('0\0/shared.txt').line, 3);
  assert.equal(h.api.getMonacoViewState().get('1\0/shared.txt').line, 9);
  await h.open(shared, 0); await h.open(shared, 1);
  assert.equal(h.editors[0].view.scroll, 10); assert.equal(h.editors[1].view.scroll, 80);
  h.api.disposeClosedFileModel(shared.id);
  assert.equal(h.api.getMonacoModels().has(shared.path), false);
  assert.equal(h.api.getMonacoViewState().has('0\0/shared.txt'), false);
  assert.equal(h.api.getMonacoViewState().has('1\0/shared.txt'), false);
});

test('오래된 칸별 렌더 토큰은 편집 가능 상태를 얻지 못함', async () => {
  const h = harness(), file = tab('/a.txt');
  await h.open(file, 0); await h.open(file, 1);
  assert.equal(h.api.fileHostEditable(0), true); assert.equal(h.api.fileHostEditable(1), true);
  h.tokens[0]++; assert.equal(h.api.fileHostEditable(0), false); assert.equal(h.api.fileHostEditable(1), true);
  h.owners[1] = tab('/b.txt'); assert.equal(h.api.fileHostEditable(1), false);
});

test('같은 Markdown은 칸별 원문/미리보기, 연속 입력은 지연 뒤 한 번 반영', async () => {
  const h = harness({ preview: true }), file = tab('/shared.md');
  await h.open(file, 0);
  h.callHook('mdpreview.click', { closest: () => ({ dataset: { md: 'preview' } }) }, file, 1);
  await h.open(file, 1);
  assert.equal(h.callHook('mdpreview.presents', file, 0), false); assert.equal(h.callHook('mdpreview.presents', file, 1), true);
  const pv = h.roots[1].querySelector('[data-md-preview]');
  assert.equal(pv.innerHTML, '<p>initial</p>'); assert.equal(h.models.length, 1);
  assert(!h.roots[0].html.includes('id="editor-wrap"')); assert(!h.roots[1].html.includes('id="md-preview"'));
  h.editors[0].getModel().setValue('first'); h.editors[0].getModel().setValue('last');
  assert.equal(pv.innerHTML, '<p>initial</p>'); assert.equal(h.timers.size, 1);
  const before = h.draws(); h.tick(); assert.equal(h.draws(), before + 1); assert.equal(pv.innerHTML, '<p>last</p>');
  h.callHook('mdpreview.click', { closest: () => ({ dataset: { md: 'raw' } }) }, file, 1);
  await h.open(file, 1); assert.equal(h.api.getMonacoEditor(1).getModel(), h.api.getMonacoEditor(0).getModel());
  h.editors[0].getModel().setValue('raw'); h.tick(); assert.equal(pv.innerHTML, '<p>last</p>');
});

test('저장 단축키는 포커스 칸의 파일만 저장', async () => {
  const h = harness(), left = tab('/left.txt'), right = tab('/right.txt');
  await h.open(left, 0); await h.open(right, 1);
  h.editors[0].getModel().setValue('left edit'); h.editors[1].getModel().setValue('right edit');
  h.layout.focus = 1; await h.editors[1].commands[0]();
  assert.deepEqual(h.saves.map(save => save.path), ['/right.txt']);
});


test('같은 칸의 연속 렌더는 마지막 탭만 모델로 부착', async () => {
  const h = harness(), first = tab('/first.txt'), last = tab('/last.txt');
  h.api.renderFileView(first, { pane: 0 }); h.api.renderFileView(last, { pane: 0 });
  await h.flush();
  assert.equal(h.api.getMonacoEditor(0).getModel().uri.fsPath, last.path);
  assert.equal(h.api.getMonacoModels().has(first.path), false);
});


test('본문 모드 변경은 본 창 전체를 갱신하고 명시 토큰은 실제 소유 칸으로 전달', async () => {
  const h = harness({ main: true }), left = tab('/left.txt'), right = tab('/right.txt');
  await h.open(left, 0); await h.open(right, 1);
  h.layout.focus = 0;
  h.api.renderFileView(right);
  assert.deepEqual(h.redraws, ['tabs', 'body']);
  const leftToken = h.tokens[0], rightToken = h.tokens[1];
  h.api.renderFileView(right, { expectedOwner: right, expectedToken: rightToken });
  await h.flush();
  assert.equal(h.tokens[0], leftToken); assert.equal(h.tokens[1], rightToken + 1);
  assert.equal(h.editors[0].getModel().uri.fsPath, left.path);
});


test('오른쪽 원문이 남아 접히면 같은 공유 모델에서도 오른쪽 커서·스크롤 복원', async () => {
  const h = harness({ preview: true }), shared = tab('/shared.md');
  await h.open(shared, 0); await h.open(shared, 1);
  h.api.getMonacoEditor(0).view = { line: 2, scroll: 10 };
  h.api.getMonacoEditor(1).view = { line: 19, scroll: 320 };
  h.layout.focus = 0;
  h.api.transferFilePane(1);
  assert.equal(h.api.getMonacoEditor(0).getModel(), null);
  await h.open(shared, 0);
  assert.equal(h.api.getMonacoEditor(0).view.line, 19);
  assert.equal(h.api.getMonacoEditor(0).view.scroll, 320);
  assert.equal(h.callHook('mdpreview.presents', shared, 0), false);
});

test('오른쪽 미리보기가 남아 접히면 모드와 원문으로 돌아갈 커서·스크롤 보존', async () => {
  const h = harness({ preview: true }), shared = tab('/shared.md');
  await h.open(shared, 0); await h.open(shared, 1);
  h.api.getMonacoEditor(1).view = { line: 27, scroll: 510 };
  h.callHook('mdpreview.click', { closest: () => ({ dataset: { md: 'preview' } }) }, shared, 1);
  await h.open(shared, 1);
  h.api.transferFilePane(1);
  await h.open(shared, 0);
  assert.equal(h.callHook('mdpreview.presents', shared, 0), true);
  assert.equal(h.roots[0].querySelector('[data-md-preview]').innerHTML, '<p>initial</p>');
  h.callHook('mdpreview.click', { closest: () => ({ dataset: { md: 'raw' } }) }, shared, 0);
  await h.open(shared, 0);
  assert.equal(h.api.getMonacoEditor(0).view.line, 27);
  assert.equal(h.api.getMonacoEditor(0).view.scroll, 510);
});

test('다른 스페이스에서 접힌 칸은 현재 편집기의 다른 경로·실시간 상태 제외', async () => {
  const h = harness({ preview: true }), live = tab('/live.md'), background = tab('/background.md');
  await h.open(live, 1);
  h.api.getMonacoEditor(1).view = { line: 99, scroll: 900 };
  const states = h.api.getMonacoViewState();
  states.set('1\0/live.md', { line: 8, scroll: 80 });
  states.set('1\0/background.md', { line: 3, scroll: 30 });
  h.setTabs([background]);
  h.api.transferFilePane(1);
  assert.equal(states.has('0\0/live.md'), false);
  assert.equal(states.get('1\0/live.md').line, 8);
  assert.equal(states.get('0\0/background.md').line, 3);
});
