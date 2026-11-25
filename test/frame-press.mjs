import assert from "node:assert/strict";
import test from "node:test";
import { installFramePress } from "../web/js/core/frame-press.js";

class FakeMouseEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.button = init.button ?? 0; }
}

// 화면 요소. parentElement·matches·getAttribute 만 씀
function node(parent, { cls = "", role = null } = {}) {
  return {
    parentElement: parent,
    matches: (sel) => sel.split(",").some((s) => s.trim() === "." + cls),
    getAttribute: (name) => (name === "role" ? role : null),
  };
}

function fixture() {
  const win = new EventTarget();
  win.MouseEvent = FakeMouseEvent;
  const doc = new EventTarget();
  const seen = [];
  // documentElement 에 보낸 누름을 document 리스너가 받는 것으로 기록
  doc.documentElement = { dispatchEvent: (event) => { seen.push(event.type); return true; } };
  doc.body = { parentElement: null };
  doc.activeElement = null;
  const timers = [];
  const schedule = (fn) => timers.push(fn);
  const flush = () => { while (timers.length) timers.shift()(); };
  let clock = 0;
  const now = () => clock;
  const tick = (ms) => { clock += ms; };
  const press = installFramePress({ win, doc, schedule, now });
  const clicks = () => seen.filter((t) => t === "click").length;
  return { win, doc, seen, press, flush, tick, clicks };
}

// 실제 iframe: 다시 읽어도 contentWindow(WindowProxy)는 같은 객체이고 문서와 그 창의 리스너만 바뀜
function iframe(tagName = "IFRAME") {
  let current = new EventTarget();
  let doc = {};
  const proxy = {
    addEventListener: (...a) => current.addEventListener(...a),
    get document() { return doc; },
  };
  return {
    tagName,
    contentWindow: proxy,
    get contentDocument() { return doc; },
    navigate() { current = new EventTarget(); doc = {}; },
    fire(type) { current.dispatchEvent(new FakeMouseEvent(type)); },
  };
}

test("같은 출처 iframe 안을 누르면 부모 문서에 바깥 누름을 한 번 보낸다", () => {
  const f = fixture();
  const chat = iframe();
  f.press.watch(chat);
  chat.fire("pointerdown");
  assert.deepEqual(f.seen, ["pointerdown", "mousedown", "click"]);
});

test("빈 iframe 에 연결한 뒤 대화 화면을 읽어 들여도 새 문서의 누름을 전달한다", () => {
  const f = fixture();
  const chat = iframe();
  f.press.watch(chat);
  chat.navigate();
  f.press.watch(chat);
  chat.fire("pointerdown");
  assert.equal(f.clicks(), 1);
});

test("같은 문서를 두 번 watch 해도 누름마다 한 번만 보낸다", () => {
  const f = fixture();
  const chat = iframe();
  f.press.watch(chat); f.press.watch(chat);
  chat.fire("pointerdown");
  assert.equal(f.clicks(), 1);
});

test("iframe 안에서 스크롤해도 바깥 누름을 보낸다", () => {
  const f = fixture();
  const chat = iframe();
  f.press.watch(chat);
  chat.fire("wheel");
  assert.equal(f.clicks(), 1);
});

test("부모 창이 포커스를 잃고 포커스가 iframe·webview 로 가면 바깥 누름을 보낸다", () => {
  for (const tag of ["IFRAME", "WEBVIEW"]) {
    const f = fixture();
    f.win.dispatchEvent(new Event("blur"));
    f.doc.activeElement = { tagName: tag };
    f.flush();
    assert.deepEqual(f.seen, ["pointerdown", "mousedown", "click"], tag);
  }
});

test("앱 밖으로 포커스가 나가면(⌘Tab) 바깥 누름을 보내지 않는다", () => {
  const f = fixture();
  f.doc.activeElement = { tagName: "BODY" };
  f.win.dispatchEvent(new Event("blur"));
  f.flush();
  assert.deepEqual(f.seen, []);
});

test("iframe 을 처음 누를 때 누름과 포커스 이동이 겹쳐도 한 번만 보낸다", () => {
  const f = fixture();
  const chat = iframe();
  f.press.watch(chat);
  chat.fire("pointerdown");
  f.win.dispatchEvent(new Event("blur"));
  f.doc.activeElement = chat;
  f.flush();
  assert.equal(f.clicks(), 1);
  f.tick(1000);
  chat.fire("pointerdown");
  assert.equal(f.clicks(), 2);
});

test("본 화면 앱 영역(.app·.titlebar·.statusbar)에서 스크롤하면 바깥 누름을 보낸다", () => {
  for (const cls of ["app", "titlebar", "statusbar"]) {
    const f = fixture();
    const top = node(f.doc.body, { cls });
    const list = node(node(top));
    f.press.onWheel({ target: list });
    assert.equal(f.clicks(), 1, cls);
  }
});

test("팝업 안(body 에 붙은 층, 메뉴·목록·대화 상자)에서 스크롤하면 닫지 않는다", () => {
  const f = fixture();
  const usagePanel = node(f.doc.body, { cls: "usg-panel" });
  f.press.onWheel({ target: node(usagePanel) });
  const app = node(f.doc.body, { cls: "app" });
  for (const role of ["listbox", "menu", "dialog"]) f.press.onWheel({ target: node(node(app, { role })) });
  assert.deepEqual(f.seen, []);
});

test("다른 출처 iframe 은 연결할 수 없어도 오류 없이 넘어간다", () => {
  const f = fixture();
  const cross = { tagName: "IFRAME", get contentDocument() { return null; }, get contentWindow() { throw new DOMException("blocked", "SecurityError"); } };
  assert.doesNotThrow(() => f.press.watch(cross));
});
