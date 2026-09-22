// CDP 명령 동안만 쓰는 숨은 탭 임시 레이아웃.
//
// 소유 범위
//   사람이 보지 않아 innerWidth가 0인 탭에 적용할 임시 viewport 값과 적용·원복 순서.
//
// 제공 API
//   withLayout(send, fn). CDP 세션이나 Electron debugger는 내주거나 직접 잡지 않는다.
//
// 의존 대상
//   호출자가 주입하는 CDP send 함수와 명령 본문 fn.
//
// 유지 조건
//   뷰포트가 이미 있는 탭에는 metrics를 씌우지 않는다. 씌웠다면 fn의 성공·실패와 무관하게
//   finally에서 반드시 제거해 사람 화면과 다른 세션·스페이스에 흔적을 남기지 않는다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 세션 send와 Runtime innerWidth이고, 양방향 소비자는 click·hover·
//   screenshot 명령이다. 임시 metrics 순서는 배경 탭 좌표·캡처와 사람이 보는 탭의 화면에도 영향을 준다.

const AGENT_VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };

async function withLayout(send, fn) {
  let applied = false;
  try {
    const r = await send("Runtime.evaluate", { expression: "innerWidth", returnByValue: true });
    const w = r && r.result ? Number(r.result.value) : 0;
    if (!w) { await send("Emulation.setDeviceMetricsOverride", AGENT_VIEWPORT); applied = true; }
  } catch {}
  try {
    return await fn(applied);
  } finally {
    if (applied) { try { await send("Emulation.clearDeviceMetricsOverride"); } catch {} }
  }
}

module.exports = { withLayout };
