export function createIndexUserPorts({ consoleAsk, notifyHostUser, progressHostUser, releaseSessionControl = () => {} } = {}) {
  if (![consoleAsk, notifyHostUser, progressHostUser, releaseSessionControl].every(value => typeof value === "function")) {
    throw new Error("index user port 함수가 필요합니다.");
  }
  return {
    ask: ({ identity, input }) => {
      // 사람에게 묻는 동안 그 세션의 탭이 조작 중으로 남으면 사람이 로그인할 때 저장된 계정 자동 완성이 막힘
      // QA 회차는 회차끼리 같은 표시 이름(iris-qa)을 써서 다른 회차의 표시까지 지우게 되므로 제외
      if (identity?.session && !identity.run) releaseSessionControl(identity.session);
      return consoleAsk(input._kind === "approve" ? "approve" : "ask", input.message, input.choices);
    },
    notify: ({ identity, input }) => notifyHostUser(input, identity.session),
    progress: ({ identity, input }) => progressHostUser(input, identity.session),
  };
}
