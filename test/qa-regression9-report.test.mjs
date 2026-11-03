import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { checkQaReport } from "../server/qa-report.js";
import { createQaSummary } from "../server/qa-summary.js";
import { qaCharter, qaPlan, qaRowContract, qaSession } from "./qa-fixtures.mjs";

const lane = { rowId: "save", path: "정상", lanes: [["save", "정상"]] };
const baseEvents = () => {
  const events = [
    { kind: "run_begin", session: "s", charter: { ...qaCharter(), exclusions: "제외 영역" }, plan: qaPlan({ entries: ["http://localhost:4321/start"] }) },
    { kind: "row", action: "declare", rowId: "save", rowData: { ...qaRowContract(), id: "save", what: "저장 결과", basis: "spec", basisNote: "저장 명세", paths: ["정상"] } },
    { kind: "entry", url: "http://localhost:4321/start" },
    { kind: "row", action: "open", ...lane, rowData: {} },
    { kind: "observation", cmd: "snapshot", ...lane, pass: true },
    { kind: "accepted", cmd: "click", ...lane, expected: { effects: [] } },
    { kind: "frame", claim: { kind: "S1" }, ...lane, acceptedSeq: 6, shot: "before.png" },
    { kind: "action", cmd: "click", ...lane, acceptedSeq: 6, pass: true },
    { kind: "frame", claim: { kind: "S2" }, ...lane, acceptedSeq: 6, shot: "after.png" },
    { kind: "observation", cmd: "observe", ...lane, pass: true },
    { kind: "assertion", ...lane, pass: true, shot: "assert.png", url: "http://localhost:4321/start" },
    { kind: "reaction", cmd: "click", ...lane, acceptedSeq: 6 },
    { kind: "row", action: "close", ...lane, rowData: { color: "green", frames: 3, receipts: 1, failed: 0, sceneJudgment: "화면 전체 확인" }, sceneJudgment: "화면 전체 확인" },
    { kind: "run_end", sessionRecord: { ...qaSession(), defects: "없음", unverified: { items: "미확인 영역", reason: "범위" }, remainingQuestions: "재실행 필요" } },
  ];
  return events.map((event, index) => ({ seq: index + 1, event }));
};

test("report judges only the retest span after the last open", () => {
  const events = baseEvents();
  const action = events.find(r => r.event.kind === "action");
  action.event.pass = false;
  events.splice(12, 0,
    { seq: 0, event: { kind: "assertion", ...lane, pass: false, shot: "old-failure.png", url: "http://localhost:4321/start" } },
    { seq: 0, event: { kind: "row", action: "open", ...lane, rowData: {} } },
    { seq: 0, event: { kind: "play_result", ...lane, detail: { retestOf: "old-run" } } },
    { seq: 0, event: { kind: "action", cmd: "viewport", ...lane, pass: true, shot: "retest-action.png" } },
    { seq: 0, event: { kind: "observation", cmd: "observe", ...lane, pass: true } },
    { seq: 0, event: { kind: "assertion", ...lane, pass: true, shot: "retest-assert.png", url: "http://localhost:4321/start" } },
    { seq: 0, event: { kind: "row", action: "close", ...lane, rowData: { color: "green", frames: 1, receipts: 1, sceneJudgment: "재확인" }, sceneJudgment: "재확인" } },
  );
  events.forEach((record, index) => { record.seq = index + 1; });
  assert.doesNotThrow(() => checkQaReport(events));
  const withoutMarker = structuredClone(events);
  withoutMarker.find(r => r.event.kind === "play_result").event.detail = {};
  assert.throws(() => checkQaReport(withoutMarker), /실패한 조작/);
});

test("summary의 사람이 할 일 범위·중복 제거·안정 문구·수정 전 사진", async () => {
  const parent = fs.realpathSync(os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'qa-regression9-summary-'));
  try {
    const runDir = path.join(root, 'run'); fs.mkdirSync(runDir);
    const runJson = path.join(runDir, 'run.json');
    fs.writeFileSync(runJson, JSON.stringify({ repo: '/origin', fixTree: '/repo', fixBranch: 'qa-fix/x' }));
    fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify({ runDir, changed: [] }));
    const events = baseEvents();
    const end = events.pop();
    const close = events.find(r => r.event.kind === 'row' && r.event.action === 'close');
    close.event.rowData = { color: 'gray', note: '회색 종료 사유', sceneJudgment: '사람 확인 필요' };
    const reaction = events.find(r => r.event.kind === 'reaction');
    reaction.event.pass = false;
    events.push(
      { seq: 90, event: { kind: 'failure', detail: { failureSeq: 8 }, shot: 'failure-action.png' } },
      { seq: 98, event: { kind: 'observation', stability: { stable: false, remaining: ['not-measured'] } } },
      { seq: 99, event: { kind: 'failure', detail: { captureError: '화면 기록 오류' } } },
      { seq: 101, event: { kind: 'defect', detail: { problem: '저장 실패', failureSeq: reaction.seq } } },
      { seq: 102, event: { kind: 'fix', detail: { defect: 101, commit: 'a'.repeat(40), branch: 'qa-fix/x', summary: '수정', diffFiles: [], diff: '' } } },
      { seq: 103, event: { kind: 'human_review', detail: { defect: 101, reason: '저장 결과 수동 확인' } } },
      { seq: 104, event: { kind: 'human_review', detail: { row: 'save', reason: '화면 수동 확인' } } },
      { seq: 105, event: { kind: 'retest_required', detail: { row: 'impact' } } },
      { seq: 106, event: { kind: 'blocked', reason: '테스트 계정 없음' } },
      { ...end, seq: 107 },
    );
    const ledger = { verify: async () => ({ events }), paths: () => ({ folder: root }) };
    const result = await createQaSummary(ledger, ['run'], { runJson });
    const html = fs.readFileSync(result.path, 'utf8');
    const firstStart = html.indexOf('<h2>사람이 할 일</h2>'), firstEnd = html.indexOf('<h2>빌드</h2>');
    assert.ok(firstStart >= 0 && firstEnd > firstStart);
    const first = html.slice(firstStart, firstEnd);
    assert.deepEqual(result.summary.humanTasks, [
      'run 결함 #101 · 사람 확인 · 저장 결과 수동 확인',
      'run · 저장 결과 · 사람 확인 · 화면 수동 확인',
      'run 항목 impact · 재실행 필요',
      `병합 여부: branch qa-fix/x · commit ${'a'.repeat(40)} · diff 0 files +0 -0`,
      'run · 테스트 계정 없음',
      'run · 중단 후 미해결: 재실행 필요',
      '실행기 verify 결과: worktree 밖 상태 변화 없음 · 변경 항목 없음 · 실행기의 검사 대상 기준',
    ]);
    for (const item of result.summary.humanTasks) assert.ok(first.includes(item), item);
    assert.doesNotMatch(first, /화면 기록 오류|미확인 영역|제외 영역|회색 종료 사유|수정 후 재확인 미확인/);
    assert.equal((first.match(/<li>run 결함 #101/g) || []).length, 1);
    assert.equal((first.match(/<li>run · 저장 결과/g) || []).length, 1);
    assert.match(html, /안정 전 촬영 · 남은 항목: 안정 여부 측정 안 됨/);
    assert.doesNotMatch(html, /not-measured/);
    const fixedStart = html.indexOf('<h2>고침</h2>'), fixedEnd = html.indexOf('<h2>못 함</h2>');
    assert.ok(fixedStart >= 0 && fixedEnd > fixedStart);
    const fixed = html.slice(fixedStart, fixedEnd);
    assert.ok(fixed.includes(`<a href="${pathToFileURL(path.join(root, 'failure-action.png')).href}">수정 전 #12</a>`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
