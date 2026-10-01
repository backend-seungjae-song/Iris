import { isRemoteRequest } from "./contract/requests.js";
import { messageFor } from "./messages.js";
import { validAccessPin } from "./pin.js";

const TYPES = new Map([
  ["remote.status", { method: "sendState", fields: [] }],
  ["remote.enable", { method: "requestEnable", fields: [] }],
  ["remote.disable", { method: "requestDisable", fields: [] }],
  ["remote.retry-stop", { method: "retryStop", fields: [] }],
  ["remote.pair.start", { method: "requestPairStart", fields: [] }],
  ["remote.pair.confirm", { method: "requestPairConfirm", fields: ["code"] }],
  ["remote.pair.cancel", { method: "requestPairCancel", fields: [] }],
  ["remote.device.remove", { method: "removeDevice", fields: ["deviceId"] }],
  ["remote.pin.set", { method: "setAccessPin", fields: ["pin", "confirmation"], response: "remote.pin.result" }],
  ["remote.pin-idle.set", { method: "setPinIdleMinutes", fields: ["minutes"], response: "remote.pin-idle.result" }],
  ["remote.request.answer", { method: "answerRequest", fields: ["request", "answer"], response: "remote.request.answer.result" }],
  ["remote.question-hook.install", { method: "installQuestionHook", fields: [], response: "remote.question-hook.result" }],
  ["remote.question-hook.remove", { method: "removeQuestionHook", fields: [], response: "remote.question-hook.result" }],
  ["remote.tailscale.status", { method: "sendTailscale", fields: [] }],
  ["remote.tailscale.install", { method: "installTailscale", fields: [] }],
  ["remote.tailscale.start", { method: "startTailscale", fields: [] }],
  ["remote.tailscale.connect", { method: "connectTailscale", fields: [] }],
]);

function send(ws, message) {
  try { ws.send(JSON.stringify(message)); } catch {}
}


function sendError(ws, requestId, code, message = messageFor(code)) {
  send(ws, { type: "remote.error", requestId: requestId || null, code, message });
}

function validMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const rule = TYPES.get(message.type);
  if (!rule) return false;
  const allowed = new Set(["type", "requestId", ...rule.fields]);
  if (Object.keys(message).some((key) => !allowed.has(key))) return false;
  if (message.requestId !== undefined
    && (typeof message.requestId !== "string" || message.requestId.length === 0 || message.requestId.length > 100)) return false;
  if (rule.fields.some((field) => !Object.hasOwn(message, field))) return false;
  if (message.type === "remote.pair.confirm"
    && (typeof message.code !== "string" || !/^\d{6}$/.test(message.code))) return false;
  if (message.type === "remote.device.remove"
    && (typeof message.deviceId !== "string" || !/^[0-9a-f]{32}$/.test(message.deviceId))) return false;
  if (message.type === "remote.pin.set"
    && (!validAccessPin(message.pin) || !validAccessPin(message.confirmation))) return false;
  if (message.type === "remote.pin-idle.set" && ![10, 20, 30, 60].includes(message.minutes)) return false;
  if (message.type === "remote.request.answer"
    && !isRemoteRequest({ type: "request.answer", rid: "local", request: message.request, answer: message.answer })) return false;
  return true;
}

export function handleRemoteLocalApi(ws, message, lifecycle) {
  if (typeof message?.type !== "string" || !message.type.startsWith("remote.")) return false;
  if (!ws?._local || !ws?._ui) {
    sendError(ws, message.requestId, "local-ui-only", "인증된 Iris 화면에서만 원격 설정을 바꿀 수 있습니다.");
    return true;
  }
  if (!validMessage(message) || !lifecycle) {
    sendError(ws, message.requestId, "invalid-request", "원격 설정 요청이 올바르지 않습니다.");
    return true;
  }
  const rule = TYPES.get(message.type);
  try {
    if (rule.method === "sendState" || rule.method === "sendTailscale") void lifecycle[rule.method](ws);
    else {
      const args = rule.fields.map((field) => message[field]);
      const result = lifecycle[rule.method](...args);
      void Promise.resolve(result).then((settled) => {
        if (settled && settled.ok === false) sendError(ws, message.requestId, settled.error || "request-failed");
        else if (rule.response) send(ws, { type: rule.response, requestId: message.requestId || null,
          ...(message.type === "remote.request.answer" ? { request: message.request, result: settled }
            : message.type === "remote.pin.set" ? {
              configured: settled?.configured === true,
              resumed: settled?.resumed === true,
            }
            : message.type === "remote.pin-idle.set" ? { minutes: settled?.pinIdleMinutes }
            : { installed: !!settled?.installed }) });
      }, () => sendError(ws, message.requestId, "request-failed"));
    }
  } catch {
    sendError(ws, message.requestId, "request-failed");
  }
  return true;
}
