import { createPublicKey, randomBytes as nodeRandomBytes, randomInt as nodeRandomInt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { encode } from "uqr";

import { isPairRequest } from "./contract/connection.js";

const PAIRING_MS = 120_000;

function validP256Spki(value) {
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

function sameText(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// 화면용 QR 행(0·1 문자열). 기기 추가 외 안내 QR 에도 사용
export function qrRows(text) {
  const encoded = encode(text, { border: 0 });
  return { size: encoded.size, rows: encoded.data.map((row) => row.map((cell) => cell ? "1" : "0").join("")) };
}

export function createPairing(options = {}) {
  const now = options.now || Date.now;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const randomInt = options.randomInt || nodeRandomInt;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const encodeQr = options.encode || encode;
  const onChange = options.onChange || (() => {});
  let active = null;

  function publicState() {
    if (!active) return null;
    if (active.phase === "scan") {
      return {
        phase: "scan",
        qr: { size: active.qr.size, rows: [...active.qr.rows] },
        expiresAt: active.expiresAt,
      };
    }
    return { phase: "code", deviceName: active.name, expiresAt: active.expiresAt };
  }

  function publish() {
    onChange(publicState());
  }

  function clear() {
    if (!active) return false;
    if (active.timer) clearTimer(active.timer);
    active = null;
    publish();
    return true;
  }

  function schedule(record) {
    record.timer = setTimer(() => {
      if (active !== record) return;
      active = null;
      publish();
    }, PAIRING_MS);
    record.timer?.unref?.();
  }

  function start(input) {
    if (!input || isIP(input.address) !== 4 || !Number.isInteger(input.port)
      || input.port < 1 || input.port > 65535 || !/^[0-9a-f]{64}$/.test(input.certHash || "")) {
      return { ok: false, error: "pairing-unavailable" };
    }
    const replaced = !!active;
    if (active?.timer) clearTimer(active.timer);
    active = null;
    let secret;
    let encoded;
    try {
      secret = randomBytes(32).toString("base64url");
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("invalid pairing secret");
      const text = JSON.stringify({
        t: "iris-remote-pair",
        v: 1,
        address: input.address,
        port: input.port,
        certHash: input.certHash,
        secret,
      });
      encoded = encodeQr(text, { border: 0 });
    } catch {
      if (replaced) publish();
      return { ok: false, error: "pairing-unavailable" };
    }
    if (!Number.isInteger(encoded?.size) || encoded.size < 1 || !Array.isArray(encoded.data)
      || encoded.data.length !== encoded.size
      || encoded.data.some((row) => !Array.isArray(row) || row.length !== encoded.size
        || row.some((cell) => typeof cell !== "boolean"))) {
      if (replaced) publish();
      return { ok: false, error: "pairing-unavailable" };
    }
    const record = {
      phase: "scan",
      secret,
      qr: { size: encoded.size, rows: encoded.data.map((row) => row.map((cell) => cell ? "1" : "0").join("")) },
      expiresAt: now() + PAIRING_MS,
      timer: null,
    };
    active = record;
    schedule(record);
    publish();
    return { ok: true };
  }

  function request(entry, message) {
    const record = active;
    const timestamp = now();
    if (!record || record.phase !== "scan" || timestamp >= record.expiresAt || !isPairRequest(message)
      || !sameText(record.secret, message.secret) || !validP256Spki(message.connKey)) {
      return { ok: false, error: "forbidden" };
    }
    if (!entry || typeof entry.nodeId !== "string" || entry.nodeId.length === 0) {
      return { ok: false, error: "forbidden" };
    }
    if (record.timer) clearTimer(record.timer);
    const deviceId = randomBytes(16).toString("hex");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!/^[0-9a-f]{32}$/.test(deviceId) || !/^\d{6}$/.test(code)) {
      active = null;
      publish();
      return { ok: false, error: "forbidden" };
    }
    active = {
      phase: "code",
      deviceId,
      code,
      name: message.name,
      connKey: message.connKey,
      nodeId: entry.nodeId,
      attempts: 0,
      expiresAt: timestamp + PAIRING_MS,
      timer: null,
    };
    schedule(active);
    publish();
    return { ok: true, pending: { deviceId, code } };
  }

  function confirm(code) {
    const record = active;
    if (!record || record.phase !== "code") return { ok: false, error: "pairing-not-active" };
    if (now() >= record.expiresAt) {
      clear();
      return { ok: false, error: "pairing-expired" };
    }
    if (typeof code !== "string" || !sameText(record.code, code)) {
      record.attempts++;
      if (record.attempts >= 3) {
        clear();
        return { ok: false, error: "pairing-attempts-exceeded" };
      }
      return { ok: false, error: "pairing-code-mismatch" };
    }
    const device = {
      deviceId: record.deviceId,
      name: record.name,
      connKey: record.connKey,
      nodeId: record.nodeId,
      addedAt: now(),
    };
    clear();
    return { ok: true, device };
  }

  return {
    start,
    request,
    confirm,
    cancel: () => clear() ? { ok: true } : { ok: false, error: "pairing-not-active" },
    discard: clear,
    publicState,
  };
}
