import { createHash } from "node:crypto";
import { applyA2uiMessages, extractA2uiBlocks } from "../agent-chat-a2ui.js";

const FENCE_START = "```a2ui";
const MAX_MARKDOWN_LENGTH = 256 * 1024;
const MAX_REPLAYED_MESSAGES = 128;

function createReplayFilter(surfaces, changed) {
  const replayed = new Set();

  return function apply(messages) {
    const fresh = messages.filter((message) => {
      const id = createHash("sha256").update(JSON.stringify(message)).digest("hex");
      if (replayed.has(id)) return false;
      if (replayed.size >= MAX_REPLAYED_MESSAGES) replayed.delete(replayed.values().next().value);
      replayed.add(id);
      return true;
    });
    if (applyA2uiMessages(surfaces, fresh)) changed();
  };
}

export function createSnapshotA2ui(surfaces, changed) {
  const apply = createReplayFilter(surfaces, changed);
  let previousCount = 0, previousDigest = "";
  return frame => {
    const items = frame.timelineRows?.map(row => row.item) ?? frame.timeline ?? [];
    const messages = items.flatMap(item => item?.type === "assistant_message" ? extractA2uiBlocks(item.text) : []);
    const digest = createHash("sha256");
    let start = 0;
    for (let index = 0; index < messages.length; index++) {
      digest.update(JSON.stringify(messages[index])).update("\n");
      if (index + 1 === previousCount && digest.copy().digest("hex") === previousDigest) start = previousCount;
    }
    previousCount = messages.length;
    previousDigest = digest.digest("hex");
    apply(messages.slice(start));
  };
}

export function createManagedA2ui(agentId, surfaces, changed) {
  const apply = createReplayFilter(surfaces, changed);
  let turn = null;
  let tail = "";

  return (data) => {
    if (!data.includes(FENCE_START) && !data.includes('"agent_stream"')) return;
    let message;
    try { message = JSON.parse(data).message; } catch { return; }
    const payload = message?.payload;
    if (payload?.agentId !== agentId) return;
    if (message.type === "fetch_agent_timeline_response") {
      if (Array.isArray(payload.entries)) {
        apply(payload.entries.flatMap((entry) => entry?.item?.type === "assistant_message" ? extractA2uiBlocks(entry.item.text) : []));
      }
      return;
    }
    const event = payload.event;
    if (message.type !== "agent_stream" || event?.type !== "timeline" || event.item?.type !== "assistant_message") return;
    const nextTurn = event.turnId ?? null;
    if (nextTurn !== turn) { tail = ""; turn = nextTurn; }
    const text = tail + event.item.text;
    apply(extractA2uiBlocks(text));
    // 완결되지 않은 A2UI 블록만 다음 스트림 메시지까지 보관
    const start = text.lastIndexOf(FENCE_START);
    tail = start >= 0 && !text.slice(start + FENCE_START.length).includes("```")
      ? text.slice(start, start + MAX_MARKDOWN_LENGTH)
      : text.slice(-(FENCE_START.length - 1));
  };
}
