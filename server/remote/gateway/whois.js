import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function parseWhois(peerIp, stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout));
  } catch {
    throw new Error("whois-invalid-json");
  }
  const nodeId = value?.Node?.StableID;
  const addresses = value?.Node?.Addresses;
  if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 256) throw new Error("whois-node-missing");
  if (!Array.isArray(addresses) || !addresses.includes(`${peerIp}/32`)) throw new Error("whois-address-mismatch");
  return nodeId;
}

export function createWhoisResolver(options) {
  const executable = options?.executable;
  if (typeof executable !== "string" || !executable) throw new TypeError("whois executable is required");
  const run = options.execFile || execFile;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheMs = options.cacheMs ?? 60_000;
  const concurrency = options.concurrency ?? 2;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  function begin() {
    while (active < concurrency && queue.length) {
      const item = queue.shift();
      active++;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error("whois-timeout")), timeoutMs);
        timer?.unref?.();
      });
      Promise.race([
        Promise.resolve(run(executable, ["whois", "--json", item.peerIp], { timeout: timeoutMs, maxBuffer: 64 * 1024 })),
        timeout,
      ]).then(({ stdout }) => {
        const nodeId = parseWhois(item.peerIp, stdout);
        cache.set(item.peerIp, { nodeId, expiresAt: now() + cacheMs });
        item.resolve(nodeId);
      }).catch(item.reject).finally(() => {
        clearTimer(timer);
        active--;
        pending.delete(item.peerIp);
        begin();
      });
    }
  }

  function resolve(peerIp) {
    const saved = cache.get(peerIp);
    if (saved && saved.expiresAt > now()) return Promise.resolve(saved.nodeId);
    if (saved) cache.delete(peerIp);
    if (pending.has(peerIp)) return pending.get(peerIp);
    const promise = new Promise((resolveValue, reject) => {
      queue.push({ peerIp, resolve: resolveValue, reject });
      begin();
    });
    pending.set(peerIp, promise);
    return promise;
  }

  return {
    resolve,
    status: () => ({ active, queued: queue.length, cached: cache.size }),
  };
}
