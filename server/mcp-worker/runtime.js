import { createWorkerActivity } from "./activity.js";
import { createWorkerStatus } from "./status.js";

const replyType = type => `${type}.result`;

export function createWorkerRuntime({ protocol = 1, deployId, workerGeneration, token, transport, lock,
  service, activity = createWorkerActivity(), now, exit = () => {} } = {}) {
  if (!transport?.connected || typeof transport.send !== "function") throw new Error("부모 IPC 채널이 필요합니다.");
  if (typeof token !== "string" || token.length < 32) throw new Error("일회용 worker 토큰이 필요합니다.");
  if (!deployId || !workerGeneration) throw new Error("worker 배포 ID와 세대가 필요합니다.");
  const status = createWorkerStatus({ deployId, workerGeneration, activity, now });
  let secret = token, authorized = false, drained = false, stopped = false;
  let lifecycle = Promise.resolve();
  const send = message => transport.connected && transport.send({ protocol, workerGeneration, ...message });
  const result = (message, ok, output, error) => send({ type: replyType(message.type), requestId: message.requestId,
    ok, ...(ok ? { output } : { error: { code: error?.code || "INTERNAL", message: error?.message || String(error), retryable: false, details: error?.details || {} } }) });

  const stopAccepting = () => {
    activity.stopAccepting();
    if (!["stopping", "failed"].includes(status.get().state)) status.setState("draining");
  };
  const lockLost = () => {
    stopAccepting();
    status.setState("failed", Object.assign(new Error("worker 잠금 소유권을 잃었습니다."), { code: "STALE_WORKER" }));
  };
  const drain = async message => {
    stopAccepting();
    const observations = activity.snapshot().observations;
    if (observations.length) {
      const error = Object.assign(new Error("활성 관찰을 먼저 끝내야 합니다."), { code: "BUSY", details: { observations } });
      result(message, false, null, error);
      return false;
    }
    const idle = await activity.waitForIdle({ timeoutMs: message.timeoutMs || 30000 });
    if (!idle) {
      const error = Object.assign(new Error("worker drain 시간이 초과됐습니다."), { code: "TIMEOUT", details: { active: activity.snapshot() } });
      result(message, false, null, error);
      return false;
    }
    drained = true;
    result(message, true, { active: activity.snapshot() });
    return true;
  };
  const shutdown = async ({ notify = true } = {}) => {
    if (stopped) return;
    stopped = true;
    stopAccepting();
    status.setState("stopping");
    lock.release();
    if (notify) send({ type: "worker.stopped", deployId, pid: process.pid });
    exit(0);
  };
  const parentGone = async () => {
    stopAccepting();
    try {
      if (activity.snapshot().observations.length) await service.stopObservations?.("부모 IPC 단절");
      await activity.waitForIdle({ timeoutMs: 30000 });
    } finally { await shutdown({ notify: false }); }
  };
  const handle = message => {
    if (!message || message.protocol !== protocol || message.workerGeneration !== workerGeneration) return;
    if (message.type === "host.response") return;
    if (message.type === "relay.event") return;
    if (message.type === "worker.status") {
      if (!authorized) return result(message, false, null, Object.assign(new Error("승인되지 않은 worker입니다."), { code: "UNAUTHORIZED_WORKER" }));
      return result(message, true, status.get());
    }
    if (message.type === "worker.request") {
      if (!authorized) return result(message, false, null, Object.assign(new Error("승인되지 않은 worker입니다."), { code: "UNAUTHORIZED_WORKER" }));
      if (typeof lock.held === "function" && !lock.held()) {
        return result(message, false, null, Object.assign(new Error("worker 잠금 소유권이 없습니다."), { code: "STALE_WORKER" }));
      }
      service.dispatch(message).then(response => result(message, true, response), error => result(message, false, null, error));
      return;
    }
    if (message.type === "worker.hostTask") {
      if (!authorized) return result(message, false, null, Object.assign(new Error("승인되지 않은 worker입니다."), { code: "UNAUTHORIZED_WORKER" }));
      if (status.get().state !== "accepting" || typeof lock.held === "function" && !lock.held()) {
        return result(message, false, null, Object.assign(new Error("host 작업을 받을 worker가 아닙니다."), { code: "WORKER_UNAVAILABLE" }));
      }
      Promise.resolve().then(() => service.hostTask(message))
        .then(response => result(message, true, response), error => result(message, false, null, error));
      return;
    }
    lifecycle = lifecycle.then(async () => {
      if (message.type === "worker.authorized") {
        if (authorized || !secret) return result(message, false, null, Object.assign(new Error("worker 토큰이 이미 소비됐습니다."), { code: "UNAUTHORIZED_WORKER" }));
        authorized = true;
        secret = null;
        lock.acquire();
        status.setState("ready");
        send({ type: "worker.ready", deployId, pid: process.pid });
        return;
      }
      if (!authorized) return result(message, false, null, Object.assign(new Error("승인되지 않은 worker입니다."), { code: "UNAUTHORIZED_WORKER" }));
      if (message.type === "worker.accept") {
        drained = false;
        activity.startAccepting();
        status.setState("accepting");
        return result(message, true, status.get());
      }
      if (message.type === "worker.stopAccepting") {
        stopAccepting();
        return result(message, true, status.get());
      }
      if (message.type === "worker.drain") return drain(message);
      if (message.type === "worker.stopObservations") {
        const stoppedObservations = await service.stopObservations?.("명시적 worker 교체") || [];
        return result(message, true, { stopped: stoppedObservations });
      }
      if (message.type === "worker.shutdown") {
        const active = activity.snapshot();
        if (!drained || Object.values(active).some(items => items.length))
          return result(message, false, null, Object.assign(new Error("worker drain이 끝나지 않았습니다."), { code: "BUSY", details: { active } }));
        result(message, true, {});
        return shutdown();
      }
      return result(message, false, null, Object.assign(new Error(`알 수 없는 worker 메시지입니다: ${message.type}`), { code: "INVALID_REQUEST" }));
    }).catch(error => {
      status.setState("failed", error);
      result(message, false, null, error);
      if (message.type === "worker.authorized") {
        stopped = true;
        stopAccepting();
        try { lock.release(); } catch {}
        try { transport.disconnect?.(); } catch {}
        exit(1);
      }
    });
  };
  transport.on("message", handle);
  transport.once("disconnect", () => { lifecycle = lifecycle.then(parentGone); });
  send({ type: "worker.hello", deployId, pid: process.pid, token: secret });
  return { activity, status, handle, parentGone, terminate: parentGone, lockLost, done: () => lifecycle };
}
