import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { createQaExpectCommands } = require("../native/electron/cdp-qa-expect.cjs");

function fixture({ sessions = [null], trees, values = {}, failure, ownerVisible = true } = {}) {
  const calls = [], contexts = new Map();
  let nextContext = 1;
  const run = async (sid, method, params = {}) => {
    calls.push({ sid, method, params });
    if (failure) { const failed = failure(sid, method, params); if (failed) throw new Error(failed); }
    if (method === "Page.getFrameTree") return { frameTree: trees?.[sid ?? "main"] || { frame: { id: sid || "main" } } };
    if (method === "Page.createIsolatedWorld") { const id = nextContext++; contexts.set(id, params.frameId); return { executionContextId: id }; }
    if (method === "DOM.getFrameOwner") return { backendNodeId: 9 };
    if (method === "DOM.resolveNode") return { object: { objectId: "owner" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: ownerVisible } };
    if (method === "Runtime.evaluate") {
      const result = values[contexts.get(params.contextId)] ?? { entries: [], queried: 0 };
      return result.exceptionDetails ? result : { result: { value: result } };
    }
    return {};
  };
  const send = (method, params) => run(null, method, params);
  send.on = (sid) => (method, params) => run(sid, method, params);
  send.frames = () => sessions;
  const shots = [];
  const commands = createQaExpectCommands({ screenshot: async (...args) => { shots.push(args); return { path: "/qa/evidence.png" }; } });
  return { send, calls, shots, expect: (args) => commands["qa-expect"](send, { getURL: () => "https://example.test/" }, args) };
}

const entry = (text, tag = "button") => ({ text, tag });
const result = (...entries) => ({ entries, queried: entries.length });

test("QA expect uses a fresh isolated world for every frame and includes screenshot results", async () => {
  const f = fixture({ sessions: [null, "oop"], trees: {
    main: { frame: { id: "main" }, childFrames: [{ frame: { id: "same" } }, { frame: { id: "cross" } }] },
    oop: { frame: { id: "cross" } },
  }, values: { main: result(), same: result(entry("완료")), cross: result(entry("저장")) } });
  const out = await f.expect({ mode: "contains", sel: "button", text: "저장" });
  assert.equal(out.pass, true);
  assert.equal(out.frames, 3);
  assert.equal(out.matched, 2);
  assert.equal(out.shot, "/qa/evidence.png");
  assert.equal(out.url, "https://example.test/");
  const worlds = f.calls.filter((call) => call.method === "Page.createIsolatedWorld");
  assert.deepEqual(worlds.map((call) => [call.sid, call.params.frameId]), [[null, "main"], [null, "same"], ["oop", "cross"]]);
  for (const call of f.calls.filter((call) => call.method === "Runtime.evaluate")) {
    assert.ok(call.params.contextId > 0);
    assert.match(call.params.expression, /document.querySelectorAll/);
    assert.doesNotMatch(call.params.expression, /__acQA|window\./);
  }
  await f.expect({ mode: "exists", sel: "button" });
  assert.notEqual(f.calls.filter((call) => call.method === "Page.createIsolatedWorld").at(-1).params.worldName, worlds[0].params.worldName);
});

test("QA absent checks every frame and does not accept an earlier frame with no matching text", async () => {
  const f = fixture({ sessions: [null, "oop"], values: { main: result(entry("待機")), oop: result(entry("保存済み")) } });
  const absent = await f.expect({ mode: "absent", sel: "button", text: "保存" });
  assert.equal(absent.pass, false);
  assert.equal(absent.got, "保存済み");
  assert.equal((await f.expect({ mode: "contains", sel: "button", text: "保存" })).pass, true);
  assert.equal((await f.expect({ mode: "equals", sel: "button", text: "保存済み" })).pass, true);
  assert.equal((await f.expect({ mode: "equals", sel: "button", text: "保存" })).pass, false);
  assert.equal((await f.expect({ mode: "absent", sel: "button", text: "不存在" })).pass, true);
  assert.equal((await f.expect({ mode: "absent", sel: "button" })).pass, false);
});

test("QA hidden iframe contents cannot satisfy exists or contains", async () => {
  const f = fixture({ trees: { main: { frame: { id: "main" }, childFrames: [{ frame: { id: "hidden" } }] } },
    values: { hidden: result(entry("저장")) }, ownerVisible: false });
  assert.equal((await f.expect({ mode: "exists", sel: "button" })).pass, false);
  assert.equal((await f.expect({ mode: "contains", sel: "button", text: "저장" })).pass, false);
  assert.equal((await f.expect({ mode: "absent", sel: "button" })).pass, true);
  assert.ok(f.calls.some((call) => call.method === "DOM.resolveNode" && call.params.executionContextId));
  assert.ok(f.calls.some((call) => call.method === "Runtime.releaseObject"));
});

test("QA inspection exceptions, incomplete frame lists, and malformed results always fail closed", async () => {
  const cases = [
    fixture({ sessions: [] }),
    fixture({ sessions: ["oop"] }),
    fixture({ trees: { main: { frame: {} } } }),
    fixture({ values: { main: { exceptionDetails: { text: "SyntaxError" } } } }),
    fixture({ values: { main: { pass: true, found: false } } }),
    fixture({ sessions: [null, "oop"], values: { main: result(entry("저장")) }, failure: (sid, method) => sid === "oop" && method === "Runtime.evaluate" ? "frame detached" : null }),
    fixture({ failure: (_sid, method) => method === "Page.createIsolatedWorld" ? "world failed" : null }),
    fixture({ trees: { main: { frame: { id: "main" }, childFrames: [{ frame: { id: "child" } }] } },
      failure: (_sid, method) => method === "DOM.getFrameOwner" ? "owner failed" : null }),
  ];
  for (const f of cases) {
    const out = await f.expect({ mode: "absent", sel: "[" });
    assert.equal(out.pass, false);
    assert.ok(out.inspectionError);
    assert.equal(out.shot, "/qa/evidence.png");
    assert.equal(f.shots.length, 1);
  }
});

test("QA screenshot errors cannot produce a passing receipt", async () => {
  const { send } = fixture({ values: { main: result(entry("저장")) } });
  for (const screenshot of [async () => ({ error: "capture failed" }), async () => ({}), async () => { throw new Error("disk full"); }]) {
    const out = await createQaExpectCommands({ screenshot })["qa-expect"](send, { getURL: () => "https://example.test/" }, { mode: "exists" });
    assert.equal(out.pass, false);
    assert.equal(out.shot, null);
    assert.ok(out.shotError);
  }
});

test("QA expect rejects unsupported modes and missing comparison text", async () => {
  const f = fixture();
  await assert.rejects(f.expect({ mode: "truthy" }), /지원하지/);
  await assert.rejects(f.expect({ mode: "contains" }), /문자가 필요/);
  await assert.rejects(f.expect({ mode: "exists", sel: "" }), /선택자/);
  assert.equal(f.calls.length, 0);
});

test("QA query expression ignores forged page helpers and excludes unrendered elements and text", async () => {
  const f = fixture();
  await f.expect({ mode: "absent", sel: "button" });
  const expression = f.calls.find((call) => call.method === "Runtime.evaluate").params.expression;
  const rect = { width: 20, height: 10, top: 0, left: 0, right: 20 };
  const element = (css = {}, tag = "button") => ({ localName: tag, parentElement: null,
    css: { display: "block", visibility: "visible", opacity: "1", ...css }, getClientRects: () => [rect], getBoundingClientRect: () => ({...rect,x:0,y:0}) });
  const shown = element(), hidden = element({ display: "none" }), transparent = element({ opacity: "0" });
  const hiddenParent = element({ opacity: "0" }), hiddenChild = element(); hiddenChild.parentElement = hiddenParent;
  const invisibleText = { parentElement: element({ visibility: "hidden" }), textContent: "가짜" };
  const text = { parentElement: shown, textContent: "저장" };
  let queried;
  const scope = {
    __acQA: () => { throw new Error("page helper must never run"); },
    getComputedStyle: (node) => node.css,
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      querySelectorAll: (selector) => { queried = selector; return [shown, hidden, transparent, hiddenChild]; },
      createTreeWalker: (node) => { const nodes = node === shown ? [text, invisibleText] : []; let at = 0; return { nextNode: () => nodes[at++] }; },
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => [rect] }),
    },
  };
  const out = vm.runInNewContext(expression, scope);
  assert.equal(queried, "button");
  assert.equal(out.queried, 4);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].text, "저장");
  const input = element({}, "input"), password = element({}, "input"), checkbox = element({}, "input"), select = element({}, "select");
  Object.assign(input, { type: "text", value: "  표시  문자  " });
  Object.assign(password, { type: "password", value: "비밀" });
  Object.assign(checkbox, { type: "checkbox", value: "on" });
  select.selectedOptions = [{ label: "선택값" }];
  scope.document.querySelectorAll = () => [input, password, checkbox, select];
  const fields = vm.runInNewContext(expression, scope);
  assert.deepEqual(Array.from(fields.entries, (item) => item.text), ["표시 문자", "", "", "선택값"]);
  scope.document.querySelectorAll = () => { throw new SyntaxError("invalid selector"); };
  assert.throws(() => vm.runInNewContext(expression, scope), /invalid selector/);
});
