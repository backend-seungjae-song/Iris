import net from "node:net";

import { acceptedPermissionVerdict } from "./protocol.mjs";

const socketPath = process.argv[2];
const paneId = process.env.HERDR_PANE_ID || "";
const cliSession = process.env.CLAUDE_CODE_SESSION_ID || "";
const MAX_LINE = 64 * 1024;
let agent = null;
let latestPermission = null;
let permissionSeq = 0;
let agentReady = false;
let stdinBuffer = "";
let socketBuffer = "";

function writeStdout(value, done) {
  process.stdout.write(`${JSON.stringify(value)}\n`, done);
}

function writeAgent(value) {
  if (!agentReady || !agent || agent.destroyed || !agent.writable) return false;
  return agent.write(`${JSON.stringify(value)}\n`);
}

function handleAgent(value) {
  const verdict = acceptedPermissionVerdict(latestPermission, value);
  if (verdict) {
    writeStdout({ jsonrpc: "2.0", method: "notifications/claude/channel/permission",
      params: verdict });
    latestPermission = null;
    return;
  }
  if (value?.type === "message" && typeof value.msgId === "string" && typeof value.content === "string") {
    writeStdout({ jsonrpc: "2.0", method: "notifications/claude/channel",
      params: { content: value.content, meta: { sender: "iris_phone", msg_id: value.msgId } } }, () => {
      writeAgent({ type: "message_written", msgId: value.msgId });
    });
  }
}

function consumeSocket(chunk) {
  socketBuffer += chunk;
  if (socketBuffer.length > MAX_LINE) return agent?.destroy();
  let newline;
  while ((newline = socketBuffer.indexOf("\n")) >= 0) {
    const line = socketBuffer.slice(0, newline); socketBuffer = socketBuffer.slice(newline + 1);
    if (!line) continue;
    try { handleAgent(JSON.parse(line)); } catch {}
  }
}

if (socketPath && paneId && cliSession) {
  agent = net.createConnection(socketPath);
  agent.setEncoding("utf8");
  agent.on("connect", () => {
    agentReady = true;
    writeAgent({ role: "channel", v: 1, paneId, cliSession });
  });
  agent.on("data", consumeSocket);
  agent.on("error", () => {});
  agent.on("close", () => { agentReady = false; agent = null; latestPermission = null; });
}

function handleMcp(message) {
  if (message?.method === "initialize" && message.id !== undefined) {
    writeStdout({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
      serverInfo: { name: "iris-remote", version: "1.0.0" },
      instructions: "Messages from the Iris phone arrive as user instructions.",
    } });
    return;
  }
  if (message?.method === "notifications/claude/channel/permission_request") {
    const value = message.params;
    if (!agentReady || !value || ![value.request_id, value.tool_name, value.description, value.input_preview]
      .every((field) => typeof field === "string")) return;
    permissionSeq += 1;
    latestPermission = { requestId: value.request_id, seq: permissionSeq };
    writeAgent({ type: "permission_request", requestId: value.request_id, seq: permissionSeq, tool: value.tool_name,
      description: value.description, input: value.input_preview });
    return;
  }
  if (message?.id !== undefined && typeof message.method === "string") {
    writeStdout({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [] } : {} });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  if (stdinBuffer.length > MAX_LINE) return process.exit(0);
  let newline;
  while ((newline = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, newline); stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!line) continue;
    try { handleMcp(JSON.parse(line)); } catch {}
  }
});
