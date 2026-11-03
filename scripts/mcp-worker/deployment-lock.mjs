import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class DeploymentBusyError extends Error {
  constructor(owner) {
    super(`다른 배포가 진행 중입니다${owner?.pid ? ` (pid ${owner.pid})` : ""}.`);
    this.code = "DEPLOYMENT_BUSY";
    this.owner = owner || null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function lockOwner(lockDirectory) {
  try { return JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")); }
  catch { return null; }
}

function staleLock(lockDirectory, owner, staleAfterMs) {
  if (owner && processAlive(Number(owner.pid))) return false;
  const age = Date.now() - fs.statSync(lockDirectory).mtimeMs;
  return age >= staleAfterMs;
}

function moveStaleLock(stateDir, lockDirectory) {
  const stale = path.join(stateDir, `.deployment.lock.stale-${randomUUID()}`);
  fs.renameSync(lockDirectory, stale);
  fs.rmSync(stale, { recursive: true, force: false });
}

export function claimDeploymentLock({ stateDir, owner = "worker-deploy", pid = process.pid, staleAfterMs = 30_000 } = {}) {
  if (!path.isAbsolute(stateDir)) throw new Error(`상태 폴더는 절대경로여야 합니다: ${stateDir}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockDirectory = path.join(stateDir, "deployment.lock");
  let retried = false;
  while (true) {
    try { fs.mkdirSync(lockDirectory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const heldBy = lockOwner(lockDirectory);
      if (!retried && staleLock(lockDirectory, heldBy, staleAfterMs)) {
        try { moveStaleLock(stateDir, lockDirectory); retried = true; continue; }
        catch (moveError) { if (!["ENOENT", "EEXIST"].includes(moveError.code)) throw moveError; }
      }
      throw new DeploymentBusyError(heldBy);
    }
    break;
  }
  const token = randomUUID();
  const value = { schemaVersion: 1, token, owner, pid, acquiredAt: new Date().toISOString() };
  fs.writeFileSync(path.join(lockDirectory, "owner.json"), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let released = false;
  return {
    path: lockDirectory,
    owner: value,
    release() {
      if (released) return false;
      const current = lockOwner(lockDirectory);
      if (!current || current.token !== token) throw new Error("배포 잠금 소유권이 바뀌어 해제하지 않았습니다.");
      fs.unlinkSync(path.join(lockDirectory, "owner.json"));
      fs.rmdirSync(lockDirectory);
      released = true;
      return true;
    },
  };
}

export async function withDeploymentLock(options, callback) {
  const lock = claimDeploymentLock(options);
  try { return await callback(lock); }
  finally { lock.release(); }
}
