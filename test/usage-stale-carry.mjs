// 사용량 한 회차가 실패했을 때 앞서 받은 값을 어떻게 다루는가.
//
// 이 판정은 429·연결 끊김처럼 손으로 만들어 내기 어려운 조건에서만 실행되어, 앱을 띄워
// 보는 것으로는 확인할 수 없다. 그래서 판정 함수를 직접 부른다.
import assert from "node:assert/strict";
import test from "node:test";

import { carryStale } from "../server/usage-handlers.js";
import { normalizeOpencodeCookie } from "../server/usage.js";

const HOUR = 60 * 60 * 1000;

function good(at) {
  return {
    provider: "claude", status: "ok", error: null, updatedAt: at,
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: at + HOUR },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: at + 24 * HOUR },
  };
}

function bad(kind, extra = {}) {
  return {
    provider: "claude", status: "error", failureKind: kind, error: null,
    session: null, weekly: null, updatedAt: Date.now(), ...extra,
  };
}

test("성공한 회차는 그대로 통과한다", () => {
  const next = good(Date.now());
  assert.equal(carryStale(next, good(Date.now() - HOUR)), next);
});

test("429 는 앞선 값을 지우지 않고 stale 로 세운다", () => {
  const dataAt = Date.now() - 5 * 60 * 1000;
  const out = carryStale(bad("rate-limited", { retryAt: Date.now() + 600000 }), good(dataAt));
  assert.equal(out.status, "ok", "값이 있는 줄은 ok 로 남아야 화면이 숫자를 그린다");
  assert.equal(out.stale, true);
  assert.equal(out.failureKind, "rate-limited");
  assert.equal(out.session.usedPercent, 12);
  assert.equal(out.dataAt, dataAt, "언제 받은 값인지가 남아야 사람이 판단할 수 있다");
  assert.ok(out.retryAt > Date.now(), "다음 회차가 건너뛸 시각을 들고 간다");
});

test("연결 실패도 앞선 값을 들고 간다", () => {
  const out = carryStale(bad("network"), good(Date.now() - HOUR));
  assert.equal(out.stale, true);
  assert.equal(out.weekly.usedPercent, 40);
});

test("계정이 없다는 대답은 앞선 값을 덮는다", () => {
  // 로그아웃했는데 이전 값이 계속 표시되면 그것이 더 잘못된 정보다.
  for (const kind of ["missing-credentials", "needs-cookie", "bad-setting"]) {
    const out = carryStale(bad(kind), good(Date.now() - HOUR));
    assert.equal(out.status, "error", `${kind} 는 값을 들고 가면 안 된다`);
    assert.equal(out.session, null);
  }
});

test("하루가 지난 값은 더 들고 가지 않는다", () => {
  const out = carryStale(bad("rate-limited"), good(Date.now() - 25 * HOUR));
  assert.equal(out.status, "error");
  assert.equal(out.session, null);
});

test("앞선 회차에도 값이 없었으면 들고 갈 것이 없다", () => {
  assert.equal(carryStale(bad("network"), bad("network")).status, "error");
  assert.equal(carryStale(bad("network"), null).status, "error");
});

test("stale 이 이어져도 최초로 값을 받은 시각을 잃지 않는다", () => {
  const dataAt = Date.now() - 2 * HOUR;
  const once = carryStale(bad("rate-limited"), good(dataAt));
  const twice = carryStale(bad("rate-limited"), once);
  assert.equal(twice.dataAt, dataAt, "이어질 때마다 시각이 새로워지면 '언제 값'이 거짓이 된다");
});

test("opencode 쿠키는 값만 붙여 넣어도 이름을 갖춘다", () => {
  assert.equal(normalizeOpencodeCookie("Fe26.2**abc"), "auth=Fe26.2**abc");
  assert.equal(normalizeOpencodeCookie("auth=zz"), "auth=zz");
  assert.equal(normalizeOpencodeCookie("auth=zz; other=1"), "auth=zz; other=1");
  assert.equal(normalizeOpencodeCookie("  "), "");
});
