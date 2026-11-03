import test from "node:test";
import assert from "node:assert/strict";
import {
  QA_CHARTER_SCHEMA, QA_SESSION_SCHEMA, QA_STOP_CRITERIA,
  validateQaCharter, validateQaSession, validateQaStoredSession,
} from "../server/qa-session-contract.js";

const charter = () => ({
  question: "고객이 변경된 저장 기능으로 주문을 저장할 수 있는가?",
  scope: "주문 작성과 저장 결과",
  exclusions: "결제",
  environment: "개발 환경, 전용 QA 계정과 주문 데이터",
  sharedEnvironment: false,
  timebox: "30분",
  people: "주문 담당자",
  documents: "주문 작성 명세",
});
const session = () => ({
  work: "주문을 작성하고 저장 결과를 확인했다",
  curios: "저장 버튼 이름이 주문마다 다르게 보인다",
  checked: "주문 생성과 목록 표시",
  unverified: { items: "운영 계정의 주문 저장", reason: "개발 계정만 사용할 수 있다" },
  blockers: "없음",
  outOfScope: "없음",
  risks: "운영 계정 권한 차이를 확인하지 못했다",
  stopCriterion: "time_or_user_stop",
  remainingQuestions: "운영 계정에서도 같은 저장 결과가 나오는가?",
});

test("charter와 session은 모든 필수 정보를 보존한 새 객체를 반환한다", () => {
  for (const sharedEnvironment of [false, true]) {
    const value = { ...charter(), sharedEnvironment };
    const result = validateQaCharter(value);
    assert.deepEqual(result, value);
    assert.notEqual(result, value);
  }
  const value = session();
  const result = validateQaSession(value);
  assert.deepEqual(result, value);
  assert.notEqual(result.unverified, value.unverified);
});

test("charter 필수 항목 각각의 누락과 공백 문자열을 거부한다", () => {
  const fields = ["question", "scope", "exclusions", "environment", "sharedEnvironment", "timebox", "people", "documents"];
  for (const key of fields) {
    const omitted = charter();
    delete omitted[key];
    assert.throws(() => validateQaCharter(omitted), new RegExp(`charter\\.${key}`));
    for (const value of ["", " \t\n ", null, undefined, [], {}])
      assert.throws(() => validateQaCharter({ ...charter(), [key]: value }), new RegExp(`charter\\.${key}`));
  }
  for (const value of ["true", "false", 0, 1])
    assert.throws(() => validateQaCharter({ ...charter(), sharedEnvironment: value }), /sharedEnvironment/);
});

test("session 필수 항목 각각의 누락과 공백 문자열을 거부한다", () => {
  const fields = ["work", "curios", "checked", "unverified", "blockers", "outOfScope", "risks", "stopCriterion", "remainingQuestions"];
  for (const key of fields) {
    const omitted = session();
    delete omitted[key];
    assert.throws(() => validateQaSession(omitted), new RegExp(`session\\.${key}`));
    for (const value of ["", " \t\n ", null, undefined, [], false])
      assert.throws(() => validateQaSession({ ...session(), [key]: value }), new RegExp(`session\\.${key}`));
  }
  for (const key of ["items", "reason"]) {
    const omitted = session();
    delete omitted.unverified[key];
    assert.throws(() => validateQaSession(omitted), new RegExp(`unverified\\.${key}`));
    for (const value of ["", " \t\n ", null, undefined, [], false])
      assert.throws(() => validateQaSession({ ...session(), unverified: { ...session().unverified, [key]: value } }), new RegExp(`unverified\\.${key}`));
  }
});

test("종료 기준은 정본의 일곱 경우만 받는다", () => {
  const expected = ["questions_answered", "time_or_user_stop", "serious_defect", "too_many_defects", "flatline", "blocked", "low_value"];
  assert.deepEqual(QA_STOP_CRITERIA, expected);
  for (const stopCriterion of expected)
    assert.equal(validateQaSession({ ...session(), stopCriterion }).stopCriterion, stopCriterion);
  for (const stopCriterion of ["coverage", "count_reached", "passed", "done", "BLOCKED", " blocked "])
    assert.throws(() => validateQaSession({ ...session(), stopCriterion }), /stopCriterion/);
});

test("알 수 없는 항목과 객체가 아닌 값은 거부한다", () => {
  assert.throws(() => validateQaCharter({ ...charter(), arbitrary: "value" }), /허용되지 않은/);
  assert.throws(() => validateQaSession({ ...session(), pass: true }), /허용되지 않은/);
  assert.throws(() => validateQaSession({ ...session(), unverified: { ...session().unverified, pass: true } }), /허용되지 않은/);
  for (const value of [null, undefined, [], "", new Date()]) {
    assert.throws(() => validateQaCharter(value), /charter/);
    assert.throws(() => validateQaSession(value), /session/);
  }
  assert.throws(() => validateQaCharter(Object.create(charter())), /객체/);
});

test("JSON schema도 공백 문자열, 필수 항목, boolean과 종료 기준을 명시한다", () => {
  assert.deepEqual(QA_CHARTER_SCHEMA.required, ["question", "scope", "exclusions", "environment", "sharedEnvironment", "timebox", "people", "documents"]);
  assert.deepEqual(QA_SESSION_SCHEMA.required, ["work", "curios", "checked", "unverified", "blockers", "outOfScope", "risks", "stopCriterion", "remainingQuestions"]);
  assert.deepEqual(QA_SESSION_SCHEMA.properties.unverified.required, ["items", "reason"]);
  assert.deepEqual(QA_SESSION_SCHEMA.properties.stopCriterion.enum, QA_STOP_CRITERIA);
  assert.equal(QA_CHARTER_SCHEMA.properties.sharedEnvironment.type, "boolean");
  for (const schema of [QA_CHARTER_SCHEMA, QA_SESSION_SCHEMA, QA_SESSION_SCHEMA.properties.unverified]) {
    assert.equal(schema.additionalProperties, false);
    assert.ok(Object.isFrozen(schema));
    for (const property of Object.values(schema.properties)) {
      if (property.type === "string" && !property.enum) {
        assert.equal(property.minLength, 1);
        assert.equal(property.pattern, "\\S");
        assert.equal(new RegExp(property.pattern).test(" \t\n "), false);
      }
    }
  }
  assert.throws(() => { QA_CHARTER_SCHEMA.properties.question.type = "number"; }, TypeError);
});

test("결함 요약은 종료 입력에서 거부하고 서버가 저장한 세션에만 허용한다", () => {
  assert.throws(() => validateQaSession({ ...session(), defects: "없음" }), /허용되지 않은/);
  assert.throws(() => validateQaStoredSession(session()), /defects/);
  assert.deepEqual(validateQaStoredSession({ ...session(), defects: "없음" }), { ...session(), defects: "없음" });
});
