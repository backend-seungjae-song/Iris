// 조작 전 트리로 반드시 미관찰이 되는 모바일 기대는 조작을 보내기 전에 거부. 기대 실수 131건이 한 회차 실패의 절반이었던 사례
import test from "node:test";
import assert from "node:assert/strict";
import { createMobileReaction, mobilePremiseErrors } from "../server/qa-mobile-reaction.js";

const el = (label, type = "StaticText", value) => ({ type, AXLabel: label, ...(value !== undefined ? { AXValue: value } : {}), frame: { x: 0, y: 0, width: 10, height: 10 } });
const before = [el("받는 번호 변경", "Button"), el("010-1234-5678", "TextField", "010-1234-5678"), el("상품 교환")];

test("이미 보이는 대상의 appear 는 그 요소를 밝혀 거부한다", () => {
  const [error] = mobilePremiseErrors([{ type: "appear", text: "상품 교환" }], before);
  assert.match(error, /^appear 상품 교환: 조작 전부터 조건에 맞는 요소가 있음\(상품 교환\)/);
});

test("조작 전에 없는 대상의 disappear·unchanged 는 비슷한 이름을 붙여 거부한다", () => {
  const errors = mobilePremiseErrors([
    { type: "disappear", name: "번호 변경" },
    { type: "unchanged", name: "포인트" },
  ], before);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^disappear 번호 변경: 조작 전 화면에 조건에 맞는 요소 없음\. 비슷한 이름: 받는 번호 변경$/);
  assert.equal(errors[1], "unchanged 포인트: 조작 전 화면에 조건에 맞는 요소 없음");
});

// 같은 요소의 이름이 바뀌는 change 는 조작 전 트리에 새 이름이 없어도 지금 판정에서 통과함(검토 지적)
test("이름이 바뀌는 요소의 change 는 조작 전에 새 이름이 없어도 거부하지 않고 판정에서 통과한다", async () => {
  const status = name => ({ type: "StaticText", resourceId: "status", AXLabel: name, AXValue: name, frame: { x: 0, y: 0, width: 10, height: 10 } });
  const expected = { type: "change", role: "statictext", name: "완료", from: "대기", to: "완료", oracle: "기능의 용도" };
  assert.deepEqual(mobilePremiseErrors([expected], [status("대기")]), []);
  let tapped = false;
  const watch = createMobileReaction({ before: [status("대기")], expect: { effects: [expected], within: 50 }, action: { command: "tap", args: { x: 1, y: 1 } },
    identity: { targetId: "phone" }, interval: 5, tailMs: 1, operationTimeoutMs: 50, readTree: async () => [status(tapped ? "완료" : "대기")], capture: async () => ({ path: "shot.png" }) });
  assert.deepEqual(watch.premise(), []);
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish(); await watch.stop();
  assert.equal(result.pass, true);
});

test("새로 나타날 대상의 appear, 유지·변경, 대상 없는 기대는 통과시킨다", () => {
  assert.deepEqual(mobilePremiseErrors([
    { type: "appear", text: "변경 완료" },
    { type: "unchanged", text: "상품 교환" },
    { type: "change", name: "010-1234-5678", to: "010-0000-0000" },
    { type: "change", text: "010-9999-0000", to: "x" },
    { type: "disappear", name: "받는 번호 변경" },
    { type: "absent", text: "오류" },
    { type: "none" },
  ], before), []);
});

test("관찰기의 premise 는 선언한 기대를 조작 전 트리로 검사하고 배경 관찰은 검사하지 않는다", () => {
  const make = (background) => createMobileReaction({ before, background, expect: { effects: background ? [] : [{ type: "appear", text: "상품 교환", oracle: "기능의 용도" }], within: 50 },
    action: { command: "tap", args: { x: 1, y: 1 } }, identity: { targetId: "phone" }, interval: 5, tailMs: 1, operationTimeoutMs: 50,
    readTree: async () => before, capture: async () => ({ path: "shot.png" }) });
  assert.equal(make(false).premise().length, 1);
  assert.deepEqual(make(true).premise(), []);
});
