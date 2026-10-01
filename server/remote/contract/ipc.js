import { isIP } from "node:net";

export const REMOTE_RPC_VERSION = "remote/1";
export const MAX_REMOTE_FRAME_BYTES = 64 * 1024;
export const MAX_BROWSER_FRAME_JPEG_BYTES = 384 * 1024;
export const MAX_BROWSER_FRAME_MESSAGE_BYTES = 520 * 1024;
export const MAX_BROWSER_DRAFT_MESSAGE_BYTES = 400 * 1024;
export const REMOTE_AVAILABILITY = Object.freeze(["enabled", "pin-required", "sharing-disabled"]);
const MAX_REMOTE_IPC_BYTES = MAX_REMOTE_FRAME_BYTES + (4 * 1024);
const MAX_LARGE_REMOTE_IPC_BYTES = MAX_BROWSER_FRAME_MESSAGE_BYTES + (4 * 1024);

const HEX_128 = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function shortString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function port(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535;
}

function positiveSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validPem(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32 * 1024;
}

export function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

export function ipcBytes(message) {
  try {
    return utf8Bytes(JSON.stringify(message));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function fitsRemoteOutboundPayload(payload) {
  if (typeof payload !== "string") return false;
  const bytes = utf8Bytes(payload);
  if (bytes <= MAX_REMOTE_FRAME_BYTES) return true;
  if (bytes > MAX_BROWSER_FRAME_MESSAGE_BYTES) return false;
  try {
    const decoded = JSON.parse(payload);
    if (decoded?.type === "browser.frame") return bytes <= MAX_BROWSER_FRAME_MESSAGE_BYTES;
    if (decoded?.type === "browser.draft.result") return bytes <= MAX_BROWSER_DRAFT_MESSAGE_BYTES;
  } catch {}
  return false;
}

export function fitsRemoteIpc(message) {
  const maximum = message?.type === "conn.send" && fitsRemoteOutboundPayload(message.payload)
    ? MAX_LARGE_REMOTE_IPC_BYTES : MAX_REMOTE_IPC_BYTES;
  return ipcBytes(message) <= maximum;
}

export function isGatewayMessage(message) {
  if (!record(message) || typeof message.type !== "string") return false;
  if (message.type === "hello") {
    return exact(message, ["type", "v", "serverInstance"])
      && message.v === REMOTE_RPC_VERSION && HEX_128.test(message.serverInstance);
  }
  if (message.type === "listening") {
    return exact(message, ["type", "address", "port", "certHash"])
      && isIP(message.address) === 4 && port(message.port) && SHA256.test(message.certHash);
  }
  if (message.type === "listen.error") {
    return exact(message, ["type", "code"]) && shortString(message.code, 80);
  }
  if (message.type === "conn.open") {
    return exact(message, ["type", "gwSeq", "peerIp", "nodeId", "certHash"])
      && positiveSequence(message.gwSeq) && isIP(message.peerIp) === 4
      && shortString(message.nodeId, 256) && SHA256.test(message.certHash);
  }
  if (message.type === "conn.frame") {
    return exact(message, ["type", "connId", "payload"])
      && HEX_128.test(message.connId) && typeof message.payload === "string"
      && utf8Bytes(message.payload) <= MAX_REMOTE_FRAME_BYTES;
  }
  if (message.type === "conn.close") {
    return exact(message, ["type", "connId", "reason"])
      && HEX_128.test(message.connId) && shortString(message.reason, 80);
  }
  if (message.type === "conn.abandon") {
    return exact(message, ["type", "gwSeq"])
      && positiveSequence(message.gwSeq);
  }
  return false;
}

export function isHostMessage(message) {
  if (!record(message) || typeof message.type !== "string") return false;
  if (message.type === "configure") {
    const keys = ["type", "v", "serverInstance", "address", "port", "keyPem", "certPem", "certHash", "tailscalePath"];
    const shape = exact(message, keys) || exact(message, [...keys, "availability"]);
    return shape
      && message.v === REMOTE_RPC_VERSION && HEX_128.test(message.serverInstance)
      && isIP(message.address) === 4 && port(message.port)
      && validPem(message.keyPem) && validPem(message.certPem)
      && SHA256.test(message.certHash) && shortString(message.tailscalePath, 1024)
      && (message.availability === undefined || REMOTE_AVAILABILITY.includes(message.availability));
  }
  if (message.type === "conn.accept") {
    return exact(message, ["type", "gwSeq", "connId"])
      && positiveSequence(message.gwSeq) && HEX_128.test(message.connId);
  }
  if (message.type === "conn.send") {
    return exact(message, ["type", "connId", "payload"])
      && HEX_128.test(message.connId) && fitsRemoteOutboundPayload(message.payload);
  }
  if (message.type === "conn.close") {
    return exact(message, ["type", "connId", "reason"])
      && HEX_128.test(message.connId) && shortString(message.reason, 80);
  }
  if (message.type === "conn.authenticated") {
    return exact(message, ["type", "connId"])
      && HEX_128.test(message.connId);
  }
  if (message.type === "ip.block") {
    return exact(message, ["type", "peerIp", "blockedUntil"])
      && isIP(message.peerIp) === 4 && Number.isSafeInteger(message.blockedUntil) && message.blockedUntil >= 0;
  }
  return false;
}
