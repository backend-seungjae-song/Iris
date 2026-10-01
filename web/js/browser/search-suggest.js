// Google 검색어 추천.
// 소유 범위: 검색어 추천 hook과 네이티브 요청 연결.
// 제공 API: initCapability().
// 의존 대상: core/hooks와 acHost.searchSuggestions.
// 유지 조건: 기능을 껐을 때 이 모듈을 로드하지 않는다. 통신 실패는 빈 목록으로 반환한다.
// 영향 범위: browser/bookmarks의 기존 주소창 제안 목록.
import { provide } from "../core/hooks.js";

async function querySuggestions(query) {
  try { return await window.acHost?.searchSuggestions?.(query) || []; }
  catch { return []; }
}

export function initCapability() {
  provide("searchsuggest.query", querySuggestions);
  return {};
}
