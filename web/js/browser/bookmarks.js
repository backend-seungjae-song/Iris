// 북마크바와 주소창 제안. 그 스페이스의 즐겨찾기와 방문 기록을 다룬다.
//
// 소유 범위
//   현재 스페이스 북마크의 렌더 캐시와 주소창 제안 목록의 열림 상태·선택 위치·원래 치던 값.
//   정본은 서버에 있고 여기 있는 것은 그 사본이다.
//
// 제공 API
//   북마크 렌더·별표 동기화·기록 남기기, 주소창 제안 열기/닫기/이동/다시 그리기,
//   그리고 init 에서 북마크바 클릭·＋·별표 연결.
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

export let bookmarks = [];   // 현재 스페이스 북마크의 렌더 캐시(browser-state 브로드캐스트로 갱신)
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
export function renderBookmarks() {
  bookmarks = bmForSpace();
  $("#bookmark-bar").innerHTML = bookmarks.map((b, i) => `<span class="bmk" draggable="true" data-i="${i}" data-url="${esc(b.url)}" title="${esc(b.url)}"><span class="bmk-t">${esc(b.title || b.url)}</span><span class="bmk-e" data-e="${i}" title="편집">✎</span><span class="bmk-x" data-x="${i}">✕</span></span>`).join("");
  wireReorder($("#bookmark-bar"), ".bmk", (el) => el.dataset.url,
    (url, before) => { const sp = curBmSpace(); if (sp) bsMutate({ op: "bookmark.move", space: sp, url, before }); });
}
export function pushHistory(u) {
  if (!u || u === "about:blank") return;
  const sp = curBmSpace(); if (!sp) return;   // 어느 스페이스 것인지 모르면 남기지 않는다
  bsMutate({ op: "history.push", space: sp, url: u });
}
export function syncBookmarkStar() { const u = currentUrl(); $("#wv-bookmark").classList.toggle("on", bookmarks.some((b) => b.url === u)); }
// 북마크 인라인 편집: ✎ → 이름·URL 입력으로 교체, Enter/✓ 저장, Esc/blur 취소.
function editBookmark(i) {
  const bm = bookmarks[i]; if (!bm) return;
  const sp = curBmSpace(); if (!sp) return;
  const span = $("#bookmark-bar").querySelector(`.bmk[data-i="${i}"]`); if (!span) return;
  span.innerHTML = `<input class="bmk-in bmk-in-t" value="${esc(bm.title || "")}" placeholder="이름" /><input class="bmk-in bmk-in-u" value="${esc(bm.url)}" placeholder="https://" /><span class="bmk-ok" title="저장">✓</span>`;
  const ti = span.querySelector(".bmk-in-t"), ui = span.querySelector(".bmk-in-u");
  let done = false;
  const save = () => { if (done) return; done = true; const t = ti.value.trim(), u = ui.value.trim();
    if (u && (u !== bm.url || t !== (bm.title || ""))) bsMutate({ op: "bookmark.edit", space: sp, url: bm.url, newUrl: u, title: t });
    renderBookmarks(); }; // 성공 시 broadcast가 다시 렌더(멱등), 거절(중복 URL 등) 시에도 편집기 해제(고정 방지)
  const cancel = () => { if (done) return; done = true; renderBookmarks(); };
  span.querySelector(".bmk-ok").addEventListener("mousedown", (ev) => { ev.preventDefault(); save(); });
  for (const el of [ti, ui]) {
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } else if (ev.key === "Escape") { ev.preventDefault(); cancel(); } });
    el.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ti && document.activeElement !== ui) cancel(); }, 0));
  }
  ti.focus(); ti.select();
}

// 연결은 init 에서 한 번. 기존 최상위 부작용의 순서를 그대로 둔다.
export function wireBookmarkBar() {
  $("#wv-bookmark").addEventListener("click", () => {
    const u = currentUrl(); if (!u || u === "about:blank") return;
    const sp = curBmSpace(); if (!sp) return;
    // 서버로 mutation만 보낸다. 실제 반영·재렌더는 browser-state 브로드캐스트 수신에서(멱등).
    if (bookmarks.some((b) => b.url === u)) bsMutate({ op: "bookmark.remove", space: sp, url: u });
    else bsMutate({ op: "bookmark.add", space: sp, url: u, title: (activeWv()?.title || u).slice(0, 60) });
  });
  // 북마크 라인 "＋": 별표 토글과 별개로 현재 페이지를 바로 북마크 추가(이미 있으면 서버가 멱등 처리).
  $("#bmk-add").addEventListener("click", () => {
    const u = currentUrl(); if (!u || u === "about:blank") return;
    const sp = curBmSpace(); if (!sp) return;
    if (bookmarks.some((b) => b.url === u)) return; // 중복 방지(이미 북마크됨)
    bsMutate({ op: "bookmark.add", space: sp, url: u, title: (activeWv()?.title || u).slice(0, 60) });
  });
  $("#bookmark-bar").addEventListener("click", (e) => {
    const ed = e.target.closest(".bmk-e"); if (ed) { e.stopPropagation(); editBookmark(+ed.dataset.e); return; }
    const x = e.target.closest(".bmk-x"); if (x) { e.stopPropagation(); const bm = bookmarks[+x.dataset.x]; const sp = curBmSpace(); if (bm && sp) bsMutate({ op: "bookmark.remove", space: sp, url: bm.url }); return; }
    const b = e.target.closest(".bmk"); if (b && !b.querySelector(".bmk-in")) { const bm = bookmarks[+b.dataset.i]; if (bm) { if (!activeWv()) openBrowser(); urlInput.value = bm.url; navigate(bm.url); } }
  });
}
