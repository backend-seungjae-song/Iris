// 검증 스키마와 요청 처리기는 해당 세션이 사용하는 Paseo 릴리스에서 주입
export async function applyProviderConfig({ AgentConfigSession, AgentConfigApplySchema, logger, operations, agentId, config }) {
  const message = { type: "agent.config.apply.request", agentId, requestId: agentId, config: AgentConfigApplySchema.parse(config) };
  let response;
  const handler = new AgentConfigSession({
    logger, operations,
    host: { emit(frame) {
      if (frame.type === "agent.config.apply.response") response = frame.payload;
    } },
  });
  await handler.handleAgentConfigApplyRequest(message);
  if (!response?.accepted) throw new Error(response?.error || "Paseo 설정 적용 결과를 확인할 수 없습니다");
  return response.notice ?? null;
}
