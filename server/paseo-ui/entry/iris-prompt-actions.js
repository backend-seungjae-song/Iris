// 질문 카드 버튼 id ↔ 선택지 순서
// - 화면 줄 번호를 id 로 쓰지 않음. 같은 질문이 다시 그려지면 줄이 바뀌는데 Paseo 는 같은 질문 id 의 첫 버튼을 그대로 둠
//   → 예전 줄 번호가 다른 선택지를 가리킴(거절을 눌렀는데 「항상 허용」이 들어간 사례)
// - 영향 범위: iris-agent-meta.ts(permissionRequest·answerRow), test/agent-chat.mjs

export const actionId = (index) => `option-${index}`;

// 앱의 답 → 선택지 순서. id 가 없거나 모르면 behavior 로 첫 선택지(deny 는 거절 역할, 나머지는 허용 쪽)
export function answerIndex(options, response) {
  const m = /^option-(\d+)$/.exec(String(response?.selectedActionId ?? ""));
  if (m) {
    const i = Number(m[1]);
    return i < options.length ? i : null;
  }
  const want = response?.behavior === "deny" ? "deny" : "allow";
  const i = options.findIndex((o) => (o.role === "deny" ? "deny" : "allow") === want);
  return i >= 0 ? i : null;
}
