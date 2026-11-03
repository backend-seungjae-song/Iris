// 화면 조건 판정(qa_expect·qa_app_expect) 실패에서 나온 결함의 수정 재실행 대조(qa-92771d8c 결함 560)
import test from "node:test";
import assert from "node:assert/strict";
import { assertQaReplayContract } from "../server/qa-remediation.js";

const oracle = "명세나 대화에서 정한 내용";
const failed = expected => [
  { seq: 1, event: { kind: "assertion", rowId: "S3", pass: false, expected } },
  { seq: 2, event: { kind: "defect", detail: { failureSeq: 1 } } },
];
const steps = effects => [{ action: "tap", target: { role: "button", name: "검색" }, expect: { effects: effects.map(e => ({ oracle, ...e })), within: 3000 } }];
const replay = (expected, effects) => assertQaReplayContract(failed(expected), "S3", steps(effects), { fixSeq: 3, defect: 2 });

test("모바일 exists 판정은 같은 종류·이름이 나타나는 기대로 다시 확인한다", () => {
  const expected = { mode: "exists", type: "TextField", label: "버거킹 내 상품 검색" };
  assert.doesNotThrow(() => replay(expected, [{ type: "appear", role: "TextField", name: "버거킹 내 상품 검색" }]));
  assert.throws(() => replay(expected, [{ type: "appear", role: "TextField", name: "다른 검색" }]),
    error => error.message.includes('"type":"appear"') && error.message.includes('"name":"버거킹 내 상품 검색"'));
});

test("모바일 absent 판정은 사라지는 기대로, contains 판정은 값 변경 기대로 다시 확인한다", () => {
  assert.doesNotThrow(() => replay({ mode: "absent", type: "Alert", label: "오류" }, [{ type: "disappear", role: "Alert", name: "오류" }]));
  assert.doesNotThrow(() => replay({ mode: "contains", type: "TextField", label: "검색", text: "피자" }, [{ type: "change", role: "TextField", name: "검색", to: "피자" }]));
});

test("웹 판정은 전과 같이 sel 과 값으로 대조한다", () => {
  assert.doesNotThrow(() => replay({ mode: "contains", sel: "#header", text: "저장 완료" }, [{ type: "change", sel: "#header", to: "저장 완료" }]));
  assert.throws(() => replay({ mode: "contains", sel: "#header", text: "저장 완료" }, [{ type: "change", sel: "#header", to: "다른 값" }]), /빠진 기대값/);
  assert.doesNotThrow(() => replay({ mode: "exists", sel: "#saved" }, [{ type: "appear", sel: "#saved" }]));
});
