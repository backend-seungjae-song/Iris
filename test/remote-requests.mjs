import assert from "node:assert/strict";
import test from "node:test";

import { isRemoteRequest } from "../server/remote/contract/requests.js";
import { createRequestAnswerOperation } from "../server/remote/ops/request-answer.js";
import { createRequestStore } from "../server/remote/requests.js";

const AGENT = "a".repeat(32);

function randomSequence() {
  let value = 1;
  return (size) => Buffer.alloc(size, value++);
}

test("인증 뒤 요청은 정확한 키와 rid 형식만 받는다", () => {
  const requests = [
    { type: "caps.get" },
    { type: "ping", rid: "r_1" },
    { type: "ping", rid: "r_2", active: true },
    { type: "watch", rid: "w1" },
    { type: "transcript.page", rid: "t1", agent: AGENT },
    { type: "transcript.watch", rid: "t2", agent: AGENT },
    { type: "agent.stop", rid: "s1", agent: AGENT },
    { type: "agent.message", rid: "m1", agent: AGENT, text: "첫째\n둘째" },
    { type: "agent.message", rid: "m2", agent: AGENT, text: "", drafts: ["d".repeat(32)] },
    { type: "request.answer", rid: "a1", request: "b".repeat(32), answer: { behavior: "allow" } },
  ];
  for (const request of requests) {
    assert.equal(isRemoteRequest(request), true, request.type);
    assert.equal(isRemoteRequest({ ...request, extra: true }), false, `${request.type} 추가 키`);
  }
  assert.equal(isRemoteRequest({ type: "ping", rid: "공백 없음" }), false);
  assert.equal(isRemoteRequest({ type: "ping", rid: "r3", active: "yes" }), false);
  assert.equal(isRemoteRequest({ type: "agent.message", rid: "m1", agent: AGENT, text: "bad\u0000" }), false);
  assert.equal(isRemoteRequest({ type: "agent.message", rid: "m1", agent: AGENT,
    text: "본문\x1b[201~" }), false);
  assert.equal(isRemoteRequest({ type: "agent.message", rid: "m1", agent: AGENT, text: "첫째\r\n둘째" }), true);
  assert.equal(isRemoteRequest({ type: "agent.message", rid: "m1", agent: AGENT,
    text: "", drafts: ["d".repeat(32), "d".repeat(32)] }), false);
  assert.equal(isRemoteRequest({ type: "agent.message", rid: "m1", agent: AGENT, text: "" }), false);
});

test("request.answer 처리는 저장소의 한 번 답 결과를 그대로 투영한다", async () => {
  const store = createRequestStore({ randomBytes: randomSequence(), setTimer: () => ({ unref() {} }), clearTimer() {} });
  const request = store.add({ agent: AGENT, kind: "claude-permission", createdAt: 1, expiresAt: Date.now() + 60_000,
    body: { tool: "Read", description: "", input: "x" } }, async () => "delivered");
  const answer = createRequestAnswerOperation({ requests: store });
  assert.deepEqual(await answer({}, { rid: "a1", request: request.ref, answer: { behavior: "allow" } }),
    { type: "request.answer.result", rid: "a1", result: "delivered" });
  assert.deepEqual(await answer({}, { rid: "a2", request: request.ref, answer: { behavior: "deny" } }),
    { type: "request.answer.result", rid: "a2", result: "already-answered" });
  assert.deepEqual(await answer({}, { rid: "a3", request: "f".repeat(32), answer: { behavior: "deny" } }),
    { type: "request.answer.result", rid: "a3", result: "expired" });
  store.close();
});

test("브라우저 사람 차례 답은 두 선택지만 받고 먼저 온 답 하나만 전달한다", async () => {
  const store = createRequestStore({ randomBytes: randomSequence(), setTimer: () => ({ unref() {} }), clearTimer() {} });
  const request = store.add({ agent: AGENT, kind: "browser-user", createdAt: 1, expiresAt: Date.now() + 60_000,
    body: { title: "사람 차례", text: "로그인을 마쳐 주세요.", choices: ["다 했음", "못 하겠음"] } },
  async () => "delivered");
  const answer = createRequestAnswerOperation({ requests: store });
  assert.equal(isRemoteRequest({ type: "request.answer", rid: "b1", request: request.ref,
    answer: { choice: "done" } }), true);
  assert.equal(isRemoteRequest({ type: "request.answer", rid: "b2", request: request.ref,
    answer: { choice: "later" } }), false);
  assert.equal((await answer({}, { rid: "b1", request: request.ref, answer: { choice: "done" } })).result,
    "delivered");
  assert.equal((await answer({}, { rid: "b2", request: request.ref, answer: { choice: "unable" } })).result,
    "already-answered");
  store.close();
});

test("요청 저장소는 먼저 온 답 하나만 전달하고 실패 결과를 보존한다", async () => {
  let release;
  let deliveries = 0;
  const store = createRequestStore({ randomBytes: randomSequence(), agentRefForPane: () => AGENT,
    setTimer: () => ({ unref() {} }), clearTimer() {} });
  const request = store.add({ paneId: "private-pane", kind: "claude-permission", createdAt: 1,
    expiresAt: Date.now() + 60_000, body: { tool: "Bash", description: "설명", input: "입력" } }, async () => {
    deliveries++;
    await new Promise((resolve) => { release = resolve; });
    return "delivered";
  });
  assert.equal("paneId" in request, false);
  const first = store.answer(request.ref, { behavior: "allow" });
  assert.equal(await store.answer(request.ref, { behavior: "deny" }), "already-answered");
  release();
  assert.equal(await first, "delivered");
  assert.equal(deliveries, 1);
  assert.deepEqual(store.list(), []);

  const failed = store.add({ agent: AGENT, kind: "claude-permission", createdAt: 2,
    expiresAt: Date.now() + 60_000, body: { tool: "Read", description: "", input: "x" } }, async () => "failed");
  assert.equal(await store.answer(failed.ref, { behavior: "allow" }), "failed");
  store.close();
});

test("만료·취소와 원격 끄기는 생산자와 폰 구독 상태를 분리한다", async () => {
  let time = 10;
  let remoteCanceled = 0;
  const store = createRequestStore({ now: () => time, randomBytes: randomSequence(),
    agentRefForPane: () => AGENT, setTimer: () => ({ unref() {} }), clearTimer() {} });
  const request = store.add({ paneId: "pane", kind: "claude-question", createdAt: 10, expiresAt: 20,
    body: { questions: [{ question: "선택", header: "질문", multiSelect: false,
      options: [{ label: "예", description: "" }] }] } }, async () => "delivered", () => { remoteCanceled++; });
  store.notifyRemoteDisabled();
  store.notifyRemoteDisabled();
  assert.equal(remoteCanceled, 1);
  assert.equal(store.list().length, 1, "원격 끄기는 Mac 답용 레코드를 유지한다");
  const canceled = store.add({ agent: AGENT, kind: "claude-permission", createdAt: 11, expiresAt: 21,
    body: { tool: "Read", description: "", input: "x" } }, async () => "delivered");
  assert.equal(store.cancel(canceled.ref), true);
  assert.equal(store.list().some((item) => item.ref === canceled.ref), false);
  time = 20;
  assert.equal(await store.answer(request.ref, { answers: [{ labels: ["예"] }] }), "expired");
  assert.deepEqual(store.list(), []);
  store.close();
});
