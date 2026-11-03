// 서버 재시작 뒤 qa_run_resume: 앞선 프로세스가 머리 해시 없이 남긴 마지막 줄
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

const channel = ledger => createQaChannel({ ledger,
  createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }), restore: async () => ({ ok: true }),
  execute: async () => ({ ok: true, data: {} }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }),
  mobileFactory: () => ({}), makeRoutes: () => ({ list: async () => [] }) });

test("재시작한 서버의 qa_run_resume 은 머리 해시 없는 마지막 한 줄을 분리하고 그 사실을 기록한다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-resume-unanchored-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const first = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const begun = await channel(first)("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const runId = begun.data.runId;
  const before = await first.verify(runId);
  // 앱 종료 중 쓰인 줄: 해시 사슬은 맞고 앵커만 갱신되지 않음
  const event = { kind: "frame", mode: "agent_action", phase: "S4", at: Date.now() };
  const rec = { seq: before.seq + 1, prevHash: before.head, event };
  rec.hash = crypto.createHash("sha256").update(JSON.stringify(rec)).digest("hex");
  fs.appendFileSync(first.paths(runId).journal, JSON.stringify(rec) + "\n");
  const second = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const resumed = await channel(second)("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const after = await second.verify(runId);
  const note = after.events.at(-1).event;
  assert.equal(note.cmd, "ledger_recovery");
  assert.equal(note.detail.unanchored.seq, before.seq + 1);
  assert.ok(fs.existsSync(path.join(first.paths(runId).folder, "journal.unanchored.jsonl")));
});

test("다른 세션의 qa_run_resume 은 장부를 바꾸지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-resume-unanchored-other-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const first = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const begun = await channel(first)("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  const runId = begun.data.runId;
  const before = await first.verify(runId);
  const rec = { seq: before.seq + 1, prevHash: before.head, event: { kind: "frame", mode: "agent_action", phase: "S4", at: 1 } };
  rec.hash = crypto.createHash("sha256").update(JSON.stringify(rec)).digest("hex");
  fs.appendFileSync(first.paths(runId).journal, JSON.stringify(rec) + "\n");
  const bytes = fs.readFileSync(first.paths(runId).journal, "utf8");
  const resumed = await channel(createQaLedger({ dir: path.join(dir, "ledger"), anchor }))("run_resume", {}, "intruder", runId);
  assert.equal(resumed.ok, false);
  assert.equal(fs.readFileSync(first.paths(runId).journal, "utf8"), bytes);
});

const unanchoredLine = (ledger, runId, verified, event) => {
  const rec = { seq: verified.seq + 1, prevHash: verified.head, event };
  rec.hash = crypto.createHash("sha256").update(JSON.stringify(rec)).digest("hex");
  fs.appendFileSync(ledger.paths(runId).journal, JSON.stringify(rec) + "\n");
};
const keyed = (ledger, approved = true) => createQaChannel({ runKeys: true, ledger,
  createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }), restore: async () => ({ ok: true }),
  execute: async () => ({ ok: true, data: {} }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: approved ? "승인" : "취소", approved } }),
  mobileFactory: () => ({}), makeRoutes: () => ({ list: async () => [] }) });

test("다른 세션의 qa_run_resume 은 분리 전에 거부하고, 회차를 연 세션이 재개할 때 분리 기록이 남는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-resume-unanchored-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const first = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const begun = await keyed(first)("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const { runId, runKey } = begun.data;
  unanchoredLine(first, runId, await first.verify(runId), { kind: "frame", mode: "agent_action", phase: "S4", caption: "기대 밖 화면 변화: 피자·치킨", at: 1 });
  const bytes = fs.readFileSync(first.paths(runId).journal);
  const second = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const wrong = await keyed(second, false)("run_resume", {}, "intruder", runId, "0".repeat(64));
  assert.equal(wrong.ok, false);
  assert.deepEqual(fs.readFileSync(first.paths(runId).journal), bytes);
  const resumed = await keyed(second)("run_resume", {}, "owner", runId, runKey);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const events = (await second.verify(runId)).events;
  assert.equal(events.at(-1).event.cmd, "ledger_recovery");
  // 한글 줄을 뺀 장부는 원래 파일의 그 줄 앞부분과 바이트가 같음
  const kept = fs.readFileSync(first.paths(runId).journal);
  const cut = bytes.lastIndexOf(10, bytes.length - 2) + 1;
  assert.deepEqual(kept.subarray(0, cut), bytes.subarray(0, cut));
});

test("분리 기록을 남기지 못하면 옮긴 줄을 장부로 되돌린다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-resume-unanchored-note-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const first = createQaLedger({ dir: path.join(dir, "ledger"), anchor: real });
  const begun = await channel(first)("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  const runId = begun.data.runId;
  unanchoredLine(first, runId, await first.verify(runId), { kind: "frame", mode: "agent_action", phase: "S4", at: 1 });
  const bytes = fs.readFileSync(first.paths(runId).journal);
  const failing = async (request) => request.op === "advance" ? { ok: false, error: "앵커 응답 없음" } : real(request);
  const second = createQaLedger({ dir: path.join(dir, "ledger"), anchor: failing });
  await assert.rejects(second.recoverUnanchored(runId));
  assert.deepEqual(fs.readFileSync(first.paths(runId).journal), bytes);
});
