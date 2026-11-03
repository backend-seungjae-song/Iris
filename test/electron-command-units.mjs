import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCommandUnits } = require("../native/electron/relay/command-units.cjs");

const codedError = (code, message) => Object.assign(new Error(message), { code });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// cdpExec 의 옛 경로와 같은 모양으로 queues 에 줄 세우는 옛 명령 대역
function legacyEnqueue(queues, key, work, log, name) {
  const prev = queues.get(key) || Promise.resolve();
  const run = async () => { log.push(`${name}:start`); await work(); log.push(`${name}:end`); };
  const p = prev.then(run, run);
  const tail = p.then(() => {}, () => {});
  queues.set(key, tail);
  return p;
}

function fixture(overrides = {}) {
  const queues = new Map();
  const log = [];
  const closed = [];
  const resets = [];
  const gone = new Map();
  const units = createCommandUnits({
    queues,
    execute: overrides.execute || (async (request) => { log.push(`exec:${request.command}`); return { url: "https://x/", token: "SECRET" }; }),
    redact: overrides.redact || ((key, value) => ({ ...value, token: "[가림]" })),
    attachMoments: overrides.attachMoments || ((key, cmd, value) => ({ ...value, moments: [`m:${cmd}`] })),
    resetSession: (key) => resets.push(key),
    watchTab: (key, onGone) => { gone.set(key, onGone); return () => gone.delete(key); },
    codedError,
    onClose: (info) => { closed.push(info); },
    timeoutMs: overrides.timeoutMs ?? 40,
    tailGraceMs: 20,
  });
  const call = (commandId, phase, extra = {}) => units.run(
    { workerGeneration: "g1", commandId, callId: extra.callId ?? 1, command: extra.command || "wc.info", target: { wcId: 7 }, args: {} },
    { unit: { command: "url", phase }, key: 7 });
  return { queues, log, resets, gone, units, call, closed };
}

test("(a) 단위는 앞서 대기 중인 옛 명령 뒤에 서고 그 뒤 옛 명령은 단위 뒤에 선다", async () => {
  const f = fixture();
  const gate = deferred();
  const first = legacyEnqueue(f.queues, 7, () => gate.promise, f.log, "legacy1");
  const unit = f.call("g1/a", "last");
  await tick();
  const after = legacyEnqueue(f.queues, 7, async () => {}, f.log, "legacy2");
  await tick();
  assert.deepEqual(f.log, ["legacy1:start"]);
  gate.resolve();
  await Promise.all([first, unit, after]);
  assert.deepEqual(f.log, ["legacy1:start", "legacy1:end", "exec:wc.info", "legacy2:start", "legacy2:end"]);
});

test("(a) 여러 호출 단위는 마지막 호출 전까지 다른 옛 명령이 끼지 않는다", async () => {
  const f = fixture();
  await f.call("g1/a", "run");
  const intruder = legacyEnqueue(f.queues, 7, async () => {}, f.log, "intruder");
  await tick();
  await f.call("g1/a", "run", { command: "wc.nav", callId: 2 });
  await tick();
  assert.deepEqual(f.log, ["exec:wc.info", "exec:wc.nav"]);
  await f.call("g1/a", "last", { callId: 3 });
  await intruder;
  assert.deepEqual(f.log, ["exec:wc.info", "exec:wc.nav", "exec:wc.info", "intruder:start", "intruder:end"]);
});

test("(a) 다른 탭의 단위는 서로를 막지 않는다", async () => {
  const f = fixture();
  await f.call("g1/a", "run");
  const other = await f.units.run({ workerGeneration: "g1", commandId: "g1/b", callId: 1, command: "wc.info", target: { wcId: 8 }, args: {} },
    { unit: { command: "url", phase: "last" }, key: 8 });
  assert.equal(other.url, "https://x/");
  await f.call("g1/a", "last", { callId: 2 });
});

test("(b) moments 는 마지막 호출에만 붙고 사용자 명령 이름으로 비운다", async () => {
  const f = fixture();
  const mid = await f.call("g1/a", "run");
  assert.equal(mid.moments, undefined);
  const last = await f.call("g1/a", "last", { callId: 2 });
  assert.deepEqual(last.moments, ["m:url"]);
});

test("(b) 마지막 호출이 실패하면 moments 를 비우지 않는다", async () => {
  let drained = 0;
  const f = fixture({ execute: async () => { throw new Error("boom"); }, attachMoments: (k, c, v) => { drained += 1; return v; } });
  await assert.rejects(() => f.call("g1/a", "last"), /boom/);
  assert.equal(drained, 0);
});

test("(c) 모든 호출 결과에 비밀 가리기를 적용한다", async () => {
  const f = fixture();
  const mid = await f.call("g1/a", "run");
  const last = await f.call("g1/a", "last", { callId: 2 });
  assert.equal(mid.token, "[가림]");
  assert.equal(last.token, "[가림]");
});

test("(e) 마지막 호출이 실패해도 단위가 닫혀 대기열이 풀린다", async () => {
  const f = fixture({ execute: async () => { throw new Error("boom"); } });
  await assert.rejects(() => f.call("g1/a", "last"), /boom/);
  const next = legacyEnqueue(f.queues, 7, async () => {}, f.log, "next");
  await next;
  assert.deepEqual(f.log, ["next:start", "next:end"]);
  assert.equal(f.units.size(), 0);
});

test("(e) 명시 종료로 열린 단위를 닫는다", async () => {
  const f = fixture();
  await f.call("g1/a", "run");
  assert.equal(f.units.size(), 1);
  assert.deepEqual(await f.call("g1/a", "end", { callId: 9 }), { ended: true });
  assert.equal(f.units.size(), 0);
  await legacyEnqueue(f.queues, 7, async () => {}, f.log, "next");
  assert.deepEqual(await f.call("g1/zzz", "end"), { ended: false });
});

test("(e) 시간 초과면 세션을 끊고 대기열을 풀며 이후 호출은 같은 오류를 받는다", async () => {
  const f = fixture({ timeoutMs: 30 });
  await f.call("g1/a", "run");
  const next = legacyEnqueue(f.queues, 7, async () => {}, f.log, "next");
  await next;
  assert.deepEqual(f.resets, [7]);
  await assert.rejects(() => f.call("g1/a", "last", { callId: 2 }), (e) => e.code === "TIMEOUT");
});

test("(e) 시간 초과는 실행 중인 호출도 거부한다", async () => {
  const hang = deferred();
  const f = fixture({ timeoutMs: 30, execute: () => hang.promise });
  await assert.rejects(() => f.call("g1/a", "last"), (e) => e.code === "TIMEOUT");
  await legacyEnqueue(f.queues, 7, async () => {}, f.log, "next");
  assert.deepEqual(f.log.slice(-2), ["next:start", "next:end"]);
});

test("(e) 세대 회수는 대기 중·실행 중 단위를 풀고 다른 세대는 건드리지 않는다", async () => {
  const f = fixture({ timeoutMs: 5000 });
  const gate = deferred();
  const blocker = legacyEnqueue(f.queues, 7, () => gate.promise, f.log, "legacy");
  const waiting = f.call("g1/a", "last");
  const waitingFailure = assert.rejects(waiting, (e) => e.code === "STALE_WORKER");
  await tick();
  f.units.releaseGeneration("g1", codedError("STALE_WORKER", "회수"));
  await waitingFailure;
  gate.resolve();
  await blocker;
  await legacyEnqueue(f.queues, 7, async () => {}, f.log, "after");
  assert.deepEqual(f.log.slice(-2), ["after:start", "after:end"]);
  assert.equal(f.units.size(), 0);

  const other = fixture({ timeoutMs: 5000 });
  await other.units.run({ workerGeneration: "g2", commandId: "g2/a", callId: 1, command: "wc.info", target: { wcId: 7 }, args: {} },
    { unit: { command: "url", phase: "run" }, key: 7 });
  other.units.releaseGeneration("g1", codedError("STALE_WORKER", "회수"));
  assert.equal(other.units.size(), 1);
  other.units.releaseAll(codedError("STALE_WORKER", "회수"));
  assert.equal(other.units.size(), 0);
});

test("(e) 탭이 닫히면 단위가 풀린다", async () => {
  const hang = deferred();
  const f = fixture({ timeoutMs: 5000, execute: () => hang.promise });
  const running = f.call("g1/a", "last");
  const failure = assert.rejects(running, (e) => e.code === "TAB_GONE");
  await tick();
  f.gone.get(7)();
  await failure;
  await legacyEnqueue(f.queues, 7, async () => {}, f.log, "after");
  assert.deepEqual(f.log, ["after:start", "after:end"]);
});

test("정상 종료는 탭 감시와 시간 초과 타이머를 정리한다", async () => {
  const f = fixture();
  await f.call("g1/a", "last");
  assert.equal(f.gone.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(f.resets, []);
});

test("(f) 단위가 닫힐 때(마지막·명시 종료·시간 초과) 그 명령 정보로 onClose 를 한 번 부른다", async () => {
  const f = fixture({ timeoutMs: 30 });
  await f.call("g1/a", "last");
  await f.call("g1/b", "run");
  await f.call("g1/b", "end", { callId: 2 });
  await f.call("g1/c", "run");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(f.closed.map((item) => [item.generation, item.commandId, item.key]).sort(),
    [["g1", "g1/a", 7], ["g1", "g1/b", 7], ["g1", "g1/c", 7]]);
});

test("(f) onClose 는 실행 중이던 호출이 끝난 뒤에 부르고 끝나지 않으면 유예(20ms) 뒤에 부른다", async () => {
  const gate = deferred();
  const f = fixture({ execute: async () => { await gate.promise; return { ok: true }; }, timeoutMs: 20 });
  const pending = f.call("g1/a", "run").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.equal(f.units.size(), 0);
  assert.deepEqual(f.closed, []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.closed.length, 1);
  gate.resolve();
  await pending;
  const quick = fixture();
  await quick.call("g1/q", "last");
  await tick();
  await tick();
  assert.equal(quick.closed.length, 1);
});

// 대기열 밖 단위(outside): 옛 QUEUE_BYPASS 명령은 막힌 명령 뒤에 서지 않음
const outsideCall = (f, commandId, phase, extra = {}) => f.units.run(
  { workerGeneration: "g1", commandId, callId: extra.callId ?? 1, command: extra.command || "wc.info", target: { wcId: 7 }, args: {} },
  { unit: { command: "nativekey", phase, outside: true }, key: 7 });

test("(g) 대기열 밖 단위는 앞서 대기 중인 옛 명령 뒤에 서지 않고 대기열도 점유하지 않는다", async () => {
  const f = fixture();
  const gate = deferred();
  const stuck = legacyEnqueue(f.queues, 7, () => gate.promise, f.log, "stuck");
  await tick();
  const outside = await outsideCall(f, "g1/o", "last");
  assert.deepEqual(f.log, ["stuck:start", "exec:wc.info"], "막힌 명령이 끝나기 전에 실행됨");
  assert.equal(outside.url, "https://x/");
  // 대기열에는 막힌 명령만 있고, 뒤에 선 옛 명령은 막힌 명령 뒤에 선다
  const after = legacyEnqueue(f.queues, 7, async () => {}, f.log, "after");
  await tick();
  assert.deepEqual(f.log, ["stuck:start", "exec:wc.info"]);
  gate.resolve();
  await Promise.all([stuck, after]);
  assert.deepEqual(f.log, ["stuck:start", "exec:wc.info", "stuck:end", "after:start", "after:end"]);
});

test("(g) 대기열 밖 단위도 비밀 가리기를 거치고 관찰 순간은 마지막 호출에만 붙는다", async () => {
  const f = fixture();
  const run = await outsideCall(f, "g1/o", "run");
  assert.equal(run.token, "[가림]");
  assert.equal(run.moments, undefined);
  const last = await outsideCall(f, "g1/o", "last", { callId: 2 });
  assert.equal(last.token, "[가림]");
  assert.deepEqual(last.moments, ["m:nativekey"]);
  assert.equal(f.units.size(), 0, "단위를 만들지 않음");
});

test("(g) 대기열 밖 단위의 마지막 호출과 명시 종료는 얻은 자원을 반환하고 중간 호출은 반환하지 않는다", async () => {
  const f = fixture();
  await outsideCall(f, "g1/a", "run");
  await tick();
  assert.deepEqual(f.closed, []);
  await outsideCall(f, "g1/a", "last", { callId: 2 });
  await tick();
  assert.deepEqual(f.closed.map((item) => [item.generation, item.commandId, item.key]), [["g1", "g1/a", 7]]);
  assert.deepEqual(await outsideCall(f, "g1/b", "end"), { ended: true });
  await tick();
  assert.deepEqual(f.closed.map((item) => item.commandId), ["g1/a", "g1/b"]);
  // 마지막 호출이 실패해도 반환
  const failing = fixture({ execute: async () => { throw codedError("BOOM", "실패"); } });
  await assert.rejects(outsideCall(failing, "g1/c", "last"), /실패/);
  await tick();
  assert.deepEqual(failing.closed.map((item) => item.commandId), ["g1/c"]);
});

test("(g) 대기열 밖 단위의 시간 초과는 오류를 돌려주되 CDP 세션을 끊지 않는다(옛 bypass 경로와 같음)", async () => {
  const gate = deferred();
  const f = fixture({ execute: async () => { await gate.promise; return { ok: true }; }, timeoutMs: 25 });
  await assert.rejects(outsideCall(f, "g1/t", "last"), (error) => error.code === "TIMEOUT");
  assert.deepEqual(f.resets, []);
  gate.resolve();
});

test("(g) 대기열 밖 단위도 끊긴 세션을 한 번 다시 붙여 재시도한다", async () => {
  let calls = 0;
  const resets = [];
  const queues = new Map();
  const units = createCommandUnits({
    queues,
    execute: async (request) => { calls += 1; if (calls === 1) throw new Error("target closed"); return { ok: true, command: request.command }; },
    redact: (_key, value) => value,
    attachMoments: (_key, _cmd, value) => value,
    resetSession: (key) => resets.push(key),
    deadSession: { test: (text) => /target closed/.test(text) },
    refreshTarget: () => ({ documentGeneration: 3, debuggerGeneration: 9 }),
    codedError,
    timeoutMs: 100,
    tailGraceMs: 10,
  });
  const out = await units.run({ workerGeneration: "g1", commandId: "g1/r", callId: 1, command: "cdp.send", target: { wcId: 7, childSessionId: "c" }, args: {} },
    { unit: { command: "nativekey", phase: "last", outside: true }, key: 7 });
  assert.deepEqual(out, { ok: true, command: "cdp.send" });
  assert.deepEqual(resets, [7]);
  assert.equal(calls, 2);
});
