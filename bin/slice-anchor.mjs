// 소스에서 절 하나만 떼어 보는 슬라이스. 기준점을 못 찾으면 실패한다.
//
// 이것이 존재하는 이유는 하나다. `indexOf` 는 못 찾으면 예외가 아니라 -1 을 주고,
// `slice(-1, …)` 는 오류 없이 거의 빈 문자열을 돌려준다. 그 조각에 대한
// "이 규칙이 없어야 한다"(doesNotMatch · !/…/) 조건은 전부 통과한다.
// 검사는 통과하지만 실제로는 아무것도 확인하지 않은 상태다.
//
// 모듈을 떼면 기준점이 바뀐다. `function X` 였던 것이 `export function X` 나
// `exports.X` 가 된다. 그래서 이 실패는 가정이 아니라 이 저장소에서 실제로 발생했다.
// test/login-session-ownership.mjs 가 분해 1단계부터 그 상태로 통과하고 있었다.
//
// bin/smoke/** 의 섹션 열 곳과 test/** 가 같은 것을 쓴다. 정의가 둘이면 한쪽만 고쳐진다.

export function sliceBetween(src, startAnchor, endAnchor, label = "") {
  const a = src.indexOf(startAnchor);
  if (a < 0) throw new Error(`슬라이스 시작 기준점 없음${label ? ` (${label})` : ""}: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  if (b < 0) throw new Error(`슬라이스 끝 기준점 없음${label ? ` (${label})` : ""}: ${endAnchor}`);
  return src.slice(a, b);
}

// 끝 기준점 대신 길이로 자르는 함수. 길이는 절이 길어지면 일치하지 않으므로 새로 쓰지 않는다.
// 기존 호출을 옮길 때만 쓰고, 가능하면 끝 기준점을 찾아 sliceBetween 으로 바꾼다.
export function sliceFrom(src, startAnchor, len, label = "") {
  const a = src.indexOf(startAnchor);
  if (a < 0) throw new Error(`슬라이스 시작 기준점 없음${label ? ` (${label})` : ""}: ${startAnchor}`);
  return src.slice(a, a + len);
}
