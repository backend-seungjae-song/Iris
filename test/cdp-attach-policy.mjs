// CDP 부착 정책이 "AI 조작 창 안·유지 조건·금지 호스트"를 시계만으로 판정하는지 검증한다.
//
// 소유 범위
//   cdp-attach-policy 의 창 연장·유휴 detach·release·keepers·blocked 계약.
//
// 제공 API
//   node --test test/cdp-attach-policy.mjs 한 명령으로 실제 타이머 없이 판정한다.
//
// 의존 대상
//   주입한 가짜 시계·타이머와 cdp-attach-policy.cjs 의 공개 API만 사용한다.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCdpAttachPolicy, DEFAULT_IDLE_MS } = require("../native/electron/cdp-attach-policy.cjs");

function fixture(overrides = {}) {
  let clock = 1000;
  const timers = new Map();
  let seq = 0;
  const detached = [];
  const urls = new Map();
  const keep = new Set();
  const policy = createCdpAttachPolicy({
    now: () => clock,
    idleMs: 30000,
    setTimer: (fn, delay) => { const id = ++seq; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    keepers: [(id) => keep.has(id)],
    blockedUrl: (url) => /^https:\/\/accounts\.google\.com\//.test(url),
    currentUrl: (id) => urls.get(id) || "https://example.com/",
    detach: (id) => detached.push(id),
    ...overrides,
  });
  // 시계를 옮기고 그 시각까지의 타이머를 순서대로 실행한다.
  const advance = (ms) => {
    clock += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > clock) continue;
      timers.delete(id);
      t.fn();
    }
  };
  return { policy, advance, detached, urls, keep, timers };
}

test("명령이 들어오면 유휴 창 안에서는 붙여 두고 창이 지나면 뗀다", () => {
  const f = fixture();
  f.policy.touch(7);
  assert.equal(f.policy.engaged(7), true);
  assert.equal(f.policy.wants(7), true);
  f.advance(29999);
  assert.equal(f.policy.wants(7), true);
  assert.deepEqual(f.detached, []);
  f.advance(1);
  assert.equal(f.policy.wants(7), false);
  assert.deepEqual(f.detached, [7]);
});

test("명령이 이어지면 창이 미뤄지고 타이머는 하나만 남는다", () => {
  const f = fixture();
  f.policy.touch(7);
  f.advance(20000);
  f.policy.touch(7);
  assert.equal(f.timers.size, 1);
  f.advance(20000);
  assert.deepEqual(f.detached, [], "두 번째 명령 뒤 20초는 아직 창 안이다");
  f.advance(10000);
  assert.deepEqual(f.detached, [7]);
});

test("유지 조건(녹화·지목 등)이 참이면 창이 지나도 떼지 않고, 꺼진 뒤 reconsider 로 뗀다", () => {
  const f = fixture();
  f.keep.add(7);
  f.policy.touch(7);
  f.advance(30000);
  assert.deepEqual(f.detached, []);
  assert.equal(f.policy.wants(7), true);
  f.keep.delete(7);
  f.policy.reconsider(7);
  f.advance(0);
  assert.deepEqual(f.detached, [7]);
});

test("release 는 창을 즉시 닫고 바로 뗀다", () => {
  const f = fixture();
  f.policy.touch(7);
  f.policy.release(7);
  assert.deepEqual(f.detached, [7]);
  assert.equal(f.policy.engaged(7), false);
  assert.equal(f.timers.size, 0, "닫힌 창의 타이머가 남아 두 번 떼지 않는다");
});

test("금지 호스트 문서에서는 조작 창 안이어도 붙이지 못하고 판정 시 뗀다", () => {
  const f = fixture();
  f.urls.set(7, "https://accounts.google.com/signin/v2/identifier");
  f.policy.touch(7);
  assert.equal(f.policy.blocked(7), true);
  assert.equal(f.policy.allowAttach(7), false);
  f.policy.reconsider(7);
  f.advance(0);
  assert.deepEqual(f.detached, [7]);
  f.urls.set(7, "https://app.example.com/callback");
  assert.equal(f.policy.allowAttach(7), true, "호스트를 떠나면 다시 붙일 수 있다");
});

test("잘못된 id 는 무시하고, forget 은 창과 타이머를 지운다", () => {
  const f = fixture();
  f.policy.touch("abc");
  assert.equal(f.timers.size, 0);
  f.policy.touch(9);
  f.policy.forget(9);
  assert.equal(f.timers.size, 0);
  assert.equal(f.policy.engaged(9), false);
  f.advance(60000);
  assert.deepEqual(f.detached, []);
});

test("기본 유휴 창은 LLM 회차 간격을 덮는 길이다", () => {
  assert.ok(DEFAULT_IDLE_MS >= 20000 && DEFAULT_IDLE_MS <= 120000);
});
