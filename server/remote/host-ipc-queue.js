import { fitsRemoteIpc, ipcBytes } from "./contract/ipc.js";

export function createHostIpcQueue(options) {
  const send = options?.send;
  if (typeof send !== "function") throw new TypeError("IPC send function is required");
  const perConnectionLimit = options.perConnectionLimit ?? 1024 * 1024;
  const totalLimit = options.totalLimit ?? 8 * 1024 * 1024;
  const onConnectionOverflow = options.onConnectionOverflow || (() => {});
  const onFailure = options.onFailure || (() => {});
  const queue = [];
  const pendingByConnection = new Map();
  let totalPending = 0;
  let inFlight = 0;
  let paused = false;
  let failed = false;

  function add(key, bytes) {
    totalPending += bytes;
    const value = (pendingByConnection.get(key) || 0) + bytes;
    pendingByConnection.set(key, value);
    return value;
  }

  function subtract(key, bytes) {
    totalPending = Math.max(0, totalPending - bytes);
    const value = Math.max(0, (pendingByConnection.get(key) || 0) - bytes);
    if (value === 0) pendingByConnection.delete(key);
    else pendingByConnection.set(key, value);
  }

  function fail(error) {
    if (failed) return;
    failed = true;
    onFailure(error);
  }

  function flush() {
    if (failed || paused) return;
    while (queue.length && !failed && !paused) {
      const item = queue.shift();
      inFlight++;
      let accepted;
      try {
        accepted = send(item.message, (error) => {
          inFlight--;
          subtract(item.key, item.bytes);
          if (error) return fail(error);
          if (paused && inFlight === 0) paused = false;
          flush();
        });
      } catch (error) {
        inFlight--;
        subtract(item.key, item.bytes);
        fail(error);
        return;
      }
      if (accepted === false) paused = true;
    }
  }

  function discard(key) {
    for (let index = queue.length - 1; index >= 0; index--) {
      const item = queue[index];
      if (item.key !== key) continue;
      subtract(item.key, item.bytes);
      queue.splice(index, 1);
    }
  }

  function enqueue(message, key, optionsForMessage = {}) {
    if (failed) return false;
    if (!fitsRemoteIpc(message)) {
      fail(new Error("ipc-message-too-large"));
      return false;
    }
    const bytes = ipcBytes(message);
    const perConnection = add(key, bytes);
    if (totalPending > totalLimit) {
      subtract(key, bytes);
      fail(new Error("ipc-total-backpressure"));
      return false;
    }
    if (!optionsForMessage.control && perConnection > perConnectionLimit) {
      subtract(key, bytes);
      onConnectionOverflow(key);
      return false;
    }
    queue.push({ message, key, bytes });
    flush();
    return true;
  }

  return {
    enqueue,
    discard,
    status: () => ({ paused, inFlight, queued: queue.length, totalPending, pendingByConnection: new Map(pendingByConnection) }),
  };
}
