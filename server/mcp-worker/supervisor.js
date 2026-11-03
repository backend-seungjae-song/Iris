import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyDeployment } from "../../scripts/mcp-worker/deployment.mjs";
import { withDeploymentLock } from "../../scripts/mcp-worker/deployment-lock.mjs";
import { processStartedAt, workerLockOwnerAlive } from "./worker-lock.js";

// 계약: docs/mcp-worker.md
const PROTOCOL = 1;
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const REQUEST_WAIT_MS = 2000;
const RESTART_BACKOFF_MS = [100, 500, 1000];
const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const sourceRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceEntryDefault = fileURLToPath(new URL("./entry.js", import.meta.url));

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function defaultSpawn(entry, options) {
  const child = fork(entry, [], { ...options, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.unref();
  child.channel?.unref?.();
  return child;
}

export function createMcpWorkerSupervisor({
  stateDir,
  sourceRoot = sourceRootDefault,
  bundleId = process.env.IRIS_BUNDLE_ID || "development",
  legacyRevision = process.env.IRIS_QA_LEGACY_REVISION || "",
  hostDispatcher,
  identityAuthority,
  releaseHostGeneration = () => {},
  relay = {},
  spawnWorker = defaultSpawn,
  verify = verifyDeployment,
  writeCurrent = atomicWriteJson,
  log = console,
  maxRestarts = 3,
  restartWindowMs = 60000,
  restartBackoffMs = RESTART_BACKOFF_MS,
  workerLockPollMs = 50,
  workerLockWaitMs = 35000,
  requestWaitMs = REQUEST_WAIT_MS,
  isProcessAlive = processAlive,
  getProcessStartedAt = processStartedAt,
} = {}) {
  if (!path.isAbsolute(String(stateDir || ""))) throw new Error("worker supervisor 상태 폴더가 필요합니다.");
  if (typeof hostDispatcher !== "function") throw new Error("worker 세대별 host dispatcher factory가 필요합니다.");
  const deployRoot = path.join(stateDir, "mcp-worker");
  const currentFile = path.join(deployRoot, "current.json");
  const workerLockFile = path.join(deployRoot, "worker.lock");
  const bootId = crypto.randomBytes(8).toString("hex");
  const pending = new Map();
  // 응답을 기다리는 요청이 있는 동안만 IPC 채널 ref · 평소 unref 는 공용 서버 종료를 막지 않기 위함
  function syncChannelRef(instance) {
    const channel = instance?.child?.channel;
    if (!channel) return;
    let waiting = false;
    for (const item of pending.values()) if (item.instance === instance) { waiting = true; break; }
    if (waiting) channel.ref?.(); else channel.unref?.();
  }
  function dropPending(requestId) {
    const item = pending.get(requestId);
    pending.delete(requestId);
    if (item) syncChannelRef(item.instance);
  }
  const restarts = [];
  let sequence = 0;
  let current = null;
  let activation = null;
  let stopping = false;
  let lastActivation = null;
  let failure = null;
  let recovery = null;
  let pendingRestart = null;
  let retryDeployment = null;
  let retryAt = 0;
  let relayRecovery = null;
  const pendingRelayRetires = new Map();

  const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  const waitBounded = async (promise, timeoutMs) => {
    let timer = null;
    try {
      await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  async function waitForWorkerLockRelease() {
    const deadline = Date.now() + workerLockWaitMs;
    let observedOwner = null;
    let observedStartedAt = null;
    while (fs.existsSync(workerLockFile)) {
      let owner = null;
      try { owner = readJson(workerLockFile); } catch {}
      const ownerKey = JSON.stringify([owner?.pid, owner?.workerGeneration, owner?.processStartedAt, owner?.leaseId]);
      if (ownerKey !== observedOwner) {
        observedOwner = ownerKey;
        observedStartedAt = owner?.processStartedAt ? getProcessStartedAt(Number(owner.pid)) : null;
      }
      if (!workerLockOwnerAlive(owner, { isProcessAlive, getProcessStartedAt: () => observedStartedAt })) return;
      if (Date.now() >= deadline) throw codedError("LOCK_TIMEOUT", "이전 worker 잠금 반환 대기 시간이 초과됐습니다.");
      await delay(workerLockPollMs);
    }
  }

  function reclaimExitedWorkerLock(instance) {
    if (!fs.existsSync(workerLockFile)) return true;
    let text, owner;
    try { text = fs.readFileSync(workerLockFile, "utf8"); owner = JSON.parse(text); }
    catch { return false; }
    if (Number(owner.pid) !== Number(instance.child.pid) || owner.workerGeneration !== instance.generation) return false;
    if (!instance.exited) return false;
    try {
      if (fs.readFileSync(workerLockFile, "utf8") !== text) return false;
      fs.unlinkSync(workerLockFile);
      return true;
    } catch (error) { return error?.code === "ENOENT"; }
  }

  async function waitForExitAndLock(instance, timeoutMs = STOP_TIMEOUT_MS) {
    if (!instance.exited) {
      await new Promise((resolve, reject) => {
        let timer = null;
        const done = () => { if (timer) clearTimeout(timer); resolve(); };
        instance.child.once("exit", done);
        if (Number.isFinite(timeoutMs)) timer = setTimeout(() => {
          instance.child.off("exit", done);
          reject(codedError("TIMEOUT", "worker 프로세스 종료 확인 시간이 초과됐습니다."));
        }, timeoutMs);
      });
    }
    if (!fs.existsSync(workerLockFile) || reclaimExitedWorkerLock(instance)) return;
    throw codedError("RESOURCE_RELEASE_FAILED", "worker 프로세스 종료 뒤 잠금이 반환되지 않았습니다.");
  }

  async function terminateFailedSpawn(instance) {
    if (!instance || instance.exited) {
      if (instance) reclaimExitedWorkerLock(instance);
      return;
    }
    try { if (instance.child.connected) instance.child.disconnect?.(); } catch {}
    try { await waitForExitAndLock(instance, STOP_TIMEOUT_MS); return; }
    catch {}
    try { instance.child.kill?.("SIGKILL"); } catch {}
    await waitForExitAndLock(instance, STOP_TIMEOUT_MS);
  }

  async function terminateChild(instance) {
    if (!instance || instance.exited) {
      if (instance) reclaimExitedWorkerLock(instance);
      return;
    }
    try { instance.child.kill?.("SIGTERM"); } catch {}
    try { await waitForExitAndLock(instance, STOP_TIMEOUT_MS); return; }
    catch {}
    try { instance.child.kill?.("SIGKILL"); } catch {}
    await waitForExitAndLock(instance, STOP_TIMEOUT_MS);
  }

  const status = () => current ? {
    deployId: current.deployId,
    pid: current.child.pid,
    workerGeneration: current.generation,
    state: current.state,
    accepting: current.state === "accepting",
    startedAt: current.startedAt,
    active: current.active || { commands: [], observations: [], mobile: [], reports: [], journalWrites: [], relayCommands: [] },
    lastActivation,
  } : {
    deployId: null, pid: null, workerGeneration: null,
    state: failure ? "failed" : "absent", accepting: false,
    active: { commands: [], observations: [], mobile: [], reports: [], journalWrites: [], relayCommands: [] },
    ...(failure ? { failure } : {}), lastActivation,
  };

  // 상태 화면용 · active 는 worker 에 물어 채움 (감독기는 활동을 따로 기록하지 않아 status() 의 active 는 늘 비어 있음)
  // 배포가 활성 관찰로 거부될 때 무엇이 남았는지 보여야 함
  async function liveStatus({ timeoutMs = 2000 } = {}) {
    const base = status();
    const instance = current;
    if (!instance || !["accepting", "draining"].includes(instance.state)) return base;
    try {
      const live = await workerRequest(instance, "worker.status", {}, timeoutMs);
      return { ...base, active: live?.active || base.active };
    } catch (error) {
      return { ...base, activeError: String(error.message || error) };
    }
  }

  const deployment = deployId => {
    const directory = path.join(deployRoot, String(deployId));
    const verified = verify(directory);
    if (verified.manifest.deployId !== deployId) throw codedError("INVALID_DEPLOYMENT", "manifest 배포 ID가 요청과 다릅니다.");
    if (verified.manifest.bundle.id !== bundleId) throw codedError("FULL_INSTALL_REQUIRED", "현재 bundle과 다른 worker 배포입니다.");
    return { deployId, directory, entry: path.join(directory, "server/mcp-worker/entry.js"), verified: true,
      manifestSha256: verified.complete.manifestSha256, workerProtocol: verified.manifest.protocol.worker };
  };

  const sourceDeployment = reason => ({
    deployId: `bundle:${bundleId}`,
    directory: sourceRoot,
    entry: sourceRoot === sourceRootDefault ? sourceEntryDefault : path.join(sourceRoot, "server/mcp-worker/entry.js"),
    verified: false,
    reason,
    workerProtocol: PROTOCOL,
  });

  function startupDeployment() {
    if (!fs.existsSync(currentFile)) return sourceDeployment("current.json 없음");
    try {
      const pointer = readJson(currentFile);
      if (pointer.schemaVersion !== 1 || pointer.bundleId !== bundleId || pointer.workerProtocol !== PROTOCOL) {
        throw new Error("current.json bundle 또는 protocol 불일치");
      }
      const selected = deployment(pointer.deployId);
      if (selected.manifestSha256 !== pointer.manifestSha256) throw new Error("current.json manifest sha256 불일치");
      return selected;
    } catch (error) {
      return sourceDeployment(`current.json 검증 실패: ${error.message}`);
    }
  }

  function currentPointerDeployId() {
    if (!fs.existsSync(currentFile)) return null;
    try {
      const pointer = readJson(currentFile);
      if (pointer.schemaVersion !== 1 || pointer.bundleId !== bundleId || pointer.workerProtocol !== PROTOCOL) return null;
      const selected = deployment(pointer.deployId);
      return selected.manifestSha256 === pointer.manifestSha256 ? pointer.deployId : null;
    } catch { return null; }
  }

  function activationPreviousId(instance) {
    return instance?.deployId || currentPointerDeployId() || null;
  }

  function writeDeploymentPointer(instance, previousDeployId) {
    if (!instance?.verified) return;
    writeCurrent(currentFile, { schemaVersion: 1, deployId: instance.deployId,
      previousDeployId, manifestSha256: instance.manifestSha256,
      bundleId, workerProtocol: PROTOCOL, activatedAt: new Date().toISOString() });
  }

  function workerRequest(instance, type, extra = {}, timeoutMs = STOP_TIMEOUT_MS) {
    const requestId = `${type}:${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
        dropPending(requestId);
        reject(codedError("TIMEOUT", `${type} 응답 시간이 초과됐습니다.`));
      }, timeoutMs) : null;
      timer?.unref?.();
      pending.set(requestId, { instance, resolve, reject, timer });
      syncChannelRef(instance);
      instance.child.send({ protocol: PROTOCOL, workerGeneration: instance.generation, type, requestId, ...extra }, error => {
        if (!error) return;
        if (timer) clearTimeout(timer);
        dropPending(requestId);
        reject(error);
      });
    });
  }

  function settle(message, instance) {
    const item = pending.get(message.requestId);
    if (!item || item.instance !== instance) return false;
    if (item.timer) clearTimeout(item.timer);
    dropPending(message.requestId);
    if (message.ok) item.resolve(message.output);
    else item.reject(codedError(message.error?.code || "INTERNAL", message.error?.message || "worker 요청 실패", message.error?.details));
    return true;
  }

  async function spawn(selected, { accept = true, takeover = false } = {}) {
    await waitForWorkerLockRelease();
    const generation = `${bootId}:${++sequence}`;
    const token = crypto.randomBytes(32).toString("hex");
    const child = spawnWorker(selected.entry, {
      cwd: selected.directory,
      env: {
        ...process.env,
        IRIS_STATE_DIR: stateDir,
        IRIS_MCP_WORKER_TOKEN: token,
        IRIS_MCP_WORKER_DEPLOY_ID: selected.deployId,
        IRIS_MCP_WORKER_GENERATION: generation,
        IRIS_BUNDLE_ID: bundleId,
        IRIS_QA_LEGACY_REVISION: legacyRevision,
      },
    });
    const instance = { ...selected, child, generation, token, state: "starting", startedAt: new Date().toISOString(), active: null,
      exited: false, registered: false, hostFinished: false, relaySubscriptions: new Map() };
    const dispatcher = hostDispatcher(generation, child);
    instance.dispatcher = dispatcher;
    let hello = false;
    child.on("exit", (code, signal) => {
      instance.exited = true;
      instance.exitCode = code;
      instance.exitSignal = signal;
      if (instance.registered) onExit(instance, code, signal);
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(codedError("TIMEOUT", "worker 기동 확인 시간이 초과됐습니다.")), START_TIMEOUT_MS);
      timer.unref?.();
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (instance.state === "starting" || instance.state === "ready") fail(codedError("WORKER_EXIT", `worker가 준비 전에 종료됐습니다(${code ?? signal}).`));
      });
      child.on("message", async message => {
        if (!message || message.protocol !== PROTOCOL || message.workerGeneration !== generation) return;
        if (message.type === "worker.hello") {
          if (hello || message.pid !== child.pid || message.deployId !== selected.deployId || !safeEqual(message.token, token)) {
            fail(codedError("UNAUTHORIZED_WORKER", "worker hello 검증에 실패했습니다."));
            return;
          }
          hello = true;
          instance.token = null;
          child.send({ protocol: PROTOCOL, workerGeneration: generation, type: "worker.authorized", requestId: `authorized:${generation}` });
          return;
        }
        if (message.type === "worker.ready") {
          if (!hello || message.pid !== child.pid || message.deployId !== selected.deployId) {
            fail(codedError("UNAUTHORIZED_WORKER", "worker ready 검증에 실패했습니다."));
            return;
          }
          clearTimeout(timer);
          instance.state = "ready";
          resolve(instance);
          return;
        }
        if (message.type === "host.request") {
          const subscription = beginRelaySubscription(instance, message);
          const response = await dispatcher.dispatch(message, child);
          finishRelaySubscription(instance, subscription, response);
          if (child.connected) child.send(response);
          return;
        }
        if (message.type.endsWith(".result")) settle(message, instance);
        if (message.type === "worker.stopped") instance.state = "stopping";
      });
    });
    try {
      await ready;
      if (accept) await acceptInstance(instance, { takeover });
      if (!instanceAlive(instance)) throw codedError("WORKER_EXIT", "worker가 접수 직후 종료됐습니다.");
      instance.registered = true;
      return instance;
    } catch (error) {
      try { await retireRelayGeneration(instance.generation); } catch {}
      await terminateFailedSpawn(instance).catch(cleanupError => {
        error.cleanupError = cleanupError;
      });
      throw error;
    }
  }

  async function spawnWithRetries(selected, { attempts = maxRestarts, primaryError = null, takeover = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt) await delay(restartBackoffMs[Math.min(attempt - 1, restartBackoffMs.length - 1)] || 0);
      try { return await spawn(selected, { takeover }); }
      catch (error) { lastError = error; }
    }
    if (primaryError && lastError) {
      primaryError.details = { ...(primaryError.details || {}), rollbackError: String(lastError.message || lastError) };
    }
    throw lastError || primaryError;
  }

  async function acceptInstance(instance, { takeover = false } = {}) {
    const accepted = typeof relay.accept === "function" ? await relay.accept(instance.generation, { takeover }) : { ok: true };
    if (accepted?.ok === false) throw codedError(accepted.code || "EXECUTOR_GONE", accepted.error || "Electron이 worker 세대를 허용하지 않았습니다.");
    await workerRequest(instance, "worker.accept");
    instance.state = "accepting";
    return instance;
  }

  function relaySubscriptionRequest(message) {
    if (message?.operation !== "browser.executeWithDialog") return null;
    const command = message.input?.relay?.command;
    if (command !== "cdp.subscribe" && command !== "cdp.unsubscribe") return null;
    const subscriptionId = String(message.input?.relay?.args?.subscriptionId || "");
    if (!SUBSCRIPTION_ID_RE.test(subscriptionId)) return null;
    return { command, subscriptionId, requestId: message.requestId };
  }

  function beginRelaySubscription(instance, message) {
    const request = relaySubscriptionRequest(message);
    if (!request || request.command !== "cdp.subscribe" || instance.relaySubscriptions.has(request.subscriptionId)) return request;
    instance.relaySubscriptions.set(request.subscriptionId, { requestId: request.requestId, pending: true, eventSeq: 0 });
    return request;
  }

  function finishRelaySubscription(instance, request, response) {
    if (!request) return;
    const output = response?.output;
    const data = output?.data && typeof output.data === "object" ? output.data : output;
    const succeeded = response?.ok === true && (request.command === "cdp.subscribe"
      ? data?.subscribed === true && data.subscriptionId === request.subscriptionId
      : data?.unsubscribed === true && data.subscriptionId === request.subscriptionId);
    if (request.command === "cdp.subscribe") {
      const subscription = instance.relaySubscriptions.get(request.subscriptionId);
      if (subscription?.requestId !== request.requestId) return;
      if (!succeeded) instance.relaySubscriptions.delete(request.subscriptionId);
      else subscription.pending = false;
      return;
    }
    if (succeeded) instance.relaySubscriptions.delete(request.subscriptionId);
  }

  function relayEvent(event) {
    const instance = current;
    if (!instance || !event || event.workerGeneration !== instance.generation) return false;
    const subscriptionId = String(event.subscriptionId || "");
    const subscription = instance.relaySubscriptions.get(subscriptionId);
    if (!subscription || !Number.isSafeInteger(event.eventSeq) || event.eventSeq <= subscription.eventSeq) return false;
    subscription.eventSeq = event.eventSeq;
    if (!instanceAlive(instance)) return false;
    try {
      instance.child.send({ protocol: PROTOCOL, type: "relay.event", workerGeneration: instance.generation,
        event: structuredClone(event) });
    } catch { return false; }
    if (event.error?.code === "EVENT_OVERFLOW") instance.relaySubscriptions.delete(subscriptionId);
    return true;
  }

  async function retireRelayGeneration(generation, { force = false } = {}) {
    if (typeof relay.retire !== "function") return { ok: true };
    const superseded = () => Boolean(current?.generation && current.generation !== generation);
    let retired;
    try { retired = await relay.retire(generation, { force }); }
    catch (error) {
      if (error?.code === "STALE_WORKER" && superseded()) {
        pendingRelayRetires.delete(generation);
        return { ok: true, stale: true };
      }
      if (error?.code !== "STALE_WORKER") pendingRelayRetires.set(generation, { force });
      throw error;
    }
    if (retired?.pending) pendingRelayRetires.set(generation, { force });
    else if (retired?.ok === false) {
      if (retired.code === "STALE_WORKER" && superseded()) {
        pendingRelayRetires.delete(generation);
        return { ok: true, stale: true };
      }
      if (retired.code !== "STALE_WORKER") pendingRelayRetires.set(generation, { force });
      throw codedError(retired.code || "RESOURCE_RELEASE_FAILED", retired.error || "Electron worker 세대 회수에 실패했습니다.", retired.details || {});
    }
    else pendingRelayRetires.delete(generation);
    return retired;
  }

  const instanceAlive = instance => Boolean(instance && !instance.exited && instance.child.connected !== false);

  async function resumeInstance(instance) {
    if (!instanceAlive(instance)) return false;
    const accepted = typeof relay.accept === "function" ? await relay.accept(instance.generation) : { ok: true };
    if (accepted?.ok === false) throw codedError(accepted.code || "EXECUTOR_GONE", accepted.error || "Electron이 이전 worker 세대를 다시 허용하지 않았습니다.");
    await workerRequest(instance, "worker.accept");
    instance.state = "accepting";
    return true;
  }

  async function finishHostGeneration(instance, { force = false } = {}) {
    if (!instance || instance.hostFinished) return;
    const release = () => releaseHostGeneration(instance.generation);
    if (force) instance.dispatcher?.retire?.(release);
    const idle = instance.dispatcher?.waitForIdle?.();
    if (idle && force) {
      await waitBounded(idle, STOP_TIMEOUT_MS);
    } else if (idle) await idle;
    if (!force) instance.dispatcher?.retire?.(release);
    release();
    instance.hostFinished = true;
  }

  async function stopInstance(instance, { stopObservations = false, retire = true } = {}) {
    let hostFinished = false;
    let relayRetired = false;
    try {
      instance.state = "draining";
      await workerRequest(instance, "worker.stopAccepting");
      try { await workerRequest(instance, "worker.drain", { timeoutMs: 30000 }, 31000); }
      catch (error) {
        if (error.code !== "BUSY" || !stopObservations) throw error;
        await workerRequest(instance, "worker.stopObservations");
        await workerRequest(instance, "worker.drain", { timeoutMs: 30000 }, 31000);
      }
      await finishHostGeneration(instance);
      hostFinished = true;
      if (retire) {
        await retireRelayGeneration(instance.generation);
        relayRetired = true;
      }
      instance.state = "stopping";
      await workerRequest(instance, "worker.shutdown");
      await waitForExitAndLock(instance);
    } catch (error) {
      error.details = { ...(error.details || {}), hostFinished, relayRetired };
      if (retire && (relayRetired || hostFinished)) {
        try { await terminateFailedSpawn(instance); }
        catch (cleanupError) {
          error.details.cleanupError = String(cleanupError.message || cleanupError);
        }
      } else {
        try { await resumeInstance(instance); }
        catch (resumeError) {
          error.details.resumeError = String(resumeError.message || resumeError);
        }
      }
      throw error;
    }
  }

  function queueRestart(instance, primaryError, reason) {
    if (!pendingRestart || pendingRestart.instance !== instance) {
      pendingRestart = {
        instance,
        primaryError,
        reason,
        hostFinished: primaryError?.details?.hostFinished === true,
        relayRetired: primaryError?.details?.relayRetired === true,
        selected: instance,
        error: null,
      };
    }
    current = null;
    return pendingRestart;
  }

  async function recoverPendingRestart(selected = null) {
    if (!pendingRestart) return false;
    if (recovery) return recovery;
    const task = pendingRestart;
    if (selected) task.selected = selected;
    recovery = (async () => {
      if (instanceAlive(task.instance)) await terminateChild(task.instance);
      if (task.instance) reclaimExitedWorkerLock(task.instance);
      if (!task.hostFinished) {
        await finishHostGeneration(task.instance, { force: true });
        task.hostFinished = true;
      }
      current = await spawnWithRetries(task.selected || task.instance, {
        attempts: Math.max(0, maxRestarts - 1),
        primaryError: task.primaryError,
        takeover: true,
      });
      pendingRestart = null;
      retryDeployment = null;
      retryAt = 0;
      failure = null;
      return true;
    })().catch(error => {
      failure = `${task.reason}: ${String(error.message || error)}`;
      task.error = error;
      if (task.primaryError) {
        task.primaryError.details = { ...(task.primaryError.details || {}), recoveryError: String(error.message || error) };
      }
      return false;
    }).finally(() => { recovery = null; });
    return recovery;
  }

  async function restoreDeadInstance(instance, primaryError) {
    queueRestart(instance, primaryError, "이전 worker 복구 실패");
    await recoverPendingRestart();
  }

  function onExit(instance, code, signal) {
    for (const [requestId, item] of pending) {
      if (item.instance !== instance) continue;
      clearTimeout(item.timer);
      dropPending(requestId);
      item.reject(codedError("COMMAND_INDETERMINATE", `worker가 응답 전에 종료됐습니다(${code ?? signal}).`));
    }
    if (current !== instance || stopping || activation || recovery) return;
    const cutoff = Date.now() - restartWindowMs;
    while (restarts.length && restarts[0] < cutoff) restarts.shift();
    if (restarts.length >= maxRestarts) {
      queueRestart(instance, null, `worker 비정상 종료(${code ?? signal})`);
      failure = `worker 비정상 종료(${code ?? signal}): worker 비정상 종료 재시도 상한 초과(${maxRestarts})`;
      retryAt = Date.now() + restartWindowMs;
      return;
    }
    restarts.push(Date.now());
    queueRestart(instance, null, `worker 비정상 종료(${code ?? signal})`);
    void recoverPendingRestart();
  }

  async function start() {
    if (current) return status();
    const selected = startupDeployment();
    log.info?.(`[mcp-worker] ${selected.deployId} 실행: ${selected.reason || "검증된 current.json"}`);
    try {
      current = await spawnWithRetries(selected, { attempts: Math.max(0, maxRestarts - 1) });
      retryDeployment = null;
      retryAt = 0;
      failure = null;
    } catch (error) {
      failure = String(error.message || error);
      retryDeployment = selected;
      retryAt = Date.now() + (restartBackoffMs.at(-1) || 1000);
      throw error;
    }
    return status();
  }

  async function waitForCurrent(timeoutMs = requestWaitMs) {
    if (current?.state === "accepting") return current;
    if (pendingRestart && Date.now() >= retryAt) await recoverPendingRestart();
    if (!current && retryDeployment && Date.now() >= retryAt && !recovery) {
      recovery = spawnWithRetries(retryDeployment, { attempts: Math.max(0, maxRestarts - 1) })
        .then(instance => { current = instance; retryDeployment = null; retryAt = 0; failure = null; return true; })
        .catch(error => { failure = String(error.message || error); retryAt = Date.now() + (restartBackoffMs.at(-1) || 1000); return false; })
        .finally(() => { recovery = null; });
      await recovery;
    }
    if (current?.state === "failed") await executorRegistered();
    const deadline = Date.now() + timeoutMs;
    while ((!current || current.state !== "accepting") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!current || current.state !== "accepting") throw codedError("WORKER_UNAVAILABLE", failure || "MCP 작업 프로세스가 교체 중이거나 준비되지 않았습니다.");
    return current;
  }

  async function request(channel, command, args, identity) {
    const instance = await waitForCurrent();
    if (identity.session) identityAuthority?.allowSession(identity.session);
    const previousBinding = identity.run ? identityAuthority?.bindingFor(identity.run) : null;
    const boundForRequest = Boolean(identity.run && identity.key && !previousBinding);
    if (boundForRequest) {
      identityAuthority?.bindRun(identity);
    }
    const commandId = `${instance.generation}/${crypto.randomUUID()}`;
    const candidate = channel === "qa" && command === "run_resume" && identity.run && !identity.key
      && (!previousBinding || previousBinding.session === identity.session);
    // MCP 재연결 뒤 새 stdio 는 key 가 없음. 같은 세션의 명시적 run_resume 에만 이번 요청용 임시 key 발급
    const requestIdentity = candidate && !identity.key ? { ...identity, key: crypto.randomUUID() } : identity;
    if (candidate) identityAuthority?.allowCandidate({ commandId, ...requestIdentity });
    try {
      const output = await workerRequest(instance, "worker.request", { channel, command, args, identity: requestIdentity, commandId }, null);
      const data = output?.data || output;
      if (output?.ok !== false && channel === "qa" && command === "run_begin" && data?.runId && data?.runKey) {
        identityAuthority?.bindRun({ session: identity.session, run: data.runId, key: data.runKey });
      }
      if (output?.ok !== false && channel === "qa" && command === "run_resume" && data?.runId && data?.runKey) {
        identityAuthority?.rotateRunKey({ session: identity.session, run: data.runId, key: data.runKey });
      }
      if (output?.ok === false && boundForRequest) identityAuthority?.releaseRun(identity);
      return output;
    } catch (error) {
      if (boundForRequest) identityAuthority?.releaseRun(identity);
      throw error;
    } finally {
      if (candidate) identityAuthority?.clearCandidate(commandId);
    }
  }

  async function hostTask({ task, identity, commandId, callId, timeoutMs } = {}) {
    const instance = current;
    if (!instance || instance.state !== "accepting" || !instanceAlive(instance)) {
      throw codedError("WORKER_UNAVAILABLE", "host 작업을 받을 worker가 없습니다.");
    }
    try {
      return await workerRequest(instance, "worker.hostTask", { task, identity, commandId, callId }, timeoutMs);
    } catch (error) {
      if (error?.code !== "TIMEOUT") throw error;
      const commandStatus = instance.dispatcher?.commandStatus?.(commandId, callId) || [];
      const completed = commandStatus.find(entry => entry.state === "completed" && entry.result);
      if (completed?.result?.ok) return completed.result.output;
      if (completed?.result?.error) {
        const failure = completed.result.error;
        throw codedError(failure.code || "INTERNAL", failure.message || "host 작업이 실패했습니다.", failure.details || {});
      }
      error.details = { ...(error.details || {}), commandStatus: commandStatus.map(({ state, ok }) => ({ state, ok })) };
      throw error;
    }
  }

  async function activate({ deployId, expectPrevId, stopObservations = false, recover = false } = {}) {
    if (activation) throw codedError("DEPLOYMENT_BUSY", "다른 worker 활성화가 진행 중입니다.");
    activation = withDeploymentLock({ stateDir, owner: "mcp-worker-activate" }, async () => {
      try {
        if (recover) {
          const selected = deployId ? deployment(deployId) : startupDeployment();
          if (recovery) {
            await recovery;
            if (current?.state === "accepting" && (!deployId || current.deployId === selected.deployId)) {
              failure = null;
              lastActivation = { deployId: current.deployId, result: "ok", recovered: true, reused: true };
              return { ok: true, recovered: true, reused: true, worker: status() };
            }
          }
          const previous = current || pendingRestart?.instance || (retryDeployment?.child ? retryDeployment : null);
          const previousDeployId = previous?.deployId || null;
          if (!pendingRestart || pendingRestart.instance !== previous) {
            pendingRestart = { instance: previous, primaryError: null, reason: "worker 강제 복구",
              hostFinished: false, relayRetired: false, selected, error: null };
          } else pendingRestart.selected = selected;
          current = null;
          retryDeployment = null;
          retryAt = 0;
          const task = pendingRestart;
          const recovered = await recoverPendingRestart(selected);
          if (!recovered || !current || current.state !== "accepting") {
            throw task.error || codedError("WORKER_UNAVAILABLE", failure || "worker 강제 복구에 실패했습니다.");
          }
          if (selected.verified) {
            try {
              writeDeploymentPointer(current, previousDeployId);
            } catch (error) {
              throw codedError("POINTER_WRITE_FAILED", `current.json 기록 실패: ${error.message}`);
            }
          }
          failure = null;
          lastActivation = { deployId: selected.deployId, result: "ok", recovered: true };
          return { ok: true, recovered: true, worker: status() };
        }
        const previous = current;
        const previousDeployId = activationPreviousId(previous);
        if (previous?.deployId === deployId && previous.state === "accepting") {
          try { writeDeploymentPointer(previous, previousDeployId); }
          catch (error) { throw codedError("POINTER_WRITE_FAILED", `current.json 기록 실패: ${error.message}`); }
          lastActivation = { deployId, result: "ok", reused: true };
          return { ok: true, reused: true, worker: status() };
        }
        if (expectPrevId != null && previousDeployId !== expectPrevId) {
          throw codedError("STALE_DEPLOYMENT", `현재 배포가 expectPrevId와 다릅니다: ${previousDeployId || "없음"}`);
        }
        const selected = deployment(deployId);
        if (previous) {
          try { await stopInstance(previous, { stopObservations }); }
          catch (error) {
            if (!instanceAlive(previous) || error.details?.hostFinished) await restoreDeadInstance(previous, error);
            throw error;
          }
        }
        current = null;
        let next;
        try { next = await spawn(selected); }
        catch (error) {
          if (previous) {
            try { current = await spawnWithRetries(previous, { attempts: Math.max(0, maxRestarts - 1), primaryError: error }); }
            catch (rollbackError) {
              failure = `새 worker 기동 실패: ${error.message}; 이전 worker 복구 실패: ${rollbackError.message}`;
              error.details = { ...(error.details || {}), rollbackError: String(rollbackError.message || rollbackError) };
            }
          }
          throw error;
        }
        if (expectPrevId != null && activationPreviousId(previous) !== expectPrevId) {
          await stopInstance(next);
          current = previous ? await spawnWithRetries(previous, { attempts: Math.max(0, maxRestarts - 1) }) : null;
          throw codedError("STALE_DEPLOYMENT", "활성화 중 이전 배포가 바뀌었습니다.");
        }
        const pointer = {
          schemaVersion: 1,
          deployId,
          previousDeployId,
          manifestSha256: selected.manifestSha256,
          bundleId,
          workerProtocol: PROTOCOL,
          activatedAt: new Date().toISOString(),
        };
        try { writeCurrent(currentFile, pointer); }
        catch (error) {
          await stopInstance(next).catch(() => {});
          current = previous ? await spawnWithRetries(previous, { attempts: Math.max(0, maxRestarts - 1), primaryError: error }) : null;
          throw codedError("POINTER_WRITE_FAILED", `current.json 기록 실패: ${error.message}`);
        }
        current = next;
        pendingRestart = null;
        retryDeployment = null;
        retryAt = 0;
        failure = null;
        lastActivation = { deployId, result: "ok" };
        return { ok: true, reused: false, previousDeployId, worker: status() };
      } catch (error) {
        lastActivation = { deployId, result: "failed", code: error.code || "INTERNAL", error: String(error.message || error) };
        throw error;
      }
    });
    try { return await activation; }
    finally { activation = null; }
  }

  async function shutdown() {
    stopping = true;
    const instance = current;
    current = null;
    if (instance) await stopInstance(instance).catch(() => {});
  }

  async function reloadSource() {
    if (activation) throw codedError("DEPLOYMENT_BUSY", "다른 worker 활성화가 진행 중입니다.");
    activation = (async () => {
      const previous = current;
      if (previous) {
        try { await stopInstance(previous); }
        catch (error) {
          if (!instanceAlive(previous) || error.details?.hostFinished) await restoreDeadInstance(previous, error);
          throw error;
        }
      }
      current = null;
      try {
        current = await spawn(sourceDeployment("개발 소스 변경"));
        pendingRestart = null;
        retryDeployment = null;
        retryAt = 0;
        failure = null;
        return { ok: true, worker: status() };
      } catch (error) {
        if (previous) {
          try {
            current = await spawnWithRetries(previous, { attempts: Math.max(0, maxRestarts - 1), primaryError: error });
            failure = null;
          } catch (rollbackError) {
            failure = `개발 worker 기동 실패: ${error.message}; 이전 worker 복구 실패: ${rollbackError.message}`;
            error.details = { ...(error.details || {}), rollbackError: String(rollbackError.message || rollbackError) };
          }
        }
        throw error;
      }
    })();
    try { return await activation; }
    finally { activation = null; }
  }

  async function executorRegistered() {
    if (pendingRestart && Date.now() >= retryAt) await recoverPendingRestart();
    if (!current && retryDeployment && Date.now() >= retryAt) {
      try { current = await spawnWithRetries(retryDeployment, { attempts: Math.max(0, maxRestarts - 1) }); retryDeployment = null; retryAt = 0; failure = null; }
      catch (error) { failure = String(error.message || error); retryAt = Date.now() + (restartBackoffMs.at(-1) || 1000); }
    }
    if (!current || !["accepting", "failed", "ready"].includes(current.state) || typeof relay.accept !== "function") return false;
    if (relayRecovery) return relayRecovery;
    const instance = current;
    relayRecovery = (async () => {
      for (const [generation, options] of [...pendingRelayRetires]) {
        if (generation === instance.generation) continue;
        await retireRelayGeneration(generation, options);
      }
      const result = await relay.accept(instance.generation);
      if (result?.ok === false) throw codedError(result.code || "EXECUTOR_GONE", result.error || "Electron worker 세대 재허용 실패");
      if (current !== instance || !instanceAlive(instance)) return false;
      instance.state = "accepting";
      failure = null;
      return true;
    })().catch(error => {
      failure = String(error.message || error);
      if (current === instance) instance.state = "failed";
      return false;
    }).finally(() => { relayRecovery = null; });
    return relayRecovery;
  }

  return { start, request, hostTask, activate, reloadSource, status, liveStatus, shutdown, startupDeployment, executorRegistered, relayEvent,
  };
}
