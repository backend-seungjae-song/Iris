// 파일을 끌어 터미널에 놓으면 절대경로가 그 자리에 들어간다(iTerm2 식).
//
// 소유 범위
//   "여기 놓으면 경로가 들어간다" 표시의 켜고 끄는 판정과 타이머, 그리고 놓인 파일의 경로 삽입.
//
// 제공 API
//   fileDragHotNext · DRAG_HOT_IDLE_MS · setDragHot · insertDroppedPaths.
//
// 의존 대상
//   panel/terminal 의 터미널 DOM·xterm 접근자. 클립보드·경로 해석은 acHost 가 한다.
//
// 유지 조건
//   표시를 켜 두는 사건은 dragover 하나뿐이다. 다른 사건으로도 켜면 그 사건이 안 오는 경로
//   (터미널 위를 지나 다른 곳에 놓기)에서 표시가 켜진 채로 남는다.
//   경로는 따옴표 없이 그대로 넣는다.
//
// 영향 범위
//   panel/xterm-wiring 이 부르는 훅 이름(chatcopy.dragHint·chatcopy.dropFiles)과
//   web/css/21-chat-copy.css 의 .drag-hot 표시.
//   현재 목록 확인: node bin/importers.mjs web/js/chatcopy/drop-path.js
import { getTerminal, getXterm } from "../panel/terminal.js";

// 파일 드래그 표시를 켤지 끌지. 순수 판정이라 DOM 없이 부를 수 있고 검사가 그대로 부른다.
// dragover 만 현재 커서 위치로 다시 계산하고, 나머지 사건은 모두 끈다. 켜 두는 사건을
// 하나라도 더 만들면 그 사건이 오지 않는 경로에서 표시가 남는다.
export function fileDragHotNext(kind, overTerminal) {
  return kind === "dragover" ? !!overTerminal : false;
}
// 드래그 중에는 dragover 가 계속 온다. 이 시간 동안 오지 않으면 드래그가 끝난 것이다.
// 명세상 커서가 멈춰 있어도 350ms 마다는 오므로 그보다 넉넉히 둔다.
export const DRAG_HOT_IDLE_MS = 1200;

let dragHotTimer = null;
export function setDragHot(on) {
  const terminal = getTerminal(); if (!terminal) return;
  terminal.classList.toggle("drag-hot", !!on);
  if (dragHotTimer) { clearTimeout(dragHotTimer); dragHotTimer = null; }
  if (on) dragHotTimer = setTimeout(() => terminal.classList.remove("drag-hot"), DRAG_HOT_IDLE_MS);
}
export function insertDroppedPaths(files, { acHost, showToast }) {
  const paths = [];
  for (const f of files) {
    const p = (acHost && acHost.getDroppedPath) ? acHost.getDroppedPath(f) : "";
    if (p) paths.push(p); // 따옴표 없이 절대경로 그대로
  }
  if (!paths.length) { showToast("드롭한 파일 경로를 읽지 못했습니다"); return; }
  const xterm = getXterm();
  if (xterm) { xterm.paste(paths.join(" ") + " "); xterm.focus(); }
}
