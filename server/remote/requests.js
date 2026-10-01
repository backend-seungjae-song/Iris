import { randomBytes as nodeRandomBytes } from "node:crypto";

import { isAnswerForRequest } from "./contract/requests.js";
import { projectRequest } from "./projection.js";

export function createRequestStore(options = {}) {
  const now = options.now || Date.now;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const agentRefForPane = options.agentRefForPane || (() => null);
  const records = new Map();
  const subscribers = new Set();

  function notify() {
    for (const subscriber of [...subscribers]) {
      try { subscriber(); } catch {}
    }
  }

  function makeRef() {
    for (let attempt = 0; attempt < 64; attempt++) {
      const ref = randomBytes(16).toString("hex");
      if (!records.has(ref)) return ref;
    }
    throw new Error("request-ref-unavailable");
  }

  function finish(record, status) {
    if (record.status !== "pending") return false;
    record.status = status;
    if (record.timer) clearTimer(record.timer);
    record.timer = null;
    notify();
    return true;
  }

  function expire(ref) {
    const record = records.get(ref);
    if (!record) return false;
    return finish(record, "expired");
  }

  function add(input, deliver, onRemoteCancel = () => {}) {
    if (typeof deliver !== "function" || typeof onRemoteCancel !== "function") {
      throw new TypeError("request callbacks are required");
    }
    const createdAt = Number.isSafeInteger(input?.createdAt) ? input.createdAt : now();
    const agent = input?.agent || agentRefForPane(input?.paneId);
    const record = {
      ref: makeRef(),
      agent,
      kind: input?.kind,
      createdAt,
      expiresAt: input?.expiresAt,
      body: structuredClone(input?.body),
      status: "pending",
      deliver,
      onRemoteCancel,
      remoteCancelNotified: false,
      timer: null,
    };
    projectRequest(record);
    records.set(record.ref, record);
    const delay = Math.max(0, record.expiresAt - now());
    record.timer = setTimer(() => expire(record.ref), delay);
    record.timer?.unref?.();
    notify();
    return projectRequest(record);
  }

  function pending(ref) {
    const record = records.get(ref);
    if (!record) return null;
    if (record.status === "pending" && now() >= record.expiresAt) expire(ref);
    return records.get(ref) || null;
  }

  function list() {
    for (const record of records.values()) {
      if (record.status === "pending" && now() >= record.expiresAt) expire(record.ref);
    }
    return [...records.values()].filter((record) => record.status === "pending").map(projectRequest);
  }

  async function answer(ref, answer) {
    const record = pending(ref);
    if (!record) return "expired";
    if (record.status === "expired" || record.status === "canceled") return "expired";
    if (record.status !== "pending") return "already-answered";
    if (!isAnswerForRequest(record, answer)) return "failed";

    // Mac·폰 동시 답의 한 동기 구간 선점
    finish(record, "answered");
    try {
      return await record.deliver(structuredClone(answer)) === "delivered" ? "delivered" : "failed";
    } catch {
      return "failed";
    }
  }

  function cancel(ref) {
    const record = records.get(ref);
    return record ? finish(record, "canceled") : false;
  }

  function notifyRemoteDisabled() {
    for (const record of records.values()) {
      if (record.status !== "pending" || record.remoteCancelNotified) continue;
      record.remoteCancelNotified = true;
      try { record.onRemoteCancel(); } catch {}
    }
  }

  function close() {
    for (const record of records.values()) if (record.timer) clearTimer(record.timer);
    subscribers.clear();
  }

  return {
    add,
    list,
    answer,
    cancel,
    expire,
    get: pending,
    notifyRemoteDisabled,
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("subscriber must be a function");
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    close,
  };
}
