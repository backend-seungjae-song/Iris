// 수정 미확인 결함의 남은 조건 안내
import test from "node:test";
import assert from "node:assert/strict";
import { deriveQaRemediation, assertQaRemediationComplete } from "../server/qa-remediation.js";

const rec = (seq, event) => ({ seq, event });
const base = [
  rec(1, { kind: "row", action: "declare", rowId: "A3", rowData: { paths: ["정상", "경계"] } }),
  rec(2, { kind: "play_result", rowId: "A3", path: "경계", detail: { pass: false, steps: [] } }),
  rec(3, { kind: "defect", rowId: "A3", path: "경계", detail: { problem: "낱말 가운데 줄바꿈", failureSeq: 2 } }),
  rec(4, { kind: "fix", detail: { defect: 3, failureSeq: 2, commit: "abc" } }),
  rec(5, { kind: "play_result", rowId: "A3", path: "경계", detail: { pass: true, retestOf: { run: "r", defect: 3 }, retestFix: { seq: 4 } } }),
];

test("재확인이 통과해도 같은 항목의 다른 경로를 다시 실행하지 않았으면 그 경로를 남은 조건으로 알려 준다", () => {
  const defect = deriveQaRemediation(base).defects[0];
  assert.equal(defect.status, "수정 미확인");
  assert.deepEqual(defect.waiting, ["항목 A3 정상 경로를 수정 seq 4 뒤 qa_play로 다시 실행"]);
  assert.throws(() => assertQaRemediationComplete(base), /3 \(항목 A3 정상 경로를 수정 seq 4 뒤 qa_play로 다시 실행\)/);
});

test("다른 경로도 수정 뒤 다시 실행해 통과하면 수정 확인이고 남은 조건이 없다", () => {
  const events = [...base, rec(6, { kind: "play_result", rowId: "A3", path: "정상", detail: { pass: true, steps: [] } })];
  const defect = deriveQaRemediation(events).defects[0];
  assert.equal(defect.status, "수정 확인");
  assert.equal(defect.waiting, undefined);
});
