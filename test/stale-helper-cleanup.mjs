import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { cleanupPriorHelpers, priorHelpers } = require("../native/electron/emulator/stale-helper-cleanup.cjs");

const runtimeRoot = "/Volumes/Iris Fixture/Library/Application Support/Iris/serve-sim-runtime";
const deviceUdid = "D21A6DEC-41A5-4996-9A40-DF2BF656FF4A";
const options = { runtimeRoot, deviceUdid, activePid: 200, appUptimeSeconds: 3600 };
const helper = (pid, age, root = runtimeRoot, udid = deviceUdid, cpu = 90) =>
  `${pid} ${age} ${cpu} ${root}/0.1.0/bin/serve-sim-bin ${udid} --port ${pid}`;

test("only helpers from a prior Iris run on the same device are candidates", () => {
  const rows = [
    helper(100, "02:00:00"),
    helper(200, "02:00:00"),
    helper(300, "00:30:00"),
    helper(400, "02:00:00", "/Applications/Other/serve-sim-runtime"),
    helper(500, "02:00:00", runtimeRoot, "another-device"),
    helper(600, "02:00:00", runtimeRoot, deviceUdid, 2),
  ].join("\n");
  assert.deepEqual(priorHelpers(rows, options).map((item) => item.pid), [100]);
  assert.deepEqual(priorHelpers(rows, { ...options, activePid: undefined }), []);
});

test("connected prior helpers remain running", async () => {
  const terminated = [];
  await cleanupPriorHelpers(options, {
    processList: async () => helper(100, "02:00:00"),
    hasClients: async () => true,
    pause: async () => {},
    terminate: (pid) => terminated.push(pid),
  });
  assert.deepEqual(terminated, []);
});

test("a disconnected prior helper is stopped after its identity and connections are rechecked", async () => {
  const terminated = [];
  const result = await cleanupPriorHelpers(options, {
    processList: async () => helper(100, "02:00:00"),
    hasClients: async () => false,
    pause: async () => {},
    terminate: (pid) => terminated.push(pid),
  });
  assert.deepEqual(result, [100]);
  assert.deepEqual(terminated, [100]);
});

test("a helper that gains a client or changes identity is kept", async () => {
  for (const scenario of [
    { rows: [helper(100, "02:00:00"), helper(100, "02:00:00")], clients: [false, true] },
    { rows: [helper(100, "02:00:00"), helper(100, "00:01:00")], clients: [false] },
    { rows: [helper(100, "02:00:00"), helper(100, "02:00:00", runtimeRoot, deviceUdid, 2)], clients: [false] },
  ]) {
    const terminated = [];
    const rows = [...scenario.rows];
    const clients = [...scenario.clients];
    await cleanupPriorHelpers(options, {
      processList: async () => rows.shift(),
      hasClients: async () => clients.shift(),
      pause: async () => {},
      terminate: (pid) => terminated.push(pid),
    });
    assert.deepEqual(terminated, []);
  }
});
