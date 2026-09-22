// 화면 스케치 기능의 진입점.
//
// 소유 범위
//   지금 보고 있는 탭을 전체 길이로 찍는 일, 그 위에 그린 결과를 파일로 남기는 일, 그리고 그
//   경로를 채팅에 넣는 일. 주소줄 버튼과 ⌘⇧D 가 이 셋을 부른다.
//   ws 소유자 둘(sketch-relay · sketch-open-relay)을 가진다.
//
// 제공 API
//   initCapability(ctx). 연결과 훅과 메시지 소유자를 여기서 등록한다.
//   훅: sketch.open
//
// 의존 대상
//   앱 셸의 통로(ctx 의 $ · wsSend · showToast · acHost · browserMode · getCurTarget),
//   터미널의 getXterm 과 알림 표식(noticeBlock), 브라우저의 activeWv, 같은 모듈 집합의 오버레이.
//
// 유지 조건
//   찍은 이미지는 경로가 아니라 바이트로 받는다. 이 창은 http://localhost 이고 webSecurity 가
//   켜져 있어 file:// 이미지를 읽지 못한다. 경로를 <img> 에 넣으면 빈 화면이 된다.
//   분리 브라우저 창에는 터미널이 없다. 그 창에서는 결과를 콘솔로 넘기고 콘솔이 자기 터미널에
//   넣는다. 요소 지목과 같은 경로다.
//   끈 상태에서 ⌘⇧D 를 눌러도 아무 일이 없어야 하고, 오류가 나서도 안 된다.
//
// 영향 범위
//   훅 이름을 바꾸면 부르는 쪽 둘도 함께 바꿔야 한다: panel/touch-drag.js · browser/dock.js.
//   ws 이름 둘은 server/index.js 의 같은 이름과 짝이다. 네이티브 쪽 반은
//   native/electron/sketch-shot.cjs 다. 화면은 web/css/32-sketch.css 가 가진다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/sketch.js
import { provide } from "../core/hooks.js";
import { getXterm } from "../panel/terminal.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import { activeWv } from "./webview.js";
import { openSketchCanvas, sketchOpen } from "./sketch-canvas.js";

function sketchBlock(s) {
  return noticeBlock(`화면 스케치 · ${s.title || "(제목 없음)"}`, [
    s.url ? `주소: ${s.url}` : "",
    `그림: ${s.path}`,
  ]);
}

export function initCapability(ctx) {
  const { $, wsSend, showToast, acHost, browserMode: BROWSER_MODE, getCurTarget } = ctx;

  // 콘솔 쪽 도착지. 분리 창에서 온 것도 여기로 들어온다.
  const deliverLocal = (s) => {
    if (!getCurTarget()) { showToast("먼저 왼쪽에서 에이전트(세션)를 선택하세요."); return; }
    wsSend({ type: "pty.input", data: "\x1b[200~" + sketchBlock(s) + "\x1b[201~" });
    showToast("스케치 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.");
    const xterm = getXterm();
    if (xterm) setTimeout(() => xterm.focus(), 0);
  };

  const deliver = async (bytes, meta) => {
    let saved = null;
    try { saved = await acHost.sketchSave(bytes); } catch (e) { saved = null; }
    if (!saved || !saved.ok) { showToast("스케치를 저장하지 못했습니다."); return; }
    const s = { path: saved.path, url: meta.url, title: meta.title };
    if (BROWSER_MODE) {
      wsSend({ type: "sketch-relay", sketch: s });
      showToast("스케치 전달됨 → 콘솔 터미널.");
      try { acHost.refocusConsole && acHost.refocusConsole(); } catch (e) {}
      return;
    }
    deliverLocal(s);
  };

  const start = async () => {
    if (sketchOpen()) return;
    const r = activeWv();
    if (!r || !r.wc) { showToast("찍을 브라우저 탭이 없습니다."); return; }
    if (!acHost || !acHost.sketchShot) { showToast("이 빌드는 스케치를 지원하지 않습니다."); return; }
    showToast("페이지 전체를 찍는 중…");
    let shot = null;
    try { shot = await acHost.sketchShot(r.wc); } catch (e) { shot = null; }
    if (!shot || !shot.ok || !shot.bytes) { showToast((shot && shot.error) || "이 탭을 찍지 못했습니다."); return; }
    // 바이트를 이 창 안의 이미지로 바꾼다. 경로로는 읽을 수 없다(위 계약).
    const url = URL.createObjectURL(new Blob([shot.bytes], { type: "image/png" }));
    const img = new Image();
    const ok = await new Promise((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (!ok) { URL.revokeObjectURL(url); showToast("찍은 그림을 열지 못했습니다."); return; }
    const meta = { url: shot.url || r.url || "", title: shot.title || r.title || "" };
    const opened = openSketchCanvas({
      png: url,
      width: img.naturalWidth,
      height: img.naturalHeight,
      onDeliver: async (bytes) => { URL.revokeObjectURL(url); await deliver(bytes, meta); },
      onCancel: () => URL.revokeObjectURL(url),
    });
    if (!opened) URL.revokeObjectURL(url);
  };

  provide("sketch.open", () => { start(); });
  $("#wv-sketch")?.addEventListener("click", () => start());

  return {
    ws: {
      "sketch-relay": (m) => { if (!BROWSER_MODE && m.sketch) deliverLocal(m.sketch); },
      // 브라우저를 분리해 두면 콘솔엔 webview 가 없다. 그때 콘솔의 ⌘⇧D 는 분리 창에서 연다.
      "sketch-open-relay": () => { if (BROWSER_MODE && activeWv()) start(); },
    },
  };
}
