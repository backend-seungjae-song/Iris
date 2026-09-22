// 끌어서 순서 바꾸기. 탭바와 북마크바가 같은 규칙으로 사용한다.
//
// 소유 범위
//   없다. 상태를 두지 않고 넘겨받은 컨테이너에 리스너만 등록한다.
//   같은 컨테이너에 두 번 등록되지 않게 컨테이너 자신에 표시를 남긴다.
//
// 제공 API
//   wireReorder(container, sel, keyOf, send): 한 번 호출하면 그 컨테이너가 끌기를 받는다.
//
// 의존 대상
//   DOM 이벤트만 사용한다. 어떤 모듈도 import 하지 않는다.
//
// 유지 조건
//   서버에는 인덱스가 아니라 "어느 항목 앞"으로 보낸다. 인덱스로 보내면 그 사이 목록이
//   바뀌었을 때 다른 자리로 이동한다. 마지막 항목의 오른쪽은 before=null 이다.
//
// 영향 범위
//   외부를 참조하지 않는다. 이 시그니처를 바꾸면 호출하는 쪽도 함께 바꿔야 한다.
//   현재 목록 확인: node bin/importers.mjs web/js/core/reorder.js

// 탭·북마크 순서 바꾸기. 규칙은 끌어서 어느 항목의 왼쪽·오른쪽에 놓느냐 하나다. 서버에는 인덱스가
// 아니라 "어느 항목 앞"으로 보낸다(그 사이 목록이 바뀌어도 의도가 유지된다).
export function wireReorder(container, sel, keyOf, send) {
  if (!container || container.__reorder) return;
  container.__reorder = true;
  let src = null;
  const clear = () => container.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  container.addEventListener("dragstart", (e) => {
    const el = e.target.closest(sel); if (!el) return;
    src = el; el.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", keyOf(el)); } catch {}
  });
  container.addEventListener("dragend", () => { if (src) src.classList.remove("dragging"); src = null; clear(); });
  container.addEventListener("dragover", (e) => {
    const el = e.target.closest(sel); if (!el || !src || el === src) return;
    e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch {}
    const r = el.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    clear(); el.classList.add(after ? "drop-after" : "drop-before");
  });
  container.addEventListener("drop", (e) => {
    const el = e.target.closest(sel); if (!el || !src || el === src) { clear(); return; }
    e.preventDefault();
    const r = el.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    // 오른쪽에 놓으면 "그 다음 항목 앞"이다. 마지막 항목의 오른쪽이면 맨 끝(before=null).
    let before = keyOf(el);
    if (after) { const nx = el.nextElementSibling && el.nextElementSibling.closest(sel); before = nx ? keyOf(nx) : null; }
    const moved = keyOf(src);
    clear(); src.classList.remove("dragging"); src = null;
    if (before !== moved) send(moved, before);
  });
}