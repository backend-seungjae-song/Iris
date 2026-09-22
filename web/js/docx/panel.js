// docx 탭을 docxview 패널에 그린다. 편집 엔진을 붙이고 떼며, 실패하면 오류 화면으로 수렴시킨다.
//
// 소유 범위
//   docx 탭 하나의 렌더 수명. 편집기 인스턴스와 크롬 정리 목록, 렌더 토큰,
//   그리고 "이 문서는 열기 어렵습니다"로 수렴시키는 실패 경로.
//
// 제공 API
//   initDocxPanel(deps) 하나. cleanupDocxRender·renderDocxContent·renderDocxPanelBody 를 돌려준다.
//   cleanupDocxRender 는 편집기 모듈도 받아 쓰므로 조립부가 그쪽에 넘긴다.
//
// 의존 대상
//   docx/editor.js 의 크롬·툴바·해시 재검사, center 의 탭 소유·dirty 표시,
//   그리고 조립부가 넘겨주는 docxview 요소와 esc·filePathBarHtml·showToast.
//   엔진 자체는 window.__docxEditorCoreReady 로 늦게 오므로 여기서 기다린다.
//
// 유지 조건
//   렌더 토큰과 소유자를 매번 다시 본다. 늦게 도착한 렌더가 이미 다른 탭이 된 화면을 덮으면
//   사람은 자기가 열지 않은 문서를 본다.
//   붙였던 것은 반드시 뗀다. 크롬 정리 목록을 비우지 않으면 탭을 닫아도 리스너가 남는다.
//   손상된 문서의 파싱 실패는 던지지 않고 오류 화면으로 수렴시킨다.
//
// 영향 범위
//   공급자는 web/js/main.js 의 조립부이고, 양방향 소비자는 web/js/docx/editor.js 다.
//   거기가 cleanupDocxRender 를 받아 편집기를 정리한다.
//   현재 목록 확인: node bin/importers.mjs web/js/docx/panel.js

import {
  docxEditorShellHtml, docxHashBytes, docxMaybeAutoformatList,
  docxMenuBarHtml, docxRefreshChrome, docxScheduleHashRecheck, docxShowLinkEditor, docxToolbarHtml,
  docxWireToolbar,
} from "./editor.js";
import { openInSpaceBrowser } from "../center/file-routing.js";
import { isTabDirty } from "../center/tab-close.js";
import { getRenderedFileOwner, getRenderedFileToken } from "../center/tabs.js";
import { markTabDirty, renderFileView } from "../center/text-editor.js";
import { svClosePopups } from "../sheet/actions.js";

export function initDocxPanel({ docxview, esc, filePathBarHtml, showToast }) {
function cleanupDocxRender(t) {
  if (!t || !t.docxMode) return;
  const editor = t.docxEditor;
  t.docxEditor = null;
  t.docxHandleRevision = null;
  const chromeCleanups = t.docxChromeCleanups || [];
  t.docxChromeCleanups = null;
  t.docxRenderToken = null;
  for (const cleanup of chromeCleanups) {
    try { cleanup(); } catch (error) {}
  }
  if (editor) editor.destroy();
}

async function renderDocxContent(t) {
  const docxGeneration = t.docxGeneration;
  const docxRenderToken = t.docxRenderToken;
  const container = docxview.querySelector(".docx-view-root");
  const DocxEditorCore = await window.__docxEditorCoreReady;
  if (t.docxGeneration !== docxGeneration) return;
  if (t.docxRenderToken !== docxRenderToken) return;
  if (t !== getRenderedFileOwner() || docxRenderToken !== getRenderedFileToken() || !container || !container.isConnected) return;
  try {
    const menu = docxview.querySelector(".gd-menu");
    const toolbar = docxview.querySelector(".gd-tb");
    if (menu) menu.innerHTML = docxMenuBarHtml();
    if (toolbar) {
      toolbar.innerHTML = docxToolbarHtml();
      docxWireToolbar(t, toolbar);
    }
    // 마운트/재부착 직후 focus()를 안 부르면 캐럿(깜빡이는 커서)이 사용자가 처음 입력하기 전까지
    // 안 보인다. core의 caret은 네이티브 브라우저 캐럿이 아니라
    // 자체 페인트 오버레이(.caret 엘리먼트, caret-color는 일부러 transparent)라 focus()만으로는
    // 위치가 안 잡힌다. focus()는 레이아웃이 아직 안 끝났으면 InteractionOutcome.ok=false,
    // code="pendingLayout"로 실패하는 API라(core d.ts) 다음 프레임에 몇 번 재시도하고, 성공하면
    // relayout({sync:true})까지 불러야 그 프레임에 캐럿 geometry가 바로 계산된다(확인 결과:
    // relayout 호출 전에는 모든 .caret 엘리먼트가 0×0, 호출 직후 하나가 2×24px 막대로 채워짐.
    // 호출하지 않으면 다음 편집이 relayout을 트리거할 때까지 캐럿이 보이지 않는다. 입력 전까지
    // 포커스 커서가 보이지 않는 증상이 이것이다). 새로 만드는 경로뿐 아니라
    // 기존 editor를 다시 attach() 하는 경로에도 같은 재시도를 건다. 탭을 떠났다 돌아오면
    // 후자를 자주 타므로, 한쪽만 걸면 같은 증상이 남는다.
    // 두 경로 모두 같은 재시도가 필요하다.
    const tryFocusDocxEditor = (ed, attempt) => {
      if (t.docxEditor !== ed || t !== getRenderedFileOwner()) return;
      const outcome = ed.focus();
      if (outcome.ok) { ed.relayout({ sync: true }); return; }
      if (outcome.code === "pendingLayout" && attempt < 5) {
        requestAnimationFrame(() => tryFocusDocxEditor(ed, attempt + 1));
      }
    };
    if (t.docxEditor) {
      t.docxEditor.attach(container);
      t.docxHandleRevision = t.docxEditor.getDocumentHandle().revision;
      docxRefreshChrome(t);
      requestAnimationFrame(() => tryFocusDocxEditor(t.docxEditor, 0));
      return;
    }
    const binary = atob(t.docxData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const editor = DocxEditorCore.createDocxEditor({
      container,
      document: bytes,
      mode: "editing",
    });
    if (t.docxGeneration !== docxGeneration || t.docxRenderToken !== docxRenderToken
        || t !== getRenderedFileOwner() || docxRenderToken !== getRenderedFileToken()) {
      editor.destroy();
      return;
    }
    t.docxEditor = editor;
    t.docxHandleRevision = editor.getDocumentHandle().revision;
    t.docxSavedHash = null; t.docxHashCheckedRevision = null; t.docxHashMatchesSaved = false;
    docxHashBytes(bytes).then((hash) => { if (t.docxEditor === editor) t.docxSavedHash = hash; });
    requestAnimationFrame(() => tryFocusDocxEditor(editor, 0));
    const chromeCleanups = [];
    chromeCleanups.push(editor.setHyperlinkChrome({
      onPopover: (activation) => {
        const href = activation.link?.href;
        if (href != null) openInSpaceBrowser(href);
      },
      onRequest: () => {
        docxShowLinkEditor(t, true);
      },
    }));
    // 손상된 문서의 파싱 실패를 오류 화면으로 수렴시킨다. createDocxEditor()는 동기적으로 throw
    // 하지 않고 파싱은 비동기라(core d.ts 확인, L1) snapshot().parseError로만 드러난다.
    // 이 상태 전환을 알린다고 문서에 적힌 "error" 이벤트는
    // 손상 파일에서 발생하지 않는다(재현: qa-corrupt.docx 에서 parseError는
    // "inflate-error"로 잡히지만 이 콜백이 불리지 않는다). 그러면 사용자에게는 빈 편집기 셸만
    // 비활성 버튼과 함께 남고 "이 문서는 열기 어렵습니다" 오류 화면이 뜨지 않는다. 반드시
    // 발생하는 "change" 이벤트에서도 매번 parseError를 직접 확인해 같은 오류 화면으로 보낸다.
    // "error" 이벤트는 참고용으로만 남기고 이 경로에 의존하지 않는다.
    const docxCheckParseError = () => {
      if (t !== getRenderedFileOwner() || t.docxEditor !== editor) return false;
      const parseError = typeof editor.snapshot === "function" ? editor.snapshot().parseError : null;
      if (!parseError) return false;
      cleanupDocxRender(t);
      t.docxError = "이 문서는 열기 어렵습니다.";
      renderFileView(t, { expectedOwner: t, expectedToken: docxRenderToken });
      return true;
    };
    // core를 향한 어떤 읽기 호출이든(toolbarCommandState()뿐 아니라 snapshot()·getDocumentHandle()도
    // 마찬가지) change/selectionChange 콜백 "안에서" 동기 호출하면, Enter로 문단을 분리한 직후 편집
    // selection이 새 문단으로 넘어가지 않고 분리 전 문단에 멈추는 벤더 결함이 발생한다(직접
    // 확인). toolbarCommandState 하나만 미루는 것으로는 부족하다.
    // docxCheckParseError()가 부르는 snapshot()이 change 핸들러 맨 앞에서 동기로 실행되면
    // 같은 증상이 재현된다. 격리 POC로 snapshot() 단독 호출도
    // 같은 증상을 낸다는 것까지 확인했다. 개별 호출이 아니라 콜백 본문 전체를 queueMicrotask로
    // 현재 호출 스택 밖으로 미룬다. 어떤 read API가 원인인지 하나씩 가려내는 대신, change/
    // selectionChange 디스패치 스택 안에서는 core를 호출하지 않는 것으로 경계를 옮긴다.
    // docxCheckParseError·docxRefreshChrome·docxScheduleHashRecheck는 전부 t.docxEditor 대조로 이미
    // stale-call에 안전하므로 미루는 것만으로 충분하다.
    chromeCleanups.push(editor.on("selectionChange", () => queueMicrotask(() => docxRefreshChrome(t))));
    chromeCleanups.push(editor.on("change", () => queueMicrotask(() => {
      if (docxCheckParseError()) return;
      docxRefreshChrome(t);
      markTabDirty(t.id, isTabDirty(t)); // 이 호출 없이는
      // 탭의 dirty 점이 타이핑 직후가 아니라 다음 탭 재렌더(탭 전환 등)까지 나타나지 않는다.
      docxScheduleHashRecheck(t, editor); // 실행취소로 원본과 같아지면 dirty를 지운다.
      // revision 기반 fast path로는 판정할 수 없다.
      docxMaybeAutoformatList(editor);
    })));
    chromeCleanups.push(editor.on("error", (error) => {
      if (docxCheckParseError()) return;
      if (t !== getRenderedFileOwner() || t.docxEditor !== editor) return;
      showToast(error.message || "DOCX 편집기 오류");
    }));
    if (docxCheckParseError()) return;
    t.docxChromeCleanups = chromeCleanups;
    docxRefreshChrome(t);
  } catch (error) {
    if (t.docxGeneration !== docxGeneration) return;
    if (t.docxRenderToken !== docxRenderToken) return;
    if (t !== getRenderedFileOwner() || docxRenderToken !== getRenderedFileToken()) return;
    t.docxError = "이 문서는 열기 어렵습니다.";
    renderFileView(t, { expectedOwner: t, expectedToken: docxRenderToken });
  }
}
// docx 탭 전용. fileview가 아니라 docxview 패널에 그린다. renderFileViewBody와 같은 층의 함수이고, docx는 그쪽 분기를 타지 않는다.
function renderDocxPanelBody(t, renderToken) {
  svClosePopups();
  t.docxRenderToken = renderToken;
  const pathBar = `<div class="fv-bar"><span class="fv-name">${esc(t.label)}</span>${filePathBarHtml(t.path)}</div>`;
  if (t.docxError) {
    docxview.innerHTML = pathBar + `<div class="fv-loading docx-error">${esc(t.docxError)}</div>`;
    return;
  }
  if (t.docxData == null) {
    docxview.innerHTML = pathBar + `<div class="fv-loading">불러오는 중…</div>`;
    return;
  }
  docxview.innerHTML = docxEditorShellHtml(t);
  renderDocxContent(t);
}

  return { cleanupDocxRender, renderDocxContent, renderDocxPanelBody };
}
