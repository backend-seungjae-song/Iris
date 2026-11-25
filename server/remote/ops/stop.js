import { projectError, projectStopResult } from "../projection.js";
import { isActualEmbedded } from "../agents.js";

export function createStopOperation(options) {
  const agents = options.agents;
  // 서버 기동 순서상 capability 초기화 뒤에 herdr 연결
  const getHerdr = options.getHerdr || (() => null);

  return async function handleStop(_entry, message) {
    const agent = agents.resolve(message.agent);
    if (!agent) return projectError("forbidden", message.rid);
    if (isActualEmbedded(agent.source)) return projectStopResult(message.rid, "unsupported");
    if (agent.source?.managedProvider) {
      const result = await options.messages?.stopManaged?.(agent, () => agents.resolve(message.agent));
      if (result === "forbidden") return projectError("forbidden", message.rid);
      if (result === "sent" || result === "not-working") return projectStopResult(message.rid, result);
      return projectError("unavailable", message.rid);
    }
    if (agent.kind !== "claude" && agent.kind !== "codex") return projectStopResult(message.rid, "unsupported");
    if (agent.status !== "working") return projectStopResult(message.rid, "not-working");
    const herdr = getHerdr();
    if (typeof herdr?.paneGet !== "function" || typeof herdr.paneSendText !== "function") return projectError("unavailable", message.rid);
    try {
      const live = await herdr.paneGet(agent.source.paneId);
      const current = agents.resolve(message.agent);
      if (!current || current.source.managedProvider || isActualEmbedded(current.source)) return projectError("forbidden", message.rid);
      if (live?.pane_id !== current.source.paneId ||
        !String(live.agent || "").toLowerCase().startsWith(current.kind) || (current.source.terminalId && live.terminal_id !== current.source.terminalId)) {
        return projectError("forbidden", message.rid);
      }
      await herdr.paneSendText(current.source.paneId, "\x1b");
      return projectStopResult(message.rid, "sent");
    } catch {
      return projectError("unavailable", message.rid);
    }
  };
}
