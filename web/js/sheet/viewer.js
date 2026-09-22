// 표 viewer 조립: 이미 분리된 sheet 계층을 원래 순서로 초기화한다.
//
// 소유 범위
//   model → formula → conditional → render → edit → actions → events 초기화 순서와 각 계층의
//   core·center·docx 의존성 조립. 표 상태·판정·렌더·편집 로직은 소유하지 않는다.
//
// 제공 API
//   initSheetViewer(deps): main의 기존 표 뷰어 시작점에서 한 번 호출하는 조립 경계.
//
// 의존 대상
//   sheet의 일곱 소유 모듈과 center·docx·explorer 도메인 API는 직접 import한다.
//   main이 소유하는 $·esc·fileview·docxview·filePathBarHtml·showToast·showNotice·wsSend·acHost와
//   isFileLikeKind만 init에서 받는다.
//
// 유지 조건
//   edit의 fill listener가 events의 sheet/document listener보다 먼저 등록되는 기존 순서와,
//   render의 등록 콜백이 edit/actions init에서 채워진 뒤 실제 사용자 입력이 시작되는 phase를 유지한다.
//
// 영향 범위
//   main의 표 뷰어 init 위치와 core 주입 계약,
//   sheet/{model,formula,conditional,render,edit,actions,events}, center/{tabs,tab-close,text-editor,
//   file-routing,file-palette}, docx/editor, explorer/context-menu의 초기화·호출 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/sheet/viewer.js

import {
  docxApplyHyperlink, docxMoveMatch, docxOpenMenu, docxRefreshChrome,
  docxReplaceAllMatches, docxReplaceMatch, docxShowFind, docxShowLinkEditor,
} from "../docx/editor.js";
import { askText } from "../explorer/context-menu.js";
import { openFilePalette } from "../center/file-palette.js";
import { SHEET_TEXT_RE } from "../viewer/kinds.js";
import { removeTabsNow } from "../center/tab-close.js";
import { requestFileContent, sendTabIo, withFileViewTransition } from "../center/tabs.js";
import { markTabDirty } from "../center/text-editor.js";
import { initSheetActions } from "./actions.js";
import { initSheetConditional } from "./conditional.js";
import { initSheetEdit, svTabDirty } from "./edit.js";
import { initSheetEvents } from "./events.js";
import { initSheetFormula } from "./formula.js";
import { initSheetMode, switchSheetMode } from "./mode.js";
import { initSheetModel } from "./model.js";
import { initSheetRender } from "./render.js";

export function initSheetViewer(deps) {
  const {
    $, acHost, docxview, esc, filePathBarHtml, fileview, isFileLikeKind,
    showNotice, showToast, wsSend,
  } = deps;

  initSheetModel();

  initSheetFormula();

  initSheetConditional();

  initSheetMode({ showToast });

  initSheetRender({
    $, esc, fileview, filePathBarHtml, withFileViewTransition, SHEET_TEXT_RE,
  });

  initSheetEdit({
    $, esc, fileview, isSheetTabDirty: svTabDirty, markTabDirty, requestFileContent, sendTabIo, showToast,
  });

  initSheetActions({
    $, esc, askText, showNotice, showToast, wsSend,
    acHost, docxview,
    isSheetTabDirty: svTabDirty, openFilePalette, removeTabsNow, requestFileContent, sendTabIo, SHEET_TEXT_RE,
  });

  initSheetEvents({
    $, acHost, askText,
    docxApplyHyperlink, docxMoveMatch, docxOpenMenu, docxRefreshChrome,
    docxReplaceAllMatches, docxReplaceMatch, docxShowFind, docxShowLinkEditor,
    docxview, esc, fileview, isFileLikeKind, showToast, switchSheetMode,
  });
}
