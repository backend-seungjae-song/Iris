// 마우스→터치 변환을 커서가 페이지 영역 안에 있을 때만 켠다.
//
// 변환이 켜져 있으면 창 안의 마우스 이동이 렌더러에 오지 않는다. 그래서 렌더러는 포인터가 페이지를
// 벗어난 것을 알 수 없고, 크기 손잡이·탭 줄을 누르면 터치로 바뀐다. 렌더러가 페이지 영역(rect, 창 내용
// 기준 CSS px)을 주고 무장하면 여기서 커서 위치를 직접 확인해 켜고 끈다.

function createTouchDragArm({ screen, BrowserWindow, setTouchDrag, intervalMs = 50 }) {
  let current = null;

  async function arm(target, rect) {
    const prev = current;
    if (prev) clearInterval(prev.timer);
    current = null;
    const keepOn = !!(prev && prev.on && rect && prev.target === target);
    if (prev && prev.on && !keepOn && !prev.target.isDestroyed()) await setTouchDrag(prev.target, false);
    if (!rect) return { ok: true, on: false };
    const host = target.hostWebContents;
    const win = host && BrowserWindow.fromWebContents(host);
    if (!win) return { ok: false, error: "탭을 품은 창이 없습니다." };
    const a = { target, on: keepOn, busy: false, timer: null };
    const inside = () => {
      const z = host.getZoomFactor(), b = win.getContentBounds(), p = screen.getCursorScreenPoint();
      const x = (p.x - b.x) / z, y = (p.y - b.y) / z;
      return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    };
    const tick = async () => {
      if (a.busy || current !== a) return;
      if (target.isDestroyed() || host.isDestroyed() || win.isDestroyed()) { clearInterval(a.timer); current = null; return; }
      const want = inside();
      if (want === a.on) return;
      a.busy = true;
      try { const r = await setTouchDrag(target, want); if (r && r.ok) a.on = want; } finally { a.busy = false; }
    };
    current = a;
    a.timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    await tick();
    return { ok: true, on: a.on };
  }

  return { arm };
}

module.exports = { createTouchDragArm };
