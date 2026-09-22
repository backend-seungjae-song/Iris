// 화면 밖까지 끌어서 복사. 대체 화면 TUI 의 스크롤 선택을 담당한다.
//
// 소유 범위
//   드래그 1회의 상태(누적 행·시야·앵커·초점), 화면 캡처 예약과 정렬, 선택 표시 다시 그리기,
//   자동 복사를 막는 guard 시간, 그리고 손을 놓았을 때의 최종 텍스트 조립.
//
// 제공 API
//   edgeStart · edgeMove · edgeWheel · edgeFinish · edgeCaptureAfterWrite · edgeAutoCopyBlocked,
//   그리고 init 에서 받는 연결(initEdgeDrag).
//
// 의존 대상
//   panel/terminal 의 xterm·crop·화면 행 읽기, chatcopy/copy-text 의 텍스트 조립,
//   web/scrollback-copy.js 의 IrisScrollbackCopy 전역(정렬·선택·구멍 판정).
//   blog·wsSend·현재 pane 접근자는 boot 이 ctx 에서 받아 넘긴다.
//
// 유지 조건
//   alternate buffer 와 앱 마우스 모드에서만 가로챈다. 최초 화면은 불변 보관하고 PTY write 뒤
//   렌더된 프레임만 누적한다. 화면 안에서 끝난 드래그는 xterm 원래 경로 그대로 둔다.
//   휠 경로는 동기여야 한다. I/O 가 끼면 스크롤과 선택이 일치하지 않는다.
//
// 영향 범위
//   panel/xterm-wiring 이 부르는 훅 이름(chatcopy.wheel·dragStart·dragMove·dragEnd)과
//   main 의 PTY 수신(chatcopy.captureAfterWrite).
//   현재 목록 확인: node bin/importers.mjs web/js/chatcopy/edge-drag.js
import {
  getAppMouseOn, getTerminalInner, getXterm, screenRows, selSkip,
} from "../panel/terminal.js";
import { alignFirstRow, copyIndentWidth, rowsToText } from "./copy-text.js";

let blog, wsSend, wsIsOpen, getCurTarget, getLastAgents;

export function initEdgeDrag(deps) {
  ({ blog, wsSend, wsIsOpen, getCurTarget, getLastAgents } = deps);
}

// ── 화면 밖까지 끌어서 복사 ──
// 이 pane은 대체 화면이라 xterm에 스크롤백이 없다(확인 결과: type=alternate, lines==rows). 그래서 xterm의
// 선택은 지금 화면을 못 넘는다. 누르는 순간 현재 화면을 불변 보관하고, 실제 휠로 스크롤한 뒤
// 보이는 화면을 같은 로컬 행 좌표에 이어 붙인다. 서버 왕복이 없고 최초 화면은 절대 덮지 않으므로
// 화면이 다시 그려져도 시작 텍스트가 바뀌지 않는다. 스크롤하지 않은 선택은 기존 xterm 경로 그대로다.
let edgeDrag = null;
// 손을 놓은 직후 xterm이 선택 변경을 한 번 더 보낸다. 그때 edgeDrag는 이미 비어 있어 자동 복사가
// 다시 동작해 현재 화면 몫으로 결과를 덮어쓰므로, 스냅샷 계산 중과 직후까지 막아 둔다.
let edgeGuardUntil = 0;
function activePtyPane() {
  const focused = getLastAgents().find((a) => a.focused);
  return (focused && focused.paneId) || getCurTarget() || null;
}
function edgeCell(e) {
  const xterm = getXterm(), terminalInner = getTerminalInner();
  const rows = xterm.rows || 24, cols = xterm.cols || 80;
  try {
    // xterm의 네이티브 선택과 같은 좌표 변환을 쓴다. crop 때문에 넓어진 wrapper 폭으로 다시
    // 나누면 남는 픽셀이 전체 열에 퍼져 포인터가 실제 셀보다 한 칸씩 밀릴 수 있다.
    const point = xterm._core._selectionService._getMouseBufferCoords(e);
    if (point && Number.isInteger(point[0]) && Number.isInteger(point[1])) {
      const base = xterm.buffer.active.baseY || 0;
      let col = point[0];
      // xterm은 전각 글자의 두 번째 셀(width=0)에서는 선택 경계를 글자 뒤로 보낸다.
      // 내부 mapper만 호출하고 이 보정을 빼면 한글 위에서 자체 highlight보다 한 셀 뒤처진다.
      try {
        const line = xterm.buffer.active.getLine(point[1]);
        if (col < cols && line?.getCell(col)?.getWidth() === 0) col++;
      } catch {}
      return {
        row: Math.max(0, Math.min(rows - 1, point[1] - base)),
        col: Math.max(0, Math.min(cols, col)),
      };
    }
  } catch {}
  // vendored 내부 서비스가 없어질 때도 wrapper 비율이 아니라 실제 xterm screen/cell 치수로 계산한다.
  const screen = xterm._core?.screenElement || terminalInner.querySelector?.(".xterm-screen") || terminalInner;
  const rect = screen.getBoundingClientRect();
  const dims = xterm._core?._renderService?.dimensions?.css?.cell || {};
  const cellW = Number(dims.width) || rect.width / cols;
  const cellH = Number(dims.height) || rect.height / rows;
  return {
    row: Math.max(0, Math.min(rows - 1, Math.ceil((e.clientY - rect.top) / cellH) - 1)),
    col: Math.max(0, Math.min(cols, Math.ceil((e.clientX - rect.left + cellW / 2) / cellW) - 1)),
  };
}
function edgeCapture(st) { return screenRows(st.skip); }
function edgeRenderSelection(st) {
  if (!st || !st.scrolled || !window.IrisScrollbackCopy) return;
  const xterm = getXterm();
  const mark = window.IrisScrollbackCopy.visibleSelection(st,
    { row: st.focusRow, col: st.focusCol }, st.viewportRows || st.rows, st.cols, st.skip);
  try {
    if (mark) xterm.select(mark.col, mark.row, mark.length);
    else xterm.clearSelection();
  } catch {}
}
function edgeRequestSelection(st) {
  if (!st || st.selectionFrame) return;
  st.selectionFrame = requestAnimationFrame(() => {
    st.selectionFrame = 0;
    if (edgeDrag === st || st.finishing) edgeRenderSelection(st);
  });
}
function edgeAlign(st, rows, expected) {
  if (!window.IrisScrollbackCopy) throw new Error("scrollback copy helper unavailable");
  const view = window.IrisScrollbackCopy.alignViewport(st, rows, expected);
  edgeNormalizeFocus(st);
  if (st.scrolled) edgeRequestSelection(st);
  return view;
}
function edgeFlushCapture(st) {
  if (st.captureTimer) clearTimeout(st.captureTimer);
  st.captureTimer = null;
  if (st.captureQuiet) clearTimeout(st.captureQuiet);
  st.captureQuiet = 0; st.captureSince = 0;
  if (st.captureFrame) cancelAnimationFrame(st.captureFrame);
  st.captureFrame = 0;
  const expected = st.pendingExpected; st.pendingExpected = 0;
  try {
    if (edgeDrag === st || st.finishing) edgeAlign(st, edgeCapture(st), expected);
  } finally {
    const waiters = st.captureWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
function edgeScheduleCapture(st, expected) {
  st.pendingExpected += expected;
}
// 휠 입력 직후 타이머로 화면을 읽으면 TUI가 아직 그리기 전인 옛 화면을 새 좌표에 붙일 수 있다.
// PTY 응답을 xterm이 실제로 파싱한 뒤에 읽는다. 한 번의 다시 그리기가 여러 조각으로 오므로
// 조각마다 읽으면 반쯤 바뀐 화면을 붙인다. 확인 결과: 빠르게 끌 때 프레임 절반이 어느 위치와도
// 맞지 않아 추정으로 놓였다. 출력이 잠깐 멈춘 뒤에 읽되, 출력이 끊이지 않아도 오래 미루지는 않는다.
const CAPTURE_QUIET_MS = 40, CAPTURE_MAX_WAIT_MS = 160;
export function edgeCaptureAfterWrite() {
  const st = edgeDrag;
  if (!st || !st.scrolled) return;
  const now = performance.now();
  if (!st.captureSince) st.captureSince = now;
  if (st.captureQuiet) clearTimeout(st.captureQuiet);
  const wait = Math.max(0, Math.min(CAPTURE_QUIET_MS, st.captureSince + CAPTURE_MAX_WAIT_MS - now));
  st.captureQuiet = setTimeout(() => {
    st.captureQuiet = 0;
    if (st.captureFrame) return;
    st.captureFrame = requestAnimationFrame(() => {
      st.captureFrame = 0;
      if (edgeDrag === st || st.finishing) edgeFlushCapture(st);
    });
  }, wait);
}
function edgeAwaitCapture(st) {
  if (!st.pendingExpected && !st.captureFrame && !st.captureQuiet) return Promise.resolve();
  return new Promise((resolve) => {
    st.captureWaiters.push(resolve);
    // 기록의 위·아래 끝에서는 TUI가 아무것도 다시 그리지 않는다. 그때만 짧게 기다린 뒤 현재 화면으로 끝낸다.
    if (!st.captureTimer) st.captureTimer = setTimeout(() => edgeFlushCapture(st), 80);
  });
}
function edgeNormalizeFocus(st) {
  const top = Math.max(0, Number(st.viewportTop) || 0);
  const count = Math.max(1, Number(st.viewportRows) || st.rows);
  const last = top + count - 1, contentCols = Math.max(0, st.cols - st.skip);
  if (st.focusScreenRow < top) { st.focusRow = 0; st.focusCol = 0; return; }
  if (st.focusScreenRow > last) { st.focusRow = count - 1; st.focusCol = contentCols; return; }
  st.focusRow = Math.max(0, Math.min(count - 1, st.focusScreenRow - top));
  st.focusCol = Math.max(0, Math.min(contentCols, st.focusScreenCol));
}
function edgeTrackPoint(st, row, col) {
  st.focusScreenRow = Math.max(0, Math.min(st.rows - 1, Math.floor(Number(row) || 0)));
  st.focusScreenCol = Math.max(0, Math.min(st.cols - st.skip, Math.floor(Number(col) || 0)));
  edgeNormalizeFocus(st);
  if (st.scrolled) edgeRequestSelection(st);
}
function edgeAdoptSelectionAnchor(st, row, col) {
  if (!st || st.anchorAdopted) return;
  st.anchorAdopted = true;
  try {
    const xterm = getXterm();
    const selection = xterm.getSelectionPosition();
    const base = xterm.buffer.active.baseY || 0;
    const anchor = window.IrisScrollbackCopy.nativeSelectionAnchor({
      start: { x: selection.start.x, y: selection.start.y - base },
      end: { x: selection.end.x, y: selection.end.y - base },
    }, { row, col }, st.rows, st.cols, st.skip);
    if (!anchor) return;
    st.initialAnchorRow = anchor.row;
    st.anchorIdx = st.view + anchor.row;
    st.anchorCol = anchor.col;
  } catch {}
}
function edgeScroll(st, dir, lines, reportCol, reportRow, selectionPoint) {
  if (!st || !dir || lines < 1) return;
  // 앱이 마우스를 쓰지 않으면 이 바이트는 스크롤이 아니라 입력으로 들어가므로 보내지 않는다.
  if (!getAppMouseOn() || !wsIsOpen()) { st.blocked = "no-mouse-mode"; return; }
  // 아직 화면으로 확인하지 못한 스크롤이 밴드의 몇 분의 일을 넘으면 이번 휠은 버린다. 두 프레임이
  // 겹치는 행이 있어야 이어 붙일 위치를 찾는데, 빠르게 끌면 한 프레임 사이에 화면 하나를 넘게 지나갔다.
  const unconfirmed = Math.abs((Number(st.pendingExpected) || 0) + dir * lines);
  if (st.scrolled && unconfirmed > Math.max(3, Math.floor((st.viewportRows || st.rows) / 4))) return;
  const point = selectionPoint || { row: reportRow - 1, col: reportCol - 1 };
  // PTY mouse report는 포인터 아래 셀, 선택 끝점은 글자 절반 기준 경계다. 휠 순간 report 셀을
  // 선택 끝점으로 재사용하면 네이티브 선택이 한 글자 어긋나므로 두 좌표를 섞지 않는다.
  edgeAdoptSelectionAnchor(st, point.row, point.col);
  edgeTrackPoint(st, point.row, point.col - st.skip);
  // 여기서 서버 스크롤 스냅샷을 요청하지 않는다. 대체 화면 pane에는 herdr 기록이 없어
  // 그 값으로는 아무것도 계산할 수 없다(edgeFinish 주석 참조).
  if (!st.scrolled) {
    st.scrolled = true;
    // xterm의 기존 선택은 대체 화면의 고정 행 좌표라 스크롤 뒤 다른 글자를 표시한다.
    // 첫 휠에서만 지우고, 이후에는 같은 기본 선택색을 현재 가상 범위에 다시 투영한다.
    try { getXterm().clearSelection(); } catch {}
    edgeRequestSelection(st);
  }
  const btn = dir < 0 ? 64 : 65;
  let seq = ""; for (let i = 0; i < lines; i++) seq += "\x1b[<" + btn + ";" + reportCol + ";" + reportRow + "M";
  edgeScheduleCapture(st, dir * lines);
  wsSend({ type: "pty.input", data: seq });
}
function edgeStart(e) {
  const xterm = getXterm();
  if (!xterm || xterm.buffer.active.type !== "alternate") return;   // 스크롤백이 있으면 xterm이 알아서 한다
  if (!getAppMouseOn()) { blog("edge skip", "앱이 마우스 모드가 아니라 스크롤을 보낼 수 없다"); return; }
  const target = activePtyPane(); if (!target) return;
  const { row, col } = edgeCell(e);
  const skip = selSkip();
  edgeDrag = {
    target, skip, rows: xterm.rows, cols: xterm.cols,
    virtual: [], view: 0, anchorIdx: row, anchorCol: Math.max(0, col - skip), initialAnchorRow: row,
    viewportTop: 0, viewportRows: xterm.rows, viewportResolved: false, expectedOffset: 0,
    trace: [],   // 임시 진단: 프레임별 정렬 판단
    focusRow: row, focusCol: Math.max(0, col - skip),
    focusScreenRow: row, focusScreenCol: Math.max(0, col - skip), anchorAdopted: false,
    scrolled: false, finishing: false, selectionFrame: 0,
    captureTimer: null, captureFrame: 0, captureQuiet: 0, captureSince: 0, pendingExpected: 0, captureWaiters: [],
  };
  edgeAlign(edgeDrag, edgeCapture(edgeDrag), 0);
}
function edgeMove(e) {
  const st = edgeDrag; if (!st) return;
  const point = edgeCell(e);
  edgeTrackPoint(st, point.row, point.col - st.skip);
}
// 서버 history가 일치하지 않을 때의 대비책. 드래그 내내 화면에서 직접 읽어 쌓은 로컬 행만 쓰므로
// pane·기하·스크롤 기록이 그 사이 바뀌어도 성립한다. 대신 빠르게 스크롤해 건너뛴 화면은
// 포함되지 않아 결과가 짧을 수 있으므로, 이 경로를 탔다는 사실을 함께 알린다.
function localSelectionText(st) {
  if (!window.IrisScrollbackCopy) throw new Error("scrollback copy helper unavailable");
  const end = { row: st.focusRow, col: st.focusCol };
  // 결과가 짧은 것은 알리면 되지만 내용이 다른 것은 알려도 쓸 수 없다. 잘린 줄 알고 붙여넣었는데
  // 내용이 바뀌어 있기 때문이다. 구멍이나 저신뢰 정렬이면 여기서 멈춘다.
  const defect = window.IrisScrollbackCopy.localCopyDefect(st, end);
  if (defect) throw new Error(defect);
  // 순서가 어긋났을 수 있는 행이 섞였으면 막지 않고 몇 줄인지 알린다. 결과에서 확인할 수 있다.
  const doubt = window.IrisScrollbackCopy.localCopyDoubt(st, end);
  if (doubt) st._doubtRows = doubt;
  const picked = window.IrisScrollbackCopy.pickRows(st, end);
  const first = alignFirstRow(picked.rows, picked.firstPrefix, picked.firstInset);
  const text = rowsToText(first.rows, st.skip, copyIndentWidth(first.prefix, first.inset), 0, first.inset);
  return text.trim() ? text : null;
}
// 드래그가 끝나면 로컬 누적 행에서 시작·끝을 잘라 최종 클립보드 텍스트를 만든다.
//
// 이 계산에 herdr pane history를 쓰지 않는다. 거기에는 데이터가 없다. 이 기능은
// 대체 화면(alternate)에서만 동작하는데(edgeStart), 대체 화면 TUI는 제자리에서 다시 그리므로
// herdr 스크롤백에 아무것도 쌓이지 않는다. 확인 결과: claude pane은 lines:5000을 요청해도 현재 화면
// 54행만 주고 max_offset_from_bottom이 0이다(같은 herdr의 일반 셸 pane은 1000행). 그래서
// 그 경로는 첫 드래그에서 스크롤 캐시 miss로 실패하고, 이후에는 성공으로 보고하면서 스크롤로 지나간
// 내용 대신 현재 화면 일부를 반환한다.
//
// 스크롤로 지나간 내용은 드래그 내내 화면에서 읽어 쌓은 로컬 누적분에만 있다.
// 반환은 {text, degraded}: 지금은 항상 온전하거나(빈 degraded) 게이트에 막혀 던진다.
async function edgeFinish(e) {
  const st = edgeDrag;
  if (!st) return null;
  if (!st.scrolled) { edgeDrag = null; return null; } // 화면 안에서 끝난 드래그는 xterm 선택 그대로가 맞다
  st.finishing = true;
  edgeGuardUntil = Number.POSITIVE_INFINITY;
  const end = edgeCell(e);
  edgeTrackPoint(st, end.row, Math.max(0, end.col - st.skip));
  let degraded = "";
  try {
    const xterm = getXterm();
    await edgeAwaitCapture(st); // 마지막 휠 뒤 화면 캡처까지만 기다린다. 스크롤 자체는 기다리지 않는다.
    // pane이나 기하가 바뀌었으면 마지막 화면을 누적에 이어 붙일 수 없다. 그때까지 쌓아 둔 행은
    // 멀쩡하므로 끝내지 않고, 마지막 한 프레임이 빠졌다는 사실만 남긴다.
    if (activePtyPane() === st.target && xterm.rows === st.rows && xterm.cols === st.cols) {
      edgeAlign(st, edgeCapture(st), 0);
      edgeRenderSelection(st);
    } else degraded = "마지막 화면을 못 붙였습니다(pane·크기 변경)";
    st._diagNote = degraded;
    st._doubtRows = 0;
    const text = localSelectionText(st);
    if (st._doubtRows) {
      degraded = (degraded ? degraded + " · " : "") + `${st._doubtRows}줄은 순서가 어긋났을 수 있습니다`;
    }
    return { text, degraded };
  } finally {
    edgeDrag = null;
    st.finishing = false;
    if (st.captureTimer) clearTimeout(st.captureTimer);
    if (st.captureFrame) cancelAnimationFrame(st.captureFrame);
    if (st.captureQuiet) clearTimeout(st.captureQuiet);
    if (st.selectionFrame) cancelAnimationFrame(st.selectionFrame);
    edgeGuardUntil = Date.now() + 600;
  }
}

// 자동 복사가 끼어들면 안 되는 구간. 드래그 중이거나 종료 직후다.
export function edgeAutoCopyBlocked() {
  return (edgeDrag && edgeDrag.scrolled) || Date.now() < edgeGuardUntil;
}
// 앱 셸은 휠 이벤트만 넘긴다. 가로챘는지 여부는 여기서 반환한다.
export function edgeWheel({ dir, lines, reportCol, reportRow, event }) {
  if (!edgeDrag) return false;
  edgeScroll(edgeDrag, dir, lines, reportCol, reportRow, edgeCell(event));
  return true;
}
export function edgeBegin(e) {
  try { edgeStart(e); } catch (e2) { blog("edge start", e2.message); }
}
export function edgeTrack(e) {
  if (edgeDrag) edgeMove(e);
}
export { edgeFinish };
