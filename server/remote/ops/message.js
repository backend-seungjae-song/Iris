import { projectError, projectMessageResult } from "../projection.js";

export function createMessageOperation(options) {
  const agents = options.agents;
  const messages = options.messages;

  const browserDrafts = options.browserDrafts;

  return async function handleMessage(entry, message) {
    const agent = agents.resolve(message.agent);
    if (!agent) return projectError("forbidden", message.rid);
    if (agent.kind !== "claude" && agent.kind !== "codex") return projectMessageResult(message.rid, "unsupported");
    const expanded = browserDrafts?.expandDrafts(entry.connId, message.agent, message.drafts || [], message.text)
      || { ok: !message.drafts?.length, text: message.text, consume() {} };
    if (!expanded.ok) return projectError(expanded.code || "forbidden", message.rid);
    const result = await messages.send(agent, expanded.text, () => agents.resolve(message.agent));
    if (result === "forbidden") return projectError("forbidden", message.rid);
    if (result === "sent" || result === "delivered") {
      expanded.consume();
      options.transcripts?.refreshAgent?.(message.agent);
    }
    return projectMessageResult(message.rid, result);
  };
}
