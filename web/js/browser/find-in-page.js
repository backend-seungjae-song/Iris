// 페이지 내 찾기(⌘F). 크롬의 찾기 막대에 해당한다.
//
// 소유 범위
//   찾기 막대의 열림/닫힘, 지금 찾는 글자, 몇 번째/몇 개 표시, 그리고 어느 탭에서 찾는 중인지.
//
// 제공 API
//   initFindInPage(deps) 와 openFind·closeFind·findNext·findIsOpen.
//
// 의존 대상
//   지금 탭의 <webview> 를 주는 접근자(activeWv)를 init 에서 받는다. 여기서 browser/webview 를
//   import 하면 webview → webview-factory → find-in-page 로 고리가 생긴다.
//   실제 찾기는 그 guest 가 한다(findInPage/stopFindInPage 와 found-in-page 이벤트).
//   #wv-find 아래의 DOM(web/index.html)과 그 CSS(web/css/18-browser.css).
//
// 유지 조건
//   찾기는 호스트가 직접 구현하지 않는다. webview 는 별도 프로세스라 호스트에서 DOM 을 탐색할 수 없고,
//   접근하더라도 다른 페이지를 수정하는 일이 된다. guest 의 기능을 그대로 쓴다.
//   막대를 닫을 때 stopFindInPage("clearSelection") 를 반드시 부른다. 부르지 않으면 노란 강조가
//   페이지에 그대로 남고, 그 페이지를 스크롤·클릭해도 안 없어진다.
//   탭을 옮기거나 페이지가 새로 뜨면 이전 탭의 강조를 지우고 개수를 0 으로 되돌린다. 그러지 않으면
//   "3/17" 이 다른 페이지 위에 남아 잘못된 값을 표시한다.
//
// 영향 범위
//   web/index.html 의 #wv-find 블록, web/css/18-browser.css, core/keynav 의 ⌘F 가로채기,
//   browser/dock 의 ac-shortcut 표(webview 포커스에서 온 ⌘F), native/electron/main-window.cjs
//   의 중계.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/find-in-page.js
// ⌘F 를 이 기능이 가져갈 상황인가. 순수 판정이라 DOM 없이 부를 수 있고, 검사가 이 함수를 그대로
// 부른다. 조합을 소스 모양으로만 확인하면 조건 하나가 뒤집혀도 검사가 통과한다.
// Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있어 둘 다 받는다(이 저장소의 규약).
export function shouldTakeFindKey(ev) {
  const e = ev || {};
  // 어느 조합이 찾기인지는 여기서 정하지 않는다. 표(core/keymap)가 정하고 부르는 쪽이 대조해서
  // bound 로 넘긴다. 여기가 소유하는 것은 "그 키를 지금 가져가도 되는가"뿐이다.
  if (!e.bound) return false;
  if (e.inTerminal) return false;          // 터미널의 ⌃F 는 커서 이동이다
  return !!(e.browserWindow || e.browserTabActive);
}

let $, activeWv, bar, input, countEl;
let barOpen = false;
let boundEl = null;      // found-in-page 를 걸어 둔 <webview>
let lastQuery = "";

export function findIsOpen() { return barOpen; }

// 지금 찾기가 성립하는 상황인가. 브라우저 탭이 앞에 있어야 한다. 파일·메모 편집기(Monaco)는
// 자체 찾기를 가지고 있어, 그것을 가로채면 더 나은 기능을 잃는다.
export function findAvailable() {
  return !!activeWv();
}

function setCount(cur, total) {
  if (!countEl) return;
  countEl.textContent = total ? `${cur}/${total}` : (lastQuery ? "0/0" : "");
  countEl.classList.toggle("none", !!lastQuery && !total);
}

// guest 가 개수를 돌려주는 지점. 탭마다 다른 webview 라 탭이 바뀌면 다시 건다.
function bindTo(el) {
  if (boundEl === el) return;
  if (boundEl) { try { boundEl.removeEventListener("found-in-page", onFound); } catch {} }
  boundEl = el;
  if (boundEl) boundEl.addEventListener("found-in-page", onFound);
}

function onFound(e) {
  const r = (e && e.result) || {};
  setCount(r.activeMatchOrdinal || 0, r.matches || 0);
}

// 찾는 중이던 페이지의 강조를 지운다. 탭 전환·페이지 이동·닫기가 모두 여기로 온다.
export function clearFind(el) {
  const target = el || boundEl;
  try { if (target) target.stopFindInPage("clearSelection"); } catch {}
}

function run(query, opts) {
  const rec = activeWv();
  if (!rec) return;
  bindTo(rec.el);
  if (!query) { clearFind(rec.el); setCount(0, 0); return; }
  try { rec.el.findInPage(query, opts); } catch {}
}

export function openFind() {
  if (!findAvailable()) return false;
  barOpen = true;
  bar.hidden = false;
  input.focus();
  input.select();
  // 크롬처럼, 열려 있는 상태에서 다시 ⌘F 를 누르면 지금 글자를 고르기만 하고 다시 찾지 않는다.
  if (input.value) { lastQuery = input.value; run(lastQuery, { findNext: false }); }
  return true;
}

export function closeFind() {
  if (!barOpen) return;
  barOpen = false;
  bar.hidden = true;
  clearFind();
  setCount(0, 0);
  // 닫으면 페이지로 포커스를 돌린다. 막대에 포커스를 두면 다음 키가 페이지로 가지 않는다.
  try { const rec = activeWv(); if (rec) rec.el.focus(); } catch {}
}

export function findNext(forward) {
  if (!barOpen || !lastQuery) return;
  run(lastQuery, { findNext: true, forward: forward !== false });
}

// 탭이 바뀌었다. 이전 탭의 강조를 지우고 개수를 되돌린다. 막대는 열어 둔 채 새 탭에서 이어 찾는다.
export function findRetarget() {
  if (boundEl) clearFind(boundEl);
  bindTo(null);
  setCount(0, 0);
  if (barOpen && !findAvailable()) closeFind();
  else if (barOpen && lastQuery) run(lastQuery, { findNext: false });
}

export function initFindInPage(deps) {
  ({ $, activeWv } = deps);
  bar = $("#wv-find");
  input = $("#wv-find-q");
  countEl = $("#wv-find-count");
  input.addEventListener("input", () => {
    lastQuery = input.value;
    run(lastQuery, { findNext: false });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); findNext(!e.shiftKey); }
  });
  $("#wv-find-prev").addEventListener("click", () => findNext(false));
  $("#wv-find-next").addEventListener("click", () => findNext(true));
  $("#wv-find-close").addEventListener("click", () => closeFind());
}
