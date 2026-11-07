// 세션이 qa_app_target clear 로 놓은 기기가 있는 회차의 이어받기(2026-11-01 qa-11828d3d)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter, qaSession } from "./qa-fixtures.mjs";
const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");

const DEV = "11111111-1111-4111-8111-111111111111";

function setup(t, { registered, devices = [] }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-resume-device-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const ledger = () => createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const snapshots = [], released = [];
  const mobileFactory = () => ({ execute: async (_session, command, args) => {
    if (command === "targets") return { ok: true, data: { registered, devices } };
    if (command === "snapshot") { snapshots.push(args.device); return registered.includes(args.device) ? { ok: true, data: { targetId: args.device } } : { ok: false, error: "먼저 target으로 이 세션에 기기를 할당하세요." }; }
    return { ok: true, data: {} };
  } });
  const channel = () => createQaChannel({ ledger: ledger(), createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }),
    restore: async () => ({ ok: true }), execute: async () => ({ ok: true, data: {} }), release: async () => {}, releaseDevice: async (target, run) => { released.push([target, run]); return { ok: true, data: {} }; },
    ask: async () => ({ ok: true, data: { approved: true } }), mobileFactory, makeRoutes: () => ({ list: async () => [] }) });
  return { channel, ledger, snapshots, released };
}

async function runWithDevice(channel, ledger) {
  const begun = await channel()("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  await ledger().append(begun.data.runId, { kind: "observation", mode: "agent_action", cmd: "app_snapshot", surface: DEV, pass: true });
  return begun.data.runId;
}

test("놓은 기기는 확인하지 않고 빼고 이어받음", async (t) => {
  const { channel, ledger, snapshots } = setup(t, { registered: [] });
  const runId = await runWithDevice(channel, ledger);
  const resumed = await channel()("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(resumed.data.releasedDevices, [DEV]);
  assert.deepEqual(snapshots, []);
});

test("등록이 남은 기기는 지금처럼 확인", async (t) => {
  const { channel, ledger, snapshots } = setup(t, { registered: [DEV] });
  const runId = await runWithDevice(channel, ledger);
  const resumed = await channel()("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.releasedDevices, undefined);
  assert.deepEqual(snapshots, [DEV]);
});

// 실제 targets 응답은 사용자 스페이스 탭(mine)도 devices 에 넣음. 놓은 기기가 그렇게 남아 이어받기가 막힌 사례
test("사용자 스페이스 탭으로만 보이는 놓은 기기도 빼고 이어받음", async (t) => {
  const { channel, ledger, snapshots } = setup(t, { registered: [], devices: [{ targetId: DEV, udid: DEV, mine: true, owner: null }] });
  const runId = await runWithDevice(channel, ledger);
  const resumed = await channel()("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(resumed.data.releasedDevices, [DEV]);
  assert.deepEqual(snapshots, []);
});

test("세션 소유 탭의 기기는 등록이 없어도 확인", async (t) => {
  const { channel, ledger, snapshots } = setup(t, { registered: [], devices: [{ targetId: DEV, udid: DEV, owner: "owner" }] });
  const runId = await runWithDevice(channel, ledger);
  await channel()("run_resume", {}, "owner", runId);
  assert.deepEqual(snapshots, [DEV]);
});

// 놓은 기기의 QA 소유가 남아 run_end 뒤에도 다른 회차가 그 기기를 못 쓰던 사례(2026-11-06 qa-1dbbda16 → qa-23e4d018)
test("놓은 기기는 이어받을 때 이 회차의 기기 소유를 푼다", async (t) => {
  const { channel, ledger, released } = setup(t, { registered: [] });
  const runId = await runWithDevice(channel, ledger);
  const resumed = await channel()("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(released, [["device:" + DEV, runId]]);
});

test("이미 끝난 회차를 이어받으면 그 회차가 쓰던 기기 소유를 푼다", async (t) => {
  const { channel, ledger, released } = setup(t, { registered: [] });
  const runId = await runWithDevice(channel, ledger);
  await ledger().end(runId, { session: qaSession() });
  const resumed = await channel()("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.ended, true);
  assert.deepEqual(released, [["device:" + DEV, runId]]);
});
