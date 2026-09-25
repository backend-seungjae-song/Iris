// Chrome에 설치된 React Developer Tools를 native persistent session에 로드하는 renderer capability.
//
// 소유 범위
//   native enable 결과의 toast와 extensionloader.before-devtools provider.
//
// 제공 API
//   initCapability(ctx).
//
// 의존 대상
//   ctx.acHost의 제한된 enableExtensionLoader/waitForExtension bridge와 ctx.showToast. acHost 가 없으면 미지원.
//
// 유지 조건
//   Chrome path·extension id·Electron session API를 알지 않는다. DevTools를 열기 전에는 현재
//   webview partition의 native load Promise가 끝나야 하며 실패를 성공으로 바꾸지 않는다.
//
// 영향 범위
//   core/capabilities.js의 extensionloader 행, panel/touch-drag.js의 before-devtools 호출,
//   native/electron/preload.cjs의 제한 bridge, bin/smoke/sections/extension-loader.mjs.

import { provide } from "../core/hooks.js";

function failureSummary(results) {
  return results.filter((result) => !result.ok)
    .map((result) => `${result.partition || "알 수 없는 세션"}(${result.stage || "load"})`)
    .join(", ");
}

export async function initCapability(ctx = {}) {
  const host = ctx.acHost;
  // native bridge 자체가 없는 창(일반 브라우저·원격 접속)은 확장을 실을 곳이 없으므로 조용히 미지원으로 둔다.
  // bridge 는 있는데 확장 로더 함수가 빠졌으면 preload 와 어긋난 것이라 오류로 알린다.
  if (host == null) return {};
  if (typeof host.enableExtensionLoader !== "function" || typeof host.waitForExtension !== "function") {
    throw new Error("확장 로더 native bridge가 없습니다");
  }
  provide("extensionloader.before-devtools", async ({ partition } = {}) => {
    const result = await host.waitForExtension(partition);
    if (!result || !result.ok) {
      const stage = result && result.stage || "devtools-ready";
      throw new Error(`${partition || "현재 세션"} 확장 준비 실패 (${stage})`);
    }
    return result;
  });

  const aggregate = await host.enableExtensionLoader();
  const results = Array.isArray(aggregate && aggregate.results) ? aggregate.results : [];
  if (!aggregate || !aggregate.ok) {
    ctx.showToast?.(`React 개발자 도구 로드 실패: ${failureSummary(results) || "native 응답 없음"}`);
  } else {
    ctx.showToast?.(`React 개발자 도구를 ${results.length}개 세션에 로드했습니다. 열린 페이지는 새로고침하세요.`);
  }
  return {};
}
