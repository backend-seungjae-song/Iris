// 소유 범위: 편집기 표시·키·호스트 수명·서식 대상·미리보기 계약의 회귀 검사.
// 제공 API: smoke 러너의 default run과 변이 확인에 쓰는 cases.
// 의존 대상: 현재 구현, editor-controls-harness의 격리 평가와 Monaco 값 객체.
// 유지 조건: 입력과 기대값은 확정 설계에서 오며 새 검사는 변이로 실패를 확인한다.
// 영향 범위: 파일·메모 조작 모듈, 전체 smoke, 작업의 RED/GREEN 증거.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAsync, read, b4Function } from "../core.mjs";
import { loadModule, editorRuntime, editorHarness, barHarness, monacoActionHarness } from "../editor-controls-harness.mjs";

function setup() {
  const monaco = editorRuntime();
  const keymap = loadModule("web/js/core/keymap.js");
  const hosts = loadModule("web/js/core/editor-hosts.js");
  const keys = loadModule("web/js/core/monaco-keys.js", { ...keymap, monaco });
  const hooks = new Map();
  const format = loadModule("web/js/center/md-format.js", { ...hosts, ...keys, ...keymap, monaco, provide: (name, fn) => hooks.set(name, fn) });
  // markdown 은 기본이 참이다. 메모가 그렇고, 파일도 .md 일 때 이 경로로 온다. 아닌 경우를
  // 검사할 때는 만든 뒤에 markdown 을 끈다(editable 을 끄는 방식과 같다).
  const host = (id, text = "alpha", kind = "memo") => ({ id, editor: editorHarness(text, [new monaco.Selection(1, 1, 1, text.length + 1)]), kind, editable: true, markdown: true, barEl: barHarness() });
  return { monaco, keymap, hosts, keys, format, hooks, host };
}

export const cases = {
  "표시 취향은 값별 열쇠·기본값·잘못된 값 복귀를 지킨다"() {
    const storage = new Map(), writes = [];
    const prefs = loadModule("web/js/core/editor-prefs.js", { localStorage: {
      getItem: (key) => storage.get(key), setItem: (key, value) => { writes.push(key); storage.set(key, value); },
    } });
    assert.equal(prefs.editorPref("file", "minimap"), true);
    assert.equal(prefs.editorPref("file", "wrap"), false);
    assert.equal(prefs.editorPref("memo", "wrap"), true);
    assert.equal(prefs.editorPref("memo", "minimap"), false);
    for (const [scope, key, fallback] of [["file", "minimap", true], ["file", "wrap", false], ["memo", "wrap", true]]) {
      prefs.setEditorPref(scope, key, !fallback);
      assert.equal(writes.at(-1), `ac.editor.${scope}.${key}`);
      assert.equal(prefs.editorPref(scope, key), !fallback);
      storage.set(`ac.editor.${scope}.${key}`, "corrupt");
      assert.equal(prefs.editorPref(scope, key), fallback);
    }
    assert.equal(JSON.stringify(prefs.monacoPrefOpts("memo")), '{"minimap":{"enabled":false},"wordWrap":"on"}');
    assert.equal(JSON.stringify(prefs.monacoPrefOpts("file")), '{"minimap":{"enabled":true},"wordWrap":"off"}');
  },
  "표시 취향은 같은 창·다른 창·다시 읽기와 구독 해제를 지킨다"() {
    const data = new Map(), listeners = [], received = [[], []];
    const localStorage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
    const windows = [0, 1].map((index) => loadModule("web/js/core/editor-prefs.js", { localStorage,
      addEventListener: (event, callback) => { assert.equal(event, "storage"); listeners[index] = callback; } }));
    const unsubscribes = windows.map((prefs, index) => prefs.subscribeEditorPrefs((...args) => received[index].push(args)));
    windows[0].toggleEditorPref("file", "wrap");
    assert.equal(received[0].length, 1); assert.equal(received[1].length, 0);
    listeners[1]({ key: "ac.editor.file.wrap", storageArea: localStorage });
    assert.equal(received[1][0][2], true);
    windows[1].toggleEditorPref("memo", "wrap");
    assert.equal(windows[0].editorPref("file", "wrap"), true);
    assert.equal(windows[0].editorPref("memo", "wrap"), false);
    const reloaded = loadModule("web/js/core/editor-prefs.js", { localStorage });
    assert.equal(reloaded.editorPref("file", "wrap"), true);
    assert.equal(reloaded.editorPref("memo", "wrap"), false);
    unsubscribes[1](); const count = received[1].length;
    listeners[1]({ key: null }); assert.equal(received[1].length, count);
    unsubscribes[0]();
  },
  "호스트는 늦은 구독·갱신·재생성·옛 해제·editor 폐기를 알린다"() {
    const { hosts, host } = setup();
    const old = host("memo-page"), next = host("memo-page");
    const unregister = hosts.registerEditorHost(old), events = [];
    const unsubscribe = hosts.subscribeEditorHosts((item, event) => events.push([item.editor, item.editable, event]));
    assert.equal(events[0][0], old.editor);
    hosts.updateEditorHost(old.id, { editable: false }); assert.equal(events.at(-1)[1], false);
    hosts.registerEditorHost(next); assert.equal(events.at(-2)[2], "remove");
    unregister(); old.editor.dispose(); assert.equal(events.at(-1)[0], next.editor);
    next.editor.dispose(); assert.equal(events.at(-1)[2], "remove");
    const count = events.length; unsubscribe(); hosts.registerEditorHost(host("file")); assert.equal(events.length, count);
  },
  async "편집기 action은 Cmd·Ctrl·Alt 물리 키와 override 재배정·폐기를 지킨다"() {
    const { keys, keymap, monaco } = setup();
    const file = editorHarness(), memo = editorHarness(), hits = [];
    for (const [name, editor] of [["file", file], ["memo", memo]]) keys.bindKeymapAction(editor, "md-bold", () => hits.push(name));
    assert.equal(file.actions.size, 1); assert.equal(memo.actions.size, 1);
    const action = file.actions.get("iris.md-bold");
    assert.equal(action.keybindingContext, "editorTextFocus");
    assert.deepEqual([...action.keybindings], [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyB]);
    action.run(); assert.deepEqual(hits, ["file"]);
    keymap.setOverrides({ "md-bold": { mod: true, alt: true, code: "KeyZ" } });
    assert.equal(file.actions.size, 1); assert.notEqual(file.actions.get("iris.md-bold"), action);
    assert.deepEqual([...file.actions.get("iris.md-bold").keybindings], [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, monaco.KeyMod.WinCtrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ]);
    file.dispose(); assert.equal(file.actions.size, 0); keymap.setOverrides({}); assert.equal(file.actions.size, 0);
    memo.dispose();
    const noMonaco = loadModule("web/js/core/monaco-keys.js", { ...keymap });
    const cold = editorHarness(); noMonaco.bindKeymapAction(cold, "md-bold", () => {}); assert.equal(cold.actions.size, 0); cold.dispose();
    assert(!read("web/js/core/monaco-keys.js").includes("addCommand("));
    const engine = monacoActionHarness(), actualHits = [];
    const realFile = engine.editor("file"), realMemo = engine.editor("memo");
    keys.bindKeymapAction(realFile, "md-bold", () => actualHits.push("file"));
    keys.bindKeymapAction(realMemo, "md-bold", () => actualHits.push("memo"));
    await engine.press("file", monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB);
    await engine.press("memo", monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyB);
    assert.deepEqual(actualHits, ["file", "memo"]);
    keymap.setOverrides({ "md-bold": { mod: true, key: "j" } });
    await engine.press("file", monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB);
    assert.equal(actualHits.length, 2);
    await engine.press("file", monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyJ);
    assert.deepEqual(actualHits, ["file", "memo", "file"]);
    realFile.dispose(); realMemo.dispose(); assert.equal(engine.rules.length, 0);
  },
  "Alt 문자키 녹음·표시·충돌 판정은 같은 물리 자리를 본다"() {
    const { keymap } = setup();
    const binding = keymap.bindingFromEvent({ key: "Ω", code: "KeyZ", altKey: true });
    assert.equal(binding.code, "KeyZ"); assert.equal(keymap.formatBinding(binding), "⌥Z");
    assert(keymap.matchBinding({ key: "Ω", code: "KeyZ", altKey: true }, binding));
    assert.equal(keymap.bindingKey({ alt: true, key: "z" }), keymap.bindingKey(binding));
    assert.equal(keymap.findConflicts(keymap.resolvedKeymap()).filter((item) => item.overlaps).length, 0);
    for (const id of ["editor-minimap", "editor-wrap", "md-bold", "md-italic", "md-link", "md-strike",
      "md-code", "md-codeblock", "md-list", "md-check", "md-quote"]) {
      assert.equal(keymap.KEYMAP.find((item) => item.id === id)?.where, keymap.ON_EDITOR);
    }
  },
  "서식은 감싸기·벗기기·빈 선택·링크·다중 선택과 undo 경계를 지킨다"() {
    const { format, host, monaco } = setup();
    for (const [name, marker] of [["bold", "**"], ["italic", "*"], ["strike", "~~"], ["code", "`"]]) {
      const target = host("file");
      assert(format.formatEditor(target, name)); assert.equal(target.editor.model.getValue(), marker + "alpha" + marker);
      assert.deepEqual(target.editor.trace, ["stop", "edit", "stop"]);
      format.formatEditor(target, name); assert.equal(target.editor.model.getValue(), "alpha");
      target.editor.setSelections([new monaco.Selection(1, 1, 1, 1)]);
      format.formatEditor(target, name); assert.equal(target.editor.getSelections()[0].positionColumn, marker.length + 1);
      assert.equal(target.editor.model.getValue(), marker + marker + "alpha");
      const wrapped = host("wrapped", marker + "alpha" + marker);
      format.formatEditor(wrapped, name); assert.equal(wrapped.editor.model.getValue(), "alpha");
    }
    const target = host("multi", "one two");
    target.editor.setSelections([new monaco.Selection(1, 4, 1, 1), new monaco.Selection(1, 5, 1, 8)]);
    format.formatEditor(target, "bold"); assert.equal(target.editor.model.getValue(), "**one** **two**");
    assert.equal(target.editor.getSelections()[0].getDirection(), monaco.SelectionDirection.RTL);
    const link = host("link", "글"); format.formatEditor(link, "link");
    assert.equal(link.editor.model.getValue(), "[글](url)");
    assert.equal(link.editor.getSelections()[0].startColumn, 5); assert.equal(link.editor.getSelections()[0].endColumn, 8);
    const undo = host("undo", "typed");
    undo.editor.executeEdits("typing", [{ range: new monaco.Range(1, 6, 1, 6), text: "!" }]);
    format.formatEditor(undo, "bold"); undo.editor.undo(); assert.equal(undo.editor.model.getValue(), "typed!");
    undo.editor.undo(); assert.equal(undo.editor.model.getValue(), "typed");
  },
  "줄 서식은 들여쓰기·끝 1열 제외·혼합 목록·체크 토글을 지킨다"() {
    const { format, host, monaco } = setup();
    const target = host("lines", "  one\n  two\nlast");
    target.editor.setSelections([new monaco.Selection(1, 1, 3, 1)]);
    format.formatEditor(target, "list"); assert.equal(target.editor.model.getValue(), "  - one\n  - two\nlast");
    format.formatEditor(target, "list"); assert.equal(target.editor.model.getValue(), "  one\n  two\nlast");
    format.formatEditor(target, "quote"); assert.equal(target.editor.model.getValue(), "  > one\n  > two\nlast");
    format.formatEditor(target, "quote"); assert.equal(target.editor.model.getValue(), "  one\n  two\nlast");
    const mixed = host("mixed", "- one\ntwo"); mixed.editor.setSelections([new monaco.Selection(1, 1, 2, 4)]);
    format.formatEditor(mixed, "list"); assert.equal(mixed.editor.model.getValue(), "- - one\n- two");
    const tasks = host("tasks", "- one\n- [x] two"); tasks.editor.setSelections([new monaco.Selection(1, 1, 2, 10)]);
    format.formatEditor(tasks, "check"); assert.equal(tasks.editor.model.getValue(), "- [ ] one\n- [ ] two");
    format.formatEditor(tasks, "check"); assert.equal(tasks.editor.model.getValue(), "- [x] one\n- [x] two");
    format.formatEditor(tasks, "check"); assert.equal(tasks.editor.model.getValue(), "- [ ] one\n- [ ] two");
  },
  "코드 블록은 고른 줄을 울타리로 감싸고 다시 누르면 벗긴다"() {
    const { format, host, monaco } = setup();
    const block = host("block", "one\ntwo\nlast");
    block.editor.setSelections([new monaco.Selection(1, 1, 2, 4)]);
    format.formatEditor(block, "codeblock");
    assert.equal(block.editor.model.getValue(), "```\none\ntwo\n```\nlast");
    assert.equal(block.editor.getSelections()[0].startLineNumber, 2);
    assert.equal(block.editor.getSelections()[0].endLineNumber, 3);
    format.formatEditor(block, "codeblock");
    assert.equal(block.editor.model.getValue(), "one\ntwo\nlast");
    assert.deepEqual(block.editor.trace, ["stop", "edit", "stop", "stop", "edit", "stop"]);
    // 빈 줄 하나면 두 울타리가 같은 위치에 놓인다. 한 번에 넣지 않으면 순서가 정해지지 않는다.
    const empty = host("empty", "");
    empty.editor.setSelections([new monaco.Selection(1, 1, 1, 1)]);
    format.formatEditor(empty, "codeblock");
    assert.equal(empty.editor.model.getValue(), "```\n\n```");
    assert.equal(empty.editor.getSelections()[0].startLineNumber, 2);
    // 줄 가운데를 선택해도 줄 전체를 감싸고, 선택 범위는 그대로 유지된다.
    const mid = host("mid", "alpha");
    mid.editor.setSelections([new monaco.Selection(1, 2, 1, 4)]);
    format.formatEditor(mid, "codeblock");
    assert.equal(mid.editor.model.getValue(), "```\nalpha\n```");
    assert.equal(mid.editor.getSelections()[0].startColumn, 2);
    assert.equal(mid.editor.getSelections()[0].endColumn, 4);
  },
  // 모든 형식 아이콘은 호버 시 단축키를 안내한다. 버튼 하나라도 키가 없으면 그 버튼만 이름만
  // 표시되고, 아이콘에는 그 안내 말고 설명할 수단이 없다.
  "서식 손잡이는 모두 이름과 단축키를 말한다"() {
    const { format, hooks, host } = setup();
    format.initCapability();
    const bar = hooks.get("mdformat.barHtml")(host("md", "alpha", "file"));
    const tips = [...bar.matchAll(/data-mdformat="([^"]+)" data-tip="([^"]*)"/g)];
    assert.equal(tips.length, 9, `손잡이 ${tips.length}개만 읽었다 — 세는 방식이 깨졌다`);
    for (const [, name, tip] of tips) {
      assert.ok(/[⌘⌥⇧]/.test(tip), `${name} 안내에 단축키가 없다: ${tip}`);
      assert.ok(tip.replace(/[⌘⌥⇧].*$/, "").trim(), `${name} 안내에 이름이 없다: ${tip}`);
    }
  },
  // 안내는 버튼 아래에 그려진다. 가로 스크롤용 overflow 가 그것까지 잘라 미니맵·줄바꿈
  // (자르지 않는 상자에 있다)만 보였으므로, 자르는 상자는 아래 여백을 그만큼 둬야 한다.
  "서식 손잡이의 안내는 잘리지 않는다"() {
    const css = read("web/css/17-editor-bar.css");
    const clipping = [...css.matchAll(/^([^{\n]*(?:editor-controls|mdformat-bar)[^{\n]*)\{([^}]*overflow:\s*hidden[^}]*)\}/gm)]
      .map((match) => match[1].trim());
    assert.ok(clipping.length >= 2, `자르는 상자를 ${clipping.length}개만 읽었다 — 세는 방식이 깨졌다`);
    const room = /([^{\n]+)\{[^}]*padding-bottom:\s*(\d+)px;\s*margin-bottom:\s*-\2px/.exec(css);
    assert.ok(room, "안내가 설 자리를 비워 두는 규칙이 없다");
    for (const selector of clipping) assert.ok(room[1].includes(selector), `${selector} 가 안내를 자른다`);
    assert.ok(/\.etool\[data-tip\]::after\s*\{[^}]*top:\s*calc\(100%/.test(css), "안내가 손잡이 아래가 아니다");
  },
  // Monaco 는 편집기에 포커스만 있으면 자기 기본키를 처리한다. 그 위에 같은 조합을 얹으면 어느
  // 쪽이 이기는지 화면에서만 갈리고 진 쪽은 아무 반응이 없다. 검사 범위는 수식키 둘과 글자
  // 하나의 조합이고, 그 밖은 판정하지 않는다.
  "편집기 단축키는 Monaco 기본키와 겹치지 않는다"() {
    const taken = new Map();
    const pattern = /(\d+) \/\* KeyMod\.CtrlCmd \*\/ \| (\d+) \/\* KeyMod\.(Shift|Alt) \*\/ \| \d+ \/\* KeyCode\.Key([A-Z]) \*\//g;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".js")) continue;
        for (const match of readFileSync(full, "utf8").matchAll(pattern)) {
          taken.set(`${match[3] === "Shift" ? "S" : "A"}-${match[4].toLowerCase()}`, entry.name);
        }
      }
    };
    walk(join("node_modules", "monaco-editor", "esm", "vs"));
    assert.ok(taken.size >= 10, `Monaco 기본키를 ${taken.size}개만 읽었다 — 세는 방식이 깨졌다`);
    const { keymap } = setup();
    const wrong = [];
    for (const item of keymap.KEYMAP) {
      if (item.where !== keymap.ON_EDITOR) continue;
      const binding = keymap.normalizeBinding(item.def);
      const letter = /^Key([A-Z])$/.exec(binding.code || "")?.[1].toLowerCase()
        || (/^[a-z]$/.test(binding.key || "") ? binding.key : null);
      if (!binding.mod || !letter || binding.shift === binding.alt) continue;
      const key = `${binding.shift ? "S" : "A"}-${letter}`;
      if (taken.has(key)) wrong.push(`${item.id} ${keymap.formatBinding(binding)} — Monaco 가 ${taken.get(key)} 에서 쓴다`);
    }
    if (wrong.length) throw new Error(wrong.join(" · "));
  },
  "서식은 원문·현재 연결·쓰기 가능한 호스트만 고친다"() {
    const { format, host } = setup();
    for (const state of ["preview", "detached", "readonly", "no-model"]) {
      const target = host(state);
      if (state === "preview") target.editable = false;
      if (state === "detached") target.barEl.isConnected = false;
      if (state === "readonly") target.editor.options.readOnly = true;
      if (state === "no-model") target.editor.model = null;
      assert.equal(format.formatEditor(target, "bold"), false, state); assert.deepEqual(target.editor.trace, []);
    }
  },
  // 마크다운에서만 등록된다. .md 가 아닌 글에는 서식 아홉 개가 붙지 않는다.
  // 미니맵·줄바꿈은 이 막대 밖이라 여기서 검사하지 않는다.
  "서식은 마크다운 호스트에만 선다"() {
    const { format, hooks, host } = setup();
    format.initCapability();
    const md = host("md", "alpha", "file");
    assert.equal(format.formatEditor(md, "bold"), true);
    assert.equal(md.editor.model.getValue(), "**alpha**");
    const bar = hooks.get("mdformat.barHtml")(md);
    for (const name of ["bold", "italic", "strike", "code", "codeblock", "list", "check", "quote", "link"]) {
      assert.ok(bar.includes(`data-mdformat="${name}"`), name);
    }
    const code = host("code", "alpha", "file");
    code.markdown = false;
    assert.equal(format.formatEditor(code, "bold"), false);
    assert.equal(code.editor.model.getValue(), "alpha");
    assert.deepEqual(code.editor.trace, []);
    assert.equal(hooks.get("mdformat.barHtml")(code), "");
    assert.equal(hooks.get("mdformat.barHtml")({ editable: true }), "");
    assert.equal(hooks.get("mdformat.barHtml")({ editable: false, markdown: true }), "");
  },
  // 호스트가 markdown 을 명시하지 않으면 막대가 사라지고 오류도 나지 않는다. 그래서 명시하는
  // 위치를 여기서 검사한다. usable() 이 그 값을 읽는다(web/js/center/md-format.js).
  "편집기 호스트는 마크다운 여부를 밝힌다"() {
    const sites = [];
    for (const path of ["web/js/center/text-editor.js", "web/js/panel/memo.js", "web/js/panel/memo-window.js"]) {
      const src = read(path);
      for (const call of src.matchAll(/registerEditorHost\(\{[\s\S]*?\}\)/g)) sites.push([path, call[0]]);
    }
    assert.ok(sites.length >= 3, `registerEditorHost 자리를 못 찾았다: ${sites.length}`);
    for (const [path, call] of sites) assert.ok(/\bmarkdown:/.test(call), `${path} 의 호스트가 markdown 을 안 밝힌다`);
  },
  "서식 툴바와 키는 늦게 켜기·호스트별 선택·미리보기·재생성에 한 번만 붙는다"() {
    const { host, hosts, format } = setup();
    const file = host("file"), dock = host("memo-dock"), page = host("memo-page"), window = host("memo-window");
    for (const target of [file, dock, page, window]) hosts.registerEditorHost(target);
    page.editor.model = dock.editor.model;
    format.initCapability(); format.initCapability();
    for (const target of [file, dock, page, window]) assert.equal(target.editor.actions.size, 9);
    const toolbar = page.barEl.toolbar, button = toolbar.buttons.get("bold");
    let prevented = false, stopped = false;
    toolbar.listeners.get("mousedown")({ target: button, preventDefault: () => { prevented = true; } });
    toolbar.listeners.get("click")({ target: button, preventDefault() {}, stopPropagation: () => { stopped = true; } });
    assert(prevented && stopped); assert.equal(page.editor.trace.length, 3); assert.equal(dock.editor.trace.length, 0); assert.equal(file.editor.trace.length, 0);
    for (const target of [file, dock, page, window]) {
      for (const other of [file, dock, page, window]) other.editor.trace.length = 0;
      target.editor.actions.get("iris.md-bold").run();
      for (const other of [file, dock, page, window]) assert.equal(other.editor.trace.length, other === target ? 3 : 0);
    }
    hosts.updateEditorHost(page.id, { editable: false }); assert.equal(page.editor.actions.size, 0); assert.equal(page.barEl.toolbar, null);
    hosts.updateEditorHost(page.id, { editable: true }); assert.equal(page.editor.actions.size, 9);
    const recreated = host(page.id); hosts.registerEditorHost(recreated); assert.equal(page.editor.actions.size, 0); assert.equal(recreated.editor.actions.size, 9);
    page.editor.dispose(); assert.equal(recreated.editor.actions.size, 9);
    recreated.editor.dispose(); assert.equal(recreated.editor.actions.size, 0); assert.equal(recreated.barEl.toolbar, null);
  },
  "파일 호스트는 오래된 탭·토큰·미리보기·다른 모델을 거절한다"() {
    const source = read("web/js/center/text-editor.js");
    const tab = { id: "file:a", path: "a.md" }, model = {};
    const base = { fileHostTab: tab, fileHostToken: 4, getRenderedFileOwner: () => tab, getRenderedFileToken: () => 4,
      getActiveTabId: () => tab.id, getCenterSpace: () => "space", callHook: () => false, monacoEditor: { getModel: () => model }, monacoModels: new Map([[tab.path, model]]) };
    const evaluate = (overrides) => {
      const values = { ...base, ...overrides };
      return new Function(...Object.keys(values), b4Function(source, "fileHostEditable") + "\nreturn fileHostEditable();")(...Object.values(values));
    };
    assert(evaluate({}));
    for (const changed of [{ getRenderedFileOwner: () => ({}) }, { getRenderedFileToken: () => 3 }, { getActiveTabId: () => "b" }, { callHook: () => true }, { monacoEditor: { getModel: () => ({}) } }]) assert.equal(evaluate(changed), false);
    const render = b4Function(source, "renderFileViewBody");
    assert(render.indexOf("fileHostTab = null") < render.indexOf('callHook("viewer.renderBody"'));
    assert(render.indexOf("renderToken !== getRenderedFileToken()") < render.indexOf("const m = modelFor(t)"));
    assert(b4Function(source, "ensureMonaco").includes("writingExternal || !fileHostEditable()"));
    assert(source.includes('monacoPrefOpts("file")'));
    assert(source.includes('bindKeymapAction(monacoEditor, "editor-wrap"'));
    assert(source.includes('bindKeymapAction(monacoEditor, "editor-minimap"'));
    const editor = editorHarness("unchanged");
    let pressed;
    const values = { monacoEditor: editor, monacoPrefOpts: () => ({ minimap: { enabled: false }, wordWrap: "on" }),
      fileview: { querySelectorAll: () => [{ dataset: { editorPref: "wrap" }, classList: { toggle() {} }, setAttribute: (name, value) => { pressed = value; } }] }, editorPref: () => true };
    new Function(...Object.keys(values), b4Function(source, "syncFilePrefs") + "\nsyncFilePrefs();")(...Object.values(values));
    assert.equal(editor.options.wordWrap, "on"); assert.equal(editor.options.minimap.enabled, false);
    assert.equal(pressed, "true"); assert.equal(editor.model.getValue(), "unchanged"); assert.deepEqual(editor.trace, []);
  },
  "mdformat은 독립 capability로 세 창에 동적 로드되고 강제 켜지지 않는다"() {
    const source = read("web/js/core/capabilities.js");
    const entry = /\{\s*id: "mdformat",([\s\S]*?)\n  \}/.exec(source)?.[1];
    assert(entry); assert(entry.includes('windows: ["main", "memo", "browser"]'));
    assert(entry.includes('files: ["center/md-format.js"]')); assert(entry.includes('presets: ["full"]'));
    assert(entry.includes('load: () => import("../center/md-format.js")')); assert(!entry.includes("alwaysIn"));
    assert(!read("web/index.html").includes("data-mdformat"));
  },
  "미리보기는 취소선·읽기 전용 체크·코드·HTML 이스케이프를 실제로 그린다"() {
    const { initMarkdown, mdToHtml, isMarkdownExtension } = loadModule("web/js/core/markdown.js");
    initMarkdown({ esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") });
    assert(isMarkdownExtension("md")); assert(isMarkdownExtension("markdown")); assert(!isMarkdownExtension("csv"));
    const html = mdToHtml("~~취소~~\n\n- [ ] 할 일\n- [x] 완료\n- [X] 완료 둘\n\n`~~코드~~`\n\n~~<script>~~");
    assert(html.includes("<del>취소</del>"));
    assert.equal((html.match(/type="checkbox" disabled/g) || []).length, 3);
    assert.equal((html.match(/ disabled checked/g) || []).length, 2);
    assert(html.includes("<code>~~코드~~</code>")); assert(html.includes("<del>&lt;script&gt;</del>"));
    assert.equal(mdToHtml("**강조 `~~코드~~`**"), "<p><strong>강조 <code>~~코드~~</code></strong></p>");
    assert(!mdToHtml("```\n~~raw~~\n- [ ] raw\n```").includes("<input"));
  },
};

export default async function run() {
  console.log("[편집기 조작 — 표시·키·서식]");
  for (const [name, test] of Object.entries(cases)) await checkAsync(name, test);
}
