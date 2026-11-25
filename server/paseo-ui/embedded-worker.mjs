import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createEmbeddedRuntime } from "./embedded-runtime.mjs";

const operations = ["ensureAgent", "snapshot", "models", "listCommands", "setSetting", "sendMessage", "respondToPermission", "cancel", "describeHandle",
  "releaseForTerminal", "returnFromTerminal", "release", "abortTerminalRelease", "prepareNativeFirst", "canDispose", "close"];

if (!isMainThread && workerData?.irisEmbedded) {
  const runtime = createEmbeddedRuntime(workerData.options);
  const subscriptions = new Map();
  const verifications = new Map();
  parentPort.on("message", async ({ id, method, args, ok, reason }) => {
    if (method === "verified") {
      const reply = verifications.get(id);
      verifications.delete(id);
      if (reply) ok ? reply.resolve() : reply.reject(new Error(reason));
      return;
    }
    try {
      if (method === "subscribe") {
        const agentId = args[0];
        subscriptions.set(agentId, runtime.subscribe(agentId, () => parentPort.postMessage({ changed: agentId })));
      } else if (method === "unsubscribe") {
        subscriptions.get(args[0])?.();
        subscriptions.delete(args[0]);
      } else {
        if (!operations.includes(method)) throw new Error("알 수 없는 대화 작업입니다");
        if (method === "returnFromTerminal") args.push(() => new Promise((resolve, reject) => {
          verifications.set(id, { resolve, reject });
          parentPort.postMessage({ verify: id });
        }));
        const value = await runtime[method](...args);
        parentPort.postMessage({ id, value });
        return;
      }
      parentPort.postMessage({ id });
    } catch (error) { parentPort.postMessage({ id, error: String(error?.message || error) }); }
  });
}

export function createSharedEmbeddedRuntime(options, { workerFactory, idleMs = 2000 } = {}) {
  const cold = createEmbeddedRuntime(options);
  const listeners = new Map();
  let current, retiring, idleTimer, sequence = 0, closed = false;

  function launch() {
    const worker = workerFactory?.({ options }) || new Worker(new URL(import.meta.url), { workerData: { irisEmbedded: true, options }, execArgv: [] });
    const state = { worker, pending: new Map() };
    worker.on("message", ({ changed, verify, id, value, error }) => {
      if (changed) {
        for (const fn of listeners.get(changed) || []) fn();
      } else if (verify) {
        const check = state.pending.get(verify)?.verify;
        Promise.resolve().then(() => check()).then(
          () => worker.postMessage({ id: verify, method: "verified", ok: true }),
          err => worker.postMessage({ id: verify, method: "verified", ok: false, reason: err.message }));
      } else {
        const request = state.pending.get(id);
        if (request) request.finish(error ? new Error(error) : null, value);
      }
    });
    const fail = error => {
      for (const request of state.pending.values()) request.finish(error);
      if (current === state) current = null;
    };
    worker.on("error", fail);
    worker.once("exit", code => fail(new Error(`대화 처리가 종료되었습니다 (${code})`)));
    for (const id of listeners.keys()) void request(state, "subscribe", [id]).catch(console.error);
    return state;
  }

  function request(state, method, args, verify, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      let timer;
      const finish = (error, value) => {
        if (state.pending.get(id)?.finish !== finish) return;
        clearTimeout(timer);
        state.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      state.pending.set(id, { verify, finish });
      if (timeoutMs > 0) timer = setTimeout(() => finish(new Error("대화 처리 응답 시간이 초과되었습니다")), timeoutMs);
      try { state.worker.postMessage({ id, method, args }); }
      catch (error) { finish(error); }
    });
  }

  async function call(method, args) {
    if (closed) throw new Error("대화 처리가 종료 중입니다");
    clearTimeout(idleTimer);
    if (retiring) await retiring;
    if (closed) throw new Error("대화 처리가 종료 중입니다");
    if (!current && ["prepareNativeFirst", "abortTerminalRelease"].includes(method)) return cold[method](...args);
    if (!current && method === "release") return false;
    const verify = method === "returnFromTerminal" ? args.pop() : undefined;
    current ??= launch();
    try { return await request(current, method, args, verify); }
    finally { scheduleIdle(); }
  }

  async function stopWorker(state) {
    try {
      await request(state, "close", [], undefined, 3000);
    } catch (error) { console.warn("대화 종료 실패", error.message); }
    finally {
      try { await state.worker.terminate(); }
      catch (error) { console.warn("대화 처리 강제 종료 실패", error.message); }
    }
  }

  function retire(state) {
    if (current === state) current = null;
    const finished = stopWorker(state);
    const pending = finished.finally(() => { if (retiring === pending) retiring = null; });
    retiring = pending;
    return pending;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (closed || !current || listeners.size || current.pending.size || retiring) return;
    idleTimer = setTimeout(async () => {
      const state = current;
      if (!state || listeners.size || state.pending.size) return;
      const observed = sequence;
      let ready;
      try {
        ready = await request(state, "canDispose", [], undefined, 3000);
      } catch (error) {
        console.warn("대화 메모리 해제 실패", error.message);
        ready = true;
      }
      if (closed || current !== state || listeners.size || state.pending.size) return;
      if (sequence !== observed + 1) { scheduleIdle(); return; }
      if (ready) await retire(state);
    }, idleMs);
    idleTimer.unref();
  }

  return {
    ...Object.fromEntries(operations.filter(key => key !== "close").map(key => [key, (...args) => call(key, args)])),
    subscribe(id, fn) {
      const currentListeners = listeners.get(id) || new Set();
      if (!listeners.has(id) && current) void request(current, "subscribe", [id]).catch(console.error);
      listeners.set(id, currentListeners);
      currentListeners.add(fn);
      return () => {
        currentListeners.delete(fn);
        if (currentListeners.size) return;
        listeners.delete(id);
        if (current) void request(current, "unsubscribe", [id]).then(scheduleIdle, console.error);
      };
    },
    async close() {
      closed = true;
      clearTimeout(idleTimer);
      try {
        if (retiring) await retiring;
        if (current) await stopWorker(current);
      } finally { await cold.close(); }
    },
  };
}
