import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewed, reviewQaList, unchangedExpectations, validateQaDeclaration, validateQaPlanList } from "../server/qa-list-review.js";

const plan = (decision = "test") => ({ listRationale: "저장 위험 확인", risks: [{ id: "r1", risk: "저장이 실패할 수 있음", size: "high", knowledge: "some", decision, ...(decision !== "test" ? { reason: "낮은 빈도" } : {}) }] });
const row = (more = {}) => ({ id: "a", given: "저장 화면", risk: ["r1"], oracle: "기능의 용도: 저장 결과 표시", basisNote: "저장 명세", dataChanging: false, mustNotChange: [{ sel: "header", text: "제목", reason: "저장 중 유지" }], ...more });

test("위험 목록과 선언 필수값을 검사", () => {
  assert.throws(() => validateQaPlanList({ risks: [], listRationale: "x" }));
  assert.throws(() => validateQaPlanList({ listRationale: "x" }));
  assert.throws(() => validateQaDeclaration({ ...row(), mustNotChange: "제목" }));
  assert.deepEqual(unchangedExpectations(row())[0].type, "unchanged");
});

test("accept·delegate 위험에는 row를 둘 수 없음", () => {
  assert.throws(() => reviewQaList({ plan: plan("accept"), rows: [row()] }));
});

test("같은 given에서 위험 하나를 공유하면 중복 후보", () => {
  const inventory = reviewQaList({ plan: plan(), rows: [row(), row({ id: "b" })] });
  assert.equal(inventory.duplicates.length, 1);
  assert.throws(() => assertReviewed(inventory, { information: [{ row: "a", text: "저장 정보" }], duplicates: [], distribution: "분산", missingRisks: "없음" }));
  assertReviewed(inventory, { information: [{ row: "a", text: "저장 정보" }, { row: "b", text: "중복 저장 정보" }], duplicates: [{ rows: ["a", "b"], decision: "split", reason: "실패 원인 분리" }], distribution: "분산", missingRisks: "없음" });
});

test("위험·목록·선언 누락과 소비자 경로를 거부", () => {
  assert.throws(() => validateQaPlanList({ listRationale: "x" }));
  for (const key of ["risk", "oracle", "mustNotChange"]) {
    const value = row(); delete value[key];
    assert.throws(() => validateQaDeclaration(value));
  }
  assert.throws(() => validateQaDeclaration({ ...row(), dataChanging: true, consumers: ["missing.js:1"] }, { repo: process.cwd() }));
  assert.equal(reviewQaList({ plan: plan(), rows: [] }).riskGroups[0].rows.length,0);
});

test("review 답 누락과 fingerprint 변경을 거부하고 현재 fingerprint를 반환", () => {
  const inventory = reviewQaList({ plan: plan(), rows: [row()] });
  assert.throws(() => assertReviewed(inventory, { information: [], duplicates: [], distribution: "분산", missingRisks: "없음" }));
  assert.throws(() => assertReviewed(inventory, { fingerprint: "old", information: [{ row: "a", text: "정보" }], duplicates: [], distribution: "분산", missingRisks: "없음" }));
  const result = assertReviewed(inventory, { fingerprint: inventory.fingerprint, information: [{ row: "a", text: "정보" }], duplicates: [], distribution: "분산", missingRisks: "없음" });
  assert.equal(result.fingerprint, inventory.fingerprint);
});

test("부분 수정은 새 fingerprint로 재검토를 요구", () => {
  const before = reviewQaList({ plan: plan(), rows: [row()] });
  const after = reviewQaList({ plan: plan(), rows: [row({ mustNotChange: [{ sel: "header", text: "새 제목", reason: "변경" }] })] });
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.throws(() => assertReviewed(after, { fingerprint: before.fingerprint, information: [{ row: "a", text: "정보" }], duplicates: [], distribution: "분산", missingRisks: "없음" }));
});
