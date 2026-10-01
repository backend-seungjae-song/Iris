import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  connectionSignatureBytes,
  isAuthResponse,
  isPairRequest,
  isPinSubmit,
  isRemoteOutbound,
} from "../server/remote/contract/connection.js";
import { canonicalBytes } from "../server/remote/contract/jcs.js";
import { createConnectionAuth } from "../server/remote/auth.js";

const SERVER_INSTANCE = "1".repeat(32);
const CERT_HASH = "2".repeat(64);
const DEVICE_ID = "3".repeat(32);
const CONN_ID = "4".repeat(32);
const OTHER_CONN_ID = "5".repeat(32);
const PEER_IP = "100.64.2.3";
const NODE_ID = "node-stable-id";

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...pair,
    spki: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function fakeClock() {
  let value = 1_000;
  const timers = [];
  return {
    now: () => value,
    advance(amount) { value += amount; },
    setTimer(fn, delay) {
      const timer = { fn, at: value + delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    runDue() {
      for (const timer of timers.filter((item) => !item.cleared && item.at <= value)) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

function fixture(overrides = {}) {
  const connectionKey = overrides.connectionKey || keyPair();
  const clock = overrides.clock || fakeClock();
  const closed = [];
  const blocked = [];
  let enabled = overrides.enabled ?? true;
  let nonceByte = 7;
  const device = {
    deviceId: DEVICE_ID,
    name: "Galaxy",
    connKey: connectionKey.spki,
    nodeId: overrides.nodeId || NODE_ID,
    addedAt: 1_000,
  };
  const auth = createConnectionAuth({
    serverInstance: SERVER_INSTANCE,
    getCertificateHash: () => overrides.certHash || CERT_HASH,
    getDevice: overrides.getDevice || ((deviceId) => deviceId === DEVICE_ID && !overrides.missing
      ? structuredClone(device) : null),
    isRemoteEnabled: () => enabled,
    verifyPin: overrides.verifyPin || (async (pin) => pin === "123456"
      ? { ok: true } : { ok: false, error: "incorrect", retryAfterMs: 1_000 }),
    getIdleMs: overrides.getIdleMs,
    now: clock.now,
    randomBytes: () => Buffer.alloc(32, nonceByte++),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: (connId, reason) => closed.push([connId, reason]),
    onThrottle: (peerIp, blockedUntil) => blocked.push([peerIp, blockedUntil]),
  });
  function open(connId = CONN_ID, extra = {}) {
    return auth.open({ connId, peerIp: PEER_IP, nodeId: NODE_ID, certHash: CERT_HASH, ...extra });
  }
  function response(challenge, privateKey = connectionKey.privateKey, changes = {}) {
    const signed = {
      domain: "iris-remote-conn/1",
      v: 1,
      serverInstance: SERVER_INSTANCE,
      connId: challenge.connId,
      deviceId: DEVICE_ID,
      nonce: challenge.nonce,
      certHash: CERT_HASH,
      ...(changes.signed || {}),
    };
    return {
      type: "auth.response",
      v: "remote/1",
      deviceId: changes.deviceId || DEVICE_ID,
      signature: sign("sha256", isAuthResponseTarget(signed) ? connectionSignatureBytes(signed) : canonicalBytes(signed), {
        key: privateKey, dsaEncoding: "der",
      }).toString("base64"),
      ...(changes.response || {}),
    };
  }
  return { auth, clock, closed, blocked, device, connectionKey, open, response, setEnabled(value) { enabled = value; } };
}

async function establish(value, connId, response, pin = "123456") {
  const authenticated = value.auth.authenticate(connId, response);
  if (!authenticated.ok) return authenticated;
  assert.equal(authenticated.pinRequired, true);
  return value.auth.submitPin(connId, { type: "pin.submit", v: "remote/1", pin });
}

function isAuthResponseTarget(value) {
  try {
    connectionSignatureBytes(value);
    return true;
  } catch {
    return false;
  }
}

test("연결 계약은 정확한 인증 응답과 원격 출력만 받는다", () => {
  const valid = { type: "auth.response", v: "remote/1", deviceId: DEVICE_ID, signature: "MAACAQA=" };
  assert.equal(isAuthResponse(valid), true);
  assert.equal(isAuthResponse({ ...valid, reason: "internal" }), false);
  assert.equal(isPinSubmit({ type: "pin.submit", v: "remote/1", pin: "123456" }), true);
  assert.equal(isPinSubmit({ type: "pin.submit", v: "remote/1", pin: "123456", extra: true }), false);
  assert.equal(isPinSubmit({ type: "pin.submit", v: "remote/1", pin: "12345" }), false);
  assert.equal(isRemoteOutbound({ type: "auth.ok", v: "remote/1",
    resumeToken: "a".repeat(43), pinIdleMinutes: 30 }), true);
  assert.equal(isRemoteOutbound({ type: "auth.ok", v: "remote/1" }), false);
  assert.equal(isRemoteOutbound({ type: "pin.required", v: "remote/1" }), true);
  assert.equal(isRemoteOutbound({ type: "pin.error", v: "remote/1", reason: "incorrect", retryAfterMs: 1_000 }), true);
  assert.equal(isRemoteOutbound({ type: "service.status", v: "remote/1", reason: "pin-required" }), true);
  assert.equal(isRemoteOutbound({ type: "service.status", v: "remote/1", reason: "sharing-disabled" }), true);
  assert.equal(isRemoteOutbound({ type: "service.status", v: "remote/1", reason: "registry-invalid" }), false);
  assert.equal(isRemoteOutbound({ type: "caps", remoteRpc: "remote/1", macName: "MacBook Pro", requests: ["caps.get"] }), true);
  assert.equal(isRemoteOutbound({ type: "error", error: { code: "busy" } }), true);
  assert.equal(isRemoteOutbound({ type: "error", error: { code: "stack" } }), false);
  const pair = { type: "pair.request", v: "remote/1", secret: "a".repeat(43),
    connKey: fixture().connectionKey.spki, name: "Galaxy" };
  assert.equal(isPairRequest(pair), true);
  assert.equal(isPairRequest({ ...pair, name: "Galaxy\nS" }), false);
  assert.equal(isPairRequest({ ...pair, connKey: `${pair.connKey}=` }), false);
  assert.equal(isRemoteOutbound({ type: "pair.pending", v: "remote/1", deviceId: DEVICE_ID, code: "012345" }), true);
  assert.equal(isRemoteOutbound({ type: "pair.pending", v: "remote/1", deviceId: DEVICE_ID, code: "12345" }), false);
});

test("등록 기기 서명과 PIN을 차례로 확인한다", async () => {
  const value = fixture();
  const opened = value.open();
  assert.equal(opened.ok, true);
  assert.equal(opened.challenge.type, "auth.challenge");
  assert.equal((await establish(value, CONN_ID, value.response(opened.challenge))).ok, true);
  assert.deepEqual(value.auth.get(CONN_ID), {
    valid: true,
    connId: CONN_ID,
    deviceId: DEVICE_ID,
    peerIp: PEER_IP,
    nodeId: NODE_ID,
    authenticatedAt: 1_000,
    lastActivityAt: 1_000,
  });
  assert.equal(value.auth.authenticate(CONN_ID, value.response(opened.challenge)).ok, false);
});

test("PIN 통과 전 요청과 형식이 틀린 PIN을 거부하고 틀린 PIN은 재시도를 제한한다", async () => {
  const value = fixture();
  const opened = value.open();
  const authenticated = value.auth.authenticate(CONN_ID, value.response(opened.challenge));
  assert.deepEqual(authenticated, { ok: true, pinRequired: true });
  assert.deepEqual(value.auth.beginRequest(CONN_ID), { ok: false, error: "forbidden", close: true });

  const retry = fixture();
  const retryOpened = retry.open();
  retry.auth.authenticate(CONN_ID, retry.response(retryOpened.challenge));
  assert.deepEqual(await retry.auth.submitPin(CONN_ID, {
    type: "pin.submit", v: "remote/1", pin: "000000",
  }), { ok: false, error: "incorrect", retryAfterMs: 1_000 });
  assert.equal(retry.auth.get(CONN_ID), null);
});

test("서명 대상의 모든 필드 변조와 다른 키와 DER 오류를 거부한다", () => {
  const fields = {
    domain: "wrong",
    v: 2,
    serverInstance: "f".repeat(32),
    connId: OTHER_CONN_ID,
    deviceId: "6".repeat(32),
    nonce: "8".repeat(64),
    certHash: "9".repeat(64),
  };
  for (const [field, changed] of Object.entries(fields)) {
    const value = fixture();
    const opened = value.open();
    assert.equal(value.auth.authenticate(CONN_ID, value.response(opened.challenge, value.connectionKey.privateKey, {
      signed: { [field]: changed },
    })).ok, false, field);
  }
  const different = fixture();
  const otherKey = keyPair();
  const challenge = different.open().challenge;
  assert.equal(different.auth.authenticate(CONN_ID, different.response(challenge, otherKey.privateKey)).ok, false);

  const malformed = fixture();
  const malformedChallenge = malformed.open().challenge;
  assert.equal(malformed.auth.authenticate(CONN_ID, {
    ...malformed.response(malformedChallenge), signature: Buffer.alloc(64, 1).toString("base64"),
  }).ok, false);
});

test("미등록·원격 꺼짐·노드·인증서 불일치를 거부한다", () => {
  for (const options of [
    { missing: true },
    { enabled: false },
    { nodeId: "other-node" },
    { certHash: "a".repeat(64) },
  ]) {
    const value = fixture(options);
    const opened = value.open();
    if (!opened.ok) continue;
    assert.equal(value.auth.authenticate(CONN_ID, value.response(opened.challenge)).ok, false, JSON.stringify(options));
  }
});

test("챌린지는 60초에 만료되고 재사용하거나 다른 connId에서 쓸 수 없다", () => {
  const expired = fixture();
  const expiredChallenge = expired.open().challenge;
  expired.clock.advance(60_000);
  expired.clock.runDue();
  assert.deepEqual(expired.closed, [[CONN_ID, "authentication-timeout"]]);
  assert.equal(expired.auth.authenticate(CONN_ID, expired.response(expiredChallenge)).ok, false);

  const crossed = fixture();
  const first = crossed.open().challenge;
  crossed.open(OTHER_CONN_ID);
  const crossedResponse = crossed.response(first, crossed.connectionKey.privateKey, { signed: { connId: OTHER_CONN_ID } });
  assert.equal(crossed.auth.authenticate(OTHER_CONN_ID, crossedResponse).ok, false);
  assert.equal(crossed.auth.authenticate(CONN_ID, crossed.response(first)).ok, true);
});

test("10분 안 인증 실패 다섯 번 뒤 IP를 30분 차단하고 만료 뒤 허용한다", () => {
  const value = fixture();
  for (let index = 0; index < 5; index++) {
    const connId = index.toString(16).padStart(32, "a");
    const opened = value.open(connId);
    assert.equal(opened.ok, true);
    const response = value.response(opened.challenge, keyPair().privateKey, { signed: { connId } });
    assert.equal(value.auth.authenticate(connId, response).ok, false);
  }
  assert.equal(value.blocked.length, 1);
  assert.equal(value.open(OTHER_CONN_ID).ok, false);
  value.clock.advance(30 * 60_000);
  assert.equal(value.open(OTHER_CONN_ID).ok, true);
});

test("인증 세션은 전체 6개와 기기당 2개를 넘지 않는다", async () => {
  const perDevice = fixture();
  for (let index = 0; index < 2; index++) {
    const connId = (index + 1).toString(16).padStart(32, "b");
    const challenge = perDevice.open(connId).challenge;
    assert.equal((await establish(perDevice, connId, perDevice.response(challenge, perDevice.connectionKey.privateKey, {
      signed: { connId },
    }))).ok, true);
  }
  const thirdId = "c".repeat(32);
  const third = perDevice.open(thirdId).challenge;
  assert.equal(perDevice.auth.authenticate(thirdId, perDevice.response(third, perDevice.connectionKey.privateKey, {
    signed: { connId: thirdId },
  })).error, "limit-exceeded");
});

test("서로 다른 기기라도 인증 세션은 전체 6개를 넘지 않는다", async () => {
  const pair = keyPair();
  const clock = fakeClock();
  let nonce = 1;
  const auth = createConnectionAuth({
    serverInstance: SERVER_INSTANCE,
    getCertificateHash: () => CERT_HASH,
    getDevice: (deviceId) => ({
      deviceId,
      name: `Device ${deviceId}`,
      connKey: pair.spki,
      nodeId: NODE_ID,
      addedAt: 1_000,
    }),
    isRemoteEnabled: () => true,
    verifyPin: async () => ({ ok: true }),
    now: clock.now,
    randomBytes: () => Buffer.alloc(32, nonce++),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  for (let index = 0; index < 7; index++) {
    const connId = (index + 1).toString(16).padStart(32, "d");
    const deviceId = (index + 1).toString(16).padStart(32, "e");
    const challenge = auth.open({ connId, peerIp: `100.64.2.${index + 1}`, nodeId: NODE_ID, certHash: CERT_HASH }).challenge;
    const target = {
      domain: "iris-remote-conn/1", v: 1, serverInstance: SERVER_INSTANCE,
      connId, deviceId, nonce: challenge.nonce, certHash: CERT_HASH,
    };
    const result = auth.authenticate(connId, {
      type: "auth.response", v: "remote/1", deviceId,
      signature: sign("sha256", connectionSignatureBytes(target), {
        key: pair.privateKey, dsaEncoding: "der",
      }).toString("base64"),
    });
    assert.equal(result.ok, index < 6, String(index));
    if (index === 6) assert.equal(result.error, "limit-exceeded");
    else assert.equal((await auth.submitPin(connId, {
      type: "pin.submit", v: "remote/1", pin: "123456",
    })).ok, true);
  }
});

test("PIN 기한은 마지막 사용부터 30분이며 활동하면 갱신되고 백그라운드 ping은 갱신하지 않는다", async () => {
  const idle = fixture();
  const challenge = idle.open().challenge;
  await establish(idle, CONN_ID, idle.response(challenge));
  idle.clock.advance(30 * 60_000);
  idle.clock.runDue();
  assert.deepEqual(idle.closed, [[CONN_ID, "idle-timeout"]]);

  const active = fixture();
  const activeChallenge = active.open().challenge;
  await establish(active, CONN_ID, active.response(activeChallenge));
  for (let index = 0; index < 3; index++) {
    active.clock.advance((30 * 60_000) - 1);
    assert.equal(active.auth.beginRequest(CONN_ID, { activity: true }).ok, true);
    active.auth.endRequest(CONN_ID);
    active.clock.runDue();
  }
  assert.equal(active.auth.get(CONN_ID).valid, true);

  const ping = fixture();
  const pingChallenge = ping.open().challenge;
  await establish(ping, CONN_ID, ping.response(pingChallenge));
  ping.clock.advance((30 * 60_000) - 1);
  assert.equal(ping.auth.beginRequest(CONN_ID, { activity: false }).ok, true);
  ping.auth.endRequest(CONN_ID);
  ping.clock.advance(1);
  ping.clock.runDue();
  assert.deepEqual(ping.closed, [[CONN_ID, "idle-timeout"]]);
});

test("재개 토큰은 기기 서명 뒤 한 번만 쓰고 같은 기기의 마지막 사용 시각을 잇는다", async () => {
  const value = fixture();
  const first = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(first));
  const token = established.resumeToken;
  value.clock.advance(5 * 60_000);
  value.auth.close(CONN_ID);

  const resumedChallenge = value.open(OTHER_CONN_ID).challenge;
  const resumed = value.auth.authenticate(OTHER_CONN_ID, value.response(
    resumedChallenge,
    value.connectionKey.privateKey,
    { signed: { connId: OTHER_CONN_ID }, response: { resumeToken: token } },
  ));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.notEqual(resumed.resumeToken, token);
  assert.equal(resumed.session.lastActivityAt, 1_000);

  value.auth.close(OTHER_CONN_ID);
  const replayId = "6".repeat(32);
  const replayChallenge = value.open(replayId).challenge;
  const replay = value.auth.authenticate(replayId, value.response(
    replayChallenge,
    value.connectionKey.privateKey,
    { signed: { connId: replayId }, response: { resumeToken: token } },
  ));
  assert.deepEqual(replay, { ok: true, pinRequired: true });
});

test("다른 등록 기기의 서명으로는 재개 토큰을 쓸 수도 폐기할 수도 없다", async () => {
  const firstKey = keyPair();
  const secondKey = keyPair();
  const secondId = "9".repeat(32);
  const devices = new Map([
    [DEVICE_ID, { deviceId: DEVICE_ID, name: "첫 폰", connKey: firstKey.spki, nodeId: NODE_ID, addedAt: 1 }],
    [secondId, { deviceId: secondId, name: "둘째 폰", connKey: secondKey.spki, nodeId: NODE_ID, addedAt: 2 }],
  ]);
  const value = fixture({ connectionKey: firstKey, getDevice: (id) => devices.get(id) || null });
  const first = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(first));
  value.auth.close(CONN_ID);

  const otherChallenge = value.open(OTHER_CONN_ID).challenge;
  const other = value.auth.authenticate(OTHER_CONN_ID, value.response(
    otherChallenge,
    secondKey.privateKey,
    {
      deviceId: secondId,
      signed: { connId: OTHER_CONN_ID, deviceId: secondId },
      response: { resumeToken: established.resumeToken },
    },
  ));
  assert.deepEqual(other, { ok: true, pinRequired: true });
  value.auth.close(OTHER_CONN_ID);

  const ownerId = "a".repeat(32);
  const ownerChallenge = value.open(ownerId).challenge;
  const owner = value.auth.authenticate(ownerId, value.response(
    ownerChallenge,
    firstKey.privateKey,
    { signed: { connId: ownerId }, response: { resumeToken: established.resumeToken } },
  ));
  assert.equal(owner.resumed, true);
});

test("재개 토큰 실패는 PIN 지수 대기 상태를 지우지 않는다", async () => {
  let calls = 0;
  const value = fixture({ verifyPin: async () => {
    calls++;
    return calls === 1
      ? { ok: false, error: "incorrect", retryAfterMs: 1_000 }
      : { ok: false, error: "retry-later", retryAfterMs: 900 };
  } });
  const first = value.open().challenge;
  value.auth.authenticate(CONN_ID, value.response(first));
  await value.auth.submitPin(CONN_ID, { type: "pin.submit", v: "remote/1", pin: "000000" });
  value.auth.close(CONN_ID);

  const next = value.open(OTHER_CONN_ID).challenge;
  assert.deepEqual(value.auth.authenticate(OTHER_CONN_ID, value.response(
    next,
    value.connectionKey.privateKey,
    { signed: { connId: OTHER_CONN_ID }, response: { resumeToken: "a".repeat(43) } },
  )), { ok: true, pinRequired: true });
  assert.deepEqual(await value.auth.submitPin(OTHER_CONN_ID, {
    type: "pin.submit", v: "remote/1", pin: "000000",
  }), { ok: false, error: "retry-later", retryAfterMs: 900 });
});

test("설정 변경은 연결된 세션과 토큰의 마지막 사용 시각에 바로 적용된다", async () => {
  let idleMs = 60 * 60_000;
  const value = fixture({ getIdleMs: () => idleMs });
  const challenge = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(challenge));
  value.clock.advance(20 * 60_000);
  idleMs = 10 * 60_000;
  assert.deepEqual(value.auth.refreshExpiry(), [CONN_ID]);
  assert.equal(value.auth.get(CONN_ID), null);

  const nextId = "7".repeat(32);
  const nextChallenge = value.open(nextId).challenge;
  const tokenAttempt = value.auth.authenticate(nextId, value.response(
    nextChallenge,
    value.connectionKey.privateKey,
    { signed: { connId: nextId }, response: { resumeToken: established.resumeToken } },
  ));
  assert.deepEqual(tokenAttempt, { ok: true, pinRequired: true });
});

test("기한을 늘려도 이전 기한에 이미 만료된 재개 토큰은 다시 쓸 수 없다", async () => {
  let idleMs = 10 * 60_000;
  const value = fixture({ getIdleMs: () => idleMs });
  const challenge = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(challenge));
  value.auth.close(CONN_ID);
  value.clock.advance(11 * 60_000);
  value.auth.pruneExpiredTokens();
  idleMs = 60 * 60_000;
  const nextId = "7".repeat(32);
  const nextChallenge = value.open(nextId).challenge;
  assert.deepEqual(value.auth.authenticate(nextId, value.response(
    nextChallenge,
    value.connectionKey.privateKey,
    { signed: { connId: nextId }, response: { resumeToken: established.resumeToken } },
  )), { ok: true, pinRequired: true });
});

test("서버는 평균 초당 10개와 짧은 20개 몰림을 허용하고 초과 요청만 거절한다", async () => {
  const value = fixture();
  const challenge = value.open().challenge;
  await establish(value, CONN_ID, value.response(challenge));
  for (let index = 1; index <= 8; index++) assert.equal(value.auth.beginRequest(CONN_ID).ok, true);
  assert.deepEqual(value.auth.beginRequest(CONN_ID), { ok: false, error: "busy", close: false });
  for (let index = 1; index <= 8; index++) value.auth.endRequest(CONN_ID);
  for (let index = 9; index <= 20; index++) {
    assert.equal(value.auth.beginRequest(CONN_ID).ok, true);
    value.auth.endRequest(CONN_ID);
  }
  assert.deepEqual(value.auth.beginRequest(CONN_ID), { ok: false, error: "limit-exceeded", close: false });
  assert.equal(value.auth.get(CONN_ID).valid, true);
  value.clock.advance(100);
  assert.equal(value.auth.beginRequest(CONN_ID).ok, true);
  value.auth.endRequest(CONN_ID);
});

test("영향 범위 무효화는 해당 기기 세션만 제거한다", async () => {
  const value = fixture();
  const challenge = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(challenge));
  assert.deepEqual(value.auth.invalidate({ scope: "device", deviceId: DEVICE_ID }), [CONN_ID]);
  assert.equal(value.auth.get(CONN_ID), null);
  const next = value.open(OTHER_CONN_ID).challenge;
  const resumed = value.auth.authenticate(OTHER_CONN_ID, value.response(
    next,
    value.connectionKey.privateKey,
    { signed: { connId: OTHER_CONN_ID }, response: { resumeToken: established.resumeToken } },
  ));
  assert.deepEqual(resumed, { ok: true, pinRequired: true });
});

test("전체 무효화는 PIN 변경 전의 챌린지와 재개 토큰을 제거한다", async () => {
  const value = fixture();
  const challenge = value.open().challenge;
  const established = await establish(value, CONN_ID, value.response(challenge));
  assert.deepEqual(value.auth.invalidate({ scope: "all" }), [CONN_ID]);
  assert.equal(value.auth.authenticate(CONN_ID, {}).ok, false);

  const next = value.open(OTHER_CONN_ID).challenge;
  const resumed = value.auth.authenticate(OTHER_CONN_ID, value.response(
    next,
    value.connectionKey.privateKey,
    { signed: { connId: OTHER_CONN_ID }, response: { resumeToken: established.resumeToken } },
  ));
  assert.deepEqual(resumed, { ok: true, pinRequired: true });
});
