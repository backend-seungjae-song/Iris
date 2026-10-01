import { createPublicKey } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { stateHome } from "../state-home.cjs";

const VERSION = 1;
const REDUCTIONS = new Set(["remove-device", "disable"]);
const OPERATIONS = new Set(["add-device", "remove-device", "enable", "disable"]);
const copy = (value) => structuredClone(value);

function defaultState() {
  return { version: VERSION, enabled: false, devices: [] };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function shortString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validP256Spki(value) {
  if (!shortString(value, 1024)) return false;
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    return false;
  }
  if (!bytes.length || bytes.toString("base64") !== value) return false;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

function validDevice(device) {
  return exactKeys(device, ["deviceId", "name", "connKey", "nodeId", "addedAt"])
    && shortString(device.deviceId)
    && shortString(device.name)
    && validP256Spki(device.connKey)
    && shortString(device.nodeId)
    && Number.isSafeInteger(device.addedAt)
    && device.addedAt >= 0;
}

function validState(value) {
  return exactKeys(value, ["version", "enabled", "devices"])
    && value.version === VERSION
    && typeof value.enabled === "boolean"
    && Array.isArray(value.devices)
    && value.devices.every(validDevice)
    && new Set(value.devices.map((device) => device.deviceId)).size === value.devices.length;
}

function validOperation(operation) {
  if (!operation || !OPERATIONS.has(operation.type)) return false;
  if (operation.type === "enable" || operation.type === "disable") {
    return exactKeys(operation, ["type"]);
  }
  if (operation.type === "add-device") {
    return exactKeys(operation, ["type", "device"]) && validDevice(operation.device);
  }
  return exactKeys(operation, ["type", "deviceId"]) && shortString(operation.deviceId);
}

function applyOperation(source, operation) {
  const next = copy(source);
  if (operation.type === "enable") next.enabled = true;
  else if (operation.type === "disable") next.enabled = false;
  else if (operation.type === "add-device") next.devices.push(copy(operation.device));
  else next.devices = next.devices.filter((device) => device.deviceId !== operation.deviceId);
  return next;
}

function defaultIo() {
  return {
    mkdir: async (directory) => {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      await fsp.chmod(directory, 0o700);
    },
    read: (file) => fsp.readFile(file, "utf8"),
    write: async (file, data, mode) => {
      await fsp.writeFile(file, data, { mode });
      await fsp.chmod(file, mode);
    },
    fsyncFile: async (file) => {
      const handle = await fsp.open(file, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    },
    rename: (from, to) => fsp.rename(from, to),
    unlink: (file) => fsp.unlink(file),
    fsyncDir: async (directory) => {
      const handle = await fsp.open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    },
    mkdirSync: (directory) => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    },
    writeSync: (file, data, mode) => {
      fs.writeFileSync(file, data, { mode });
      fs.chmodSync(file, mode);
    },
    fsyncFileSync: (file) => {
      const descriptor = fs.openSync(file, "r+");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    },
    renameSync: (from, to) => fs.renameSync(from, to),
    unlinkSync: (file) => fs.unlinkSync(file),
    fsyncDirSync: (directory) => {
      const descriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    },
  };
}

export function createRegistry(options = {}) {
  const remoteDir = path.join(options.stateDir || stateHome(), "remote");
  const registryFile = path.join(remoteDir, "registry.json");
  const cleanFile = path.join(remoteDir, "clean-shutdown");
  const io = { ...defaultIo(), ...(options.io || {}) };
  let stored = copy(options.initialState || defaultState());
  let operations = [];
  let sequence = 0;
  let saving = false;
  let saveRequested = false;
  let savePromise = null;
  let valid = validState(stored);
  let initialized = options.initialState !== undefined;
  let needsConfirmation = false;
  let lastSaveFailed = false;
  let closed = false;

  function snapshotThrough(maximumSequence = Number.POSITIVE_INFINITY, reductionsOnly = false) {
    let next = copy(stored);
    for (const entry of operations) {
      if (entry.sequence > maximumSequence || (reductionsOnly && !entry.reduction)) continue;
      next = applyOperation(next, entry.operation);
    }
    return next;
  }

  function snapshot() {
    return snapshotThrough();
  }

  function effectiveState() {
    const next = snapshotThrough(Number.POSITIVE_INFINITY, true);
    if (!valid) next.enabled = false;
    return next;
  }

  function change(operation) {
    if (closed) return { ok: false, error: "closed" };
    if (!initialized || !valid) return { ok: false, error: "registry-invalid" };
    if (!validOperation(operation)) return { ok: false, error: "invalid-operation" };
    const current = snapshot();
    if (operation.type === "add-device"
      && current.devices.some((device) => device.deviceId === operation.device.deviceId)) {
      return { ok: false, error: "device-exists" };
    }
    const unchanged = (operation.type === "remove-device"
        && !current.devices.some((device) => device.deviceId === operation.deviceId))
      || (operation.type === "disable" && !current.enabled)
      || (operation.type === "enable" && current.enabled);
    if (unchanged) return { ok: true, unchanged: true, reduction: REDUCTIONS.has(operation.type) };
    const entry = {
      sequence: ++sequence,
      operation: copy(operation),
      reduction: REDUCTIONS.has(operation.type),
    };
    operations.push(entry);
    return { ok: true, sequence: entry.sequence, reduction: entry.reduction };
  }

  async function durableReplace(file, data) {
    await io.mkdir(remoteDir);
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    let renamed = false;
    try {
      await io.write(temporary, data, 0o600);
      await io.fsyncFile(temporary);
      await io.rename(temporary, file);
      renamed = true;
      await io.fsyncDir(remoteDir);
    } catch (error) {
      if (!renamed) {
        try { await io.unlink(temporary); } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
        }
      }
      throw error;
    }
  }

  async function saveAttempt() {
    const targetSequence = sequence;
    const target = snapshotThrough(targetSequence);
    try {
      await durableReplace(registryFile, `${JSON.stringify(target)}\n`);
    } catch (cause) {
      lastSaveFailed = true;
      return { ok: false, error: "registry-save-failed", cause };
    }
    stored = target;
    operations = operations.filter((entry) => entry.sequence > targetSequence);
    if (stored.enabled) needsConfirmation = false;
    lastSaveFailed = false;
    return { ok: true };
  }

  async function runSaveLoop() {
    let result;
    do {
      saveRequested = false;
      result = await saveAttempt();
    } while (result.ok && (saveRequested || operations.length));
    return result;
  }

  function save() {
    if (closed) return Promise.resolve({ ok: false, error: "closed" });
    if (!initialized || !valid) return Promise.resolve({ ok: false, error: "registry-invalid" });
    if (saving) {
      saveRequested = true;
      return savePromise;
    }
    if (!operations.length) return Promise.resolve({ ok: true, unchanged: true });
    saving = true;
    savePromise = runSaveLoop().finally(() => {
      saving = false;
      savePromise = null;
    });
    return savePromise;
  }

  function durableReplaceSync(file, data) {
    io.mkdirSync(remoteDir);
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    let renamed = false;
    try {
      io.writeSync(temporary, data, 0o600);
      io.fsyncFileSync(temporary);
      io.renameSync(temporary, file);
      renamed = true;
      io.fsyncDirSync(remoteDir);
      return true;
    } catch {
      if (!renamed) {
        try { io.unlinkSync(temporary); } catch {}
      }
      return false;
    }
  }

  function saveSync() {
    if (closed || saving || !initialized || !valid || !operations.length) return !operations.length && !lastSaveFailed;
    const targetSequence = sequence;
    const target = snapshotThrough(targetSequence);
    if (!durableReplaceSync(registryFile, `${JSON.stringify(target)}\n`)) {
      lastSaveFailed = true;
      return false;
    }
    stored = target;
    operations = operations.filter((entry) => entry.sequence > targetSequence);
    if (stored.enabled) needsConfirmation = false;
    lastSaveFailed = false;
    return true;
  }

  async function consumeCleanMarker() {
    try {
      await io.read(cleanFile);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    await io.unlink(cleanFile);
    await io.fsyncDir(remoteDir);
    return true;
  }

  async function initialize() {
    if (initialized) return { ok: valid, clean: false, created: false, needsConfirmation };
    try {
      await io.mkdir(remoteDir);
      const clean = await consumeCleanMarker();
      let parsed;
      let created = false;
      try {
        parsed = JSON.parse(await io.read(registryFile));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          valid = false;
          initialized = true;
          return { ok: false, error: "registry-invalid", clean, cause: error };
        }
        parsed = defaultState();
        created = true;
      }
      if (!validState(parsed)) {
        valid = false;
        initialized = true;
        return { ok: false, error: "registry-invalid", clean };
      }
      stored = copy(parsed);
      operations = [];
      valid = true;
      initialized = true;
      needsConfirmation = false;
      if (created) {
        try {
          await durableReplace(registryFile, `${JSON.stringify(stored)}\n`);
        } catch (cause) {
          lastSaveFailed = true;
          return { ok: false, error: "registry-save-failed", clean, created, cause };
        }
      }
      return { ok: true, clean, created, needsConfirmation };
    } catch (cause) {
      valid = false;
      initialized = true;
      return { ok: false, error: "registry-invalid", cause };
    }
  }

  function markCleanShutdownSync() {
    closed = true;
    if (saving || operations.length || lastSaveFailed || !initialized || !valid) return false;
    return durableReplaceSync(cleanFile, "clean\n");
  }

  function status() {
    return {
      valid,
      initialized,
      saving,
      dirty: operations.length > 0,
      lastSaveFailed,
      needsConfirmation,
      closed,
    };
  }

  return {
    initialize,
    change,
    save,
    saveSync,
    snapshot,
    effectiveState,
    markCleanShutdownSync,
    status,
  };
}
