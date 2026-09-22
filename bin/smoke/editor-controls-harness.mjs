// 소유 범위: 편집기 조작 검사의 격리된 모듈 평가와 메모리 편집기·DOM 대역.
// 제공 API: loadModule, editorRuntime, editorHarness, barHarness, memoOptions, monacoActionHarness.
// 의존 대상: 현재 소스, Node vm, 설치된 Monaco의 Range·Selection·키 열거값.
// 유지 조건: 앱·서버·실제 저장소를 건드리지 않고, 대역 검증을 실제 화면 검증으로 세지 않는다.
// 영향 범위: editor-controls·memo·scrollback-copy smoke와 작업의 변이 검증.

import { runInNewContext } from "node:vm";
import { read, b4Function } from "./core.mjs";
import { Range } from "../../node_modules/monaco-editor/esm/vs/editor/common/core/range.js";
import { Selection } from "../../node_modules/monaco-editor/esm/vs/editor/common/core/selection.js";
import { KeyCode, EditorOption, SelectionDirection } from "../../node_modules/monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js";
import { ContextKeyExpr } from "../../node_modules/monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
import { DisposableStore, toDisposable } from "../../node_modules/monaco-editor/esm/vs/base/common/lifecycle.js";

export function loadModule(path, dependencies = {}) {
  const source = read(path);
  const names = [...source.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)].map((match) => match[1] || match[2]);
  return runInNewContext(source.replace(/^import [\s\S]*?;\n/gm, "").replace(/\bexport /g, "")
    + `\n;({${names.join(",")}})`, { console, ...dependencies }, { filename: path });
}

export function editorRuntime() {
  return { Range, Selection, SelectionDirection, KeyCode, KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512, Shift: 1024 }, editor: { EditorOption } };
}

export function monacoActionHarness() {
  const source = read("node_modules/monaco-editor/esm/vs/editor/standalone/browser/standaloneCodeEditor.js");
  const begin = source.indexOf("    addAction(_descriptor) {"), end = source.indexOf("    _triggerCommand(", begin);
  if (begin < 0 || end < 0) throw new Error("설치된 Monaco addAction을 못 읽음");
  const rules = [], commands = new Map();
  const action = runInNewContext("({" + source.slice(begin, end) + "}).addAction", { ContextKeyExpr, DisposableStore, toDisposable,
    CommandsRegistry: { registerCommand: (id, run) => { commands.set(id, run); return { dispose: () => commands.delete(id) }; } },
    InternalEditorAction: class {},
  });
  return {
    editor(id) {
      const editor = editorHarness();
      Object.assign(editor, { getId: () => id, _actions: new Map(), _contextKeyService: {},
        _standaloneKeybindingService: { addDynamicKeybinding(command, key, run, when) {
          const rule = { command, key, run, when }; rules.push(rule);
          return { dispose: () => { const index = rules.indexOf(rule); if (index >= 0) rules.splice(index, 1); } };
        } }, addAction: action });
      return editor;
    },
    async press(id, key) {
      const context = { getValue: (name) => name === "editorId" ? id : name === "editorTextFocus" };
      const rule = rules.filter((item) => item.key === key && item.when.evaluate(context)).at(-1);
      if (rule) await commands.get(rule.command)();
    },
    rules,
  };
}

export function editorHarness(text = "", selections = [new Selection(1, 1, 1, 1)]) {
  const disposals = new Set(), actions = new Map(), history = [];
  let value = text, current = selections, openUndo = false;
  const model = {
    getValue: () => value,
    getLineContent: (line) => value.split("\n")[line - 1].replace(/\r$/, ""),
    getOffsetAt: ({ lineNumber, column }) => value.split("\n").slice(0, lineNumber - 1).reduce((length, line) => length + line.length + 1, 0) + column - 1,
    getPositionAt: (offset) => {
      const lines = value.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1).replace(/\r$/, "").length + 1 };
    },
  };
  const editor = {
    actions, trace: [], options: {}, model,
    getModel() { return this.model; },
    getSelections: () => current,
    setSelections: (next) => { current = next; },
    getOption: () => !!editor.options.readOnly,
    updateOptions: (options) => Object.assign(editor.options, options),
    focus() {},
    onDidDispose(fn) { disposals.add(fn); return { dispose: () => disposals.delete(fn) }; },
    addAction(descriptor) { actions.set(descriptor.id, descriptor); return { dispose: () => actions.delete(descriptor.id) }; },
    dispose() { for (const fn of [...disposals]) fn(); },
    pushUndoStop() { this.trace.push("stop"); openUndo = false; },
    executeEdits(source, edits, endState) {
      this.trace.push("edit");
      if (!openUndo) history.push({ value, current });
      openUndo = true;
      const operations = edits.map((edit) => ({ start: model.getOffsetAt(edit.range.getStartPosition()), end: model.getOffsetAt(edit.range.getEndPosition()), text: edit.text }));
      for (const edit of operations.sort((left, right) => right.start - left.start)) value = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
      if (typeof endState === "function") current = endState([]);
      return true;
    },
    undo() { const previous = history.pop(); if (previous) { value = previous.value; current = previous.current; } openUndo = false; },
  };
  return editor;
}

export function barHarness() {
  const bar = { isConnected: true, toolbar: null, closest: () => null,
    querySelector: () => bar.toolbar,
    insertAdjacentHTML(position, html) {
      const listeners = new Map(), buttons = new Map();
      const toolbar = { parentElement: bar, listeners, buttons,
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name),
        remove() { if (bar.toolbar === toolbar) bar.toolbar = null; toolbar.parentElement = null; },
        contains: (button) => [...buttons.values()].includes(button),
        querySelector: (selector) => buttons.get(/data-mdformat="([^"]+)"/.exec(selector)?.[1]),
      };
      for (const match of html.matchAll(/data-mdformat="([^"]+)"/g)) {
        const button = { dataset: { mdformat: match[1] }, closest: () => button };
        buttons.set(match[1], button);
      }
      bar.toolbar = toolbar;
    },
  };
  return bar;
}

export function memoOptions(wrap) {
  const shared = { monacoPrefOpts: () => ({ minimap: { enabled: false }, wordWrap: wrap ? "on" : "off" }),
    monacoTheme: () => "ac", getComputedStyle: () => ({ getPropertyValue: () => "mono" }), document: { documentElement: {} } };
  const dock = runInNewContext(b4Function(read("web/js/panel/memo.js"), "memoOpts") + "\nmemoOpts()",
    { ...shared, memoModel: {}, getMemoShownSpace: () => "space" });
  const source = read("web/js/panel/memo-window.js");
  const begin = source.indexOf('mwEditor = monaco.editor.create($("#mw-editor"), {');
  if (begin < 0) throw new Error("메모 창 editor 생성 자리가 없음");
  const creation = source.slice(begin, source.indexOf("\n    });", begin) + 8);
  const window = runInNewContext(creation + "\nmwEditor", { ...shared, mwModel: {}, $: () => ({}), monaco: { editor: { create: (element, options) => options } } });
  return [dock, window];
}
