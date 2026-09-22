// 창 위치 복원이 무슨 일을 했는지 실제로 실행해 본다.
//
// 배경: 이 결함은 모니터를 뽑았다 꽂아야 재현되어 사람만 확인할 수 있고, 보고만으로
// 고치면 같은 증상이 다시 나타난다.
// 그래서 (a) 그 회차에 무슨 일이 있었는지 기록이 남아야 하고 (b) 그 기록이 실제로
// 채워지는지를 여기서 검사한다. 기록이 비면 원인을 추측하게 된다.
//
// Electron 은 안 띄운다. createWindowLayout 이 screen·fs·시계를 밖에서 받으므로 흉내로 갈아끼운다.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createWindowLayout } = require("../native/electron/window-layout.cjs");
const { boundsVisible } = require("../native/electron/window-bounds.cjs");

// 예시 배치: 내장 하나와 외장 둘.
const INTERNAL = { id: 3, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, workArea: { x: 0, y: 25, width: 1728, height: 1092 }, scaleFactor: 2, internal: true };
const LEFT = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const RIGHT = { id: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1115 }, workArea: { x: 1920, y: 32, width: 1920, height: 1083 }, scaleFactor: 1 };

const ON_LEFT = { x: -1510, y: 130, width: 1100, height: 820 };
const ON_INTERNAL = { x: 96, y: 25, width: 1728, height: 1017 };

function makeWin(title, bounds) {
  return {
    __irisTitle: title,
    _bounds: { ...bounds },
    _max: false, _full: false,
    _listeners: new Map(),
    isDestroyed: () => false,
    getBounds() { return { ...this._bounds }; },
    getNormalBounds() { return { ...this._bounds }; },
    setBounds(b) { Object.assign(this._bounds, b); },
    isMaximized() { return this._max; },
    isFullScreen() { return this._full; },
    maximize() { this._max = true; },
    setFullScreen(v) { this._full = !!v; },
    setTitle() {},
    on(type, fn) { (this._listeners.get(type) || this._listeners.set(type, []).get(type)).push(fn); },
    once(type, fn) { this.on(type, fn); },
    emit(type, ...a) { for (const fn of [...(this._listeners.get(type) || [])]) fn(...a); },
  };
}

function harness({ displays = [INTERNAL, LEFT, RIGHT], state = {} } = {}) {
  let current = displays.slice();
  const screenHandlers = new Map();
  const files = new Map();
  let clock = 1_000_000;

  const screen = {
    getAllDisplays: () => current.slice(),
    getDisplayMatching: (b) => current.find((d) => b.x >= d.workArea.x && b.x < d.workArea.x + d.workArea.width) || current[0],
    on: (type, fn) => { (screenHandlers.get(type) || screenHandlers.set(type, []).get(type)).push(fn); },
  };
  const ui = { ...state };
  const layout = createWindowLayout({
    screen,
    windowBoundsVisible: boundsVisible,
    readUiState: () => ({ ...ui }),
    writeUiState: (patch) => Object.assign(ui, patch),
    fs: { writeFileSync: (p, text) => files.set(p, text) },
    path: { join: (...parts) => parts.join("/") },
    stateHome: () => "/state",
    now: () => clock,
  });

  const fire = (type, ...a) => { for (const fn of [...(screenHandlers.get(type) || [])]) fn(...a); };
  return {
    layout, ui, files, screen,
    setDisplays: (list) => { current = list.slice(); },
    fire,
    tick: (ms) => { clock += ms; },
    diagFile: () => {
      const text = files.get("/state/window-layout-diag.json");
      return text ? JSON.parse(text) : null;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 350));
const kinds = (h) => h.layout.diagEvents().map((e) => e.kind);
const lastOf = (h, kind) => [...h.layout.diagEvents()].reverse().find((e) => e.kind === kind) || null;

test("켤 때 저장된 자리를 썼는지 남는다", () => {
  const h = harness({ state: { browserBounds: { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } } } });
  const opts = {};
  h.layout.applySavedBounds(opts, "browserBounds");
  const ev = lastOf(h, "launch");
  assert.ok(ev, "켤 때 아무것도 안 남았다");
  assert.equal(ev.key, "browserBounds");
  assert.equal(ev.placed, true);
  assert.equal(opts.x, ON_LEFT.x, "저장된 자리를 안 썼다");
});

test("갈 모니터가 없으면 그 사실이 남는다", () => {
  // 로그인 직후 외장이 아직 안 붙은 상태. 여기서 기본 위치로 떨어지면 위치가 뒤바뀐다.
  const h = harness({
    displays: [INTERNAL],
    state: { browserBounds: { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } } },
  });
  h.layout.applySavedBounds({}, "browserBounds");
  const ev = lastOf(h, "launch");
  assert.equal(ev.placed, false);
  assert.match(ev.why, /안 겹친다/);
});

test("모니터가 빠지면 그 창을 붙들고, 그 사실과 그때 구성이 남는다", () => {
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");

  h.setDisplays([INTERNAL]);
  h.fire("display-removed");

  assert.equal(h.layout.isAwaiting(w), true, "빠진 모니터의 창을 안 붙들었다");
  const removed = lastOf(h, "display-removed");
  assert.ok(removed && Array.isArray(removed.displays), "그때의 모니터 구성이 안 남았다");
  assert.equal(removed.displays.length, 1);
  const hold = lastOf(h, "hold");
  assert.ok(hold, "붙든 사실이 안 남았다");
  assert.deepEqual(hold.record, saved);
});

test("붙들고 있는 동안의 자리는 저장하지 않고, 왜 건너뛰었는지 남는다", () => {
  // 이것이 위치 뒤바뀜의 핵심 방어다. OS 가 옮긴 위치를 저장하면 원래 위치가 지워진다.
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");
  h.setDisplays([INTERNAL]);
  h.fire("display-removed");

  // macOS 가 남은 화면으로 옮겼다.
  Object.assign(w._bounds, { x: 300, y: 200 });
  h.tick(5000);                 // 정착 창(1.5초)은 지났고, 막는 것은 대기표다
  w.emit("maximize");           // 저장 경로를 즉시 태운다(debounce 없는 이벤트)

  assert.deepEqual(h.ui.browserBounds, saved, "밀린 자리가 원래 자리를 덮었다");
  const skip = lastOf(h, "skipSave");
  assert.ok(skip, "건너뛴 사실이 안 남았다");
  assert.equal(skip.key, "browserBounds");
  assert.match(skip.why, /대기표/);
  assert.deepEqual(skip.actual, { x: 300, y: 200, width: ON_LEFT.width, height: ON_LEFT.height });
});

test("모니터가 돌아오면 원래 자리에 놓고 그 사실이 남는다", () => {
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");
  h.setDisplays([INTERNAL]);
  h.fire("display-removed");
  Object.assign(w._bounds, { x: 300, y: 200 });

  h.setDisplays([INTERNAL, LEFT, RIGHT]);
  h.fire("display-added");

  assert.equal(h.layout.isAwaiting(w), false, "돌아왔는데 아직 붙들고 있다");
  assert.equal(w._bounds.x, ON_LEFT.x, "원래 자리로 안 돌아갔다");
  const place = lastOf(h, "place");
  assert.ok(place, "되돌린 사실이 안 남았다");
  assert.deepEqual(place.record, saved);
});

test("붙은 모니터가 그 창의 것이 아니면 계속 기다린 사실이 남는다", () => {
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");
  h.setDisplays([INTERNAL]);
  h.fire("display-removed");

  h.setDisplays([INTERNAL, RIGHT]);   // 왼쪽이 아니라 오른쪽이 붙었다
  h.fire("display-added");

  assert.equal(h.layout.isAwaiting(w), true, "엉뚱한 모니터에 놓았다");
  assert.ok(lastOf(h, "stillWaiting"), "계속 기다린 사실이 안 남았다");
});

test("사람이 옮기면 기다림을 접고 그 사실이 남는다", () => {
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");
  h.setDisplays([INTERNAL]);
  h.fire("display-removed");

  h.tick(5000);          // 모니터가 막 바뀐 직후가 아니므로 사람이 옮긴 것으로 센다
  w.emit("will-move");

  assert.equal(h.layout.isAwaiting(w), false, "사람이 옮겼는데 계속 붙들고 있다");
  const gave = lastOf(h, "giveUp");
  assert.ok(gave, "기다림을 접은 사실이 안 남았다");
});

test("모니터가 막 바뀐 직후의 이동은 사람이 옮긴 것으로 세지 않는다", () => {
  const saved = { ...ON_LEFT, maximized: false, fullscreen: false, display: { id: 2, x: -1920, y: 0 } };
  const h = harness({ state: { browserBounds: saved } });
  const w = makeWin("Iris — 브라우저", ON_LEFT);
  h.layout.trackWindowBounds(w, "browserBounds");
  h.setDisplays([INTERNAL]);
  h.fire("display-removed");

  h.tick(1000);          // 1.5초 안이므로 OS 가 옮긴 것이다
  w.emit("will-move");
  assert.equal(h.layout.isAwaiting(w), true, "OS 가 민 것을 사람이 옮긴 것으로 셌다");
});

test("정상 저장도 남는다", () => {
  const h = harness();
  const w = makeWin("Iris — 콘솔", ON_INTERNAL);
  h.layout.trackWindowBounds(w, "mainBounds");
  h.tick(5000);
  w.emit("maximize");
  const ev = lastOf(h, "save");
  assert.ok(ev, "저장한 사실이 안 남았다");
  assert.equal(ev.key, "mainBounds");
  assert.equal(h.ui.mainBounds.x, ON_INTERNAL.x);
});

test("기록이 파일로 나간다", async () => {
  const h = harness();
  const w = makeWin("Iris — 콘솔", ON_INTERNAL);
  h.layout.trackWindowBounds(w, "mainBounds");
  h.tick(5000);
  w.emit("maximize");
  await settle();
  const d = h.diagFile();
  assert.ok(d, "진단 파일이 안 나갔다");
  assert.ok(Array.isArray(d.events) && d.events.length, "사건이 비었다");
  assert.ok(Array.isArray(d.displays) && d.displays.length === 3, "그때의 모니터 구성이 안 실렸다");
  assert.equal(d.settleMs, 1500, "정착 창 길이가 안 실렸다 — 나중에 이 값을 의심할 때 못 짚는다");
});

test("기록 자리를 안 주면 아무 일도 안 하고 그대로 돈다", () => {
  // 검사·다른 호출자가 fs 를 안 줘도 판정이 멈추면 안 된다.
  const layout = createWindowLayout({
    screen: { getAllDisplays: () => [INTERNAL], getDisplayMatching: () => INTERNAL, on: () => {} },
    windowBoundsVisible: boundsVisible,
    readUiState: () => ({}),
    writeUiState: () => {},
  });
  const opts = {};
  layout.applySavedBounds(opts, "mainBounds");
  assert.deepEqual(layout.diagEvents().map((e) => e.kind), ["launch"]);
});

test("기록은 무한히 자라지 않는다", () => {
  const h = harness();
  const w = makeWin("Iris — 콘솔", ON_INTERNAL);
  h.layout.trackWindowBounds(w, "mainBounds");
  h.tick(5000);
  for (let i = 0; i < 300; i++) w.emit("maximize");
  assert.ok(h.layout.diagEvents().length <= 120, "기록이 무한히 쌓인다");
  assert.ok(kinds(h).includes("save"));
});
