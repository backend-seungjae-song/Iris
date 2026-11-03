// 도구 연결이 다시 시작돼 회차 열쇠가 사라진 뒤 같은 세션의 이어받기
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";
const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-run-takeover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const asked = [];
  const channel = ({ restore = async () => ({ ok: true }) } = {}) => createQaChannel({ runKeys: true, ledger: createQaLedger({ dir: path.join(dir, "ledger"), anchor }),
    createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }), restore,
    execute: async () => ({ ok: true, data: {} }), release: async () => {},
    ask: async (_tab, session, summary, options) => { asked.push({ session, summary, options }); return { ok: true, data: { approved: true } }; },
    mobileFactory: () => ({}), makeRoutes: () => ({ list: async () => [] }) });
  return { channel, asked, ledger: () => createQaLedger({ dir: path.join(dir, "ledger"), anchor }) };
}
const begin = async call => {
  const begun = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  return begun.data;
};

test("서버가 다시 시작되고 열쇠가 없는 같은 세션은 묻지 않고 새 열쇠로 이어 가고 옛 열쇠는 거부된다", async (t) => {
  const { channel, asked, ledger } = setup(t);
  const { runId, runKey: oldKey } = await begin(channel());
  const before = asked.length;
  const restarted = channel();
  const resumed = await restarted("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.takenOver, true);
  assert.match(resumed.data.runKey, /^[a-f0-9]{64}$/);
  assert.equal(asked.length, before);
  const fresh = await restarted("review", {}, "owner", runId, resumed.data.runKey);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  const stale = await restarted("review", {}, "owner", runId, oldKey);
  assert.match(stale.error, /도구 연결이 아닙니다/);
  const keys = (await ledger().verify(runId)).events.filter(r => r.event.kind === "run_key");
  assert.equal(keys.length, 2);
  assert.equal(keys[1].event.detail.via, "같은 세션 재연결");
});

test("서버는 그대로이고 도구 연결만 다시 시작된 같은 세션도 묻지 않고 이어 간다", async (t) => {
  const { channel, asked } = setup(t);
  const call = channel();
  const { runId } = await begin(call);
  const before = asked.length;
  const resumed = await call("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.takenOver, true);
  assert.equal(asked.length, before);
});

test("틀린 열쇠를 든 같은 세션도 새 열쇠로 이어 간다", async (t) => {
  const { channel } = setup(t);
  const { runId } = await begin(channel());
  const resumed = await channel()("run_resume", {}, "owner", runId, "f".repeat(64));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.takenOver, true);
});

test("다른 세션은 거부하고 열쇠를 새로 만들지 않는다", async (t) => {
  const { channel, ledger } = setup(t);
  const { runId } = await begin(channel());
  for (const call of [channel(), channel()]) {
    const resumed = await call("run_resume", {}, "intruder", runId);
    assert.equal(resumed.ok, false);
    assert.match(resumed.error, /이 세션의 QA 회차가 아닙니다/);
  }
  assert.equal((await ledger().verify(runId)).events.filter(r => r.event.kind === "run_key").length, 1);
});

test("맞는 열쇠로 재개하면 새 열쇠를 만들지 않는다", async (t) => {
  const { channel, ledger } = setup(t);
  const { runId, runKey } = await begin(channel());
  const resumed = await channel()("run_resume", {}, "owner", runId, runKey);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.takenOver, undefined);
  assert.equal((await ledger().verify(runId)).events.filter(r => r.event.kind === "run_key").length, 1);
});

test("탭 복원이 실패하면 새 열쇠를 기록하지 않고, 복원이 되면 재시도가 이어 간다", async (t) => {
  const { channel, asked, ledger } = setup(t);
  const { runId } = await begin(channel());
  const before = asked.length;
  let restoreOk = false;
  const call = channel({ restore: async () => restoreOk ? { ok: true } : { ok: false, error: "기기가 없습니다" } });
  for (let i = 0; i < 3; i++) assert.equal((await call("run_resume", {}, "owner", runId)).ok, false);
  assert.equal((await ledger().verify(runId)).events.filter(r => r.event.kind === "run_key").length, 1);
  restoreOk = true;
  const retried = await call("run_resume", {}, "owner", runId);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.data.takenOver, true);
  assert.equal(asked.length, before);
});

test("도구 연결은 이어받기로 받은 새 열쇠를 보관하고 LLM 에게 주는 결과에서 뺀다", async () => {
  const { EventEmitter } = await import("node:events");
  const { callQa } = await import("../bin/iris-qa.mjs");
  const sent = [], keys = new Map();
  const request = (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = payload => {
      const body = JSON.parse(payload); sent.push(body);
      const res = new EventEmitter(); onResponse(res);
      const data = body.cmd === "run_resume" ? { runId: "qa-1", runKey: "n".repeat(64), takenOver: true } : { tabs: [] };
      res.emit("data", JSON.stringify({ ok: true, data })); res.emit("end");
    };
    return req;
  };
  const resumed = await callQa("qa_run_resume", { run: "qa-1" }, { session: async () => "owner", request, keys });
  assert.equal(resumed.data.runKey, undefined);
  assert.equal(resumed.data.takenOver, true);
  await callQa("qa_tabs", { run: "qa-1" }, { session: async () => "owner", request, keys });
  assert.equal(sent.at(-1).key, "n".repeat(64));
});

test("서버가 다시 시작된 뒤 이어받기 전에 다른 명령을 부르면 같은 세션에는 qa_run_resume 을 먼저 부르라고 알린다", async (t) => {
  // qa-2ab6e345: 설치 뒤 첫 qa_report 가 "이 세션의 QA 회차가 아닙니다"로 거부됨
  const { channel } = setup(t);
  const { runId, runKey } = await begin(channel());
  const restarted = channel();
  const own = await restarted("review", {}, "owner", runId, runKey);
  assert.equal(own.ok, false);
  assert.match(own.error, /qa_run_resume 을 먼저/);
  const other = await restarted("review", {}, "stranger", runId, runKey);
  assert.match(other.error, /이 세션의 QA 회차가 아닙니다/);
});
