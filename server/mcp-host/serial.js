import { AsyncLocalStorage } from "node:async_hooks";

export function createKeyedSerialExecutor() {
  const tails = new Map();
  const context = new AsyncLocalStorage();

  function acquire(owned) {
    let release;
    const ticket = new Promise((resolve) => { release = resolve; });
    const waits = [];
    for (const key of owned) {
      const previous = tails.get(key);
      if (previous) waits.push(previous.catch(() => {}));
      tails.set(key, ticket);
    }
    const lease = { owned, ticket, release, suspended: false };
    return waits.length ? Promise.all(waits).then(() => lease) : Promise.resolve(lease);
  }

  function drop(lease) {
    if (!lease?.ticket) return;
    lease.release();
    for (const key of lease.owned) if (tails.get(key) === lease.ticket) tails.delete(key);
    lease.ticket = null;
    lease.release = null;
  }

  async function run(keys, operation) {
    const owned = [...new Set((keys || []).filter(Boolean).map(String))].sort();
    if (!owned.length) return operation();
    const lease = await acquire(owned);
    return context.run(lease, async () => {
      try { return await operation(); }
      finally { drop(lease); }
    });
  }

  async function runUnlocked(operation) {
    const lease = context.getStore();
    if (!lease?.ticket || lease.suspended) return operation();
    lease.suspended = true;
    drop(lease);
    try { return await operation(); }
    finally {
      const reacquired = await acquire(lease.owned);
      lease.ticket = reacquired.ticket;
      lease.release = reacquired.release;
      lease.suspended = false;
    }
  }

  return { run, runUnlocked, size: () => tails.size };
}
