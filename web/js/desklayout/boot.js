// 창 레이아웃 저장·복원(desklayout)의 렌더러 쪽 입구.
//
// 소유 범위
//   이 기능의 등록표 계약을 만족하는 진입점. 화면·상태를 갖지 않는다.
//
// 제공 API
//   initCapability(ctx). rail도 panel도 없으므로 screen·panelHtml은 반환하지 않는다.
//
// 의존 대상
//   core/hooks.js 의 provide. 저장·복원·단축키·타이머는 모두 네이티브 쪽(native/electron/desk-layout/)이
//   소유하고, 그쪽은 IPC(ac-desklayout-save-now·restore-now·disable)로만 열려 있다.
//
// 유지 조건
//   화면이 없는 기능이므로 screen을 반환하면 안 된다(설계 1·2-2절 — 반환하면 진입 경로가
//   없는 화면이 되어 이 기능만 실패 처리된다). ws 처리기도 없다. 서버 메시지가 아니라
//   네이티브 IPC로만 동작한다.
//
// 영향 범위
//   web/js/core/capabilities.js의 desklayout 줄. 그 밖에는 없다.
//   현재 목록 확인: node bin/importers.mjs web/js/desklayout/boot.js

import { provide } from "../core/hooks.js";

export function initCapability(ctx = {}) {
  // 설정에서 이 기능을 끌 때 core/features.js 가 부른다. 재시작 전까지 네이티브 쪽이 계속 돌지 않도록
  // 단축키·타이머를 내리고, 이 기능이 켰던 로그인 항목을 되돌린다. 끄기 자체는 막지 않으므로 실패는 알리기만 한다.
  provide("desklayout.disabling", async () => {
    let result = null;
    try { result = await window.acHost?.deskLayoutDisable?.(); } catch {}
    if (!result || !result.ok) {
      ctx.showToast?.("창 레이아웃을 바로 멈추지 못했습니다. 앱을 다시 시작하면 멈춥니다. 로그인 항목은 시스템 설정 > 일반 > 로그인 항목에서 꺼 주세요");
    }
  });
  return {};
}
