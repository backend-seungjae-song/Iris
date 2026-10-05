import { privatePathAsync } from "./windows-private.cjs";
import fsp from "node:fs/promises";
import path from "node:path";

import { stateHome } from "../state-home.cjs";

const VERSION = 1;
export const PIN_IDLE_MINUTES = Object.freeze([10, 20, 30, 60]);
export const DEFAULT_PIN_IDLE_MINUTES = 30;

function validMinutes(value) {
  return PIN_IDLE_MINUTES.includes(value);
}

function validRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.version === VERSION
    && validMinutes(value.pinIdleMinutes);
}

export function createSessionPolicyStore(options = {}) {
  const remoteDir = path.join(options.stateDir || stateHome(), "remote");
  const policyFile = path.join(remoteDir, "session-policy.json");
  let pinIdleMinutes = DEFAULT_PIN_IDLE_MINUTES;
  let initialized = false;
  let sequence = 0;

  async function durableWrite(next) {
    await fsp.mkdir(remoteDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(remoteDir, 0o700);
    if (process.platform === "win32") await privatePathAsync(remoteDir);
    const temporary = `${policyFile}.${process.pid}.${++sequence}.tmp`;
    let renamed = false;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await fsp.chmod(temporary, 0o600);
      const handle = await fsp.open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await fsp.rename(temporary, policyFile);
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

  async function initialize() {
    if (initialized) return { ok: true, pinIdleMinutes };
    initialized = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(policyFile, "utf8"));
      if (!validRecord(parsed)) return { ok: false, error: "session-policy-invalid" };
      pinIdleMinutes = parsed.pinIdleMinutes;
      return { ok: true, pinIdleMinutes };
    } catch (error) {
      if (error?.code !== "ENOENT") return { ok: false, error: "session-policy-invalid" };
      try {
        await durableWrite({ version: VERSION, pinIdleMinutes });
        return { ok: true, pinIdleMinutes };
      } catch {
        return { ok: false, error: "session-policy-save-failed" };
      }
    }
  }

  async function set(nextMinutes) {
    if (!initialized) return { ok: false, error: "initializing" };
    if (!validMinutes(nextMinutes)) return { ok: false, error: "invalid-session-policy" };
    if (nextMinutes === pinIdleMinutes) return { ok: true, unchanged: true, pinIdleMinutes };
    try {
      await durableWrite({ version: VERSION, pinIdleMinutes: nextMinutes });
      pinIdleMinutes = nextMinutes;
      return { ok: true, pinIdleMinutes };
    } catch {
      return { ok: false, error: "session-policy-save-failed" };
    }
  }

  return {
    initialize,
    set,
    getPinIdleMinutes: () => pinIdleMinutes,
  };
}
