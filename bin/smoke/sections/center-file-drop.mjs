// 소유 범위: 가운데 외부 파일 드롭의 수용·순서·거절·표시 수명 회귀 검사.
// 제공 API: smoke default run과 실제 소스 변이에 쓰는 cases.
// 의존 대상: 정본 file-drop 모듈, DOM 이벤트 전파·시계 대역, 현재 main/CSS/xterm 연결.
// 유지 조건: 내부 드래그의 기본 동작과 전파를 검사하고, 화면 검증으로 과장하지 않는다.
// 영향 범위: center/file-drop.js, main 조립부, 11-center-tabs.css, 전체 smoke.

import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { checkAsync, read } from "../core.mjs";
import { initCenterFileDrop, centerFileDragHotNext, CENTER_DROP_IDLE_MS } from "../../../web/js/center/file-drop.js";
import { wireReorder } from "../../../web/js/core/reorder.js";

function element(id, parent = null) {
  const classes = new Set(), listeners = new Map();
  const node = {
    id, parent, listeners,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    contains(target) { return target === node || !!target?.parent && node.contains(target.parent); },
    closest(selector) { return selector === "#" + id || selector === ".ctab" && id.startsWith("tab-") ? node : parent?.closest(selector); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    addEventListener(kind, handler, capture = false) {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push({ handler, capture });
    },
    removeEventListener(kind, handler, capture = false) {
      listeners.set(kind, (listeners.get(kind) || []).filter((item) => item.handler !== handler || item.capture !== capture));
    },
  };
  return node;
}

function dispatch(target, type, dataTransfer = null, extra = {}) {
  const event = { target, type, dataTransfer, relatedTarget: null, clientX: 0,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...extra };
  const path = [];
  for (let node = target; node; node = node.parent) path.push(node);
  for (const capture of [true, false]) {
    for (const node of capture ? [...path].reverse() : path) {
      for (const listener of node.listeners.get(type) || []) {
        if (listener.capture === capture) listener.handler(event);
      }
      if (event.stopped) return event;
    }
  }
  return event;
}

function transfer(paths = ["/tmp/hello world.md"], overrides = {}) {
  const files = paths.map((path) => ({ name: path.split("/").at(-1), path, size: 0, type: "" }));
  return { types: ["Files"], files, dropEffect: "none", items: files.map((file) => ({
    kind: "file", getAsFile: () => file,
    webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, fullPath: "/virtual/" + file.name }),
  })), ...overrides };
}

function setup(overrides = {}) {
  const document = element("document"), window = element("window");
  const tabstrip = element("tabstrip", document), centerBody = element("center-body", document);
  const editor = element("editor", centerBody), terminal = element("terminal", document);
  const opened = [], notices = [], hooks = [], timers = new Map();
  let time = 0, timerId = 0;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; };
  window.clearTimeout = (timer) => timers.delete(timer);
  const deps = { document, window, tabstrip, centerBody,
    acHost: { getDroppedPath: (file) => file.path },
    openFile: (path) => opened.push(path), showToast: (message) => notices.push(message),
    callHook: (...args) => hooks.push(args), ...overrides };
  const dispose = initCenterFileDrop(deps);
  return { ...deps, editor, terminal, opened, notices, hooks, timers, dispose,
    advance(delta) {
      time += delta;
      for (const [timer, value] of [...timers]) {
        if (value.at <= time) { timers.delete(timer); value.callback(); }
      }
    },
    hot: () => [tabstrip, centerBody].filter((node) => node.classList.contains("center-drop-hot")).map((node) => node.id),
  };
}

export const cases = {
  "가운데 파일 드롭은 탭 띠·빈 본문·편집기 자식에서 모든 절대경로를 순서대로 연다"() {
    for (const target of ["tabstrip", "centerBody", "editor"]) {
      const runtime = setup(), data = transfer(["/tmp/한 글.md", "/tmp/report.xlsx", "/tmp/archive.zip", "/tmp/last.txt"]);
      const event = dispatch(runtime[target], "drop", data);
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(runtime.opened, data.files.map((file) => file.path));
      assert.equal(runtime.opened.at(-1), "/tmp/last.txt");
      assert.deepEqual(runtime.notices, []);
    }
  },
  "가운데 파일 드롭은 폴더만 거절하고 빈 파일·확장자 없는 파일을 계속 연다"() {
    const runtime = setup(), data = transfer(["/tmp/folder.md", "/tmp/EMPTY", "/tmp/last.txt"]);
    data.items[0].webkitGetAsEntry = () => ({ isDirectory: true, isFile: false });
    dispatch(runtime.editor, "drop", data);
    assert.deepEqual(runtime.opened, ["/tmp/EMPTY", "/tmp/last.txt"]);
    assert.equal(runtime.notices.length, 1);
    assert.match(runtime.notices[0], /폴더/);
  },
  "가운데 파일 드롭은 종류·경로·열기 실패를 알리고 다음 파일을 처리한다"() {
    for (const fault of ["no-entry", "no-api", "entry-throw", "no-file", "no-path", "host-throw", "open-throw"]) {
      const runtime = setup(), data = transfer(["/tmp/broken", "/tmp/next.md"]);
      if (fault === "no-entry") data.items[0].webkitGetAsEntry = () => null;
      if (fault === "no-api") delete data.items[0].webkitGetAsEntry;
      if (fault === "entry-throw") data.items[0].webkitGetAsEntry = () => { throw new Error("entry"); };
      if (fault === "no-file") data.items[0].getAsFile = () => null;
      if (fault === "no-path") data.files[0].path = "";
      if (fault === "host-throw") runtime.acHost.getDroppedPath = (file) => { if (file.name === "broken") throw new Error("host"); return file.path; };
      if (fault === "open-throw") {
        runtime.dispose();
        initCenterFileDrop({ ...runtime, openFile: (path) => { if (path.endsWith("broken")) throw new Error("open"); runtime.opened.push(path); } });
      }
      dispatch(runtime.editor, "drop", data);
      assert.deepEqual(runtime.opened, ["/tmp/next.md"], fault);
      assert.equal(runtime.notices.length, 1, fault);
    }
    for (const data of [transfer([], { items: undefined }), transfer([], { items: [{ kind: "string" }] })]) {
      const runtime = setup(); dispatch(runtime.tabstrip, "drop", data);
      assert.equal(runtime.opened.length, 0); assert.equal(runtime.notices.length, 1);
    }
    const runtime = setup({ acHost: null }); dispatch(runtime.tabstrip, "drop", transfer());
    assert.equal(runtime.opened.length, 0); assert.equal(runtime.notices.length, 1);
  },
  "가운데 파일 드롭은 getAsEntry도 쓰고 스페이스 사전 판정 없이 openFile에 맡긴다"() {
    const routed = [], runtime = setup({ openFile: (path) => routed.push(path) });
    const data = transfer(); data.items[0].getAsEntry = data.items[0].webkitGetAsEntry;
    delete data.items[0].webkitGetAsEntry;
    dispatch(runtime.tabstrip, "drop", data);
    assert.deepEqual(routed, [data.files[0].path]);
    assert.equal(runtime.notices.length, 0);
  },
  "가운데 파일 드롭은 내부 탭·스페이스·링크·텍스트 드래그를 가로채지 않는다"() {
    for (const types of [["text/plain"], ["text/uri-list"], ["application/x-iris-space"], []]) {
      const runtime = setup(), data = transfer([], { types, dropEffect: "move" });
      let received = 0;
      runtime.editor.addEventListener("drop", () => received++);
      for (const kind of ["dragover", "drop", "pointerdown", "pointermove", "pointerup"]) {
        const event = dispatch(runtime.editor, kind, data);
        assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false);
      }
      assert.equal(received, 1); assert.equal(data.dropEffect, "move");
      assert.deepEqual(runtime.hot(), []); assert.deepEqual(runtime.opened, []); assert.deepEqual(runtime.notices, []);
    }
    const runtime = setup(), data = transfer();
    dispatch(runtime.editor, "dragstart", data);
    assert.equal(dispatch(runtime.editor, "dragover", data).defaultPrevented, false);
    assert.equal(dispatch(runtime.editor, "drop", data).stopped, false);
    assert.deepEqual(runtime.opened, []);
    dispatch(runtime.editor, "drop", transfer()); assert.equal(runtime.opened.length, 1);
  },
  "가운데 파일 드롭 배선과 실제 wireReorder를 함께 써도 탭 순서가 바뀐다"() {
    const runtime = setup(), moved = [];
    const source = element("tab-first", runtime.tabstrip), target = element("tab-second", runtime.tabstrip);
    wireReorder(runtime.tabstrip, ".ctab", (node) => node.id, (...args) => moved.push(args));
    const data = transfer([], { types: ["text/plain"], setData() {} });
    dispatch(source, "dragstart", data);
    dispatch(target, "dragover", data); dispatch(target, "drop", data); dispatch(source, "dragend", data);
    assert.deepEqual(moved, [["tab-first", "tab-second"]]); assert.deepEqual(runtime.opened, []);
    assert.equal(data.dropEffect, "move"); assert.deepEqual(runtime.hot(), []);
  },
  "가운데 파일 표시는 dragover만 켜고 파일 내용을 dragover에서 읽지 않는다"() {
    for (const kind of ["dragenter", "dragleave", "drop", "dragend", "blur"]) assert.equal(centerFileDragHotNext(kind, true), false);
    assert.equal(centerFileDragHotNext("dragover", true), true);
    assert.equal(centerFileDragHotNext("dragover", false), false);
    const runtime = setup(), data = transfer([]);
    Object.defineProperty(data, "items", { get() { throw new Error("protected data"); } });
    dispatch(runtime.tabstrip, "dragenter", data); assert.deepEqual(runtime.hot(), []);
    const event = dispatch(runtime.tabstrip, "dragover", data);
    assert.equal(event.defaultPrevented, true); assert.equal(data.dropEffect, "copy");
    assert.deepEqual(runtime.hot(), ["tabstrip"]);
    dispatch(runtime.editor, "dragover", data); assert.deepEqual(runtime.hot(), ["center-body"]);
  },
  "가운데 파일 표시는 바깥 이동·놓기·종료·창 이탈·포커스 상실에 꺼진다"() {
    for (const kind of ["outside-over", "non-file-over", "outside-drop", "drop", "dragend", "dragleave", "blur"]) {
      const runtime = setup(); dispatch(runtime.editor, "dragover", transfer());
      if (kind === "outside-over") dispatch(runtime.terminal, "dragover", transfer());
      else if (kind === "non-file-over") dispatch(runtime.editor, "dragover", transfer([], { types: ["text/plain"] }));
      else if (kind === "outside-drop") dispatch(runtime.terminal, "drop", transfer());
      else dispatch(kind === "blur" ? runtime.window : runtime.editor, kind, transfer());
      assert.deepEqual(runtime.hot(), [], kind); assert.equal(runtime.timers.size, 0, kind);
    }
  },
  "가운데 파일 표시는 자식 이동에 유지되고 사건이 없어도 유휴 시계로 꺼진다"() {
    assert.ok(CENTER_DROP_IDLE_MS > 350 && CENTER_DROP_IDLE_MS <= 2000);
    const runtime = setup(); dispatch(runtime.editor, "dragover", transfer());
    dispatch(runtime.editor, "dragleave", transfer(), { relatedTarget: runtime.centerBody });
    assert.deepEqual(runtime.hot(), ["center-body"]);
    runtime.advance(CENTER_DROP_IDLE_MS - 1); assert.deepEqual(runtime.hot(), ["center-body"]);
    dispatch(runtime.editor, "dragover", transfer());
    assert.equal(runtime.timers.size, 1);
    runtime.advance(1); assert.deepEqual(runtime.hot(), ["center-body"]);
    runtime.advance(CENTER_DROP_IDLE_MS - 1); assert.deepEqual(runtime.hot(), []);
    dispatch(runtime.editor, "dragover", transfer()); runtime.dispose();
    assert.equal(runtime.timers.size, 0); assert.deepEqual(runtime.hot(), []);
    dispatch(runtime.editor, "drop", transfer()); assert.deepEqual(runtime.opened, []);
  },
  "가운데 파일 드롭은 편집기 자체 삽입을 막고 xterm 문서 차단·터미널 드롭과 공존한다"() {
    const runtime = setup(), wiring = read("web/js/panel/xterm-wiring.js");
    const start = wiring.indexOf("  const hasFiles = (dt)"), end = wiring.indexOf("  startPty();", start);
    assert.ok(start >= 0 && end > start);
    runInNewContext(wiring.slice(start, end), runtime);
    let editorDrops = 0; runtime.editor.addEventListener("drop", () => editorDrops++);
    dispatch(runtime.terminal, "dragover", transfer());
    dispatch(runtime.editor, "drop", transfer());
    assert.equal(editorDrops, 0);
    assert.deepEqual(runtime.hooks.at(-1), ["chatcopy.dragHint", "drop", false]);
    const terminalData = transfer(); dispatch(runtime.terminal, "drop", terminalData);
    assert.equal(runtime.opened.length, 1);
    assert.deepEqual(runtime.hooks.filter(([name]) => name === "chatcopy.dropFiles"), [["chatcopy.dropFiles", terminalData.files]]);
    const outside = element("outside", runtime.document);
    assert.equal(dispatch(outside, "drop", transfer()).defaultPrevented, true);
  },
  "가운데 파일 드롭은 main에서 실제 의존성을 받고 표시 CSS가 연결된다"() {
    const source = read("web/js/main.js"), css = read("web/css/11-center-tabs.css");
    assert.match(source, /import \{ initCenterFileDrop \} from "\.\/center\/file-drop\.js"/);
    const start = source.indexOf("if (!AUX_MODE || BROWSER_MODE) initCenterFileDrop({"), end = source.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start);
    const runtime = setup(), calls = [];
    const context = { ...runtime, AUX_MODE: false, BROWSER_MODE: false, browserview: null, openDroppedLocal: () => {},
      $: (selector) => selector === "#center-body" ? runtime.centerBody : null,
      initCenterFileDrop: (deps) => calls.push(deps) };
    runtime.window.acHost = runtime.acHost;
    runInNewContext(source.slice(start, end + 4), context);
    assert.equal(calls.length, 1);
    for (const key of ["tabstrip", "centerBody", "document", "window", "acHost", "openFile", "showToast", "callHook"]) assert.equal(calls[0][key], runtime[key], key);
    runInNewContext(source.slice(start, end + 4), { ...context, AUX_MODE: true }); assert.equal(calls.length, 1);
    runInNewContext(source.slice(start, end + 4), { ...context, AUX_MODE: true, BROWSER_MODE: true });
    assert.equal(calls.length, 2); assert.equal(calls[1].browserWindow, true);
    assert.equal(calls[1].openDroppedLocal, context.openDroppedLocal);
    assert.match(css, /\.tabstrip\.center-drop-hot::after, \.center-body\.center-drop-hot::after\s*\{[^}]*content:"파일 열기"[^}]*pointer-events:none/);
    assert.match(css, /\.tabstrip\.center-drop-hot\s*\{[^}]*outline:2px dashed var\(--primary\);[^}]*outline-offset:-2px/);
    assert.ok(!read("web/js/core/capabilities.js").includes("center/file-drop.js"));
  },
};

export default async function run() {
  for (const [name, test] of Object.entries(cases)) await checkAsync(name, test);
}
