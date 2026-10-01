import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fitsRemoteIpc,
  fitsRemoteOutboundPayload,
  isGatewayMessage,
  isHostMessage,
  MAX_BROWSER_DRAFT_MESSAGE_BYTES,
  MAX_BROWSER_FRAME_MESSAGE_BYTES,
  MAX_REMOTE_FRAME_BYTES,
  REMOTE_RPC_VERSION,
} from "../server/remote/contract/ipc.js";
import { createGatewayIpcQueue } from "../server/remote/gateway/ipc-queue.js";
import { createHostIpcQueue } from "../server/remote/host-ipc-queue.js";
import { REMOTE_REQUEST_TYPES } from "../server/remote/contract/requests.js";
import { createRemoteRpcHost } from "../server/remote/rpc-host.js";

const SERVER_INSTANCE = "1".repeat(32);
const CERT_HASH = "2".repeat(64);
const REQUESTS = ["caps.get", "ping", "watch", "transcript.page", "transcript.watch",
  "agent.stop", "agent.message", "request.answer"];

function configuration() {
  return {
    type: "configure",
    v: REMOTE_RPC_VERSION,
    serverInstance: SERVER_INSTANCE,
    address: "100.64.1.2",
    port: 4292,
    keyPem: "key",
    certPem: "certificate",
    certHash: CERT_HASH,
    tailscalePath: "/tailscale",
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
    this.callbacks = [];
    this.sendResults = [];
    this.callbackErrors = [];
    this.killResults = [];
    this.kills = 0;
    this.deferCallbacks = false;
  }

  send(message, callback) {
    this.sent.push(structuredClone(message));
    const result = this.sendResults.length ? this.sendResults.shift() : true;
    const error = this.callbackErrors.length ? this.callbackErrors.shift() : null;
    if (this.deferCallbacks) this.callbacks.push(() => callback?.(error));
    else queueMicrotask(() => callback?.(error));
    return result;
  }

  kill() {
    this.kills++;
    const result = this.killResults.length ? this.killResults.shift() : true;
    if (result !== false) this.connected = false;
    return result;
  }
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    runNext() {
      const timer = pending.find((value) => !value.cleared);
      assert.ok(timer, "expected an active timer");
      timer.cleared = true;
      timer.fn();
      return timer.delay;
    },
  };
}

function hostHarness(overrides = {}) {
  const children = [];
  const timers = overrides.timers || fakeTimers();
  let random = 2;
  const host = createRemoteRpcHost({
    serverInstance: SERVER_INSTANCE,
    fork(url, args, options) {
      assert.equal(url.pathname.endsWith("/server/remote/gateway/child.js"), true);
      assert.deepEqual(args, [SERVER_INSTANCE]);
      assert.equal(options.serialization, "json");
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    randomBytes: () => Buffer.alloc(16, random++),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onAudit: overrides.onAudit,
    onFailureLimit: overrides.onFailureLimit,
    onFrame: overrides.onFrame,
    auth: overrides.auth,
    operations: overrides.operations,
    macName: overrides.macName || (async () => "MacBook Pro"),
  });
  return { host, children, timers };
}

function projected(child, connId) {
  return child.sent
    .filter((message) => message.type === "conn.send" && message.connId === connId)
    .map((message) => JSON.parse(message.payload));
}

async function listen(harness) {
  const ready = harness.host.start(configuration());
  const child = harness.children.at(-1);
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  assert.equal(child.sent[0].type, "configure");
  child.emit("message", { type: "listening", address: "100.64.1.2", port: 4292, certHash: CERT_HASH });
  await ready;
  return child;
}

async function openConnection(harness, child, gwSeq = 1) {
  child.emit("message", { type: "conn.open", gwSeq, peerIp: "100.64.2.3", nodeId: "node-id", certHash: CERT_HASH });
  await Promise.resolve();
  const accepted = child.sent.find((message) => message.type === "conn.accept" && message.gwSeq === gwSeq);
  assert.ok(accepted);
  return accepted.connId;
}

test("IPC 계약은 정확한 필드만 받고 크기 상한을 적용한다", () => {
  const open = { type: "conn.open", gwSeq: 1, peerIp: "100.64.2.3", nodeId: "n", certHash: CERT_HASH };
  assert.equal(isGatewayMessage(open), true);
  assert.equal(isGatewayMessage({ ...open, authenticated: true }), false);
  assert.equal(isGatewayMessage({ type: "conn.frame", connId: "3".repeat(32), payload: "x".repeat(MAX_REMOTE_FRAME_BYTES) }), true);
  assert.equal(isGatewayMessage({ type: "conn.frame", connId: "3".repeat(32), payload: "x".repeat(MAX_REMOTE_FRAME_BYTES + 1) }), false);
  assert.equal(isHostMessage(configuration()), true);
  assert.equal(isHostMessage({ ...configuration(), verdict: "trusted" }), false);
  assert.equal(fitsRemoteIpc({ payload: "x".repeat(80 * 1024) }), false);
});

test("큰 송신은 브라우저 화면과 붙여넣기 초안에만 종류별 상한을 적용한다", () => {
  const connId = "3".repeat(32);
  const frame = JSON.stringify({ type: "browser.frame", jpeg: "A".repeat(300 * 1024) });
  const draft = JSON.stringify({ type: "browser.draft.result", content: "가".repeat(40 * 1024) });
  const generic = JSON.stringify({ type: "agents", content: "A".repeat(70 * 1024) });
  const exactPayload = (type, field, maximum) => {
    const empty = JSON.stringify({ type, [field]: "" });
    return JSON.stringify({ type, [field]: "A".repeat(maximum - Buffer.byteLength(empty)) });
  };
  const exactFrame = exactPayload("browser.frame", "jpeg", MAX_BROWSER_FRAME_MESSAGE_BYTES);
  const exactDraft = exactPayload("browser.draft.result", "content", MAX_BROWSER_DRAFT_MESSAGE_BYTES);
  assert.equal(fitsRemoteOutboundPayload(frame), true);
  assert.equal(fitsRemoteOutboundPayload(draft), true);
  assert.equal(fitsRemoteOutboundPayload(generic), false);
  assert.equal(Buffer.byteLength(exactFrame), MAX_BROWSER_FRAME_MESSAGE_BYTES);
  assert.equal(Buffer.byteLength(exactDraft), MAX_BROWSER_DRAFT_MESSAGE_BYTES);
  assert.equal(fitsRemoteOutboundPayload(exactFrame), true);
  assert.equal(fitsRemoteOutboundPayload(exactDraft), true);
  assert.equal(fitsRemoteOutboundPayload(`${exactFrame} `), false);
  assert.equal(fitsRemoteOutboundPayload(`${exactDraft} `), false);
  assert.equal(isHostMessage({ type: "conn.send", connId, payload: frame }), true);
  assert.equal(fitsRemoteIpc({ type: "conn.send", connId, payload: frame }), true);
  assert.equal(fitsRemoteOutboundPayload(JSON.stringify({ type: "browser.frame",
    jpeg: "A".repeat(MAX_BROWSER_FRAME_MESSAGE_BYTES) })), false);
  assert.equal(fitsRemoteOutboundPayload(JSON.stringify({ type: "browser.draft.result",
    content: "A".repeat(MAX_BROWSER_DRAFT_MESSAGE_BYTES) })), false);
});

test("양방향 IPC 큐는 send false 뒤 콜백까지 멈추고 연결별 한도를 센다", () => {
  for (const [name, makeQueue] of [
    ["host", (options) => createHostIpcQueue({ ...options, totalLimit: 10_000 })],
    ["gateway", (options) => createGatewayIpcQueue(options)],
  ]) {
    const sent = [];
    const callbacks = [];
    const overflow = [];
    const queue = makeQueue({
      maximumPerConnection: 90,
      perConnectionLimit: 90,
      send(message, callback) { sent.push(message); callbacks.push(callback); return sent.length !== 1; },
      onOverflow: (key) => overflow.push(key),
      onConnectionOverflow: (key) => overflow.push(key),
      onFailure(error) { assert.fail(`${name}: ${error.message}`); },
    });
    assert.equal(queue.enqueue({ type: "one", value: "x".repeat(20) }, "conn"), true);
    assert.equal(queue.enqueue({ type: "two", value: "x".repeat(20) }, "other"), true);
    assert.equal(sent.length, 1, name);
    callbacks.shift()(null);
    assert.equal(sent.length, 2, name);
    callbacks.shift()(null);
    assert.equal(queue.enqueue({ type: "big", value: "x".repeat(70) }, "limited"), false);
    assert.deepEqual(overflow, ["limited"], name);
  }
});

test("IPC 송신 콜백 오류와 전체 대기량 초과는 실패로 처리한다", () => {
  const failures = [];
  const callbacks = [];
  const queue = createHostIpcQueue({
    totalLimit: 120,
    perConnectionLimit: 1_000,
    send(_message, callback) { callbacks.push(callback); return false; },
    onFailure: (error) => failures.push(error.message),
  });
  queue.enqueue({ type: "one", value: "x".repeat(20) }, "a");
  queue.enqueue({ type: "two", value: "x".repeat(70) }, "b");
  assert.deepEqual(failures, ["ipc-total-backpressure"]);

  const callbackFailures = [];
  const callbackQueue = createHostIpcQueue({
    send(_message, callback) { callbacks.push(callback); return true; },
    onFailure: (error) => callbackFailures.push(error.message),
  });
  callbackQueue.enqueue({ type: "message" }, "c");
  callbacks.at(-1)(new Error("write failed"));
  assert.deepEqual(callbackFailures, ["write failed"]);
});

test("RPC 호스트는 모르는 connId와 닫힌 connId를 무시하고 인증 전 프레임을 닫는다", async () => {
  const audit = [];
  const harness = hostHarness({ onAudit: (event) => audit.push(event) });
  const child = await listen(harness);
  const unknown = "9".repeat(32);
  child.emit("message", { type: "conn.frame", connId: unknown, payload: "ignored" });
  assert.equal(harness.host.status().connections, 0);
  const connId = await openConnection(harness, child);
  assert.equal(harness.host.status().connections, 1);
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "terminal.input", rid: "no-pin", agent: "a".repeat(32), text: "whoami" }) });
  await Promise.resolve();
  assert.equal(harness.host.status().connections, 0);
  const closes = child.sent.filter((message) => message.type === "conn.close" && message.connId === connId);
  assert.equal(closes.length, 1);
  child.emit("message", { type: "conn.frame", connId, payload: "closed" });
  assert.equal(child.sent.filter((message) => message.type === "conn.close" && message.connId === connId).length, 1);
  assert.ok(audit.some((event) => event.type === "conn.ignored" && event.connId === unknown));
});

for (const type of ["terminal.select", "terminal.mouse"]) {
  test(`미등록·PIN 전 연결의 ${type}은 터미널 조작 전에 거절`, async () => {
    let invoked = false;
    const harness = hostHarness({ operations: { table: new Map([[type, async () => { invoked = true; }]]), closeConnection() {}, close() {} } });
    const child = await listen(harness);
    const connId = await openConnection(harness, child);
    child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type, rid: "touch", agent: "a".repeat(32), hash: "b".repeat(64), columns: 87, rows: 44, row: 2,
      ...(type === "terminal.mouse" ? { column: 12, action: "click" } : {}) }) });
    await Promise.resolve();
    assert.equal(invoked, false);
    assert.equal(harness.host.status().connections, 0);
    harness.host.stop();
  });
}

test("RPC 호스트도 connId별 인증 전 초당 다섯 프레임만 받는다", async () => {
  const frames = [];
  const harness = hostHarness({ onFrame: (connection, payload) => frames.push([connection.connId, payload]) });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  for (let index = 0; index < 6; index++) child.emit("message", { type: "conn.frame", connId, payload: `frame-${index}` });
  await Promise.resolve();
  assert.equal(frames.length, 5);
  assert.equal(harness.host.status().connections, 0);
  assert.ok(child.sent.some((message) => message.type === "conn.close" && message.reason === "rate-limit"));
});

test("RPC 호스트는 챌린지만 먼저 보내고 인증 뒤 caps와 표준 오류만 보낸다", async () => {
  const sessions = new Set();
  const admissions = [];
  const auth = {
    open(connection) {
      assert.equal(connection.certHash, CERT_HASH);
      return { ok: true, challenge: {
        serverInstance: SERVER_INSTANCE, connId: connection.connId, nonce: "7".repeat(64), certHash: CERT_HASH,
      } };
    },
    authenticate(connId, response) {
      if (response?.type !== "auth.response") return { ok: false, error: "forbidden" };
      sessions.add(connId);
      return { ok: true, resumeToken: "a".repeat(43), pinIdleMinutes: 30 };
    },
    beginRequest(_connId, request) {
      admissions.push(request);
      return { ok: true };
    },
    endRequest: () => true,
    close: (connId) => sessions.delete(connId),
    activeBlocks: () => [],
  };
  const harness = hostHarness({ auth });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  assert.deepEqual(projected(child, connId).map((message) => message.type), ["auth.challenge"]);
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({
    type: "auth.response", v: "remote/1", deviceId: "d", signature: "MAACAQA=",
  }) });
  await Promise.resolve();
  assert.ok(child.sent.some((message) => message.type === "conn.authenticated" && message.connId === connId));
  assert.deepEqual(projected(child, connId).map((message) => message.type), ["auth.challenge", "auth.ok"]);

  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "caps.get" }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "future.request" }) });
  await Promise.resolve();
  await Promise.resolve();
  const responses = projected(child, connId).slice(2);
  assert.ok(responses.some((message) => message.type === "caps" && message.remoteRpc === "remote/1"
    && REQUESTS.every((name) => message.requests.includes(name))
    && message.requests.every((name) => REMOTE_REQUEST_TYPES.includes(name))));
  assert.ok(responses.some((message) => message.type === "error" && message.error.code === "unsupported-request"));

  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "p1" }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "p-active", active: true }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "p2", extra: true }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "bad rid" }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "agent.stop", rid: "s1", agent: "f".repeat(32) }) });
  await Promise.resolve();
  await Promise.resolve();
  const operationResponses = projected(child, connId);
  assert.ok(operationResponses.some((message) => message.type === "pong" && message.rid === "p1"));
  assert.ok(operationResponses.some((message) => message.type === "pong" && message.rid === "p-active"));
  assert.ok(operationResponses.some((message) => message.type === "error" && message.rid === "p2"
    && message.error.code === "invalid-request"));
  assert.ok(operationResponses.some((message) => message.type === "error" && !("rid" in message)
    && message.error.code === "invalid-request"));
  assert.ok(operationResponses.some((message) => message.type === "error" && message.rid === "s1"
    && message.error.code === "forbidden"));
  assert.deepEqual(admissions, [
    { activity: true },
    { activity: false },
    { activity: false },
    { activity: true },
    { activity: false },
    { activity: false },
    { activity: true },
  ]);

  const sentBeforeStop = child.sent.length;
  harness.host.stop();
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "after" }) });
  await Promise.resolve();
  assert.equal(child.sent.length, sentBeforeStop, "원격 중지 뒤에는 응답을 보내지 않는다");
});

test("64 KiB 초과 터미널은 부분 화면 대신 사유를 보내고 큰 목록은 거절한다", async () => {
  const auth = {
    open: (connection) => ({ ok: true, challenge: {
      serverInstance: SERVER_INSTANCE, connId: connection.connId, nonce: "7".repeat(64), certHash: CERT_HASH,
    } }),
    authenticate: () => ({ ok: true, resumeToken: "a".repeat(43), pinIdleMinutes: 30 }),
    beginRequest: () => ({ ok: true }), endRequest: () => true,
    close: () => true, activeBlocks: () => [],
  };
  const operations = { table: new Map([["ping", async (_entry, message) => message.rid === "large"
    ? { type: "terminal.watch.result", rid: message.rid, agent: "a".repeat(32), revision: 1,
      text: "\"".repeat(49_000), truncated: false }
    : { type: "browser.record.result", rid: message.rid, state: "recording",
      steps: Array.from({ length: 200 }, () => "한".repeat(500)), elapsedMs: 0 }]]), closeConnection() {}, close() {} };
  const harness = hostHarness({ auth, operations });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "auth.response" }) });
  for (let index = 0; index < 6; index++) await Promise.resolve();
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "large" }) });
  for (let index = 0; index < 6; index++) await Promise.resolve();
  const result = projected(child, connId).at(-1);
  assert.equal(result.type, "terminal.watch.result");
  assert.equal(result.rid, "large");
  assert.equal(result.truncated, false);
  assert.equal(result.text, "");
  assert.equal(result.error, "terminal-frame-too-large");
  const sent = child.sent.findLast((message) => message.type === "conn.send" && message.connId === connId);
  assert.ok(Buffer.byteLength(sent.payload, "utf8") <= MAX_REMOTE_FRAME_BYTES);
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "ping", rid: "large-list" }) });
  for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(projected(child, connId).at(-1), {
    type: "error", rid: "large-list", error: { code: "limit-exceeded" },
  });
  harness.host.stop();
});

test("RPC 호스트는 busy를 projection 오류로 보내고 처리표에서 caps를 만든다", async () => {
  let busy = true;
  const auth = {
    open: (connection) => ({ ok: true, challenge: {
      serverInstance: SERVER_INSTANCE, connId: connection.connId, nonce: "7".repeat(64), certHash: CERT_HASH,
    } }),
    authenticate: () => ({ ok: true, resumeToken: "a".repeat(43), pinIdleMinutes: 30 }),
    beginRequest: () => busy ? { ok: false, error: "busy", close: false } : { ok: true },
    endRequest: () => true,
    close: () => true,
    activeBlocks: () => [],
  };
  const harness = hostHarness({ auth });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "auth.response" }) });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "caps.get" }) });
  await Promise.resolve();
  assert.deepEqual(projected(child, connId).at(-1), { type: "error", error: { code: "busy" } });
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "caps.get", rid: "r-busy" }) });
  await Promise.resolve();
  assert.deepEqual(projected(child, connId).at(-1), { type: "error", rid: "r-busy", error: { code: "busy" } });
  busy = false;
  child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify({ type: "caps.get" }) });
  await Promise.resolve();
  await Promise.resolve();
  const caps = projected(child, connId).at(-1);
  assert.equal(caps.type, "caps");
  assert.equal(caps.remoteRpc, "remote/1");
  assert.deepEqual(caps.requests.slice(0, REQUESTS.length), REQUESTS);
  assert.ok(caps.requests.includes("browser.tabs"));
  assert.equal(caps.requests.includes("terminal.watch"), false);
});

test("다섯 번째 인증 실패 차단 통지는 게이트웨이에만 일반 사유로 전달한다", async () => {
  const until = 1_800_000;
  const auth = {
    open: (connection) => ({ ok: true, challenge: {
      serverInstance: SERVER_INSTANCE, connId: connection.connId, nonce: "7".repeat(64), certHash: CERT_HASH,
    } }),
    authenticate: () => ({ ok: false, error: "forbidden", blockedUntil: until }),
    close: () => true,
    activeBlocks: () => [],
  };
  const harness = hostHarness({ auth });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  child.emit("message", { type: "conn.frame", connId, payload: "{}" });
  await Promise.resolve();
  assert.ok(child.sent.some((message) => message.type === "ip.block"
    && message.peerIp === "100.64.2.3" && message.blockedUntil === until));
  assert.ok(child.sent.some((message) => message.type === "conn.close"
    && message.connId === connId && message.reason === "authentication-rejected"));
});

test("이전 세대 connId는 재기동 뒤 폐기된다", async () => {
  const harness = hostHarness();
  const first = await listen(harness);
  const connId = await openConnection(harness, first);
  first.emit("exit", 1);
  assert.equal(harness.host.status().connections, 0);
  assert.equal(harness.timers.runNext(), 1_000);
  const second = harness.children.at(-1);
  second.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  second.emit("message", { type: "listening", address: "100.64.1.2", port: 4292, certHash: CERT_HASH });
  second.emit("message", { type: "conn.frame", connId, payload: "old" });
  assert.equal(harness.host.status().connections, 0);
  assert.equal(second.kills, 0);
});

test("게이트웨이 세대 교체는 인증 소유자의 이전 세션도 폐기한다", async () => {
  const closed = [];
  const auth = {
    open: (connection) => ({ ok: true, challenge: {
      serverInstance: SERVER_INSTANCE, connId: connection.connId, nonce: "7".repeat(64), certHash: CERT_HASH,
    } }),
    close(connId) { closed.push(connId); return true; },
    activeBlocks: () => [],
  };
  const harness = hostHarness({ auth });
  const child = await listen(harness);
  const connId = await openConnection(harness, child);
  child.emit("exit", 1);
  assert.deepEqual(closed, [connId]);
  assert.equal(harness.host.status().connections, 0);
  harness.host.stop();
});

test("hello 불일치와 게이트웨이 판정 필드 주입과 IPC 크기 초과는 자식을 종료한다", async () => {
  for (const bad of [
    { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: "f".repeat(32) },
    { type: "conn.open", gwSeq: 1, peerIp: "100.64.2.3", nodeId: "node", certHash: CERT_HASH, verified: true },
    { type: "conn.frame", connId: "3".repeat(32), payload: "x".repeat(80 * 1024) },
  ]) {
    const harness = hostHarness();
    const starting = harness.host.start(configuration());
    starting.catch(() => {});
    const child = harness.children[0];
    if (bad.type !== "hello") {
      child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
      await Promise.resolve();
    }
    child.emit("message", bad);
    assert.equal(child.kills, 1, bad.type);
    assert.equal(harness.host.status().restartScheduled, true, bad.type);
    harness.host.stop();
  }
});

test("게이트웨이가 보고한 수신 주소와 포트는 설정과 같아야 한다", async () => {
  const harness = hostHarness();
  const starting = harness.host.start(configuration());
  starting.catch(() => {});
  const child = harness.children[0];
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  child.emit("message", { type: "listening", address: "100.64.1.2", port: 4293, certHash: CERT_HASH });
  assert.equal(child.kills, 1);
  assert.equal(harness.host.status().restartScheduled, true);
  harness.host.stop();
});

test("재기동은 1·2·4·8초 뒤 실행하고 5분 안 5회 실패하면 알린다", async () => {
  const limits = [];
  const harness = hostHarness({ onFailureLimit: (value) => limits.push(value) });
  const starting = harness.host.start(configuration());
  const observed = [];
  for (let index = 0; index < 5; index++) {
    harness.children.at(-1).emit("exit", 1);
    if (index < 4) observed.push(harness.timers.runNext());
  }
  assert.deepEqual(observed, [1_000, 2_000, 4_000, 8_000]);
  await assert.rejects(starting, /gateway-restart-limit/);
  assert.equal(limits.length, 1);
  assert.equal(harness.host.status().active, false);
});

test("자식 send 콜백 오류는 게이트웨이 재기동을 예약한다", async () => {
  const harness = hostHarness();
  const starting = harness.host.start(configuration());
  starting.catch(() => {});
  const child = harness.children[0];
  child.callbackErrors.push(new Error("callback failed"));
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(child.kills, 1);
  assert.equal(harness.host.status().restartScheduled, true);
  harness.host.stop();
});

test("RPC 호스트 중지는 자식과 연결을 동기로 없애고 listener를 누적하지 않는다", async () => {
  const harness = hostHarness();
  const child = await listen(harness);
  await openConnection(harness, child);
  assert.equal(harness.host.stop(), true);
  assert.equal(harness.host.status().connections, 0);
  assert.equal(child.kills, 1);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("자식 kill이 실패하면 참조를 보존해 중지를 다시 시도한다", async () => {
  const harness = hostHarness();
  const child = await listen(harness);
  child.killResults.push(false, true);
  assert.equal(harness.host.stop(), false);
  assert.equal(harness.host.status().child, true);
  assert.equal(child.connected, true);
  assert.equal(harness.host.stop(), true);
  assert.equal(harness.host.status().child, false);
  assert.equal(child.kills, 2);
});

test("프로토콜 오류 중 kill이 실패하면 이전 자식을 보존하고 재기동하지 않는다", async () => {
  const terminal = [];
  const harness = hostHarness({ onFailureLimit: (event) => terminal.push(event) });
  const child = await listen(harness);
  child.killResults.push(false, true);
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  assert.equal(child.kills, 1);
  assert.equal(child.connected, true);
  assert.equal(harness.host.status().child, true);
  assert.equal(harness.host.status().restartScheduled, false);
  assert.deepEqual(terminal, [{ code: "gateway-stop-failed", reason: "duplicate-hello" }]);
  assert.equal(harness.host.stop(), true);
  assert.equal(child.kills, 2);
});

test("이전 자식의 늦은 IPC 콜백은 새 자식을 종료하지 않는다", async () => {
  const harness = hostHarness();
  const starting = harness.host.start(configuration());
  starting.catch(() => {});
  const first = harness.children[0];
  first.deferCallbacks = true;
  first.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  assert.equal(first.callbacks.length, 1);
  first.emit("exit", 1);
  harness.timers.runNext();
  const second = harness.children[1];
  second.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  second.emit("message", { type: "listening", address: "100.64.1.2", port: 4292, certHash: CERT_HASH });
  await starting;
  first.callbacks.shift()(new Error("late callback"));
  assert.equal(second.kills, 0);
  assert.equal(harness.host.status().generation, 2);
  assert.equal(harness.host.status().restartScheduled, false);
  harness.host.stop();
});

test("실제 게이트웨이 자식은 hello를 먼저 보내고 IPC disconnect에 즉시 종료한다", async (t) => {
  const entry = fileURLToPath(new URL("../server/remote/gateway/child.js", import.meta.url));
  const child = fork(entry, [SERVER_INSTANCE], { serialization: "json", stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const hello = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  assert.deepEqual(hello, { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.disconnect();
  const code = await exited;
  assert.equal(code, 0);
});
