import fs from "node:fs";
import path from "node:path";

import { stateHome } from "./state-home.cjs";
import { allKeys, idOfKey, isFolderKey, keyOf } from "./space-key.js";

const MAX_KEYS = 1_000;

export function createSpaceOrderStore(options = {}) {
  const filePath = options.filePath || path.join(stateHome(), "space-order.json");
  const canonicalKey = options.keyOf || keyOf;
  const folderKey = options.isFolderKey || isFolderKey;
  const knownKeys = options.knownKeys || (() => Object.values(allKeys()));
  const resolveId = options.idOfKey || idOfKey;
  const subscribers = new Set();
  let order = [];
  let initialized = false;

  function normalize(value) {
    if (!Array.isArray(value)) return null;
    const known = new Set(knownKeys().map(canonicalKey).filter(folderKey));
    const next = [];
    const seen = new Set();
    for (const valueKey of value.slice(0, MAX_KEYS)) {
      if (typeof valueKey !== "string") continue;
      const key = canonicalKey(valueKey);
      if (!folderKey(key) || !known.has(key) || seen.has(key)) continue;
      seen.add(key);
      next.push(key);
    }
    return next;
  }

  function initialize() {
    if (initialized) return [...order];
    initialized = true;
    try { order = normalize(JSON.parse(fs.readFileSync(filePath, "utf8"))) || []; }
    catch { order = []; }
    return [...order];
  }

  function persist(next) {
    const dir = path.dirname(filePath);
    const temporary = `${filePath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  function set(value) {
    const next = normalize(value);
    if (!next) return { ok: false, changed: false };
    if (JSON.stringify(next) === JSON.stringify(order)) return { ok: true, changed: false };
    try { persist(next); }
    catch { return { ok: false, changed: false }; }
    order = next;
    for (const subscriber of [...subscribers]) {
      try { subscriber(); } catch {}
    }
    return { ok: true, changed: true };
  }

  function orderWorkspaces(workspaces) {
    const list = Array.isArray(workspaces) ? workspaces : [];
    const liveIds = list.map((space) => space?.id).filter((id) => typeof id === "string" && id);
    const byId = new Map(list.map((space) => [space?.id, space]));
    const sorted = [];
    for (const key of order) {
      const id = resolveId(key, liveIds);
      if (!byId.has(id)) continue;
      sorted.push(byId.get(id));
      byId.delete(id);
    }
    for (const space of list) if (byId.has(space?.id)) {
      sorted.push(space);
      byId.delete(space.id);
    }
    return sorted;
  }

  return {
    initialize,
    set,
    list: () => [...order],
    orderWorkspaces,
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("subscriber must be a function");
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

export function handleSpaceOrderMessage(ws, message, store) {
  if (message?.type !== "space-order.set") return false;
  if (!ws?._local || !ws?._ui) {
    try { ws?.send?.(JSON.stringify({ type: "control-error", message: "인증된 로컬 Iris UI만 스페이스 순서를 바꿀 수 있습니다" })); } catch {}
    return true;
  }
  const result = store.set(message.order);
  if (!result.ok) {
    try { ws.send(JSON.stringify({ type: "control-error", message: "스페이스 순서를 저장하지 못했습니다" })); } catch {}
  }
  return true;
}
