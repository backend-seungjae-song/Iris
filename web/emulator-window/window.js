// 에뮬레이터 전용 창. 원래 자리에서 분리했을 때 같은 화면 모듈을 창 전체에 붙인다.
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
import { PICK_PASS } from "/js/emulator/controls.js";

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
    fixedDevice: true,
    onDeviceChange: (device) => host.requestControl({ action: "device", tab: params.get("tab"), device }),
    onRequestDetach: () => {},
    detachable: false,
    actions: [{ label: "다시 붙이기", icon: "totab", title: "기기를 원래 자리로 다시 붙입니다", onClick: () => { void host.closeWindow({ tab: params.get("tab") }); } }],
    onPick: params.get("pick") === "1" ? () => host.requestControl({ action: "pick", tab: params.get("tab") }) : undefined,
    pickOn: () => picking,
    onRecord: params.get("record") === "1" ? () => host.requestControl({ action: "record", tab: params.get("tab") }) : undefined,
    recordOn: () => recording,
  });
  host.onConnectRequested?.(() => pane.connect());
  let picking = false;
  let recording = false;
  let hover = null;
  host.onPickState((on) => {
    picking = !!on;
    document.body.classList.toggle("picking-tabs", picking);
    hover?.classList.remove("pick-hover"); hover = null;
  });
  host.onRecordState((on) => { recording = !!on; });
  let noticeTimer = 0;
  host.onControlResult((message) => {
    let notice = document.querySelector(".emu-window-notice");
    if (!notice) { notice = document.createElement("div"); notice.className = "emu-window-notice"; document.body.append(notice); }
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
  });
  document.addEventListener("mousemove", (event) => {
    if (!picking) return;
    const target = event.target.closest(".emu-toolbar, .emu-frame-shell");
    const next = event.target.closest(PICK_PASS) ? null : target;
    if (next === hover) return;
    hover?.classList.remove("pick-hover");
    hover = next;
    hover?.classList.add("pick-hover");
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!picking || event.target.closest(PICK_PASS) || !event.target.closest(".emu-toolbar, .emu-frame-shell")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    host.requestControl({ action: "target", tab: params.get("tab"), device: pane.current().udid });
  }, true);
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
    document.addEventListener(type, (event) => {
      if (!picking || event.target.closest(PICK_PASS) || !event.target.closest(".emu-toolbar, .emu-frame-shell")) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  }
  pane.setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", () => pane.setVisible(document.visibilityState === "visible"));
  window.addEventListener("pagehide", () => pane.dispose());
  // 켜짐 여부 보고. 본 창이 자리 기록에 저장(앱 재시작 때 켜져 있던 기기만 다시 켜기)
  // 복원으로 켜는 중(connect=1)에는 붙거나 실패할 때까지 보고 보류(켜는 중에 "꺼짐"이 저장되지 않게)
  let running = null;
  let booting = params.get("connect") === "1";
  setInterval(() => {
    const cur = pane.current();
    if (booting) { if (cur.attached || cur.error) booting = false; else return; }
    if (cur.loading) return;
    const on = !!cur.attached;
    if (on !== running) { running = on; host.requestControl({ action: "running", tab: params.get("tab"), on }); }
  }, 2000);
  if (booting) pane.connect();
}
