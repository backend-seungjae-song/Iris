import { createHash, createPublicKey, randomBytes as nodeRandomBytes, verify } from "node:crypto";

import { connectionSignatureBytes, isAuthResponse, isPinSubmit } from "./contract/connection.js";
import { REMOTE_RPC_VERSION } from "./contract/ipc.js";
import { resetTokenBucket, takeToken } from "./contract/rate-limit.js";

const CHALLENGE_MS = 60_000;
const DEFAULT_IDLE_MS = 30 * 60_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const BLOCK_MS = 30 * 60_000;
const TOTAL_SESSION_LIMIT = 6;
const DEVICE_SESSION_LIMIT = 2;
const REQUEST_RATE = 10;
const REQUEST_BURST = 20;
// 대화 화면 하나가 여는 요청(기록 구독·첫 페이지·PR·변경 파일·브라우저 목록)과 긴 브라우저 요청이 함께 들어가는 수
const INFLIGHT_LIMIT = 8;

function sameImpact(session, impact) {
  if (impact.scope === "all") return true;
  return impact.deviceId === session.deviceId;
}

function decodeSignature(value) {
  try {
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length || bytes.toString("base64") !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

function connectionKey(spki) {
  try {
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

function resumeKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createConnectionAuth(options) {
  if (!/^[0-9a-f]{32}$/.test(options?.serverInstance || "")
    || typeof options?.getCertificateHash !== "function"
    || typeof options?.getDevice !== "function"
    || typeof options?.isRemoteEnabled !== "function"
    || typeof options?.verifyPin !== "function") {
    throw new TypeError("connection auth dependencies are incomplete");
  }
  const serverInstance = options.serverInstance;
  const getCertificateHash = options.getCertificateHash;
  const getDevice = options.getDevice;
  const isRemoteEnabled = options.isRemoteEnabled;
  const verifyPin = options.verifyPin;
  const getIdleMs = options.getIdleMs || (() => DEFAULT_IDLE_MS);
  const now = options.now || Date.now;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onExpire = options.onExpire || (() => {});
  const onThrottle = options.onThrottle || (() => {});
  const records = new Map();
  const resumeTokens = new Map();
  const failures = new Map();
  const blocks = new Map();

  function clearRecordTimers(record) {
    for (const timer of [record.challengeTimer, record.idleTimer]) {
      if (timer) clearTimer(timer);
    }
  }

  function remove(connId, revokeToken = false) {
    const record = records.get(connId);
    if (!record) return null;
    records.delete(connId);
    clearRecordTimers(record);
    if (revokeToken && record.resumeKey) resumeTokens.delete(record.resumeKey);
    return record;
  }

  function schedule(record, field, delay, reason) {
    if (record[field]) clearTimer(record[field]);
    const timer = setTimer(() => {
      if (records.get(record.connId) !== record || record[field] !== timer) return;
      remove(record.connId, reason === "idle-timeout");
      onExpire(record.connId, reason);
    }, delay);
    timer?.unref?.();
    record[field] = timer;
  }

  function blockedUntil(peerIp, timestamp = now()) {
    const until = blocks.get(peerIp) || 0;
    if (until <= timestamp) {
      blocks.delete(peerIp);
      return 0;
    }
    return until;
  }

  function recordFailure(peerIp) {
    const timestamp = now();
    const recent = (failures.get(peerIp) || []).filter((value) => timestamp - value < FAILURE_WINDOW_MS);
    recent.push(timestamp);
    if (recent.length < 5) {
      failures.set(peerIp, recent);
      return 0;
    }
    failures.delete(peerIp);
    const until = timestamp + BLOCK_MS;
    blocks.set(peerIp, until);
    onThrottle(peerIp, until);
    return until;
  }

  function reject(connId, countFailure = true) {
    const record = remove(connId);
    if (!record) return { ok: false, error: "forbidden" };
    const blocked = countFailure ? recordFailure(record.peerIp) : 0;
    return { ok: false, error: "forbidden", ...(blocked ? { blockedUntil: blocked } : {}) };
  }

  function idleMs() {
    const value = getIdleMs();
    return Number.isSafeInteger(value) && value >= 60_000 ? value : DEFAULT_IDLE_MS;
  }

  function pruneTokens(timestamp = now()) {
    const maximumAge = idleMs();
    for (const [key, token] of resumeTokens) {
      if (timestamp - token.lastActivityAt >= maximumAge || !getDevice(token.deviceId)) {
        resumeTokens.delete(key);
      }
    }
  }

  function issueResumeToken(record, timestamp) {
    pruneTokens(timestamp);
    const token = randomBytes(32).toString("base64url");
    const key = resumeKey(token);
    resumeTokens.set(key, { deviceId: record.deviceId, lastActivityAt: timestamp });
    record.resumeKey = key;
    return token;
  }

  function open(input) {
    if (!input || !/^[0-9a-f]{32}$/.test(input.connId || "") || typeof input.peerIp !== "string"
      || typeof input.nodeId !== "string" || records.has(input.connId)) return { ok: false, error: "forbidden" };
    const blocked = blockedUntil(input.peerIp);
    if (blocked) return { ok: false, error: "forbidden", blockedUntil: blocked };
    const certHash = getCertificateHash();
    if (!isRemoteEnabled() || !/^[0-9a-f]{64}$/.test(certHash || "") || input.certHash !== certHash) {
      return { ok: false, error: "forbidden" };
    }
    const timestamp = now();
    const nonce = randomBytes(32).toString("hex");
    const record = {
      phase: "challenge",
      connId: input.connId,
      peerIp: input.peerIp,
      nodeId: input.nodeId,
      certHash,
      nonce,
      expiresAt: timestamp + CHALLENGE_MS,
      challengeTimer: null,
      idleTimer: null,
      resumeKey: null,
    };
    records.set(input.connId, record);
    schedule(record, "challengeTimer", CHALLENGE_MS, "authentication-timeout");
    return {
      ok: true,
      challenge: {
        type: "auth.challenge",
        v: REMOTE_RPC_VERSION,
        serverInstance,
        connId: input.connId,
        nonce,
        certHash,
      },
    };
  }

  function authenticate(connId, response) {
    const pending = records.get(connId);
    if (!pending || pending.phase !== "challenge") return { ok: false, error: "forbidden" };
    pending.phase = "consumed";
    if (pending.challengeTimer) {
      clearTimer(pending.challengeTimer);
      pending.challengeTimer = null;
    }
    const timestamp = now();
    const device = isAuthResponse(response) ? getDevice(response.deviceId) : null;
    const signature = isAuthResponse(response) ? decodeSignature(response.signature) : null;
    const signed = device ? {
      domain: "iris-remote-conn/1",
      v: 1,
      serverInstance,
      connId,
      deviceId: response.deviceId,
      nonce: pending.nonce,
      certHash: pending.certHash,
    } : null;
    const key = device ? connectionKey(device.connKey) : null;
    let signatureValid = false;
    if (key && signature && signed) {
      try {
        signatureValid = verify("sha256", connectionSignatureBytes(signed), { key, dsaEncoding: "der" }, signature);
      } catch {
        signatureValid = false;
      }
    }
    if (timestamp >= pending.expiresAt || !isRemoteEnabled() || !device
      || device.nodeId !== pending.nodeId || getCertificateHash() !== pending.certHash || !signatureValid) {
      return reject(connId);
    }
    if (typeof response.resumeToken === "string") {
      const key = resumeKey(response.resumeToken);
      const token = resumeTokens.get(key);
      if (token && token.deviceId === device.deviceId && timestamp - token.lastActivityAt < idleMs()) {
        resumeTokens.delete(key);
        const replacedConnIds = [];
        for (const record of [...records.values()]) {
          if (record.phase === "session" && record.resumeKey === key) {
            remove(record.connId);
            replacedConnIds.push(record.connId);
          }
        }
        pending.deviceId = device.deviceId;
        const resumed = beginSession(pending, timestamp, token.lastActivityAt);
        return resumed.ok ? { ...resumed, resumed: true, replacedConnIds } : resumed;
      }
      if (token?.deviceId === device.deviceId) resumeTokens.delete(key);
    }
    const active = [...records.values()].filter((record) => ["pin", "pin-verifying", "session"].includes(record.phase));
    if (active.length >= TOTAL_SESSION_LIMIT
      || active.filter((record) => record.deviceId === device.deviceId).length >= DEVICE_SESSION_LIMIT) {
      remove(connId);
      return { ok: false, error: "limit-exceeded" };
    }
    pending.phase = "pin";
    pending.deviceId = device.deviceId;
    pending.expiresAt = timestamp + CHALLENGE_MS;
    schedule(pending, "challengeTimer", CHALLENGE_MS, "authentication-timeout");
    return { ok: true, pinRequired: true };
  }

  function beginSession(pending, timestamp, lastActivityAt = timestamp) {
    const sessions = [...records.values()].filter((record) => record.phase === "session");
    if (sessions.length >= TOTAL_SESSION_LIMIT
      || sessions.filter((record) => record.deviceId === pending.deviceId).length >= DEVICE_SESSION_LIMIT) {
      remove(pending.connId);
      return { ok: false, error: "limit-exceeded" };
    }
    if (pending.challengeTimer) {
      clearTimer(pending.challengeTimer);
      pending.challengeTimer = null;
    }
    pending.phase = "session";
    pending.authenticatedAt = timestamp;
    pending.lastActivityAt = lastActivityAt;
    resetTokenBucket(pending, timestamp, REQUEST_BURST);
    pending.inflight = 0;
    const token = issueResumeToken(pending, lastActivityAt);
    schedule(pending, "idleTimer", Math.max(0, idleMs() - (timestamp - lastActivityAt)), "idle-timeout");
    return {
      ok: true,
      session: get(pending.connId),
      resumeToken: token,
      pinIdleMinutes: idleMs() / 60_000,
    };
  }

  async function submitPin(connId, message) {
    const pending = records.get(connId);
    if (!pending || pending.phase !== "pin" || !isPinSubmit(message)
      || now() >= pending.expiresAt || !isRemoteEnabled()) {
      return reject(connId);
    }
    pending.phase = "pin-verifying";
    const verified = await verifyPin(message.pin, {
      deviceId: pending.deviceId,
      peerIp: pending.peerIp,
    });
    if (records.get(connId) !== pending || pending.phase !== "pin-verifying") {
      return { ok: false, error: "forbidden" };
    }
    if (!verified?.ok) {
      pending.phase = "pin";
      return {
        ok: false,
        error: ["incorrect", "retry-later", "unavailable"].includes(verified?.error)
          ? verified.error : "unavailable",
        retryAfterMs: Number.isSafeInteger(verified?.retryAfterMs)
          ? Math.min(60_000, Math.max(0, verified.retryAfterMs)) : 0,
      };
    }
    return beginSession(pending, now());
  }

  function get(connId) {
    const record = records.get(connId);
    if (!record || record.phase !== "session") return null;
    return {
      valid: true,
      connId: record.connId,
      deviceId: record.deviceId,
      peerIp: record.peerIp,
      nodeId: record.nodeId,
      authenticatedAt: record.authenticatedAt,
      lastActivityAt: record.lastActivityAt,
    };
  }

  function touch(record, timestamp) {
    record.lastActivityAt = timestamp;
    const token = resumeTokens.get(record.resumeKey);
    if (token) token.lastActivityAt = timestamp;
    schedule(record, "idleTimer", idleMs(), "idle-timeout");
  }

  function beginRequest(connId, request = {}) {
    const record = records.get(connId);
    const timestamp = now();
    if (!record || record.phase !== "session") return { ok: false, error: "forbidden", close: true };
    if (timestamp - record.lastActivityAt >= idleMs()) {
      remove(connId, true);
      return { ok: false, error: "expired", close: true };
    }
    if (record.inflight >= INFLIGHT_LIMIT) return { ok: false, error: "busy", close: false };
    if (!takeToken(record, timestamp, { capacity: REQUEST_BURST, perSecond: REQUEST_RATE })) {
      return { ok: false, error: "limit-exceeded", close: false };
    }
    record.inflight++;
    if (request.activity === true) touch(record, timestamp);
    return { ok: true };
  }

  function endRequest(connId) {
    const record = records.get(connId);
    if (!record || record.phase !== "session" || record.inflight === 0) return false;
    record.inflight--;
    return true;
  }

  function invalidate(impact) {
    const removed = [];
    for (const record of [...records.values()]) {
      if (impact.scope !== "all"
        && (!["pin", "pin-verifying", "session"].includes(record.phase) || !sameImpact(record, impact))) continue;
      remove(record.connId, true);
      removed.push(record.connId);
    }
    for (const [key, token] of resumeTokens) {
      if (impact.scope === "all" || impact.deviceId === token.deviceId) resumeTokens.delete(key);
    }
    return removed;
  }

  function refreshExpiry() {
    const timestamp = now();
    const expired = [];
    pruneTokens(timestamp);
    for (const record of [...records.values()]) {
      if (record.phase !== "session") continue;
      const remaining = idleMs() - (timestamp - record.lastActivityAt);
      if (remaining <= 0) {
        remove(record.connId, true);
        expired.push(record.connId);
      } else {
        schedule(record, "idleTimer", remaining, "idle-timeout");
      }
    }
    return expired;
  }

  function activeBlocks() {
    const timestamp = now();
    const result = [];
    for (const [peerIp, until] of blocks) {
      if (until <= timestamp) blocks.delete(peerIp);
      else result.push({ peerIp, blockedUntil: until });
    }
    return result;
  }

  return {
    open,
    authenticate,
    submitPin,
    reject,
    get,
    beginRequest,
    endRequest,
    close: (connId) => !!remove(connId),
    invalidate,
    refreshExpiry,
    pruneExpiredTokens: () => pruneTokens(),
    activeBlocks,
    status: () => ({
      challenges: [...records.values()].filter((record) => record.phase !== "session").length,
      sessions: [...records.values()].filter((record) => record.phase === "session").length,
      blockedIps: activeBlocks().length,
    }),
  };
}
