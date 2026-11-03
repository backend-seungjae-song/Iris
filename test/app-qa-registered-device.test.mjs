import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-app-qa-registered-"));
process.env.IRIS_STATE_DIR = stateDir;
process.env.IRIS_PORT = "4291";
const { createAppSurface } = await import("../bin/mcp/app.mjs");
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const qaTab = (udid) => ({ udid, name: "iPhone 13", mine: false, owner: "other", tab: `tab-${udid}`, qaRun: "qa-run-1" });

function surface(registered, tabs) {
  return createAppSurface({ currentSession: async () => "session", journal: async () => null, addReceipt: () => ({}),
    call: async (cmd) => {
      if (cmd === "app-targets-get") return { ok: true, data: { devices: registered } };
      if (cmd === "app-devices") return { ok: true, data: { tabs } };
      throw new Error(`Unexpected command: ${cmd}`);
    } });
}

test("사용자가 지목해 등록한 기기는 QA 회차가 잡고 있어도 앱 도구 대상이다", async () => {
  const app = surface([A], [qaTab(A)]);
  assert.equal(await app.simTarget(), A);
  assert.equal(await app.simTarget(A), A);
});

test("등록하지 않은 QA 회차 기기는 여전히 앱 도구 대상이 아니다", async () => {
  const app = surface([A], [qaTab(A), qaTab(B)]);
  assert.equal(await app.simTarget(B), null);
});
