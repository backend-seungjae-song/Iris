import os from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { qaCharter, qaPlan } from "./qa-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const testRoot = process.env.IRIS_QA_TEST_DIR || path.join(realpathSync(os.tmpdir()), "qa-ledger-tests");
const setup = () => {
  mkdirSync(testRoot, { recursive: true });
  const dir = mkdtempSync(path.join(testRoot, "iris-qa-ledger-"));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  return { dir, anchor, ledger: createQaLedger({ anchor, dir }) };
};

test("장부의 모든 줄과 메인 프로세스 머리를 대조한다", async () => {
  const { ledger, dir } = setup();
  await ledger.begin({ runId: "run-1", session: "s", charter: qaCharter(), plan: qaPlan({ entries: ["http://localhost:4291"] }) });
  const row = await ledger.append("run-1", { kind: "row", action: "begin", rowId: "A", name: "설정" });
  assert.equal(row.seq, 2);
  assert.equal((await ledger.verify("run-1")).events.length, 2);
  const file = path.join(dir, "run-1", "journal.jsonl");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("설정", "계정"));
  await assert.rejects(ledger.report("run-1"), /해시|변조/);
  await assert.rejects(ledger.append("run-1", { kind: "observation" }), /해시|변조/);
});

test("재시작 후 저장된 머리로 장부를 검증한다", async () => {
  const { ledger, dir } = setup();
  await ledger.begin({ runId: "run-2", session: "s", charter: qaCharter(), plan: qaPlan() });
  const restarted = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }), dir });
  assert.equal((await restarted.verify("run-2")).seq, 1);
});

test("보고서가 재시도 통과를 flaky로 계산하고 증거 사진 변경을 거부한다", async () => {
  const { ledger, dir } = setup();
  const source = path.join(dir, "source.png");
  writeFileSync(source, "png-a");
  await ledger.begin({ runId: "run-3", session: "s", charter: qaCharter(), plan: qaPlan() });
  await ledger.append("run-3", { kind: "row", action: "begin", rowId: "A", name: "버튼" });
  await ledger.append("run-3", { kind: "assertion", rowId: "A", pass: false, tries: 1, shot: source });
  await ledger.append("run-3", { kind: "assertion", rowId: "A", pass: true, tries: 2, shot: source });
  await ledger.append("run-3", { kind: "row", action: "end", rowId: "A" });
  const report = await ledger.report("run-3");
  assert.equal(report.rows[0].status, "flaky");
  assert.equal(report.receipts.length, 2);
  const shot = path.join(dir, "run-3", report.receipts[0].shot);
  writeFileSync(shot, "other");
  await assert.rejects(ledger.report("run-3"), /사진|해시|변조/);
});

test("경로는 통과한 로컬 클릭만 저장하고 첫 불일치에서 멈춘다", async () => {
  const { ledger, dir } = setup();
  await ledger.begin({ runId: "run-4", session: "s", charter: qaCharter(), plan: qaPlan({ entries: ["http://localhost:4291"] }) });
  const begin = await ledger.append("run-4", { kind: "entry", url: "http://localhost:4291" });
  await ledger.append("run-4", { kind: "action", mode: "testing", cmd: "click", pass: true,
    target: { role: "button", name: "설정" }, received: [{ type: "click", trusted: true, role: "button", name: "설정" }] });
  const end = await ledger.append("run-4", { kind: "assertion", mode: "testing", pass: true,
    arrival: { mode: "contains", sel: "h1", text: "설정" } });
  const called = [];
  const routes = createQaRoutes({ ledger, dir, executor: async ({ step }) => {
    called.push(step);
    return { ok: true, topTarget: { role: "button", name: "다른 버튼" }, arrival: step.arrival, pass: true };
  } });
  await assert.rejects(routes.save({ runId: "run-4", name: "외부", fromSeq: begin.seq + 1, toSeq: end.seq,
    currentUrl: "https://example.com" }), /로컬/);
  const saved = await routes.save({ runId: "run-4", name: "설정 열기", fromSeq: begin.seq + 1, toSeq: end.seq,
    currentUrl: "http://localhost:4291" });
  assert.equal(saved.steps.length, 1);
  const replay = await routes.replay({ runId: "run-4", name: "설정 열기" });
  assert.equal(replay.ok, false);
  assert.equal(called.length, 1);
  assert.equal(replay.step, 1);
});

test("완료되지 않은 줄과 수신 확인이 없는 경로를 통과로 세지 않는다", async () => {
  const { ledger } = setup();
  await ledger.begin({ runId: "run-5", session: "s", charter: qaCharter(), plan: qaPlan() });
  await ledger.append("run-5", { kind: "row", action: "begin", rowId: "A", name: "항목" });
  await ledger.append("run-5", { kind: "action", rowId: "A", cmd: "click", pass: false });
  await ledger.append("run-5", { kind: "assertion", rowId: "A", pass: true });
  assert.equal((await ledger.report("run-5")).rows[0].status, "gray");
  await ledger.append("run-5", { kind: "row", action: "end", rowId: "A" });
  assert.equal((await ledger.report("run-5")).rows[0].status, "flaky");
});

test("저장 목록의 실패 횟수를 고쳐도 두 번 빗나간 경로는 다시 실행하지 않는다", async () => {
  const { ledger, dir } = setup();
  await ledger.begin({ runId: "run-6", session: "s", charter: qaCharter(), plan: qaPlan() });
  const entry = await ledger.append("run-6", { kind: "entry", url: "http://127.0.0.1:4291" });
  await ledger.append("run-6", { kind: "action", cmd: "click", pass: true,
    target: { role: "button", name: "설정" },
    received: [{ type: "click", trusted: true, role: "button", name: "설정" }] });
  const assertion = await ledger.append("run-6", { kind: "assertion", pass: true,
    arrival: { mode: "exists", sel: "h1" } });
  let count = 0;
  const routes = createQaRoutes({ ledger, dir, executor: async () => {
    count++;
    return { ok: false, error: "화면 변경" };
  } });
  await routes.save({ runId: "run-6", name: "설정 열기", fromSeq: entry.seq + 1, toSeq: assertion.seq,
    currentUrl: "http://127.0.0.1:4291" });
  assert.equal((await routes.replay({ runId: "run-6", name: "설정 열기" })).stale, false);
  assert.equal((await routes.replay({ runId: "run-6", name: "설정 열기" })).stale, true);
  const indexPath = path.join(dir, "validated-routes.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index[0].misses = 0; index[0].stale = false;
  writeFileSync(indexPath, JSON.stringify(index));
  assert.equal((await routes.replay({ runId: "run-6", name: "설정 열기" })).stale, true);
  assert.equal(count, 2);
});

test("같은 항목을 다시 시작해도 실패 이력을 보존한다", async () => {
  const { ledger } = setup();
  await ledger.begin({ runId: "retry-row", session: "s", charter: qaCharter(), plan: qaPlan() });
  for (const pass of [false, true]) {
    await ledger.append("retry-row", { kind: "row", action: "begin", rowId: "A" });
    await ledger.append("retry-row", { kind: "action", rowId: "A", pass });
    await ledger.append("retry-row", { kind: "assertion", rowId: "A", pass });
    await ledger.append("retry-row", { kind: "row", action: "end", rowId: "A" });
  }
  assert.equal((await ledger.report("retry-row")).rows[0].status, "flaky");
});
