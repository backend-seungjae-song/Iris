// 사이드바 접기. rail 의 ⇤ 버튼이 부른다.
//
// 제공 API
//   toggleSidebar(): desktop 은 body.sidebar-collapsed, 820px 이하는 #sidebar.mobile-open 을 뒤집는다.
//
// 의존 대상
//   index.html 의 #sidebar 와 body CSS 계약. 칸 높이·폭 조절은 core/layout-engine.js 가 맡는다.
//
// 영향 범위
//   devtool/rail.js 의 sidebar 토글 콜백.

const $ = (sel) => document.querySelector(sel);

// 사이드바 토글: rail 라인의 ⇤ 버튼이 호출. body.sidebar-collapsed가 sidebar·sc·acct 패널 모두 제어.
export function toggleSidebar() {
  const sb = $("#sidebar");
  if (window.innerWidth <= 820) { sb.classList.toggle("mobile-open"); return; }
  document.body.classList.toggle("sidebar-collapsed"); // CSS가 현재 표시 중인 좌측 패널(어느 것이든)을 접는다
}
