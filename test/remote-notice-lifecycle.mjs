import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteFeatures } from "../server/remote/features/index.js";
import { createRequestStore } from "../server/remote/requests.js";

function fixture(t, initial = {}) {
  let time = 10_000;
  let sequence = 0;
  const timers = new Set();
  const setTimer = (callback, delay) => {
    const timer = { callback, at: time + delay, unref() {} };
    timers.add(timer);
    return timer;
  };
  const clearTimer = (timer) => timers.delete(timer);
  let notices = [{ id: "ask-login", session: "w1:p7", kind: "ask", round: 1,
    title: "로그인", text: "로그인을 마쳐 주세요.", wait: 30, ...initial }];
  const delivered = [];
  const issuedRefs = new Set();
  const store = createRequestStore({ now: () => time, setTimer, clearTimer,
    randomBytes: (size) => Buffer.alloc(size, ++sequence) });
  store.subscribe(() => {
    for (const request of store.list()) issuedRefs.add(request.ref);
  });
  const features = createRemoteFeatures({ requests: store,
    agents: { resolvePane: () => ({ ref: "a".repeat(32) }) }, now: () => time,
    pendingUserNotices: () => notices,
    answerUserAsk: (id, answer) => delivered.push({ id, answer }),
    askSetTimer: setTimer, askClearTimer: clearTimer,
    terminalFeature: { available: () => false, closeConnection() {}, close() {} },
    browserFeature: { refForTabId: () => null, interactiveAvailable: () => false, closeConnection() {}, close() {} },
    sourceControlFeature: { gitAvailable: () => false, githubAvailable: () => false } });
  t.after(() => { features.close(); store.close(); });
  return {
    store, issuedRefs, delivered,
    update(fields) { notices = notices.map((notice) => ({ ...notice, ...fields })); },
    remove() { notices = []; },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        time = next.at; timers.delete(next); next.callback();
      }
      time = end;
    },
  };
}

test("대기 시간이 끝난 같은 round는 원격 요청을 다시 만들지 않는다", (t) => {
  const f = fixture(t, { wait: 0 });
  const first = f.store.list()[0];
  f.advance(4_000);
  assert.equal(f.store.get(first.ref).status, "expired");
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual([...f.issuedRefs], [first.ref]);
  assert.deepEqual(f.delivered, []);
});

test("대기 중인 요청도 만료 후 같은 round에서 다시 알리지 않는다", (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  f.update({ wait: 0 });
  f.advance(32_000);
  assert.equal(f.store.get(first.ref).status, "expired");
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual([...f.issuedRefs], [first.ref]);
});

test("같은 id의 새 round는 만료된 요청을 이어 새 요청을 한 번 만든다", async (t) => {
  const f = fixture(t, { wait: 0 });
  const first = f.store.list()[0];
  f.advance(2_000);
  f.update({ round: 2, wait: 30 });
  f.advance(250);
  const second = f.store.list()[0];
  assert.notEqual(second.ref, first.ref);
  assert.equal(await f.store.answer(first.ref, { choice: "done" }), "expired");
  assert.equal(await f.store.answer(second.ref, { choice: "done" }), "delivered");
  f.advance(2_000);
  assert.deepEqual(f.store.list(), []);
  assert.equal(f.issuedRefs.size, 2);
  assert.deepEqual(f.delivered, [{ id: "ask-login", answer: "다 했음" }]);
});

test("새 round가 시작되면 이전 round의 아직 남은 요청으로 답할 수 없다", async (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  f.update({ round: 2 });
  f.advance(250);
  const second = f.store.list()[0];
  assert.notEqual(second.ref, first.ref);
  assert.equal(await f.store.answer(first.ref, { choice: "done" }), "expired");
  assert.equal(await f.store.answer(second.ref, { choice: "unable" }), "delivered");
  assert.deepEqual(f.delivered, [{ id: "ask-login", answer: "못 했음" }]);
});

test("못 하겠음 버튼은 브라우저 호출이 해석하는 못 했음 값을 전달한다", async (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  assert.equal(await f.store.answer(first.ref, { choice: "unable" }), "delivered");
  f.advance(1_000);
  assert.equal(f.issuedRefs.size, 1);
  assert.deepEqual(f.delivered, [{ id: "ask-login", answer: "못 했음" }]);
});

test("답한 알림도 새 round에서는 다시 답할 수 있다", async (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  assert.equal(await f.store.answer(first.ref, { choice: "done" }), "delivered");
  f.update({ round: 2 });
  f.advance(250);
  const second = f.store.list()[0];
  assert.notEqual(second.ref, first.ref);
  assert.equal(await f.store.answer(second.ref, { choice: "unable" }), "delivered");
  assert.deepEqual(f.delivered.map((item) => item.answer), ["다 했음", "못 했음"]);
});

test("동기화 전에 round가 바뀌어도 이전 질문의 답을 새 호출에 전달하지 않는다", async (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  f.update({ round: 2 });
  assert.equal(await f.store.answer(first.ref, { choice: "done" }), "failed");
  assert.deepEqual(f.delivered, []);
  f.advance(250);
  const second = f.store.list()[0];
  assert.notEqual(second.ref, first.ref);
  assert.equal(await f.store.answer(second.ref, { choice: "done" }), "delivered");
});

test("데스크톱에서 닫힌 알림은 남은 원격 요청을 취소한다", async (t) => {
  const f = fixture(t);
  const first = f.store.list()[0];
  f.remove();
  f.advance(250);
  assert.deepEqual(f.store.list(), []);
  assert.equal(await f.store.answer(first.ref, { choice: "done" }), "expired");
  assert.deepEqual(f.delivered, []);
});

for (const notice of [
  { kind: "approve", choices: null, wait: 30 },
  { kind: "approve", choices: ["결제 승인", "취소"], wait: 30 },
  { kind: "ask", choices: ["첫 번째", "두 번째", "직접 입력"], wait: 30 },
]) {
  test(`${notice.kind}의 지정 선택지는 기본 완료 질문으로 바꾸지 않는다`, (t) => {
    const f = fixture(t, notice);
    assert.deepEqual(f.store.list(), []);
    f.update({ wait: 0 });
    f.advance(32_000);
    assert.deepEqual(f.store.list(), []);
    assert.equal(f.issuedRefs.size, 0);
    assert.deepEqual(f.delivered, []);
  });
}
