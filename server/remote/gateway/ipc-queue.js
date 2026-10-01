import { fitsRemoteIpc, ipcBytes } from "../contract/ipc.js";

export function createGatewayIpcQueue(options) {
  const send = options?.send;
  if (typeof send !== "function") throw new TypeError("IPC send function is required");
  const maximum = options.maximumPerConnection ?? 256 * 1024;
  const onOverflow = options.onOverflow || (() => {});
  const onFailure = options.onFailure || (() => {});
  const queue = [];
  const pendingBytes = new Map();
  let inFlight = 0;
  let paused = false;
  let failed = false;

  function add(key, amount) {
    const next = (pendingBytes.get(key) || 0) + amount;
    pendingBytes.set(key, next);
    return next;
  }

  function subtract(key, amount) {
    const next = Math.max(0, (pendingBytes.get(key) || 0) - amount);
    if (next === 0) pendingBytes.delete(key);
    else pendingBytes.set(key, next);
  }

  function flush() {
    if (paused || failed) return;
    while (queue.length && !paused && !failed) {
      const item = queue.shift();
      inFlight++;
      let accepted;
      try {
        accepted = send(item.message, (error) => {
          inFlight--;
          subtract(item.key, item.bytes);
          if (error && !failed) {
            failed = true;
            onFailure(error);
            return;
          }
          if (paused && inFlight === 0) paused = false;
          flush();
        });
      } catch (error) {
        inFlight--;
        subtract(item.key, item.bytes);
        failed = true;
        onFailure(error);
        return;
      }
      if (accepted === false) paused = true;
    }
  }

  function enqueue(message, key) {
    if (failed) return false;
    if (!fitsRemoteIpc(message)) {
      failed = true;
      onFailure(new Error("ipc-message-too-large"));
      return false;
    }
    const bytes = ipcBytes(message);
    if (add(key, bytes) > maximum) {
      subtract(key, bytes);
      onOverflow(key);
      return false;
    }
    queue.push({ message, key, bytes });
    flush();
    return true;
  }

  function discard(key) {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].key !== key) continue;
      subtract(key, queue[index].bytes);
      queue.splice(index, 1);
    }
  }

  return {
    enqueue,
    discard,
    status: () => ({ paused, inFlight, queued: queue.length, pendingBytes: new Map(pendingBytes) }),
  };
}
