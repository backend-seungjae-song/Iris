// 메모 기능의 진입점: 이 기능이 가진 다섯 모듈을 한 곳에서 연결한다.
//
// 소유 범위
//   메모 모듈 집합의 조립 순서와, 앱 셸이 이름으로 부르는 훅의 채움. 모듈 자체(사이드바 메모·
//   저장소·서버 메시지·분리 창·관리 화면)는 각 파일이 소유한다.
//
// 제공 API
//   initMemoCapability(ctx): capability 부팅이 한 번 부른다. 그 기능이 받을 서버 메시지 표를
//   돌려준다. enterMemoAdmin: 관리 화면에 들어올 때 부른다.
//
// 의존 대상
//   main 이 준 ctx 하나. 여기서 다섯 모듈에 필요한 것을 나눠 준다. main 을 import 하지 않는다.
//
// 유지 조건
//   메모 창 모드(mode=memo)에서는 이 기능이 그 창의 전부이므로, 꺼져 있어도 반드시 로드된다.
//   그 판정은 main 의 isOn 이 하고, 여기서는 memoMode 일 때 창 연결을 함께 켠다.
//   앱 셸이 부르는 이름(memo.render·memo.renderPreview·memo.disconnect·memo.remapDrafts)은
//   메모가 꺼지면 아무도 채우지 않는다. 부르는 쪽은 그 상태를 정상으로 처리해야 한다.
//
// 영향 범위
//   core/capabilities.js 의 등록, center/tabs.js·main.js 의 이름 호출, 서버의 memo* 메시지 계약.

import { provide } from "../core/hooks.js";
import { initMemo, renderMemo, renderMemoPreview, bootMemo } from "./memo.js";
import {
  applyMemoDocumentMessage, applyMemoSaved, disconnectMemoStore, initMemoStore, remapMemoDrafts,
} from "./memo-store.js";
import { initMemoMessages } from "./memo-messages.js";
import {
  initMemoWindowModule, initMemoWindow, handleMemoWindowMessage,
  disconnectMemoWindow, showMemoWindowError, archiveMemoWindow,
} from "./memo-window.js";
import { initMemoAdmin, enterMemoAdmin, panelHtml } from "./memo-admin.js";

export { enterMemoAdmin };
// 영역은 앱 셸이 이 진입점에서 받아 간다. 안쪽을 만든 것은 memo-admin 이지만, 표가 부르는 진입점은
// 여기 하나다. 다시 내보내지 않으면 그 영역만 생기지 않는다.
export { panelHtml };

// 서버가 보내지만 이 창이 할 일이 없는 메시지. 표에서 빼면 "모르는 메시지" 경고가 뜬다.
function ignore() { return true; }

export function initCapability(ctx) {
  return { screen: { enter: enterMemoAdmin }, ws: initMemoCapability(ctx) };
}

export function initMemoCapability(ctx) {
  const params = ctx.appParams;
  const memoMode = !!ctx.MEMO_MODE;
  const wsIsOpen = ctx.wsIsOpen || (() => false);

  initMemoStore({
    spk: ctx.spk, getSpaces: ctx.getSpaces, getSelectedSpaceId: ctx.getSelectedSpaceId,
    storedObjRemap: ctx.storedObjRemap, wsSend: ctx.wsSend, wsIsOpen,
    memoReqId: ctx.memoReqId, showToast: ctx.showToast,
    snapshotState: ctx.memoSnapshotState,
  });
  initMemo({
    $: ctx.$, blog: ctx.blog, wsSend: ctx.wsSend, showToast: ctx.showToast,
    AUX_MODE: ctx.AUX_MODE, memoReqId: ctx.memoReqId, orderedSpaces: ctx.orderedSpaces,
    bindAgentKeys: ctx.bindAgentKeys, acHost: ctx.acHost,
  });
  const messages = initMemoMessages({
    showToast: ctx.showToast, spk: ctx.spk,
    spaceLabel: (id) => (ctx.orderedSpaces().find((x) => x.id === id) || {}).label || id,
  });
  initMemoWindowModule({
    $: ctx.$, memoMode, wsSend: ctx.wsSend, wsIsOpen, memoReqId: ctx.memoReqId,
    mdToHtml: ctx.mdToHtml, ensureMonacoLib: ctx.ensureMonacoLib,
    getMonaco: () => window.monaco, monacoTheme: ctx.monacoTheme, acHost: ctx.acHost,
    kind: params.get("kind") === "shared" ? "shared" : "local",
    instance: params.get("instance") || "memo-window",
    space: params.get("space") || "",
    note: params.get("note") || "",
    spaceLabel: params.get("spaceLabel") || "",
    view: params.get("view"),
    alwaysOnTop: params.get("top") === "1",
  });
  initMemoAdmin({
    $: ctx.$, esc: ctx.esc, wsSend: ctx.wsSend, showToast: ctx.showToast,
    copyText: ctx.copyText, MEMO_MODE: memoMode,
    orderedSpaces: ctx.orderedSpaces, spk: ctx.spk, memoReqId: ctx.memoReqId,
  });

  // 앱 셸이 이 기능의 동작을 부르는 훅. 메모를 끄면 이 이름들을 아무도 채우지 않고, 부르는 쪽은
  // 아무 일도 하지 않는다.
  provide("memo.render", renderMemo);
  provide("memo.renderPreview", renderMemoPreview);
  provide("memo.disconnect", () => { disconnectMemoStore(); if (memoMode) disconnectMemoWindow(); });
  provide("memo.remapDrafts", remapMemoDrafts);
  // 메모 창에서는 들어오는 모든 서버 메시지를 그 창이 받는다. 본 창의 저장소가 거기에는 없다.
  // 그 분기는 앱 셸의 수신부에 있고, 무엇을 할지는 여기가 정한다.
  provide("memo.windowMessage", handleMemoWindowMessage);
  // ⌘⇧S: 메모 창에서 오늘 자를 보관한다. 단축키와 도크가 이 이름으로 부른다.
  provide("memo.archiveWindow", archiveMemoWindow);

  bootMemo();
  // 메모 창은 이 기능이 그 창의 전부다. 연결이 끝난 다음 틱에 띄운다. 부팅 중에 예외가 나면
  // 나머지 기능까지 멈춘다.
  if (memoMode) setTimeout(() => { try { initMemoWindow(); } catch (e) { showMemoWindowError(e); } }, 0);

  return {
    "memo-notes": messages.handleMemoNotesMessage,
    "memo.note.created": messages.handleMemoNoteCreatedMessage,
    "memo.note.restored": messages.handleMemoNoteRestoredMessage,
    "memo.note.archived": messages.handleMemoNoteArchivedMessage,
    "memo-conflict": messages.handleMemoConflictMessage,
    "memo.error": messages.handleMemoErrorMessage,
    "memo-saved": applyMemoSaved,
    "memo-archives": messages.handleMemoArchivesMessage,
    "memo-archived": messages.handleMemoArchivedMessage,
    "memos": messages.handleMemosMessage,
    "memo": applyMemoDocumentMessage,
    "memo.doc.live": ignore,
    "memo.doc.saved": ignore,
    "memo.doc.conflict": ignore,
  };
}
