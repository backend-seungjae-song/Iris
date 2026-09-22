// 브라우저 주소줄의 "닫은 탭" 목록. 최근에 닫은 것을 골라 복원한다.
//
// 소유 범위
//   #wv-closed 칩이 여는 드롭다운의 렌더와 열림·닫힘, 그리고 고른 항목을 복원하는 호출.
//
// 제공 API
//   initCapability(ctx). 이 기능의 진입점으로 자기 listener 를 직접 건다(앱 셸이 부르는 이름은 없다).
//   initClosedTabsMenu(deps) · closedMenuMarkup(list). 렌더만 담당하며, 검사와 사본이 같은 함수를 부른다.
//
// 의존 대상
//   목록과 복원은 center/closed-tabs 가 소유하므로, 여기서 스택을 다시 만들지 않는다.
//
// 유지 조건
//   이 파일을 앱 셸이 정적으로 import 하면 "끈 기능은 로드되지 않는다"가 깨진다.
//   ⌘⇧T 는 이 기능의 것이 아니다. 앱 셸(center/closed-tabs)의 스택이 가지므로, 이 목록을
//   꺼도 맨 위 하나를 복원하는 경로는 남는다. 이 목록은 그 아래 것을 고르기 위한 것이다.
//   본 창과 분리 브라우저 창 둘 다에서 동작한다. #wv-closed 칩이 두 창에 다 있다.
//   이 목록은 설정 화면에서 브라우저로 옮겨 온 것이다.
//   ⌘⇧T 는 그대로 맨 위 하나를 복원한다. 이 목록은 그 아래 것을 고르기 위한 것이다.
//   고른 것을 복원해야 한다. 여기서 맨 위를 열면 선택을 무시하는 것이 된다.
//
// 영향 범위
//   web/index.html 의 #wv-closed 칩, web/css/24-closed-tabs.css 의 wvc-* 이름,
//   center/closed-tabs 의 목록·복원.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/closed-tabs-menu.js

let getList = null, reopen = null, menuEl = null;

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function closedMenuMarkup(list) {
  const esc = escapeHtml;
  const rows = (list || []).slice(0, 12);
  if (!rows.length) return `<div class="wvc-empty">되살릴 닫힌 탭이 없습니다.</div>`;
  return `<div class="wvc-h">최근 닫은 탭<span class="wvc-key">⌘⇧T</span></div>`
    + rows.map((t) => {
      const name = t.title || t.label || t.url || t.path || "(제목 없음)";
      const key = t.kind === "center" ? (t.path || "") : (t.tabId || "");
      return `<button class="wvc-row" data-closed-kind="${esc(t.kind)}" data-closed-key="${esc(key)}"
        title="${esc(t.url || t.path || "")}">
        <span class="wvc-kind">${t.kind === "center" ? "파일" : "탭"}</span>
        <span class="wvc-name">${esc(name)}</span></button>`;
    }).join("");
}

function close() { if (menuEl) { menuEl.remove(); menuEl = null; } }

function open(anchor) {
  close();
  const el = document.createElement("div");
  el.className = "wvc-menu";
  el.id = "wv-closed-menu";
  el.innerHTML = closedMenuMarkup(getList ? getList() : []);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.round(Math.min(r.left, window.innerWidth - 320)) + "px";
  el.style.top = Math.round(r.bottom + 6) + "px";
  document.body.appendChild(el);
  menuEl = el;
}

export function initClosedTabsMenu(deps) {
  getList = deps.closedTabsForView;
  reopen = deps.reopenClosedTab;
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#wv-closed");
    if (chip) { menuEl ? close() : open(chip); return; }
    const row = e.target.closest("[data-closed-kind]");
    if (row) {
      reopen && reopen(row.dataset.closedKind, row.dataset.closedKey);
      close();
      return;
    }
    if (menuEl && !e.target.closest("#wv-closed-menu")) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }, true);
}

// 이 기능의 연결. 표에는 선언만 두고 연결 방법은 각 기능이 가진다.
export function initCapability(ctx) {
  initClosedTabsMenu({
    closedTabsForView: ctx.closedTabsForView,
    reopenClosedTab: ctx.reopenClosedTab,
  });
  return {};
}
