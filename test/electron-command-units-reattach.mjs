import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCommandUnits } = require("../native/electron/relay/command-units.cjs");

const codedError = (code, message) => Object.assign(new Error(message), { code });
const DEAD = /target closed|detached from target|not attached|session closed|no session with given id|session .*(?:not found|does not exist)/i;

function fixture({ execute, live = true }) {
  const resets = [];
  const units = createCommandUnits({
    queues: new Map(),
    execute,
    redact: (_k, v) => v,
    attachMoments: (_k, _c, v) => v,
    resetSession: (key) => resets.push(key),
    deadSession: DEAD,
    liveTab: () => live,
    refreshTarget: () => ({ debuggerGeneration: 9, documentGeneration: 5 }),
    codedError,
    timeoutMs: 200,
    tailGraceMs: 10,
  });
  const run = (command) => units.run(
    { workerGeneration: "g1", commandId: `g1/${command}/${Math.random()}`, callId: 1, command,
      target: { wcId: 7, debuggerGeneration: 1, documentGeneration: 1, childSessionId: "old" }, args: {} },
    { unit: { command: "snapshot", phase: "last" }, key: 7 });
  return { units, resets, run };
}

test("끊긴 디버거 세션은 다시 붙여 새 세대로 한 번 재시도한다", async () => {
  const seen = [];
  const f = fixture({ execute: async (request) => {
    seen.push(request.target);
    if (seen.length === 1) throw new Error("Debugger is not attached to the tab");
    return { ok: true };
  } });
  assert.deepEqual(await f.run("cdp.send"), { ok: true });
  assert.deepEqual(f.resets, [7]);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].debuggerGeneration, 9);
  assert.equal(seen[1].childSessionId, undefined);
});

test("ax.tree 도 cdp.send 와 같이 다시 붙여 재시도하고 qa- 명령은 재시도하지 않는다", async () => {
  const seen = [];
  const f = fixture({ execute: async (request) => {
    seen.push(request.target);
    if (seen.length === 1) throw new Error("Debugger is not attached to the tab");
    return { nodes: [] };
  } });
  assert.deepEqual(await f.run("ax.tree"), { nodes: [] });
  assert.deepEqual(f.resets, [7]);
  assert.equal(seen[1].debuggerGeneration, 9);
  assert.equal(seen[1].childSessionId, undefined);

  let calls = 0;
  const qa = fixture({ execute: async () => { calls++; throw new Error("Debugger is not attached to the tab"); } });
  const request = { workerGeneration: "g1", commandId: "g1/qa/1", callId: 1, command: "ax.tree", target: { wcId: 7 }, args: {} };
  await assert.rejects(qa.units.run(request, { unit: { command: "qa-snapshot", phase: "last" }, key: 7 }), /not attached/);
  assert.equal(calls, 1);
  assert.deepEqual(qa.resets, []);
});

test("재시도도 끊겨 있으면 session_detached, 탭이 없으면 tab_gone, 다른 오류와 다른 명령은 재시도하지 않는다", async () => {
  let calls = 0;
  const dead = fixture({ execute: async () => { calls++; throw new Error("Target closed"); } });
  await assert.rejects(dead.run("cdp.batch"), (e) => e.code === "session_detached");
  assert.equal(calls, 2);

  const gone = fixture({ live: false, execute: async () => { throw new Error("Target closed"); } });
  await assert.rejects(gone.run("cdp.send"), (e) => e.code === "tab_gone");
  assert.deepEqual(gone.resets, []);

  calls = 0;
  const other = fixture({ execute: async () => { calls++; throw new Error("boom"); } });
  await assert.rejects(other.run("cdp.send"), /boom/);
  assert.equal(calls, 1);

  calls = 0;
  const notCdp = fixture({ execute: async () => { calls++; throw new Error("Target closed"); } });
  await assert.rejects(notCdp.run("wc.info"), /Target closed/);
  assert.equal(calls, 1);

  calls = 0;
  const blocked = fixture({ execute: async () => { calls++; throw codedError("cdp_blocked", "not attached"); } });
  await assert.rejects(blocked.run("cdp.send"), (e) => e.code === "cdp_blocked");
  assert.equal(calls, 1);
});

test("사용자 명령 이름이 qa- 로 시작하면 끊긴 세션을 다시 붙이지 않는다(옛 execWithReattachRaw 와 같음)", async () => {
  for (const userCommand of ["qa-reaction-end", "qa-screenshot", "qa-mode-off"]) {
    let calls = 0;
    const f = fixture({ execute: async () => { calls++; throw new Error("Debugger is not attached to the tab"); } });
    for (const outside of [false, true]) {
      calls = 0;
      await assert.rejects(f.units.run(
        { workerGeneration: "g1", commandId: `g1/${userCommand}/${outside}/${Math.random()}`, callId: 1, command: "cdp.send",
          target: { wcId: 7, debuggerGeneration: 1, documentGeneration: 1 }, args: {} },
        { unit: { command: userCommand, phase: "last", ...(outside ? { outside: true } : {}) }, key: 7 }), /not attached/, `${userCommand} outside=${outside}`);
      assert.equal(calls, 1, `${userCommand} outside=${outside}`);
    }
    assert.deepEqual(f.resets, [], userCommand);
  }
  // qa- 가 아닌 사용자 명령은 그대로 재시도
  let calls = 0;
  const plain = fixture({ execute: async () => { calls++; if (calls === 1) throw new Error("Debugger is not attached to the tab"); return { ok: true }; } });
  assert.deepEqual(await plain.run("cdp.send"), { ok: true });
  assert.equal(calls, 2);
});
