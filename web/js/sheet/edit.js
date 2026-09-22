// 시트 편집: 선택·셀 편집·저장·채우기·서식 상태와 명령을 맡는다.
//
// 소유 범위
//   선택 범위와 overlay, 셀 편집·수식 입력 상태, undo/redo·dirty generation, 채우기 drag, style pool.
//
// 제공 API
//   initSheetEdit(deps): center/core 의존성을 받고 fill listener를 기존 순서에 등록한다.
//   svSet·svApply·svEdit·svSave·svUndo·svFormat·svFillFrom과 선택·overlay·저장 헬퍼.
//
// 의존 대상
//   sheet/model.js·formula.js·conditional.js·render.js를 한 방향으로 import한다.
//   main의 $, esc, showToast와 center file I/O·dirty 판정·탭 표시 함수를 init에서 받는다.
//
// 유지 조건
//   값 변경 → generation 기록 → 재계산 → 현재 DOM 갱신 → save 표시 순서.
//   fill listener는 sheet click/keyboard listener보다 먼저 등록되고, dirty ACK 전에는 편집 표식을 지우지 않는다.
//
// 영향 범위
//   center 소유 상태 fileview·centerSpace, center의 sendTabIo·requestFileContent·isSheetTabDirty·markTabDirty,
//   sheet/actions.js·sheet/events.js와 main의 탭 닫기·저장 ACK 경로.
//
// model/formula/conditional ← render ← edit 방향만 유지한다. render의 후처리는 bind API로 등록한다.
import {
  SV_CHUNK, colName, svAnchorOf, svStyle, svSheet, svStyles, svSrcAt,
} from "./model.js";
import { svCellVal, svErr, svFmtNum, svLit, svRecalc } from "./formula.js";
import { svCF } from "./conditional.js";
import {
  bindSheetRenderEdit, renderSheetView, svPane, svRenderCols, svRenderRows, svRowsHtml,
  svSync, svSyncRows, svTab,
} from "./render.js";
import { getCenterSpace } from "../center/tab-store.js";

let $, esc, fileview, isSheetTabDirty, markTabDirty, requestFileContent, sendTabIo, showToast;

export function initSheetEdit(deps) {
  ({ $, esc, fileview, isSheetTabDirty, markTabDirty, requestFileContent, sendTabIo, showToast } = deps);
  bindSheetRenderEdit({ svPending, svGrowTo, svPaint, svRangeBox, svFillHandle, svRenderImages });
  initSheetFillEvents();
}

// ── 표에서의 조작 ───────────────────────────────────────────────────────────
// 읽기 전용 표는 조회만 가능하다. 구글 시트와 같은 위치에 같은
// 키·같은 동작을 둔다: 고르기·끌기·고치기·지우기·붙여넣기·되돌리기·찾기·저장.
const svCellEl = (r, c) => document.querySelector(`#sv-grid td[data-r="${r}"][data-c="${c}"]:not(.sv-mv)`);
export function svNorm(s) { return { r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2), c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2) }; }
function svTextAt(sh, r, c) { const v = sh.cells[r + "," + c]; return v ? v[0] : ""; }
export function svDvAt(t, sh, r, c) { const i = sh.dv && sh.dv[r + "," + c]; return i ? ((t.sheet.lists || [])[i - 1] || null) : null; }

export function svGrowTo(t, sh, r) {
  if (r <= t._svShown) return;
  const fz = t._svFreeze || { n: 0, y: 0 };
  const next = Math.min(svRenderRows(sh), Math.max(r, t._svShown + SV_CHUNK));
  const pl = svPane("sv-pl"), pb = svPane("sv-pb");
  if (!pb) return;
  const from = t._svShown + 1;
  if (pl) { const tb = pl.querySelector("tbody"); if (tb) tb.insertAdjacentHTML("beforeend", svRowsHtml(t, sh, from, next, 1, fz.n, true, fz.n, fz.y + 1)); }
  const tb2 = pb.querySelector("tbody");
  if (tb2) tb2.insertAdjacentHTML("beforeend", svRowsHtml(t, sh, from, next, fz.n + 1, svRenderCols(sh), false, 0, fz.y + 1));
  t._svShown = next;
  svSyncRows();
  svRenderImages(t);
  svPaint(t);
}

// 고른 범위는 여러 덩어리일 수 있다(구글 시트에서 ⌘를 누르고 다른 데를 고르면 그것도 함께
// 고른 것이 된다). _svSel이 지금 움직이는 덩어리, _svRanges가 앞서 고른 덩어리들이다.
function svAllRanges(t) { return (t._svRanges || []).concat(t._svSel ? [svNorm(t._svSel)] : []); }
// 고른 칸 전부를 한 번씩 순회한다(겹친 칸은 한 번만).
export function svEachCell(t, fn) {
  const seen = new Set();
  for (const g of svAllRanges(t)) {
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
      const k = r + "," + c;
      if (seen.has(k)) continue;
      seen.add(k);
      fn(r, c);
    }
  }
}

export function svPaint(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  document.querySelectorAll("#sv-grid td.sv-sel, #sv-grid td.sv-in").forEach((x) => x.classList.remove("sv-sel", "sv-in"));
  document.querySelectorAll("#sv-grid th.sv-hl").forEach((x) => x.classList.remove("sv-hl"));
  let n = 0, sum = 0, nums = 0, cells = 0;
  const rows = new Set(), cols = new Set();
  svEachCell(t, (r, c) => {
    cells++;
    const el = svCellEl(r, c);
    if (el) el.classList.add(r === t._svSel.r1 && c === t._svSel.c1 ? "sv-sel" : "sv-in");
    rows.add(r); cols.add(c);
    const txt = svTextAt(sh, r, c);
    if (txt !== "") { n++; const num = Number(String(txt).replace(/[,\s₩$%]/g, "")); if (Number.isFinite(num)) { sum += num; nums++; } }
  });
  for (const r of rows) { const rh = document.querySelector(`#sv-grid th.sv-rh[data-r="${r}"]`); if (rh) rh.classList.add("sv-hl"); }
  for (const c of cols) { const ch = document.querySelector(`#sv-grid th.sv-ch[data-c="${c}"]`); if (ch) ch.classList.add("sv-hl"); }
  const one = cells === 1;
  // 여럿을 고르면 활성 칸도 함께 덮인다(확인 결과: J282:L285 에서 J282 안쪽도 #eaeffc).
  // 한 칸만 고르면 안이 비어 있으므로 테두리만 그린다.
  if (!one) { const a = svCellEl(t._svSel.r1, t._svSel.c1); if (a) a.classList.add("sv-in"); }
  const nameBox = $("#sv-name");
  if (nameBox && document.activeElement !== nameBox) nameBox.value = one ? colName(s.c1) + s.r1 : `${colName(s.c1)}${s.r1}:${colName(s.c2)}${s.r2}`;
  const fxin = $("#sv-fxin");
  if (fxin && document.activeElement !== fxin) fxin.value = svSrcAt(sh, t._svSel.r1, t._svSel.c1);
  svRangeBox(t);
  svFillHandle(t);
  const stat = $("#sv-stat");
  if (stat) stat.textContent = one ? "" :
    `고른 칸 ${cells}개 · 값 있는 칸 ${n}개` + (nums ? ` · 합계 ${Math.round(sum * 1e6) / 1e6} · 평균 ${Math.round(sum / nums * 1e4) / 1e4}` : "");
}

// 고른 칸이 화면 밖이면 그 칸이 있는 조각을 움직인다.
function svEnsure(t, r, c) {
  const fz = t._svFreeze || { n: 0, y: 0 };
  const el = svCellEl(r, c); if (!el) return;
  const pb = svPane("sv-pb"), sx = svPane("sv-sbx"), sy = svPane("sv-sby");
  // svRangeBox와 같은 이유(zoom 아래 offsetLeft/Width가 배율을 반영하지 않음)로 pb 기준 화면 좌표로 계산한다.
  const pbr = pb ? pb.getBoundingClientRect() : null, er = pbr ? el.getBoundingClientRect() : null;
  if (sx && pb && c > fz.n) {
    const eL = er.left - pbr.left + sx.scrollLeft, eW = er.width;
    if (eL < sx.scrollLeft) sx.scrollLeft = eL;
    else if (eL + eW > sx.scrollLeft + pb.clientWidth) sx.scrollLeft = eL + eW - pb.clientWidth;
  }
  if (sy && pb && r > fz.y) {
    const eT = er.top - pbr.top + sy.scrollTop, eH = er.height;
    if (eT < sy.scrollTop) sy.scrollTop = eT;
    else if (eT + eH > sy.scrollTop + pb.clientHeight) sy.scrollTop = eT + eH - pb.clientHeight;
  }
  svSync();
}

let svKeepRanges = false;      // ⌘로 덩어리를 더하는 중에는 앞서 고른 것을 지우지 않는다
export function svSetKeepRanges(value) { svKeepRanges = value; }
export function svSet(t, r, c, extend) {
  const sh = svSheet(t); if (!sh) return;
  // sh.rows까지만 잡으면 새로 칠 용도로 비워둔 꼬리 행(SV_TAIL_ROWS, svRenderRows)이 클릭에
  // 잡히지 않고 마지막 실데이터 행으로 되돌아간다. 더블클릭(svEdit)은 이 clamp를 거치지 않아 그
  // 행에서만 동작한다(확인 결과: 단일 클릭 무반응, 더블클릭만 동작).
  r = Math.max(1, Math.min(svRenderRows(sh), r)); c = Math.max(1, Math.min(svRenderCols(sh), c));
  const a = svAnchorOf(t, r, c);
  svGrowTo(t, sh, a.r);
  if (extend && t._svSel) { t._svSel.r2 = a.r; t._svSel.c2 = a.c; }
  else { if (!svKeepRanges) t._svRanges = []; t._svSel = { r1: a.r, c1: a.c, r2: a.r, c2: a.c }; }
  svPaint(t); svEnsure(t, a.r, a.c);
}

export function svRangeText(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return "";
  const s = svNorm(t._svSel), out = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const row = [];
    for (let c = s.c1; c <= s.c2; c++) { const a = svAnchorOf(t, r, c); row.push(String(svTextAt(sh, a.r, a.c)).replace(/\t/g, " ")); }
    out.push(row.join("\t"));
  }
  return out.join("\n");
}

// ── 고치기 ──────────────────────────────────────────────────────────────────
// 바뀐 칸은 저장 전까지 모서리에 표시가 남는다. 저장은 사용자가 누를 때만 한다. 자동 저장은
// 되돌릴 수 없는 변경을 사용자 모르게 수행한다.
export function svDirtyKey(t, r, c) { return (t.sheetIdx || 0) + "|" + r + "," + c; }
export function svNextGeneration(t) { t._svGeneration = (t._svGeneration || 0) + 1; return t._svGeneration; }

// 고친 값을 화면이 그리는 cells에도 함께 넣는다. src에만 넣으면 파일에는 들어가지만 화면은
// 이전 글자를 그대로 갖고 있어 고른 값이 칸에 보이지 않는다(확인 결과: 드롭다운으로 고른 칸이 빈칸).
// 서식 번호는 그대로 유지한다. 값을 지웠다고 그 칸의 색·테두리까지 사라지면 안 된다.
function svPut(t, sh, r, c, raw) {
  const key = r + "," + c;
  const cur = sh.cells[key];
  const si = cur ? (cur[1] || 0) : 0;
  if (raw === "" || raw == null) { if (si) sh.cells[key] = ["", si]; else delete sh.cells[key]; return; }
  if (String(raw)[0] === "=") return;                    // 수식 칸은 svRecalc이 채운다
  const nf = si ? (svStyles(t)[si - 1] || {}).nf : null;
  const v = svLit(raw);
  const text = typeof v === "number" ? svFmtNum(v, nf) : (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
  sh.cells[key] = typeof v === "number" ? [text, si, 1] : (si ? [text, si] : [text]);
}

export function svApply(t, changes, noUndo) {
  const sh = svSheet(t); if (!sh || !changes.length) return;
  if (!sh.src) sh.src = {};
  if (!t._svDirty) t._svDirty = new Map();
  if (!t._svBase) t._svBase = new Map();
  const batch = [];
  let generation = null;
  for (const ch of changes) {
    const key = ch.r + "," + ch.c;
    const before = svSrcAt(sh, ch.r, ch.c);
    const after = ch.src == null ? "" : String(ch.src);
    if (before === after) continue;
    if (generation === null) generation = svNextGeneration(t);
    batch.push({ r: ch.r, c: ch.c, before, after });
    const dirtyKey = svDirtyKey(t, ch.r, ch.c);
    if (!t._svBase.has(dirtyKey)) t._svBase.set(dirtyKey, before); // 이 칸을 이 세션에서 처음 건드리는 순간의 값 = 디스크 원본
    if (after === "") delete sh.src[key];
    else sh.src[key] = after;
    svPut(t, sh, ch.r, ch.c, after);
    // 원본으로 되돌아왔으면 변경이 아니다. touched 키만 쌓으면 되돌려도 dirty가 풀리지 않는다.
    if (after === t._svBase.get(dirtyKey)) t._svDirty.delete(dirtyKey);
    else t._svDirty.set(dirtyKey, { r: ch.r, c: ch.c, generation });
  }
  if (!batch.length) return;
  if (!noUndo) { (t._svUndo = t._svUndo || []).push({ si: t.sheetIdx || 0, batch }); t._svRedo = []; if (t._svUndo.length > 200) t._svUndo.shift(); }
  svFinishEdit(t, sh);
}

// 고친 뒤 화면을 맞춘다. 값을 다시 계산하고, 이미 그려 둔 칸의 글자만 교체한다.
// 표 전체를 다시 그리면 스크롤과 선택 범위가 이동하고, 한 글자 고칠 때마다 화면이 깜빡인다.
function svFinishEdit(t, sh) {
  svRecalc(t);
  const styles = svStyles(t);
  document.querySelectorAll("#sv-grid td.sv-c").forEach((el) => {
    if (el.classList.contains("sv-mv")) return;
    const r = +el.dataset.r, c = +el.dataset.c, key = r + "," + c;
    const cell = sh.cells[key];
    const text = cell ? cell[0] : "";
    if (el.textContent !== text) el.textContent = text;
    const base = cell && cell[1] ? styles[cell[1] - 1] : null;
    const over = svCF(t, sh, r, c, text);
    const want = svStyle(over ? Object.assign({}, base, over) : base, !!(cell && cell[2]));
    if (el.getAttribute("style") !== want) el.setAttribute("style", want);
    el.classList.toggle("sv-dirty", !!(t._svDirty && t._svDirty.has(svDirtyKey(t, r, c))));
    el.classList.toggle("sv-dv", !!(sh.dv && sh.dv[key]));
  });
  svSyncRows();
  svRenderImages(t);
  svPaint(t);
  svSaveBtn(t);
}

// 저장 버튼과 바 이름의 점만 갈아 끼운다(표는 다시 그리지 않는다).
export function svSaveBtn(t) {
  const n = svPending(t);
  const box = document.querySelector(".gs-save");
  if (box) box.innerHTML = n ? `<button class="hot" data-sv="save">저장 (${n})</button>` : "";
  const nm = document.querySelector(".fv-bar .fv-name");
  if (nm) nm.textContent = t.label + (n ? " •" : "");
  const ub = document.querySelector('[data-sv="undo"]'), rb = document.querySelector('[data-sv="redo"]');
  if (ub) ub.disabled = !(t._svUndo && t._svUndo.length);
  if (rb) rb.disabled = !(t._svRedo && t._svRedo.length);
  // 텍스트 파일·docx 탭은 markTabDirty로 탭 목록의 동그라미까지 표시하는데(markFileDirty·
  // docxScheduleHashRecheck 등), 표는 이 함수(콘텐츠 바의 점·저장 버튼)만 갱신하고 탭 자체는
  // 건드리지 않아, 여러 탭을 열어 두면 어느 표가 저장되지 않았는지 본문을 열어야 알 수 있다.
  markTabDirty(t.id, !!n);
}

export function svUndo(t, redo) {
  const from = redo ? t._svRedo : t._svUndo, to = redo ? t._svUndo : t._svRedo;
  if (!from || !from.length) return;
  const step = from.pop();
  if (step.si !== (t.sheetIdx || 0)) renderSheetView(t, { nextSheetIdx: step.si });
  const sh = svSheet(t);
  const generation = svNextGeneration(t);
  for (const b of step.batch) {
    const key = b.r + "," + b.c, v = redo ? b.after : b.before;
    if (v === "") delete sh.src[key]; else sh.src[key] = v;
    if (b.sBefore !== undefined) {                       // 서식만 바꾼 단계
      const si = redo ? b.sAfter : b.sBefore;
      const cur = sh.cells[key];
      if (cur) sh.cells[key] = si ? [cur[0], si, cur[2]].filter((x, i) => i < 2 || x) : [cur[0]];
      else if (si) sh.cells[key] = ["", si];
    } else svPut(t, sh, b.r, b.c, v);
    t._svDirty = t._svDirty || new Map();
    const dirtyKey = svDirtyKey(t, b.r, b.c);
    // 서식 단계는 기준값을 안 두므로 그대로 dirty. 값 단계는 원본으로 되돌아왔으면 dirty를 뗀다.
    if (b.sBefore === undefined && t._svBase && t._svBase.has(dirtyKey) && v === t._svBase.get(dirtyKey)) {
      t._svDirty.delete(dirtyKey);
    } else {
      t._svDirty.set(dirtyKey, { r: b.r, c: b.c, style: b.sBefore !== undefined, generation });
    }
  }
  (to || (redo ? (t._svUndo = []) : (t._svRedo = []))).push(step);
  svFinishEdit(t, sh);
  const f = step.batch[0]; if (f) svSet(t, f.r, f.c, false);
}

// 칸 위에 입력칸을 겹쳐 띄운다. 구글 시트처럼 그 칸에서 바로 고친다.
export function svEdit(t, r, c, seed) {
  const sh = svSheet(t); if (!sh) return;
  svCloseEdit(t, false);
  const el = svCellEl(r, c); if (!el) return;
  const host = svOverlayHost(); if (!host) return;
  // svRangeBox와 같은 이유(zoom 아래 offsetLeft/Width가 배율을 안 반영 + 스크롤한 조각[.sv-p]
  // 자신에 붙이면 그 조각의 스크롤값이 좌표에서 다시 한 번 빠져 어긋난다. svOverlayHost 주석
  // 참조). 스크롤하지 않는 #sv-grid 기준 화면 좌표로 계산한다(확인 결과: 스크롤한 뒤 더블클릭
  // 편집 상자가 다른 위치·크기로 표시됨).
  const hr0 = host.getBoundingClientRect(), er0 = el.getBoundingClientRect();
  const ta = document.createElement("textarea");
  ta.className = "sv-ed";
  ta.value = seed != null ? seed : svSrcAt(sh, r, c);
  ta.style.left = (er0.left - hr0.left) + "px";
  ta.style.top = (er0.top - hr0.top) + "px";
  ta.style.minWidth = er0.width + "px";
  ta.style.minHeight = er0.height + "px";
  host.appendChild(ta);
  t._svEd = { r, c, el: ta, si: t.sheetIdx || 0, orig: ta.value };
  ta.focus();
  if (seed != null) { ta.selectionStart = ta.selectionEnd = ta.value.length; } else ta.select();
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(er0.height, ta.scrollHeight) + "px"; };
  ta.addEventListener("input", grow); grow();
}

export function svCloseEdit(t, commit, move) {
  const ed = t._svEd; if (!ed) return false;
  const el = ed.el;
  t._svEd = null;
  const validCommit = !!(commit && el && el.isConnected && fileview.contains(el) && ed.si === (t.sheetIdx || 0));
  const v = el ? el.value : "";
  if (el && el.parentNode) el.parentNode.removeChild(el);
  if (validCommit && v !== ed.orig) svApply(t, [{ r: ed.r, c: ed.c, src: v }]);
  if (validCommit && move) svSet(t, ed.r + (move[0] || 0), ed.c + (move[1] || 0), false);
  else { const g = svPane("sv-pb"); if (g) g.focus(); }
  return true;
}

export function svFormulaEditorDirty(t) {
  const ed = t && t._svFxEd;
  return !!(ed && ed.el && ed.el.isConnected && fileview.contains(ed.el)
    && ed.si === (t.sheetIdx || 0) && ed.el.value !== ed.orig);
}

// 이 표에 아직 저장하지 않은 편집이 있는지 판정한다. 앱 셸(center/tab-close)이 _sv* 을 직접 읽어
// 판정하면 시트 모듈이 그 판정을 다시 앱 셸에서 import 하게 되어, 상태의 소유자와 판정의 소유자가
// 갈라진다. 판정은 상태를 만드는 쪽이 갖는다.
export function svTabDirty(t) {
  if (!t) return false;
  const ed = t._svEd;
  const editorDirty = !!(ed && ed.el && ed.el.isConnected && fileview.contains(ed.el)
    && ed.el.value !== ed.orig);
  return !!(t._svDirty && t._svDirty.size)
    || !!(t._svLayout && Object.keys(t._svLayout).length)
    || !!(t._svMergeEdit && t._svMergeEdit.size)
    || editorDirty
    || svFormulaEditorDirty(t);
}

// 이 표가 화면에서 내려간다. 열려 있던 인라인 편집기는 아직 그 화면에 붙어 있고 같은 시트를
// 보고 있을 때만 값을 받아 닫는다. 그렇지 않으면 그 편집기는 다른 화면의 것이라 값을 받으면
// 하지 않은 편집이 들어간다.
export function svLeaveTab(t) {
  if (!t) return;
  const ed = t._svEd;
  if (ed) {
    if (ed.el && ed.el.isConnected && fileview.contains(ed.el) && ed.si === (t.sheetIdx || 0)) svCloseEdit(t, true);
    else t._svEd = null;
  }
  if (t._svFxEd) svCloseFormulaEdit(t, true);
}

// 이 표가 화면에 올라온다. 어느 시트를 펼지는 부르는 쪽이 정해서 넘긴다.
export function svEnterTab(t, opts) {
  if (t && opts && opts.nextSheetIdx !== undefined) t.sheetIdx = opts.nextSheetIdx;
}

export function svCloseFormulaEdit(t, commit) {
  const ed = t && t._svFxEd; if (!ed) return false;
  t._svFxEd = null;
  const validCommit = !!(commit && ed.el && ed.el.isConnected && fileview.contains(ed.el)
    && ed.si === (t.sheetIdx || 0));
  const value = ed.el ? ed.el.value : "";
  if (validCommit && value !== ed.orig) svApply(t, [{ r: ed.r, c: ed.c, src: value }]);
  return true;
}

// 고를 수 있는 값이 정해진 칸: 작은 목록을 띄워 고르게 한다(구글 시트의 드롭다운).
// body에 붙이고 뷰포트 기준 좌표로 놓는다. pane 안에 붙이면 pane의 overflow:hidden에 잘린다
// (확인 결과: 아래쪽 칸에서 목록이 잘려 보임). 아래에 공간이 없으면 위로 펼치고,
// 그래도 다 못 담으면 안에서 스크롤한다.
export function svPick(t, r, c) {
  const sh = svSheet(t);
  const opts = svDvAt(t, sh, r, c); if (!opts) return false;
  document.querySelectorAll(".sv-pick").forEach((x) => x.remove());
  const el = svCellEl(r, c); if (!el) return false;
  const box = document.createElement("div");
  box.className = "sv-pick";
  box.innerHTML = opts.map((o) => `<button data-opt="${esc(o)}">${esc(o)}</button>`).join("") + `<button data-opt="">(비우기)</button>`;
  document.body.appendChild(box);
  const rect = el.getBoundingClientRect();
  const naturalH = box.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - 4, spaceAbove = rect.top - 4;
  const openUp = naturalH > spaceBelow && spaceAbove > spaceBelow;
  const cap = Math.max(60, openUp ? spaceAbove : spaceBelow);
  const h = Math.min(naturalH, cap);
  box.style.maxHeight = cap + "px";
  box.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - box.offsetWidth - 4)) + "px";
  box.style.top = (openUp ? rect.top - h : rect.bottom) + "px";
  box.addEventListener("mousedown", (e) => {
    const b = e.target.closest("[data-opt]"); if (!b) return;
    e.preventDefault();
    svApply(t, [{ r, c, src: b.dataset.opt }]);
    box.remove();
  });
  setTimeout(() => {
    const sx = svPane("sv-sbx"), sy = svPane("sv-sby");
    const cleanup = () => {
      document.removeEventListener("mousedown", off, true);
      if (sx) sx.removeEventListener("scroll", close);
      if (sy) sy.removeEventListener("scroll", close);
    };
    const close = () => { box.remove(); cleanup(); };
    const off = (ev) => { if (!box.contains(ev.target)) close(); };
    document.addEventListener("mousedown", off, true);
    if (sx) sx.addEventListener("scroll", close, { once: true });
    if (sy) sy.addEventListener("scroll", close, { once: true });
  }, 0);
  return true;
}

// 행·열 삽입: 병합·고정·서식이 얽혀 있어 화면에서 좌표를 손으로 밀지 않는다. 서버에 한 번에
// 시키고(exceljs가 실제 구조를 옮김) 성공하면 파일을 통째로 다시 읽어 그 결과를 그대로 반영한다.
// 저장 안 한 편집이 있으면 좌표가 어긋날 수 있어(그 편집은 삽입 전 좌표를 가리킨다) 먼저 저장을
// 요구한다.
export async function svInsert(t, axis, at) {
  const sh = svSheet(t); if (!sh) return;
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const note = $("#sv-note");
  if (note) note.textContent = axis === "row" ? "행 삽입하는 중…" : "열 삽입하는 중…";
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, insert: { axis, at, count: 1 } }], space: getCenterSpace(), tabId: t.id, reason: "insert" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "insert", getCenterSpace(), t.id);
    if (note) { note.textContent = "삽입했습니다"; setTimeout(() => { if (note.isConnected) note.textContent = ""; }, 1500); }
  } catch (e) {
    showToast("삽입 실패: " + e.message);
    if (note) note.textContent = "";
  }
}

export async function svDelete(t, axis, at, count) {
  const sh = svSheet(t); if (!sh) return;
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const note = $("#sv-note");
  if (note) note.textContent = axis === "row" ? "행 삭제하는 중…" : "열 삭제하는 중…";
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, delete: { axis, at, count } }], space: getCenterSpace(), tabId: t.id, reason: "delete" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "delete", getCenterSpace(), t.id);
    if (note) { note.textContent = "삭제했습니다"; setTimeout(() => { if (note.isConnected) note.textContent = ""; }, 1500); }
  } catch (e) {
    showToast("삭제 실패: " + e.message);
    if (note) note.textContent = "";
  }
}

// 저장: 바뀐 칸만 서버로 보낸다. 수식은 계산해 둔 결과까지 함께 보낸다(안 보내면 다음에 열 때
// 그 칸이 빈칸으로 보인다).
export function svPending(t) {
  return (t._svDirty ? t._svDirty.size : 0)
    + (t._svLayout ? Object.keys(t._svLayout).length : 0)
    + (t._svMergeEdit ? t._svMergeEdit.size : 0);
}

export function svSave(t) {
  const space = arguments[1];
  if (t._saveInFlight) return t._saveInFlight;
  if (t._svEd) svCloseEdit(t, true);
  if (!svPending(t)) return;
  const book = t.sheet;
  const ctx = { book, cache: new Map(), busy: new Set() };
  const styles = svStyles(t);
  const edits = [];
  for (const [k, pos] of (t._svDirty || new Map())) {
    const si = Number(k.split("|")[0]);
    const sh = book.sheets[si]; if (!sh) continue;
    const src = svSrcAt(sh, pos.r, pos.c);
    const e = { sheet: sh.name, r: pos.r, c: pos.c, v: src };
    if (src && src[0] === "=") { const v = svCellVal(ctx, si, pos.r, pos.c); if (v !== "" && !svErr(v)) e.result = v; }
    // 서식을 바꾼 칸은 그 서식도 함께 보낸다. 보내지 않으면 화면만 바뀌고 파일은 그대로다.
    if (pos.style) { const cur = sh.cells[pos.r + "," + pos.c]; e.style = cur && cur[1] ? styles[cur[1] - 1] : {}; }
    edits.push(e);
  }
  for (const k of Object.keys(t._svLayout || {})) {
    const L = t._svLayout[k];
    edits.push({ sheet: L.sheet, layout: { kind: L.kind, i: L.i, px: L.px } });
  }
  for (const [sheet, merge] of (t._svMergeEdit || new Map())) {
    edits.push({ sheet, merge: { ranges: merge.ranges.slice() } });
  }
  if (!edits.length) return;
  const snapshot = {
    dirty: new Map([...(t._svDirty || new Map())].map(([key, entry]) => [key, entry.generation])),
    layout: new Map(Object.entries(t._svLayout || {}).map(([key, entry]) => [key, entry.generation])),
    merge: new Map([...(t._svMergeEdit || new Map())].map(([key, entry]) => [key, entry.generation])),
  };
  const pending = sendTabIo({ type: "sheet.write", path: t.path, edits, space: space || getCenterSpace(), tabId: t.id, reason: "save" });
  t._svSaving = { requestId: pending.requestId, snapshot, path: t.path, promise: null };
  const saving = t._svSaving;
  const completion = (async () => {
    const message = await pending;
    if (message.error) throw new Error(message.error);
    return message;
  })().catch((error) => {
    if (t._svSaving === saving) t._svSaving = null;
    const note = $("#sv-note"); if (note) note.textContent = "저장 실패: " + error.message;
    showToast("저장 실패: " + error.message);
    throw error;
  }).finally(() => { if (t._saveInFlight === completion) t._saveInFlight = null; });
  saving.promise = completion;
  t._saveInFlight = completion;
  const note = $("#sv-note"); if (note) note.textContent = "저장하는 중…";
  return completion;
}

// 고른 범위를 두른 테두리. 구글 시트는 고른 범위 전체를 2px 파란 선으로 두르고, 그 안에서
// 활성 칸 하나를 다시 같은 굵기로 두른다(확인 결과: 바깥 J282:L285 과 안쪽 J282 가 둘 다
// 2px #3370eb). 칸의 테두리로는 이 둘을 겹쳐 그릴 수 없어 조각 위에 겹치는 상자로 그린다.
// 셀 오버레이(선택 박스·채우기 손잡이·그림)의 컨테이너다. #sv-grid는 조각(sv-pt/pb/pl)을 담는
// 바깥 요소이고 그 자체는 스크롤하지 않는다. 이 오버레이를 조각(.sv-p, 실제 스크롤되는
// 요소) 안에 넣고 그 조각 기준 상대좌표를 쓰면, 조각도 스크롤 컨테이너라 absolute 자식의
// top/left는 "스크롤된 콘텐츠 원점"에서 다시 한 번 스크롤값만큼 밀린다. getBoundingClientRect
// 차이(이미 스크롤이 반영된 화면 좌표)를 그 위에 얹으면 스크롤값이 두 번 빠져(요소가 실제
// 칸보다 스크롤량만큼 더 위/왼쪽으로 밀림), 화면이 처음 그려질 때(스크롤 0)는 안 보이다가
// 실제로 스크롤하면 좌표가 어긋난다(확인 결과: 위로 400px 스크롤한 표에서 칸은
// y=1612인데 선택 박스는 y=180). #sv-grid는 스크롤하지 않는 바깥 요소라 여기에 붙이면 이 문제가
// 없다.
function svOverlayHost() { return document.getElementById("sv-grid"); }

export function svRangeBox(t) {
  document.querySelectorAll(".sv-rng").forEach((x) => x.remove());
  if (!t || !t._svSel) return;
  const host = svOverlayHost(); if (!host) return;
  const hr = host.getBoundingClientRect();
  for (const rg of svAllRanges(t)) {
    const s = svNorm(rg);
    const a = svCellEl(s.r1, s.c1), b = svCellEl(s.r2, s.c2);
    if (!a || !b) continue;
    const pane = a.closest(".sv-p");
    if (!pane || b.closest(".sv-p") !== pane) continue;      // 조각을 넘는 범위는 두르지 않는다
    // offsetLeft/Top/Width/Height는 셀이 확대/축소(zoom)된 표 안에 있으면 배율을 반영하지 않는다
    // (칸은 배율만큼 커 보이는데 이 값들은 그 전 크기를 돌려줌). 그래서 화면 좌표(getBoundingClientRect,
    // 항상 실제로 그려진 크기를 돌려줌)로 상대 위치를 계산해야 확대 상태에서도 칸과 정확히
    // 겹친다(확인 결과: 150% 확대에서 칸은 120x31.5px, 이 박스는 80x21px).
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "sv-rng";
    box.style.left = (ar.left - hr.left) + "px";
    box.style.top = (ar.top - hr.top) + "px";
    box.style.width = (br.right - ar.left) + "px";
    box.style.height = (br.bottom - ar.top) + "px";
    host.appendChild(box);
  }
}

// 셀에 고정된 그림: svRangeBox와 같은 이유로 #sv-grid 기준 화면 좌표를 쓴다(그림 크기는 원본 px에
// 확대 배율을 직접 곱해야 한다. 오버레이는 zoom 적용 밖이다).
export function svRenderImages(t) {
  document.querySelectorAll(".sv-img").forEach((x) => x.remove());
  const sh = svSheet(t); if (!sh || !sh.images || !sh.images.length) return;
  const host = svOverlayHost(); if (!host) return;
  const hr = host.getBoundingClientRect();
  const z = t._svZoom || 1;
  for (const im of sh.images) {
    const a = svCellEl(im.r, im.c); if (!a) continue;
    const ar = a.getBoundingClientRect();
    const img = document.createElement("img");
    img.className = "sv-img";
    img.src = im.dataUrl;
    img.style.left = (ar.left - hr.left) + "px";
    img.style.top = (ar.top - hr.top) + "px";
    img.style.width = Math.round(im.w * z) + "px";
    img.style.height = Math.round(im.h * z) + "px";
    host.appendChild(img);
  }
}

// ── 드래그로 연속 채우기 ────────────────────────────────────────────────────
// 구글 시트처럼 고른 범위의 오른쪽 아래 모서리에 손잡이가 뜨고, 끌면 그 방향으로
// 채운다. ⌘D(아래로 채우기)·⌘R(오른쪽으로 채우기)도 같은 경로를 쓴다.
//
// 무엇을 채우는가:
// - 고른 칸이 하나이고 숫자면 그대로 복사한다(구글 시트와 같다).
// - 고른 칸이 둘 이상이고 숫자면 그 간격을 이어 간다(1,2 → 3,4,5 / 2,4 → 6,8).
// - 글자 끝에 숫자가 붙어 있으면 그 숫자를 1씩 올린다(항목1 → 항목2).
// - 수식은 상대 참조를 옮겨 준다($ 붙은 참조는 그대로 둔다).
// - 나머지는 고른 것을 차례로 되풀이한다.
export function svFillHandle(t) {
  document.querySelectorAll(".sv-fill").forEach((x) => x.remove());
  if (!t || !t._svSel) return;
  const s = svNorm(t._svSel);
  const el = svCellEl(s.r2, s.c2); if (!el) return;
  const host = svOverlayHost(); if (!host) return;
  // svRangeBox와 같은 이유(zoom 아래 offsetLeft/Width가 배율을 안 반영 + #sv-grid는 스크롤하지
  // 않는 바깥 요소여야 스크롤 후에도 좌표가 어긋나지 않음)로 화면 좌표로 계산한다.
  const hr = host.getBoundingClientRect(), er = el.getBoundingClientRect();
  const h = document.createElement("div");
  h.className = "sv-fill";
  h.style.left = (er.right - hr.left - 5) + "px";
  h.style.top = (er.bottom - hr.top - 5) + "px";
  host.appendChild(h);
}

// 글자 끝의 숫자를 떼어 낸다: "항목12" → ["항목", 12]
function svTail(sv) {
  const m = /^(.*?)(\d+)$/.exec(String(sv));
  return m ? [m[1], Number(m[2]), m[2].length] : null;
}

// 수식의 상대 참조를 dr·dc 만큼 옮긴다. $가 붙은 참조는 건드리지 않는다.
function svShift(f, dr, dc) {
  return f.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (all, ac, cl, ar, rw) => {
    // 따옴표 안의 글자는 참조가 아니지만, 여기서는 시트 이름이 앞에 붙은 형태만 그대로 둔다.
    let c = 0;
    for (const ch of cl.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    let r = Number(rw);
    if (!ac) c += dc;
    if (!ar) r += dr;
    if (c < 1 || r < 1) return "#REF!";
    let name = "";
    let n = c;
    while (n > 0) { const m2 = (n - 1) % 26; name = String.fromCharCode(65 + m2) + name; n = (n - 1 - m2) / 26; }
    return ac + name + ar + r;
  });
}

// 씨앗 목록(고른 칸들의 원본 글자)에서 i번째 다음 값을 만든다.
function svNext(seed, i, dr, dc) {
  const n = seed.length;
  const base = seed[i % n];
  if (base === "" || base == null) return "";
  if (String(base)[0] === "=") return "=" + svShift(String(base).slice(1), dr, dc);
  const nums = seed.map((x) => (x === "" ? null : Number(String(x).replace(/,/g, ""))));
  const allNum = nums.every((x) => x != null && Number.isFinite(x));
  if (allNum) {
    if (n === 1) return String(nums[0]);                    // 한 칸이면 그대로 복사(구글 시트와 같다)
    let step = 0;
    for (let k = 1; k < n; k++) step += nums[k] - nums[k - 1];
    step /= (n - 1);
    const v = nums[n - 1] + step * (i + 1);
    return String(Math.round(v * 1e10) / 1e10);
  }
  const tl = svTail(base);
  if (tl && n === 1) {
    const [head, num, w] = tl;
    return head + String(num + i + 1).padStart(w, "0");
  }
  if (tl) {
    const tails = seed.map(svTail);
    if (tails.every(Boolean) && tails.every((x) => x[0] === tails[0][0])) {
      let step = 0;
      for (let k = 1; k < n; k++) step += tails[k][1] - tails[k - 1][1];
      step /= (n - 1);
      return tails[0][0] + String(Math.round(tails[n - 1][1] + step * (i + 1))).padStart(tails[0][2], "0");
    }
  }
  return String(base);                                       // 그 밖에는 되풀이
}

// 고른 범위를 목표 범위까지 채운다.
function svFill(t, to) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const ch = [];
  if (to.r2 > s.r2 || to.r1 < s.r1) {                        // 세로로 채우기
    const down = to.r2 > s.r2;
    for (let c = s.c1; c <= s.c2; c++) {
      const seed = [];
      for (let r = s.r1; r <= s.r2; r++) seed.push(svSrcAt(sh, r, c));
      if (!down) seed.reverse();
      const from = down ? s.r2 + 1 : s.r1 - 1, end = down ? to.r2 : to.r1;
      const n = seed.length;
      for (let i = 0, r = from; down ? r <= end : r >= end; i++, r += down ? 1 : -1) {
        const seedRow = down ? s.r1 + (i % n) : s.r2 - (i % n);
        ch.push({ r, c, src: svNext(seed, i, r - seedRow, 0) });
      }
    }
  }
  if (to.c2 > s.c2 || to.c1 < s.c1) {                        // 가로로 채우기
    const right = to.c2 > s.c2;
    for (let r = s.r1; r <= s.r2; r++) {
      const seed = [];
      for (let c = s.c1; c <= s.c2; c++) seed.push(svSrcAt(sh, r, c));
      if (!right) seed.reverse();
      const from = right ? s.c2 + 1 : s.c1 - 1, end = right ? to.c2 : to.c1;
      const n = seed.length;
      for (let i = 0, c = from; right ? c <= end : c >= end; i++, c += right ? 1 : -1) {
        const seedCol = right ? s.c1 + (i % n) : s.c2 - (i % n);
        ch.push({ r, c, src: svNext(seed, i, 0, c - seedCol) });
      }
    }
  }
  if (!ch.length) return;
  svGrowTo(t, sh, Math.min(sh.rows, Math.max(to.r2, s.r2)));
  svApply(t, ch);
  t._svSel = { r1: Math.min(s.r1, to.r1), c1: Math.min(s.c1, to.c1), r2: Math.max(s.r2, to.r2), c2: Math.max(s.c2, to.c2) };
  svPaint(t);
}

// ⌘D·⌘R: 고른 범위의 첫 줄·첫 칸을 기준으로 나머지를 채운다(구글 시트와 같다).
export function svFillFrom(t, dir) {
  const s = svNorm(t._svSel);
  if (dir === "down") {
    if (s.r2 <= s.r1) return;
    t._svSel = { r1: s.r1, c1: s.c1, r2: s.r1, c2: s.c2 };
    svFill(t, { r1: s.r1, r2: s.r2, c1: s.c1, c2: s.c2 });
  } else {
    if (s.c2 <= s.c1) return;
    t._svSel = { r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c1 };
    svFill(t, { r1: s.r1, r2: s.r2, c1: s.c1, c2: s.c2 });
  }
}

// 손잡이를 끄는 동안 한 축으로만 늘린다(구글 시트와 같고, 대각선으로는 늘어나지 않는다).
let svFillDrag = null;
function initSheetFillEvents() {
  fileview.addEventListener("mousedown", (e) => {
    const t = svTab(); if (!t) return;
    if (!e.target.closest(".sv-fill")) return;
    e.preventDefault(); e.stopPropagation();
    svFillDrag = { base: svNorm(t._svSel) };
  }, true);
  fileview.addEventListener("mouseover", (e) => {
    if (!svFillDrag) return;
    const t = svTab(); if (!t) return;
    const td = e.target.closest("#sv-grid td.sv-c"); if (!td || td.classList.contains("sv-mv")) return;
    const r = +td.dataset.r, c = +td.dataset.c, b = svFillDrag.base;
    const dr = r > b.r2 ? r - b.r2 : r < b.r1 ? b.r1 - r : 0;
    const dc = c > b.c2 ? c - b.c2 : c < b.c1 ? b.c1 - c : 0;
    const to = dr >= dc
      ? { r1: Math.min(b.r1, r), r2: Math.max(b.r2, r), c1: b.c1, c2: b.c2 }
      : { r1: b.r1, r2: b.r2, c1: Math.min(b.c1, c), c2: Math.max(b.c2, c) };
    svFillDrag.to = to;
    document.querySelectorAll("#sv-grid td.sv-pre").forEach((x) => x.classList.remove("sv-pre"));
    for (let rr = to.r1; rr <= to.r2; rr++) for (let cc = to.c1; cc <= to.c2; cc++) {
      if (rr >= b.r1 && rr <= b.r2 && cc >= b.c1 && cc <= b.c2) continue;
      const el = svCellEl(rr, cc); if (el) el.classList.add("sv-pre");
    }
  });
  document.addEventListener("mouseup", () => {
    if (!svFillDrag) return;
    const d = svFillDrag; svFillDrag = null;
    document.querySelectorAll("#sv-grid td.sv-pre").forEach((x) => x.classList.remove("sv-pre"));
    const t = svTab(); if (!t || !d.to) return;
    svFill(t, d.to);
  });
}


// ── 서식 ────────────────────────────────────────────────────────────────────
// 굵게·기울임·밑줄·취소선·맞춤·줄바꿈. 화면에서 바뀐 것이 저장할 때 파일에도 그대로 들어간다.
// 화면에서만 바뀌고 파일이 그대로면 전달한 파일이 화면과 달라진다.
function svPoolAdd(t, st) {
  const keys = Object.keys(st).filter((k) => st[k] !== undefined && st[k] !== null && st[k] !== "");
  if (!keys.length) return 0;
  const clean = {};
  keys.sort().forEach((k) => { clean[k] = st[k]; });
  const sig = JSON.stringify(clean);
  const list = (t.sheet.styles = t.sheet.styles || []);
  for (let i = 0; i < list.length; i++) if (JSON.stringify(list[i]) === sig) return i + 1;
  list.push(clean);
  return list.length;
}

export function svFormat(t, mut) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const styles = svStyles(t), batch = [];
  let generation = null;
  if (!t._svDirty) t._svDirty = new Map();
  svEachCell(t, (r, c) => {
    const key = r + "," + c;
    if (t._svMerge.hidden.has(key)) return;
    const cur = sh.cells[key];
    const before = cur ? (cur[1] || 0) : 0;
    const st = before ? Object.assign({}, styles[before - 1]) : {};
    mut(st, sh, r, c);
    const after = svPoolAdd(t, st);
    if (after === before) return;
    if (generation === null) generation = svNextGeneration(t);
    batch.push({ r, c, sBefore: before, sAfter: after, before: svSrcAt(sh, r, c), after: svSrcAt(sh, r, c) });
    sh.cells[key] = cur ? [cur[0], after, cur[2]].filter((x, i) => i < 2 || x) : ["", after];
    t._svDirty.set(svDirtyKey(t, r, c), { r, c, style: true, generation });
  });
  if (!batch.length) return;
  (t._svUndo = t._svUndo || []).push({ si: t.sheetIdx || 0, batch, fmt: true });
  t._svRedo = [];
  svFinishEdit(t, sh);
}

// 고른 칸들이 이미 그 서식이면 끄고, 아니면 켠다(구글 시트와 같다).
export function svHas(t, prop) {
  const sh = svSheet(t); if (!sh || !t._svSel) return false;
  const s = svNorm(t._svSel), styles = svStyles(t);
  const cur = sh.cells[s.r1 + "," + s.c1];
  const st = cur && cur[1] ? styles[cur[1] - 1] : null;
  return !!(st && st[prop]);
}

const SV_FMT = {
  "fmt-bold": ["b", 1], "fmt-ital": ["i", 1], "fmt-unde": ["u", 1], "fmt-strk": ["st", 1],
};


