// 이 뷰어가 맡는 파일 종류: 확장자와 읽는 방법을 소유한다.
//
// 소유 범위
//   .docx 와 .xlsx·.xlsm·.csv·.tsv·.tab 의 판정, 글자 표현이 있는 형식(csv·tsv·tab),
//   어느 칸이 비어 있으면 아직 못 받은 것인가,
//   docx 읽기 요청의 세대 번호, 그리고 「모두 취소」가 무엇을 다시 읽어야 하는가.
//
// 제공 API
//   registerViewerKinds() 는 등록표에 두 줄을 추가한다. SHEET_TEXT_RE 는 sheet 모듈들이 쓴다.
//
// 의존 대상
//   core/file-kinds.js 하나. DOM 을 보지 않는다.
//
// 설계 이유
//   이 세 정규식이 center/file-routing.js 에 있으면 앱 셸의 네 파일이 그것을 import 하게 된다.
//   그러면 앱 셸이 "xlsx 는 표다"를 알게 되어, 표 뷰어를 꺼도 그 판정이 남는다.
//
// 유지 조건
//   docx 를 sheet 보다 먼저 등록한다. 등록 순서가 판정 순서를 정한다.
//   docx 의 test 는 탭이 있으면 탭의 docxMode 를 먼저 본다. requestFileContent 와 같은 순서다.
//   세대 번호는 요청마다 하나씩 올라가야 한다. 같은 번호가 두 번 나가면 늦게 온 응답이
//   먼저 온 것을 덮는다.
//
// 영향 범위
//   viewer/boot.js 가 부르고, sheet/{viewer,render,actions} 가 SHEET_TEXT_RE 를 쓴다.
//   현재 목록 확인: node bin/importers.mjs web/js/viewer/kinds.js

import { registerFileKind } from "../core/file-kinds.js";

export const DOCX_RE = /\.docx$/i;
export const SHEET_RE = /\.(xlsx|xlsm|csv|tsv|tab)$/i;
export const SHEET_TEXT_RE = /\.(csv|tsv|tab)$/i;

let docxRequestGenerationSeq = 0;

export function registerViewerKinds() {
  registerFileKind({
    id: "docx",
    test: (path, tab) => (tab ? !!tab.docxMode : DOCX_RE.test(path)),
    tabKind: "docx",
    tabFlags: { docxMode: true },
    docIcon: "📝",
    docLabel: "문서",
    tabFields: () => ({
      docxMode: false, docxData: null, docxError: null, docxGeneration: 0, docxEditor: null,
      docxRevision: null, docxHandleRevision: null, docxDiskData: null, docxDiskRevision: null,
      docxDirty: false, docxChromeCleanups: null,
    }),
    textForm: () => false,
    read: (path, tab) => {
      const docxGeneration = ++docxRequestGenerationSeq;
      if (tab) tab.docxGeneration = docxGeneration;
      return { type: "docx.read", path, docxGeneration };
    },
    // 문서는 텍스트로 되돌린다. 표처럼 따로 읽을 데이터가 없다.
    discardReads: () => ({ text: true, data: false }),
    pending: (tab) => !!tab && tab.docxData == null && tab.docxError == null,
  });

  registerFileKind({
    id: "sheet",
    test: (path, tab) => !(tab && tab.docxMode) && SHEET_RE.test(path),
    tabKind: "file",
    tabFlags: { sheetMode: true },
    docIcon: "📊",
    docLabel: "스프레드시트",
    tabFields: () => ({ sheetMode: false, sheet: null }),
    textForm: (path) => SHEET_TEXT_RE.test(path),
    read: (path) => ({ type: "sheet.read", path }),
    // csv·tsv 는 같은 파일을 텍스트로도 본다. 둘 다 다시 읽어야 어느 쪽을 보고 있든 맞는다.
    discardReads: (path) => ({ text: SHEET_TEXT_RE.test(path), data: true }),
    // 표를 텍스트로 전환해 보고 있으면 비어 있는 필드가 다르다.
    pending: (tab) => (!!tab && (tab.sheetMode
      ? (tab.sheet == null && tab.sheetError == null)
      : tab.content == null)),
  });
}
