// 경로에서 레포 이름을 추출한다.
//
// 소유 범위
//   "/a/b/iris" → "iris" 한 가지 규칙.
//
// 제공 API
//   repoNameOf(root).
//
// core 에 둔 이유
//   깃 화면과 diff 화면이 같은 이름을 써야 하는데, 이것은 깃 기능이 아니라 경로 계산이다.
//   깃 쪽에 두면 깃을 끈 사용자의 diff 탭이 이름을 잃고, diff 쪽에 두면 같은 규칙이 두 벌이 된다.
//
// 영향 범위
//   devtool/source-control.js · devtool/diff.js.

export function repoNameOf(root) {
  return String(root || "").split("/").filter(Boolean).pop() || root;
}
