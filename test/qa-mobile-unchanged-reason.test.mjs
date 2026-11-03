// 항목의 mustNotChange 로 qa_play 가 더하는 unchanged 효과(reason 포함)를 모바일 반응 검사가 받는다(qa-92771d8c W1)
import test from "node:test";
import assert from "node:assert/strict";
import { validateMobileReaction } from "../server/qa-mobile-reaction.js";
import { unchangedExpectations } from "../server/qa-list-review.js";

test("mustNotChange 에서 만든 unchanged 효과가 모바일 기대 검사를 통과한다", () => {
  const row = { id: "W1", oracle: "기능의 용도: 찜", mustNotChange: [{ role: "text", name: "다른 상품의 찜 수", reason: "다른 상품에 영향 없어야 함" }] };
  const step = { effects: [{ type: "appear", text: "찜 완료", oracle: "기능의 용도" }, ...unchangedExpectations(row)], within: 3000 };
  assert.doesNotThrow(() => validateMobileReaction(step));
  assert.throws(() => validateMobileReaction({ effects: [{ type: "appear", text: "찜", oracle: "기능의 용도", reason: 3 }], within: 3000 }), /reason/);
});
