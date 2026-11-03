import crypto from "node:crypto";

export const ACTIVE_KINDS = ["commands", "observations", "mobile", "reports", "journalWrites", "relayCommands"];

const drainingError = () => Object.assign(new Error("MCP 작업 프로세스가 접수를 중지했습니다."), { code: "DRAINING" });

export function createWorkerActivity() {
  const active = Object.fromEntries(ACTIVE_KINDS.map(kind => [kind, new Map()]));
  const waiters = new Set();
  let accepting = false;

  const notify = () => {
    if (ACTIVE_KINDS.every(kind => active[kind].size === 0)) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
  };
  const hold = (kind, id = crypto.randomUUID(), detail = {}) => {
    if (!active[kind]) throw new Error(`알 수 없는 worker 작업 종류입니다: ${kind}`);
    const key = String(id);
    active[kind].set(key, { id: key, startedAt: new Date().toISOString(), ...structuredClone(detail) });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active[kind].delete(key);
      notify();
    };
  };
  const run = async (kind, id, fn, { allowDuringDrain = false, detail } = {}) => {
    if (kind === "commands" && !accepting && !allowDuringDrain) throw drainingError();
    const release = hold(kind, id, detail);
    try { return await fn(); }
    finally { release(); }
  };
  const snapshot = () => Object.fromEntries(ACTIVE_KINDS.map(kind => [kind, [...active[kind].values()].map(value => structuredClone(value))]));
  const waitForIdle = ({ timeoutMs = 30000 } = {}) => {
    if (ACTIVE_KINDS.every(kind => active[kind].size === 0)) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(true); };
      const timer = setTimeout(() => { waiters.delete(done); resolve(false); }, timeoutMs);
      timer.unref?.();
      waiters.add(done);
    });
  };
  return {
    hold, run, snapshot, waitForIdle,
    startAccepting() { accepting = true; },
    stopAccepting() { accepting = false; },
    isAccepting() { return accepting; },
    drainingError,
  };
}
