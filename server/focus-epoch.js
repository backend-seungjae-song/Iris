// 사용자가 요청한 포커스 변경과 관제 snapshot 의 선후 관계를 세는 모듈.
//
// herdr 호출은 하나에 약 100ms 걸리고 snapshot 은 여러 호출을 거쳐 만들어진다. 포커스 요청이
// 끝나기 전에 agent.list 를 받은 snapshot 은 옛 포커스를 담고 있어서, 창이 그 방송을 믿으면
// 사용자가 고른 세션을 직전 세션으로 되돌린다. 그래서 snapshot 을 만들기 시작할 때 표를 받고,
// 끝날 때 그 사이에 포커스 요청이 진행 중이었거나 끝났는지를 묻는다.

let pending = 0;
let done = 0;

export function beginFocus() { pending++; }
export function endFocus() { pending = Math.max(0, pending - 1); done++; }

export function focusMark() { return { done, pending }; }

// mark 를 받은 뒤 포커스 요청이 끝났거나 지금도 진행 중이면 그 snapshot 의 포커스는 믿을 수 없다.
export function focusChangedSince(mark) {
  return pending > 0 || mark.pending > 0 || done !== mark.done;
}

export function resetFocusEpoch() { pending = 0; done = 0; }
