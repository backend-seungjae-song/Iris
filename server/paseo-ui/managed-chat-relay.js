import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

// Paseo 파일 전송 프레임 opcode. 터미널·플러그인·분할 메시지는 여기서 받지 않음
const FILE_END_OPCODE = 0x12;
const FILE_FRAME_OPCODES = new Set([0x10, 0x11, FILE_END_OPCODE]);

function withinWorkspace(cwd, value) {
  if (typeof cwd !== "string" || typeof value !== "string" || /^~/.test(value)) return false;
  const root = fs.realpathSync(cwd);
  const requested = fs.realpathSync(path.resolve(cwd, value));
  const relative = path.relative(root, requested);
  return !path.isAbsolute(relative) && relative.split(path.sep, 1)[0] !== "..";
}

function scopeMatches(message, pane) {
  for (const [key, value] of Object.entries(message)) {
    if (value == null) continue;
    if (/^(?:agentIds?|.*AgentIds?)$/.test(key)) {
      if (!(Array.isArray(value) ? value : [value]).every((id) => id === pane.agentId)) return false;
    } else if (/^(?:workspaceId|focusedWorkspaceId)$/.test(key) && value !== pane.workspaceId) return false;
    else if (/^(?:serverId|sourceAgentServerId)$/.test(key) && value !== pane.serverId) return false;
    else if (/^(?:cwd|path)$|(?:Cwd|Path|Root|Directory)$/.test(key) && !withinWorkspace(pane.cwd, value)) return false;
    else if (key === "cursors" && Object.keys(value).some((id) => id !== pane.agentId)) return false;
    else if ((key === "filter" || key === "draftConfig" || key === "target") && typeof value === "object" && !scopeMatches(value, pane)) return false;
  }
  return true;
}

function isAllowed(message, pane, requiredPermissionForInbound) {
  const required = requiredPermissionForInbound(message.type);
  if (required === null) return message.type === "subscription.release.request";
  const permissions = Array.isArray(required) ? required : [required];
  if (!scopeMatches(message, pane)) return false;
  // 홈 디렉터리까지 검색하는 위임 요청의 범위 제한
  if (message.type === "project.suggestions.request" || message.type === "fetch_recent_provider_sessions_request") return false;
  if (message.type === "directory_suggestions_request" && !message.cwd) return false;
  if (permissions.includes("workspace.read") || permissions.includes("daemon.read")) return true;
  if (!permissions.includes("workspace.write")) return false;
  if (message.type === "file.upload.request") {
    return Number.isSafeInteger(message.size) && message.size >= 0 && message.size <= 30 * 1024 * 1024;
  }
  if (message.type === "clear_agent_attention" && Array.isArray(message.agentId)) return message.agentId.length === 1;
  return message.agentId === pane.agentId;
}

export function connectManagedChat(pane, requiredPermissionForInbound, deliver) {
  const upstream = new WebSocket(`ws+unix://${pane.socketPath}:/ws`, { maxPayload: MAX_FRAME_BYTES });
  let closed = false;
  let hello = false;
  const uploads = new Set();
  upstream.on("open", () => { if (!closed) deliver({ event: "open" }); });
  upstream.on("message", (data, binary) => {
    if (!closed) deliver({ event: "message", data: data.toString(binary ? "base64" : "utf8"), ...(binary ? { binary: true } : {}) });
  });
  upstream.on("error", () => {});
  upstream.on("close", (code) => { if (!closed) deliver({ event: "close", code }); });

  return {
    send({ data, binary }) {
      if (closed || upstream.readyState !== WebSocket.OPEN || typeof data !== "string" || data.length > MAX_FRAME_BYTES) return;
      if (upstream.bufferedAmount > MAX_PENDING_BYTES) { upstream.close(1013); return; }
      if (binary === true) {
        if (!uploads.size) return;
        const bytes = Buffer.from(data, "base64");
        const [opcode, idLength] = bytes;
        if (!FILE_FRAME_OPCODES.has(opcode) || !idLength || idLength > bytes.length - 2) return;
        const requestId = bytes.toString("utf8", 2, 2 + idLength);
        if (!uploads.has(requestId)) return;
        upstream.send(bytes);
        if (opcode === FILE_END_OPCODE) uploads.delete(requestId);
        return;
      }
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (!hello && frame?.type === "hello") {
        hello = true;
        const clientId = pane.clientNamespace && typeof frame.clientId === "string"
          ? `iris_${createHash("sha256").update(pane.clientNamespace).update("\0").update(frame.clientId).digest("hex").slice(0, 32)}`
          : frame.clientId;
        // 권한 검사는 JSON 원본을 받는 연결에서만 수행
        upstream.send(JSON.stringify({ ...frame, clientId, capabilities: { ...frame.capabilities, binary_chunking_v1: false } }));
        return;
      }
      if (!hello) return;
      if (frame?.type === "ping") { upstream.send(data); return; }
      if (frame?.type !== "session" || typeof frame.message?.type !== "string") return;
      const upload = frame.message.type === "file.upload.request";
      let allowed = false;
      try { allowed = isAllowed(frame.message, pane, requiredPermissionForInbound); } catch { /* 경로가 없거나 읽을 수 없음 */ }
      if (allowed && (!upload || (uploads.size < 4 && typeof frame.message.requestId === "string"))) {
        if (upload) uploads.add(frame.message.requestId);
        upstream.send(data);
      } else if (typeof frame.message.requestId === "string") {
        const { requestId, type: requestType } = frame.message;
        deliver({ event: "message", data: JSON.stringify({ type: "session", message: {
          type: "rpc_error", payload: { requestId, requestType, error: "현재 대화에서 실행할 수 없는 요청입니다", code: "unsupported" },
        } }) });
      }
    },
    close() {
      closed = true;
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    },
  };
}
