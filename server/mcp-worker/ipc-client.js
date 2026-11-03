import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export function createIpcClient({ protocol = 1, workerGeneration, send, events = new EventEmitter(), timeoutMs = null }) {
  if (typeof send !== "function") throw new Error("worker IPC 전송 함수가 필요합니다.");
  const pending = new Map();
  const relayListeners = new Set();
  let closed = false;

  const onMessage = message => {
    if (!message || message.protocol !== protocol || message.workerGeneration !== workerGeneration) return;
    if (message.type === "relay.event") {
      if (!message.event || message.event.workerGeneration !== workerGeneration) return;
      for (const listener of [...relayListeners]) {
        try { listener(message.event); } catch {}
      }
      return;
    }
    if (message.type !== "host.response" || typeof message.requestId !== "string") return;
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    clearTimeout(item.timer);
    if (message.ok) item.resolve(message.output);
    else item.reject(Object.assign(new Error(message.error?.message || "host API 요청이 실패했습니다."), message.error || { code: "INTERNAL" }));
  };
  const onDisconnect = () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error("부모 IPC가 끊겼습니다."), { code: "EXECUTOR_GONE" }));
    }
    pending.clear();
    relayListeners.clear();
  };
  events.on("message", onMessage);
  events.on("disconnect", onDisconnect);

  return {
    async request(operation, { identity, input = {}, commandId, callId, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
      if (closed) throw Object.assign(new Error("부모 IPC가 끊겼습니다."), { code: "EXECUTOR_GONE" });
      const requestId = crypto.randomUUID();
      const message = { protocol, type: "host.request", requestId, workerGeneration, operation, input };
      if (identity && Object.keys(identity).length) message.identity = identity;
      if (commandId) message.commandId = commandId;
      if (callId != null) message.callId = callId;
      return new Promise((resolve, reject) => {
        const timer = Number.isFinite(requestTimeoutMs) ? setTimeout(() => {
          pending.delete(requestId);
          reject(Object.assign(new Error(`host API 응답 시간이 초과됐습니다: ${operation}`), { code: "TIMEOUT" }));
        }, requestTimeoutMs) : null;
        timer?.unref?.();
        pending.set(requestId, { resolve, reject, timer });
        try { send(message); }
        catch (error) { if (timer) clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    },
    onRelayEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("relay 이벤트 listener가 필요합니다.");
      if (closed) throw Object.assign(new Error("부모 IPC가 끊겼습니다."), { code: "EXECUTOR_GONE" });
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
    close() {
      events.off("message", onMessage);
      events.off("disconnect", onDisconnect);
      onDisconnect();
    },
  };
}
