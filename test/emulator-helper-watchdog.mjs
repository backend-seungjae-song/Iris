import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHelperWatchdog, plan, aliveFromPs } = require("../native/electron/emulator/helper-watchdog.cjs");

const A = "76EDA0E3-F8CC-47FC-8267-EF94ED5F2811", B = "11111111-2222-3333-4444-555555555555";
const helperLine = (udid) => `/Users/x/Library/Application Support/Iris/serve-sim-runtime/bin/serve-sim-bin ${udid} --port 3100`;
const simctl = (...udids) => JSON.stringify({ devices: { "iOS-18": udids.map((udid) => ({ udid, state: "Booted" })) } });

test("켜진 iOS 기기 중 도우미가 없는 기기만, 붙은 탭 하나와 함께 고른다", () => {
  const sessions = [{ deviceUdid: A, backend: "ios" }, { deviceUdid: B, backend: "ios" }, { deviceUdid: "emulator-5554", backend: "android" }];
  const worktrees = [["space:a", A], ["space:a2", A], ["space:b", B], ["space:c", "emulator-5554"]];
  assert.deepEqual(plan({ sessions, worktrees, alive: new Set([B]), booted: new Set([A, B]) }), [{ udid: A, worktree: "space:a" }]);
  assert.deepEqual(plan({ sessions, worktrees, alive: new Set(), booted: new Set([B]) }), [{ udid: B, worktree: "space:b" }], "꺼진 기기는 다시 띄우지 않음");
  assert.deepEqual(plan({ sessions, worktrees: [], alive: new Set(), booted: new Set([A]) }), [], "붙은 탭이 없으면 다시 띄우지 않음");
  assert.deepEqual(aliveFromPs(`${helperLine(A)}\n/opt/homebrew/bin/idb_companion --udid ${B}\n`, [A, B]), new Set([A]));
});

function rig({ ps, booted }) {
  const calls = [];
  const registry = { listSessions: () => [{ deviceUdid: A, backend: "ios" }], activeByWorktree: new Map([["space:a", A]]) };
  const exec = async (command) => { calls.push(command); return command === "ps" ? ps() : booted(); };
  const reattached = [];
  const dog = createHelperWatchdog({ registry, exec, retryMs: 10000, reattach: async (udid, worktree) => { reattached.push([udid, worktree]); }, log: { info() {}, warn() {} } });
  return { dog, calls, reattached };
}

test("도우미가 끝나면 다시 붙이고, 살아 있으면 simctl 도 부르지 않으며, 재시도는 간격을 둔다", async () => {
  let helper = true;
  const { dog, calls, reattached } = rig({ ps: () => (helper ? helperLine(A) : "/bin/zsh"), booted: () => simctl(A) });
  await dog.tick(1000);
  assert.deepEqual([calls, reattached], [["ps"], []]);
  helper = false;
  await dog.tick(2000);
  assert.deepEqual(reattached, [[A, "space:a"]]);
  await dog.tick(5000);
  assert.equal(reattached.length, 1, "10초 안에는 다시 시도하지 않음");
  await dog.tick(12001);
  assert.equal(reattached.length, 2);
});

test("ps·simctl 을 읽지 못하면 다시 띄우지 않는다", async () => {
  const noPs = rig({ ps: () => null, booted: () => simctl(A) });
  await noPs.dog.tick(1000);
  assert.deepEqual(noPs.reattached, []);
  const noSim = rig({ ps: () => "/bin/zsh", booted: () => null });
  await noSim.dog.tick(1000);
  assert.deepEqual(noSim.reattached, []);
});
