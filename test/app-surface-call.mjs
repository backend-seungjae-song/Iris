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

test("동시에 실패한 앱 대상도 자기 호출의 오류를 돌려준다", async () => {
  let opens = 0;
  const surface = createAppSurface({
    currentSession: async () => "session-a",
    call: async (cmd, args) => {
      if (cmd === "app-devices") return { ok: true, data: { tabs: [] } };
      if (cmd === "app-targets-get") return { ok: true, data: { devices: [] } };
      if (cmd === "app-open") {
        const id = ++opens;
        await new Promise(resolve => setTimeout(resolve, id === 1 ? 20 : 0));
        return { ok: false, error: `open-${id}` };
      }
      throw new Error(`unexpected app call: ${cmd}`);
    },
  });
  const snapshot = surface.tools.find((tool) => tool.name === "app_snapshot");
  const [alpha, beta] = await Promise.all([
    snapshot.run({}),
    snapshot.run({}),
  ]);
  assert.equal(alpha.ok, false);
  assert.match(alpha.error, /open-1/);
  assert.equal(beta.ok, false);
  assert.match(beta.error, /open-2/);
});
