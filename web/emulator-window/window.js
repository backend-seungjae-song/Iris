// 에뮬레이터 전용 창. 탭에서 분리했을 때 같은 화면 모듈을 창 전체에 붙인다.
//
// 소유 범위
//   주소의 space · device 로 화면 하나를 붙이고, 창이 닫힐 때 그 화면을 정리하는 일.
//
// 제공 API
//   없다. 페이지가 읽히면 바로 실행된다.
//
// 의존 대상
//   preload 가 노출한 window.acHost.emulator 와 web/js/emulator/pane.js.
//
// 유지 조건
//   창을 닫을 때 close() 가 아니라 dispose() 를 부른다. 창을 닫는 것은 탭으로 되돌리는 것이고,
//   탭이 같은 세션에 다시 붙는다. close() 를 부르면 기기와 헬퍼가 꺼져서 탭이 처음부터 다시 켠다.
//
// 영향 범위
//   web/js/emulator/boot.js 의 분리·되돌리기.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/emulator-window/window.js
import { mountEmulatorPane } from "/js/emulator/pane.js";

const params = new URLSearchParams(location.search);
const root = document.getElementById("emu-window");
const host = window.acHost && window.acHost.emulator;

if (!host || !params.get("space")) {
  root.textContent = "이 창은 Iris 앱에서 에뮬레이터 탭을 분리할 때만 열 수 있습니다.";
} else {
  const pane = mountEmulatorPane(root, {
    host,
    workspaceId: params.get("space"),
    deviceId: params.get("device") || null,
    onDeviceChange: () => {},
    onRequestDetach: () => {},
    detachable: false,
  });
  pane.setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", () => pane.setVisible(document.visibilityState === "visible"));
  window.addEventListener("pagehide", () => pane.dispose());
}
