// 시트 렌더: workbook을 네 pane 격자와 메뉴·도구·선택 overlay로 그린다.
//
// 소유 범위
//   pane HTML, 고정 행·열 계산, 가상 렌더 범위, pane 스크롤·행 높이 동기화, 현재 sheet tab 조회.
//
// 제공 API
//   initSheetRender(deps): core·center 의존성을 기존 선언 위치에서 주입받는다.
//   bindSheetRenderEdit(deps), bindSheetRenderActions(deps): 뒤 모듈이 렌더 후처리 콜백을 등록한다.
//   renderSheetView, renderSheetViewBody, svPane, svPanes, svSync, svSyncRows와 가상 렌더 헬퍼.
//
// 의존 대상
//   sheet/model.js·formula.js·conditional.js를 한 방향으로 import한다.
//   main의 $, esc, filePathBarHtml, withFileViewTransition, SHEET_TEXT_RE를 init에서 받고 tab-store를 import한다.
//   edit/actions는 앞 방향 import 뒤 bind 함수로 paint·overlay·현재 style 콜백을 등록한다.
//
// 유지 조건
//   네 pane 분할, 고정 영역의 잘림, 바깥 스크롤 띠가 pane을 이끄는 순서와 ResizeObserver 재렌더 순서.
//   렌더 뒤 wire → selection 초기화 → 행 동기화 → image → fit → paint 순서를 바꾸지 않는다.
//
// 영향 범위
//   center 소유 fileview와 tab-store query 경계,
//   sheet/edit.js·sheet/actions.js·main의 file view 렌더 전환.
//
// model/formula/conditional ← render 방향만 유지한다. 뒤 모듈은 bind API로 앞 방향 의존을 등록한다.
import {
  SV_CHUNK, colName, mergeMap, svStyle, GS_MENUS, GS_TOOLBAR, svSheet, svStyles,
} from "./model.js";
import { svRecalc } from "./formula.js";
import { svCF } from "./conditional.js";
import { getActiveTabId, getCenterSpace, getCurrentTabs } from "../center/tab-store.js";

let $, esc, fileview, filePathBarHtml, withFileViewTransition, SHEET_TEXT_RE;
let svPending, svGrowTo, svPaint, svRangeBox, svFillHandle, svRenderImages, svCurStyle;

export function initSheetRender(deps) {
  ({ $, esc, fileview, filePathBarHtml, withFileViewTransition, SHEET_TEXT_RE } = deps);
  bindSheetRenderEdit(deps);
  bindSheetRenderActions(deps);
}

export function bindSheetRenderEdit(deps) {
  ({ svPending, svGrowTo, svPaint, svRangeBox, svFillHandle, svRenderImages } = deps);
}

export function bindSheetRenderActions(deps) {
  ({ svCurStyle } = deps);
}

export const svTab = () => {
  const centerSpace = getCenterSpace();
  const t = getCurrentTabs().find((x) => x.id === getActiveTabId(centerSpace));
  return t && t.kind === "file" && t.sheetMode && t.sheet ? t : null;
};

// ── 그리기 ──────────────────────────────────────────────────────────────────
// 구글 시트와 같은 네 조각으로 나눈다: 모서리 · 위(고정 행) · 왼쪽(고정 열) · 본문.
//
// 고정된 폭이 화면보다 넓을 때의 동작은 구글 시트를 측정해 그대로 따른다
// (확인 결과: 빈 시트에 11열 고정 + 창 900px. 고정 조각이 격자 폭 888을 통째로 가져가고,
//  본문 조각은 폭 0, 가로 스크롤바는 clientWidth 0이 되어 아예 안 움직였다. 화면 밖으로 나간
//  고정 열은 볼 수 없고, 멀리 있는 칸(R1)을 골라도 화면이 밀리지 않았다.
//  세로도 같다. 고정 행이 창보다 크면 위에서부터 잘리고 아래 15px만 본문에 남았다.)
//
// 즉 고정 조각에 따로 스크롤을 붙이지 않는다. 넘치면 자른다. 좁아서 보이지 않는 것은 창을 넓혀
// 해결한다. 구글 시트와 같은 방식이다.
const SV_RH_W = 44;                       // 행 머리 폭
const SV_KEEP = 15;                       // 고정 조각이 다 먹어도 본문에 남기는 세로 자리(측정값)
const SV_FZDIV = 4;                       // 고정 경계에 그리는 띠 두께(구글 시트 확인 결과: 4px #c7c7c7)
// 마지막 데이터 행까지만 스크롤되면 그 줄이 화면 맨 밑에 붙어 잘려 보인다(확인
// 결과). 구글 시트처럼 데이터 아래로 빈 줄을 더 두어 마지막 줄이 화면 안쪽으로 올라올 여유를 준다.
const SV_TAIL_ROWS = 20;
// 렌더링·가상 스크롤 한계로만 쓰는 "총 줄 수"다. 선택 범위(sh.rows 그대로 써야 함)에는 쓰지 않는다.
export function svRenderRows(sh) { return sh.rows + SV_TAIL_ROWS; }
// 열도 행과 같은 이유로 데이터 끝에서 끊기면 Z열까지 기본 빈 칸으로 보이지 않는다(확인
// 결과). 실데이터가 Z보다 넓으면 그 폭을 그대로 쓴다.
export function svRenderCols(sh) { return Math.max(sh.colsCount, 26); }

function svFrozen(sh) { return { n: sh.freeze ? Math.min(sh.freeze.x || 0, sh.colsCount) : 0, y: sh.freeze ? Math.min(sh.freeze.y || 0, sh.rows) : 0 }; }
export function svColW(sh, c) { return sh.col[c - 1] || 80; }

// 한 조각의 열 정의. 왼쪽 조각들만 행 머리를 갖는다.
function svColsHtml(sh, c1, c2, withRh) {
  let out = "<colgroup>";
  if (withRh) out += `<col style="width:${SV_RH_W}px">`;
  for (let c = c1; c <= c2; c++) out += `<col style="width:${svColW(sh, c)}px">`;
  return out + "</colgroup>";
}
function svPaneW(sh, c1, c2, withRh) {
  let w = withRh ? SV_RH_W : 0;
  for (let c = c1; c <= c2; c++) w += svColW(sh, c);
  return w;
}

function svHeadHtml(t, sh, c1, c2, withRh, fn) {
  let out = `<thead><tr class="sv-hr">`;
  if (withRh) out += `<th class="sv-corner"></th>`;
  for (let c = c1; c <= c2; c++) out += `<th class="sv-ch${c === fn ? " sv-fc-last" : ""}" data-c="${c}">${colName(c)}<span class="sv-cgrip" data-gc="${c}"></span></th>`;
  return out + "</tr></thead>";
}

// 줄 그리기. 조각마다 열 범위와 행 범위가 다르므로 그 경계를 넘는 병합은 잘라 낸다. 자르지 않으면
// 옆 조각 위로 뻗어 다른 칸을 덮는다.
export function svRowsHtml(t, sh, from, to, c1, c2, withRh, fn, rowFrom) {
  const styles = svStyles(t);
  const mm = t._svMerge;
  const filt = t._svFilter;
  let out = "";
  for (let r = from; r <= to; r++) {
    const h = sh.row[r - 1] || 0;
    const filtCls = filt ? (String((sh.cells[r + "," + filt.c] || [""])[0]) === filt.val ? " sv-filter-hit" : " sv-filter-dim") : "";
    out += `<tr data-r="${r}"${filtCls ? ` class="${filtCls.trim()}"` : ""}${h ? ` style="height:${h}px"` : ""}>`;
    if (withRh) out += `<th class="sv-rh" data-r="${r}">${r}<span class="sv-rgrip" data-gr="${r}"></span></th>`;
    for (let c = c1; c <= c2; c++) {
      const key = r + "," + c;
      const hid = mm.hidden.get(key);
      // 병합된 칸: 그 병합의 머리가 이 조각 안에 있으면 칸을 만들지 않고, 밖에 있으면 빈 칸으로 둔다.
      if (hid) {
        if (hid[0] >= rowFrom && hid[1] >= c1 && hid[1] <= c2) continue;
        out += `<td class="sv-c sv-mv" data-r="${r}" data-c="${c}"></td>`;
        continue;
      }
      const span = mm.anchor.get(key);
      const cell = sh.cells[key];
      const text = t._svShowFormulas && sh.src && sh.src[key] != null ? sh.src[key] : (cell ? cell[0] : "");
      const base = cell && cell[1] ? styles[cell[1] - 1] : null;
      const over = svCF(t, sh, r, c, text);
      const st = over ? Object.assign({}, base, over) : base;
      const isNum = !!(cell && cell[2]);
      const rs = span ? Math.min(span.rs, Math.max(1, to - r + 1)) : 1;
      const cs = span ? Math.min(span.cs, c2 - c + 1) : 1;
      const dirty = t._svDirty && t._svDirty.has((t.sheetIdx || 0) + "|" + key);
      const dv = sh.dv && sh.dv[key];
      const note = sh.note && sh.note[key];
      out += `<td class="sv-c${c === fn ? " sv-fc-last" : ""}${dirty ? " sv-dirty" : ""}${dv ? " sv-dv" : ""}${note ? " sv-note" : ""}" data-r="${r}" data-c="${c}"`
        + (rs > 1 || cs > 1 ? ` rowspan="${rs}" colspan="${cs}"` : "")
        + (note ? ` title="${esc(note)}"` : "")
        + ` style="${svStyle(st, isNum)}">${esc(text)}</td>`;
    }
    out += "</tr>";
  }
  return out;
}

function svPaneHtml(t, sh, id, cls, c1, c2, withRh, rowFrom, rowTo, fn, head) {
  const cols = svColsHtml(sh, c1, c2, withRh);
  const w = svPaneW(sh, c1, c2, withRh);
  const z = t._svZoom || 1;
  const body = rowTo >= rowFrom ? `<tbody>${svRowsHtml(t, sh, rowFrom, rowTo, c1, c2, withRh, fn, rowFrom)}</tbody>` : "<tbody></tbody>";
  return `<div class="sv-p ${cls}" id="${id}" tabindex="-1"><table class="sv-t" style="width:${w}px${z !== 1 ? `;zoom:${z}` : ""}">${cols}${head ? svHeadHtml(t, sh, c1, c2, withRh, fn) : ""}${body}</table></div>`;
}

export const svPane = (id) => document.getElementById(id);
export const svPanes = () => [svPane("sv-pc"), svPane("sv-pt"), svPane("sv-pl"), svPane("sv-pb")];

// 조각끼리 줄 높이를 맞춘다. 글자가 접히는 칸은 조각마다 높이가 달라져, 맞추지 않으면 왼쪽 고정 열과
// 본문의 줄이 한 칸씩 어긋난 채로 스크롤된다.
export function svSyncRows() {
  const pairs = [["sv-pc", "sv-pt"], ["sv-pl", "sv-pb"]];
  for (const [a, b] of pairs) {
    const A = svPane(a), B = svPane(b);
    if (!A || !B) continue;
    const ra = A.querySelectorAll("tbody tr"), rb = B.querySelectorAll("tbody tr");
    const n = Math.min(ra.length, rb.length);
    for (let i = 0; i < n; i++) {
      ra[i].style.height = ""; rb[i].style.height = "";
      const h = Math.max(ra[i].offsetHeight, rb[i].offsetHeight);
      ra[i].style.height = h + "px"; rb[i].style.height = h + "px";
    }
    const ha = A.querySelector("thead tr"), hb = B.querySelector("thead tr");
    if (ha && hb) { const h = Math.max(ha.offsetHeight, hb.offsetHeight); ha.style.height = h + "px"; hb.style.height = h + "px"; }
  }
}

export function renderSheetView(t, options) {
  return withFileViewTransition(t, options || {}, () => renderSheetViewBody(t));
}
// 격자의 이름은 이 파일이 정한다(#sv-grid · td.sv-c). 그래서 격자의 존재 여부와
// 특정 위치가 격자 칸인지도 여기서 답한다. 밖에서 선택자를 다시 적으면 이름이 바뀔 때
// 그쪽이 아무것도 찾지 못한다.
export function svGridEl() { return document.querySelector("#sv-grid"); }
export function svCellAt(target) { return target && target.closest ? target.closest("#sv-grid td.sv-c") : null; }

export function renderSheetViewBody(t) {
  const name = esc(t.label);
  const pathBar = filePathBarHtml(t.path);
  if (t.sheetError) {
    fileview.innerHTML = `<div class="fv-bar"><span class="fv-name">${name}</span>${pathBar}</div>`
      + `<div class="sv-msg">이 파일을 표로 열지 못했습니다.<div class="sv-why">${esc(t.sheetError)}</div>
      <button data-sv="finder">Finder에서 열기</button></div>`;
    return;
  }
  if (!t.sheet) { fileview.innerHTML = `<div class="fv-bar"><span class="fv-name">${name}</span>${pathBar}</div><div class="fv-loading">불러오는 중…</div>`; return; }
  const sh = svSheet(t);
  if (!sh) { fileview.innerHTML = `<div class="fv-bar"><span class="fv-name">${name}</span>${pathBar}</div><div class="sv-msg">보여줄 시트가 없습니다.</div>`; return; }

  if (!t._svCalced) { svRecalc(t); t._svCalced = true; }
  t._svMerge = mergeMap(sh.merges);
  const fz = svFrozen(sh);
  t._svFreeze = fz;
  const shown = Math.min(svRenderRows(sh), Math.max(t._svShown || 0, SV_CHUNK));
  t._svShown = shown;
  const z = t._svZoom || 1;

  const availW = (fileview.clientWidth || 900);
  const frozenW = svPaneW(sh, 1, fz.n, true) * z;
  // 고정 조각은 자기 폭을 그대로 받고, 화면을 넘으면 잘린다. 본문은 남는 만큼만 갖는다.
  // 남는 것이 없으면 0이고, 그때는 가로로 움직이지 않는다(구글 시트와 같다).
  // 고정 경계에 그리는 띠도 왼쪽 조각의 폭에 포함된다. 더하지 않으면 고정 열의 마지막 3px이 잘린다.
  const divX = fz.n > 0 ? SV_FZDIV : 1;
  const leftW = Math.min(frozenW + divX, availW);

  const dirtyN = svPending(t);
  const toText = SHEET_TEXT_RE.test(t.path)
    ? `<button data-sv="text">원문</button><button data-sv="table" class="on">표</button>` : "";
  const bar = `<div class="fv-bar">${toText}<span class="fv-name">${name}${dirtyN ? " •" : ""}</span>${filePathBarHtml(t.path)}`
    + `<span class="gs-save">${dirtyN ? `<button class="hot" data-sv="save">저장 (${dirtyN})</button>` : ""}</span></div>`;

  // 메뉴 바·도구 모음은 GS_MENUS·GS_TOOLBAR를 그대로 편다. 여기서 항목을 고르거나 순서를
  // 바꾸지 않는다. 그 목록이 구글 시트 화면에서 수집한 값이다.
  const menu = `<div class="gs-menu">`
    + GS_MENUS.map((m) => `<button data-gm="${m.k}">${esc(m.n)}</button>`).join("")
    + `<span class="gs-note" id="sv-note"></span></div>`;

  const cur = svCurStyle(t);
  const tb = `<div class="gs-tb">` + GS_TOOLBAR.map((it) => {
    if (it === "|") return `<span class="gs-sep"></span>`;
    const [k, label, glyph] = it;
    // 이 둘도 svMenuAt 팝업으로 통일한다. 네이티브 <select> 로 두면 나머지 도구 모음과 달리
    // OS 기본 드롭다운으로 남아 이질적이다(확인 결과: 요소 선택으로 이 select를 직접 짚어
    // 확인). 다른 도구 모음 버튼과 같은
    // svMenuAt(el, svList(...)) 패턴으로 교체.
    if (k === "font") return `<button class="gs-pick" data-sv="font" title="${esc(label)}">${esc(cur.ff || "Arial")}</button>`;
    if (k === "fs") return `<button class="gs-pick gs-fs" data-sv="fs" title="${esc(label)}">${esc(String(cur.fs || 10))}</button>`;
    const on = (k === "fmt-bold" && cur.b) || (k === "fmt-ital" && cur.i) || (k === "fmt-strk" && cur.st) || (k === "wrap" && cur.wrap)
      || (k === "rtl-sheet" && t._svRtl) || (k === "a11y" && t._svA11y) || (k === "hide-menu" && t._svHideMenu)
      || (k === "ltr-cell" && cur.dir === "ltr") || (k === "rtl-cell" && cur.dir === "rtl");
    const dis = (k === "undo" && !(t._svUndo && t._svUndo.length))
      || (k === "redo" && !(t._svRedo && t._svRedo.length))
      || (SHEET_TEXT_RE.test(t.path) && (k === "merge" || k === "merge-kind"));
    const cls = k === "fmt-bold" ? " gs-bold" : k === "fmt-ital" ? " gs-ital" : k === "fmt-strk" ? " gs-strk" : "";
    return `<button data-sv="${k}" class="${cls}${on ? " on" : ""}" title="${esc(label)}"${dis ? " disabled" : ""}>${glyph}</button>`;
  }).join("")
    + `<span class="gs-sep"></span>`
    + `<button data-sv="zoom-out" title="작게 (⌘-)">−</button>`
    + `<button data-sv="zoom-reset" id="sv-zoom" title="원래 크기로 (⌘0)">${Math.round(z * 100)}%</button>`
    + `<button data-sv="zoom-in" title="크게 (⌘+)">＋</button>`
    + `<button data-sv="find" title="찾기 (⌘F)">찾기</button></div>`;

  const fx = `<div class="gs-fx">`
    + `<input class="gs-name" id="sv-name" spellcheck="false" autocomplete="off">`
    + `<span class="gs-fxi">fx</span>`
    + `<input class="gs-in" id="sv-fxin" spellcheck="false" autocomplete="off"></div>`;

  const findBar = `<div class="sv-findbar" id="sv-find" hidden>`
    + `<input id="sv-fq" type="text" placeholder="표에서 찾기" spellcheck="false" autocomplete="off">`
    + `<span class="sv-fstat" id="sv-fstat"></span>`
    + `<button data-sv="find-prev" title="이전 (⇧Enter)">↑</button>`
    + `<button data-sv="find-next" title="다음 (Enter)">↓</button>`
    + `<button data-sv="find-close" title="닫기 (Esc)">✕</button></div>`;

  const cutNote = sh.cut ? `<div class="sv-cut">파일이 커서 일부만 보여줍니다. 전부 보려면 Finder에서 여세요.</div>` : "";
  const N = svRenderCols(sh);
  // 스크롤 채움 막대의 크기 = 전체 내용 크기(구글 시트가 그렇게 싣는다). sh.col은 실데이터
  // 열까지만 채워져 있다. slice(0,N)은 배열 길이를 넘지 못해 꼬리 열(svRenderCols)의 기본 폭이
  // 빠지고, 그만큼 채움 막대가 짧아져 실제 내용보다 일찍 스크롤이 끝난다(확인 결과: 가로 스크롤이
  // Z열까지 가지 않음). svColW와 같은 방식(칸마다 조회 + 기본값 80)으로 직접 더한다.
  let allW = 0;
  for (let c = 1; c <= N; c++) allW += svColW(sh, c);
  allW = Math.round(allW * z);
  let allH = 0;
  for (let r = fz.y + 1; r <= svRenderRows(sh); r++) allH += (sh.row[r - 1] || 21);
  allH = Math.round(allH * z);
  const fzCls = (fz.n > 0 ? " sv-fzx" : "") + (fz.y > 0 ? " sv-fzy" : "");
  const grid = `<div class="sv-grid${fzCls}" id="sv-grid" style="grid-template-columns:${Math.round(leftW)}px 1fr 13px">`
    + svPaneHtml(t, sh, "sv-pc", "sv-pc", 1, fz.n, true, 1, fz.y, fz.n, true)
    + svPaneHtml(t, sh, "sv-pt", "sv-pt", fz.n + 1, N, false, 1, fz.y, 0, true)
    + `<div class="sv-shim sv-shim-e"></div>`
    + svPaneHtml(t, sh, "sv-pl", "sv-pl", 1, fz.n, true, fz.y + 1, shown, fz.n, false)
    + svPaneHtml(t, sh, "sv-pb", "sv-pb", fz.n + 1, N, false, fz.y + 1, shown, 0, false)
    + `<div class="sv-sby" id="sv-sby"><div style="width:1px;height:${allH}px"></div></div>`
    + `<div class="sv-shim sv-shim-b"></div>`
    + `<div class="sv-sbx sv-shim sv-shim-b" id="sv-sbx"><div style="height:1px;width:${allW}px"></div></div>`
    + `</div>`;

  const visSheets = t.sheet.sheets.map((s, i) => [s, i]).filter(([s]) => !s.hidden);
  const tabs = !SHEET_TEXT_RE.test(t.path)
    ? `<div class="sv-tabs">` + visSheets.map(([s, i]) =>
        `<button class="sv-tab${i === (t.sheetIdx || 0) ? " on" : ""}" data-si="${i}">${esc(s.name)}</button>`).join("")
      + `<button class="sv-tab" data-sv="sheet-add" title="시트 추가">＋</button></div>`
    : "";

  // rtl-sheet(시트 전체 방향)·hide-menu(메뉴 숨김)·a11y(고대비)는 셀 단위가 아니라 탭 단위
  // 상태라 svFormat이 아니라 여기 컨테이너 class로 반영한다(svToolbar case 참조).
  const gsClass = "gs" + (t._svA11y ? " gs-a11y" : "") + (t._svRtl ? " gs-rtl" : "") + (t._svHideMenu ? " gs-hide-menu" : "") + (sh.grid === false ? " gs-no-grid" : "");
  fileview.innerHTML = bar + `<div class="${gsClass}">` + menu + tb + fx + cutNote + findBar + grid
    + `<div class="sv-foot">${tabs || `<span class="sv-only">${esc(sh.name)}</span>`}<span class="sv-stat" id="sv-stat"></span></div></div>`;

  svWire(t, sh);
  if (!t._svSel) t._svSel = { r1: 1, c1: 1, r2: 1, c2: 1 };
  svSyncRows();
  svRenderImages(t);
  svFitTop();
  svPaint(t);
  if (t._svScroll) {
    const sx = svPane("sv-sbx"), sy = svPane("sv-sby");
    if (sx) sx.scrollLeft = t._svScroll.left || 0;
    if (sy) sy.scrollTop = t._svScroll.top || 0;
    svSync();
  }
}

// 조각들의 스크롤을 서로 맞춘다. 본문이 기준이고 나머지가 따라간다.
// 바깥 스크롤 띠가 기준이다. 조각들은 그 값을 받아 자기 위치로 옮긴다.
export function svSync() {
  const pb = svPane("sv-pb"), pt = svPane("sv-pt"), pl = svPane("sv-pl");
  const sx = svPane("sv-sbx"), sy = svPane("sv-sby");
  if (!pb) return;
  const x = sx ? sx.scrollLeft : 0, y = sy ? sy.scrollTop : 0;
  pb.scrollLeft = x; if (pt) pt.scrollLeft = x;
  pb.scrollTop = y; if (pl) pl.scrollTop = y;
}

// 고정 행이 창보다 높으면 위 조각을 잘라 배치한다. 구글 시트도 아래 15px만 남기고 자른다.
function svFitTop() {
  const grid = $("#sv-grid"), pc = svPane("sv-pc"), pt = svPane("sv-pt");
  if (!grid || (!pc && !pt)) return;
  const tbl = (pc && pc.querySelector("table")) || (pt && pt.querySelector("table"));
  if (!tbl) return;
  // 위 조각의 아래 테두리(고정 띠)도 조각 높이에 포함된다. 더하지 않으면 고정 행 마지막 줄이 잘린다.
  const divY = grid.classList.contains("sv-fzy") ? SV_FZDIV : 1;
  const natural = tbl.offsetHeight + divY;
  const gh = grid.clientHeight;
  const topH = Math.min(natural, Math.max(0, gh - SV_KEEP));
  grid.style.gridTemplateRows = topH + "px 1fr 13px";
}

function svWire(t, sh) {
  const pb = svPane("sv-pb"), pl = svPane("sv-pl"), pt = svPane("sv-pt");
  const sx = svPane("sv-sbx"), sy = svPane("sv-sby");
  if (!pb) return;
  const onScroll = () => {
    t._svScroll = { top: sy ? sy.scrollTop : 0, left: sx ? sx.scrollLeft : 0 };
    svSync();
    // 선택 박스·채우기 손잡이·그림은 스크롤하지 않는 #sv-grid에 얹혀 있어(svOverlayHost 주석
    // 참조) 스크롤할 때마다 다시 계산해야 칸을 따라간다. 계산하지 않으면 스크롤 전 위치에 남는다.
    svRangeBox(t);
    svFillHandle(t);
    svRenderImages(t);
    if (!sy || t._svShown >= svRenderRows(sh)) return;
    if (sy.scrollTop + sy.clientHeight < sy.scrollHeight - 400) return;
    svGrowTo(t, sh, Math.min(svRenderRows(sh), t._svShown + SV_CHUNK));
  };
  if (sx) sx.addEventListener("scroll", onScroll);
  if (sy) sy.addEventListener("scroll", onScroll);
  // 고정 조각 위에서 굴린 휠은 본문을 가로·세로 모두 움직인다. 고정 조각 자체는 스크롤이
  // 없으므로(구글 시트와 같다) 넘기지 않으면 그 위에서 표가 움직이지 않는다. 특히 화면 대부분이 고정
  // 열이면 휠이 거의 항상 이 조각 위에서 발생하므로, 한 축만 넘기면 다른 축은 움직이지 않는다
  // (확인 결과: 가로를 넘기지 않으면 가로 스크롤이 동작하지 않음).
  const pass = (el) => el && el.addEventListener("wheel", (e) => {
    if (!sx && !sy) return;
    const before = [sy ? sy.scrollTop : 0, sx ? sx.scrollLeft : 0];
    if (sy) sy.scrollTop += e.deltaY;
    if (sx) sx.scrollLeft += e.deltaX;
    // 더 이동할 곳이 없으면 브라우저 기본 동작을 막지 않는다. 막으면 바깥이 스크롤돼야 할 상황에서
    // 아무 일도 일어나지 않는다.
    if ((sy && sy.scrollTop !== before[0]) || (sx && sx.scrollLeft !== before[1])) e.preventDefault();
  }, { passive: false });
  pass(pl); pass(pt); pass(pb); pass(svPane("sv-pc"));
  // 창 크기가 바뀌면 고정 조각의 폭이 달라지므로 다시 그린다(선택 범위·스크롤은 유지한다).
  if (!t._svRO && window.ResizeObserver) {
    t._svRO = new ResizeObserver(() => {
      if (t._svRT) clearTimeout(t._svRT);
      t._svRT = setTimeout(() => { if (svTab() === t) renderSheetView(t); }, 120);
    });
    t._svRO.observe(fileview);
  }
}

