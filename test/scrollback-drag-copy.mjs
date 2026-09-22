import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import vm from "node:vm";
import { sliceBetween, sliceFrom } from "../bin/slice-anchor.mjs";

// "어디에도 없어야 한다"는 존재 검사다. 파일 몇 개만 확인하면 세 번째 파일이 사각지대가 된다.
function allWebJs() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(fs.readFileSync(p, "utf8"));
    }
  })("web/js");
  return out.join("\n");
}

function loadCopyHelpers() {
  const source = fs.readFileSync("web/scrollback-copy.js", "utf8");
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: "web/scrollback-copy.js" });
  return context.globalThis.IrisScrollbackCopy;
}

function copyCleanup(cols = 20) {
  const web = fs.readFileSync("web/js/chatcopy/copy-text.js", "utf8");
  const start = web.indexOf("function copyIndentWidth");
  const end = web.indexOf("function cropAwareSelection", start);
  assert.ok(start >= 0 && end > start, "copy cleanup functions must remain extractable");
  const fixture = { cols };
  const context = { getXterm: () => fixture };
  vm.runInNewContext(web.slice(start, end), context, { filename: "web/js/chatcopy/copy-text.js#copy-cleanup" });
  return context;
}

function mapDragCell({ coords, baseY = 0, continuationCol = -1, event = { clientX: 181, clientY: 75 } }) {
  const web = fs.readFileSync("web/js/chatcopy/edge-drag.js", "utf8");
  const start = web.indexOf("function edgeCell");
  const end = web.indexOf("function edgeCapture", start);
  assert.ok(start >= 0 && end > start, "drag cell mapper must remain extractable");
  const xterm = {
    rows: 24, cols: 80, buffer: { active: {
      baseY,
      getLine: () => ({ getCell: (col) => ({ getWidth: () => col === continuationCol ? 0 : 1 }) }),
    } },
    _core: { _selectionService: { _getMouseBufferCoords: () => coords } },
  };
  const terminalInner = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 240 }) };
  const context = { getXterm: () => xterm, getTerminalInner: () => terminalInner };
  vm.runInNewContext(web.slice(start, end), context, { filename: "web/js/chatcopy/edge-drag.js#edge-cell" });
  return context.edgeCell(event);
}

function mapMouseReportCell({ coords, event = { clientX: 181, clientY: 75 } }) {
  const web = fs.readFileSync("web/js/panel/xterm-wiring.js", "utf8");
  const start = web.indexOf("function mouseReportCell");
  const end = web.indexOf("export function sendPtyResize", start);
  assert.ok(start >= 0 && end > start, "mouse-report mapper must remain extractable");
  const xterm = {
    rows: 24, cols: 80,
    _core: {
      screenElement: {},
      _mouseService: { getMouseReportCoords: () => coords },
      _renderService: { dimensions: { css: { cell: { width: 10, height: 10 } } } },
    },
  };
  const terminalInner = { querySelector: () => null };
  const context = { getXterm: () => xterm, getTerminalInner: () => terminalInner };
  vm.runInNewContext(web.slice(start, end), context, { filename: "web/js/panel/xterm-wiring.js#mouse-report-cell" });
  return context.mouseReportCell(event);
}

function historySnapshot(rows, offset, extra = {}) {
  const scroll = extra.scroll || {
    offset_from_bottom: offset,
    max_offset_from_bottom: Math.max(0, rows.length - 3),
    viewport_rows: 3,
  };
  return {
    target: "w18:pA", text: rows.join("\n"), truncated: false, scroll,
    ...extra, scroll,
  };
}

function startDrag(copy, rows, row = 0, col = 0) {
  const state = { virtual: [], view: 0, anchorIdx: row, anchorCol: col };
  copy.alignRows(state, rows, 0);
  return state;
}

test("drag start rows stay immutable when later screens redraw", () => {
  const copy = loadCopyHelpers();
  const state = startDrag(copy, ["header", "A", "ORIGINAL", "C", "footer"], 2, 8);

  copy.alignRows(state, ["X", "Y", "header", "A", "ORIGINAL"], -2);
  copy.alignRows(state, ["X2", "Y2", "changed", "changed", "changed"], 0);

  assert.equal(state.virtual[state.anchorIdx], "ORIGINAL");
  assert.deepEqual(Array.from(copy.pickRows(state, { row: 1, col: 0 }).rows),
    ["Y2", "header", "A", "ORIGINAL"], "selection must terminate at the original anchor text");
});

test("native xterm selection replaces the cropped pixel estimate before scrolling", () => {
  const copy = loadCopyHelpers();
  const state = startDrag(copy, ["수정 완료", "중간", "마지막"], 1, 2);
  const anchor = copy.nativeSelectionAnchor({
    start: { x: 8, y: 0 },
    end: { x: 28, y: 2 },
  }, { row: 2, col: 27 }, 3, 80, 8);

  assert.deepEqual({ ...anchor }, { row: 0, col: 0 },
    "the xterm cell anchor must win over the approximate cropped DOM coordinate");
  state.anchorIdx = state.view + anchor.row;
  state.anchorCol = anchor.col;
  assert.equal(copy.pickRows(state, { row: 2, col: 6 }).rows[0], "수정 완료",
    "the first full-width character and start row must survive");

  assert.deepEqual({ ...copy.nativeSelectionAnchor({
    start: { x: 9, y: 0 },
    end: { x: 25, y: 2 },
  }, { row: 0, col: 9 }, 3, 80, 8) }, { row: 2, col: 17 },
  "reverse selections use xterm's exclusive end as the original anchor");
});

test("copied rows exclude pane dividers without deleting terminal syntax", () => {
  const copy = loadCopyHelpers();
  assert.equal(copy.terminalContentRow("  ▕│  terminal text   │"), "  terminal text",
    "fallback crop slack and residual Unicode pane boundaries are UI, not terminal content");
  assert.equal(copy.terminalContentRow("  | markdown |"), "  | markdown |",
    "ASCII pipes and terminal indentation remain content");

  const cleanup = copyCleanup(20);
  assert.equal(cleanup.rowsToText([
    copy.terminalContentRow("│  first line  │"),
    copy.terminalContentRow("│  + second  │"),
  ], 0), "first line\n+ second", "existing fake-indent cleanup still owns layout blanks");
});

test("drag pointer uses xterm's exact cell mapping", () => {
  assert.deepEqual({ ...mapDragCell({ coords: [17, 9], baseY: 2 }) }, { row: 7, col: 17 },
    "the enlarged cropped container must not shift the pointer by a cell");
  assert.deepEqual({ ...mapDragCell({ coords: [17, 9], baseY: 2, continuationCol: 17 }) }, { row: 7, col: 18 },
    "the custom range must apply xterm's wide-character continuation-cell correction");
  assert.deepEqual({ ...mapDragCell({ coords: [80, 9], baseY: 2 }) }, { row: 7, col: 80 },
    "the exclusive boundary after the last cell must not be clamped one cell early");
  assert.deepEqual({ ...mapMouseReportCell({ coords: { col: 16, row: 9 } }) }, { row: 9, col: 16 },
    "wheel and click reports use the cell under the pointer, not xterm's half-cell selection boundary");
  const web = fs.readFileSync("web/js/panel/xterm-wiring.js", "utf8");
  const start = web.indexOf("function cellAt");
  const end = web.indexOf('terminalInner.addEventListener("wheel"', start);
  const cellAt = web.slice(start, end);
  assert.match(cellAt, /mouseReportCell\(/, "wheel and click coordinates must use the mouse-report mapper");
  assert.doesNotMatch(cellAt, /edgeCell\(/,
    "selection-boundary coordinates must not leak into wheel and click reports");
  assert.doesNotMatch(cellAt, /getBoundingClientRect|rect\.width \/ cols/,
    "no input path may revive the cropped-container approximation");
});

test("final copy comes from pane-only Herdr history instead of stitched TUI frames", () => {
  const copy = loadCopyHelpers();
  const paneRows = [
    "pane row 0", "pane row 1", "pane row 2", "pane row 3", "pane row 4",
    "pane row 5", "pane row 6", "pane row 7", "pane row 8",
  ];
  const start = historySnapshot([], 0, {
    text: undefined,
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 6, viewport_rows: 3 },
    phase: "start",
  });
  const end = historySnapshot(paneRows, 4);

  const picked = copy.pickHistoryRows(start, end,
    { row: 2, col: 20 }, { row: 0, col: 0 }, { gutter: 2, contentCols: 20 });
  assert.deepEqual(Array.from(picked.rows),
    ["pane row 2", "pane row 3", "pane row 4", "pane row 5", "pane row 6", "pane row 7", "pane row 8"],
  "pane rows cannot be cropped again with the outer screen's detected gutter");
});

test("pane-history mapping preserves the start anchor while output grows", () => {
  const copy = loadCopyHelpers();
  const start = historySnapshot([], 0, {
    text: undefined,
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 3, viewport_rows: 3 },
    phase: "start",
  });
  const endRows = ["A", "B", "C", "D", "E", "F", "NEW-1", "NEW-2"];
  const end = historySnapshot(endRows, 0, {
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5, viewport_rows: 3 },
  });

  const picked = copy.pickHistoryRows(start, end,
    { row: 1, col: 0 }, { row: 2, col: 20 }, { contentCols: 20 });
  assert.deepEqual(Array.from(picked.rows), ["E", "F", "NEW-1", "NEW-2"],
    "new output changes the distance from bottom but not the original history row");
});

// 대체 화면 pane 에는 herdr 기록이 없어서(claude pane 은 lines:5000 요청에도 현재 화면
// 54행, max_offset_from_bottom 0) 화면 좌표를 pane history 행으로 옮기는 경로는 읽을
// 데이터가 없다. 지금은 로컬 누적물이 유일한 소스이므로, 확인할 것은 고정 TUI 크롬이 그
// 누적물에 섞이지 않는가이고 실제 모듈로 검사한다.
//
// 드래그는 화면 아래 크롬(입력줄·구분선·상태줄)에서 시작하는 일이 흔하다. 가장 새 출력이
// 거기 붙어 있어 거기서 위로 끌기 때문이다. 앵커가 밴드 밖일 때 밴드 판별을 버리면 화면
// 전체가 본문으로 쌓여 클립보드에 구분선과 ❯ 입력줄이 그대로 들어간다.
// 구분선처럼 모양이 같은 행은 어디서 어디로 옮겨졌는지 증명하지 못한다. 그런 행끼리
// 맞아떨어지면 밴드가 크롬 쪽으로 늘어난다. 확인 결과: 구분선 두 줄의 간격(2행)만큼
// 굴리면 밴드가 51→55로 늘고 ❯ 입력줄까지 본문으로 들어왔다.
test("repeated rows never widen the band into the chrome", () => {
  const copy = loadCopyHelpers();
  const DIV = "─".repeat(67), BAND = 51, ROWS = 55;
  const body = Array.from({ length: 400 }, (_, i) => `  본문 ${String(i).padStart(3, "0")}`);
  // 구분선이 두 줄, 사이에 입력줄. 두 구분선 간격이 정확히 2행이다.
  const chrome = ["   new task? /clear to save 389.3k tokens", DIV, "❯", DIV];
  const screen = (top) => [...body.slice(top, top + BAND), ...chrome];
  const CHROME = /[─❯]|new task\?/u;

  for (const step of [1, 2, 3, 4, 6]) {
    const region = copy.scrollableRegion(screen(0), screen(step), step);
    assert.ok(region, `step ${step}: band must be found`);
    assert.equal(region.end, BAND, `step ${step}: repeated dividers must not extend the band`);
  }

  // 하필 구분선 간격과 같은 폭으로 굴려도 크롬이 안 섞이고 복사가 막히지 않아야 한다.
  for (const anchorRow of [10, 50, 52, 54]) {
    const st = { virtual: [], view: 0, anchorIdx: anchorRow, anchorCol: 0,
      initialAnchorRow: anchorRow, viewportTop: 0, viewportRows: ROWS,
      viewportResolved: false, expectedOffset: 0 };
    copy.alignViewport(st, screen(0), 0);
    for (let t = 2; t <= 40; t += 2) copy.alignViewport(st, screen(t), 2);
    assert.equal(st.viewportRows, BAND, `anchor ${anchorRow}: band excludes chrome`);
    assert.equal(st.virtual.filter((r) => r && CHROME.test(r)).length, 0,
      `anchor ${anchorRow}: no chrome row may reach the copy buffer`);
    assert.equal(copy.localCopyDefect(st, { row: BAND - 1, col: 60 }), "",
      `anchor ${anchorRow}: a plain scroll must stay copyable`);
  }
});

// 밴드를 첫 스크롤에 한 번 정하고 고정으로 쓰면, 화면 구성이 도중에 바뀔 때(작업중 표시가
// 생겼다 사라지고, 힌트 줄이 붙었다 떨어진다) 잘라내는 창이 어긋난다. 크롬이 본문에 섞이거나
// 본문 한 줄이 창 밖으로 밀린다. 확인 결과 같은 화면인데 회차마다 밴드가 46·47·51·52로 갈렸다.
test("the band is re-detected as the screen composition changes mid-drag", () => {
  const copy = loadCopyHelpers();
  const ROWS = 55, DIV = "─".repeat(60);
  const body = Array.from({ length: 600 }, (_, i) => `  본문 ${String(i).padStart(3, "0")}`);
  const chrome4 = ["   힌트", DIV, "❯", DIV];
  const chrome5 = ["✻ 작업중", "   힌트", DIV, "❯", DIV];
  const screen = (top, ch) => [...body.slice(top, top + (ROWS - ch.length)), ...ch];
  const CHROME = /[─❯✻]|힌트/u;

  const st = { virtual: [], view: 0, anchorIdx: 20, anchorCol: 0, initialAnchorRow: 20,
    viewportTop: 0, viewportRows: ROWS, viewportResolved: false, expectedOffset: 0 };
  copy.alignViewport(st, screen(0, chrome4), 0);
  for (let t = 3; t <= 30; t += 3) copy.alignViewport(st, screen(t, chrome4), 3);
  for (let t = 33; t <= 90; t += 3) copy.alignViewport(st, screen(t, chrome5), 3);   // 크롬 한 줄 늘어남
  // 여기서 끝낸다. 원래 크기로 돌아오는 흐름은 뒤 프레임이 새어 나온 행을 덮어 스스로
  // 복구하므로 이 결함이 드러나지 않는다. 바뀐 채로 손을 떼는 쪽이 실제 조건이다.

  assert.equal(st.virtual.filter((r) => r && CHROME.test(r)).length, 0,
    "chrome must not leak when its height changes mid-drag");
  assert.equal(st.virtual.filter((r) => r == null).length, 0, "no gaps");
  // 본문이 순서대로 온전해야 한다. 중간이 잘리거나 다른 부분이 끼어들면 여기서 걸린다.
  const nums = st.virtual.filter((r) => r && /본문 \d+/.test(r)).map((r) => Number(r.match(/본문 (\d+)/)[1]));
  let breaks = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) breaks++;
  assert.equal(breaks, 0, "body rows must stay contiguous across the composition change");
  assert.ok(nums.length > 100, "the whole scrolled range must be collected");
});

test("fixed TUI chrome never enters the copied buffer, wherever the drag starts", () => {
  const copy = loadCopyHelpers();
  const ROWS = 55, BAND = 51;
  const body = Array.from({ length: 300 }, (_, i) => `  본문 ${String(i).padStart(3, "0")}`);
  const chrome = ["✻ Baked for 2m 42s", "─".repeat(67), "❯ 입력 중", "─".repeat(67)];
  const screen = (top) => [...body.slice(top, top + BAND), ...chrome];
  const CHROME = /[─❯✻]/u;

  for (const anchorRow of [0, 10, 50, 51, 52, 54]) {
    const st = { virtual: [], view: 0, anchorIdx: anchorRow, anchorCol: 0,
      initialAnchorRow: anchorRow, viewportTop: 0, viewportRows: ROWS,
      viewportResolved: false, expectedOffset: 0 };
    copy.alignViewport(st, screen(20), 0);
    copy.alignViewport(st, screen(23), 3);
    copy.alignViewport(st, screen(26), 3);

    assert.ok(st.viewportResolved, `anchor ${anchorRow}: band must resolve`);
    assert.equal(st.viewportRows, BAND, `anchor ${anchorRow}: band excludes chrome`);
    assert.equal(st.virtual.filter((r) => r && CHROME.test(r)).length, 0,
      `anchor ${anchorRow}: no chrome row may reach the copy buffer`);
    assert.equal(copy.localCopyDefect(st, { row: 10, col: 60 }), "",
      `anchor ${anchorRow}: a plain scroll must stay copyable`);
    assert.ok(st.anchorIdx >= 0 && st.anchorIdx < st.virtual.length,
      `anchor ${anchorRow}: clamped anchor stays inside the band`);
  }
});

// 스크롤 중에는 본문 맨 아래 행 오른쪽에 바닥으로 가기 힌트가 겹쳐 그려지고, 그 아래 빈 줄·설문·
// 알림은 제자리에 있다. 확인 결과: 겹친 행은 어느 프레임과도 글자가 같지 않아 밴드에서 빠졌고,
// 위로 갔다가 바닥으로 돌아와도 선택이 입력창 위 본문 끝까지 내려가지 않았다.
test("the band reaches the last body row above the input even under the jump-to-bottom hint", () => {
  const copy = loadCopyHelpers();
  const BODY = 44, HDR = " Memo     Iris-Complete     GitHub";
  const body = Array.from({ length: 200 }, (_, k) =>
    k % 7 === 6 ? "" : `  본문 ${String(k).padStart(3, "0")} 줄은 이런 내용으로 이어진다`);
  body[198] = "";
  body[199] = "✻ Churned for 6s · done 오후 5:53";
  const chrome = ["", "● How is Claude doing this session? (optional)", "  1: Bad    2: Fine   3: Good   0: Dismiss",
    "                           ✔ Update installed · Restart", "─".repeat(50), "❯", "─".repeat(50),
    "  ⏵⏵ auto mode on (shift+tab to cycle)"];
  const bottom = body.length - BODY;
  const hint = (r) => (r + " ".repeat(40)).slice(0, 40) + " Jump to bottom (ctrl+End)";
  const screen = (top) => {
    const rows = body.slice(top, top + BODY);
    if (top < bottom) rows[BODY - 1] = hint(rows[BODY - 1]);
    return [HDR, ...rows, ...chrome];
  };
  const CHROME = /Jump to bottom|How is Claude|Update installed|[─❯⏵]/u;

  const st = { virtual: [], view: 0, anchorIdx: 26, anchorCol: 0, initialAnchorRow: 26,
    viewportTop: 0, viewportRows: 53, viewportResolved: false, expectedOffset: 0 };
  let top = bottom;
  copy.alignViewport(st, screen(top), 0);
  for (let i = 0; i < 12; i++) { top -= 6; copy.alignViewport(st, screen(top), -6); }
  while (top < bottom) { const step = Math.min(6, bottom - top); top += step; copy.alignViewport(st, screen(top), step); }

  assert.equal(st.viewportTop + st.viewportRows, 1 + BODY, "band must end right above the fixed rows");
  assert.equal(st.virtual.filter((r) => r && CHROME.test(r)).length, 0, "no hint or chrome in the copy buffer");
  const picked = copy.pickRows(st, { row: st.viewportRows - 1, col: 60 });
  assert.equal(picked.rows[picked.rows.length - 1], body[199], "selection reaches the last body row");

  // 위로 한 화면 넘게 올라간 채 손을 떼도, 힌트가 겹친 행이 이미 받은 본문 행을 덮지 않는다.
  const up = { virtual: [], view: 0, anchorIdx: 26, anchorCol: 0, initialAnchorRow: 26,
    viewportTop: 0, viewportRows: 53, viewportResolved: false, expectedOffset: 0 };
  top = bottom;
  copy.alignViewport(up, screen(top), 0);
  for (let i = 0; i < 20; i++) { top -= 6; copy.alignViewport(up, screen(top), -6); }
  const kept = up.virtual.slice(0, up.virtual.length - BODY);
  assert.equal(kept.filter((r) => r && CHROME.test(r)).length, 0, "hint rows never overwrite body rows");
});

test("pane-history copy fails closed when its identity or range is no longer trustworthy", () => {
  const copy = loadCopyHelpers();
  const start = historySnapshot([], 0, {
    text: undefined,
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5, viewport_rows: 3 },
    phase: "start",
  });
  const end = historySnapshot(["row 9", "row 10", "row 11"], 0, {
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 8, viewport_rows: 3 },
  });
  const positions = [{ row: 0, col: 0 }, { row: 2, col: 6 }];
  const options = { contentCols: 20 };

  assert.throws(() => copy.pickHistoryRows(start, { ...end, target: "w18:pB" }, ...positions, options),
    /pane changed/);
  assert.throws(() => copy.pickHistoryRows(start, { ...end, truncated: true }, ...positions, options),
    /snapshot truncated/);
  assert.throws(() => copy.pickHistoryRows(start, {
    ...end, scroll: { ...end.scroll, viewport_rows: 4 },
  }, ...positions, options),
    /viewport geometry changed/);
  assert.throws(() => copy.pickHistoryRows(start, end, ...positions, options),
    /scrollback range unavailable/, "a final recent window that no longer contains the anchor must not copy a wrong row");
});

test("fixed TUI chrome is excluded from the accumulated scrollable rows", () => {
  const copy = loadCopyHelpers();
  const initial = ["header", "A", "B", "C", "D", "E", "View  Process  Feature", "prompt"];
  const next = ["header", "C", "D", "E", "F", "G", "View  Process  Feature", "prompt"];
  const state = { virtual: [], view: 0, anchorIdx: 1, anchorCol: 0, initialAnchorRow: 1 };

  copy.alignViewport(state, initial, 0);
  copy.alignViewport(state, next, 2);

  assert.equal(state.viewportTop, 1);
  assert.equal(state.viewportRows, 5);
  assert.deepEqual(Array.from(state.virtual), ["A", "B", "C", "D", "E", "F", "G"],
    "fixed header, status bar, and prompt must never enter the virtual document");
  assert.deepEqual(Array.from(copy.pickRows(state, { row: 4, col: 1 }).rows),
    ["A", "B", "C", "D", "E", "F", "G"]);
  assert.deepEqual({ ...copy.visibleSelection(state, { row: 4, col: 1 }, 5, 80, 0) },
    { col: 0, row: 1, length: 321 }, "highlight must stop before the fixed footer");

  const reverse = { virtual: [], view: 0, anchorIdx: 5, anchorCol: 1, initialAnchorRow: 5 };
  copy.alignViewport(reverse,
    ["header", "C", "D", "E", "F", "G", "View  Process  Feature", "prompt"], 0);
  copy.alignViewport(reverse,
    ["header", "A", "B", "C", "D", "E", "View  Process  Feature", "prompt"], -2);
  assert.deepEqual(Array.from(reverse.virtual), ["A", "B", "C", "D", "E", "F", "G"],
    "fixed chrome must also stay out while scrolling upward");
  assert.deepEqual(Array.from(copy.pickRows(reverse, { row: 0, col: 0 }).rows),
    ["A", "B", "C", "D", "E", "F", "G"]);
});

test("wheel-rendered screens extend the same virtual selection", () => {
  const copy = loadCopyHelpers();
  const state = startDrag(copy, ["A", "B", "C"], 0, 0);

  copy.alignRows(state, ["C", "D", "E"], 2);
  const picked = copy.pickRows(state, { row: 2, col: 1 });

  assert.deepEqual(Array.from(picked.rows), ["A", "B", "C", "D", "E"]);
});

test("reverse scroll prepends rows without moving the original anchor", () => {
  const copy = loadCopyHelpers();
  const state = startDrag(copy, ["C", "D", "E"], 2, 1);

  copy.alignRows(state, ["A", "B", "C"], -2);

  assert.equal(state.anchorIdx, 4);
  assert.equal(state.virtual[state.anchorIdx], "E");
  assert.deepEqual(Array.from(copy.pickRows(state, { row: 0, col: 0 }).rows), ["A", "B", "C", "D", "E"]);
});

test("visible highlight follows the virtual selection while the viewport scrolls", () => {
  const copy = loadCopyHelpers();
  const state = startDrag(copy, ["A", "B", "C", "D", "E"], 2, 3);

  assert.deepEqual({ ...copy.visibleSelection(state, { row: 4, col: 5 }, 5, 20, 4) },
    { col: 7, row: 2, length: 42 });

  state.view = 4;
  assert.deepEqual({ ...copy.visibleSelection(state, { row: 3, col: 6 }, 5, 20, 4) },
    { col: 4, row: 0, length: 66 }, "an offscreen anchor highlights from the visible content edge");

  const reverse = startDrag(copy, ["C", "D", "E"], 2, 3);
  copy.alignRows(reverse, ["A", "B", "C"], -2);
  assert.deepEqual({ ...copy.visibleSelection(reverse, { row: 0, col: 2 }, 3, 20, 4) },
    { col: 6, row: 0, length: 54 }, "an offscreen reverse anchor highlights to the visible content edge");
});

test("virtual rows still use the existing fake-wrap and fake-blank cleanup", () => {
  const copy = loadCopyHelpers();
  const cleanup = copyCleanup(20);

  assert.equal(cleanup.rowsToText(["abcdefghijklmno)", "next"], 0), "abcdefghijklmno) next",
    "terminal-width fake wraps stay joined");

  const state = startDrag(copy, ["  첫 줄", "  + 둘째"], 0, 2);
  const picked = copy.pickRows(state, { row: 1, col: 20 });
  const firstInset = cleanup.copyIndentWidth(picked.firstPrefix, picked.firstInset);
  assert.equal(cleanup.rowsToText(Array.from(picked.rows), 0, firstInset), "첫 줄\n+ 둘째",
    "continuation fake blanks stay removed");
});

test("fake wraps restore token and word boundaries without inventing spaces", () => {
  const narrow = copyCleanup(11);
  assert.equal(narrow.rowsToText(["12345678판", "정입니다"], 0), "12345678판정입니다",
    "a full-width Hangul token split at the pane edge must not gain a space");
  assert.equal(narrow.rowsToText(["1234presen", "t result"], 0), "1234present result",
    "an ASCII token split at the pane edge must not gain a space");

  const words = copyCleanup(20);
  assert.equal(words.rowsToText(["prefix nonblank", "rows stay"], 0), "prefix nonblank rows stay",
    "a whole word pushed to the next row keeps its original separator");
  assert.equal(words.rowsToText(["prefix selection", "API result"], 0), "prefix selection API result",
    "a capitalized word pushed to the next row must not be glued to the prior word");
  assert.equal(narrow.rowsToText(["1234567890", "- second item"], 0), "1234567890\n- second item",
    "an explicit list item is a logical line even when the prior row fills the pane");
});

// 휠 경로는 동기여야 한다. 굴리는 조작과 화면 사이에 I/O 가 끼면 선택이 어긋난다.
// 손을 뗀 뒤 pane history 를 읽는 방식은 쓰지 않는다. 대체 화면 pane 에 herdr 기록이
// 없어 그 읽기가 스크롤로 지나간 내용을 주지 못한다(claude pane 은 lines:5000 에도 현재
// 화면 54행·max_offset 0, 같은 herdr 의 일반 셸 pane 은 1000행). 소스는 로컬 누적물뿐이다.
test("scroll-copy keeps the wheel path local and synchronous", () => {
  const web = fs.readFileSync("web/js/chatcopy/edge-drag.js", "utf8");
  // 이 둘은 "어디에도 없어야 한다". 두 파일만 확인하면 세 번째 파일에 다시 생겨도 못 본다
  const everywhere = allWebJs();

  // 이름으로 검사하면 이름이 사라진 뒤에는 아무것도 검사하지 않으면서 통과한다. 그래서
  // 프로토콜 자체를 양쪽에서 본다. 한쪽만 복원하면 아무 일도 일어나지 않기 때문이다.
  const serverSide = fs.readFileSync("server/herdr-handlers.js", "utf8");
  assert.doesNotMatch(everywhere + serverSide, /copy-snapshot/,
    "the server round-trip for scroll content is gone on both sides — reviving one half does nothing");
  assert.doesNotMatch(everywhere, /scrollbackSelectionText/,
    "the pane-history clipboard path is gone — local accumulation is the only source");
  assert.match(web, /function edgeScroll\(st, dir, lines, reportCol, reportRow, selectionPoint\)/);
  const edgeStart = sliceBetween(web, "function edgeStart", "function edgeMove", "가장자리 시작");
  const edgeScroll = sliceBetween(web, "function edgeScroll", "function edgeStart", "가장자리 스크롤");
  const edgeMoveAt = web.indexOf("function edgeMove");
  const edgeMove = web.slice(edgeMoveAt, web.indexOf("\nfunction ", edgeMoveAt + 1));
  assert.doesNotMatch(edgeStart, /showToast|clearSelection|xterm\.select|wsSend|setInterval|\.style\b/,
    "mousedown may capture state but must not mutate the screen or start movement");
  assert.doesNotMatch(edgeScroll, /async function edgeScroll|new Promise/,
    "wheel dispatch must remain synchronous and never create an I/O wait");
  assert.match(edgeScroll, /const point = selectionPoint[\s\S]*?edgeTrackPoint\(st, point\.row, point\.col - st\.skip\)/,
    "wheel reporting must not replace the selection boundary with the adjacent report cell");
  assert.doesNotMatch(edgeScroll, /paneRead|setTimeout|setInterval/,
    "the wheel path has no pane read or timer");
  assert.match(edgeScroll, /edgeScheduleCapture\(st, dir \* lines\)/);
  assert.doesNotMatch(edgeScroll, /showToast|setInterval/,
    "starting or scrolling a selection must not add UI or autonomous motion");
  assert.doesNotMatch(edgeMove, /edgeScroll|setInterval|EDGE_PX/,
    "pointer movement alone must never scroll the terminal");
  // 굴림 이벤트는 앱 셸이 넘기고 그것을 받는 것은 이 기능이다. 두 지점을 함께 본다.
  const wiring = fs.readFileSync("web/js/panel/xterm-wiring.js", "utf8");
  assert.match(wiring, /terminalInner\.addEventListener\("wheel",[\s\S]*?callHook\("chatcopy\.wheel", \{ dir, lines: n, reportCol: col, reportRow: row, event: e \}\)/,
    "the wheel listener must hand the roll to the chat-copy hook, not reach into its state");
  assert.match(web, /function edgeWheel\(\{ dir, lines, reportCol, reportRow, event \}\)[\s\S]*?edgeScroll\(edgeDrag, dir, lines, reportCol, reportRow, edgeCell\(event\)\)/);
  assert.match(web, /function edgeRenderSelection[\s\S]*?IrisScrollbackCopy\.visibleSelection[\s\S]*?xterm\.select\(/);
  // 파일 전체를 훑으면 뒤쪽의 무관한 clearSelection 까지 건너뛰어 매치하므로 edgeScroll 조각만 본다
  assert.match(edgeScroll, /edgeAdoptSelectionAnchor\(st,[\s\S]*?getXterm\(\)\.clearSelection\(\)/,
    "the exact native anchor must be adopted before the first wheel clears xterm selection");
  assert.match(web, /function edgeAlign[\s\S]*?IrisScrollbackCopy\.alignViewport/,
    "viewport stitching must exclude fixed TUI chrome");
  // 이 짝은 전송 계층에 있다. WS 바이너리 프레임을 쓴 직후가 그 위치다
  assert.match(fs.readFileSync("web/js/main.js", "utf8"), /getXterm\(\)\.write\([\s\S]*?callHook\("chatcopy\.captureAfterWrite"\)/,
    "viewport capture and highlight update after xterm parsed the TUI response");
  assert.match(web, /function edgeStart[\s\S]*?edgeAlign\(edgeDrag, edgeCapture\(edgeDrag\), 0\)/);
  assert.match(web, /async function edgeFinish[\s\S]*?await edgeAwaitCapture\(st\)/);
  assert.match(web, /function localSelectionText[\s\S]*?localCopyDefect[\s\S]*?pickRows[\s\S]*?rowsToText\(/,
    "the clipboard text comes from the local accumulation, gated on integrity first");
});
