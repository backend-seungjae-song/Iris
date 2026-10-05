// 분리 창은 탭 여러 개를 담는다. 그 창에서 만든 새 탭은 그 창에 들어가고, 다른 분리 창의 띠로 끌어다
// 놓은 탭은 그 창으로 옮겨 가며, 탭이 다 빠진 창은 닫힌다.
// 확인 결과: 분리 창이 탭 하나에 묶여 있어 그 창에서 새 탭을 만들 수 없었다.
// Electron 은 띄우지 않는다. BrowserWindow·ipcMain·screen 을 흉내로 넣고 장부와 판정만 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDetachedTabWindows } = require("../native/electron/detached-tab-window.cjs");

function setup() {
  const all = [];
  let nextId = 10;
  class FakeWindow {
    constructor(opts) {
      this.opts = opts; this.destroyed = false; this.listeners = {}; this.sent = [];
      this.bounds = { x: 0, y: 0, width: opts.width || 800, height: opts.height || 600 };
      const self = this;
      this.webContents = {
        id: nextId++, on() {}, setWindowOpenHandler() {},
        send(ch, payload) { self.sent.push([ch, payload]); },
      };
      all.push(this);
    }
    static getAllWindows() { return all.filter((w) => !w.destroyed); }
    on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
    show() {} showInactive() {} focus() {}
    isDestroyed() { return this.destroyed; }
    isFocused() { return false; }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    setBounds(b) { Object.assign(this.bounds, b); }
    close() { if (this.destroyed) return; this.destroyed = true; for (const fn of this.listeners.closed || []) fn(); }
  }
  const handlers = new Map(), listeners = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) };
  const loaded = [];
  const cursor = { x: 0, y: 0 };
  const api = createDetachedTabWindows({
    BrowserWindow: FakeWindow, ipcMain, preloadPath: "", webviewPreloadPath: "",
    windowLayout: { ownWindowTitle() {} }, guardWebviewPartition() {}, pinHiddenViewportById() {},
    webContents: {}, shell: { openExternal() {} }, loadUrlWithRetry: (w, url) => loaded.push(url),
    getAppUrl: () => "http://127.0.0.1:1", noThrottleOpt: false, isTrustedSender: () => true,
    isAppQuitting: () => false, markAppAlive() {}, log() {},
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
  });
  api.registerDetachedTabIpc();
  api.tabDrag.registerTabDragIpc();
  const main = new FakeWindow({});   // 띠를 그리는 원래 창
  return { api, FakeWindow, handlers, listeners, loaded, cursor, main };
}

const byTab = (snap) => Object.fromEntries(snap.map((x) => [x.tabId, x.win]));

test("분리 창의 주소에 창 id 가 있고, 그 창에 새 탭을 넣을 수 있다", () => {
  const { api, loaded } = setup();
  api.openDetachedTab({ space: "s1", tabId: "a" });
  const win = api.detachedTabs()[0].win;
  assert.match(loaded[0], new RegExp(`[?&]win=${win}(&|$)`));
  assert.equal(api.claimTab(win, "b", "s1"), true);
  assert.deepEqual(byTab(api.detachedTabs()), { a: win, b: win });
});

test("다른 스페이스의 탭은 받지 않는다", () => {
  const { api } = setup();
  api.openDetachedTab({ space: "s1", tabId: "a" });
  const win = api.detachedTabs()[0].win;
  assert.equal(api.claimTab(win, "x", "__shared__"), false);
  assert.deepEqual(byTab(api.detachedTabs()), { a: win });
});

test("탭이 여럿인 분리 창에서 하나를 다시 빼면 새 창으로 가고 원래 창은 남는다", () => {
  const { api } = setup();
  api.openDetachedTab({ space: "s1", tabId: "a" });
  const w1 = api.detachedTabs()[0].win;
  api.claimTab(w1, "b", "s1");
  api.openDetachedTab({ space: "s1", tabId: "b" });
  const map = byTab(api.detachedTabs());
  assert.equal(map.a, w1);
  assert.notEqual(map.b, w1);
});

test("마지막 탭을 되돌리면 창이 닫히고 목록에서 빠진다", () => {
  const { api, main } = setup();
  const win = api.openDetachedTab({ space: "s1", tabId: "a" });
  const wid = api.detachedTabs()[0].win;
  api.claimTab(wid, "b", "s1");
  api.reattachTab("a");
  assert.equal(win.isDestroyed(), false);
  api.reattachTab("b");
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(api.detachedTabs(), []);
  // 닫힌 뒤의 방송은 남은 창에 빈 목록으로 간다
  const last = main.sent.at(-1);
  assert.deepEqual(last && last[1], { tabs: [] });
});

test("창을 닫으면 그 창의 탭이 모두 원래 띠로 돌아간다", () => {
  const { api } = setup();
  const win = api.openDetachedTab({ space: "s1", tabId: "a" });
  api.claimTab(api.detachedTabs()[0].win, "b", "s1");
  win.close();
  assert.deepEqual(api.detachedTabs(), []);
});

test("혼자 있는 탭의 창을 다른 분리 창 띠에 놓으면 그 창으로 옮겨 가고 끌던 창은 닫힌다", async () => {
  const { api, handlers, listeners, cursor } = setup();
  const target = api.openDetachedTab({ space: "s1", tabId: "a" });
  const targetWin = api.detachedTabs()[0].win;
  const dragged = api.openDetachedTab({ space: "s1", tabId: "b" });
  // 대상 창의 띠: 화면 (0,0)~(400,30). 끌던 창은 멀리 둔다.
  dragged.setBounds({ x: 2000, y: 2000 });
  listeners.get("ac-tabstrip-rect")({ sender: { id: target.webContents.id, once() {} } },
    { left: 0, top: 0, w: 400, h: 30, space: "s1", win: targetWin });
  const sender = { sender: { id: dragged.webContents.id } };
  cursor.x = 2010; cursor.y = 2010;
  const start = await handlers.get("ac-tabdrag-start")(sender, { tabId: "b", space: "s1" });
  assert.equal(start.state, "window");
  await handlers.get("ac-tabdrag-move")(sender, { x: 50, y: 10 });
  assert.deepEqual(byTab(api.detachedTabs()), { a: targetWin, b: targetWin });
  assert.equal(dragged.isDestroyed(), true);
});

test("탭이 여럿인 분리 창에서 끌기를 시작하면 창이 아니라 탭을 끈다", async () => {
  const { api, handlers } = setup();
  const win = api.openDetachedTab({ space: "s1", tabId: "a" });
  api.claimTab(api.detachedTabs()[0].win, "b", "s1");
  const start = await handlers.get("ac-tabdrag-start")({ sender: { id: win.webContents.id } }, { tabId: "b", space: "s1" });
  assert.equal(start.state, "tabs");
});
