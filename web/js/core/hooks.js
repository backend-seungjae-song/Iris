// 선택 기능이 스스로 등록하는 지점. 코어가 화면 모듈을 import 하지 않고도 호출할 수 있게 한다.
//
// 소유 범위
//   이름 → 함수 표 하나, 그리고 등록되지 않은 이름을 호출했을 때의 동작(아무 일도 하지 않음).
//
// 제공 API
//   provide(name, fn) · callHook(name, ...args) · hasHook(name) · hookNames() · clearHooks().
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 호출된다.
//
// 배경
//   단축키 코드가 ⌘⇧S 하나 때문에 메모 화면 모듈 전체를 import 했고(keynav·dock), 브라우저
//   코어가 자동완성 목록 새로고침 하나 때문에 로그인 화면을 import 했다(webview-factory).
//   그 결과 "기능을 끄면 로드되지 않는다"가 성립하지 않았다. 호출하는 쪽은 이름만 알고, 그
//   이름을 채우는 것은 로드된 기능 자신이다. 로드되지 않았으면 그 호출은 아무 일도 하지 않는다.
//
// 유지 조건
//   등록되지 않은 이름을 호출하는 것은 오류가 아니다. 예외를 던지게 만들면 기능을 끈 순간
//   앱이 죽는다.
//   반환값을 쓰는 쪽은 호출하는 쪽이 대체값을 갖는다. undefined 가 그대로 화면에 나가면
//   값이 빈 것과 기능이 없는 것을 구별할 수 없다.
//   이름은 "기능.동작" 형식으로 적는다. 앞부분이 어느 기능이 채우는지를 나타낸다.
//
// 영향 범위
//   core/keynav.js · browser/dock.js · browser/webview-factory.js 가 호출하고,
//   panel/memo-admin.js · browser/autofill-allowlist.js 가 채운다.
//   현재 목록 확인: node bin/importers.mjs web/js/core/hooks.js

const handlers = new Map();

export function provide(name, fn) {
  if (!name || typeof fn !== "function") return false;
  // 두 기능이 같은 이름을 채우면 나중 것이 조용히 덮어써서, 먼저 채운 쪽의 동작이 알림 없이
  // 사라진다. 그래서 먼저 등록된 것을 유지하고 나중 것은 오류를 남기며 거절한다. 같은 함수를
  // 다시 채우는 것은 같은 모듈의 재등록이므로 거절하지 않는다.
  const had = handlers.get(name);
  if (had && had !== fn) {
    try { console.error("[hooks] 이미 채워진 이름을 다시 채우려 함:", name); } catch {}
    return false;
  }
  handlers.set(name, fn);
  return true;
}

export function callHook(name, ...args) {
  const fn = handlers.get(name);
  return fn ? fn(...args) : undefined;
}

export function hasHook(name) { return handlers.has(name); }
export function hookNames() { return [...handlers.keys()]; }
export function clearHooks() { handlers.clear(); }
