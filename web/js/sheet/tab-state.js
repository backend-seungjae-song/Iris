// 표 탭이 갖는 상태: 스냅숏 생성·비교, 디스크로 되돌리기, 탭이 사라질 때 정리.
//
// 소유 범위
//   한 탭에 붙은 표 상태(_sv* 열셋과 sheet·sheetError)를 다루는 네 동작:
//   스냅숏 · 스냅숏 비교 · 되돌린 뒤 초기화 · 탭이 사라질 때 정리. 그리고 경로가 바뀔 때의 따라가기.
//
// 제공 API
//   svDiscardSnapshot(t) · svSameDiscardSnapshot(a, b) · svResetAfterDiscard(t, staged)
//   svTearDownTab(t) · svRetargetTabPath(t, path). 훅 등록은 viewer/boot 이 한다.
//
// 의존 대상
//   dirty 판정은 앱 셸(center/tab-close)에 묻는다. 텍스트 편집까지 함께 봐야 하기 때문이다.
//   기능이 앱 셸을 부르는 것은 허용된 방향이다(반대는 금지). 편집기 닫기는 같은 모듈 집합의 edit.js 가 한다.
//
// 유지 조건
//   이 상태의 소유자는 표 뷰어다. 앱 셸(center/tab-close)이 열세 개를 직접 되돌리면, 새
//   뷰어를 추가할 때마다 앱 셸의 되돌리기도 함께 고쳐야 한다. 상태를 추가하면 여기만 고친다.
//   스냅숏은 그 사이에 사용자가 더 편집했는지 판정하는 값이다. 값을 그대로 담지 말고 비교 가능한
//   형태(정렬된 키·세대·좌표)로 담는다. Map 을 그대로 담으면 같은 내용도 매번 다르게 비교된다.
//   인라인 편집기(_svEd)는 객체 동일성으로 비교한다. 값이 같아도 다른 편집기면 다른 상태다.
//   비교가 불확정을 돌려주면 부르는 쪽이 같다고 판단한다. 그래서 여기서는 항상 boolean 을 돌려준다.
//
// 영향 범위
//   web/js/viewer/boot.js 의 훅 등록, web/js/center/tab-close.js 의 되돌리기·닫기 경로,
//   web/js/sheet/edit.js 의 _svEd, web/js/sheet/model.js 의 _svDirty·_svBase.
//   현재 목록 확인: node bin/importers.mjs web/js/sheet/tab-state.js

import { isTabDirty } from "../center/tab-close.js";
import { svCloseEdit, svCloseFormulaEdit } from "./edit.js";

// 지금 이 탭의 표 상태를 비교 가능한 형태로 만든다. 되돌리기가 서버 답을 기다리는 동안 사용자가 더
// 편집했는지 판정하는 데 쓴다. 편집이 있었으면 그 되돌리기는 최신이 아니므로 버린다.
export function svDiscardSnapshot(t) {
  const editor = (t && t._svEd) || null;
  const dirtyEntries = [...((t && t._svDirty) || new Map()).entries()];
  const layoutEntries = Object.entries((t && t._svLayout) || {});
  const mergeEntries = [...((t && t._svMergeEdit) || new Map()).entries()];
  return {
    editor,
    editorValue: editor && editor.el ? editor.el.value : null,
    dirtyKeys: dirtyEntries.map(([key]) => key).sort(),
    dirtyState: dirtyEntries.map(([key, entry]) => [key, entry && entry.generation, entry && entry.r, entry && entry.c, !!(entry && entry.style)]).sort(),
    layoutKeys: layoutEntries.map(([key]) => key).sort(),
    layoutState: layoutEntries.map(([key, entry]) => [key, entry && entry.generation, entry && entry.px]).sort(),
    mergeKeys: mergeEntries.map(([key]) => key).sort(),
    mergeState: mergeEntries.map(([key, entry]) => [key, entry && entry.generation, JSON.stringify((entry && entry.ranges) || [])]).sort(),
    sheetMode: !!(t && t.sheetMode),
    svSaving: (t && t._svSaving) || null,
  };
}

export function svSameDiscardSnapshot(a, b) {
  if (!a || !b) return false;
  const sameKeys = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);
  return a.editor === b.editor
    && a.editorValue === b.editorValue
    && sameKeys(a.dirtyKeys, b.dirtyKeys)
    && JSON.stringify(a.dirtyState) === JSON.stringify(b.dirtyState)
    && sameKeys(a.layoutKeys, b.layoutKeys)
    && JSON.stringify(a.layoutState) === JSON.stringify(b.layoutState)
    && sameKeys(a.mergeKeys, b.mergeKeys)
    && JSON.stringify(a.mergeState) === JSON.stringify(b.mergeState)
    && a.sheetMode === b.sheetMode
    && a.svSaving === b.svSaving;
}

// 디스크 내용으로 되돌린 직후. 표가 갖고 있던 편집·되돌리기 기록·화면 상태를 전부 비운다.
// 남기면 방금 되돌린 내용 위에 이전 편집이 다시 적용된다.
export function svResetAfterDiscard(t, staged) {
  if (!t) return;
  t.sheet = staged && staged.sheet !== undefined ? staged.sheet : null;
  t._svDirty = new Map();
  t._svBase = new Map();
  t._svLayout = {};
  t._svMergeEdit = new Map();
  t._svUndo = [];
  t._svRedo = [];
  t._svSaving = false;
  t.sheetError = null;
  t._svCalced = false;
  t._svMerge = null;
  t._svFreeze = null;
  t._svShown = 0;
}

// 탭이 목록에서 사라질 때. 열려 있던 인라인 편집기는 화면에서 제거한다. 제거하지 않으면 탭은 없는데
// 입력칸만 화면에 남는다.
export function svTearDownTab(t) {
  if (!t || !t._svEd) return;
  const editor = t._svEd;
  t._svEd = null;
  if (editor.el && editor.el.parentNode) editor.el.parentNode.removeChild(editor.el);
}

// 파일이 옮겨졌을 때. 저장이 날아가는 중이면 그 저장도 새 경로를 보게 한다.
export function svRetargetTabPath(t, path) {
  if (t && t._svSaving) t._svSaving.path = path;
}

// 밖에서 파일이 바뀌어 새로 읽어 온 내용을 이 탭에 반영한다. 저장하지 않은 편집이 있으면 반영하지 않는다.
// 이 함수가 다루는 상태가 전부 표의 것이므로 여기에 둔다.
// 부르는 쪽은 뷰어 하나뿐이라 훅을 두지 않고 그대로 내보낸다.
export function svApplyResponseData(t, data) {
  if (isTabDirty(t)) return false;
  // 현재 입력의 기준은 아직 화면에 보이는 이전 snapshot이다. 새 data를 먼저 꽂고 blur/commit하면
  // 사용자가 입력하지 않았어도 외부에서 달라진 값을 사용자 수정으로 기록해 dirty가 된다.
  svCloseEdit(t, false);
  svCloseFormulaEdit(t, false);
  const keep = t.sheet && t.sheet.sheets[t.sheetIdx || 0];
  t.sheet = data;
  t._svCalced = false;
  data.sheets.forEach((sheet) => { delete sheet._cfi; });
  t._svUndo = []; t._svRedo = []; t._svLayout = {}; t._svBase = new Map();
  if (keep) {
    const i = data.sheets.findIndex((sheet) => sheet.name === keep.name);
    t.sheetIdx = i >= 0 ? i : 0;
  } else t.sheetIdx = 0;
  return true;
}
