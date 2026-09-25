// 채팅 복붙 기능의 진입점.
//
// 소유 범위
//   이 기능의 연결 하나. 앱 셸이 부르는 여덟 이름을 채우고, 하위 모듈에 ctx 를 넘긴다.
//
// 제공 API
//   initCapability(ctx). 화면도 서버 메시지도 갖지 않는다. 가운데 영역도 rail 도 아닌
//   터미널 위에서만 동작하는 기능이다.
//
// 의존 대상
//   core/hooks 의 provide, panel/terminal 의 상태 접근자, 그리고 자기 하위 모듈 셋
//   (edge-drag · copy-text · drop-path). ctx 에서 꺼내는 것은 main 이 실제로 주는 이름뿐이다.
//
// 유지 조건
//   이 파일을 앱 셸이 정적으로 import 하면 "끈 기능은 로드되지 않는다" 규칙이 깨진다.
//   훅 이름은 전부 "chatcopy." 로 시작한다. 접두어가 채우는 모듈을 가리킨다.
//   자동 복사는 드래그 중과 종료 직후를 피해야 한다. 그 판정은 edge-drag 이 소유하며,
//   여기서 다시 계산하면 두 곳의 기준이 갈라진다.
//
// 영향 범위
//   panel/xterm-wiring 의 훅 호출 위치와 main 의 PTY 수신(chatcopy.captureAfterWrite).
//   현재 목록 확인: node bin/importers.mjs web/js/chatcopy/boot.js
import { provide } from "../core/hooks.js";
import { cropAwareSelection } from "./copy-text.js";
import {
  edgeAutoCopyBlocked, edgeBegin, edgeCaptureAfterWrite, edgeFinish, edgeTrack, edgeWheel,
  initEdgeDrag,
} from "./edge-drag.js";
import { fileDragHotNext, insertDroppedPaths, setDragHot } from "./drop-path.js";

// 고르는 동안 오는 선택 변경을 이만큼 모아서 마지막 한 번만 알린다.
const COPY_TOAST_DELAY_MS = 250;

export function initCapability(ctx) {
  const { blog, wsSend, showToast, getLastAgents, getCurTarget, wsIsOpen, acHost, copyText } = ctx;
  initEdgeDrag({ blog, wsSend, wsIsOpen, getCurTarget, getLastAgents });

  // 앱 셸의 copyText 는 메인 프로세스 clipboard 를 먼저 쓰고 복사했는지를 돌려준다. 렌더러
  // navigator.clipboard 는 Electron webview 에서 실패해 빈 값이 복사된다.
  const writeClipboard = async (text) => {
    try { return (await copyText(text)) === true; } catch { return false; }
  };

  provide("chatcopy.wheel", (spec) => edgeWheel(spec));
  provide("chatcopy.dragStart", (e) => edgeBegin(e));
  provide("chatcopy.dragMove", (e) => edgeTrack(e));
  provide("chatcopy.dragEnd", (e) => { finishDrag(e); });
  provide("chatcopy.captureAfterWrite", () => edgeCaptureAfterWrite());
  // 복사됐다는 사실을 알린다.
  //
  // 드래그 복사만 알리면 그냥 선택해 복사한 경우에는 표시가 없어, 사람은 복사가
  // 됐는지 붙여넣기 전에는 알 수 없다.
  // 고르는 동안 선택 변경이 여러 번 오므로 마지막 한 번만 알린다. 선택이 풀리면 예약도 취소한다.
  // 취소하지 않으면 지워진 선택을 두고 "복사됨"이 뜬다.
  // 알림은 복사 결과가 온 뒤에 띄운다. 복사하지 못했으면 그 사실을 알린다.
  let copiedTimer = null, copiedGen = 0;
  const noteCopied = (text, written) => {
    const gen = ++copiedGen;
    if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null; }
    if (!text) return;
    copiedTimer = setTimeout(async () => {
      copiedTimer = null;
      const ok = await written;
      if (gen !== copiedGen) return;
      showToast(ok ? `${String(text).split("\n").length}줄 복사됨` : "복사하지 못했습니다");
    }, COPY_TOAST_DELAY_MS);
  };

  provide("chatcopy.selectionChanged", () => {
    // 화면 밖 드래그 중이거나 종료 직후이면 여기서 쓰지 않는다. 지금 화면 몫만 써서
    // 이어붙인 결과를 덮어버린다. 손을 놓은 뒤에도 xterm 이 선택 변경을 한 번 더 쏘기 때문이다.
    if (edgeAutoCopyBlocked()) return;
    const s = cropAwareSelection();
    if (!s) { noteCopied(""); return; }
    noteCopied(s, writeClipboard(s));
  });
  provide("chatcopy.dragHint", (kind, overTerminal) => setDragHot(fileDragHotNext(kind, overTerminal)));
  provide("chatcopy.dropFiles", (files) => insertDroppedPaths(files, { acHost, showToast }));

  async function finishDrag(e) {
    let got = null;
    try { got = await edgeFinish(e); }
    catch (e2) {
      // 여기까지 오면 서버 기록과 로컬 누적분을 모두 쓰지 못한 것으로, 결과가 비는 유일한 경우다.
      blog("edge finish", e2.message);
      showToast("범위 복사를 만들지 못했습니다 — " + (e2.message || "원인 불명"));
    }
    if (!got || !got.text) return;
    const text = got.text;
    if (!(await writeClipboard(text))) { showToast("범위 복사를 만들었지만 클립보드에 쓰지 못했습니다"); return; }
    const lines = text.split("\n").length;
    // 잘렸을 수 있다는 사실을 감추면 모르고 붙여넣게 된다. 완전본과 다른 문구를 쓰고, 어느 대조가
    // 일치하지 않았는지 함께 남긴다. 이 정보가 없으면 원인을 찾을 수 없다.
    showToast(got.degraded
      ? `${lines}줄 복사됨 — 화면에서 본 만큼만 (기록 대조 실패: ${got.degraded})`
      : `${lines}줄 복사됨(화면 밖 포함)`);
  }

  return {};
}
