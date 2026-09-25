// 공통 북마크. 모든 스페이스의 북마크바 앞쪽에 같은 목록을 보여 준다.
//
// 소유 범위
//   공통 목록을 북마크바에 내주는 이름 하나(commonbookmarks.list). 상태는 갖지 않는다.
//
// 제공 API
//   initCapability(ctx). 앱 셸이 부르는 이름은 commonbookmarks.list 하나다.
//
// 의존 대상
//   목록의 정본은 서버의 bookmarksCommon 이고, 그리기·편집·끌어 옮기기는 앱 셸의
//   browser/bookmarks.js 가 세션 구역과 같은 코드로 한다. 여기서는 ctx 로 받은 것만 쓴다.
//
// 유지 조건
//   이 파일을 앱 셸이 정적으로 import 하면 "끈 기능은 로드되지 않는다"가 깨진다.
//   끄면 이 이름이 채워지지 않아 북마크바는 세션 구역 하나만 그린다. 서버의 공통 목록은 지우지
//   않으므로 다시 켜면 그대로 돌아온다.
//
// 영향 범위
//   browser/bookmarks.js 의 구역 판정. 현재 목록: node bin/importers.mjs web/js/browser/common-bookmarks.js
import { provide } from "../core/hooks.js";

export function initCapability(ctx) {
  provide("commonbookmarks.list", () => {
    const list = ctx.getBrowserState().bookmarksCommon;
    return Array.isArray(list) ? list : [];
  });
  // 설정에서 지금 켠 경우에는 브로드캐스트를 기다리지 않고 바로 공통 구역을 그린다.
  ctx.renderBookmarks();
  return {};
}
