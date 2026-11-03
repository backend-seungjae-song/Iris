// 다른 앱에서 누른 링크를 받는 창의 역할. 공유 창은 "shared", 콘솔 창은 "session", 나머지는 받지 않음(null)
// 공유 스페이스에서 떼어 낸 탭 분리 창도 space=__shared__ 로 뜨므로 win 값으로 구분
export function linkRole({ browserMode, memoMode, boundSpace, detachedWin }) {
  if (memoMode) return null;
  if (!browserMode) return "session";
  return boundSpace === "__shared__" && !detachedWin ? "shared" : null;
}
