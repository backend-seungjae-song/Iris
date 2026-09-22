// 가운데 탭의 종류마다 어느 화면이 뜨고 무엇이 그리는가. 각 기능이 스스로 등록하는 표다.
//
// 소유 범위
//   등록된 종류의 목록과 그 순서. 종류 하나당 화면 element id · 파일처럼 다루는가 · 그리는 함수.
//
// 제공 API
//   registerTabView(spec) · tabViews() · tabViewOf(kind) · tabViewKinds() ·
//   isFileLikeTabKind(kind) · clearTabViews().
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 호출된다.
//   화면 element 를 실제로 찾는 것은 호출하는 쪽(앱 셸)이다.
//
// 배경
//   앱 셸이 종류 이름을 나열하고 있었다. center/tabs 의 showActiveTab 과 browser/dock 이
//   각각 "docx 면 이 화면, diff 면 저 화면"을 적었고, main 이 "파일처럼 다루는 종류"를
//   따로 나열했다. 그래서 새 화면 하나를 추가하려면 앱 셸 세 파일을 함께 고쳐야 했고, 두 사람이
//   각자 화면을 하나씩 추가하면 그 세 자리에서 충돌했다. 이제 추가하는 쪽이 한 줄을 등록한다.
//
// 유지 조건
//   같은 종류를 두 기능이 등록하면 나중 것이 덮어쓰므로, 먼저 등록된 것을 유지하고 오류를
//   남기며 거절한다. "file" 과 "browser" 는 앱 셸의 것이라 여기 등록하지 않는다.
//   fileLike 는 이 탭이 디스크의 파일 하나를 가리키는지를 뜻한다. 그 값이 파일 감시·저장·복원·
//   닫기 확인에서 이 탭을 파일로 집계할지를 정하며, 화면이 다르다는 것과는 별개의 판정이다.
//
// 영향 범위
//   center/tabs.js 의 showActiveTab · browser/dock.js 의 도킹 렌더 · main 의 isFileLikeKind,
//   그리고 등록하는 쪽(viewer/boot.js · devtool/source-control.js).
//   현재 목록 확인: node bin/importers.mjs web/js/core/tab-views.js

const views = [];

export function registerTabView(spec) {
  if (!spec || !spec.kind || !spec.panelId) {
    try { console.error("[tab-views] 종류와 지면을 다 적어야 한다:", spec); } catch {}
    return false;
  }
  const had = views.find((v) => v.kind === spec.kind);
  if (had) {
    try { console.error("[tab-views] 이미 임자가 있는 종류:", spec.kind); } catch {}
    return false;
  }
  views.push({
    kind: spec.kind,
    panelId: spec.panelId,
    fileLike: !!spec.fileLike,
    render: typeof spec.render === "function" ? spec.render : null,
  });
  return true;
}

export function tabViews() { return views.slice(); }
export function tabViewOf(kind) { return views.find((v) => v.kind === kind) || null; }
export function tabViewKinds() { return views.map((v) => v.kind); }
export function isFileLikeTabKind(kind) { return views.some((v) => v.kind === kind && v.fileLike); }
export function clearTabViews() { views.length = 0; }
