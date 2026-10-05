// 등록된 화면 action을 해당 webview의 호스트에서 호출한다. 페이지 디버거는 사용하지 않는다.
//
// 소유 범위
//   guest의 호스트와 등록된 action을 확인하고 화면 hook의 결과를 반환한다.
// 제공 API
//   createContextActionCommand(getContextActions).
// 의존 대상
//   주입된 action registry와 Electron guest·host 객체. Electron을 직접 로드하지 않는다.
// 유지 조건
//   호스트 코드와 hook module 경로는 고정하고 등록된 이름과 실제 guest id만 JSON으로 전달한다.
// 영향 범위
//   cdp-control.cjs의 contextaction 명령, main.cjs의 registry 주입, 원격 브라우저 action.
function createContextActionCommand(getContextActions) {
  return async (guest, args = {}) => {
    const unavailable = { ok: false, code: "unavailable" };
    const host = guest?.hostWebContents;
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || !host || host.isDestroyed()
      || typeof args.name !== "string" || !getContextActions(host).some((action) => action.name === args.name)) return unavailable;
    const name = JSON.stringify(args.name);
    const message = JSON.stringify({ guestWebContentsId: guest.id });
    try {
      const result = await host.executeJavaScript(`(async()=>{const {callHook,hasHook}=await import('/js/core/hooks.js');const name=${name};if(!hasHook(name))return {ok:false,code:'unavailable'};return await callHook(name,${message})||{ok:false,code:'unavailable'};})()`);
      return result && typeof result.ok === "boolean" ? result : unavailable;
    } catch { return unavailable; }
  };
}

module.exports = { createContextActionCommand };
