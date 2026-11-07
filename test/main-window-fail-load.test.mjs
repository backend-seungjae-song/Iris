import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const { createMainWindow } = createRequire(import.meta.url)("../native/electron/main-window.cjs");

// 앱 화면 안의 iframe 하나가 실패해도 앱 화면 전체를 다시 불러오면 화면이 번쩍임
function harness() {
  const handlers = {};
  const timers = [];
  let loads = 0;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, getType: () => "window" });
    }
    isDestroyed() { return false; }
    loadURL() { loads++; return Promise.resolve(); }
  }
  const api = createMainWindow({
    app: { on: (name, fn) => { handlers[name] = fn; } },
    BrowserWindow: FakeWindow,
    webContents: {},
    dialog: {}, shell: {},
    windowLayout: { applySavedBounds: () => null, ownWindowTitle() {}, boundsVisible: () => true,
      trackWindowBounds() {}, restoreWhenDisplayReturns() {}, placeSavedBounds() {} },
    guardWebviewPartition() {}, pinHiddenViewportById() {}, markAppAlive() {},
    appUrl: "http://127.0.0.1:4271/", console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, setImmediate() {},
  });
  api.createWindow();
  const win = api.getWindow();
  handlers["web-contents-created"](null, win.webContents);
  const reloadsAfter = (...args) => {
    const before = loads;
    win.webContents.emit("did-fail-load", {}, ...args);
    while (timers.length) timers.shift()();
    return loads - before;
  };
  return { reloadsAfter };
}

test("앱 화면 안 iframe 이 실패하면 앱 화면을 다시 불러오지 않음", () => {
  const { reloadsAfter } = harness();
  assert.equal(reloadsAfter(-102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:4271/paseo-ui/?panel=chat-settings", false), 0);
});

test("앱 화면 자체를 못 불러왔으면 다시 시도함", () => {
  const { reloadsAfter } = harness();
  assert.equal(reloadsAfter(-102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:4271/", true), 1);
  assert.equal(reloadsAfter(-3, "ERR_ABORTED", "http://127.0.0.1:4271/", true), 0, "취소는 재시도하지 않음");
});
