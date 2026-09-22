// 표·문서 뷰어: 엑셀·CSV 표와 DOCX 문서를 가운데 탭에서 여는 기능 전체.
//
// 소유 범위
//   sheet 일곱 모듈과 docx 두 모듈의 조립 순서, 그리고 이 기능이 앱 셸에 등록하는 이름들.
//   서버가 보내는 docx · sheet · sheet-saved 세 메시지의 처리도 여기가 소유한다.
//
// 제공 API
//   initCapability(ctx) 는 { ws } 를 돌려준다. 화면(screen)은 없다. 이 기능은 rail 화면이
//   아니라 가운데 탭에 붙는다.
//
// 의존 대상
//   center/* 와 explorer/* 는 앱 셸이므로 직접 import 한다(기능 → 앱 셸 방향은 허용된다).
//   앱 셸이 소유한 DOM·알림·판정($ · fileview · docxview · filePathBarHtml · isFileLikeKind ·
//   showNotice · showToast · wsSend · browserMode)만 ctx 로 받는다.
//
// 설계 이유
//   앱 셸이 이 모듈 집합을 정적으로 import 하면 열다섯 곳이 걸린다. main 이 다섯, center 셋이 아홉,
//   브라우저 지목이 셋이다. 그러면 "표 뷰어를 끈다"가 성립하지 않고(꺼도 4200줄이 로드된다),
//   표 하나를 고치려면 가운데 탭·닫기·텍스트 편집기 파일을 함께 고쳐야 한다. 지금은 앱 셸이 이름만
//   부르고(core/hooks.js), 그 이름을 채우는 것은 로드된 이 기능이다. 로드되지 않았으면 그 훅은
//   아무 일도 하지 않는다. 표 탭 자체가 생기지 않으므로 부를 일도 없다.
//
// 유지 조건
//   여기서 채우는 이름은 전부 "viewer." 로 시작한다. 접두어가 채우는 모듈을 가리킨다.
//   docx 를 bindTabCloseDocx · bindTextEditorDocx 두 이름으로 등록하지 않는다. 그
//   두 이름은 앱 셸에 기능 이름이 박힌 형태라 뷰어가 늘 때마다 bind 도 늘어난다. 그래서
//   같은 훅으로 합쳤다. 나누어 두면 경계가 둘이 되고 어느 쪽에 등록할지가 매번 판단 대상이 된다.
//   조립 순서(model → formula → conditional → render → edit → actions → events)는 sheet/viewer.js
//   가 갖는다. 여기서 그 순서를 다시 적지 않는다.
//
// 영향 범위
//   core/capabilities.js 의 표, core/hooks.js 의 이름들, center/{tabs,tab-close,text-editor},
//   browser/{pick,pick-host}, browser/dock.js 가 이 이름들을 부른다.
//   현재 목록 확인: node bin/importers.mjs web/js/viewer/boot.js

import { provide } from "../core/hooks.js";
import { registerTabView } from "../core/tab-views.js";
import {
  curTabs, fileReloadReason,
  getRenderedFileOwner, renderTabs, sendTabIo, showActiveTab, withFileViewTransition,
} from "../center/tabs.js";
import { askInfo, askText } from "../explorer/context-menu.js";
import { getActiveTabId, getCenterSpace, getTabs, getTabSpaces } from "../center/tab-store.js";
import {
  svApplyResponseData, svDiscardSnapshot, svResetAfterDiscard, svRetargetTabPath,
  svSameDiscardSnapshot, svTearDownTab,
} from "../sheet/tab-state.js";
import { isTabDirty } from "../center/tab-close.js";
import { ensureTabViewPane } from "../center/tabs.js";
import { renderFileViewBody } from "../center/text-editor.js";
import { initDocxPanel } from "../docx/panel.js";
import { docxSaveTab, docxTabDirty, initDocxEditor } from "../docx/editor.js";
import { initSheetViewer } from "../sheet/viewer.js";
import { registerViewerKinds } from "./kinds.js";
import { svClosePopups } from "../sheet/actions.js";
import {
  svCloseEdit, svDirtyKey, svEnterTab, svLeaveTab, svSave, svSaveBtn, svTabDirty,
} from "../sheet/edit.js";
import { colName, svSrcAt } from "../sheet/model.js";
import { renderSheetViewBody, svCellAt, svGridEl, svTab } from "../sheet/render.js";

export function initCapability(ctx) {
  // 이 뷰어가 만드는 가운데 영역을 여기서 먼저 만든다. 앱 셸은 등록표를 보고 만들지만 그
  // 등록이 이 함수 안에서 일어나므로, 앱 셸이 만드는 시점(bootCapabilities 뒤)은 여기보다
  // 늦다. 바로 아래에서 ctx 로 꺼내 쓰므로 그때는 이미 존재해야 한다.
  ensureTabViewPane({ panelId: "docxview" });
  const {
    $, esc, wsSend, showToast, showNotice, browserMode,
    fileview, docxPane, filePathBarHtml, isFileLikeKind, acHost, askConfirm,
  } = ctx;
  // 위에서 만든 영역을 지금 받는다. 안에서는 기존 이름을 그대로 쓴다.
  const docxview = docxPane;

  // 이 뷰어가 무엇을 맡는지부터 적는다. 앱 셸이 이 표를 보고 경로를 정한다.
  registerViewerKinds();

  // docx 탭을 그리는 모듈을 먼저 만든다. 편집기가 그 정리 함수를 인자로 받는다.
  const { cleanupDocxRender, renderDocxPanelBody } = initDocxPanel({
    docxview, esc, filePathBarHtml, showToast,
  });

  initSheetViewer({
    $, acHost, docxview, esc, filePathBarHtml, fileview, isFileLikeKind,
    showNotice, showToast, wsSend,
  });

  initDocxEditor({
    $, esc, askText, askConfirm, askInfo, showToast, filePathBarHtml, sendTabIo,
    cleanupDocxRender, getRenderedFileOwner,
  });

  // docx 탭의 영역과 렌더 함수. 앱 셸은 이 표를 보고 영역을 만들고 이 함수를 부른다.
  // 종류 이름을 앱 셸이 따로 관리하지 않는다. fileLike 는 이 탭이 디스크의 파일 하나를 가리킨다는 뜻이다.
  registerTabView({ kind: "docx", panelId: "docxview", fileLike: true, render: (t, token) => renderDocxPanelBody(t, token) });

  // 앱 셸이 부르는 이름들. 값을 돌려받아 쓰는 경우 부르는 쪽이 대체값을 갖는다.
  provide("viewer.closePopups", () => svClosePopups());
  provide("viewer.closeEdit", (t, flag) => svCloseEdit(t, flag));
  // 그린 쪽이 true 를 돌려준다. 앱 셸은 이 답만 보고 자기 렌더를 멈춘다.
  provide("viewer.renderBody", (t) => {
    if (!(t && t.sheetMode)) return false;
    renderSheetViewBody(t);
    return true;
  });
  provide("viewer.activeSheetTab", () => svTab());
  provide("viewer.colName", (c) => colName(c));
  // 브라우저 요소 지목이 표 셀을 인식하는 경로. 선택자는 표가 갖고, 지목은 이름만 부른다.
  provide("viewer.sheetGrid", () => svGridEl());
  provide("viewer.sheetCellAt", (target) => svCellAt(target));
  // 이 탭의 저장을 누가 맡는지 답한다. undefined 는 이 기능의 것이 아니라는 뜻이고, 그때 앱 셸이 자기
  // 방식으로 저장한다. 텍스트로 보는
  // csv 는 표 모드가 아니므로 여기서도 이 기능의 것이 아니다(기존 동작을 그대로 유지한다).
  provide("viewer.saveTab", (t, space) => {
    if (t && t.sheetMode) return svSave(t, space) || null;
    if (t && t.docxMode) return docxSaveTab(t, space) || null;
    return undefined;
  });
  provide("viewer.cleanupDocxRender", (t) => cleanupDocxRender(t));
  // 픽 모드가 문서 안을 지목하려면 그 화면의 루트를 알아야 한다. 이름(.docx-editor-shell)은
  // 이 기능의 것이라 앱 셸이 직접 찾지 않고 여기에 묻는다. 시트도 같은 방식이다.
  provide("viewer.docxRoot", (host) => (host ? host.querySelector(".docx-editor-shell") : null));
  // 탭 하나가 저장하지 않은 편집을 갖고 있는지 판정한다. 앱 셸이 _sv* 과 docx* 를 직접 읽어 이
  // 판정을 하면, 새 뷰어를 추가할 때마다 앱 셸의 dirty 판정까지 함께 고쳐야 한다.
  // 앱 셸은 존재 여부만 묻고, 무엇을 보는지는 그 뷰어가 소유한다.
  provide("viewer.tabDirty", (t) => svTabDirty(t) || docxTabDirty(t));
  // 되돌리기가 서버 답을 기다리는 동안 사용자가 더 편집했는지 판정한다. 스냅숏 형식과 비교는 뷰어가 소유한다.
  // 앱 셸이 필드 이름을 알면 필드가 늘 때마다 앱 셸도 함께 바뀐다.
  provide("viewer.discardSnapshot", (t) => svDiscardSnapshot(t));
  provide("viewer.sameDiscardSnapshot", (a2, b2) => svSameDiscardSnapshot(a2, b2));
  provide("viewer.resetAfterDiscard", (t, staged) => svResetAfterDiscard(t, staged));
  // 탭이 목록에서 빠질 때와 파일이 옮겨졌을 때 뷰어가 자기 상태를 정리한다.
  provide("viewer.tearDownTab", (t) => svTearDownTab(t));
  // 스페이스 목록에서 사라진 문서 탭을 내릴 때. 저장하지 않은 문서는 파괴하지 않고 분리해 두고,
  // 그 탭은 아직 내리면 안 된다고 true 로 답한다. 무엇이 dirty 이고 무엇을 분리해야 하는지는
  // 그 편집기를 만든 쪽만 안다. 앱 셸(browser/dock.js)이 docxMode·docxEditor·_svEd 를
  // 직접 읽어 정리하면, 뷰어를 고칠 때마다 브라우저 도킹 파일도 함께 고쳐야 한다.
  // 이 기능이 로드되지 않았으면 undefined 가 돌아오고, 그때는 문서 탭 자체가 없으므로 그냥 내리면 된다.
  provide("viewer.dropUnlistedTab", (t) => {
    if (t.docxMode && t.docxEditor && isTabDirty(t)) { t.docxEditor.detach(); return true; }
    cleanupDocxRender(t);
    svTearDownTab(t);
    return false;
  });
  provide("viewer.retargetTabPath", (t, path) => svRetargetTabPath(t, path));
  // 탭이 화면에서 내려가고 올라올 때. 무엇을 유지하고 무엇을 버릴지는 그 편집기를 만든 쪽만 안다.
  // 문서는 저장하지 않은 편집이 있으면 파기하지 않고 분리해 두고(force 면 그래도 정리한다), 표는 아직
  // 그 화면에 붙어 있고 같은 시트일 때만 값을 받아 닫는다.
  provide("viewer.leaveTab", (t, opts) => {
    if (t.docxMode && t.docxEditor && isTabDirty(t) && !(opts && opts.force)) {
      t.docxDirty = true;
      t.docxEditor.detach();
    } else {
      cleanupDocxRender(t);
    }
    svLeaveTab(t);
  });
  provide("viewer.enterTab", (t, opts) => svEnterTab(t, opts));
  // 이 탭을 지금 뷰어가 그리고 있는지 답한다. 앱 셸이 "텍스트로 보는 것만 담는다"를 판정할 때 쓴다.
  provide("viewer.presentsTab", (t) => !!(t && (t.sheetMode || t.docxMode)));
  // 지금 문서 영역이 무엇을 그리고 있는지 답한다. 종류 이름("docx")은 이 뷰어의 것이라 밖에서 관리하지
  // 않는다. 시트는 activeSheetTab 으로 같은 방식을 쓴다.
  // 숨겨져 있으면 없는 것으로 답한다. 그 판정을 부르는 쪽에 두면 화면이 바뀔 때마다 함께 고쳐야 한다.
  provide("viewer.activeDocxTab", () => {
    const t = typeof getRenderedFileOwner === "function" ? getRenderedFileOwner() : null;
    return (t && t.kind === "docx" && docxview && !docxview.hidden) ? t : null;
  });

  return {
    ws: {
      "docx": (m, responseIoEntry) => handleDocxMessage(m, responseIoEntry, { showToast, renderDocxPanelBody }),
      "sheet": (m, responseIoEntry) => handleSheetMessage(m, responseIoEntry, { showToast, browserMode, fileview, docxview }),
      "sheet-saved": (m, responseIoEntry) => handleSheetSavedMessage(m, responseIoEntry, { $, showToast }),
    },
  };
}

function handleDocxMessage(m, responseIoEntry, { showToast, renderDocxPanelBody }) {
  const target = responseIoEntry && responseIoEntry.tabRef;
  const docxGeneration = m.docxGeneration;
  if (!target || !target.docxMode || target.docxGeneration !== docxGeneration) return;
  if (m.error) {
    target.docxError = m.error;
    target.docxData = null;
    showToast(m.error);
  } else if (m.reason === "watch" && (isTabDirty(target) || target._saveInFlight)) {
    target.docxDiskData = m.data;
    target.docxDiskRevision = m.revision;
    if (target.id === getActiveTabId(getCenterSpace())) showActiveTab();
    return;
  } else {
    if (target.docxEditor && target !== getRenderedFileOwner()) {
      target.docxEditor.destroy();
      target.docxEditor = null;
      target.docxHandleRevision = null;
      target.docxDirty = false;
    }
    target.docxError = null;
    target.docxData = m.data;
    target.docxRevision = m.revision;
    target.hasDiskSnapshot = true;
  }
  const owner = responseIoEntry.owner;
  if (owner.space === getCenterSpace() && target.id === getActiveTabId(getCenterSpace())
      && target === getRenderedFileOwner()) {
    withFileViewTransition(target, { expectedOwner: target, expectedToken: target.docxRenderToken,
      forceDocxCleanup: m.reason !== "watch" }, (nextRenderToken) => {
      renderDocxPanelBody(target, nextRenderToken);
    });
  }
}

function handleSheetMessage(m, responseIoEntry, { showToast, browserMode, fileview, docxview }) {
  // 표 파일 응답. 실제 사용자 편집만 보호하고, 변경이 없는 탭은 외부 snapshot으로 즉시 바꾼다.
  const id = "file:" + m.path;
  if (responseIoEntry && responseIoEntry.reason === "discard") return;
  if (m.reason === "watch" || !m.requestId) fileReloadReason.delete(m.path);
  let touched = false;
  for (const sp of getTabSpaces()) {
    const t = getTabs(sp).find((x) => x.id === id); if (!t) continue;
    touched = true;
    if (m.error) { t.sheetError = m.error; t.sheet = null; }
    else {
      t.hasDiskSnapshot = true;
      t.sheetError = null;
      // 저장하지 않은 편집이 있으면 덮지 않는다. 변경이 없으면 보던 시트는 유지하되 즉시 새 snapshot 으로 바꾼다.
      if (!svApplyResponseData(t, m.data)) {
        showToast("이 파일이 밖에서 바뀌었습니다. 내 고침이 남아 있어 그대로 두었습니다");
        continue;
      }
    }
  }
  if (touched && curTabs().some((x) => x.id === id && x.id === getActiveTabId(getCenterSpace()))) {
    // showActiveTab()은 분리창(browserMode)에서 그냥 return하는 no-op다(주석: "분리창은
    // browserview를 항상 표시"). 분리 상태(sbState.docked=false)의 사용자가 실제로 보는
    // 창이 바로 이 창이라, 응답이 도착해 t.sheet가 채워져도 화면은 그 순간 이미 그려 둔
    // "불러오는 중…"에서 바뀌지 않는다(재현: t.sheet는 있는데 DOM에 #sv-grid가
    // 없음). 다른 탭에 갔다 오면 표시되던 것도 같은 원인이다. 탭을
    // 전환하면 sbState 브로드캐스트(bsMutate)가 reconcileDocTabs()를 다시 돌려
    // renderedFileOwner가 이 탭이 아니게 됐다가 되돌아올 때 그 함수의 직접 렌더 호출로
    // 렌더가 일어난 것뿐이다. docx 응답 핸들러는 showActiveTab을 쓰지 않고 직접
    // withFileViewTransition을 불러 이 문제가 없다. docx는 즉시 표시되는 것으로
    // 확인했다. 같은 직접 호출 방식을 sheet에도 적용한다.
    if (browserMode) {
      const activeTab = curTabs().find((x) => x.id === id);
      if (activeTab) withFileViewTransition(activeTab, {}, (renderToken) => {
        fileview.hidden = activeTab.kind !== "file";
        docxview.hidden = activeTab.kind !== "docx";
        renderFileViewBody(activeTab, renderToken);
      });
    } else showActiveTab();
  }
}

function handleSheetSavedMessage(m, responseIoEntry, { $, showToast }) {
  for (const t of [responseIoEntry && responseIoEntry.tabRef]) {
    const saving = t && t._svSaving;
    if (!saving || saving.requestId !== m.requestId) continue;
    if (m.error) {
      continue;
    }
    t.hasDiskSnapshot = true;
    const snapshot = saving.snapshot;
    if (t._svSaving !== saving) continue;
    t._svSaving = null;
    for (const [key, generation] of snapshot.dirty) {
      const entry = t._svDirty && t._svDirty.get(key);
      if (entry && entry.generation === generation) {
        t._svDirty.delete(key);
        // 방금 저장한 값이 새 기준이다. 그렇지 않으면 다음에 이 셀을 고쳤다 저장 전 값으로
        // 되돌려도 (더 이전) 기준과 비교해 여전히 dirty로 남는다.
        if (t._svBase && !entry.style) {
          const si = Number(key.split("|")[0]);
          const sh = t.sheet && t.sheet.sheets[si];
          if (sh) t._svBase.set(key, svSrcAt(sh, entry.r, entry.c));
        }
      }
    }
    for (const [key, generation] of snapshot.layout) {
      const entry = t._svLayout && t._svLayout[key];
      if (entry && entry.generation === generation) delete t._svLayout[key];
    }
    for (const [key, generation] of snapshot.merge) {
      const entry = t._svMergeEdit && t._svMergeEdit.get(key);
      if (entry && entry.generation === generation) t._svMergeEdit.delete(key);
    }
    if (t === getTabs(getCenterSpace()).find((tab) => tab.id === getActiveTabId(getCenterSpace()))) {
      document.querySelectorAll("#sv-grid td.sv-c").forEach((cell) => {
        cell.classList.toggle("sv-dirty", !!(t._svDirty && t._svDirty.has(svDirtyKey(t, +cell.dataset.r, +cell.dataset.c))));
      });
      svSaveBtn(t);
      const note = $("#sv-note"); if (note) { note.textContent = `저장했습니다 (${m.saved}칸)`; setTimeout(() => { if (note.isConnected) note.textContent = ""; }, 2500); }
    }
    renderTabs();
  }
  if (m.error && !m.requestId) showToast("저장 실패: " + m.error);
}
