import assert from "node:assert/strict";
import test from "node:test";

import { createAppSurface } from "../bin/mcp/app.mjs";

// 서버 호출을 주지 않은 표면(검사용)이 먼저 만든 표면의 실제 서버 호출로 Iris 앱·시뮬레이터에 닿으면 안 된다
test("서버 호출 없이 만든 앱 표면은 앞 표면의 서버 호출을 쓰지 않는다", async () => {
  const calls = [];
  createAppSurface({ currentSession: async () => null, journal: async () => null, addReceipt: () => ({ id: "r" }),
    call: async (cmd) => { calls.push(cmd); return { ok: true, data: { tabs: [] } }; } });
  const bare = createAppSurface({ currentSession: async () => null, journal: async () => null, addReceipt: () => ({ id: "r" }) });
  const out = await bare.tools.find((t) => t.name === "app_targets").run({});
  assert.deepEqual(calls, []);
  assert.equal(out.ok, false);
  assert.match(out.error, /서버 호출이 연결되지 않았습니다/);
});
