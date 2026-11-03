// 붙어 있는 webContents.debugger 의 JS 참조 유지
// - Electron 43 의 Debugger 는 GC 가 수거하는 객체이고 소멸자가 DetachClient 를 부르지 않음
//   붙은 채 수거되면 Chromium 이 해제된 객체로 CDP 메시지를 보내 앱 본체가 죽음
//   (2026-10-29 15:33 SIGSEGV, DevToolsSession::DispatchProtocolResponseOrNotification. electron#53738, 44.4.1 에서 수정)
// - detach 이벤트는 직접 떼거나 Chromium 이 연결을 닫을 때 모두 옴. 그때 참조를 놓음

const pinned = new Set();

function pinWhileAttached(dbg) {
  if (!dbg || pinned.has(dbg)) return;
  pinned.add(dbg);
  try { dbg.once("detach", () => pinned.delete(dbg)); }
  catch { pinned.delete(dbg); }
}

module.exports = { pinWhileAttached, pinnedCount: () => pinned.size };
