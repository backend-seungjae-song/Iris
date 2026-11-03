import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HEARTBEAT_INTERVAL_MS = 1000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000,
    }).trim();
    return value || null;
  } catch { return null; }
}

export function workerLockOwnerAlive(owner, { isProcessAlive = processAlive, getProcessStartedAt = processStartedAt,
  } = {}) {
  const pid = Number(owner?.pid);
  if (!isProcessAlive(pid)) return false;
  const current = owner?.processStartedAt ? getProcessStartedAt(pid) : null;
  if (owner?.processStartedAt && current != null) return current === owner.processStartedAt;
  return true;
}

export function createWorkerLock({ file, pid = process.pid, workerGeneration, isProcessAlive = processAlive,
    processStartedAt: getProcessStartedAt = processStartedAt,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    onLost = () => {} } = {}) {
  if (!path.isAbsolute(String(file || ""))) throw new Error("worker 잠금 파일 절대 경로가 필요합니다.");
  const owner = { pid, workerGeneration, processStartedAt: getProcessStartedAt(pid), leaseId: crypto.randomUUID() };
  const encoded = () => JSON.stringify(owner);
  let held = false;
  let heartbeat = null;
  const lose = () => {
    if (!held) return false;
    held = false;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    queueMicrotask(onLost);
    return false;
  };
  const pulse = () => {
    if (!held) return false;
    let current;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { return error?.code === "ENOENT" ? lose() : false; }
    if (current?.leaseId !== owner.leaseId) return lose();
    const temporary = `${file}.${pid}.${owner.leaseId}.heartbeat`;
    try {
      fs.writeFileSync(temporary, encoded(), { mode: 0o600 });
      const latest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (latest?.leaseId !== owner.leaseId) return lose();
      fs.renameSync(temporary, file);
      return true;
    } catch {
      return false;
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  };
  return {
    acquire() {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${pid}`;
      try {
        fs.writeFileSync(temp, encoded(), { mode: 0o600 });
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            fs.linkSync(temp, file);
            held = true;
            heartbeat = setInterval(pulse, heartbeatIntervalMs);
            heartbeat.unref?.();
            return;
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            let staleText = "";
            let staleOwner = null;
            try { staleText = fs.readFileSync(file, "utf8"); staleOwner = JSON.parse(staleText); }
            catch {}
            if (workerLockOwnerAlive(staleOwner, { isProcessAlive, getProcessStartedAt })) {
              throw Object.assign(new Error("다른 MCP 작업 프로세스가 실행 중입니다."), { code: "BUSY", owner: staleOwner });
            }
            try {
              if (fs.readFileSync(file, "utf8") !== staleText) continue;
              fs.unlinkSync(file);
            } catch (unlinkError) {
              if (unlinkError?.code !== "ENOENT") throw unlinkError;
            }
          }
        }
        throw Object.assign(new Error("MCP 작업 프로세스 잠금을 회수하지 못했습니다."), { code: "BUSY" });
      } finally {
        try { fs.unlinkSync(temp); } catch {}
      }
    },
    release() {
      if (!held) return false;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      let current;
      try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { held = false; return false; }
      if (current?.leaseId !== owner.leaseId) throw new Error("MCP 작업 프로세스 잠금 소유자가 바뀌었습니다.");
      fs.unlinkSync(file);
      held = false;
      return true;
    },
    pulse,
    held() { return held; },
  };
}
