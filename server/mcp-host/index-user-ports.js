export function createIndexUserPorts({ consoleAsk, notifyHostUser, progressHostUser } = {}) {
  if (![consoleAsk, notifyHostUser, progressHostUser].every(value => typeof value === "function")) {
    throw new Error("index user port 함수가 필요합니다.");
  }
  return {
    ask: ({ input }) => consoleAsk(input._kind === "approve" ? "approve" : "ask", input.message, input.choices),
    notify: ({ identity, input }) => notifyHostUser(input, identity.session),
    progress: ({ identity, input }) => progressHostUser(input, identity.session),
  };
}
