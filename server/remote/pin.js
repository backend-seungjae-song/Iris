import { privatePath } from "./windows-private.cjs";
import { randomBytes as nodeRandomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { stateHome } from "../state-home.cjs";

const VERSION = 1;
const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const HASH_BYTES = 32;
const FAILURE_RESET_MS = 10 * 60_000;
const MAX_RETRY_MS = 60_000;

export function validAccessPin(value) {
  return typeof value === "string" && /^\d{6,32}$/.test(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalBase64(value, bytes) {
  if (typeof value !== "string") return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function validRecord(value) {
  return exactKeys(value, ["version", "algorithm", "N", "r", "p", "salt", "hash"])
    && value.version === VERSION && value.algorithm === "scrypt"
    && value.N === SCRYPT.N && value.r === SCRYPT.r && value.p === SCRYPT.p
    && canonicalBase64(value.salt, 16) && canonicalBase64(value.hash, HASH_BYTES);
}

function deriveWithScrypt(pin, salt) {
  return new Promise((resolve, reject) => {
    nodeScrypt(pin, salt, HASH_BYTES, SCRYPT, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function createPinStore(options = {}) {
  const remoteDir = path.join(options.stateDir || stateHome(), "remote");
  const pinFile = path.join(remoteDir, "access-pin.json");
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const derive = options.derive || deriveWithScrypt;
  const now = options.now || Date.now;
  let record = null;
  let initialized = false;
  let valid = true;
  let sequence = 0;
  const failures = new Map();

  async function initialize() {
    if (initialized) return { ok: valid, configured: !!record };
    initialized = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(pinFile, "utf8"));
      if (!validRecord(parsed)) {
        valid = false;
        return { ok: false, error: "pin-invalid", configured: false };
      }
      record = parsed;
      return { ok: true, configured: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, configured: false };
      valid = false;
      return { ok: false, error: "pin-invalid", configured: false };
    }
  }

  async function durableWrite(next) {
    await fsp.mkdir(remoteDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(remoteDir, 0o700);
    if (process.platform === "win32") privatePath(remoteDir);
    const temporary = `${pinFile}.${process.pid}.${++sequence}.tmp`;
    let renamed = false;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await fsp.chmod(temporary, 0o600);
      const handle = await fsp.open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await fsp.rename(temporary, pinFile);
      renamed = true;
      const directory = await fsp.open(remoteDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!renamed) {
        try { await fsp.unlink(temporary); } catch {}
      }
      throw error;
    }
  }

  async function set(pin) {
    if (!initialized || !valid) return { ok: false, error: "pin-invalid" };
    if (!validAccessPin(pin)) return { ok: false, error: "invalid-pin" };
    const salt = randomBytes(16);
    try {
      const hash = await derive(pin, salt);
      const next = {
        version: VERSION,
        algorithm: "scrypt",
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        salt: Buffer.from(salt).toString("base64"),
        hash: Buffer.from(hash).toString("base64"),
      };
      if (!validRecord(next)) return { ok: false, error: "pin-save-failed" };
      await durableWrite(next);
      record = next;
      failures.clear();
      return { ok: true };
    } catch {
      return { ok: false, error: "pin-save-failed" };
    }
  }

  async function verify(pin, identity = {}) {
    if (!initialized || !valid || !record || !validAccessPin(pin)) {
      return { ok: false, error: "incorrect", retryAfterMs: 0 };
    }
    const key = `${identity.deviceId || ""}\u0000${identity.peerIp || ""}`;
    const timestamp = now();
    const previous = failures.get(key);
    if (previous?.retryAt > timestamp) {
      return { ok: false, error: "retry-later", retryAfterMs: previous.retryAt - timestamp };
    }
    let candidate;
    try {
      candidate = Buffer.from(await derive(pin, Buffer.from(record.salt, "base64")));
    } catch {
      return { ok: false, error: "unavailable", retryAfterMs: 0 };
    }
    const expected = Buffer.from(record.hash, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      failures.delete(key);
      return { ok: true };
    }
    const count = previous && timestamp - previous.lastFailure < FAILURE_RESET_MS ? previous.count + 1 : 1;
    const retryAfterMs = Math.min(MAX_RETRY_MS, 1_000 * (2 ** Math.min(count - 1, 6)));
    failures.set(key, { count, lastFailure: timestamp, retryAt: timestamp + retryAfterMs });
    return { ok: false, error: "incorrect", retryAfterMs };
  }

  return {
    initialize,
    set,
    verify,
    hasPin: () => initialized && valid && !!record,
    status: () => ({ initialized, valid, configured: !!record }),
  };
}
