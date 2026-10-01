import { projectError, projectStopResult } from "../projection.js";

export function createStopOperation(options) {
  const agents = options.agents;
  // 서버 기동 순서상 capability 초기화 뒤에 herdr 연결
  const getHerdr = options.getHerdr || (() => null);

  return async function handleStop(_entry, message) {
    const agent = agents.resolve(message.agent);
    if (!agent) return projectError("forbidden", message.rid);
    if (agent.kind !== "claude" && agent.kind !== "codex") return projectStopResult(message.rid, "unsupported");
    if (agent.status !== "working") return projectStopResult(message.rid, "not-working");
    const herdr = getHerdr();
    if (!herdr || typeof herdr.paneSendText !== "function") return projectError("unavailable", message.rid);
    try {
      await herdr.paneSendText(agent.source.paneId, "\x1b");
      return projectStopResult(message.rid, "sent");
    } catch {
      return projectError("unavailable", message.rid);
    }
  };
}
