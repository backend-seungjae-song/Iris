// 시트 액션: 메뉴·도구 모음 명령과 클립보드·시트 메타 작업을 맡는다.
//
// 소유 범위
//   svMenuAct·svToolbar dispatch, popup/capture 상태, 필터·병합·정렬·메타·찾기 명령.
//
// 제공 API
//   initSheetActions(deps): core notice·transport와 center 서비스를 기존 선언 위치에서 주입받는다.
//   svMenuAct, svToolbar, svMenuAt, svList, svFind·svFindBar·svZoom과 공유 popup keyboard 헬퍼.
//
// 의존 대상
//   sheet/model.js·formula.js·render.js·edit.js를 한 방향으로 import한다.
//   main의 $, esc, showToast, showNotice, askText, wsSend와 center file 작업을 init에서 받는다.
//
// 유지 조건
//   Google Sheets 메뉴 이름·분기 순서·조건, popup 닫기→선택 callback 순서, 저장 전 dirty guard.
//   지원하지 않는 명령도 기존 문구로 알리고, 조용히 성공 처리하지 않는다.
//
// 영향 범위
//   center 소유 상태 centerSpace·docxview, center의 openFilePalette·removeTabsNow·file I/O,
//   core notice(showToast·showNotice·askText), sheet/events.js와 main의 docx popup 재사용 경로.
//
// model/formula/conditional ← render ← edit ← actions 방향만 유지한다.
import {
  GS_ALIGN_H, GS_ALIGN_V, GS_BORDERS, GS_COLORS, GS_FONTS, GS_NUMFMT, GS_ROTATE,
  GS_SIZES, GS_WRAP, colName, svSheet, svSrcAt, svStyles,
} from "./model.js";
import { svA1, svCellVal, svRecalc } from "./formula.js";
import { bindSheetRenderActions, renderSheetView, svPane } from "./render.js";
import {
  svApply, svDelete, svEdit, svFormat, svHas, svInsert, svNextGeneration, svNorm,
  svRenderImages, svSaveBtn, svSet, svUndo,
} from "./edit.js";
import { getCenterSpace } from "../center/tab-store.js";

let $, esc, askText, showNotice, showToast, wsSend;
let acHost, docxview, isSheetTabDirty, openFilePalette, removeTabsNow, requestFileContent;
let sendTabIo, SHEET_TEXT_RE;

export function initSheetActions(deps) {
  ({ $, esc, askText, showNotice, showToast, wsSend } = deps);
  ({ acHost, docxview, isSheetTabDirty, openFilePalette, removeTabsNow, requestFileContent,
    sendTabIo, SHEET_TEXT_RE } = deps);
  bindSheetRenderActions({ svCurStyle });
}

// ── 도구 모음·메뉴가 실제로 하는 일 ────────────────────────────────────────
// 고른 칸의 현재 서식(도구 모음이 눌린 상태로 보여야 한다).
export function svCurStyle(t) {
  const sh = svSheet(t);
  if (!sh || !t._svSel) return {};
  const c = sh.cells[t._svSel.r1 + "," + t._svSel.c1];
  return (c && c[1] ? svStyles(t)[c[1] - 1] : null) || {};
}

// 작은 목록을 띄운다(글꼴·색·테두리·맞춤 등 구글 시트가 ▾로 여는 것들).
export function svClosePopups() {
  document.querySelectorAll(".gs-pop").forEach((box) => {
    if (typeof box._gsClose === "function") box._gsClose();
    else box.remove();
  });
}
// 시트 메뉴의 하위목록(선택하여 붙여넣기·표시·고정·함수 등)을 팝업 교체가 아니라 docx처럼
// 같은 팝업 안 아코디언으로 펼치기 위한 캡처 모드다. 실제 핸들러(svMenuAct)를 그대로 다시 불러
// svMenuAt이 열려던 팝업의 html/onPick만 가로채고, 진짜 팝업은 띄우지 않는다. 핸들러를 통째로
// 복제하지 않아도 되는 대신, 후보 라벨은 "svMenuAt을 부르기 전에 다른 부수효과가 없는" 것만
// SV_MENU_SUBLIST로 미리 검증해 골랐다(직접 동작을 실행하는 라벨을 캡처하면 그 동작이 그대로
// 실행된다).
let svCapture = null;
export function svCaptureSub(t, menu, item) {
  svCapture = {};
  svMenuAct(t, menu, item);
  const c = svCapture;
  svCapture = null;
  return c.html ? c : null;
}
export function svMenuAt(anchor, html, onPick) {
  if (svCapture) { svCapture.html = html; svCapture.onPick = onPick; return null; }
  svClosePopups();
  const box = document.createElement("div");
  box.className = "gs-pop";
  box.innerHTML = html;
  document.body.appendChild(box);
  let off = null;
  const close = () => {
    if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "false");
    box.remove();
    if (off) { document.removeEventListener("mousedown", off, true); off = null; }
  };
  box._gsClose = close;
  if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "true");
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.min(r.left, innerWidth - box.offsetWidth - 8) + "px";
  box.style.top = (r.bottom + 2) + "px";
  box.addEventListener("mousedown", (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return;
    e.preventDefault();
    close();
    onPick(b.dataset.pick, b);
  });
  setTimeout(() => {
    if (!box.isConnected) return;
    off = (ev) => { if (!box.contains(ev.target)) close(); };
    document.addEventListener("mousedown", off, true);
  }, 0);
  return box;
}
export function gdFocusPopupItem(box, last) {
  if (!box) return;
  const items = Array.from(box.querySelectorAll('button[data-pick]:not(:disabled):not([aria-disabled="true"])'));
  const item = last ? items[items.length - 1] : items[0];
  if (item) item.focus();
}
export function gdWireMenuKeyboard(anchor, box) {
  box.setAttribute("role", "menu");
  box.addEventListener("keydown", (e) => {
    const items = Array.from(box.querySelectorAll('button[data-pick]:not(:disabled):not([aria-disabled="true"])'));
    const current = e.target.closest("button[data-pick]");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      let index = items.indexOf(current);
      if (index < 0) index = step > 0 ? -1 : 0;
      if (items.length) items[(index + step + items.length) % items.length].focus();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const menus = Array.from(docxview.querySelectorAll(".gd-menu [data-gm]"));
      const step = e.key === "ArrowRight" ? 1 : -1;
      const index = menus.indexOf(anchor);
      const next = menus[(index + step + menus.length) % menus.length];
      if (!next) return;
      box._gsClose();
      next.focus();
      next.click();
      gdFocusPopupItem(document.querySelector(".gs-pop"), e.key === "ArrowLeft");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      box._gsClose();
      anchor.focus();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && current) {
      e.preventDefault();
      current.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      anchor.focus();
    }
  });
}
export const svList = (rows) => rows.map((r) => `<button data-pick="${esc(String(r[1]))}">${esc(r[0])}</button>`).join("");
const svSwatches = () => `<div class="gs-sw">` + GS_COLORS.map((c) =>
  `<button data-pick="${c}" style="background:${c}" title="${c}"></button>`).join("") + `</div>`
  + `<button data-pick="" class="gs-none">없음</button>`;

// 숫자 서식의 소수 자릿수를 한 칸 늘리고 줄인다.
function svDec(nf, d) {
  const f = String(nf || "");
  const m = f.match(/\.(0+)/);
  const cur = m ? m[1].length : 0;
  const next = Math.max(0, Math.min(10, cur + d));
  if (!f || f === "General") return next ? "0." + "0".repeat(next) : "0";
  if (m) return next ? f.replace(/\.(0+)/, "." + "0".repeat(next)) : f.replace(/\.(0+)/, "");
  return next ? f.replace(/(0|#)(?![0#.,])/, "$1." + "0".repeat(next)) : f;
}

// 테두리: 고른 범위에 구글 시트와 같은 방식으로 건다.
function svBorder(t, kind) {
  const s = svNorm(t._svSel);
  const line = "1px solid #000000";
  svFormat(t, (st, sh, r, c) => {
    const edgeT = r === s.r1, edgeB = r === s.r2, edgeL = c === s.c1, edgeR = c === s.c2;
    const set = (k, on) => { if (on) st[k] = line; else delete st[k]; };
    if (kind === "none") { delete st.bt; delete st.bb; delete st.bl; delete st.br; return; }
    if (kind === "all") { st.bt = st.bb = st.bl = st.br = line; return; }
    if (kind === "outer") { set("bt", edgeT); set("bb", edgeB); set("bl", edgeL); set("br", edgeR); return; }
    if (kind === "inner") { set("bt", !edgeT); set("bb", !edgeB); set("bl", !edgeL); set("br", !edgeR); return; }
    if (kind === "h") { set("bt", !edgeT); set("bb", !edgeB); return; }
    if (kind === "v") { set("bl", !edgeL); set("br", !edgeR); return; }
    if (kind === "top") { set("bt", edgeT); return; }
    if (kind === "bottom") { set("bb", edgeB); return; }
    if (kind === "left") { set("bl", edgeL); return; }
    if (kind === "right") { set("br", edgeR); return; }
  });
}

// 도구 모음 한 칸을 눌렀을 때. 이름은 구글 시트의 것을 그대로 쓴다.
export function svToolbar(t, act, el) {
  if (SHEET_TEXT_RE.test(t.path) && (act === "merge" || act === "merge-kind")) return true;
  const sh = svSheet(t); if (!sh) return true;
  const tog = (p) => { const on = svHas(t, p); svFormat(t, (st) => { if (on) delete st[p]; else st[p] = 1; }); };
  switch (act) {
    case "undo": svUndo(t, false); return true;
    case "redo": svUndo(t, true); return true;
    case "print": window.print(); return true;
    case "painter": t._svBrush = Object.assign({}, svCurStyle(t)); showToast("서식을 복사했습니다. 붙일 곳을 고르고 서식 붙여넣기를 누르세요"); return true;
    case "painter-paste": if (t._svBrush) svFormat(t, (st) => { for (const k of Object.keys(st)) delete st[k]; Object.assign(st, t._svBrush); }); return true;
    case "nf-won": svFormat(t, (st) => { st.nf = "₩#,##0"; }); return true;
    case "nf-pct": svFormat(t, (st) => { st.nf = "0.00%"; }); return true;
    case "nf-dec-": svFormat(t, (st) => { st.nf = svDec(st.nf, -1); }); return true;
    case "nf-dec+": svFormat(t, (st) => { st.nf = svDec(st.nf, 1); }); return true;
    case "nf-more": svMenuAt(el, svList(GS_NUMFMT), (v) => svFormat(t, (st) => { if (v) st.nf = v; else delete st.nf; })); return true;
    case "font": svMenuAt(el, svList(GS_FONTS.map((f) => [f, f])), (v) => svFormat(t, (st) => { st.ff = v; })); return true;
    case "fs": svMenuAt(el, svList(GS_SIZES.map((n) => [String(n), n])), (v) => svFormat(t, (st) => { st.fs = Number(v); })); return true;
    case "fs-": svFormat(t, (st) => { st.fs = Math.max(6, (st.fs || 10) - 1); }); return true;
    case "fs+": svFormat(t, (st) => { st.fs = Math.min(96, (st.fs || 10) + 1); }); return true;
    case "fmt-bold": tog("b"); return true;
    case "fmt-ital": tog("i"); return true;
    case "fmt-strk": tog("st"); return true;
    case "color-text": svMenuAt(el, svSwatches(), (v) => svFormat(t, (st) => { if (v) st.c = v; else delete st.c; })); return true;
    case "color-fill": svMenuAt(el, svSwatches(), (v) => svFormat(t, (st) => { if (v) st.bg = v; else delete st.bg; })); return true;
    case "border": svMenuAt(el, svList(GS_BORDERS), (v) => svBorder(t, v)); return true;
    case "align-h": svMenuAt(el, svList(GS_ALIGN_H), (v) => svFormat(t, (st) => { st.ha = v; })); return true;
    case "align-v": svMenuAt(el, svList(GS_ALIGN_V), (v) => svFormat(t, (st) => { st.va = v; })); return true;
    case "wrap": svMenuAt(el, svList(GS_WRAP), (v) => svFormat(t, (st) => { if (v === "1") st.wrap = 1; else delete st.wrap; st.clip = v === "2" ? 1 : undefined; })); return true;
    case "rotate": svMenuAt(el, svList(GS_ROTATE), (v) => svFormat(t, (st) => { const n = Number(v); if (n) st.rot = n; else delete st.rot; })); return true;
    case "merge": svMerge(t, "all"); return true;
    case "merge-kind": svMenuAt(el, svList([["모두 병합", "all"], ["가로로 병합", "h"], ["세로로 병합", "v"], ["병합 취소", "none"]]), (v) => svMerge(t, v)); return true;
    case "fn": svMenuAt(el, svList([["SUM", "SUM"], ["AVERAGE", "AVERAGE"], ["COUNT", "COUNT"], ["COUNTA", "COUNTA"], ["MAX", "MAX"], ["MIN", "MIN"], ["COUNTIF", "COUNTIF"], ["SUMIF", "SUMIF"], ["IF", "IF"], ["IFERROR", "IFERROR"]]), (v) => {
      const s = svNorm(t._svSel);
      const r1 = s.r1 > 1 ? 1 : s.r1;
      svEdit(t, s.r1, s.c1, "=" + v + "(" + (s.r1 > 1 ? `${colName(s.c1)}${r1}:${colName(s.c1)}${s.r1 - 1}` : "") + ")");
    }); return true;
    case "link": {
      const s = svNorm(t._svSel);
      askText("링크 URL", "", "예: https://example.com").then((raw) => {
        if (raw == null) return;
        const url = raw.trim();
        if (!url) { showToast("URL을 입력하세요."); return; }
        const cur = svSrcAt(sh, s.r1, s.c1);
        const label = (cur && cur[0] !== "=" ? cur : url).replace(/"/g, '""');
        svApply(t, [{ r: s.r1, c: s.c1, src: `=HYPERLINK("${url.replace(/"/g, '""')}","${label}")` }]);
        // svApply는 "="로 시작하는 값을 그대로 두고 계산을 svRecalc에 미룬다(수식 칸은
        // svRecalc이 채운다). 여기서 부르지 않으면 링크가 셀 소스에 저장돼도 화면에는 방금 입력한
        // 라벨 텍스트 그대로 남아 값이 바뀌지 않은 것처럼 보인다(확인 결과).
        svRecalc(t);
        renderSheetView(t);
      });
      return true;
    }
    // rtl-sheet(시트 전체)·ltr-cell/rtl-cell(고른 칸)·hide-menu·a11y는 셀 서식이 아니라 탭
    // 단위 또는 st.dir 토글이다. 이미 켜진 상태에서 같은 버튼을 다시 누르면 끈다(구글 시트와
    // 같은 토글 관례, tog() 헬퍼와 동일 패턴).
    case "rtl-sheet": t._svRtl = !t._svRtl; renderSheetView(t); return true;
    case "ltr-cell": svFormat(t, (st) => { if (st.dir === "ltr") delete st.dir; else st.dir = "ltr"; }); return true;
    case "rtl-cell": svFormat(t, (st) => { if (st.dir === "rtl") delete st.dir; else st.dir = "rtl"; }); return true;
    case "hide-menu": t._svHideMenu = !t._svHideMenu; renderSheetView(t); return true;
    case "a11y": t._svA11y = !t._svA11y; renderSheetView(t); showToast(t._svA11y ? "고대비 모드 켜짐" : "고대비 모드 꺼짐"); return true;
    case "chart": showToast("차트는 아직 이 앱에 없습니다. 실제 차트를 저장 파일(xlsx)에 남기려면 별도 작업이 필요합니다."); return true;
    case "filter-clear": svFilterClear(t); return true;
    case "filter-view": svFilterMenu(t, el); return true;
  }
  return false;
}

// 메뉴 항목을 골랐을 때. 도구 모음과 같은 일을 하는 항목은 같은 처리로 보낸다.
export function svMenuAct(t, menu, item) {
  const n = item[0];
  const anchor = document.querySelector(`[data-gm="${menu}"]`);
  const M = {
    "실행취소": "undo", "재실행": "redo", "인쇄": "print", "서식 지우기": "clear",
    "셀 병합": "merge", "찾기 및 바꾸기": "find", "함수": "fn", "링크": "link",
    "숫자": "nf-more", "줄바꿈": "wrap", "회전": "rotate",
  };
  const a = M[n];
  if (a === "find") { svFindBar(t, true); return; }
  if (a === "clear") { svFormat(t, (st) => { for (const k of Object.keys(st)) delete st[k]; }); return; }
  if (a && svToolbar(t, a, anchor)) return;
  if (n === "잘라내기") { svCopySel(t, true); return; }
  if (n === "복사") { svCopySel(t, false); return; }
  if (n === "붙여넣기") { svPasteSel(t); return; }
  if (n === "선택하여 붙여넣기") {
    svMenuAt(anchor, svList([["값만 붙여넣기", "values"], ["서식만 붙여넣기", "format"]]), (v) => {
      if (v === "values") svPasteSel(t);
      else if (!t._svBrush) showToast("먼저 서식 복사(🖌)를 실행하세요.");
      else svFormat(t, (st) => { for (const k of Object.keys(st)) delete st[k]; Object.assign(st, t._svBrush); });
    });
    return;
  }
  // "이동"이 Edit(잘라내기 별칭)·File(폴더 이동) 두 메뉴에 같은 라벨로 있다. menu로 갈라야
  // 먼저 오는 쪽(Edit)이 File 클릭까지 가로채지 않는다(그렇지 않으면 File>이동에서 자르기가
  // 실행된다).
  if (n === "이동" && menu === "edit") { svCopySel(t, true); return; }
  if (n === "삭제") {
    const sel = t._svSel;
    svMenuAt(anchor, svList([["선택한 값 삭제", "clear"], ["행 삭제", "row"], ["열 삭제", "col"]]), (v) => {
      if (v === "clear") svClearValues(t);
      else if (v === "row" && sel) svDelete(t, "row", Math.min(sel.r1, sel.r2), Math.abs(sel.r2 - sel.r1) + 1);
      else if (v === "col" && sel) svDelete(t, "col", Math.min(sel.c1, sel.c2), Math.abs(sel.c2 - sel.c1) + 1);
    });
    return;
  }
  if (n === "확대/축소") { svMenuAt(anchor, svList([["50%", .5], ["75%", .75], ["100%", 1], ["125%", 1.25], ["150%", 1.5], ["200%", 2]]), (v) => { t._svZoom = Number(v); renderSheetView(t); }); return; }
  if (n === "표시") {
    const sh = svSheet(t);
    svMenuAt(anchor, svList([[(sh && sh.grid !== false ? "✓ " : "") + "눈금선", "grid"], [(t._svShowFormulas ? "✓ " : "") + "수식 표시", "formulas"]]), (v) => {
      if (v === "grid") svSheetMeta(t, sh.name, { grid: !(sh.grid !== false) });
      else { t._svShowFormulas = !t._svShowFormulas; renderSheetView(t); }
    });
    return;
  }
  if (n === "고정") {
    const sh = svSheet(t);
    svMenuAt(anchor, svList([["고정 안 함", "0,0"], ["1행 고정", "0,1"], ["2행 고정", "0,2"], ["1열 고정", "1,0"], ["2열 고정", "2,0"]]), (v) => {
      const [x, y] = v.split(",").map(Number);
      svSheetMeta(t, sh.name, { freeze: { x, y } });
    });
    return;
  }
  if (n === "그룹") { showToast("행/열 그룹(개요)은 아직 이 앱에 없습니다. 접기/펼치기 상태까지 저장하는 별도 작업이 필요합니다."); return; }
  if (n === "숨겨진 시트") {
    const hidden = (t.sheet.sheets || []).filter((s) => s.hidden);
    if (!hidden.length) { showToast("숨겨진 시트가 없습니다."); return; }
    svMenuAt(anchor, svList(hidden.map((s) => [s.name, s.name])), (name) => svSheetMeta(t, name, { hidden: false }));
    return;
  }
  if (n === "전체 화면") { svToggleFullscreen(); return; }
  if (n === "셀") {
    const sel = t._svSel; if (!sel) return;
    svMenuAt(anchor, svList([["위에 행 삽입", "row"], ["왼쪽에 열 삽입", "col"]]), (v) => {
      if (v === "row") svInsert(t, "row", Math.min(sel.r1, sel.r2));
      else svInsert(t, "col", Math.min(sel.c1, sel.c2));
    });
    return;
  }
  if (n === "행") {
    const sel = t._svSel; if (!sel) return;
    const r = Math.min(sel.r1, sel.r2);
    svMenuAt(anchor, svList([["위에 행 삽입", r], ["아래에 행 삽입", Math.max(sel.r1, sel.r2) + 1]]), (v) => svInsert(t, "row", Number(v)));
    return;
  }
  if (n === "열") {
    const sel = t._svSel; if (!sel) return;
    const c = Math.min(sel.c1, sel.c2);
    svMenuAt(anchor, svList([["왼쪽에 열 삽입", c], ["오른쪽에 열 삽입", Math.max(sel.c1, sel.c2) + 1]]), (v) => svInsert(t, "col", Number(v)));
    return;
  }
  if (n === "시트") { svSheetMeta(t, svSheet(t).name, { newSheet: "" }); return; }
  if (n === "이미지") { svInsertImage(t); return; }
  if (n === "체크박스") { svInsertDv(t, ["TRUE", "FALSE"], "FALSE"); return; }
  if (n === "드롭다운") {
    askText("드롭다운 목록", "", "쉼표로 구분(예: 진행중,완료,보류)").then((raw) => {
      if (raw == null) return;
      const values = raw.split(",").map((x) => x.trim()).filter(Boolean);
      if (!values.length) { showToast("값을 하나 이상 입력하세요."); return; }
      svInsertDv(t, values);
    });
    return;
  }
  if (n === "메모") { svInsertNote(t); return; }
  if (n === "그림") { showToast("벡터 드로잉 편집기 자체가 필요해 이 앱에는 아직 없습니다."); return; }
  if (n === "표 생성" || n === "표로 변환") { showToast("구조화된 표(필터·줄무늬 서식)는 이 그리드에 별도 렌더링이 필요해 아직 없습니다."); return; }
  if (n === "차트") { showToast("차트는 아직 이 앱에 없습니다. 실제 차트를 저장 파일(xlsx)에 남기려면 별도 작업이 필요합니다."); return; }
  if (n === "피봇 테이블") { showToast("피봇 테이블은 별도의 큰 하위 기능이라 아직 이 앱에 없습니다."); return; }
  if (n === "텍스트") {
    svMenuAt(anchor, svList([["굵게", "fmt-bold"], ["기울임", "fmt-ital"], ["취소선", "fmt-strk"]]), (v) => svToolbar(t, v, anchor));
    return;
  }
  if (n === "정렬") {
    svMenuAt(anchor, svList([["왼쪽 맞춤", "h:left"], ["가로 가운데 맞춤", "h:center"], ["오른쪽 맞춤", "h:right"],
      ["위쪽 맞춤", "v:top"], ["세로 가운데 맞춤", "v:middle"], ["아래쪽 맞춤", "v:bottom"]]), (v) => {
      const i = v.indexOf(":"); const axis = v.slice(0, i), val = v.slice(i + 1);
      svFormat(t, (st) => { if (axis === "h") st.ha = val; else st.va = val; });
    });
    return;
  }
  if (n === "글꼴 크기") { svMenuAt(anchor, svList(GS_SIZES.map((s) => [String(s), s])), (v) => svFormat(t, (st) => { st.fs = Number(v); })); return; }
  if (n === "교차 색상") {
    const sel = t._svSel; if (!sel) return;
    const base = Math.min(sel.r1, sel.r2);
    svFormat(t, (st, sh, r) => { if ((r - base) % 2 === 1) st.bg = "#f3f3f3"; else delete st.bg; });
    return;
  }
  if (n === "조건부 서식") { showToast("조건부 서식 규칙은 이 파일에 있으면 그대로 읽고 적용합니다. 새 규칙을 만드는 도구는 별도 작업이 필요합니다."); return; }
  if (n === "테마") { showToast("스프레드시트 테마 전환은 이 앱의 고정 팔레트 구조상 별도 작업이 필요합니다."); return; }
  if (n === "시트 정렬") {
    const sh = svSheet(t);
    const items = [];
    for (let c = 1; c <= sh.colsCount; c++) { items.push([`${colName(c)}열 기준 오름차순`, c + ",1"]); items.push([`${colName(c)}열 기준 내림차순`, c + ",0"]); }
    svMenuAt(anchor, svList(items), (v) => { const [c, asc] = v.split(",").map(Number); svSortRange(t, 2, sh.rows, 1, sh.colsCount, c, !!asc); });
    return;
  }
  if (n === "범위 정렬") {
    const sel = t._svSel; if (!sel) return;
    const s = svNorm(sel);
    const items = [];
    for (let c = s.c1; c <= s.c2; c++) { items.push([`${colName(c)}열 기준 오름차순`, c + ",1"]); items.push([`${colName(c)}열 기준 내림차순`, c + ",0"]); }
    svMenuAt(anchor, svList(items), (v) => { const [c, asc] = v.split(",").map(Number); svSortRange(t, s.r1, s.r2, s.c1, s.c2, c, !!asc); });
    return;
  }
  if (n === "필터 삭제") { svFilterClear(t); return; }
  if (n === "범위 임의로 섞기") { const s = svNorm(t._svSel); svShuffleRange(t, s.r1, s.r2, s.c1, s.c2); return; }
  if (n === "열 통계") { svColumnStats(t); return; }
  if (n === "데이터 확인") {
    askText("데이터 확인 — 허용 값 목록", "", "쉼표로 구분(예: 진행중,완료,보류)").then((raw) => {
      if (raw == null) return;
      const values = raw.split(",").map((x) => x.trim()).filter(Boolean);
      if (!values.length) { showToast("값을 하나 이상 입력하세요."); return; }
      svInsertDv(t, values);
    });
    return;
  }
  if (n === "데이터 정리") { svDedupeRows(t); return; }
  if (n === "텍스트를 열로 분할") {
    askText("텍스트를 열로 분할", ",", "구분자(쉼표·탭 등)").then((sep) => { if (sep) svSplitColumns(t, sep); });
    return;
  }
  if (n === "이름이 지정된 범위") {
    const names = (t.sheet && t.sheet.definedNames) || [];
    svMenuAt(anchor, svList([["새로 만들기", "new"], [`관리(${names.length}개)`, "list"]]), (v) => {
      if (v === "new") svAddNamedRange(t); else svListNamedRanges(t, anchor);
    });
    return;
  }
  if (n === "슬라이서 추가") { showToast("슬라이서는 차트·피봇 테이블이 있어야 의미가 있는데 이 앱엔 아직 없습니다."); return; }
  if (n === "최적화 문제 풀이") { showToast("선형계획법 solver는 별도의 큰 하위 기능이라 아직 이 앱에 없습니다."); return; }
  if (n === "이름이 지정된 함수") { showToast("사용자 정의 함수는 이 앱의 수식 엔진 확장이 필요해 아직 없습니다."); return; }
  if (n === "데이터 추출") { showToast("데이터 추출은 정렬·필터·중복 삭제로 이미 다루는 것과 겹쳐 이 스코프에서는 보류합니다."); return; }
  if (n === "열기") { openFilePalette(); return; }
  if (n === "새 문서") {
    const dir = t.path.slice(0, t.path.lastIndexOf("/"));
    askText("새 스프레드시트", "제목 없는 스프레드시트", "파일 이름").then((name) => {
      if (!name || !name.trim()) return;
      wsSend({ type: "fs.op", op: "create-sheet", destDir: dir, name: name.trim().replace(/\.xlsx$/i, "") + ".xlsx" });
    });
    return;
  }
  if (n === "사본 만들기") {
    const base = t.path.slice(t.path.lastIndexOf("/") + 1).replace(/\.xlsx$/i, "");
    const dir = t.path.slice(0, t.path.lastIndexOf("/"));
    askText("사본 만들기", `${base} 사본`, "파일 이름").then((name) => {
      if (!name || !name.trim()) return;
      wsSend({ type: "fs.op", op: "copy", src: t.path, destDir: dir, name: name.trim().replace(/\.xlsx$/i, "") + ".xlsx", open: true });
    });
    return;
  }
  if (n === "이름 바꾸기") {
    const base = t.path.slice(t.path.lastIndexOf("/") + 1);
    askText("이름 바꾸기", base, "파일 이름").then((name) => {
      if (!name || !name.trim() || name.trim() === base) return;
      wsSend({ type: "fs.op", op: "rename", path: t.path, name: name.trim() });
    });
    return;
  }
  if (n === "이동" && menu === "file") {
    const dir = t.path.slice(0, t.path.lastIndexOf("/"));
    askText("이동", dir, "대상 폴더 경로").then((destDir) => {
      if (!destDir || !destDir.trim() || destDir.trim() === dir) return;
      wsSend({ type: "fs.op", op: "move", src: t.path, destDir: destDir.trim() });
    });
    return;
  }
  if (n === "휴지통으로 이동") {
    if (!window.acHost || !acHost.trashItem) { showToast("이 실행 환경에서는 휴지통 이동을 지원하지 않습니다."); return; }
    if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장하거나 되돌린 뒤 다시 시도하세요"); return; }
    const base = t.path.slice(t.path.lastIndexOf("/") + 1);
    askText("휴지통으로 이동", "", `"${base}"을(를) 휴지통으로 이동하려면 그대로 다시 입력: ${base}`).then(async (v) => {
      if (v !== base) { showToast("취소했습니다."); return; }
      const res = await acHost.trashItem(t.path);
      if (!res || !res.ok) { showToast("삭제 실패: " + (res && res.error || "알 수 없음")); return; }
      removeTabsNow([{ tabRef: t, space: getCenterSpace() }]);
      showToast("휴지통으로 이동했습니다.");
    });
    return;
  }
  if (n === "세부정보") {
    const sh = svSheet(t);
    showToast(`${t.path} — 시트 ${t.sheet.sheets.length}개, 현재 시트 ${sh.rows}행×${sh.colsCount}열`);
    return;
  }
  if (n === "설정") { showToast("지역화·반복 계산 등 설정 항목이 이 계산 엔진에 아직 반영되지 않습니다."); return; }
  if (n === "가져오기") { showToast("다른 형식을 시트로 병합하는 규칙까지 다루려면 별도 설계가 필요해 아직 없습니다."); return; }
  showToast("아직 안 옮긴 기능입니다: " + n);
}

// 필터: 고른 칸의 열에서 값을 하나 골라 그 값과 일치하는 행만 강조한다. 진짜 구글 시트처럼
// 맞지 않는 행을 화면에서 지우는(행 숨김) 방식은 쓰지 않는다. 이 그리드는 스크롤 구간([from,to])을
// 행 높이 누적으로 계산하는 가상 스크롤이라(svFitTop 등), 행을 숨기면 그 합산이 어긋나
// 스크롤·고정창이 깨질 위험이 크다. 강조만으로도 "필터"의 핵심
// 목적(찾아서 눈에 띄게)은 충족한다.
function svFilterClear(t) {
  if (!t._svFilter) { showToast("적용된 필터가 없습니다."); return; }
  t._svFilter = null;
  renderSheetView(t);
  showToast("필터를 지웠습니다.");
}
function svFilterMenu(t, el) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const c = t._svSel.c1;
  const seen = new Set();
  for (const key of Object.keys(sh.cells)) {
    const parts = key.split(",");
    if (Number(parts[1]) !== c) continue;
    const v = String(sh.cells[key][0] || "");
    if (v !== "") seen.add(v);
  }
  const values = Array.from(seen).sort();
  if (!values.length) { showToast("이 열에 값이 없습니다."); return; }
  const items = [["(모두 보기)", ""]].concat(values.map((v) => [v, v]));
  svMenuAt(el, svList(items), (v) => {
    t._svFilter = v ? { c, val: v } : null;
    renderSheetView(t);
    showToast(v ? `"${v}"과 일치하는 행을 강조했습니다` : "필터를 지웠습니다.");
  });
}

// 복사·잘라내기·붙여넣기: OS 클립보드를 통해 TSV(탭 구분 값)로 오간다. document.execCommand는
// contenteditable이 아닌 이 커스텀 그리드에서 동작하지 않으므로
// 실제 클립보드 API를 쓴다. 수식은 계산된 값으로 고정해 내보낸다. 상대 참조를 옮긴 위치에
// 맞춰 다시 쓰는 것까지는 이 엔진이 지원하지 않으므로, 값만 오가는 편이 수식이 엉뚱한 값을
// 가리키는 것보다 안전하다.
async function svCopySel(t, cut) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const ctx = { book: t.sheet, cache: new Map(), busy: new Set() };
  const lines = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const row = [];
    for (let c = s.c1; c <= s.c2; c++) {
      const src = svSrcAt(sh, r, c);
      const v = src && src[0] === "=" ? svCellVal(ctx, t.sheetIdx || 0, r, c) : src;
      row.push(v == null ? "" : String(v));
    }
    lines.push(row.join("\t"));
  }
  try { await navigator.clipboard.writeText(lines.join("\n")); }
  catch (e) { showToast("클립보드 접근 실패: " + e.message); return; }
  if (cut) {
    const changes = [];
    for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) changes.push({ r, c, src: "" });
    svApply(t, changes);
    renderSheetView(t);
    svSaveBtn(t);
  }
  showToast(cut ? "잘라냈습니다" : "복사했습니다");
}
async function svPasteSel(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { showToast("클립보드 읽기 실패: " + e.message); return; }
  if (!text) return;
  const rows = text.replace(/\r/g, "").split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();
  const s = svNorm(t._svSel);
  const changes = [];
  rows.forEach((line, ri) => { line.split("\t").forEach((cell, ci) => changes.push({ r: s.r1 + ri, c: s.c1 + ci, src: cell })); });
  svApply(t, changes);
  svRecalc(t);
  renderSheetView(t);
  svSaveBtn(t);
  showToast("붙여넣었습니다");
}
function svClearValues(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const changes = [];
  for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) changes.push({ r, c, src: "" });
  svApply(t, changes);
  renderSheetView(t);
  svSaveBtn(t);
}

// 셀 병합: 화면과 파일 양쪽에 적용한다.
function svMerge(t, kind) {
  if (SHEET_TEXT_RE.test(t.path)) return;
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const keep = (a) => `${colName(a.c1)}${a.r1}:${colName(a.c2)}${a.r2}`;
  sh.merges = (sh.merges || []).filter((m) => {
    const p = String(m).split(":").map(svA1);
    if (!p[0] || !p[1]) return true;
    const r1 = Math.min(p[0][0], p[1][0]), r2 = Math.max(p[0][0], p[1][0]);
    const c1 = Math.min(p[0][1], p[1][1]), c2 = Math.max(p[0][1], p[1][1]);
    return r2 < s.r1 || r1 > s.r2 || c2 < s.c1 || c1 > s.c2;      // 겹치는 병합은 먼저 푼다
  });
  const add = [];
  if (kind === "all" && (s.r1 !== s.r2 || s.c1 !== s.c2)) add.push(keep(s));
  else if (kind === "h") for (let r = s.r1; r <= s.r2; r++) { if (s.c1 !== s.c2) add.push(keep({ r1: r, r2: r, c1: s.c1, c2: s.c2 })); }
  else if (kind === "v") for (let c = s.c1; c <= s.c2; c++) { if (s.r1 !== s.r2) add.push(keep({ r1: s.r1, r2: s.r2, c1: c, c2: c })); }
  sh.merges = sh.merges.concat(add);
  t._svMergeEdit = t._svMergeEdit || new Map();
  t._svMergeEdit.set(sh.name, { ranges: sh.merges.slice(), generation: svNextGeneration(t) });
  t._svShown = 0;
  renderSheetView(t);
  svSaveBtn(t);
}

export function svZoom(t, d) {
  t._svZoom = Math.max(0.5, Math.min(2, d === 0 ? 1 : (t._svZoom || 1) + d));
  renderSheetView(t);
}

// 고정(freeze)·눈금선·시트 숨김은 파일의 뷰 상태라 즉시 서버로 보내 저장한다(다른 편집처럼
// 저장 버튼을 기다리지 않으며 svInsert/svDelete와 같은 방식이다). CSV·TSV는 이런 뷰 개념이 없다.
export async function svSheetMeta(t, sheetName, patch) {
  if (SHEET_TEXT_RE.test(t.path)) { showToast("이 표 형식은 지원하지 않습니다."); return; }
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [Object.assign({ sheet: sheetName }, patch)], space: getCenterSpace(), tabId: t.id, reason: "meta" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "meta", getCenterSpace(), t.id);
    const sh = svSheet(t);
    if (sh && sh.hidden && t.sheet) {
      const vi = t.sheet.sheets.findIndex((s) => !s.hidden);
      if (vi >= 0) { t.sheetIdx = vi; renderSheetView(t); }
    }
  } catch (e) { showToast("적용 실패: " + e.message); }
}

// 체크박스·드롭다운: 데이터 검증(목록) 규칙을 넣는다. 기존 svPick(칸 클릭 시 목록에서 고르기)이
// 이미 이 검증을 읽어 인터랙티브 피커를 띄우므로, 여기서는 규칙을 쓰는 것만 새로 만들면 된다.
async function svInsertDv(t, values, cellValue) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  if (SHEET_TEXT_RE.test(t.path)) { showToast("이 표 형식은 지원하지 않습니다."); return; }
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const s = svNorm(t._svSel);
  const range = `${colName(s.c1)}${s.r1}:${colName(s.c2)}${s.r2}`;
  const edits = [{ sheet: sh.name, dv: { range, values } }];
  if (cellValue != null) for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) edits.push({ sheet: sh.name, r, c, v: cellValue });
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits, space: getCenterSpace(), tabId: t.id, reason: "dv" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "dv", getCenterSpace(), t.id);
  } catch (e) { showToast("적용 실패: " + e.message); }
}

// 정렬·임의 섞기: 값(src)만 행째로 옮긴다. 서식은 원래 위치에 남고 수식은 참조를 다시 쓰지 않는다
// (복사/붙여넣기와 같은 이유로 같은 제약). 정렬 결과는 svApply로 즉시 dirty 처리되고, 저장
// 버튼을 눌러야 파일에 반영된다. 행 삽입/삭제처럼 즉시 서버 왕복하지 않는다.
function svReorderRows(t, r1, r2, c1, c2, order) {
  const sh = svSheet(t); if (!sh) return;
  const rows = [];
  for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(svSrcAt(sh, r, c)); rows.push(row); }
  const changes = [];
  order.forEach((srcIdx, i) => { const r = r1 + i; rows[srcIdx].forEach((src, j) => changes.push({ r, c: c1 + j, src })); });
  svApply(t, changes);
  svRecalc(t);
  renderSheetView(t);
  svSaveBtn(t);
}
function svSortRange(t, r1, r2, c1, c2, byCol, asc) {
  if (r2 <= r1) { showToast("정렬할 행이 2개 이상이어야 합니다."); return; }
  const sh = svSheet(t);
  const byIdx = byCol - c1;
  const idx = [];
  for (let i = 0; i < r2 - r1 + 1; i++) idx.push(i);
  idx.sort((ia, ib) => {
    const av = svSrcAt(sh, r1 + ia, byCol), bv = svSrcAt(sh, r1 + ib, byCol);
    const an = Number(av), bn = Number(bv);
    const bothNum = av !== "" && bv !== "" && Number.isFinite(an) && Number.isFinite(bn);
    const c = bothNum ? an - bn : String(av).localeCompare(String(bv), "ko");
    return asc ? c : -c;
  });
  svReorderRows(t, r1, r2, c1, c2, idx);
  showToast("정렬했습니다. 값만 옮기며, 서식은 자리에 남고 수식 참조는 다시 쓰지 않습니다.");
}
function svShuffleRange(t, r1, r2, c1, c2) {
  if (r2 <= r1) { showToast("섞을 행이 2개 이상이어야 합니다."); return; }
  const idx = []; for (let i = 0; i < r2 - r1 + 1; i++) idx.push(i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  svReorderRows(t, r1, r2, c1, c2, idx);
  showToast("무작위로 섞었습니다.");
}

// 열 통계: 구글 시트가 열 머리를 누르면 보여주는 요약을 골라 놓은 범위에 대해 보여준다.
function svColumnStats(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const nums = [];
  let countA = 0, blanks = 0;
  for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) {
    const v = svSrcAt(sh, r, c);
    if (v === "") { blanks++; continue; }
    countA++;
    const n = Number(v);
    if (Number.isFinite(n)) nums.push(n);
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = nums.length ? sum / nums.length : 0;
  const items = [
    ["개수(값 있음)", countA], ["숫자 개수", nums.length], ["빈 칸", blanks],
    ["합계", nums.length ? sum : "—"], ["평균", nums.length ? Math.round(avg * 10000) / 10000 : "—"],
    ["최소", nums.length ? Math.min.apply(null, nums) : "—"], ["최대", nums.length ? Math.max.apply(null, nums) : "—"],
  ];
  svMenuAt(document.querySelector(`[data-gm="data"]`), items.map(([k, v]) => `<button data-pick=""><span>${esc(k)}</span><span class="gs-sc">${esc(String(v))}</span></button>`).join(""), () => {});
}

// 데이터 정리: 선택 범위 안에서 모든 열의 값이 완전히 같은 행(첫 등장 이후)을 지운다.
async function svDedupeRows(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const s = svNorm(t._svSel);
  const seen = new Set();
  const dupRows = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const key = []; for (let c = s.c1; c <= s.c2; c++) key.push(svSrcAt(sh, r, c));
    const sig = key.join("");
    if (seen.has(sig)) dupRows.push(r); else seen.add(sig);
  }
  if (!dupRows.length) { showToast("중복된 행이 없습니다."); return; }
  for (let i = dupRows.length - 1; i >= 0; i--) { await svDelete(t, "row", dupRows[i], 1); }
  showToast(`중복된 행 ${dupRows.length}개를 지웠습니다.`);
}

// 텍스트를 열로 분할: 각 칸을 구분자로 나눠 오른쪽 열들에 채운다.
function svSplitColumns(t, sep) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  const s = svNorm(t._svSel);
  const changes = [];
  for (let r = s.r1; r <= s.r2; r++) {
    const parts = svSrcAt(sh, r, s.c1).split(sep);
    parts.forEach((p, i) => changes.push({ r, c: s.c1 + i, src: p.trim() }));
  }
  svApply(t, changes);
  svRecalc(t);
  renderSheetView(t);
  svSaveBtn(t);
}

async function svAddNamedRange(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  if (SHEET_TEXT_RE.test(t.path)) { showToast("이 표 형식은 지원하지 않습니다."); return; }
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const name = await askText("이름이 지정된 범위", "", "예: 매출범위(공백·특수문자 없이)");
  if (!name || !name.trim()) return;
  const s = svNorm(t._svSel);
  const range = `$${colName(s.c1)}$${s.r1}:$${colName(s.c2)}$${s.r2}`;
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, definedName: { name: name.trim(), range } }], space: getCenterSpace(), tabId: t.id, reason: "name" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "name", getCenterSpace(), t.id);
    showToast(`"${name.trim()}" 범위를 등록했습니다.`);
  } catch (e) { showToast("등록 실패: " + e.message); }
}
export function svListNamedRanges(t, anchor) {
  const names = (t.sheet && t.sheet.definedNames) || [];
  if (!names.length) { showToast("등록된 이름 범위가 없습니다."); return; }
  const items = [];
  names.forEach((nm) => (nm.ranges || []).forEach((range) => items.push([`${nm.name} — ${range} (삭제)`, JSON.stringify({ name: nm.name, range: range.split("!").pop() })])));
  svMenuAt(anchor, svList(items), async (v) => {
    const { name, range } = JSON.parse(v);
    const sh = svSheet(t);
    try {
      const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, removeDefinedName: { name, range } }], space: getCenterSpace(), tabId: t.id, reason: "name" });
      if (saved.error) throw new Error(saved.error);
      await requestFileContent(t.path, "name", getCenterSpace(), t.id);
      showToast(`"${name}"을 지웠습니다.`);
    } catch (e) { showToast("삭제 실패: " + e.message); }
  });
}

async function svInsertNote(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  if (SHEET_TEXT_RE.test(t.path)) { showToast("이 표 형식은 지원하지 않습니다."); return; }
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const r = t._svSel.r1, c = t._svSel.c1;
  const cur = (sh.note && sh.note[r + "," + c]) || "";
  const text = await askText("메모", cur, "이 칸에 대한 메모");
  if (text == null) return;
  try {
    const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, note: { r, c, text: text.trim() } }], space: getCenterSpace(), tabId: t.id, reason: "note" });
    if (saved.error) throw new Error(saved.error);
    await requestFileContent(t.path, "note", getCenterSpace(), t.id);
  } catch (e) { showToast("적용 실패: " + e.message); }
}

function svToggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch((e) => showToast("전체 화면 실패: " + e.message));
}

// 이미지: 파일을 base64로 읽어 서버로 보내 xlsx에 넣는다. 저장이 끝나면 받은
// 위치를 이 탭의 sh.images에도 반영해 svRenderImages로 곧바로 그린다(다시 열 필요 없음).
function svInsertImage(t) {
  const sh = svSheet(t); if (!sh || !t._svSel) return;
  if (SHEET_TEXT_RE.test(t.path)) { showToast("이 표 형식은 지원하지 않습니다."); return; }
  if (isSheetTabDirty(t)) { showToast("저장하지 않은 편집이 있습니다. 먼저 저장한 뒤 다시 시도하세요"); return; }
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/png,image/jpeg,image/gif";
  input.onchange = () => {
    const file = input.files && input.files[0]; if (!file) return;
    const ext = file.type.split("/")[1] || "png";
    const reader = new FileReader();
    reader.onload = async () => {
      const r = t._svSel.r1, c = t._svSel.c1;
      const image = { r, c, dataUrl: reader.result, extension: ext, width: 120, height: 90 };
      try {
        const saved = await sendTabIo({ type: "sheet.write", path: t.path, edits: [{ sheet: sh.name, image }], space: getCenterSpace(), tabId: t.id, reason: "image" });
        if (saved.error) throw new Error(saved.error);
        (sh.images || (sh.images = [])).push({ r, c, w: image.width, h: image.height, dataUrl: image.dataUrl });
        svRenderImages(t);
        showToast("이미지를 삽입했습니다.");
      } catch (e) { showToast("삽입 실패: " + e.message); }
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// 찾기: 값이 든 칸만 검사해 위치를 모으고 하나씩 옮겨 간다.
export function svFind(t, q, back) {
  const sh = svSheet(t); if (!sh || !q) return;
  const needle = q.toLowerCase();
  const hits = [];
  for (const key of Object.keys(sh.cells)) {
    const v = sh.cells[key][0];
    if (v !== "" && String(v).toLowerCase().includes(needle)) { const rc = key.split(","); hits.push([+rc[0], +rc[1]]); }
  }
  if (!hits.length) { const st = $("#sv-fstat"); if (st) st.textContent = "없음"; return; }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cur = t._svSel ? [t._svSel.r1, t._svSel.c1] : [0, 0];
  let i;
  if (back) { i = hits.length - 1; for (let k = hits.length - 1; k >= 0; k--) { if (hits[k][0] < cur[0] || (hits[k][0] === cur[0] && hits[k][1] < cur[1])) { i = k; break; } } }
  else { i = 0; for (let k = 0; k < hits.length; k++) { if (hits[k][0] > cur[0] || (hits[k][0] === cur[0] && hits[k][1] > cur[1])) { i = k; break; } } }
  const st = $("#sv-fstat"); if (st) st.textContent = `${i + 1} / ${hits.length}`;
  svSet(t, hits[i][0], hits[i][1], false);
}
export function svFindBar(t, show) {
  const bar = $("#sv-find"); if (!bar) return;
  bar.hidden = !show;
  if (show) { const inp = $("#sv-fq"); if (inp) { inp.focus(); inp.select(); } }
  else { const w = svPane("sv-pb"); if (w) w.focus(); }
}

