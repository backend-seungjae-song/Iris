// 질문 카드 버튼 id ↔ 선택지 순서
// - 화면 줄 번호를 id 로 쓰지 않음. 같은 질문이 다시 그려지면 줄이 바뀌는데 Paseo 는 같은 질문 id 의 첫 버튼을 그대로 둠
//   → 예전 줄 번호가 다른 선택지를 가리킴(거절을 눌렀는데 「항상 허용」이 들어간 사례)
// - 영향 범위: iris-agent-meta.ts(permissionRequest·answerRow), test/agent-chat.mjs

export const actionId = (index) => `option-${index}`;

// 줄 번호를 보내던 이전 화면의 거절 응답도 현재 거절 선택지에만 연결
export function answerIndex(options, response) {
  const { selectedActionId, behavior } = response ?? {};
  const match = /^option-(\d+)$/.exec(String(selectedActionId ?? ""));
  if (match) {
    const index = Number(match[1]);
    const option = options[index];
    if (!option || (behavior !== undefined && behavior !== (option.role === "deny" ? "deny" : "allow"))) return null;
    return index;
  }
  if (behavior !== "deny" && !(selectedActionId == null && behavior === "allow")) return null;
  const index = options.findIndex(option => option.role === behavior);
  return index >= 0 ? index : null;
}
