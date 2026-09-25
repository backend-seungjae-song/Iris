// Claude 초기화권(cedar_ember) 응답을 화면 값으로 바꾸는 판정.
//
// 버튼을 잠글지는 이 판정 하나가 정한다. 한도에 걸리지 않았는데 버튼이 열리거나, 걸렸는데
// 잠기면 사용자가 초기화권을 쓸 수 없거나 헛되이 누르게 된다. 응답을 손으로 만들어 넣는다.
import assert from "node:assert/strict";
import test from "node:test";

import { claudeCredits } from "../server/usage.js";

function grant(extra = {}) {
  return {
    id: "g1", label: "", resets_total: 3, resets_left: 2,
    ends_at: "2030-01-01T00:00:00Z", clears: ["five_hour", "seven_day"],
    paused: false, usable_now: false, use_requires_limit: true, ...extra,
  };
}

function status(extra = {}) {
  return { eligible: true, at_limit: false, grants: [grant()], next_grant_id: "g1", ...extra };
}

test("블록이 없으면 아무 값도 넣지 않는다", () => {
  assert.deepEqual(claudeCredits(undefined), {});
  assert.deepEqual(claudeCredits(null), {});
  assert.deepEqual(claudeCredits({ eligible: false, grants: [] }), {});
});

test("한도에 걸리지 않았고 한도가 필요한 초기화권이면 잠근다", () => {
  const out = claudeCredits(status());
  assert.equal(out.resetCredits, 2);
  assert.equal(out.resetGrantId, "g1");
  assert.equal(out.resetBlocked, "needs-limit");
  assert.equal(out.resetCreditExpiresAt, Date.parse("2030-01-01T00:00:00Z"));
});

test("한도에 걸렸으면 연다", () => {
  const out = claudeCredits(status({ at_limit: true }));
  assert.equal(out.resetBlocked, undefined);
  assert.equal(out.resetGrantId, "g1");
});

test("제공자가 지금 쓸 수 있다고 하면 연다", () => {
  const out = claudeCredits(status({ grants: [grant({ usable_now: true })] }));
  assert.equal(out.resetBlocked, undefined);
});

test("한도가 필요 없는 초기화권은 한도가 아니어도 연다", () => {
  const out = claudeCredits(status({ grants: [grant({ use_requires_limit: false })] }));
  assert.equal(out.resetBlocked, undefined);
});

test("일시정지·쿨다운·자격 없음은 한도와 상관없이 잠근다", () => {
  assert.equal(claudeCredits(status({ at_limit: true, grants: [grant({ paused: true })] })).resetBlocked, "paused");
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.equal(claudeCredits(status({ at_limit: true, cooldown_until: later })).resetBlocked, "cooldown");
  assert.equal(claudeCredits(status({ at_limit: true, eligible: false })).resetBlocked, "ineligible");
});

test("지난 쿨다운은 잠그지 않는다", () => {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(claudeCredits(status({ at_limit: true, cooldown_until: past })).resetBlocked, undefined);
});

test("여러 grant 는 합계로 적고 지목된 grant 로 쓴다", () => {
  const out = claudeCredits(status({
    at_limit: true,
    grants: [grant({ id: "g1", resets_left: 0 }), grant({ id: "g2", resets_left: 3 })],
    next_grant_id: "g2",
  }));
  assert.equal(out.resetCredits, 3);
  assert.equal(out.resetGrantId, "g2");
  assert.equal(out.resetBlocked, undefined);
});

test("지목된 grant 가 없으면 수는 보이되 잠근다", () => {
  const out = claudeCredits(status({ at_limit: true, next_grant_id: null }));
  assert.equal(out.resetCredits, 2);
  assert.equal(out.resetGrantId, undefined);
  assert.equal(out.resetBlocked, "none");
});

test("형식이 틀린 grant 는 버린다", () => {
  const out = claudeCredits(status({
    at_limit: true,
    grants: [grant({ id: "BAD ID" }), grant({ id: "g2", resets_left: "2" })],
    next_grant_id: "g2",
  }));
  assert.deepEqual(out, {});
});
