// 탭 끌기를 실제 이벤트로 재본다.
//
// 배경: 소스 모양 검사와 부팅 탐침만으로는 잡히지 않는 두 가지가 실물에서 겹쳐 기능이
// 동작하지 않았다.
//   칩의 draggable="true" 가 네이티브 드래그를 시작시켜 포인터 이벤트가 취소됨 → 분리 실패
//   띠에 포인터 캡처를 걸어 그 뒤의 click 대상이 띠가 됨 → 탭 클릭과 그 위 기능 실패
// 그래서 여기서는 실제 이벤트를 흘려 보내고 무엇이 호출됐는지 센다.
//
// DOM 은 흉내만 낸다. 검사 대상이 연결이지 렌더링이 아니라서, 흉내가 못 미치는 부분은
// 테스트가 아니라 사람이 확인해야 한다. 그 경계를 아래 주석에 적어 둔다.
import assert from "node:assert/strict";
import test from "node:test";

function makeEl(tag, attrs = {}) {
  const el = {
    tag, attrs, children: [], parent: null,
    classList: {
      _s: new Set(),
      add(...n) { n.forEach((x) => this._s.add(x)); },
      remove(...n) { n.forEach((x) => this._s.delete(x)); },
      contains(x) { return this._s.has(x); },
    },
    dataset: attrs.dataset || {},
    rect: attrs.rect || { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 },
    getBoundingClientRect() { return this.rect; },
    isConnected: true,
    _listeners: new Map(),
    addEventListener(type, fn, opt) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, opt });
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) || [];
      const i = list.findIndex((x) => x.fn === fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, ev) {
      const list = [...(this._listeners.get(type) || [])];
      for (const { fn, opt } of list) {
        fn(ev);
        if (opt && opt.once) this.removeEventListener(type, fn);
      }
      return ev;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === ".ctab" && cur.tag === "ctab") return cur;
        if (sel === "[data-close]" && cur.attrs.close) return cur;
        cur = cur.parent;
      }
      return null;
    },
    querySelectorAll() { return []; },
    nextElementSibling: null,
    setPointerCapture() { throw new Error("포인터 캡처를 쓰면 안 된다 — click 대상이 띠가 된다"); },
  };
  return el;
}

function harness() {
  const calls = { start: 0, move: [], end: 0, rect: [], reorder: [] };
  const strip = makeEl("strip", { rect: { left: 0, top: 0, right: 400, bottom: 30, width: 400, height: 30 } });
  const tab = makeEl("ctab", { dataset: { tab: "t1" }, rect: { left: 10, top: 0, right: 110, bottom: 30, width: 100, height: 30 } });
  tab.parent = strip;

  const win = {
    screenX: 200, screenY: 100,
    acHost: {
      tabStripRect: (r) => calls.rect.push(r),
      tabDragStart: async (a) => { calls.start++; calls.startArg = a; return { ok: true }; },
      tabDragMove: async (p) => { calls.move.push(p); return { ok: true }; },
      tabDragEnd: async () => { calls.end++; return { ok: true }; },
    },
    _listeners: new Map(),
    addEventListener: makeEl("w").addEventListener,
    removeEventListener: makeEl("w").removeEventListener,
    dispatch: makeEl("w").dispatch,
  };
  win._listeners = new Map();
  const doc = { elementFromPoint: () => null };
  return { calls, strip, tab, win, doc };
}

async function loadModule(win, doc) {
  globalThis.window = win;
  globalThis.document = doc;
  // 모듈 안의 host 캐시를 회차마다 새로 만든다.
  const url = new URL("../web/js/browser/tab-drag.js", import.meta.url).href + "?t=" + calls_seq++;
  return import(url);
}
let calls_seq = 0;

const ev = (x, y, extra = {}) => ({ button: 0, clientX: x, clientY: y, ...extra });

test("문턱을 넘으면 끌기가 시작되고 화면 좌표로 보낸다", async () => {
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({
    strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "제목", spaceOf: () => "sp1",
    move: (id, before) => calls.reorder.push([id, before]),
  });

  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  assert.equal(calls.start, 0, "누르기만 해도 시작되면 탭을 못 누른다");

  // 문턱(5px) 안쪽이라 아직 시작하지 않는다.
  win.dispatch("pointermove", { ...ev(52, 11), target: tab });
  assert.equal(calls.start, 0);

  win.dispatch("pointermove", { ...ev(80, 40), target: tab });
  assert.equal(calls.start, 1, "문턱을 넘었는데 시작이 안 됐다");
  assert.equal(calls.startArg.tabId, "t1");
  assert.equal(calls.startArg.space, "sp1");
  // 잡은 자리(칩 왼쪽 10 에서 50 을 눌렀으니 40)를 그대로 넘겨야 창이 커서에 붙는다.
  assert.equal(calls.startArg.grabDx, 40);

  // 화면 좌표여야 main 이 다른 창의 띠와 견줄 수 있다.
  assert.deepEqual(calls.move[0], { x: 200 + 80, y: 100 + 40 });
});

test("띠 밖으로 나가도 좌표가 계속 온다", async () => {
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: (id, b) => calls.reorder.push([id, b]) });

  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointermove", { ...ev(80, 40), target: tab });
  const first = calls.move.length;
  // 앞 호출이 돌아오길 기다린다. 밀림 방지 때문에 in-flight 중에는 보내지 않는다.
  await new Promise((r) => setTimeout(r, 0));
  // 띠 아래로 한참 내려간 자리. 창 밖이어도 window 리스너라 계속 온다.
  win.dispatch("pointermove", { ...ev(80, 400), target: strip });
  assert.ok(calls.move.length > first, "띠 밖에서 좌표가 끊겼다 — 분리 판정이 굶는다");
});

test("포인터 캡처를 쓰지 않는다", async () => {
  // 캡처를 걸면 그 뒤의 click 대상이 띠 자신이 되어 탭 클릭이 동작하지 않는다. 흉내 DOM 의
  // setPointerCapture 는 부르면 던지므로, 쓰면 이 테스트가 깨진다.
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: () => {} });
  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  assert.equal(calls.start, 0);
});

test("네이티브 드래그를 막는다", async () => {
  // 칩에 draggable="true" 가 있어서, 막지 않으면 포인터 이벤트가 취소되고 끌기가 동작하지 않는다.
  const { strip, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: () => {} });
  let prevented = false;
  strip.dispatch("dragstart", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "네이티브 드래그를 안 막으면 포인터 경로가 죽는다");
});

test("띠 안에서 놓으면 자리 옮김, 밖에서 놓으면 안 부른다", async () => {
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: (id, b) => calls.reorder.push([id, b]) });

  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointermove", { ...ev(200, 15), target: strip });
  win.dispatch("pointerup", { ...ev(200, 15), target: strip });
  assert.equal(calls.end, 1, "놓았는데 끝을 안 알린다");
  // 띠 안이고 before 가 바뀌지 않았으므로 옮기지 않는다. 여기서는 옮김 호출이 0 이어야 한다.
  assert.equal(calls.reorder.length, 0);

  // 두 번째 회차: 띠 밖에서 놓는다. main 이 이미 옮겼으므로 여기서 또 옮기면 안 된다.
  const h2 = harness();
  const m2 = await loadModule(h2.win, h2.doc);
  m2.wireTabDrag({ strip: h2.strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: (id, b) => h2.calls.reorder.push([id, b]) });
  h2.strip.dispatch("pointerdown", { ...ev(50, 10), target: h2.tab });
  h2.win.dispatch("pointermove", { ...ev(80, 400), target: h2.strip });
  h2.win.dispatch("pointerup", { ...ev(80, 400), target: h2.strip });
  assert.equal(h2.calls.reorder.length, 0, "띠 밖에서 놓았는데 자리 옮김까지 했다");
});

test("창이 포커스를 잃으면 끌기가 끝난다", async () => {
  // 떼어낸 창이 포커스를 가져가면 이 창에는 마우스가 더 안 온다. 그대로 두면 끌기가 멈춘 채
  // 남고, 나중에 이 창을 누르는 순간 다시 시작된다. 누르지 않은 탭이 돌아오면서 끌린다.
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: (id, b) => calls.reorder.push([id, b]) });

  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointermove", { ...ev(80, 400), target: strip });
  assert.equal(calls.start, 1);
  assert.equal(calls.end, 0);

  win.dispatch("blur", {});
  assert.equal(calls.end, 1, "포커스를 잃었는데 끌기가 안 끝났다");
  assert.equal((win._listeners.get("pointermove") || []).length, 0, "리스너가 남았다");

  // 남아 있던 끌기가 다시 시작되지 않는다. 좌표를 더 보내도 아무 일이 없다.
  const moved = calls.move.length;
  win.dispatch("pointermove", { ...ev(120, 420), target: strip });
  assert.equal(calls.move.length, moved, "끝난 끌기가 좌표를 계속 보낸다");
});

test("앞의 끌기가 남아 있어도 새로 누르면 겹치지 않는다", async () => {
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: () => {} });

  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointermove", { ...ev(80, 400), target: strip });
  // 놓기가 안 온 채로 다시 누른다(떼어낸 창이 마우스를 가져간 회차).
  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  assert.equal((win._listeners.get("pointermove") || []).length, 1, "리스너가 겹쳐 붙었다");
  assert.equal(calls.end, 1, "남은 끌기를 안 끝내고 새로 시작했다");
});

test("끈 뒤의 click 한 번만 삼킨다", async () => {
  const { calls, strip, tab, win, doc } = harness();
  const m = await loadModule(win, doc);
  m.wireTabDrag({ strip, tabSel: ".ctab", keyOf: (el) => el.dataset.tab,
    titleOf: () => "", spaceOf: () => "sp1", move: () => {} });

  // 끌지 않고 그냥 누르고 뗀 회차다. click 을 삼키면 탭을 못 연다.
  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointerup", { ...ev(50, 10), target: tab });
  assert.equal((win._listeners.get("click") || []).length, 0, "안 끌었는데 click 을 막는다");

  // 끈 회차다. 한 번만 삼킨다.
  strip.dispatch("pointerdown", { ...ev(50, 10), target: tab });
  win.dispatch("pointermove", { ...ev(120, 12), target: strip });
  win.dispatch("pointerup", { ...ev(120, 12), target: strip });
  assert.equal((win._listeners.get("click") || []).length, 1, "끌었는데 click 을 안 삼킨다");
  let stopped = 0;
  win.dispatch("click", { stopPropagation: () => stopped++, preventDefault: () => {} });
  assert.equal(stopped, 1);
  assert.equal((win._listeners.get("click") || []).length, 0, "한 번만 삼켜야 한다");
});
