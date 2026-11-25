import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { attachWs, initWsTransport } from "../server/ws-transport.js";

function socket(overrides = {}) {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    terminated: 0,
    send(data) { this.sent.push(JSON.parse(String(data))); },
    terminate() { this.terminated++; },
  }, overrides);
  return ws;
}

test("WS 초기 상태와 비동기 dispatch 오류는 연결을 종료하고 control-error로 알린다", async () => {
  const wss = new EventEmitter();
  initWsTransport({ wss, isLocalRequest: () => true });
  attachWs({
    initialState() { throw new Error("initial failed"); },
    dispatch() { return Promise.reject(new Error("dispatch failed")); },
    onClose() {},
  });
  const initial = socket();
  assert.doesNotThrow(() => wss.emit("connection", initial, {}));
  assert.equal(initial.terminated, 1);
  assert.equal(initial.sent[0].type, "control-error");

  const ready = socket();
  const secondWss = new EventEmitter();
  initWsTransport({ wss: secondWss, isLocalRequest: () => true });
  attachWs({ initialState() {}, dispatch() { return Promise.reject(new Error("dispatch failed")); }, onClose() {} });
  secondWss.emit("connection", ready, {});
  ready.emit("message", Buffer.from('{"type":"test"}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready.sent.at(-1).type, "control-error");
});

test("연결의 직접 send 호출도 전송량 제한과 예외 격리를 적용한다", () => {
  const wss = new EventEmitter();
  initWsTransport({ wss, isLocalRequest: () => true });
  attachWs({
    initialState() {},
    dispatch(ws) { ws.send(JSON.stringify({ type: "reply" })); },
    onClose() {},
  });
  const broken = socket({ send() { throw new Error("write failed"); } });
  assert.doesNotThrow(() => {
    wss.emit("connection", broken, {});
    broken.emit("message", Buffer.from('{"type":"test"}'));
  });
  assert.equal(broken.terminated, 1);

  const slow = socket({ bufferedAmount: 9 * 1024 * 1024, send() { assert.fail("queued another frame"); } });
  assert.doesNotThrow(() => {
    wss.emit("connection", slow, {});
    slow.send(JSON.stringify({ type: "reply" }));
  });
  assert.equal(slow.terminated, 1);
});

test("terminate 예외가 error 이벤트를 프로세스 오류로 만들지 않는다", () => {
  const wss = new EventEmitter();
  initWsTransport({ wss, isLocalRequest: () => true });
  attachWs({ initialState() {}, dispatch() {}, onClose() {} });
  const ws = socket({ terminate() { throw new Error("already closed"); } });
  wss.emit("connection", ws, {});
  assert.doesNotThrow(() => ws.emit("error", new Error("connection reset")));
});

test("직접 send를 차단해도 전송 완료를 기다리는 호출자에게 오류를 알린다", async () => {
  const wss = new EventEmitter();
  initWsTransport({ wss, isLocalRequest: () => true });
  attachWs({ initialState() {}, dispatch() {}, onClose() {} });
  const slow = socket({ bufferedAmount: 9 * 1024 * 1024 });
  wss.emit("connection", slow, {});
  let error;
  slow.send("frame", {}, value => { error = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(error instanceof Error);
  assert.equal(slow.terminated, 1);
});
