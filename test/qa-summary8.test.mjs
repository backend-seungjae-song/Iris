import { sliceBetween } from "../bin/slice-anchor.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQaSummary } from "../server/qa-summary.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-summary8-"));
const runDir = path.join(root, "run"); fs.mkdirSync(runDir, { recursive: true });
const runJson = path.join(runDir, "run.json");
fs.writeFileSync(runJson, JSON.stringify({ repo: "/origin", fixTree: "/repo", fixBranch: "qa-fix/x" }));
fs.writeFileSync(path.join(runDir, "verify.json"), JSON.stringify({ runDir, changed: [] }));
const failure = { seq: 2, event: { kind: "assertion", pass: false, rowId: "save" } };
const events = [
  { seq: 1, event: { kind: "run_begin", session: "s", build: { repo: "/repo", branch: "main" }, charter: {} } },
  failure,
  { seq: 3, event: { kind: "defect", detail: { problem: "저장 실패", failureSeq: 2 } } },
  { seq: 4, event: { kind: "fix", detail: { defect: 3, commit: "a".repeat(40), branch: "qa-fix/x", summary: "수정", diffFiles: ["web/save.js"], diff: "+added\n-removed", diagnosis: { reason: "상태 갱신 누락" }, testReason:"기대값 명세 수정", affectedRows: ["save"] } } },
  { seq: 5, event: { kind: "run_end", sessionRecord: {} } },
];
const ledger = { verify: async () => ({ events }), paths: () => ({ folder: root }) };

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("summary 첫 칸에 실제 실행기 결과와 수정 근거를 넣는다", async () => {
  const result = await createQaSummary(ledger, ["run"], { runJson });
  assert.deepEqual(result.summary.unattendedVerify.changed, []);
  assert.equal(result.summary.fixed[0].diffStat.files[0], "web/save.js");
  assert.equal(result.summary.fixed[0].diffStat.additions, 1);
  assert.equal(result.summary.fixed[0].diffStat.deletions, 1);
  const html = fs.readFileSync(result.path, "utf8");
  assert.ok(html.indexOf("<h2>사람이 할 일</h2>") < html.indexOf("<h2>빌드</h2>"));
  assert(html.includes("<h2>사람이 할 일</h2>"));
  const first=sliceBetween(html,"<h2>사람이 할 일</h2>","<h2>빌드</h2>");
  for(const value of ["qa-fix/x","a".repeat(40),"+1 -1","기대값 명세 수정","+added"])assert(first.includes(value),value);
  for (const text of ["worktree 밖 상태 변화 없음", "상태 갱신 누락", "+1 -1", "영향 row save", "수정 전 실패 seq 2"]) assert.ok(html.includes(text), text);
});

test("verify.runDir이 run.json 폴더와 다르면 실행기 결과를 거부한다", async () => {
  fs.writeFileSync(path.join(runDir, "verify.json"), JSON.stringify({ runDir: path.join(root, "other"), changed: [] }));
  await assert.rejects(createQaSummary(ledger, ["run"], { runJson }), /형식/);
  fs.writeFileSync(path.join(runDir, "verify.json"), JSON.stringify({ runDir, changed: "mutated" }));
  await assert.rejects(createQaSummary(ledger, ["run"], { runJson }), /형식/);
});

test("요약은 회차 사진을 넣지 않고 회차 보고서로 연결한다", async () => {
  const shots = path.join(root, "shots"); fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(root, "report.html"), "<p>보고서</p>");
  const withShot = [...events.slice(0, 2), { seq: 6, event: { kind: "frame", rowId: "save", shot: "shots/a.png" } }, ...events.slice(2)];
  const result = await createQaSummary({ ...ledger, verify: async () => ({ events: withShot }) }, ["run"]);
  const html = fs.readFileSync(result.path, "utf8");
  assert.doesNotMatch(html, /data:image|조작과 결과/);
  assert.match(html, /<h2>회차별 보고서<\/h2><ul><li>run · <a href="file:[^"]+\/report\.html">보고서<\/a><\/li>/);
});
