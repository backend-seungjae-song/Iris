import assert from "node:assert/strict";
import test from "node:test";

import { createHostLeaseStore } from "../server/mcp-host/lease-store.js";

test("만료된 host lease는 다음 점검에서 제거된다", () => {
  let now = 1000;
  const timers = [];
  const store = createHostLeaseStore({ now: () => now, setTimer: (fn) => (timers.push(fn), fn), clearTimer() {} });
  const lease = store.grant({ session: "session-a", run: "run-a" }, { executor: "browser", scope: ["tab"], ttlMs: 100 });
  assert.equal(store.size(), 1);
  now += 101;
  assert.equal(store.size(), 0);
  assert.equal(timers.length, 1);
  store.close();
  assert.equal(lease.executor, "browser");
});
