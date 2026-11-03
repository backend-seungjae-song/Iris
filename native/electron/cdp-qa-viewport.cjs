// QA 탭의 화면 크기만 변경하고 UA·주소·새로고침은 유지
// 사용자가 호스트별로 걸어 둔 확대(Cmd+-)는 페이지 CSS 크기와 배율을 바꾸므로 보정해서 요청한 크기·배율 유지.
// 확대 설정 자체는 같은 호스트의 사용자 탭과 공유되어 바꾸지 않음
function zoomOf(wc) {
  try { const z = typeof wc.getZoomFactor === "function" ? wc.getZoomFactor() : 1; return z > 0 ? z : 1; } catch { return 1; }
}
function createQaViewportCommands({ notify, yieldViewport, viewportOwner }) {
  const states = new WeakMap();
  // QA 명령이 정한 크기에 적용한 확대 비율. 주소창 크기 설정은 보정 대상 아님
  const appliedZoom = new WeakMap();
  const read = (wc) => viewportOwner ? viewportOwner.viewportFor(wc.id) : states.get(wc) || null;
  const write = (wc, state) => { if (viewportOwner) viewportOwner.setViewportState(wc.id, state); else if (state) states.set(wc, state); else states.delete(wc); };
  const apply = async (send, wc, { width, height, dpr }) => {
    const z = zoomOf(wc);
    const w = Math.round(width*z), h = Math.round(height*z);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr > 0 ? dpr/z : 0, mobile: false });
    appliedZoom.set(wc, z);
    if (notify) notify(wc.id, { w, h, cls: "desktop" });
  };
  // 이동 뒤 호스트 확대가 바뀐 경우 같은 크기로 다시 적용
  const reconcile = async (send, wc) => {
    if (!appliedZoom.has(wc) || appliedZoom.get(wc) === zoomOf(wc)) return false;
    const state = read(wc);
    if (!state) { appliedZoom.delete(wc); return false; }
    await apply(send, wc, state);
    return true;
  };
  const commands = {
    async "qa-viewport-state"(_send, wc) { return { ok: true, viewport: read(wc) }; },
    async "qa-viewport"(send, wc, args = {}) {
      if (yieldViewport) yieldViewport(wc.id);
      if (args.clear) {
        await send("Emulation.clearDeviceMetricsOverride");
        write(wc, null);
        appliedZoom.delete(wc);
        if (notify) notify(wc.id, null);
        return { ok: true, cleared: true };
      }
      const width = args.width, height = args.height, dpr = args.dpr ?? 1;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16000 || height > 16000
        || !Number.isFinite(dpr) || dpr < 0 || dpr > 3) throw new Error("QA 화면 크기·배율이 올바르지 않습니다");
      const state = { width, height, dpr };
      await apply(send, wc, state);
      write(wc, state);
      return { ok: true, ...state, reloaded: false };
    },
  };
  // 명령 표에 섞이지 않게 열거 제외
  Object.defineProperty(commands, "reconcile", { value: reconcile, enumerable: false });
  Object.defineProperty(commands, "release", { value: (wc) => appliedZoom.delete(wc), enumerable: false });
  return commands;
}

module.exports = { createQaViewportCommands, zoomOf };
