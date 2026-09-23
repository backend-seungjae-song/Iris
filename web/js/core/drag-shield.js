// 끌기 덮개. 마우스로 끄는 동안 창 전체를 투명한 레이어로 덮어 포인터 이벤트를 이 문서에 고정한다.
//
// 소유 범위
//   끌기 한 회차의 상태(덮개 요소·이전 userSelect·콜백)와 document 에 등록한 mousemove/mouseup.
//
// 제공 API
//   beginDrag({ cursor, onMove, onEnd }): 덮개를 씌우고 끌기를 시작한다. mousedown 처리에서 호출한다.
//   endDrag(): 현재 회차를 끝낸다. 보통 mouseup 이 호출한다.
//   isDragging(): 회차가 열려 있는지 반환한다.
//
// 의존 대상
//   document.body 와 .drag-shield(web/css/01-base.css) 뿐이다. 어느 화면도 import 하지 않는다.
//
// 배경
//   <iframe>(메모랩)과 <webview>(서버·브라우저)는 마우스 이벤트를 자체 처리한다. 덮개 없이 끌면
//   포인터가 그 위로 들어가는 순간 이 문서의 mousemove 가 끊기고, 그 안에서 버튼을 놓으면
//   mouseup 도 전달되지 않는다. 그 결과 끌기가 끝나지 않은 채 남아, 포인터가 다시 이 문서로
//   들어오면 누르지 않은 크기 조절이 계속 따라온다.
//   덮개는 그 두 창을 가려 좌표를 이 문서 안으로 고정한다.
//
// 유지 조건
//   덮개는 mousedown 뒤에 붙이고 끝날 때 반드시 제거한다. 남으면 화면 전체가 클릭을 받지 못한다.
//   버튼이 이미 놓였는데 mouseup 을 놓친 회차는 다음 mousemove(e.buttons === 0)에서 끝낸다.
//   창이 포커스를 잃으면(⌘Tab) 끌기도 끝낸다. 돌아왔을 때 끌기가 이어지면 안 된다.
//
// 영향 범위
//   web/js/core/layout-engine.js(경계 막대 · 편집 모드 끌기)가 호출한다.
//   panel/memo.js 와 panel/touch-drag.js 는 각자 만든 덮개를 계속 사용한다.

let active = null;

export function beginDrag({ cursor, onMove, onEnd } = {}) {
  if (typeof onMove !== "function") return false;
  if (active) endDrag();   // 이전 회차가 끝나지 않은 채 남아 있으면 여기서 정리한다
  const shield = document.createElement("div");
  shield.className = "drag-shield";
  if (cursor) shield.style.cursor = cursor;
  document.body.appendChild(shield);
  active = { shield, onMove, onEnd, prevSelect: document.body.style.userSelect };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onDocMove, true);
  document.addEventListener("mouseup", endDrag, true);
  addEventListener("blur", endDrag);
  return true;
}

function onDocMove(e) {
  const d = active;
  if (!d) return;
  // 버튼은 이미 놓였는데 mouseup 이 오지 않은 회차는 여기서 끝낸다. 그러지 않으면 이후 모든
  // 이동이 끌기로 처리되어 누르지 않은 크기 조절이 따라온다. 확인하는 것은 임의 버튼이 아니라
  // 이 끌기를 시작한 왼쪽 버튼이다. 왼쪽을 놓고 오른쪽을 누른 채 움직이면 buttons 는 0 이 아니다.
  if ((e.buttons & 1) === 0) { endDrag(); return; }
  d.onMove(e);
}

export function endDrag() {
  const d = active;
  if (!d) return;
  active = null;
  document.removeEventListener("mousemove", onDocMove, true);
  document.removeEventListener("mouseup", endDrag, true);
  removeEventListener("blur", endDrag);
  try { d.shield.remove(); } catch {}
  document.body.style.userSelect = d.prevSelect;
  if (typeof d.onEnd === "function") d.onEnd();
}

export function isDragging() { return !!active; }
