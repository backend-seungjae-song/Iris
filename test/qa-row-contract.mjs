import assert from "node:assert/strict";
import test from "node:test";

import { listFromSource, nominalFault, quoteFromSource } from "../server/qa-row-contract.js";

test("상태 모듈에서 분리한 근거 인용 결과를 보존", () => {
  assert.deepEqual(quoteFromSource("test/qa-rows.test.mjs:1-3"), {
    quote: "import { qaPlan, qaRowContract } from \"./qa-fixtures.mjs\";\n"
      + "import assert from \"node:assert/strict\";\n"
      + "import fs from \"node:fs\";",
  });
  assert.deepEqual(quoteFromSource("missing-file:1"), {
    error: "그 파일을 읽지 못했습니다: missing-file",
  });
});

test("상태 모듈에서 분리한 목록 추출 결과를 보존", () => {
  const result = listFromSource({
    source: "test/qa-rows.test.mjs",
    pick: "test\\(\\\"([^\\\"]+)",
  });
  assert.equal(result.items.length, 14);
  assert.deepEqual(result.items[0], {
    id: "선언 조건과 중복 id를 거부하고 근거를 보존",
    text: "test(\"선언 조건과 중복 id를 거부하고 근거를 보존\", async () => {",
    at: "test/qa-rows.test.mjs:25",
  });
  assert.deepEqual(listFromSource({ source: "test/qa-rows.test.mjs", pick: "NO_MATCH" }), {
    error: "그 규칙이 test/qa-rows.test.mjs에서 아무것도 못 찾았습니다: NO_MATCH\n"
      + "0개짜리 목록은 완전한 목록과 구별되지 않습니다 — 규칙을 고치거나 items로 직접 적으세요.",
  });
});

test("상태 모듈에서 분리한 라벨체 검사를 보존", () => {
  assert.match(nominalFault("판정", "버튼이 눌리지 않는다."), /^판정: 보고서는 라벨체입니다\./);
  assert.equal(nominalFault("판정", "버튼이 눌렸나요?"), null);
});
