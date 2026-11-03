// QA 기록 검증: 같은 프로세스의 반복 검증은 새로 붙은 줄만 읽음
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

async function runWithShots(t, count) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-incremental-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }) });
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const source = path.join(dir, "shot.png");
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(source, "png-" + i);
    await ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4", shot: source });
  }
  return { ledger, folder: ledger.paths("run").folder, source };
}

// 검증 중 읽은 사진 파일 수
async function shotReads(t, fn) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) { if (String(file).includes(`${path.sep}shots${path.sep}`)) reads++; return original.call(this, file, ...rest); };
  try { await fn(); } finally { fs.readFileSync = original; }
  return reads;
}

test("줄 추가와 반복 검증은 이미 확인한 사진을 다시 읽지 않는다", async (t) => {
  const { ledger, source } = await runWithShots(t, 5);
  await ledger.verify("run");
  const reads = await shotReads(t, async () => {
    for (let i = 0; i < 4; i++) await ledger.verify("run");
    fs.writeFileSync(source, "png-new");
    await ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4", shot: source });
    const after = await ledger.verify("run");
    assert.equal(after.events.filter(r => r.event.shot).length, 6);
  });
  // 새 사진 하나만 확인
  assert.equal(reads, 1);
});

test("크기를 바꾸지 않고 다시 쓴 기록은 반복 검증에서도 변조로 거부한다", async (t) => {
  const { ledger } = await runWithShots(t, 2);
  await ledger.verify("run");
  const journal = ledger.paths("run").journal;
  const text = fs.readFileSync(journal, "utf8");
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(journal, text.replace('"phase":"S4"', '"phase":"S5"'));
  assert.equal(fs.statSync(journal).size, Buffer.byteLength(text));
  await assert.rejects(ledger.verify("run"), /변조/);
});

test("회차 종료·보고서용 전체 검증은 이미 확인한 사진의 변조도 거부한다", async (t) => {
  const { ledger, folder } = await runWithShots(t, 2);
  await ledger.verify("run");
  const first = fs.readdirSync(path.join(folder, "shots")).sort()[0];
  fs.writeFileSync(path.join(folder, "shots", first), "forged");
  await assert.rejects(ledger.verify("run", { full: true }), /사진 해시/);
});

test("다른 프로세스가 연 기록도 첫 검증은 전체를 확인한다", async (t) => {
  const { ledger, folder } = await runWithShots(t, 2);
  const first = fs.readdirSync(path.join(folder, "shots")).sort()[0];
  fs.writeFileSync(path.join(folder, "shots", first), "forged");
  const fresh = createQaLedger({ dir: path.dirname(folder), anchor: createQaLedgerAnchor({ dir: path.join(path.dirname(path.dirname(folder)), "native") }) });
  await assert.rejects(fresh.verify("run"), /사진 해시/);
});
