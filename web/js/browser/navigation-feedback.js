// 주소창은 마지막 완료 주소와 현재 이동 목적지를 구분한다. 탭을 바꿔도 그 탭의 진행 상태를 복원한다.
export function beginNavigation(rec, url) {
  rec.loadingUrl = String(url || "");
  rec.navigationState = "loading";
  rec.failedUrl = "";
}
export function endNavigation(rec, url) {
  if (rec.navigationState === "failed") return;
  if (url) rec.url = url;
  rec.loadingUrl = "";
  rec.navigationState = "idle";
}
export function failNavigation(rec, url, canceled = false) {
  // 이전 이동의 취소가 새 이동의 목적지나 로딩 표시를 지우면 안 된다.
  if (url && rec.loadingUrl && url !== rec.loadingUrl) return false;
  rec.failedUrl = canceled ? "" : String(url || rec.loadingUrl || "");
  rec.loadingUrl = "";
  rec.navigationState = canceled ? "canceled" : "failed";
  return true;
}
export function navigationDisplay(rec) {
  const url = rec.loadingUrl || rec.failedUrl || rec.url || "";
  const note = rec.navigationState === "loading" ? "여는 중… " + url
    : rec.navigationState === "canceled" ? "이동을 취소했습니다." : "";
  return { url, note };
}
