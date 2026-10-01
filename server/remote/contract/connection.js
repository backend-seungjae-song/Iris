import { REMOTE_RPC_VERSION } from "./ipc.js";
import { canonicalBytes } from "./jcs.js";
import { isErrorProjection, isOperationProjection } from "./projection.js";
import { hasExactKeys, isHex, isString } from "./validate.js";

const CONNECTION_DOMAIN = "iris-remote-conn/1";

function canonicalBase64(value, maximumBytes = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximumBytes / 3) * 4) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= maximumBytes && bytes.toString("base64") === value;
}

function isConnectionSignature(value) {
  return hasExactKeys(value, ["domain", "v", "serverInstance", "connId", "deviceId", "nonce", "certHash"])
    && value.domain === CONNECTION_DOMAIN
    && value.v === 1
    && isHex(value.serverInstance, 16)
    && isHex(value.connId, 16)
    && isString(value.deviceId, 1, 256)
    && isHex(value.nonce, 32)
    && isHex(value.certHash, 32);
}

export function connectionSignatureBytes(value) {
  if (!isConnectionSignature(value)) throw new TypeError("연결 서명 객체가 계약과 맞지 않습니다.");
  return canonicalBytes(value);
}

export function isAuthResponse(value) {
  return hasExactKeys(value, ["type", "v", "deviceId", "signature"], ["resumeToken"])
    && value.type === "auth.response"
    && value.v === REMOTE_RPC_VERSION
    && isString(value.deviceId, 1, 256)
    && canonicalBase64(value.signature)
    && (value.resumeToken === undefined || /^[A-Za-z0-9_-]{43}$/.test(value.resumeToken));
}

export function isPinSubmit(value) {
  return hasExactKeys(value, ["type", "v", "pin"])
    && value.type === "pin.submit"
    && value.v === REMOTE_RPC_VERSION
    && typeof value.pin === "string"
    && /^\d{6,32}$/.test(value.pin);
}

export function isPairRequest(value) {
  return hasExactKeys(value, ["type", "v", "secret", "connKey", "name"])
    && value.type === "pair.request"
    && value.v === REMOTE_RPC_VERSION
    && typeof value.secret === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(value.secret)
    && canonicalBase64(value.connKey, 1024)
    && isString(value.name, 1, 64)
    && !/[\p{Cc}]/u.test(value.name);
}

export function isRemoteOutbound(value) {
  if (hasExactKeys(value, ["type", "v", "serverInstance", "connId", "nonce", "certHash"])) {
    return value.type === "auth.challenge" && value.v === REMOTE_RPC_VERSION
      && isHex(value.serverInstance, 16) && isHex(value.connId, 16)
      && isHex(value.nonce, 32) && isHex(value.certHash, 32);
  }
  if (hasExactKeys(value, ["type", "v"])) {
    return value.type === "pin.required" && value.v === REMOTE_RPC_VERSION;
  }
  if (hasExactKeys(value, ["type", "v", "resumeToken", "pinIdleMinutes"])) {
    return value.type === "auth.ok" && value.v === REMOTE_RPC_VERSION
      && /^[A-Za-z0-9_-]{43}$/.test(value.resumeToken)
      && [10, 20, 30, 60].includes(value.pinIdleMinutes);
  }
  if (hasExactKeys(value, ["type", "v", "reason"])) {
    return value.type === "service.status" && value.v === REMOTE_RPC_VERSION
      && ["pin-required", "sharing-disabled"].includes(value.reason);
  }
  if (hasExactKeys(value, ["type", "v", "reason", "retryAfterMs"])) {
    return value.type === "pin.error" && value.v === REMOTE_RPC_VERSION
      && ["incorrect", "retry-later", "unavailable"].includes(value.reason)
      && Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 60_000;
  }
  if (hasExactKeys(value, ["type", "v", "deviceId", "code"])) {
    return value.type === "pair.pending" && value.v === REMOTE_RPC_VERSION
      && isHex(value.deviceId, 16) && /^\d{6}$/.test(value.code);
  }
  if (hasExactKeys(value, ["type", "remoteRpc", "macName", "requests"])) {
    return value.type === "caps" && value.remoteRpc === REMOTE_RPC_VERSION
      && isString(value.macName, 1, 64) && !/[\p{Cc}\p{Cf}]/u.test(value.macName)
      && Array.isArray(value.requests)
      && value.requests.every((request) => isString(request))
      && new Set(value.requests).size === value.requests.length;
  }
  return isErrorProjection(value) || isOperationProjection(value);
}
