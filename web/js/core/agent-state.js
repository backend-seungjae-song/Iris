// 상태 점의 판정과 이름. 점을 그리는 모든 곳(스페이스 줄·에이전트 줄·오른쪽 머리·창 번호 줄)이
// 이 파일 하나로 class 와 툴팁을 정한다. 색은 web/css/00-tokens.css 의 --st-* 토큰이 갖는다.
//
// herdr 상태는 working·idle·done·blocked·unknown 다섯이다. unknown 은 비활성화로 그린다.
// 질문 있음은 herdr 에 없는 상태라 서버(server/agent-question.js)가 붙인 question 으로 정한다.
export const STATE_LABEL = {
  working: "작업 중",
  done: "작업 완료",
  idle: "비활성화",
  blocked: "멈춤(답 대기)",
  question: "질문 있음",
};

export function agentState(status, question) {
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "done" || status === "idle") return question ? "question" : status;
  return "idle";
}

// 스페이스 줄: 스페이스 상태가 done·idle 이고 그 스페이스 에이전트 중 질문을 남긴 것이 있으면 질문 있음.
export function spaceState(status, agents, spaceId) {
  const asked = (agents || []).some((a) => a.workspaceId === spaceId && a.question);
  return agentState(status, asked);
}
// 점 옆에 적는 상태 이름. 점과 같은 판정을 쓴다.
export const stateLabel = (a) => STATE_LABEL[agentState(a?.status, a?.question)];

// 오른쪽 머리처럼 이미 있는 점 요소를 에이전트 하나의 상태로 다시 칠한다. 에이전트가 없으면 비활성화.
export function paintStateDot(el, a) {
  const st = agentState(a?.status, a?.question);
  el.className = "dot " + st;
  el.title = STATE_LABEL[st];
  el.setAttribute("aria-label", STATE_LABEL[st]); // 점은 role="img" 라 스크린리더가 이 이름을 읽는다
}
