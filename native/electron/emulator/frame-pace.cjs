// 에뮬레이터 화면 프레임 전달 간격
// 화면을 띄운 창에 포커스가 없으면 초당 5프레임까지만 창에 전달. 포커스가 돌아오면 바로 전부 전달
// 시뮬레이터 앱이 계속 움직이면 serve-sim 이 초당 20~60프레임을 보내고, 전부 넘기면 메인 IPC·창 디코딩에 CPU 약 40%
// 5프레임은 화면 변화가 없을 때 serve-sim 이 보내는 속도와 같음
const UNFOCUSED_INTERVAL_MS = 200;

function frameAllowed({ focused, lastSentAt, now }) {
  return focused || now - lastSentAt >= UNFOCUSED_INTERVAL_MS;
}

function createFramePacer(win, now = Date.now) {
  let lastSentAt = 0;
  return () => {
    const t = now();
    let focused = true;
    try { focused = !win || win.isDestroyed() || win.isFocused(); } catch {}
    if (!frameAllowed({ focused, lastSentAt, now: t })) return false;
    lastSentAt = t;
    return true;
  };
}

module.exports = { UNFOCUSED_INTERVAL_MS, frameAllowed, createFramePacer };
