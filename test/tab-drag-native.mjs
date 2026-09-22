// 네이티브 탭 끌기 판정을 실제로 돌려 본다.
//
// 배경: 렌더러 쪽은 test/tab-drag-events.mjs 가 검사하지만 판정은 전부 네이티브에 있어
// 검사되지 않았다. 그래서 크롬 원본의 한 줄이 빠진 것을 어떤 검사도 잡지 못했다.
// 끄는 동안 그 창을 판정에서 빼는 부분(tab_drag_controller.cc:1334 의 exclude_dragged_view)이다.
// 그것이 빠지면 끌던 창이 늘 커서 아래에 있어 자기 띠에 자기가 붙고, attachTo 가 그 창을
// 닫아 탭이 원래 자리로 돌아간다.
//
// Electron 은 안 띄운다. createTabDrag 가 BrowserWindow·screen 을 밖에서 받으므로 흉내로
// 갈아끼우고 판정만 본다. 창이 실제로 어떻게 그려지는지는 사람이 확인한다.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTabDrag } = require("../native/electron/tab-drag.cjs");

function makeWin(wcId, bounds) {
  return {
    webContents: { id: wcId },
    _bounds: { ...bounds },
    _focused: false,
    _shown: 0,
    _activated: 0,
    isDestroyed: () => false,
    isFocused() { return this._focused; },
    getBounds() { return { ...this._bounds }; },
    getContentBounds() { return { ...this._bounds }; },
    setBounds(b) { Object.assign(this._bounds, b); },
    show() { this._shown++; this._activated++; },
    showInactive() { this._shown++; },
    focus() { this._activated++; },
  };
}

// 띠는 창 안 상대 좌표로 보고된다. 창 왼쪽 위에서 (0,0) 크기 400x30 으로 둔다.
const STRIP = { left: 0, top: 0, w: 400, h: 30 };

function harness() {
  const calls = { opened: [], closed: [], cursor: { x: 0, y: 0 } };
  const wins = new Map();

  // 메인 창: 화면 (100,100) 에 있고 띠는 (100,100)~(500,130).
  const main = makeWin(1, { x: 100, y: 100, width: 800, height: 600 });
  wins.set(1, main);

  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
  };
  const BrowserWindow = { getAllWindows: () => [...wins.values()] };
  const screen = { getCursorScreenPoint: () => ({ ...calls.cursor }) };

  let nextWc = 10;
  const detached = new Map();   // tabId → win

  const api = createTabDrag({
    BrowserWindow, ipcMain, screen,
    isTrustedSender: () => true,
    openDetachedTab: ({ space, tabId, title, activate = true }) => {
      calls.opened.push({ space, tabId, title, activate });
      const w = makeWin(nextWc++, { x: 0, y: 0, width: 500, height: 400 });
      // 실제 모듈과 같다. activate 면 show+focus, 아니면 showInactive.
      if (activate) { w.show(); w.focus(); } else w.showInactive();
      w._focused = true;           // 겹칠 때 위로 본다
      wins.set(w.webContents.id, w);
      detached.set(tabId, w);
      return w;
    },
    closeDetachedTab: (tabId) => {
      calls.closed.push(tabId);
      const w = detached.get(tabId);
      if (w) { wins.delete(w.webContents.id); detached.delete(tabId); }
    },
    detachedWindowFor: (tabId) => detached.get(tabId) || null,
    log: () => {},
  });
  api.registerTabDragIpc();

  const send = (ch, wcId, arg) => listeners.get(ch)({ sender: { id: wcId, once: () => {} } }, arg);
  const call = (ch, wcId, arg) => handlers.get(ch)({ sender: { id: wcId, once: () => {} } }, arg);

  // 메인 창의 띠를 보고한다.
  send("ac-tabstrip-rect", 1, { ...STRIP, space: "sp1", tab: "" });

  // 분리 창이 뜨면 그 창도 자기 띠를 보고한다(실제 렌더러가 그렇게 한다).
  const reportDetached = (tabId) => {
    const w = detached.get(tabId);
    send("ac-tabstrip-rect", w.webContents.id, { ...STRIP, space: "sp1", tab: tabId });
    return w;
  };

  return { calls, wins, main, detached, send, call, reportDetached, api };
}

const START = { tabId: "t1", space: "sp1", title: "제목", grabDx: 40, grabDy: 10 };

test("띠를 벗어나면 그 자리에서 창이 된다", () => {
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  // 메인 띠는 (100,100)~(500,130). 한참 아래로 내려간다.
  const r = h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  assert.equal(r.state, "window", "띠를 벗어났는데 창이 안 됐다");
  assert.equal(h.calls.opened.length, 1);
  assert.deepEqual(h.calls.opened[0], { space: "sp1", tabId: "t1", title: "제목", activate: false });
});

test("끌기로 만든 창은 포커스를 가져가지 않는다", () => {
  // 가져가면 끌던 창이 포커스를 잃고 그 순간 마우스 이벤트가 끊긴다. 끌기가 끝나지도 못한 채
  // 멈춰서, 나중에 그 창을 누르면 멈춰 있던 끌기가 다시 시작된다. 누르지 않은 탭이 돌아오며 끌린다.
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  assert.equal(h.calls.opened[0].activate, false, "끌기로 만든 창이 포커스를 가져간다");
  const w = h.detached.get("t1");
  assert.equal(w._shown, 1, "창을 안 띄웠다");
  assert.equal(w._activated, 0, "창이 포커스를 가져갔다");
});

test("띠 안에서는 창을 만들지 않는다", () => {
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  const r = h.call("ac-tabdrag-move", 1, { x: 300, y: 115 });
  assert.equal(r.state, "tabs");
  assert.equal(h.calls.opened.length, 0);
});

test("세로 15px 자석 — 띠 바로 위아래는 아직 붙어 있다", () => {
  // 크롬: kVerticalDetachMagnetism = 15. 띠 아래 끝은 y=130.
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  assert.equal(h.call("ac-tabdrag-move", 1, { x: 300, y: 144 }).state, "tabs", "14px 아래인데 떨어졌다");

  const h2 = harness();
  h2.call("ac-tabdrag-start", 1, START);
  assert.equal(h2.call("ac-tabdrag-move", 1, { x: 300, y: 145 }).state, "window", "15px 아래인데 안 떨어졌다");
});

test("끌고 있는 창 자신의 띠에는 안 붙는다", () => {
  // 이것이 그 결함이다. 끌던 창은 커서를 따라다니므로 늘 커서 아래에 있다.
  // 판정에서 빼지 않으면 자기 띠에 자기가 붙어 attachTo 가 그 창을 닫는다.
  // 사용자에게는 끌자마자 탭이 원래 자리로 돌아가는 것으로 보인다.
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });      // 분리
  h.reportDetached("t1");                                 // 새 창이 자기 띠를 보고한다

  const before = h.calls.closed.length;
  // 계속 끈다. 창은 커서를 따라왔으므로 커서는 그 창의 띠 위에 있다.
  const r = h.call("ac-tabdrag-move", 1, { x: 305, y: 405 });
  assert.equal(r.state, "window", "자기 띠에 붙어 창 상태를 잃었다");
  assert.equal(h.calls.closed.length, before, "자기 띠에 붙어 창이 닫혔다");
});

test("이미 창인 탭을 끌어도 자기 띠에 안 붙는다", () => {
  // 같은 결함의 다른 진입 경로다. 분리 창에서 끌기를 새로 시작하는 경우다.
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const w = h.reportDetached("t1");
  h.call("ac-tabdrag-end", 1);

  // 그 창 안에서 다시 잡는다.
  h.calls.cursor = { x: w._bounds.x + 60, y: w._bounds.y + 12 };
  const s = h.call("ac-tabdrag-start", w.webContents.id, START);
  assert.equal(s.state, "window", "이미 창인 탭인데 창 끌기로 안 봤다");

  const before = h.calls.closed.length;
  const r = h.call("ac-tabdrag-move", w.webContents.id, { x: h.calls.cursor.x + 5, y: h.calls.cursor.y + 5 });
  assert.equal(r.state, "window");
  assert.equal(h.calls.closed.length, before, "끌자마자 자기 창이 닫혔다 — 탭이 돌아간다");
});

test("이미 창인 탭은 잡은 자리를 창 기준으로 다시 잰다", () => {
  // 렌더러가 주는 grabDx 는 칩 안의 offset 이다. 그대로 쓰면 첫 이동에서 창이 커서 쪽으로 튄다.
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const w = h.reportDetached("t1");
  h.call("ac-tabdrag-end", 1);

  w._bounds.x = 700; w._bounds.y = 500;
  h.calls.cursor = { x: 760, y: 512 };     // 창 기준 (60, 12)
  h.call("ac-tabdrag-start", w.webContents.id, START);
  h.call("ac-tabdrag-move", w.webContents.id, { x: 760, y: 512 });
  assert.equal(w._bounds.x, 700, "창이 가로로 튀었다");
  assert.equal(w._bounds.y, 500, "창이 세로로 튀었다");
});

test("다른 창의 띠에 들어가면 붙고 끌던 창은 닫힌다", () => {
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const w = h.reportDetached("t1");
  // 끌던 창이 메인 띠를 덮지 않도록 옆으로 옮긴다. 실제로도 커서가 메인 띠로 가면
  // 창이 따라가지만, 여기서는 판정만 본다.
  w._bounds.x = 2000; w._bounds.y = 2000;

  const r = h.call("ac-tabdrag-move", 1, { x: 300, y: 115 });   // 메인 띠 안
  assert.equal(r.state, "tabs", "메인 띠에 들어갔는데 안 붙었다");
  assert.deepEqual(h.calls.closed, ["t1"], "붙었는데 끌던 창이 안 닫혔다");
  assert.equal(h.main._shown, 1, "붙인 창을 앞으로 안 냈다");
});

test("창 끌기 중에는 매 이동마다 창이 커서를 따라온다", () => {
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const w = h.detached.get("t1");
  assert.equal(w._bounds.x, 300 - 40, "잡은 자리를 안 지켰다");
  assert.equal(w._bounds.y, 400 - 10);

  h.reportDetached("t1");
  h.call("ac-tabdrag-move", 1, { x: 500, y: 450 });
  assert.equal(w._bounds.x, 500 - 40, "창이 커서를 안 따라온다");
  assert.equal(w._bounds.y, 450 - 10);
});

test("띠를 보고하지 않은 창에는 안 붙는다", () => {
  // 메모 창처럼 띠가 없는 창. 창 크기로 짐작하면 여기에도 붙는다.
  const h = harness();
  const memo = makeWin(99, { x: 100, y: 100, width: 800, height: 600 });
  h.wins.set(99, memo);
  h.send("ac-tabstrip-rect", 99, null);      // 띠 없음을 알린다

  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const w = h.reportDetached("t1");
  w._bounds.x = 2000; w._bounds.y = 2000;

  // 메모 창 위지만 메인 띠(y 100~130) 밖인 자리.
  const r = h.call("ac-tabdrag-move", 1, { x: 300, y: 300 });
  assert.equal(r.state, "window", "띠 없는 창에 붙었다");
  assert.equal(h.calls.closed.length, 0);
});

test("놓기는 상태를 끝낼 뿐이다", () => {
  const h = harness();
  h.call("ac-tabdrag-start", 1, START);
  h.call("ac-tabdrag-move", 1, { x: 300, y: 400 });
  const opened = h.calls.opened.length;
  const closed = h.calls.closed.length;
  const r = h.call("ac-tabdrag-end", 1);
  assert.equal(r.state, "window");
  assert.equal(h.calls.opened.length, opened, "놓을 때 창을 또 만들었다");
  assert.equal(h.calls.closed.length, closed, "놓을 때 창을 닫았다");
  // 끝난 뒤의 이동은 아무 일도 안 한다.
  assert.equal(h.call("ac-tabdrag-move", 1, { x: 10, y: 10 }).skipped, "no-drag");
});
