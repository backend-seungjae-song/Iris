// 화면 밖으로 빠르게 끌 때 스크롤과 화면 읽기의 박자.
//
// 두 프레임이 겹치는 행이 있어야 이어 붙일 위치를 찾는다. 빠르게 끌면 화면을 한 번 읽는 사이에
// 화면 하나를 넘게 지나갔고, 한 번의 다시 그리기가 여러 조각으로 와서 조각마다 읽은 화면은 반쯤
// 바뀌어 있었다. 확인 결과: 추정으로 놓인 프레임이 절반을 넘었고 복사 결과가 어긋났다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadCopyHelpers() {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync("web/scrollback-copy.js", "utf8"), context);
  return context.globalThis.IrisScrollbackCopy;
}

function loadEdgeDrag() {
  const source = fs.readFileSync("web/js/chatcopy/edge-drag.js", "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";$/gm, "")
    .replace(/^export \{[^}]*\};$/gm, "")
    .replace(/^export /gm, "");
  let now = 0, seq = 0;
  const timers = new Map();
  const schedule = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = until;
  };
  const ROWS = 53;
  const body = Array.from({ length: 400 }, (_, i) => `  본문 ${String(i).padStart(3, "0")} 줄`);
  let top = 200, captures = 0;
  const sent = [];
  const xterm = {
    rows: ROWS, cols: 80,
    buffer: { active: { type: "alternate", baseY: 0, getLine: () => ({ getCell: () => ({ getWidth: () => 1 }) }) } },
    _core: { _selectionService: { _getMouseBufferCoords: () => [10, 20] } },
    clearSelection() {}, select() {},
    getSelectionPosition: () => ({ start: { x: 0, y: 20 }, end: { x: 10, y: 20 } }),
  };
  const context = {
    window: { IrisScrollbackCopy: loadCopyHelpers() },
    performance: { now: () => now },
    setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => schedule(fn, 16), cancelAnimationFrame: (id) => timers.delete(id),
    getXterm: () => xterm, getTerminalInner: () => ({}), getAppMouseOn: () => true, selSkip: () => 0,
    screenRows: () => { captures++; return [" header", ...body.slice(top, top + ROWS - 3), "─".repeat(40), "❯", "─".repeat(40)]; },
    alignFirstRow: () => ({ rows: [], prefix: "", inset: 0 }), copyIndentWidth: () => 0, rowsToText: () => "",
  };
  vm.runInNewContext(source, context, { filename: "web/js/chatcopy/edge-drag.js" });
  context.initEdgeDrag({
    blog() {}, wsSend: (m) => sent.push(m), wsIsOpen: () => true,
    getCurTarget: () => "pane", getLastAgents: () => [],
  });
  return {
    api: context, advance,
    scrollTo: (next) => { top = next; },
    captures: () => captures,
    sentLines: () => sent.reduce((n, m) => n + (m.data.match(/M/g) || []).length, 0),
  };
}

const wheel = (api, lines) => api.edgeWheel({ dir: 1, lines, reportCol: 10, reportRow: 20, event: {} });

test("wheel input waits for the screen once the unconfirmed scroll would outrun the overlap", () => {
  const h = loadEdgeDrag();
  h.api.edgeBegin({});
  for (let i = 0; i < 10; i++) wheel(h.api, 6);
  const first = h.sentLines();
  assert.ok(first > 0 && first <= Math.floor(53 / 4), `unconfirmed scroll must stay small, sent ${first}`);

  // 화면을 한 번 읽고 나면 다시 받는다.
  h.scrollTo(200 + first);
  h.api.edgeCaptureAfterWrite();
  h.advance(200);
  wheel(h.api, 6);
  assert.equal(h.sentLines(), first + 6, "a confirmed screen releases the next wheel");
});

test("a redraw that arrives in several chunks is read once, after the output pauses", () => {
  const h = loadEdgeDrag();
  h.api.edgeBegin({});
  wheel(h.api, 3);
  const before = h.captures();
  for (let i = 0; i < 4; i++) { h.api.edgeCaptureAfterWrite(); h.advance(10); }
  assert.equal(h.captures(), before, "no read while the chunks keep coming");
  h.advance(60);
  assert.equal(h.captures(), before + 1, "one read after the pause");

  // 출력이 끊이지 않아도 한없이 미루지는 않는다.
  wheel(h.api, 3);
  const busy = h.captures();
  for (let i = 0; i < 30; i++) { h.api.edgeCaptureAfterWrite(); h.advance(10); }
  assert.ok(h.captures() > busy, "a continuous stream still gets read");
});

test("a position backed by only a few overlapping rows is not trusted", () => {
  const copy = loadCopyHelpers();
  const body = Array.from({ length: 200 }, (_, i) => `row ${i}`);
  const st = { virtual: [], view: 0, anchorIdx: 5, anchorCol: 0 };
  copy.alignRows(st, body.slice(0, 46), 0);
  // 실제로는 41줄 넘게 건너뛰어 6줄만 겹친다. 예상 위치(18)와 다르다.
  const rows = [...body.slice(40, 46), ...Array.from({ length: 40 }, (_, i) => `torn ${i}`)];
  copy.alignRows(st, rows, 18);
  assert.equal(st.view, 18, "a 6-row overlap must not override the expected position");
  assert.ok(copy.localCopyDefect(st, { row: 45, col: 5 }), "the stitched range is reported as a guess");
});
