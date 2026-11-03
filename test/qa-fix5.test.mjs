import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { applyQaFix, QA_FIX_SCHEMA } from "../server/qa-fix.js";
import { applyQaRow, QA_ROW_SCHEMA } from "../server/qa-rows.js";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()), "qa-fix5-tests");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export async function fixture(t) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "run-")), repo = path.join(dir, "repo");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  const commit = (value) => {
    fs.writeFileSync(path.join(repo, "value.txt"), value);
    git(repo, "add", "value.txt");
    git(repo, "-c", "user.name=QA fixture", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", value);
    return git(repo, "rev-parse", "HEAD");
  };
  const initial = commit("initial");
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "anchors") }) });
  await ledger.begin({ runId: "source", session: "owner", plan: qaPlan({ entries: [], build: { repo } }), charter: qaCharter() });
  const failure = await ledger.append("source", { kind: "assertion", mode: "agent_action", pass: false, rowId: "save" });
  const defect = await ledger.append("source", { kind: "defect", mode: "agent_action", detail: { problem: "저장 표시 누락", failureSeq: failure.seq } });
  const fix = (args = {}) => applyQaFix({ ledger, runId: "source", args: { defect: defect.seq, failureSeq: failure.seq, diagnosis: { source: "value.txt:1", reason: "헤더 갱신 호출이 누락됨" }, commit: git(repo, "rev-parse", "HEAD"), summary: "저장 표시 수정", ...args } });
  const fixed = async () => { git(repo, "checkout", "-b", "fix/save"); const hash = commit("fix"); return { hash, receipt: await fix({ commit: hash }) }; };
  const target = async () => ledger.begin({ runId: "target", session: "owner", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const row = (args = {}) => applyQaRow({ ledger, runId: "target", args: { action: "declare", ...qaRowContract(), id: "retest", what: "저장 표시", given: "저장 완료", basis: "spec", paths: ["정상"], ...args } });
  return { dir, repo, ledger, commit, initial, failure, defect, fix, fixed, target, row };
}

test("qa_fix는 다른 작업 브랜치의 실제 커밋을 전체 해시로 기록하고 종료 후에도 보존", async t => {
  const f = await fixture(t);
  git(f.repo, "checkout", "-b", "fix/save");
  const hash = f.commit("fix");
  const receipt = await f.fix({ commit: hash.slice(0, 8), summary: "  저장 표시 수정  " });
  assert.equal(receipt.event.detail.defect, f.defect.seq); assert.equal(receipt.event.detail.failureSeq, f.failure.seq);
  assert.equal(receipt.event.detail.commit, hash); assert.equal(receipt.event.detail.branch, "fix/save");
  const events = (await f.ledger.verify("source")).events;
  assert.equal(events.at(-1).event.kind, "fix");
  assert.equal(events.find(r => r.seq === f.defect.seq).event.detail.problem, "저장 표시 누락");
  assert.equal(events[0].event.build.branch, "main");
});

test("qa_fix는 시작 회차와 같은 브랜치의 커밋을 거부", async t => {
  const f = await fixture(t);
  f.commit("fix");
  await assert.rejects(f.fix(), /다른 작업 브랜치/);
  assert.equal((await f.ledger.verify("source")).events.some(r => r.event.kind === "fix"), false);
});

test("qa_fix는 현재 작업 브랜치가 포함하지 않은 커밋과 detached HEAD를 거부", async t => {
  const f = await fixture(t);
  git(f.repo, "checkout", "-b", "fix/other");
  const other = f.commit("other");
  git(f.repo, "checkout", "-b", "fix/current", f.initial);
  await assert.rejects(f.fix({ commit: other }), /포함되지 않은/);
  git(f.repo, "checkout", "--detach", f.initial);
  await assert.rejects(f.fix({ commit: f.initial }), /작업 브랜치/);
});

test("qa_fix는 없는 결함·커밋·시작 빌드와 잘못된 입력을 거부", async t => {
  const f = await fixture(t);
  git(f.repo, "checkout", "-b", "fix/save");
  for (const defect of ["2", 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 999]) await assert.rejects(f.fix({ defect }));
  for (const args of [{ commit: "" }, { commit: "missing-commit" }, { commit: "--all" }, { summary: "" }]) await assert.rejects(f.fix(args));
  await f.ledger.begin({ runId: "legacy", session: "owner", plan: { entries: [] }, charter: qaCharter() });
  const failure = await f.ledger.append("legacy", { kind: "assertion", pass: false });
  const defect = await f.ledger.append("legacy", { kind: "defect", detail: { problem: "표시 누락", failureSeq: failure.seq } });
  await assert.rejects(applyQaFix({ ledger: f.ledger, runId: "legacy", args: { defect: defect.seq, failureSeq: failure.seq, diagnosis: { source: "value.txt:1", reason: "오류" }, commit: f.initial, summary: "표시 수정" } }), /시작 회차/);
});

test("retestOf는 수정된 결함을 declare와 rowData에서 연결하고 기존 결함을 유지", async t => {
  const f = await fixture(t);
  const { hash, receipt } = await f.fixed();
  await f.target();
  const retestOf = { run: "source", defect: f.defect.seq };
  const declared = await f.row({ retestOf });
  assert.deepEqual(declared.row.retestOf, retestOf);
  assert.deepEqual(declared.row.retestFix, { seq: receipt.seq, commit: hash });
  const rowData = { ...qaRowContract(), id: "nested", what: "저장 표시", given: "저장 완료", basis: "spec", paths: ["정상"], retestOf };
  assert.deepEqual((await f.row({ id: undefined, rowData })).row.retestOf, retestOf);
  const source = (await f.ledger.verify("source")).events;
  assert.equal(source.find(r => r.seq === receipt.seq).event.detail.defect, f.defect.seq);
  assert.equal(source.find(r => r.seq === f.defect.seq).event.kind, "defect");
});

test("retestFix는 선언한 최신 수정만 기록하고 이후 수정과 구분", async t => {
  const f = await fixture(t), first = await f.fixed();
  await f.target();
  const retestOf = { run: "source", defect: f.defect.seq };
  await f.row({ retestOf });
  const hash = f.commit("next-fix"), receipt = await f.fix({ commit: hash });
  const next = await f.row({ id: "next", retestOf });
  assert.deepEqual(next.row.retestFix, { seq: receipt.seq, commit: hash });
  const old = (await f.ledger.verify("target")).events.find(rec => rec.event.rowId === "retest").event.rowData;
  assert.deepEqual(old.retestFix, { seq: first.receipt.seq, commit: first.hash });
});

test("retestOf는 다른 세션이 소유한 회차의 결함을 연결할 수 없다", async t => {
  const f = await fixture(t); await f.fixed();
  await f.ledger.begin({ runId: "target", session: "other-owner", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  await assert.rejects(f.row({ retestOf: { run: "source", defect: f.defect.seq } }), /세션 소유권/);
  assert.equal((await f.ledger.verify("target")).events.length, 1);
});

test("retestOf는 없는 회차·결함·수정 기록과 잘못된 연결 값을 거부", async t => {
  const f = await fixture(t);
  await f.target();
  for (const retestOf of [null, [], {}, { run: "source", defect: "2" }, { run: "source", defect: 0 }, { run: "source", defect: 1.5 },
    { run: "missing", defect: 2 }, { run: "source", defect: 1 }, { run: "source", defect: 999 }, { run: "source", defect: f.defect.seq },
    { run: "source", defect: f.defect.seq, commit: "invented" }]) await assert.rejects(f.row({ retestOf }));
  assert.equal((await f.ledger.verify("target")).events.length, 1);
});

test("retestOf는 대상 장부 해시가 변조되면 연결을 거부", async t => {
  const f = await fixture(t);
  await f.fixed(); await f.target();
  const journal = f.ledger.paths("source").journal;
  fs.writeFileSync(journal, fs.readFileSync(journal, "utf8").replace("저장 표시 누락", "다른 결함"));
  await assert.rejects(f.row({ retestOf: { run: "source", defect: f.defect.seq } }), /변조/);
  assert.equal((await f.ledger.verify("target")).events.length, 1);
});

test("qa_fix와 retestOf 스키마는 정수 순번을 요구", () => {
  // failureSeq 는 실패 판정 없이 기록한 결함(noFailure)에는 넣지 않으므로 필수가 아님
  assert.deepEqual(QA_FIX_SCHEMA.required, ["defect", "commit", "summary", "diagnosis"]);
  assert.equal(QA_FIX_SCHEMA.properties.failureSeq.type, "integer");
  assert.equal(QA_FIX_SCHEMA.properties.defect.type, "integer");
  for (const declaration of [QA_ROW_SCHEMA.properties, QA_ROW_SCHEMA.properties.rowData.properties]) {
    assert.deepEqual(declaration.retestOf.required, ["run", "defect"]);
    assert.equal(declaration.retestOf.additionalProperties, false);
    assert.equal(declaration.retestOf.properties.defect.type, "integer");
  }
});
