// Antigravity 키체인 자격증명 파싱과 Claude 동일 구조(5h·wk·Argon) 집계 검증
import assert from "node:assert/strict";
import test from "node:test";

import { parseAntigravityKeychain, parseAntigravityQuota } from "../server/usage.js";

test("go-keyring-base64 접두사가 붙은 키체인 항목에서 토큰과 만료 시각을 읽는다", () => {
  const payload = {
    token: {
      access_token: "ya29.test-token",
      token_type: "Bearer",
      expiry: "2026-11-24T05:15:59.096527+09:00",
    },
    auth_method: "consumer",
  };
  const encoded = "go-keyring-base64:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const out = parseAntigravityKeychain(encoded);
  assert.equal(out.token, "ya29.test-token");
  assert.equal(out.expiresAt, Date.parse("2026-11-24T05:15:59.096527+09:00"));
});

test("평문 JSON 키체인 항목도 읽고 손상된 값은 null 을 반환한다", () => {
  const out = parseAntigravityKeychain(JSON.stringify({ access_token: "tok-plain", expiry_date: 1795450000000 }));
  assert.deepEqual(out, { token: "tok-plain", expiresAt: 1795450000000 });
  assert.equal(parseAntigravityKeychain(""), null);
  assert.equal(parseAntigravityKeychain("go-keyring-base64:not-json"), null);
  assert.equal(parseAntigravityKeychain(JSON.stringify({ token: {} })), null);
});

test("타사(claude·gpt)와 내부용을 빼고 5시간·주간·Argon 만 Claude 구조로 묶는다", () => {
  const now = Date.parse("2026-11-23T19:50:00Z");
  const out = parseAntigravityQuota({
    buckets: [
      { modelId: "chat_20706", remainingFraction: 0.2 },
      { modelId: "claude-opus-5-5-high", remainingFraction: 0.1, resetTime: "2026-11-24T00:22:45Z" },
      { modelId: "gpt-oss-120b-medium", remainingFraction: 0.2, resetTime: "2026-11-24T00:22:45Z" },
      { modelId: "gemini-2.5-pro", remainingFraction: 0.95, resetTime: "2026-11-24T00:17:02Z" },
      { modelId: "gemini-3-flash", remainingFraction: 0.60, resetTime: "2026-11-24T00:17:02Z" },
      { modelId: "gemini-weekly", remainingFraction: 0.70, resetTime: "2026-11-30T00:00:00Z" },
      { modelId: "gemini-4-argon-high", remainingFraction: 0.50, resetTime: "2026-11-24T00:17:02Z" },
    ],
  }, now);
  assert.deepEqual(out, {
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: Date.parse("2026-11-24T00:17:02Z") },
    weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: Date.parse("2026-11-30T00:00:00Z") },
    scoped: [{ label: "Argon", window: { usedPercent: 50, windowMinutes: 300, resetsAt: Date.parse("2026-11-24T00:17:02Z") } }],
  });
});
