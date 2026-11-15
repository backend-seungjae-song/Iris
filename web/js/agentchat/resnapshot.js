// 연 대화에 이어 붙인 메시지가 이만큼 쌓이면 최근 기록만 다시 받음
// - 이어 붙이기만 하면 대화 화면 iframe 이 연 뒤의 모든 메시지를 화면 행으로 들고 있어 몇 시간에 GB 단위로 커짐(2026-11-14 본창 2.9GB)
// - 이전 기록 불러오기로 늘어난 것은 세지 않음. 사용자가 읽으려고 불러온 기록을 지우지 않게
export const RESNAPSHOT_APPENDED = 600;

export function needsResnapshot(view) {
  return !!view && !view.loadingOlder && (view.appended || 0) > RESNAPSHOT_APPENDED;
}
