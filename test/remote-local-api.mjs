import assert from "node:assert/strict";
import test from "node:test";

import { handleRemoteLocalApi } from "../server/remote/local-api.js";

function socket(local = true, ui = true) {
  return {
    _local: local,
    _ui: ui,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
}

function service(log) {
  return {
    sendState(ws) { log.push("status"); ws.send(JSON.stringify({ type: "remote.state", status: "off" })); },
    requestEnable() { log.push("enable"); },
    requestDisable() { log.push("disable"); },
    retryStop() { log.push("retry-stop"); },
    requestPairStart() { log.push("pair-start"); return { ok: true }; },
    requestPairConfirm(code) { log.push(`pair-confirm:${code}`); return { ok: true }; },
    requestPairCancel() { log.push("pair-cancel"); return { ok: true }; },
    removeDevice(deviceId) { log.push(`remove:${deviceId}`); return { ok: true }; },
    setAccessPin(pin, confirmation) { log.push(`pin:${pin === confirmation}`); return { ok: true, configured: true, resumed: false }; },
    setPinIdleMinutes(minutes) { log.push(`pin-idle:${minutes}`); return { ok: true, pinIdleMinutes: minutes }; },
    answerRequest(request, answer) { log.push(`answer:${request}:${answer.behavior || "question"}`); return "delivered"; },
    installQuestionHook() { log.push("hook-install"); return { ok: true, installed: true }; },
    removeQuestionHook() { log.push("hook-remove"); return { ok: true, installed: false }; },
  };
}

test("Mac 관리 요청은 local UI 연결과 정해진 입력만 받는다", () => {
  for (const ws of [socket(false, true), socket(true, false)]) {
    const log = [];
    assert.equal(handleRemoteLocalApi(ws, { type: "remote.enable" }, service(log)), true);
    assert.deepEqual(log, []);
    assert.equal(ws.sent[0].type, "remote.error");
  }

  for (const message of [
    { type: "remote.unknown" },
    { type: "remote.enable", extra: true },
    { type: "remote.status", requestId: "" },
    { type: "remote.disable", requestId: "x".repeat(101) },
    { type: "remote.pair.confirm", code: 123456 },
    { type: "remote.pair.confirm", code: "12345" },
    { type: "remote.pair.cancel", code: "123456" },
    { type: "remote.device.remove", deviceId: "not-a-device" },
    { type: "remote.pin.set", pin: "12345", confirmation: "12345" },
    { type: "remote.pin.set", pin: "123456", confirmation: "123456", extra: true },
    { type: "remote.pin-idle.set", minutes: 15 },
  ]) {
    const ws = socket();
    const log = [];
    assert.equal(handleRemoteLocalApi(ws, message, service(log)), true);
    assert.deepEqual(log, []);
    assert.equal(ws.sent[0].type, "remote.error");
  }
  assert.equal(handleRemoteLocalApi(socket(), { type: "other.status" }, service([])), false);
});

test("Mac 관리 요청은 검사 뒤 수명 관리 함수만 호출한다", () => {
  const cases = [
    ["remote.status", "status"],
    ["remote.enable", "enable"],
    ["remote.disable", "disable"],
    ["remote.retry-stop", "retry-stop"],
    ["remote.pair.start", "pair-start"],
    ["remote.pair.confirm", "pair-confirm:123456", { code: "123456" }],
    ["remote.pair.cancel", "pair-cancel"],
    ["remote.device.remove", `remove:${"a".repeat(32)}`, { deviceId: "a".repeat(32) }],
    ["remote.pin.set", "pin:true", { pin: "123456", confirmation: "123456" }],
    ["remote.pin-idle.set", "pin-idle:20", { minutes: 20 }],
    ["remote.request.answer", `answer:${"b".repeat(32)}:allow`, {
      request: "b".repeat(32), answer: { behavior: "allow" },
    }],
    ["remote.question-hook.install", "hook-install"],
    ["remote.question-hook.remove", "hook-remove"],
  ];
  for (const [type, expected, fields = {}] of cases) {
    const ws = socket();
    const log = [];
    assert.equal(handleRemoteLocalApi(ws, { type, requestId: "request-1", ...fields }, service(log)), true);
    assert.deepEqual(log, [expected]);
  }
});

test("Mac 답변 성공 결과는 같은 요청 번호와 요청 ref를 돌려준다", async () => {
  const ws = socket();
  handleRemoteLocalApi(ws, { type: "remote.request.answer", requestId: "ui-1",
    request: "b".repeat(32), answer: { behavior: "allow" } }, service([]));
  await Promise.resolve();
  assert.deepEqual(ws.sent, [{ type: "remote.request.answer.result", requestId: "ui-1",
    request: "b".repeat(32), result: "delivered" }]);
});

test("PIN 저장 결과는 공유 자동 재개 여부를 돌려준다", async () => {
  const ws = socket();
  const owner = service([]);
  owner.setAccessPin = () => ({ ok: true, configured: true, resumed: true });
  handleRemoteLocalApi(ws, {
    type: "remote.pin.set", requestId: "pin-1", pin: "123456", confirmation: "123456",
  }, owner);
  await Promise.resolve();
  assert.deepEqual(ws.sent, [{
    type: "remote.pin.result", requestId: "pin-1", configured: true, resumed: true,
  }]);
});

test("PIN 기한 저장 결과는 선택한 분을 돌려준다", async () => {
  const ws = socket();
  handleRemoteLocalApi(ws, {
    type: "remote.pin-idle.set", requestId: "idle-1", minutes: 60,
  }, service([]));
  await Promise.resolve();
  assert.deepEqual(ws.sent, [{
    type: "remote.pin-idle.result", requestId: "idle-1", minutes: 60,
  }]);
});

test("Mac 관리 요청의 실패는 쉬운 remote.error로 보낸다", async () => {
  const ws = socket();
  const owner = service([]);
  owner.requestPairConfirm = () => ({ ok: false, error: "pairing-code-mismatch" });
  handleRemoteLocalApi(ws, { type: "remote.pair.confirm", code: "000000", requestId: "pair-1" }, owner);
  await Promise.resolve();
  assert.deepEqual(ws.sent, [{
    type: "remote.error", requestId: "pair-1", code: "pairing-code-mismatch", message: "코드가 일치하지 않습니다.",
  }]);

  const noUi = socket(true, false);
  handleRemoteLocalApi(noUi, { type: "remote.pair.start" }, owner);
  assert.equal(noUi.sent[0].code, "local-ui-only");
});
