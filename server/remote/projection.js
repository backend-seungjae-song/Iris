import { isErrorCode } from "./contract/errors.js";
import { isRemoteOutbound } from "./contract/connection.js";
import { REMOTE_RPC_VERSION } from "./contract/ipc.js";
import {
  isAgentProjection,
  isErrorProjection,
  isItemProjection,
  isOperationProjection,
  isRequestProjection,
} from "./contract/projection.js";

function checked(value, validate) {
  if (!validate(value)) throw new TypeError("원격 projection 계약과 맞지 않습니다.");
  return structuredClone(value);
}

export function projectError(code, rid) {
  return checked({ type: "error", ...(rid === undefined ? {} : { rid }),
    error: { code: isErrorCode(code) ? code : "unavailable" } }, isErrorProjection);
}

export function projectChallenge(source) {
  return checked({
    type: "auth.challenge",
    v: REMOTE_RPC_VERSION,
    serverInstance: source.serverInstance,
    connId: source.connId,
    nonce: source.nonce,
    certHash: source.certHash,
  }, isRemoteOutbound);
}

export function projectAuthResult(resumeToken, pinIdleMinutes) {
  return checked({ type: "auth.ok", v: REMOTE_RPC_VERSION, resumeToken, pinIdleMinutes }, isRemoteOutbound);
}

export function projectPinRequired() {
  return checked({ type: "pin.required", v: REMOTE_RPC_VERSION }, isRemoteOutbound);
}

export function projectPinError(reason, retryAfterMs) {
  return checked({ type: "pin.error", v: REMOTE_RPC_VERSION, reason, retryAfterMs }, isRemoteOutbound);
}

export function projectPairPending(source) {
  return checked({
    type: "pair.pending",
    v: REMOTE_RPC_VERSION,
    deviceId: source.deviceId,
    code: source.code,
  }, isRemoteOutbound);
}

export function projectCaps(requests, macName) {
  return checked({
    type: "caps",
    remoteRpc: REMOTE_RPC_VERSION,
    macName,
    requests: structuredClone(requests),
  }, isRemoteOutbound);
}

export function projectAgent(source) {
  return checked({
    ref: source.ref,
    name: source.name,
    kind: source.kind,
    status: source.status,
    question: source.question,
    space: source.space,
    spaceRef: source.spaceRef,
    spaceOrder: source.spaceOrder,
    sessionOrder: source.sessionOrder,
    parent: source.parent,
    lastActivityAt: source.lastActivityAt,
    can: { stop: source.can.stop, message: source.can.message },
  }, isAgentProjection);
}

export function projectItem(source) {
  return checked({
    role: source.role,
    text: source.text,
    ...(source.tool === undefined ? {} : { tool: source.tool }),
    ...(source.at === undefined ? {} : { at: source.at }),
  }, isItemProjection);
}

export function projectRequest(source) {
  return checked({
    ref: source.ref,
    agent: source.agent,
    kind: source.kind,
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    body: structuredClone(source.body),
  }, isRequestProjection);
}

export function projectPong(rid) {
  return checked({ type: "pong", rid }, isOperationProjection);
}

export function projectAgents(agents) {
  return checked({ type: "agents", agents: agents.map(projectAgent) }, isOperationProjection);
}

export function projectRequests(requests) {
  return checked({ type: "requests", requests: requests.map(projectRequest) }, isOperationProjection);
}

export function projectTranscript({ rid, agent, items, before }) {
  return checked({ type: "transcript", rid, agent, items: items.map(projectItem), before }, isOperationProjection);
}

export function projectTranscriptAppend({ agent, items }) {
  return checked({ type: "transcript.append", agent, items: items.map(projectItem) }, isOperationProjection);
}

export function projectStopResult(rid, result) {
  return checked({ type: "agent.stop.result", rid, result }, isOperationProjection);
}

export function projectMessageResult(rid, result) {
  return checked({ type: "agent.message.result", rid, result }, isOperationProjection);
}

export function projectAnswerResult(rid, result) {
  return checked({ type: "request.answer.result", rid, result }, isOperationProjection);
}

export function projectFeature(value) {
  return checked(value, isOperationProjection);
}
