// 북마크바와 주소창 제안. 그 스페이스의 즐겨찾기와 방문 기록을 다룬다.
//
// 소유 범위
//   보이는 북마크 구역(세션, 켜져 있으면 공통)의 렌더 캐시, 폴더·구역 메뉴의 열림 상태,
//   주소창 제안 목록의 열림 상태·선택 위치·원래 치던 값. 정본은 서버에 있고 여기 있는 것은 그 사본이다.
//   공통 구역의 목록은 편의 기능(commonbookmarks)이 commonbookmarks.list 로 내줄 때만 있다.
//
// 제공 API
//   북마크 렌더·별표 동기화·기록 남기기, 주소창 제안 열기/닫기/이동/다시 그리기,
//   그리고 init 에서 북마크바 클릭·끌기·＋·새 폴더·별표 연결.
//
// 의존 대상
//   상태와 space 판정은 browser/state, 지금 보는 webview 는 browser/webview,
//   끌어서 순서 바꾸기는 core/reorder 에서 import 한다.
//   $·esc·urlInput·openBrowser·navigate 는 main 이 소유해서 init 에서 받는다.
//
// 유지 조건
//   서버로 mutation 만 보내고 목록을 직접 고치지 않는다. 실제 반영은 browser-state
//   브로드캐스트 수신에서 하고, 그래야 두 창이 같은 것을 본다(멱등).
//   기록은 스페이스마다 따로다. 어느 스페이스 것인지 모르면 남기지 않는다.
//   제안 목록에서 인덱스 -1 은 "원래 치던 값"이다. 끝을 넘으면 거기로 돌아와야
//   사용자가 친 것을 되찾을 수 있다.
//
// 영향 범위
//   #bookmark-bar·#url-sug·#wv-bookmark·#bmk-add DOM 과 main 의 주소창 입력 처리.
//   이 API를 바꾸면 import 하는 파일도 함께 바꿔야 한다:
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/bookmarks.js
import { bsMutate, curBmSpace, getBrowserState } from "./state.js";
import { activeWv } from "./webview.js";
import { wireReorder } from "../core/reorder.js";
import { callHook } from "../core/hooks.js";

let $, esc, urlInput, openBrowser, navigate;

// init 은 값만 받는다. 연결은 두 군데에서 각자 기존 최상위 코드가 있던 줄에서 호출한다.
// 주소창은 브라우저 도구모음이 만들어진 뒤, 북마크바는 그보다 나중이다.
export function initBookmarks(deps) {
  ({ $, esc, urlInput, openBrowser, navigate } = deps);
}

// 주소창 입력과 제안 목록. 제안 상태(무엇을 치고 있었는가·어디를 훑고 있는가)가 이 모듈에
// 있으므로 그 상태를 읽고 쓰는 연결도 여기 있어야 한다. main 에 두면 사설 변수를 밖에서
// 호출하게 되고, 그러면 구문 검사와 테스트는 통과한 채 주소창을 누를 때만 실패한다.
// goUrl 은 main 이 소유한다. 주소 확정은 탭·webview 흐름이라 이 모듈의 책임이 아니다.
export function wireUrlBar({ goUrl }) {
  urlInput.addEventListener("input", () => { sugTyped = urlInput.value; sugIdx = -1; openSug(sugTyped); });
  urlInput.addEventListener("focus", () => { sugTyped = urlInput.value; });
  urlInput.addEventListener("blur", () => setTimeout(closeSug, 120)); // 항목 클릭이 먼저 처리되게
  urlInput.addEventListener("keydown", (ev) => {
    const k = ev.code || "";
    if (k === "ArrowDown") { ev.preventDefault(); moveSug(+1); return; }
    if (k === "ArrowUp") { ev.preventDefault(); moveSug(-1); return; }
    // 제안을 훑던 중의 Esc는 원래 치던 값으로 되돌리고 목록만 닫는다. 포커스는 주소창에 남는다.
    if (k === "Escape" && sugOpen()) { ev.preventDefault(); ev.stopPropagation(); urlInput.value = sugTyped; closeSug(); urlInput.focus(); return; }
    if (k === "Enter" || k === "NumpadEnter") { closeSug(); goUrl(); }
  });
  $("#url-sug").addEventListener("mousedown", (ev) => {
    const it = ev.target.closest(".sug"); if (!it) return;
    ev.preventDefault(); urlInput.value = sugItems[+it.dataset.i] || urlInput.value; closeSug(); goUrl();
  });
}

export let bookmarks = [];   // 지금 보이는 북마크 전부(폴더 안 포함)를 펼친 렌더 캐시. 별표·주소창 제안이 쓴다
// 주소창 기록도 스페이스마다 따로 둔다. 전역 하나로 두면 acme 주소창에
// shop 에서 가던 주소가 나온다. 씨앗(__seed__)은 앱 이름이 바뀌기 전 기록 중 어느 스페이스 것인지
// 구분할 수 없는 항목이라, 제안에는 함께 나오되 새로 쌓이지는 않는다.
const HISTORY_SEED = "__seed__";
export function historyFor(sp) {
  const m = getBrowserState().urlHistoryBySpace || {};
  const mine = (sp && Array.isArray(m[sp])) ? m[sp] : [];
  const seed = Array.isArray(m[HISTORY_SEED]) ? m[HISTORY_SEED] : [];
  return [...mine, ...seed];
}
export function currentUrl() { const r = activeWv(); return r ? r.url : ""; }
export function bmForSpace() { const sp = curBmSpace(), state = getBrowserState(); return (sp && state.bookmarksBySpace && Array.isArray(state.bookmarksBySpace[sp])) ? state.bookmarksBySpace[sp] : []; }
// 주소창 제안 목록. datalist는 화살표 이동이 입력창에 반영되는 방식도, Esc 복귀도 제어할 수 없어
// 직접 그린다. 규칙: 위아래로 옮기면 그 후보가 입력창에 그대로 들어가고, Esc는 원래 치던 값으로 되돌린다.
let sugItems = [], sugIdx = -1, sugTyped = "";
export function urlPool() { return [...new Set([...bookmarks.map((b) => b.url), ...historyFor(curBmSpace())])]; }
export function sugOpen() { return !$("#url-sug").hidden; }
export function renderUrlDatalist() { if (sugOpen()) openSug(sugTyped); } // 목록이 바뀌면 열려 있을 때만 다시 그린다
export function closeSug() { const box = $("#url-sug"); box.hidden = true; box.innerHTML = ""; sugItems = []; sugIdx = -1; }
function paintSug() {
  const box = $("#url-sug");
  box.innerHTML = sugItems.map((u, i) => `<div class="sug${i === sugIdx ? " on" : ""}" data-i="${i}">${esc(u)}</div>`).join("");
  const on = box.querySelector(".sug.on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}
export function openSug(q) {
  const s = String(q || "").trim().toLowerCase();
  sugItems = urlPool().filter((u) => !s || u.toLowerCase().includes(s)).slice(0, 8);
  if (!sugItems.length) { closeSug(); return; }
  $("#url-sug").hidden = false; paintSug();
}
// 인덱스 -1 = "원래 치던 값". 목록 끝을 넘으면 거기로 돌아와 원문을 다시 보여준다.
export function moveSug(d) {
  if (!sugOpen()) { sugTyped = urlInput.value; sugIdx = -1; openSug(sugTyped); if (!sugItems.length) return; }
  if (!sugItems.length) return;
  const n = sugItems.length + 1;
  sugIdx = ((sugIdx + 1 + d) % n + n) % n - 1;
  urlInput.value = sugIdx < 0 ? sugTyped : sugItems[sugIdx];
  paintSug();
}
// ── 북마크바 ─────────────────────────────────────────────────────────
// 구역은 세션(이 스페이스) 하나이고, 공통 북마크 편의 기능이 켜져 있으면 공통 구역이 앞에 붙는다.
// 그 기능이 로드되지 않았으면 아래 호출은 undefined 를 돌려주고 세션 구역만 그린다.
let sections = [];
function currentSections() {
  const session = { scope: "space", label: "세션", items: bmForSpace() };
  const common = callHook("commonbookmarks.list");
  return Array.isArray(common) ? [{ scope: "common", label: "공통", items: common }, session] : [session];
}
const leaves = (items) => items.flatMap((x) => (x && x.folder ? (x.items || []) : [x])).filter((x) => x && x.url);
const sectionOf = (scope) => sections.find((s) => s.scope === scope) || null;
const folderIn = (scope, id) => (sectionOf(scope)?.items || []).find((x) => x && x.folder === id) || null;

// 칩의 열쇠는 "구역|종류|값" 이다. 값(url)에 | 가 들어 있어도 앞의 두 칸만 잘라 읽는다.
function parseKey(k) { const [scope, kind, ...rest] = String(k || "").split("|"); return { scope, kind, id: rest.join("|") }; }

// scope 가 "common" 이 아니면 서버는 그 스페이스의 세션 목록을 고친다. 공통 목록도 space 를 함께 보낸다.
// 구역을 넘나드는 이동은 두 목록을 한 번에 고쳐야 하기 때문이다.
function sendBm(m) {
  const sp = curBmSpace(); if (!sp) return false;
  bsMutate({ ...m, space: sp });
  return true;
}

function chipHtml(scope, b) {
  if (b.folder) {
    return `<span class="bmk bmk-folder" draggable="true" tabindex="0" role="button" aria-haspopup="menu" aria-expanded="false"`
      + ` data-key="${esc(scope + "|f|" + b.folder)}" title="${esc(b.title)}">`
      + `<svg class="bmk-fi" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>`
      + `<span class="bmk-t">${esc(b.title)}</span><span class="bmk-n">${(b.items || []).length}</span>`
      + `<span class="bmk-e" title="이름 바꾸기">✎</span><span class="bmk-x" title="폴더 삭제. 안의 북마크는 폴더 자리에 남습니다">✕</span></span>`;
  }
  return `<span class="bmk" draggable="true" data-key="${esc(scope + "|u|" + b.url)}" data-url="${esc(b.url)}" title="${esc(b.url)}">`
    + `<span class="bmk-t">${esc(b.title || b.url)}</span><span class="bmk-e" title="편집">✎</span><span class="bmk-x" title="삭제">✕</span></span>`;
}
function sectionHtml(sec, multi) {
  const head = multi
    ? `<button class="bmk-sec-h" data-scope="${sec.scope}" aria-haspopup="menu" title="${sec.scope === "common" ? "모든 스페이스에서 보이는 북마크" : "이 스페이스에서만 보이는 북마크"}">${sec.label}</button>`
    : "";
  // 끝 표시는 구역의 마지막 칩 오른쪽과 빈 구역에 놓을 자리다. 없으면 구역을 넘어 끝에 놓는 이동을 구별할 수 없다.
  return `<div class="bmk-sec" data-scope="${sec.scope}">${head}${sec.items.map((b) => chipHtml(sec.scope, b)).join("")}`
    + `<span class="bmk-end" data-key="${sec.scope}|end|"></span></div>`;
}

let pendingFolderEdit = null;   // 방금 만든 폴더. 서버 브로드캐스트로 칩이 생기면 바로 이름 입력을 연다
export function renderBookmarks() {
  sections = currentSections();
  bookmarks = sections.flatMap((s) => leaves(s.items));
  const bar = $("#bookmark-bar");
  bar.innerHTML = sections.map((s) => sectionHtml(s, sections.length > 1)).join("");
  wireReorder(bar, ".bmk, .bmk-end", (el) => el.dataset.key, moveByKeys);
  if (pendingFolderEdit && folderIn(pendingFolderEdit.scope, pendingFolderEdit.id)) {
    const { scope, id } = pendingFolderEdit; pendingFolderEdit = null; editFolder(scope, id);
  }
  refreshMenu();
}
// wireReorder 는 "어느 칩 앞"을 준다. 앞 칩이 다른 구역이면 구역을 옮기는 이동이다.
function moveByKeys(movedKey, beforeKey) {
  const a = parseKey(movedKey), b = beforeKey ? parseKey(beforeKey) : null;
  const m = { op: "bookmark.move", scope: a.scope, toScope: b ? b.scope : a.scope };
  if (a.kind === "f") m.folder = a.id; else m.url = a.id;
  if (b && b.kind === "u") m.before = b.id; else if (b && b.kind === "f") m.beforeFolder = b.id;
  sendBm(m);
}
export function pushHistory(u) {
  if (!u || u === "about:blank") return;
  const sp = curBmSpace(); if (!sp) return;   // 어느 스페이스 것인지 모르면 남기지 않는다
  bsMutate({ op: "history.push", space: sp, url: u });
}
export function syncBookmarkStar() { const u = currentUrl(); $("#wv-bookmark").classList.toggle("on", bookmarks.some((b) => b.url === u)); }

// 칩 인라인 편집: ✎ → 입력칸으로 교체, Enter/✓ 저장, Esc/blur 취소.
function editChip(chip, fields, save) {
  chip.innerHTML = fields.map((f) => `<input class="bmk-in ${f.cls}" value="${esc(f.value)}" placeholder="${f.ph}" />`).join("")
    + `<span class="bmk-ok" title="저장">✓</span>`;
  const ins = [...chip.querySelectorAll(".bmk-in")];
  let done = false;
  // 성공하면 브로드캐스트가 다시 그린다(멱등). 거절(중복 URL 등)돼도 편집기를 내려 칩이 입력칸으로 남지 않게 한다.
  const finish = (ok) => { if (done) return; done = true; if (ok) save(ins.map((i) => i.value.trim())); renderBookmarks(); };
  chip.querySelector(".bmk-ok").addEventListener("mousedown", (ev) => { ev.preventDefault(); finish(true); });
  for (const el of ins) {
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); finish(true); } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); } });
    el.addEventListener("blur", () => setTimeout(() => { if (!ins.includes(document.activeElement)) finish(false); }, 0));
  }
  ins[0].focus(); ins[0].select();
}
const chipByKey = (key) => [...$("#bookmark-bar").querySelectorAll(".bmk")].find((el) => el.dataset.key === key) || null;
function editBookmark(scope, url) {
  const bm = leaves(sectionOf(scope)?.items || []).find((b) => b.url === url);
  const chip = chipByKey(`${scope}|u|${url}`); if (!bm || !chip) return;
  editChip(chip, [{ cls: "bmk-in-t", value: bm.title || "", ph: "이름" }, { cls: "bmk-in-u", value: bm.url, ph: "https://" }], ([t, u]) => {
    if (u && (u !== bm.url || t !== (bm.title || ""))) sendBm({ op: "bookmark.edit", scope, url: bm.url, newUrl: u, title: t });
  });
}
function editFolder(scope, id) {
  const f = folderIn(scope, id), chip = chipByKey(`${scope}|f|${id}`); if (!f || !chip) return;
  editChip(chip, [{ cls: "bmk-in-t", value: f.title || "", ph: "폴더 이름" }], ([t]) => {
    if (t && t !== f.title) sendBm({ op: "bookmark.folder.rename", scope, folder: id, title: t });
  });
}
function newFolder(scope) {
  const id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (sendBm({ op: "bookmark.folder.add", scope, folder: id, title: "새 폴더" })) pendingFolderEdit = { scope, id };
}
function openUrl(url) { if (!activeWv()) openBrowser(); urlInput.value = url; navigate(url); }
function pageToAdd() { const u = currentUrl(); return u && u !== "about:blank" ? { url: u, title: (activeWv()?.title || u).slice(0, 60) } : null; }

// ── 폴더·구역 메뉴 ──────────────────────────────────────────────────
// 메뉴는 하나만 연다. 열린 동안 상태가 바뀌면(다른 창의 편집 포함) 같은 자리에서 내용을 다시 그린다.
let menu = null;   // { el, kind: "folder"|"section", scope, id, anchorKey }
function anchorOf(m) {
  return m.kind === "folder" ? chipByKey(m.anchorKey)
    : $("#bookmark-bar").querySelector(`.bmk-sec-h[data-scope="${m.scope}"]`);
}
function menuHtml(m) {
  const page = pageToAdd();
  const has = page && leaves(sectionOf(m.scope)?.items || []).some((b) => b.url === page.url);
  if (m.kind === "section") {
    return `<div class="bmf-h">${m.scope === "common" ? "공통 북마크" : "세션 북마크"}</div>`
      + `<button class="bmf-act" data-act="add-page"${page && !has ? "" : " disabled"}>${has ? "현재 페이지가 이미 있습니다" : "현재 페이지 추가"}</button>`
      + `<button class="bmf-act" data-act="new-folder">새 폴더</button>`;
  }
  const f = folderIn(m.scope, m.id); if (!f) return null;
  const rows = (f.items || []).map((b) => `<div class="bmf-row">`
    + `<button class="bmf-open" data-url="${esc(b.url)}" title="${esc(b.url)}">${esc(b.title || b.url)}</button>`
    + `<button class="bmf-ic" data-act="out" data-url="${esc(b.url)}" title="폴더에서 꺼내기">↥</button>`
    + `<button class="bmf-ic" data-act="del" data-url="${esc(b.url)}" title="삭제">✕</button></div>`).join("");
  return `<div class="bmf-h">${esc(f.title)}</div>`
    + (rows || `<div class="bmf-empty">비어 있습니다. 북마크를 폴더 가운데로 끌어 놓으면 들어갑니다.</div>`)
    + `<div class="bmf-sep"></div>`
    + `<button class="bmf-act" data-act="add-page"${page && !has ? "" : " disabled"}>${has ? "현재 페이지가 이미 북마크에 있습니다" : "현재 페이지를 이 폴더에 추가"}</button>`;
}
function placeMenu() {
  const a = anchorOf(menu); if (!a) { closeMenu(false); return; }
  a.setAttribute("aria-expanded", "true");
  const r = a.getBoundingClientRect(), w = menu.el.offsetWidth;
  menu.el.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + "px";
  menu.el.style.top = Math.round(r.bottom + 4) + "px";
}
const menuButtons = () => (menu ? [...menu.el.querySelectorAll("button:not([disabled])")] : []);
function refreshMenu() {
  if (!menu) return;
  const html = menuHtml(menu); if (html == null) { closeMenu(false); return; }
  const focusedIdx = menuButtons().indexOf(document.activeElement);
  menu.el.innerHTML = html; placeMenu();
  if (!menu) return;
  if (focusedIdx >= 0) (menuButtons()[focusedIdx] || menuButtons().at(-1) || menu.el).focus();
}
function openMenu(m, byKeyboard) {
  closeMenu(false);
  const html = menuHtml(m); if (html == null) return;
  const el = document.createElement("div");
  el.className = "bmf-menu"; el.id = "bmk-menu"; el.setAttribute("role", "menu"); el.tabIndex = -1;
  el.innerHTML = html;
  document.body.appendChild(el);
  menu = { ...m, el };
  placeMenu();
  if (!menu) return;
  el.addEventListener("click", onMenuClick);
  el.addEventListener("keydown", onMenuKey);
  (byKeyboard ? menuButtons()[0] || el : el).focus({ preventScroll: true });
}
function closeMenu(focusBack) {
  if (!menu) return;
  const a = anchorOf(menu); if (a) a.setAttribute("aria-expanded", "false");
  menu.el.remove(); menu = null;
  if (focusBack && a) a.focus();
}
function onMenuKey(e) {
  const bs = menuButtons(); const i = bs.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); if (!bs.length) return;
    const d = e.key === "ArrowDown" ? 1 : -1;
    bs[i < 0 ? (d > 0 ? 0 : bs.length - 1) : (i + d + bs.length) % bs.length].focus();
  } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  else if (e.key === "Tab") closeMenu(false);
}
function onMenuClick(e) {
  const b = e.target.closest("button"); if (!b || b.disabled || !menu) return;
  const { scope, id, kind } = menu;
  if (b.classList.contains("bmf-open")) { closeMenu(false); openUrl(b.dataset.url); return; }
  const act = b.dataset.act, url = b.dataset.url;
  if (act === "add-page") { const p = pageToAdd(); if (p) sendBm({ op: "bookmark.add", scope, ...p, ...(kind === "folder" ? { folder: id } : {}) }); closeMenu(false); }
  else if (act === "new-folder") { closeMenu(false); newFolder(scope); }
  else if (act === "del") sendBm({ op: "bookmark.remove", scope, url });
  else if (act === "out") {
    // 꺼낸 북마크는 폴더 바로 오른쪽에 둔다. 맨 끝으로 보내면 긴 북마크바에서 찾기 어렵다.
    const items = sectionOf(scope)?.items || [], i = items.findIndex((x) => x && x.folder === id), next = items[i + 1];
    sendBm({ op: "bookmark.move", scope, toScope: scope, url, ...(next ? (next.folder ? { beforeFolder: next.folder } : { before: next.url }) : {}) });
  }
}

// 연결은 init 에서 한 번. 기존 최상위 부작용의 순서를 그대로 둔다.
export function wireBookmarkBar() {
  const bar = $("#bookmark-bar");
  // 별표는 보이는 구역 어디에든 있으면 지운다. 세션 구역을 먼저 본다. 새로 추가하는 곳이 세션이라서
  // 별표를 두 번 누르면 원래대로 돌아가야 한다.
  $("#wv-bookmark").addEventListener("click", () => {
    const p = pageToAdd(); if (!p) return;
    // 서버로 mutation만 보낸다. 실제 반영·재렌더는 browser-state 브로드캐스트 수신에서(멱등).
    const hit = [...sections].reverse().find((s) => leaves(s.items).some((b) => b.url === p.url));
    if (hit) sendBm({ op: "bookmark.remove", scope: hit.scope, url: p.url });
    else sendBm({ op: "bookmark.add", scope: "space", ...p });
  });
  // 북마크 라인 "＋": 별표 토글과 별개로 현재 페이지를 세션 북마크에 바로 추가한다(이미 보이면 추가하지 않는다).
  $("#bmk-add").addEventListener("click", () => {
    const p = pageToAdd(); if (!p || bookmarks.some((b) => b.url === p.url)) return;
    sendBm({ op: "bookmark.add", scope: "space", ...p });
  });
  $("#bmk-folder-add").addEventListener("click", () => newFolder("space"));
  bar.addEventListener("click", (e) => {
    const head = e.target.closest(".bmk-sec-h");
    if (head) {
      e.stopPropagation();
      const same = menu && menu.kind === "section" && menu.scope === head.dataset.scope;
      if (same) closeMenu(false); else openMenu({ kind: "section", scope: head.dataset.scope }, e.detail === 0);
      return;
    }
    const chip = e.target.closest(".bmk"); if (!chip || chip.querySelector(".bmk-in")) return;
    const k = parseKey(chip.dataset.key);
    if (e.target.closest(".bmk-e")) { e.stopPropagation(); closeMenu(false); if (k.kind === "f") editFolder(k.scope, k.id); else editBookmark(k.scope, k.id); return; }
    if (e.target.closest(".bmk-x")) {
      e.stopPropagation(); closeMenu(false);
      sendBm(k.kind === "f" ? { op: "bookmark.folder.remove", scope: k.scope, folder: k.id } : { op: "bookmark.remove", scope: k.scope, url: k.id });
      return;
    }
    if (k.kind === "f") {
      e.stopPropagation();
      const same = menu && menu.kind === "folder" && menu.anchorKey === chip.dataset.key;
      if (same) closeMenu(false); else openMenu({ kind: "folder", scope: k.scope, id: k.id, anchorKey: chip.dataset.key }, e.detail === 0);
      return;
    }
    openUrl(k.id);
  });
  // 폴더 칩은 키보드로도 연다. 북마크 칩은 원래대로 마우스 전용이다.
  bar.addEventListener("keydown", (e) => {
    const chip = e.target.closest?.(".bmk-folder"); if (!chip || e.target !== chip) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      const k = parseKey(chip.dataset.key);
      openMenu({ kind: "folder", scope: k.scope, id: k.id, anchorKey: chip.dataset.key }, true);
    }
  });
  document.addEventListener("mousedown", (e) => { if (menu && !e.target.closest("#bmk-menu") && !e.target.closest(".bmk-folder, .bmk-sec-h")) closeMenu(false); }, true);
  window.addEventListener("resize", () => closeMenu(false));
  bar.addEventListener("scroll", () => closeMenu(false));

  // 폴더 칩 가운데에 놓으면 폴더 안으로 들어간다. 양쪽 가장자리는 순서 바꾸기(wireReorder)가 받는다.
  // 캡처 단계에서 먼저 보고, 가운데일 때만 전파를 막아 순서 바꾸기가 앞·뒤 표시를 그리지 않게 한다.
  let dragKey = null;
  const clearInto = () => bar.querySelectorAll(".drop-into").forEach((n) => n.classList.remove("drop-into"));
  const intoTarget = (e) => {
    const f = e.target.closest?.(".bmk-folder"); if (!f || !dragKey || parseKey(dragKey).kind !== "u") return null;
    const r = f.getBoundingClientRect(), x = e.clientX - r.left;
    return x > r.width * 0.25 && x < r.width * 0.75 ? f : null;
  };
  bar.addEventListener("dragstart", (e) => { dragKey = e.target.closest?.(".bmk")?.dataset.key || null; closeMenu(false); }, true);
  bar.addEventListener("dragend", () => { dragKey = null; clearInto(); }, true);
  bar.addEventListener("dragover", (e) => {
    const f = intoTarget(e); clearInto(); if (!f) return;
    e.preventDefault(); e.stopPropagation();
    bar.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    f.classList.add("drop-into");
  }, true);
  bar.addEventListener("drop", (e) => {
    const f = intoTarget(e); if (!f) return;
    e.preventDefault(); e.stopPropagation(); clearInto();
    const a = parseKey(dragKey), to = parseKey(f.dataset.key);
    bar.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    dragKey = null;
    sendBm({ op: "bookmark.move", scope: a.scope, toScope: to.scope, url: a.id, into: to.id });
  }, true);
}
