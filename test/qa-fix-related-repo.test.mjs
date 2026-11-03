// 한 회차가 여러 저장소를 다룰 때: build.related 기록과 관련 저장소의 수정 커밋
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { applyQaFix } from "../server/qa-fix.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  return value => { fs.writeFileSync(path.join(dir, "value.txt"), value); git(dir, "add", "value.txt");
    git(dir, "-c", "user.name=QA fixture", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", value); return git(dir, "rev-parse", "HEAD"); };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-fix-related-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = path.join(dir, "client"), admin = path.join(dir, "admin");
  const commitClient = makeRepo(client), commitAdmin = makeRepo(admin);
  commitClient("initial"); commitAdmin("initial");
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "anchors") }) });
  await ledger.begin({ runId: "run", session: "owner", plan: qaPlan({ entries: [], build: { repo: client, related: [admin] } }), charter: qaCharter() });
  return { client, admin, commitAdmin, ledger };
}

test("회차 기록은 plan.build.related 와 관련 저장소의 시작 브랜치를 보존한다", async t => {
  const { admin, ledger } = await setup(t);
  const begin = (await ledger.verify("run")).events[0].event;
  assert.deepEqual(begin.plan.build.related, [admin]);
  assert.equal(begin.build.related?.[0]?.repo, admin);
  assert.equal(begin.build.related[0].branch, "main");
});

test("qa_fix 는 build.related 저장소의 수정 커밋을 받아 그 저장소를 기록한다", async t => {
  const { admin, commitAdmin, ledger } = await setup(t);
  const failure = await ledger.append("run", { kind: "assertion", mode: "agent_action", pass: false, rowId: "cms" });
  const defect = await ledger.append("run", { kind: "defect", mode: "agent_action", detail: { problem: "선택 상자 저장 실패", failureSeq: failure.seq } });
  git(admin, "checkout", "-q", "-b", "fix/select");
  const commit = commitAdmin("fix");
  const receipt = await applyQaFix({ ledger, runId: "run", args: { defect: defect.seq, failureSeq: failure.seq, commit, summary: "선택 상자 저장 수정",
    diagnosis: { source: "value.txt:1", reason: "저장 요청 누락" } } });
  assert.equal(receipt.event.detail.commit, commit);
  assert.equal(receipt.event.detail.repo, admin);
  assert.equal(receipt.event.detail.branch, "fix/select");
});

test("관련 저장소에서도 시작 브랜치 그대로 고친 커밋은 거부한다", async t => {
  const { commitAdmin, ledger } = await setup(t);
  const failure = await ledger.append("run", { kind: "assertion", mode: "agent_action", pass: false, rowId: "cms" });
  const defect = await ledger.append("run", { kind: "defect", mode: "agent_action", detail: { problem: "선택 상자 저장 실패", failureSeq: failure.seq } });
  const commit = commitAdmin("fix on main");
  await assert.rejects(applyQaFix({ ledger, runId: "run", args: { defect: defect.seq, failureSeq: failure.seq, commit, summary: "수정",
    diagnosis: { source: "value.txt:1", reason: "저장 요청 누락" } } }), /다른 작업 브랜치/);
});

test("회차 저장소가 시작 때 detached HEAD 여도 관련 저장소의 수정 커밋을 받는다", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-fix-detached-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = path.join(dir, "client"), server = path.join(dir, "server");
  makeRepo(client)("initial"); const commitServer = makeRepo(server); commitServer("initial");
  git(client, "checkout", "-q", "--detach"); git(server, "checkout", "-q", "--detach");
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "anchors") }) });
  await ledger.begin({ runId: "run", session: "owner", plan: qaPlan({ entries: [], build: { repo: client, related: [server] } }), charter: qaCharter() });
  assert.equal((await ledger.verify("run")).events[0].event.build.branch, null);
  const defect = await ledger.append("run", { kind: "defect", mode: "agent_action", detail: { problem: "영상 보상에 골든티켓 추가", noFailure: true } });
  git(server, "checkout", "-q", "-b", "qa-fix/bonus");
  const commit = commitServer("fix");
  const receipt = await applyQaFix({ ledger, runId: "run", args: { defect: defect.seq, commit, summary: "영상 보상 기본값 수정",
    diagnosis: { source: "value.txt:1", reason: "칸이 없을 때 고정값 사용" } } });
  assert.equal(receipt.event.detail.repo, server);
  assert.equal(receipt.event.detail.branch, "qa-fix/bonus");
});
