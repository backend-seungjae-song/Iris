// 대화 행을 처음부터 다시 만든 뒤 Paseo 앱에 알리는 방법
// - Paseo 앱은 대화마다 마지막으로 받은 epoch 를 저장하고 다른 epoch 의 행 알림은 버림(classifySessionTimelineSeq drop_epoch)
// - shim 은 대화를 바꿀 때 epoch 를 새로 만듦. 앞서 본 대화로 돌아오면 앱은 기록을 다시 요청하지 않고 새 행 알림도 버림
//   → 바꾼 뒤 처음 행이 생기면 기록을 다시 받게 함(replace)
// - 반환: replace 다시 받게 · stream 행마다 알림 · none 알리지 않음(앱이 대화를 열며 직접 받음)
export function rebuiltRowsNotice({ hadRows, switchedSinceRows, fresh, count }) {
  if (hadRows) return "replace";
  if (switchedSinceRows && count > 0) return "replace";
  return fresh ? "none" : "stream";
}
