// 서버가 보내온 메모 알림을 화면에 반영한다.
//
// 소유 범위
//   memo-* WS 메시지 열 가지의 처리: 목록 갱신, 새 창 열기, 충돌·실패 안내,
//   보관함 갱신, 그리고 메모 스냅샷 반영.
//
// 제공 API
//   initMemoMessages(deps) 하나. 조립부가 dispatch 표에 그대로 꽂는 handler 들을 돌려준다.
//
// 의존 대상
//   panel/memo*.js 의 상태 소유자들과, 조립부가 넘겨주는 showToast·spk(스페이스 열쇠 변환).
//   원시 상태를 여기서 갖지 않는다. 전부 소유 모듈을 거친다.
//
// 유지 조건
//   저장 실패와 충돌은 그냥 넘기지 않는다. 초안은 창에 남기고 사용자에게 알린다.
//   동시에 바뀐 두 버전은 하나를 버리지 않고 둘 다 보존한다.
//   보관함 화면이 떠 있을 때만 다시 그린다.
//
// 영향 범위
//   공급자는 web/js/main.js 의 조립부(dispatch 표)이고, 양방향 소비자는 panel/memo-store.js ·
//   panel/memo-admin.js 다. 여기서 부르는 setter 들이 그 모듈에 있다.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/memo-messages.js

import { renderMemo } from "./memo.js";
import { callHook } from "../core/hooks.js";
import {
  applyMemoConflict, applyMemoError, applyMemoSnapshot, getMemoShownSpace, hasMemoDraft,
  setMemoNotes, setMemoShownSpace, takeMemoCreate,
} from "./memo-store.js";

export function initMemoMessages({ showToast, spk, spaceLabel }) {
function handleMemoNotesMessage(m) {
      setMemoNotes(m);
      if (document.body.classList.contains("mm-active")) callHook("memo.refresh");
      if (m.error) showToast(m.error);
}

function handleMemoNoteCreatedMessage(m) {
      const pending = takeMemoCreate(m.requestId);
      if (m.note?.id) Promise.resolve(window.acHost?.openLocalMemo?.({
        spaceKey: m.storageSpace || spk(m.space || pending?.space), noteId: m.note.id,
        spaceLabel: pending?.label || spaceLabel(m.space || pending?.space),
      })).then((result) => { if (!result?.ok) showToast(result?.error || "메모 창을 열지 못했습니다."); });
}

function handleMemoNoteRestoredMessage(m) {
      showToast(`“${m.note?.name || "메모"}” 복구됨`);
}

function handleMemoNoteArchivedMessage(m) {
      showToast(m.empty ? "빈 메모는 보관하지 않았습니다." : `${m.date} 보관함에 저장했습니다.`);
}

function handleMemoConflictMessage(m) {
      if (applyMemoConflict(m)) {
        showToast("동시에 바뀐 메모 두 버전을 모두 보존했습니다.");
      } else showToast(m.message || "다른 창에서 메모가 먼저 바뀌었습니다.");
}

function handleMemoErrorMessage(m) {
      if (applyMemoError(m) === "central") {
        showToast(m.message || "중앙 메모를 저장하지 못했습니다. 초안은 이 창에 보존했습니다.");
      } else {
        showToast(m.message || "메모 작업에 실패했습니다.");
      }
}

function handleMemoArchivesMessage(m) {
      callHook("memo.setArchives", m.archives || {});
      if (document.body.classList.contains("mm-active")) callHook("memo.refresh");
}

function handleMemoArchivedMessage(m) {
      if (m.empty) showToast("메모가 비어 있어 보관하지 않았습니다.");
      else showToast(`${m.date} 보관함에 ${m.updated ? "이어 붙였습니다" : "담았습니다"}.`);
}

function handleMemosMessage(m) {
      applyMemoSnapshot(m);
      if (!hasMemoDraft(getMemoShownSpace())) setMemoShownSpace(null);
      renderMemo();
}

  return { handleMemoNotesMessage, handleMemoNoteCreatedMessage, handleMemoNoteRestoredMessage,
    handleMemoNoteArchivedMessage, handleMemoConflictMessage, handleMemoErrorMessage,
    handleMemoArchivesMessage, handleMemoArchivedMessage, handleMemosMessage };
}
