import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptsUrl,
  liveCommandForInput,
  initCapability,
} from "../web/js/browser/chrome-mirror-surface.js";
import { callHook, clearHooks } from "../web/js/core/hooks.js";

test("기존 mirror 입력을 좁은 live Page/Input 명령으로 변환한다", () => {
  assert.deepEqual(liveCommandForInput({ kind: "navigation", command: "back" }), {
    command: "Navigation.back", args: {},
  });
  assert.deepEqual(liveCommandForInput({ kind: "navigation", command: "forceReload" }), {
    command: "Page.reload", args: { ignoreCache: true },
  });
  assert.deepEqual(liveCommandForInput({ kind: "text", text: "입력" }), {
    command: "Input.insertText", args: { text: "입력" },
  });
  assert.deepEqual(liveCommandForInput({ kind: "mouse", type: "press", x: 2, y: 3,
    button: "left", buttons: 1, clickCount: 1, modifiers: 4 }), {
    command: "Input.dispatchMouseEvent",
    args: { type: "mousePressed", x: 2, y: 3, button: "left", buttons: 1, clickCount: 1, modifiers: 4 },
  });
  assert.equal(liveCommandForInput({ kind: "navigation", command: "Browser.close" }), null);
  assert.equal(liveCommandForInput({ kind: "storage", command: "cookies" }), null);
});

test("live session stays in Chrome across sites while dedicated mirrors retain host scope", () => {
  assert.equal(acceptsUrl({transport:"live",mode:"manual",manualHost:"first.test"},"https://second.test/"),true);
  assert.equal(acceptsUrl({transport:"dedicated",mode:"manual",manualHost:"first.test"},"https://second.test/"),false);
  assert.equal(acceptsUrl({transport:"live"},"file:///tmp/secret"),false);
  assert.equal(acceptsUrl({transport:"live"},"https://user:secret@example.test/"),false);
});

test("Google 거절 문서는 현재 Chrome 연결 안내를 자동으로 띄우지 않는다", (t) => {
  const originalDocument = globalThis.document;
  const visible = new Set();
  const element = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() { visible.delete(this); } });
  globalThis.document = { createElement: element, body: { appendChild(el) { visible.add(el); } } };
  t.after(() => { globalThis.document = originalDocument; clearHooks(); });
  let active = "rejected";
  const rec = { tabId: "rejected", url: "https://accounts.google.com/v3/signin/rejected",
    el: { classList: { contains: () => active === "rejected" } } };
  const other = { tabId: "other", url: "https://example.com/",
    el: { classList: { contains: () => active === "other" } } };
  const noop = () => {};
  clearHooks();
  initCapability({ acHost: { mirrorStart: noop, mirrorInput: noop, mirrorResize: noop,
    mirrorStop: noop, onMirrorFrame: noop, onMirrorMeta: noop },
    getWebviewEntries: () => [[rec.tabId, rec], [other.tabId, other]] });
  assert.equal(visible.size, 0);
  callHook("mirror.navigation", rec, { phase: "commit", url: rec.url });
  assert.equal(visible.size, 0);
  active = "other";
  callHook("mirror.activeTab", active);
  assert.equal(visible.size, 0);
  active = "rejected";
  callHook("mirror.activeTab", active);
  assert.equal(visible.size, 0);
});

test("진짜 Chrome으로 열기는 선택창 없이 전용 mirror를 바로 시작한다", async (t) => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const dialogs = [];
  const stack = { appendChild(el) { el.parentElement = stack; }, getBoundingClientRect: () => ({ width: 900, height: 700 }) };
  const surface = () => ({
    style: {}, dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, remove() {},
    focus() {}, getBoundingClientRect: () => ({ width: 900, height: 700 }),
  });
  globalThis.document = {
    createElement(tag) { return tag === "img" ? surface() : { ...surface(), appendChild() {} }; },
    body: { appendChild(el) { dialogs.push(el); } }, activeElement: null,
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; clearHooks(); });

  const starts = [];
  let liveConnects = 0;
  const rec = { tabId: "direct-dedicated", url: "https://example.com/account",
    el: { classList: { contains: () => true }, loadURL: async () => {} } };
  const noop = () => {};
  clearHooks();
  initCapability({
    acHost: {
      mirrorStart: async (input) => { starts.push(input); return { ok: true, mirrorId: "dedicated-1" }; },
      mirrorInput: noop, mirrorResize: noop, mirrorStop: noop, onMirrorFrame: noop, onMirrorMeta: noop,
      liveChromeConnect: () => { liveConnects += 1; return { ok: false }; },
    },
    $: (selector) => selector === "#wv-stack" ? stack : null,
    getWebviewEntries: () => [[rec.tabId, rec]],
  });

  const item = callHook("mirror.tabItem", rec);
  assert.equal(item.label, "진짜 Chrome으로 열기");
  item.act();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialogs.length, 0);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].url, rec.url);
  assert.equal(starts[0].manualHost, "example.com");
  assert.equal(liveConnects, 0);
  callHook("mirror.navigation", rec, { phase: "destroy", url: rec.url });
});
