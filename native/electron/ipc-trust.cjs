// privileged IPC 발신자의 앱 origin 일치 판정.
//
// 소유 범위
//   senderFrame URL과 기대하는 앱 URL의 origin을 매 호출마다 비교하는 규칙.
//
// 제공 API
//   isTrustedSender(event, expectedAppUrl)와 main webContents 전용 isTrustedMainFrame을 제공한다.
//   원시 상태나 캐시된 신뢰 표식은 제공하지 않는다.
//
// 의존 대상
//   표준 URL 파서와 호출자가 넘기는 Electron IPC event·기대 앱 URL 값.
//
// 유지 조건
//   두 origin이 정확히 같을 때만 참이다. senderFrame이 없거나 어느 URL이든 깨졌으면
//   던지지 않고 거짓이며, 판정 결과를 캐시해 다른 IPC 호출에 재사용하지 않는다.
//   좁은 판정은 살아 있는 허용 webContents 객체와 그 객체의 mainFrame까지 매 호출 직접 대조한다.
//
// 영향 범위
//   공급자는 main.cjs의 APP_URL과 Electron senderFrame.url이고, 양방향 소비자는 main.cjs의
//   파일·Chrome handoff·viewport·profile import·credential·AI login·창 IPC adapter들이다.
//   이 판정은 renderer preload가 노출한 privileged 호출과 로컬 파일·자격증명 경계까지 번진다.

function isTrustedSender(event, expectedAppUrl) {
  try {
    const senderUrl = event && event.senderFrame && event.senderFrame.url;
    if (!senderUrl) return false;
    if (new URL(senderUrl).origin !== new URL(expectedAppUrl).origin) return false;
    return true;
  } catch {
    return false;
  }
}

function isTrustedMainFrame(event, expectedAppUrl, allowedWebContents) {
  try {
    if (!isTrustedSender(event, expectedAppUrl)) return false;
    if (!allowedWebContents || event.sender !== allowedWebContents) return false;
    if (typeof allowedWebContents.isDestroyed === "function" && allowedWebContents.isDestroyed()) return false;
    if (!allowedWebContents.mainFrame || event.senderFrame !== allowedWebContents.mainFrame) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { isTrustedSender, isTrustedMainFrame };
