// 기기 부팅보다 먼저 뜬 idb companion 만 교체하는지
import assert from "node:assert/strict";
import test from "node:test";
import { etimeSeconds, missingCompanion, refreshIdbCompanion, staleCompanionPid } from "../bin/mcp/idb-companion.mjs";

const U = "76EDA0E3-F8CC-47FC-8267-EF94ED5F2811";
const other = "11111111-2222-3333-4444-555555555555";
const ps = (companionAge, bootAge, udid = U) => [
  `  4062 ${companionAge} /opt/homebrew/bin/idb_companion --udid ${udid} --grpc-domain-sock /tmp/idb/${udid}_companion.sock --only simulator`,
  ` 85406 ${bootAge} launchd_sim /Users/you/Library/Developer/CoreSimulator/Devices/${U}/data/var/run/launchd_bootstrap.plist`,
  "  9999 01:00 /usr/bin/other",
].join("\n");

test("ps 경과 시간 형식을 초로 바꾼다", () => {
  assert.equal(etimeSeconds("00:39"), 39);
  assert.equal(etimeSeconds("01:26:10"), 5170);
  assert.equal(etimeSeconds("2-01:00:00"), 176400);
  assert.equal(etimeSeconds("x"), null);
});

test("부팅보다 오래된 그 기기의 companion 만 고른다", () => {
  assert.equal(staleCompanionPid(U, ps("01:26:10", "04:31")), 4062);
  assert.equal(staleCompanionPid(U, ps("00:39", "04:31")), null);
  assert.equal(staleCompanionPid(U, ps("01:26:10", "04:31", other)), null);
  assert.equal(staleCompanionPid(U, ps("01:26:10", "04:31").split("\n").slice(0, 1).join("\n")), null);
});

test("낡은 companion 은 종료 뒤 다시 연결하고, 새 companion 은 그대로 둔다", async () => {
  const calls = [];
  let running = true;
  const fake = (psText) => ({ ps: async () => ({ ok: true, out: psText }), kill: (pid) => { calls.push(["kill", pid]); running = false; },
    connect: async () => { calls.push(["connect"]); return { ok: true }; }, wait: async () => {}, isAlive: () => running, checked: new Map() });
  assert.equal(await refreshIdbCompanion(U, fake(ps("01:26:10", "04:31"))), true);
  assert.deepEqual(calls, [["kill", 4062], ["connect"]]);
  calls.length = 0; running = true;
  assert.equal(await refreshIdbCompanion(U, fake(ps("00:39", "04:31"))), false);
  assert.deepEqual(calls, []);
});

test("같은 기기는 10초 안에 다시 확인하지 않는다", async () => {
  let listed = 0, clock = 0;
  const options = { ps: async () => { listed++; return { ok: true, out: ps("00:39", "04:31") }; }, now: () => clock, checked: new Map() };
  await refreshIdbCompanion(U, options);
  clock = 9999; await refreshIdbCompanion(U, options);
  assert.equal(listed, 1);
  clock = 10000; await refreshIdbCompanion(U, options);
  assert.equal(listed, 2);
});

// 앱 재시작 때 companion 만 종료되고 /tmp/idb/state 에 옛 소켓이 남아 idb 가 없는 소켓에 붙던 사례(2026-11-01)
test("켜진 기기에 companion 이 없으면 옛 연결 기록을 지우고 다시 연결한다", async () => {
  const bootOnly = ps("00:39", "04:31").split("\n").slice(1).join("\n");
  assert.equal(missingCompanion(U, bootOnly), true);
  assert.equal(missingCompanion(U, ps("00:39", "04:31")), false);
  assert.equal(missingCompanion(U, "  9999 01:00 /usr/bin/other"), false);
  const calls = [];
  const options = { ps: async () => ({ ok: true, out: bootOnly }), disconnect: async () => { calls.push(["disconnect"]); return { ok: true }; },
    connect: async () => { calls.push(["connect"]); return { ok: true }; }, checked: new Map() };
  assert.equal(await refreshIdbCompanion(U, options), true);
  assert.deepEqual(calls, [["disconnect"], ["connect"]]);
});
