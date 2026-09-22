// 패널 layout: 좌측 3패널의 세로 높이와 sidebar 접힘을 다룬다.
//
// 소유 범위
//   file-tree/space-list 높이 저장 키와 .v-resizer drag 연결, sidebar 접힘 class 전환.
//
// 제공 API
//   initLayout({ $ }): 저장된 높이를 복원하고 resizer를 연결한다. main 이 한 번 부른다.
//   toggleSidebar(): rail의 sidebar 버튼이 부르는 desktop/mobile 접기 전환.
//
// 의존 대상
//   $를 init 에서 주입받고, index.html의 #sidebar/.v-resizer/data-resize 및 body CSS 계약을 쓴다.
//   드래그 중 덮개는 core/drag-shield.js가 씌운다. 포인터가 iframe·webview 로 넘어가지 않게 한다.
//   localStorage의 ac.fileTreeH/ac.spaceListH가 이 창의 높이 정본이다.
//
// 유지 조건
//   drag 중 높이는 60px 이상, sidebar 높이보다 160px 작은 값 이하이며 mouseup 때만 저장한다.
//   document 에 직접 mousemove 를 걸지 않는다. 덮개 없이 걸면 iframe 위에서 드래그가 끊긴다.
//   820px 이하에서는 body 접힘 대신 #sidebar.mobile-open만 뒤집는다.
//
// 영향 범위
//   devtool/rail.js의 sidebar 토글 콜백과 web/index.html의 sidebar/resizer DOM·CSS.

import { beginDrag } from "../core/drag-shield.js";

let dom = null;

export function initLayout(deps) {
  dom = deps.$;
  // ── 좌측 3패널(Explorer/Spaces/Agents) 세로 높이 조절: 각 구분선이 위 패널의 body 높이 조절 ──
  const sidebarEl = dom("#sidebar");
  const RESIZE_KEY = { "file-tree": "ac.fileTreeH", "space-list": "ac.spaceListH" };
  for (const [id, key] of Object.entries(RESIZE_KEY)) { const saved = localStorage.getItem(key); if (saved) dom("#" + id).style.height = saved; }
  document.querySelectorAll(".v-resizer").forEach((rz) => {
    const targetId = rz.dataset.resize, target = dom("#" + targetId), key = RESIZE_KEY[targetId];
    rz.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY, startH = target.getBoundingClientRect().height;
      beginDrag({
        cursor: "row-resize",
        onMove: (ev) => {
          const max = sidebarEl.getBoundingClientRect().height - 160;
          target.style.height = Math.max(60, Math.min(max, startH + (ev.clientY - startY))) + "px";
        },
        onEnd: () => { if (key) localStorage.setItem(key, target.style.height); },
      });
    });
  });
}

// 사이드바 토글: rail 라인의 ⇤ 버튼이 호출. body.sidebar-collapsed가 sidebar·sc·acct 패널 모두 제어.
export function toggleSidebar() {
  const sb = dom("#sidebar");
  if (window.innerWidth <= 820) { sb.classList.toggle("mobile-open"); return; }
  document.body.classList.toggle("sidebar-collapsed"); // CSS가 현재 표시 중인 좌측 패널(어느 것이든)을 접는다
}
