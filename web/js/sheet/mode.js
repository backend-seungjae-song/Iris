// 소유 범위: 같은 파일을 표로 볼지 글자로 볼지 고르는 전환 하나.
//   전환이 관여하는 범위: 현재 표현에 저장하지 않은 편집이 있으면 먼저 물어보고, 고른 뒤에야
//   모드를 바꾸고, 새 표현에 담을 것이 없으면 그때 읽어 온다.
// 제공 API: initSheetMode(deps) 와 switchSheetMode(t, targetMode).
// 의존 대상: 앱 셸의 탭 저장소·저장/폐기 경로·저장 확인 대화상자·파일 화면 렌더.
//   기능 → 앱 셸 방향이라 직접 import 한다. showToast 만 조립부에서 받는다.
// 유지 조건: 모드 변경은 사용자가 고른 *뒤*에 한다. 먼저 바꾸고 물어보면
//   취소를 눌러도 이미 화면이 바뀐 뒤다.
// 설계 이유: 이 코드가 center/tab-close.js 에 있으면 앱 셸이 t.sheetMode · t.sheet 와
//   "sheet.read" 라는 이 기능의 메시지 이름까지 알게 되고, 표 뷰어를 끄면 그 코드의 역할이
//   불분명해진다. 부르는 곳은 이 기능 안(viewer.js · events.js)뿐이다.
// 영향 범위: 저장 확인 대화상자는 한 번에 하나만 뜬다. 그 잠금은 앱 셸이 소유하고
//   chooseDirtyAction 이 감싸므로 여기서 직접 여닫지 않는다.
//   현재 목록 확인: node bin/importers.mjs web/js/sheet/mode.js
import { getCenterSpace, getTabs } from "../center/tab-store.js";
import { sendTabIo } from "../center/tabs.js";
import { chooseDirtyAction, discardTabToDisk, isTabDirty, saveTabForClose } from "../center/tab-close.js";
import { isTextTabDirty, renderFileView } from "../center/text-editor.js";
import { svTabDirty } from "./edit.js";

let showToast;

export function initSheetMode(deps) {
  ({ showToast } = deps);
}

export async function switchSheetMode(t, targetMode) {
  targetMode = !!targetMode;
  const sourceMode = !!t.sheetMode;
  if (sourceMode === targetMode) return;
  const space = getCenterSpace(), tabId = t.id, path = t.path;
  // 물어보는 동안 사람이 탭을 옮기거나 닫거나 다른 데서 모드를 바꿀 수 있다. 그 뒤에 이어서
  // 진행하면 다른 탭을 바꾸게 되므로, 기다린 뒤마다 같은 탭·같은 모드인지 다시 확인한다.
  const isLiveSource = () => getCenterSpace() === space
    && getTabs(space).some((tab) => tab === t && tab.id === tabId && tab.path === path)
    && !!t.sheetMode === sourceMode;
  let sourceDirty = sourceMode ? svTabDirty(t) : isTextTabDirty(t);
  let targetDirty = sourceMode ? isTextTabDirty(t) : svTabDirty(t);
  if (sourceDirty) {
    // 잠금은 앱 셸이 소유한다. 이미 열려 있으면 null 이 오고, 여기서 두 번째 대화상자를 띄우지 않는다.
    const choice = await chooseDirtyAction("변경 내용을 저장하고 전환할까요?", t.label || t.path);
    if (choice === null) { showToast("이미 저장 확인이 열려 있습니다"); return; }
    if (choice === "cancel" || !isLiveSource()) return;
    sourceDirty = sourceMode ? svTabDirty(t) : isTextTabDirty(t);
    targetDirty = sourceMode ? isTextTabDirty(t) : svTabDirty(t);
    if (choice === "save") {
      if (sourceDirty && targetDirty) {
        showToast("원문과 표 양쪽에 편집이 남아 있습니다. 수정 사항 모두 취소하거나 전환을 취소하세요");
        return;
      }
      try { await saveTabForClose(t, space); }
      catch (e) { return; }
      if (!isLiveSource() || (sourceMode ? svTabDirty(t) : isTextTabDirty(t))) return;
    } else if (choice === "discard") {
      const discarded = await discardTabToDisk({ space, tabId, tabRef: t });
      if (!discarded || !isLiveSource() || isTabDirty(t)) return;
    } else return;
  }
  if (!isLiveSource()) return;
  t.sheetMode = targetMode;
  if (targetMode && !t.sheet) {
    const pending = sendTabIo({ type: "sheet.read", path, space, tabId, reason: "mode-switch" });
    pending.catch(() => {});
  } else if (!targetMode && t.content == null) {
    const pending = sendTabIo({ type: "fs.read", path, space, tabId, reason: "mode-switch" });
    pending.catch(() => {});
  }
  renderFileView(t);
}
