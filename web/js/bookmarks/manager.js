// 북마크 관리 화면. rail 의 책갈피 아이콘으로 연다. 북마크마다 열 계정을 정하고, 이름을 바꾸고, 지운다.
//
// 소유 범위
//   이 화면의 렌더·listener, 화면에서 시작되는 북마크 수정(계정·이름·지우기·되돌리기·여러 개 한꺼번에).
//
// 제공 API
//   initCapability(ctx) · panelHtml.
//
// 의존 대상
//   목록 계산과 마크업은 bookmarks/manager-view.js. 북마크 저장은 서버 상태(bsMutate 의 bookmark.*),
//   계정 목록은 browser/profiles.js, 드롭다운은 core/dropdown.js. $·esc·showToast·orderedSpaces 는 ctx 에서 받음.
//
// 유지 조건
//   브라우저의 북마크 막대·메뉴는 건드리지 않음. 계정을 정한 북마크를 그 계정으로 여는 일은
//   browser/bookmarks.js 의 openUrl 이 맡음.
//   서버 상태가 바뀌면 화면이 보일 때만 다시 그림(bookmarkmgr.stateChanged, browser/ai-tabs.js 가 부름).
//   이름을 바꾸는 중에는 다시 그리지 않음. 다시 그리면 쓰던 글자가 사라짐.
//
// 영향 범위
//   core/capabilities.js·core/rail-items.js 의 bookmarkmgr 줄, web/css/44-bookmark-manager.css 의 bkm-* 규칙,
//   server/browser-state.js 의 bookmark.edit(profile)·bookmark.remove·bookmark.add.

import { collectBookmarks, filterSections, autoAccount, managerSummary, sectionsMarkup, rowKey } from "./manager-view.js";
import { getProfiles, getSpaceDefaults, profileName } from "../browser/profiles.js";
import { bsMutate, getBrowserState } from "../browser/state.js";
import { createDropdown } from "../core/dropdown.js";
import { provide } from "../core/hooks.js";

export const panelHtml = `
  <div class="bkm-head">
    <h1>북마크</h1><span class="bkm-sum" id="bkm-sum"></span><span class="bkm-sp"></span>
    <div class="bkm-seg" role="radiogroup" aria-label="거르기">
      <button role="radio" data-bkm-mode="all" aria-checked="true">전체</button>
      <button role="radio" data-bkm-mode="set" aria-checked="false">계정 지정</button>
      <button role="radio" data-bkm-mode="auto" aria-checked="false">자동</button>
    </div>
    <label class="bkm-search"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>
      <input id="bkm-q" type="search" placeholder="이름·주소 찾기" autocomplete="off" spellcheck="false" aria-label="북마크 찾기"><kbd>/</kbd></label>
  </div>
  <div class="bkm-body" id="bkm-body">
    <div class="bkm-main">
      <p class="bkm-why">북마크마다 열 계정을 정합니다. <b>자동</b>이면 설정 「링크 열기」의 계정 규칙을 따르고, 맞는 규칙이 없으면 스페이스 기본 계정으로 엽니다. 브라우저의 북마크 막대에서 열 때 적용됩니다.</p>
      <div id="bkm-list"></div>
    </div>
  </div>
  <div class="bkm-float"><div class="bkm-undo" id="bkm-undo" hidden></div><div class="bkm-bulk" id="bkm-bulk" hidden></div></div>
`;

const UNDO_MS = 8000;
const FRESH_MS = 900;

let $, esc, showToast, orderedSpaces;
let visible = false;
let query = "";
let mode = "all";
const selected = new Set();
let editing = null;        // 이름을 바꾸는 줄의 rowKey
let fresh = null;          // 방금 바꾼 줄(잠깐 강조)
let freshTimer = 0;
let undo = null;           // { row, timer }
let dropdowns = [];       // 일괄 바꾸기 줄의 드롭다운
let rowDropdowns = [];    // 목록 줄마다의 계정 드롭다운
let rowsByKey = new Map();
let listKey = "";         // 마지막으로 그린 목록의 내용 열쇠. 같으면 줄·드롭다운을 다시 만들지 않음
// 이름 바꾸기 직후 서버 방송이 오기 전까지 보일 새 이름
// - 옛 이름으로 그렸다가 방송에 새 이름으로 다시 그리면 줄 강조가 두 번 재생됨
const pendingTitle = new Map();   // rowKey → { title, timer }

function model() {
  const st = getBrowserState();
  const sections = collectBookmarks({ common: st.bookmarksCommon, bySpace: st.bookmarksBySpace, spaces: orderedSpaces() });
  for (const s of sections) for (const r of s.rows) {
    const k = rowKey(r), p = pendingTitle.get(k); if (!p) continue;
    if (p.title === r.title) { clearTimeout(p.timer); pendingTitle.delete(k); } else r.title = p.title;
  }
  return { all: sections, shown: filterSections(sections, query, mode) };
}

function autoCtx() {
  return { rules: getBrowserState().linkProfileRules || [], spaceDefaults: getSpaceDefaults(), profileName };
}

function accountItems(row) {
  const auto = row ? autoAccount(row, autoCtx()) : null;
  return [
    // 트리거에는 열릴 계정 이름만(칸이 좁음), 이유(규칙·스페이스 기본)는 목록에서 봄
    { value: "auto", label: "자동", sub: auto ? (auto.why.startsWith("규칙") ? `${auto.name} · 규칙` : auto.name) : "규칙·스페이스 기본" },
    ...getProfiles().map((p) => ({ value: p.id || "", label: p.name })),
  ];
}

function send(m) { bsMutate(m); }
function editMutation(row, extra) {
  return { op: "bookmark.edit", scope: row.scope === "common" ? "common" : undefined, space: row.space || undefined, url: row.url, ...extra };
}
function markFresh(key) {
  fresh = key; clearTimeout(freshTimer);
  freshTimer = setTimeout(() => { fresh = null; const el = document.querySelector(`[data-bkm-row="${CSS.escape(key)}"]`); if (el) el.classList.remove("bkm-fresh"); }, FRESH_MS);
}

function setAccount(row, value) {
  send(editMutation(row, { profile: value === "auto" ? null : value }));
  markFresh(rowKey(row));
}

let lastSig = "";
function drawnSignature() {
  const st = getBrowserState();
  return JSON.stringify([st.bookmarksCommon, st.bookmarksBySpace, st.linkProfileRules, getSpaceDefaults(),
    getProfiles().map((p) => [p.id, p.name]), orderedSpaces().map((s) => [s.id, s.label])]);
}

function render() {
  if (!visible) return;
  const list = $("#bkm-list"); if (!list) return;
  lastSig = drawnSignature();
  const destroyAll = (arr) => { for (const d of arr) { try { d.destroy(); } catch {} } };
  destroyAll(dropdowns); dropdowns = [];
  const { all, shown } = model();
  rowsByKey = new Map(all.flatMap((s) => s.rows).map((r) => [rowKey(r), r]));
  for (const k of [...selected]) if (!rowsByKey.has(k)) selected.delete(k);
  const sum = managerSummary(all);
  $("#bkm-sum").innerHTML = sum.total ? `<b>${sum.total}</b>개 · 계정 지정 <b>${sum.set}</b>` : "";
  for (const b of document.querySelectorAll("[data-bkm-mode]")) b.setAttribute("aria-checked", String(b.dataset.bkmMode === mode));
  if (!sum.total) {
    destroyAll(rowDropdowns); rowDropdowns = []; listKey = "";
    list.innerHTML = `<div class="bkm-empty"><b>북마크가 없습니다.</b><span>브라우저 주소창 오른쪽의 별을 눌러 추가하면 여기서 계정을 정할 수 있습니다.</span></div>`;
  } else if (!shown.length) {
    destroyAll(rowDropdowns); rowDropdowns = []; listKey = "";
    const what = query ? `‘${esc(query)}’와 맞는 북마크가 없습니다.` : mode === "set" ? "계정을 정한 북마크가 없습니다." : "자동으로 여는 북마크가 없습니다.";
    list.innerHTML = `<div class="bkm-empty"><b>${what}</b><button class="bkm-btn ghost" data-bkm-reset>거르기 풀기</button></div>`;
  } else {
    const html = sectionsMarkup(shown, { selected, editing, fresh });
    // 드롭다운은 마크업에 안 보이므로 값에 영향을 주는 것도 열쇠에 넣음
    const key = html + "\u0000" + JSON.stringify([getProfiles().map((p) => [p.id, p.name]), getSpaceDefaults(),
      getBrowserState().linkProfileRules || [], shown.flatMap((s) => s.rows.map((r) => r.profile))]);
    if (key === listKey && list.querySelector("[data-bkm-acct]")) { renderBulk(); renderUndo(); return; }
    listKey = key;
    destroyAll(rowDropdowns); rowDropdowns = [];
    list.innerHTML = html;
    for (const slot of list.querySelectorAll("[data-bkm-acct]")) {
      const row = rowsByKey.get(slot.dataset.bkmAcct); if (!row) continue;
      const dd = createDropdown({
        items: accountItems(row), value: row.profile === undefined ? "auto" : row.profile,
        ariaLabel: `${row.title} 를 열 계정`, className: "bkm-dd", showSub: row.profile === undefined,
        onChange: (v) => setAccount(row, v),
      });
      slot.appendChild(dd.el); rowDropdowns.push(dd);
    }
    if (editing) { const inp = list.querySelector("[data-bkm-rename]"); if (inp) { inp.focus(); inp.select(); } }
  }
  renderBulk();
  renderUndo();
}

function renderBulk() {
  const bar = $("#bkm-bulk"); if (!bar) return;
  if (!selected.size) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="bkm-bn"><b>${selected.size}</b>개 고름</span><span class="bkm-bl">계정</span><span class="bkm-bdd"></span>
    <button class="bkm-btn ghost" data-bkm-selall>보이는 것 모두 고르기</button><button class="bkm-btn ghost" data-bkm-selnone>고르기 해제</button>`;
  const dd = createDropdown({
    items: accountItems(null), value: "", ariaLabel: "고른 북마크를 열 계정", className: "bkm-dd",
    onChange: (v) => {
      const rows = [...selected].map((k) => rowsByKey.get(k)).filter(Boolean);
      for (const row of rows) send(editMutation(row, { profile: v === "auto" ? null : v }));
      showToast(`북마크 ${rows.length}개를 ${v === "auto" ? "자동" : profileName(v)}(으)로 바꿨습니다`, { level: "ok" });
      selected.clear(); render();
    },
  });
  // 고르기 전에는 아무 계정도 고른 것처럼 보이지 않게 함
  dd.el.querySelector(".cc-dd-value") && (dd.el.querySelector(".cc-dd-value").textContent = "계정 고르기");
  bar.querySelector(".bkm-bdd").appendChild(dd.el); dropdowns.push(dd);
}

function renderUndo() {
  const bar = $("#bkm-undo"); if (!bar) return;
  if (!undo) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = `<span><b>${esc(undo.row.title)}</b> 북마크를 지웠습니다.</span><button class="bkm-btn" data-bkm-undo>되돌리기</button>`;
}

function removeRow(row) {
  send({ op: "bookmark.remove", scope: row.scope === "common" ? "common" : undefined, space: row.space || undefined, url: row.url });
  if (undo) clearTimeout(undo.timer);
  undo = { row, timer: setTimeout(() => { undo = null; renderUndo(); }, UNDO_MS) };
  selected.delete(rowKey(row));
  renderUndo();
}

function undoRemove() {
  if (!undo) return;
  const { row } = undo; clearTimeout(undo.timer); undo = null;
  const base = { op: "bookmark.add", scope: row.scope === "common" ? "common" : undefined, space: row.space || undefined, url: row.url, title: row.title };
  // 폴더가 그사이 없어졌으면 폴더 밖에 되살림
  const st = getBrowserState();
  const list = row.scope === "common" ? st.bookmarksCommon : (st.bookmarksBySpace || {})[row.space];
  const folderAlive = row.folder && Array.isArray(list) && list.some((x) => x && x.folder === row.folder.id);
  send(folderAlive ? { ...base, folder: row.folder.id } : base);
  if (row.profile !== undefined) send(editMutation(row, { profile: row.profile }));
  markFresh(rowKey(row));
  render();
}

function commitRename(key, value) {
  const row = rowsByKey.get(key); editing = null;
  const title = String(value || "").trim();
  if (row && title && title !== row.title) {
    send(editMutation(row, { title })); markFresh(key);
    const old = pendingTitle.get(key); if (old) clearTimeout(old.timer);
    // 방송이 안 와도(서버가 거절) 3초 뒤에는 서버 값으로 돌아감
    pendingTitle.set(key, { title, timer: setTimeout(() => { pendingTitle.delete(key); render(); }, 3000) });
  }
  render();
}

function wire() {
  const root = $("#bookmarkmgr-panel"); if (!root) return;
  root.addEventListener("click", (e) => {
    const m = e.target.closest("[data-bkm-mode]");
    if (m) { mode = m.dataset.bkmMode; render(); return; }
    if (e.target.closest("[data-bkm-reset]")) { query = ""; mode = "all"; $("#bkm-q").value = ""; render(); return; }
    if (e.target.closest("[data-bkm-undo]")) { undoRemove(); return; }
    if (e.target.closest("[data-bkm-selnone]")) { selected.clear(); render(); return; }
    if (e.target.closest("[data-bkm-selall]")) { for (const s of model().shown) for (const r of s.rows) selected.add(rowKey(r)); render(); return; }
    const ed = e.target.closest("[data-bkm-edit]");
    if (ed) { editing = ed.dataset.bkmEdit; render(); return; }
    const del = e.target.closest("[data-bkm-del]");
    if (del) { const row = rowsByKey.get(del.dataset.bkmDel); if (row) removeRow(row); return; }
  });
  root.addEventListener("change", (e) => {
    const ck = e.target.closest("[data-bkm-sel]");
    if (!ck) return;
    if (ck.checked) selected.add(ck.dataset.bkmSel); else selected.delete(ck.dataset.bkmSel);
    const row = ck.closest("[data-bkm-row]"); if (row) row.classList.toggle("on", ck.checked);
    renderBulk();
  });
  root.addEventListener("input", (e) => { if (e.target.id === "bkm-q") { query = e.target.value; render(); } });
  root.addEventListener("keydown", (e) => {
    const ren = e.target.closest && e.target.closest("[data-bkm-rename]");
    if (ren) {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commitRename(ren.dataset.bkmRename, ren.value); }
      else if (e.key === "Escape") { e.preventDefault(); editing = null; render(); }
      return;
    }
    if (e.target.id === "bkm-q" && e.key === "Escape") {
      e.preventDefault();
      const box = e.target;
      if (query) { query = ""; box.value = ""; render(); } else box.blur();
      return;
    }
    const typing = e.target.matches && e.target.matches("input, textarea, [contenteditable]");
    if (!typing && e.key === "/") { e.preventDefault(); $("#bkm-q").focus(); return; }
    if (!typing && e.key === "Escape" && selected.size) { selected.clear(); render(); }
  });
  root.addEventListener("focusout", (e) => {
    const ren = e.target.closest && e.target.closest("[data-bkm-rename]");
    if (ren && editing === ren.dataset.bkmRename) commitRename(ren.dataset.bkmRename, ren.value);
  });
}

export function initCapability(ctx) {
  ({ $, esc, showToast, orderedSpaces } = ctx);
  wire();
  // 서버 상태는 탭 이동마다 옴. 이 화면이 그리는 값이 그대로면 다시 그리지 않음(열어 둔 드롭다운·누르던 단추가 사라지지 않게)
  provide("bookmarkmgr.stateChanged", () => {
    if (!visible || editing) return;
    const sig = drawnSignature();
    if (sig !== lastSig) render();
  });
  return { screen: { enter() { visible = true; render(); }, leave() { visible = false; editing = null; } } };
}
