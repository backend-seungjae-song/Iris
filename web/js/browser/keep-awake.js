// 잠들지 않게 한 브라우저 탭의 표시와 우클릭 메뉴 줄. 콘솔 탭바(center/tabs·tab-close)와 분리 창 탭바(browser/tabs)가 함께 씀
import { bsMutate } from "./state.js";

// 잠들지 않게 한 탭의 표시. 앞머리·이름 앞 자리는 다른 상태(로딩·소리·저장 안 됨·질문·AI)가 쓰므로 이름 뒤
export function keepAwakeMark(on) {
  if (!on) return "";
  return '<span class="ckeep" role="img" aria-label="잠들지 않음" title="잠들지 않음 · 우클릭 메뉴에서 끄기">'
    + '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/></svg></span>';
}
// 우클릭 메뉴 줄
export function keepAwakeItem(sp, tab) {
  const on = !!(tab && tab.keepAwake);
  return { label: on ? "잠들지 않게 끄기" : "잠들지 않게 하기", act: () => bsMutate({ op: "tab.keepAwake", space: sp, id: tab.id, on: !on }) };
}
