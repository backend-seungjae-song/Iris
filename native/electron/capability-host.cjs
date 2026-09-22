// 켜 둔 네이티브 기능만 로드한다.
//
// 소유 범위
//   표를 순회하며 켜진 것만 require 하고 initCapability 를 부르는 순서, 그리고 하나가 실패했을
//   때의 처리.
//
// 제공 API
//   bootNativeCapabilities({ items, isOn, ctx, onError }): 로드한 id 목록을 돌려준다.
//
// 의존 대상
//   표도 판정도 밖에서 받는다. 그래야 검사가 대역 표로 이 함수를 직접 실행할 수 있다.
//
// 유지 조건
//   하나가 실패해도 나머지는 로드한다. 한 기능의 오류가 앱 실행을 막으면, 기능을 끄고 켜는
//   장치가 앱을 더 쉽게 죽게 만든 것이다.
//   끈 것은 require 를 부르지 않는다. 로드해 놓고 쓰지 않으면 이 파일이 하는 일이 없다.
//   실패는 삼키지 않고 onError 로 올린다. 조용히 없는 기능이 되면 원인을 추적할 수 없다.
//
// 영향 범위
//   capabilities.cjs 의 표, main.cjs 의 부팅 순서.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/capability-host.cjs

function bootNativeCapabilities({ items, isOn, ctx, onError } = {}) {
  const list = Array.isArray(items) ? items : [];
  const on = typeof isOn === "function" ? isOn : () => true;
  const loaded = [];
  for (const cap of list) {
    if (!cap || !cap.id || !cap.module) continue;
    if (!on(cap.id)) continue;                       // 끈 것은 require 를 부르지 않는다
    try {
      // 표가 이미 require.resolve 로 풀어 둔 절대 경로다. 여기서 다시 조립하지 않는다.
      // 두 곳에서 각자 경로를 풀면 서로 다른 파일을 가리킬 수 있다.
      const mod = require(cap.module);
      if (typeof mod.initCapability !== "function") {
        throw new Error(`${cap.id}: initCapability 가 없다`);
      }
      mod.initCapability(ctx || {});
      loaded.push(cap.id);
    } catch (e) {
      if (onError) onError(cap.id, e);
      else console.error(`[capability] ${cap.id} 실패`, e);
    }
  }
  return loaded;
}

module.exports = { bootNativeCapabilities };
