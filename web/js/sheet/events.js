// 시트 이벤트: sheet/docx host의 클릭·키보드·drag listener를 등록한다.
//
// 소유 범위
//   sheet click·dblclick·selection drag·row/column resize와 document copy/cut/paste·keydown listener closure.
//
// 제공 API
//   initSheetEvents(deps): 모든 listener와 event-local 상태를 기존 최상위 등록 순서로 한 번 만든다.
//
// 의존 대상
//   sheet/model.js·formula.js·render.js·edit.js·actions.js를 한 방향으로 import한다.
//   main의 file/docx host, docx 명령, notice·mode 전환 함수를 init에서 받고 tab-store를 import한다.
//
// 유지 조건
//   fill listener(edit) 뒤, 다른 전역 keydown listener 앞이라는 등록 우선순위.
//   sheet/docx 분기 조건, preventDefault·stopPropagation 위치와 click→menu→command 순서.
//
// 영향 범위
//   center 소유 fileview·docxview와 tab-store query,
//   main의 docx 명령·switchSheetMode·isFileLikeKind, 전역 copy/cut/paste·keydown 우선순위.
//
// model/formula/conditional ← render ← edit ← actions ← events 방향만 유지한다.
import { GS_MENUS, SV_MENU_SUBLIST, svSheet, svSrcAt } from "./model.js";
import { svA1 } from "./formula.js";
import { getActiveTabId, getCenterSpace, getCurrentTabs } from "../center/tab-store.js";
import { renderSheetView, svColW, svPane, svTab } from "./render.js";
import {
  svApply, svCloseEdit, svCloseFormulaEdit, svDelete, svDvAt, svEachCell, svEdit,
  svFillFrom, svFormat, svGrowTo, svHas, svInsert, svNextGeneration, svNorm,
  svPaint, svPick, svRangeText, svSave, svSet, svSetKeepRanges, svUndo,
} from "./edit.js";
import {
  gdFocusPopupItem, svCaptureSub, svFind, svFindBar, svList, svMenuAct, svMenuAt,
  svSheetMeta, svToolbar, svZoom,
} from "./actions.js";

export function initSheetEvents(deps) {
  const {
    $, acHost, askText, docxApplyHyperlink, docxMoveMatch, docxOpenMenu,
    docxRefreshChrome, docxReplaceAllMatches, docxReplaceMatch, docxShowFind,
    docxShowLinkEditor, docxview, esc, fileview, isFileLikeKind, showToast,
    switchSheetMode,
  } = deps;
  const currentTab = () => {
    const centerSpace = getCenterSpace();
    return getCurrentTabs().find((x) => x.id === getActiveTabId(centerSpace));
  };

  // ── 눌렀을 때 ───────────────────────────────────────────────────────────────
  // docx 클릭(찾기/바꾸기·링크·모드전환·메뉴)과 sheet 클릭(셀·툴바)이 원래 fileview 하나에 델리게이트
  // 돼 있었는데, docx가 docxview 패널로 옮겨가며 그 서브트리 이벤트가
  // fileview까지 올라오지 않는다. 그래서 이 핸들러를 두 패널 모두에 붙인다. 함수 안에서
  // t.docxMode/t.sheetMode로 이미 갈라 처리하므로 로직 자체는 그대로 재사용된다.
  function fileviewClickHandler(e) {
    const t = currentTab();
    if (!t || !isFileLikeKind(t.kind)) return;
    const docxAct = e.target.closest("[data-docx-act]");
    if (docxAct && t.docxMode) {
      const act = docxAct.dataset.docxAct;
      if (act === "find-open") docxShowFind(t, true);
      else if (act === "find-close") docxShowFind(t, false);
      else if (act === "find-next") docxMoveMatch(t, 1);
      else if (act === "find-prev") docxMoveMatch(t, -1);
      else if (act === "replace-one") docxReplaceMatch(t);
      else if (act === "replace-all") docxReplaceAllMatches(t);
      else if (act === "link-apply") docxApplyHyperlink(t);
      else if (act === "link-close") docxShowLinkEditor(t, false);
      else if (act === "mode-edit") {
        const editor = t.docxEditor;
        if (editor && editor.getEditingMode() !== "editing") editor.setEditingMode("editing");
        docxRefreshChrome(t);
      } else if (act === "mode-view") {
        const editor = t.docxEditor;
        if (editor && editor.getEditingMode() !== "viewing") editor.setEditingMode("viewing");
        docxRefreshChrome(t);
      }
      return;
    }
    const sv = e.target.closest("[data-sv]");
    if (sv) {
      const act = sv.dataset.sv;
      if (act === "finder") { try { window.acHost && acHost.revealInFinder && acHost.revealInFinder(t.path); } catch (err) {} return; }
      if (act === "text") { switchSheetMode(t, false); return; }
      if (act === "table") { switchSheetMode(t, true); return; }
      if (act === "zoom-in") { svZoom(t, 0.1); return; }
      if (act === "zoom-out") { svZoom(t, -0.1); return; }
      if (act === "zoom-reset") { svZoom(t, 0); return; }
      if (act === "find") { svFindBar(t, true); return; }
      if (act === "find-next") { svFind(t, ($("#sv-fq") || {}).value, false); return; }
      if (act === "find-prev") { svFind(t, ($("#sv-fq") || {}).value, true); return; }
      if (act === "find-close") { svFindBar(t, false); return; }
      if (act === "save") { svSave(t); return; }
      if (act === "sheet-add") { svSheetMeta(t, svSheet(t).name, { newSheet: "" }); return; }
      if (t.sheetMode && svToolbar(t, act, sv)) return;
    }
    // 메뉴 바. GS_MENUS 를 그대로 펼친다.
    const gm = e.target.closest("[data-gm]");
    if (gm && t.docxMode) {
      docxOpenMenu(t, gm);
      return;
    }
    if (gm && t.sheetMode) {
      const m = GS_MENUS.find((x) => x.k === gm.dataset.gm);
      if (m) {
        const subRuns = {};
        const html = m.items.map((it, i) => SV_MENU_SUBLIST.has(it[0])
          ? `<details class="gs-submenu" data-sub="${i}"><summary>${esc(it[0])}<span>›</span></summary><div class="gs-submenu-items"></div></details>`
          : `<button data-pick="${i}"><span>${esc(it[0])}${it[2] ? " ▸" : ""}</span><span class="gs-sc">${esc(it[1] || "")}</span></button>`
        ).join("");
        const box = svMenuAt(gm, html, (v, b) => {
          const body = b && b.closest(".gs-submenu-items");
          if (body) { const run = subRuns[body.closest("[data-sub]").dataset.sub]; if (run) run(v); return; }
          svMenuAct(t, m.k, m.items[Number(v)]);
        });
        box.querySelectorAll("details.gs-submenu").forEach((det) => {
          det.addEventListener("toggle", () => {
            if (!det.open || det.dataset.loaded) return;
            det.dataset.loaded = "1";
            const idx = det.dataset.sub;
            const cap = svCaptureSub(t, m.k, m.items[Number(idx)]);
            const body = det.querySelector(".gs-submenu-items");
            if (!cap) { body.innerHTML = `<div class="gs-note">없음</div>`; return; }
            body.innerHTML = cap.html;
            subRuns[idx] = cap.onPick;
          });
        });
        return;
      }
    }
    if (!t.sheetMode) return;
    const si = e.target.closest("[data-si]");
    if (si) {
      const idx = +si.dataset.si;
      // 이 탭 클릭은 매번 renderSheetView로 .sv-tabs를 통째로 다시 그려 버튼 DOM 자체가 클릭마다
      // 새로 생긴다. 그래서 브라우저 네이티브 dblclick(같은 대상에 두 번 클릭 필요)이 안정적으로
      // 잡히지 않는다. 시트 이름 바꾸기도 같은 이유로 더블클릭이 동작하지 않는다.
      // DOM 노드가 아니라 si 값과 시간으로 직접 두 번 클릭을 판정한다.
      const now = Date.now();
      const isDbl = t._svTabClickIdx === idx && now - (t._svTabClickAt || 0) < 500;
      t._svTabClickAt = now; t._svTabClickIdx = idx;
      if (isDbl) {
        t._svTabClickAt = 0;
        const sh = t.sheet.sheets[idx]; if (!sh) return;
        askText("시트 이름", sh.name).then((name) => { if (name && name.trim()) svSheetMeta(t, sh.name, { rename: name.trim() }); });
        return;
      }
      t._svScroll = null; t._svSel = null; t._svShown = 0; renderSheetView(t, { nextSheetIdx: idx }); return;
    }
    const sh = svSheet(t); if (!sh) return;
    const add = (e.metaKey || e.ctrlKey) && t._svSel;
    const grow = (rect) => {
      if (add) t._svRanges = (t._svRanges || []).concat([svNorm(t._svSel)]);
      else if (e.shiftKey && t._svSel) { t._svSel.r2 = rect.r2; t._svSel.c2 = rect.c2; svPaint(t); return; }
      else t._svRanges = [];
      t._svSel = rect; svPaint(t);
    };
    if (e.target.closest(".sv-corner")) { grow({ r1: 1, c1: 1, r2: sh.rows, c2: sh.colsCount }); return; }
    const ch = e.target.closest("th.sv-ch");
    if (ch) { const c = +ch.dataset.c; grow({ r1: 1, c1: c, r2: sh.rows, c2: c }); return; }
    const rh = e.target.closest("th.sv-rh");
    if (rh) { const r = +rh.dataset.r; grow({ r1: r, c1: 1, r2: r, c2: sh.colsCount }); return; }
  }
  fileview.addEventListener("click", fileviewClickHandler);
  docxview.addEventListener("click", fileviewClickHandler);
  
  function fileviewKeydownHandler(e) {
    const gm = e.target.closest(".gd-menu [data-gm]");
    if (!gm || (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown")) return;
    const t = currentTab();
    if (!t || !t.docxMode) return;
    e.preventDefault();
    gm.click();
    gdFocusPopupItem(document.querySelector(".gs-pop"));
  }
  fileview.addEventListener("keydown", fileviewKeydownHandler);
  docxview.addEventListener("keydown", fileviewKeydownHandler);
  
  // 행·열 머리를 오른쪽 클릭하면 그 위치의 위/왼쪽·아래/오른쪽에 행·열을 삽입하는 메뉴가 뜬다
  // (구글 시트와 같은 위치). 삽입 자체는 svInsert가 처리한다.
  fileview.addEventListener("contextmenu", (e) => {
    const t = svTab(); if (!t) return;
    const tab = e.target.closest(".sv-tab");
    if (tab) {
      e.preventDefault();
      const si = +tab.dataset.si;
      const sh = t.sheet.sheets[si]; if (!sh) return;
      const visCount = t.sheet.sheets.filter((s) => !s.hidden).length;
      svMenuAt(tab, svList([["이름 바꾸기", "rename"], ["복제", "dup"], ["숨기기", "hide"], ["삭제", "del"]]), (v) => {
        if (v === "rename") { askText("시트 이름", sh.name).then((name) => { if (name && name.trim()) svSheetMeta(t, sh.name, { rename: name.trim() }); }); return; }
        if (v === "dup") { svSheetMeta(t, sh.name, { duplicate: true }); return; }
        if (v === "hide") { if (visCount <= 1) { showToast("마지막 남은 시트는 숨길 수 없습니다."); return; } svSheetMeta(t, sh.name, { hidden: true }); return; }
        if (v === "del") { if (t.sheet.sheets.length <= 1) { showToast("마지막 남은 시트는 삭제할 수 없습니다."); return; } svSheetMeta(t, sh.name, { removeSheet: true }); return; }
      });
      return;
    }
    const rh = e.target.closest("th.sv-rh");
    const ch = !rh && e.target.closest("th.sv-ch");
    if (!rh && !ch) return;
    e.preventDefault();
    if (rh) {
      const r = +rh.dataset.r;
      const sel = t._svSel;
      const inSel = sel && sel.r1 <= r && r <= sel.r2 && sel.c1 === 1;
      const at = inSel ? Math.min(sel.r1, sel.r2) : r, count = inSel ? Math.abs(sel.r2 - sel.r1) + 1 : 1;
      svMenuAt(rh, svList([["위에 행 삽입", "ins:" + r], ["아래에 행 삽입", "ins:" + (r + 1)],
        [count > 1 ? `선택한 행 ${count}개 삭제` : "이 행 삭제", "del"]]), (v) => {
        if (v === "del") svDelete(t, "row", at, count);
        else { const i = v.indexOf(":"); svInsert(t, "row", +v.slice(i + 1)); }
      });
    } else {
      const c = +ch.dataset.c;
      const sel = t._svSel;
      const inSel = sel && sel.c1 <= c && c <= sel.c2 && sel.r1 === 1;
      const at = inSel ? Math.min(sel.c1, sel.c2) : c, count = inSel ? Math.abs(sel.c2 - sel.c1) + 1 : 1;
      svMenuAt(ch, svList([["왼쪽에 열 삽입", "ins:" + c], ["오른쪽에 열 삽입", "ins:" + (c + 1)],
        [count > 1 ? `선택한 열 ${count}개 삭제` : "이 열 삭제", "del"]]), (v) => {
        if (v === "del") svDelete(t, "col", at, count);
        else { const i = v.indexOf(":"); svInsert(t, "col", +v.slice(i + 1)); }
      });
    }
  });
  
  // 두 번 누르면 그 칸에서 바로 고친다.
  fileview.addEventListener("dblclick", (e) => {
    const t = svTab(); if (!t) return;
    const td = e.target.closest("#sv-grid td.sv-c"); if (!td || td.classList.contains("sv-mv")) return;
    svEdit(t, +td.dataset.r, +td.dataset.c);
  });
  
  // 끌어서 범위 고르기. 이미 고른 칸을 한 번 더 누르면 목록(드롭다운)이 있으면 그것을 연다.
  let svDrag = false;
  fileview.addEventListener("mousedown", (e) => {
    const t = svTab(); if (!t) return;
    const td = e.target.closest("#sv-grid td.sv-c"); if (!td || td.classList.contains("sv-mv")) return;
    const r = +td.dataset.r, c = +td.dataset.c;
    if (t._svEd) svCloseEdit(t, true);
    if (t._svFxEd) {
      svCloseFormulaEdit(t, true);
      const grid = svPane("sv-pb"); if (grid) grid.focus();
    }
    const s = t._svSel;
    if (s && s.r1 === r && s.c1 === c && s.r1 === s.r2 && s.c1 === s.c2 && svDvAt(t, svSheet(t), r, c)) { e.preventDefault(); svPick(t, r, c); return; }
    // ⌘(또는 Ctrl)를 누른 채 고르면 앞서 고른 덩어리를 두고 새 덩어리를 더한다(구글 시트와 같다).
    // ⇧는 지금 덩어리를 그 위치까지 늘린다. 브라우저가 글자 선택을 시작하지 않게 막는다.
    // 막지 않으면 ⇧를 눌렀을 때 표가 아니라 글자가 선택되어 범위가 움직이지 않는 것처럼 보인다.
    e.preventDefault();
    const addRange = (e.metaKey || e.ctrlKey) && t._svSel;
    if (addRange) t._svRanges = (t._svRanges || []).concat([svNorm(t._svSel)]);
    else if (!e.shiftKey) t._svRanges = [];
    svDrag = true;
    svSetKeepRanges(true); svSet(t, r, c, e.shiftKey); svSetKeepRanges(false);
  });
  fileview.addEventListener("mouseover", (e) => {
    if (!svDrag) return;
    const t = svTab(); if (!t) return;
    const td = e.target.closest("#sv-grid td.sv-c"); if (!td || td.classList.contains("sv-mv")) return;
    svSetKeepRanges(true); svSet(t, +td.dataset.r, +td.dataset.c, true); svSetKeepRanges(false);
  });
  document.addEventListener("mouseup", () => { svDrag = false; });
  
  // 열 폭·행 높이를 끌어서 바꾼다. 바꾼 값은 저장할 때 파일에도 들어간다. 화면에서만 넓히면
  // 다른 사람이 연 파일은 그대로라 좁아서 보이지 않던 글자가 그대로 남는다.
  let svGrip = null;
  fileview.addEventListener("mousedown", (e) => {
    const t = svTab(); if (!t) return;
    const cg = e.target.closest(".sv-cgrip"), rg = e.target.closest(".sv-rgrip");
    if (!cg && !rg) return;
    e.preventDefault(); e.stopPropagation();
    const sh = svSheet(t);
    svGrip = cg
      ? { kind: "c", i: +cg.dataset.gc, x: e.clientX, from: svColW(sh, +cg.dataset.gc) }
      : { kind: "r", i: +rg.dataset.gr, y: e.clientY, from: (sh.row[+rg.dataset.gr - 1] || 21) };
  }, true);
  document.addEventListener("mousemove", (e) => {
    if (!svGrip) return;
    const t = svTab(); if (!t) return;
    const sh = svSheet(t);
    if (svGrip.kind === "c") sh.col[svGrip.i - 1] = Math.max(24, Math.round(svGrip.from + (e.clientX - svGrip.x)));
    else sh.row[svGrip.i - 1] = Math.max(16, Math.round(svGrip.from + (e.clientY - svGrip.y)));
    svGrip.moved = true;
  });
  document.addEventListener("mouseup", () => {
    if (!svGrip) return;
    const g = svGrip; svGrip = null;
    const t = svTab(); if (!t || !g.moved) return;
    const sh = svSheet(t);
    const box = (t._svLayout = t._svLayout || {});
    const key = (t.sheetIdx || 0) + "|" + g.kind + g.i;
    box[key] = { sheet: sh.name, kind: g.kind, i: g.i, px: g.kind === "c" ? svColW(sh, g.i) : sh.row[g.i - 1], generation: svNextGeneration(t) };
    renderSheetView(t);
  });
  
  // ── 키보드 ──────────────────────────────────────────────────────────────────
  // 구글 시트와 같은 위치에 같은 키. 글자를 그냥 치면 그 칸에서 고치기가 시작된다.
  document.addEventListener("keydown", (e) => {
    const t = svTab(); if (!t || !t.sheet) return;
    const el = e.target, tag = (el.tagName || "").toLowerCase();
  
    // 칸 위에 뜬 입력칸에서.
    if (el.classList && el.classList.contains("sv-ed")) {
      if (e.key === "Enter" && !e.altKey && !e.shiftKey) { e.preventDefault(); svCloseEdit(t, true, [1, 0]); return; }
      if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); svCloseEdit(t, true, [-1, 0]); return; }
      if (e.key === "Tab") { e.preventDefault(); svCloseEdit(t, true, [0, e.shiftKey ? -1 : 1]); return; }
      if (e.key === "Escape") { e.preventDefault(); svCloseEdit(t, false); const g = svPane("sv-pb"); if (g) g.focus(); return; }
      return;
    }
    if (tag === "input" || tag === "textarea") {
      // 되돌리기·저장은 어디에 커서가 있든 듣는다. 수식 입력줄에 커서를 둔 채 ⌘Z를 눌렀을 때
      // 아무 일도 일어나지 않으면 편집 뒤 되돌리기가 동작하지 않는 것으로 보인다(확인).
      if ((e.metaKey || e.ctrlKey) && /^[zyZYsS]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === "s" || e.key === "S") svSave(t);
        else svUndo(t, e.key === "y" || e.key === "Y" || e.shiftKey);
        el.blur();
        return;
      }
      if (el.id === "sv-fq") {
        if (e.key === "Enter") { e.preventDefault(); svFind(t, el.value, e.shiftKey); }
        else if (e.key === "Escape") { e.preventDefault(); svFindBar(t, false); }
        return;
      }
      if (el.id === "sv-fxin") {
        const s = t._svSel;
        if (e.key === "Enter" && s) { e.preventDefault(); svApply(t, [{ r: s.r1, c: s.c1, src: el.value }]); svSet(t, s.r1 + 1, s.c1, false); const g = svPane("sv-pb"); if (g) g.focus(); }
        else if (e.key === "Escape") { e.preventDefault(); svPaint(t); const g = svPane("sv-pb"); if (g) g.focus(); }
        return;
      }
      if (el.id === "sv-name") {
        if (e.key === "Enter") {
          e.preventDefault();
          const at = svA1(String(el.value).trim().toUpperCase());
          if (at) svSet(t, at[0], at[1], false);
          const g = svPane("sv-pb"); if (g) g.focus();
        }
        return;
      }
      return;
    }
    if (!fileview.contains(document.activeElement) && document.activeElement !== document.body) return;
    const sh = svSheet(t); if (!sh) return;
    const mod = e.metaKey || e.ctrlKey;
  
    if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); svSave(t); return; }
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); svUndo(t, e.shiftKey); return; }
    if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); svUndo(t, true); return; }
    if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); const on = svHas(t, "b"); svFormat(t, (st) => { if (on) delete st.b; else st.b = 1; }); return; }
    if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); const on = svHas(t, "i"); svFormat(t, (st) => { if (on) delete st.i; else st.i = 1; }); return; }
    if (mod && (e.key === "u" || e.key === "U")) { e.preventDefault(); const on = svHas(t, "u"); svFormat(t, (st) => { if (on) delete st.u; else st.u = 1; }); return; }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); svFillFrom(t, "down"); return; }
    if (mod && (e.key === "r" || e.key === "R")) { e.preventDefault(); svFillFrom(t, "right"); return; }
    if (mod && (e.key === "f" || e.key === "F")) { e.preventDefault(); svFindBar(t, true); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); svZoom(t, 0.1); return; }
    if (mod && e.key === "-") { e.preventDefault(); svZoom(t, -0.1); return; }
    if (mod && e.key === "0") { e.preventDefault(); svZoom(t, 0); return; }
    if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); t._svSel = { r1: 1, c1: 1, r2: sh.rows, c2: sh.colsCount }; svPaint(t); return; }
    if (e.key === "Escape" && !($("#sv-find") || {}).hidden) { e.preventDefault(); svFindBar(t, false); return; }
    const s = t._svSel; if (!s) return;
    const ext = e.shiftKey;
    const cr = ext ? s.r2 : s.r1, cc = ext ? s.c2 : s.c1;
  
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const ch = [];
      svEachCell(t, (r, c) => { if (svSrcAt(sh, r, c) !== "") ch.push({ r, c, src: "" }); });
      svApply(t, ch);
      return;
    }
    if (e.key === "F2") { e.preventDefault(); svEdit(t, s.r1, s.c1); return; }
  
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (step) {
      e.preventDefault();
      if (mod) svSet(t, step[0] ? (step[0] < 0 ? 1 : sh.rows) : cr, step[1] ? (step[1] < 0 ? 1 : sh.colsCount) : cc, ext);
      else svSet(t, cr + step[0], cc + step[1], ext);
      return;
    }
    if (e.key === "Tab") { e.preventDefault(); svSet(t, cr, cc + (e.shiftKey ? -1 : 1), false); return; }
    if (e.key === "Enter") { e.preventDefault(); svEdit(t, s.r1, s.c1); return; }
    if (e.key === "Home") { e.preventDefault(); svSet(t, mod ? 1 : cr, 1, ext); return; }
    if (e.key === "End") { e.preventDefault(); svSet(t, mod ? sh.rows : cr, sh.colsCount, ext); return; }
    if (e.key === "PageDown") { e.preventDefault(); svSet(t, cr + 25, cc, ext); return; }
    if (e.key === "PageUp") { e.preventDefault(); svSet(t, cr - 25, cc, ext); return; }
    // 글자를 그냥 치면 고치기가 시작되고, 그 글자가 첫 글자가 된다.
    if (!mod && !e.altKey && e.key.length === 1) { e.preventDefault(); svEdit(t, s.r1, s.c1, e.key); return; }
  });
  
  // 수식 입력줄은 focus 시점의 칸을 소유한다. 선택이 먼저 움직이고 focusout이 나중에 와도 새 칸에
  // 이전 값을 잘못 쓰지 않아야 하며, 실제로 글자가 달라진 경우만 dirty다.
  document.addEventListener("focusin", (e) => {
    if (!e.target || e.target.id !== "sv-fxin") return;
    const t = svTab(); if (!t || !t._svSel) return;
    const s = t._svSel;
    t._svFxEd = { el: e.target, si: t.sheetIdx || 0, r: s.r1, c: s.c1, orig: e.target.value };
  });
  document.addEventListener("focusout", (e) => {
    if (!e.target || e.target.id !== "sv-fxin") return;
    const t = svTab(); if (!t || !t._svFxEd || t._svFxEd.el !== e.target) return;
    svCloseFormulaEdit(t, true);
  });
  
  // 고른 것을 ⌘C로 복사, ⌘X로 잘라내기, ⌘V로 붙여넣기(칸은 탭, 줄은 줄바꿈).
  document.addEventListener("copy", (e) => {
    const t = svTab(); if (!t || !t._svSel || t._svEd) return;
    if (String(window.getSelection() || "")) return;
    const txt = svRangeText(t); if (!txt) return;
    e.clipboardData.setData("text/plain", txt);
    e.preventDefault();
    const s = svNorm(t._svSel);
    showToast(s.r1 === s.r2 && s.c1 === s.c2 ? "칸 내용 복사됨" : `${(s.r2 - s.r1 + 1)}줄 × ${(s.c2 - s.c1 + 1)}칸 복사됨`);
  });
  document.addEventListener("cut", (e) => {
    const t = svTab(); if (!t || !t._svSel || t._svEd) return;
    const txt = svRangeText(t); if (!txt) return;
    e.clipboardData.setData("text/plain", txt);
    e.preventDefault();
    const sh = svSheet(t), ch = [];
    svEachCell(t, (r, c) => { if (svSrcAt(sh, r, c) !== "") ch.push({ r, c, src: "" }); });
    svApply(t, ch);
  });
  document.addEventListener("paste", (e) => {
    const t = svTab(); if (!t || !t._svSel || t._svEd) return;
    const txt = (e.clipboardData || {}).getData ? e.clipboardData.getData("text/plain") : "";
    if (!txt) return;
    e.preventDefault();
    const sh = svSheet(t), s = svNorm(t._svSel);
    const rows = txt.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const ch = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        const r = s.r1 + i, c = s.c1 + j;
        if (r > sh.rows || c > sh.colsCount) continue;
        ch.push({ r, c, src: rows[i][j] });
      }
    }
    if (!ch.length) return;
    svGrowTo(t, sh, Math.min(sh.rows, s.r1 + rows.length - 1));
    svApply(t, ch);
    t._svSel = { r1: s.r1, c1: s.c1, r2: Math.min(sh.rows, s.r1 + rows.length - 1), c2: Math.min(sh.colsCount, s.c1 + rows[0].length - 1) };
    svPaint(t);
    showToast(`${rows.length}줄 붙여넣음`);
  });
  
  
}
