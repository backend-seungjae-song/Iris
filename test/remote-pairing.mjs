import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConnectionAuth } from "../server/remote/auth.js";
import { connectionSignatureBytes } from "../server/remote/contract/connection.js";
import { REMOTE_RPC_VERSION } from "../server/remote/contract/ipc.js";
import { createRemoteLifecycle } from "../server/remote/index.js";
import { createPairing } from "../server/remote/pairing.js";
import { createRegistry } from "../server/remote/registry.js";
import { createRemoteRpcHost } from "../server/remote/rpc-host.js";

const SERVER_INSTANCE = "1".repeat(32);
const CERT_HASH = "2".repeat(64);
const ADDRESS = "100.64.1.2";
const PEER_IP = "100.64.2.3";
const NODE_ID = "node-stable-id";

function keyPair(namedCurve = "prime256v1") {
  const pair = generateKeyPairSync("ec", { namedCurve });
  return { ...pair, spki: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

function fakeClock() {
  let value = 1_000;
  const timers = [];
  return {
    now: () => value,
    advance(amount) { value += amount; },
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    timers,
  };
}

function pairingFixture(overrides = {}) {
  const clock = overrides.clock || fakeClock();
  const changes = [];
  const encoded = [];
  let random = 1;
  const pairing = createPairing({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    randomBytes: (size) => Buffer.alloc(size, random++),
    randomInt: () => 12_345,
    encode(text) {
      encoded.push(text);
      return { size: 2, data: [[true, false], [false, true]] };
    },
    onChange: (value) => changes.push(structuredClone(value)),
    ...overrides,
  });
  function start() {
    assert.deepEqual(pairing.start({ address: ADDRESS, port: 4292, certHash: CERT_HASH }), { ok: true });
    return JSON.parse(encoded.at(-1));
  }
  return { pairing, clock, changes, encoded, start };
}

function request(secret, connKey, name = "Galaxy") {
  return { type: "pair.request", v: REMOTE_RPC_VERSION, secret, connKey, name };
}

test("페어링은 QR 공개 상태만 내보내고 새 시작이 이전 비밀을 폐기한다", () => {
  const pair = keyPair();
  const value = pairingFixture();
  const first = value.start();
  assert.deepEqual(Object.keys(first), ["t", "v", "address", "port", "certHash", "secret"]);
  assert.equal(first.t, "iris-remote-pair");
  assert.equal(first.secret.length, 43);
  assert.deepEqual(value.pairing.publicState(), {
    phase: "scan", qr: { size: 2, rows: ["10", "01"] }, expiresAt: 121_000,
  });
  assert.equal(JSON.stringify(value.pairing.publicState()).includes(first.secret), false);
  assert.equal(value.clock.timers.at(-1).unrefCalled, true);

  const second = value.start();
  assert.notEqual(second.secret, first.secret);
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request(first.secret, pair.spki)).ok, false);
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request(second.secret, pair.spki)).ok, true);
  assert.deepEqual(value.pairing.publicState(), { phase: "code", deviceName: "Galaxy", expiresAt: 121_000 });
  assert.equal(JSON.stringify(value.pairing.publicState()).includes("012345"), false);
});

test("페어링 요청은 비밀·만료·P-256·기기 이름을 모두 검사한다", () => {
  const p256 = keyPair();
  const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");

  let value = pairingFixture();
  let qr = value.start();
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request("x".repeat(43), p256.spki)).ok, false);

  value = pairingFixture();
  qr = value.start();
  value.clock.advance(120_000);
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request(qr.secret, p256.spki)).ok, false);

  value = pairingFixture();
  qr = value.start();
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request(qr.secret, ed25519)).ok, false);

  value = pairingFixture();
  qr = value.start();
  assert.equal(value.pairing.request({ nodeId: NODE_ID }, request(qr.secret, p256.spki, "Galaxy\nS")).ok, false);
});

test("코드를 세 번 틀리면 폐기하고 맞으면 whois 노드가 든 기기를 반환한다", () => {
  const pair = keyPair();
  const failed = pairingFixture();
  const failedQr = failed.start();
  failed.pairing.request({ nodeId: NODE_ID }, request(failedQr.secret, pair.spki));
  assert.equal(failed.pairing.confirm("999999").error, "pairing-code-mismatch");
  assert.equal(failed.pairing.confirm("999999").error, "pairing-code-mismatch");
  assert.equal(failed.pairing.confirm("999999").error, "pairing-attempts-exceeded");
  assert.equal(failed.pairing.publicState(), null);

  const passed = pairingFixture();
  const passedQr = passed.start();
  const pending = passed.pairing.request({ nodeId: NODE_ID }, request(passedQr.secret, pair.spki));
  assert.deepEqual(pending.pending, { deviceId: "02".repeat(16), code: "012345" });
  assert.deepEqual(passed.pairing.confirm("012345"), {
    ok: true,
    device: { deviceId: "02".repeat(16), name: "Galaxy", connKey: pair.spki, nodeId: NODE_ID, addedAt: 1_000 },
  });
  assert.equal(passed.pairing.publicState(), null);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
  }

  send(message, callback) {
    this.sent.push(structuredClone(message));
    queueMicrotask(() => callback?.(null));
    return true;
  }

  kill() {
    this.connected = false;
    return true;
  }
}

function configuration() {
  return {
    type: "configure", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE,
    address: ADDRESS, port: 4292, keyPem: "key", certPem: "certificate",
    certHash: CERT_HASH, tailscalePath: "/tailscale",
  };
}

async function rpcFixture(pairing, clock = fakeClock()) {
  let child;
  let random = 20;
  let host;
  const auth = createConnectionAuth({
    serverInstance: SERVER_INSTANCE,
    getCertificateHash: () => CERT_HASH,
    getDevice: () => null,
    isRemoteEnabled: () => true,
    verifyPin: async () => ({ ok: false, error: "incorrect", retryAfterMs: 1_000 }),
    now: clock.now,
    randomBytes: (size) => Buffer.alloc(size, random++),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: (connId, reason) => host?.closeConnection(connId, reason),
  });
  host = createRemoteRpcHost({
    serverInstance: SERVER_INSTANCE,
    auth,
    onPairRequest: (entry, message) => pairing.request(entry, message),
    fork: () => (child = new FakeChild()),
    randomBytes: (size) => Buffer.alloc(size, random++),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const ready = host.start(configuration());
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  child.emit("message", { type: "listening", address: ADDRESS, port: 4292, certHash: CERT_HASH });
  await ready;
  return { host, auth, child };
}

async function openConnection(value, gwSeq, peerIp = PEER_IP) {
  value.child.emit("message", { type: "conn.open", gwSeq, peerIp, nodeId: NODE_ID, certHash: CERT_HASH });
  await Promise.resolve();
  return value.child.sent.find((message) => message.type === "conn.accept" && message.gwSeq === gwSeq).connId;
}

function sentTo(child, connId) {
  return child.sent.filter((message) => message.type === "conn.send" && message.connId === connId)
    .map((message) => JSON.parse(message.payload));
}

async function sendFrame(value, connId, message) {
  value.child.emit("message", { type: "conn.frame", connId, payload: JSON.stringify(message) });
  await Promise.resolve();
  await Promise.resolve();
}

test("페어링 실패는 데이터를 보내지 않고 다섯 번째에 IP 차단을 알린다", async () => {
  const clock = fakeClock();
  const fixture = pairingFixture({ clock });
  const p256 = keyPair();
  const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const rpc = await rpcFixture(fixture.pairing, clock);
  let sequence = 1;

  let qr = fixture.start();
  let connId = await openConnection(rpc, sequence++);
  await sendFrame(rpc, connId, request("x".repeat(43), p256.spki));
  assert.deepEqual(sentTo(rpc.child, connId).map((message) => message.type), ["auth.challenge"]);

  qr = fixture.start();
  clock.advance(120_000);
  connId = await openConnection(rpc, sequence++);
  await sendFrame(rpc, connId, request(qr.secret, p256.spki));

  qr = fixture.start();
  connId = await openConnection(rpc, sequence++);
  await sendFrame(rpc, connId, request(qr.secret, ed25519));

  qr = fixture.start();
  connId = await openConnection(rpc, sequence++);
  await sendFrame(rpc, connId, request(qr.secret, p256.spki, "Galaxy\nS"));

  qr = fixture.start();
  const successful = await openConnection(rpc, sequence++);
  await sendFrame(rpc, successful, request(qr.secret, p256.spki));
  assert.deepEqual(sentTo(rpc.child, successful).at(-1), {
    type: "pair.pending", v: REMOTE_RPC_VERSION, deviceId: "06".repeat(16), code: "012345",
  });
  const second = await openConnection(rpc, sequence++);
  await sendFrame(rpc, second, request(qr.secret, p256.spki));
  assert.ok(rpc.child.sent.some((message) => message.type === "ip.block" && message.peerIp === PEER_IP));

  await sendFrame(rpc, successful, { type: "auth.response", v: REMOTE_RPC_VERSION,
    deviceId: "06".repeat(16), signature: "MAACAQA=" });
  assert.equal(rpc.child.sent.some((message) => message.type === "conn.authenticated" && message.connId === successful), false);
  assert.ok(rpc.child.sent.some((message) => message.type === "conn.close" && message.connId === successful));
  rpc.host.stop();
});

test("Mac 자신의 수신 주소에서 온 페어링은 처리 함수 성공과 관계없이 거부한다", async () => {
  let called = 0;
  let child;
  const auth = {
    open: (entry) => ({ ok: true, challenge: { serverInstance: SERVER_INSTANCE, connId: entry.connId,
      nonce: "7".repeat(64), certHash: CERT_HASH } }),
    reject: () => ({ ok: false, error: "forbidden" }),
    close: () => true,
    activeBlocks: () => [],
  };
  const host = createRemoteRpcHost({
    serverInstance: SERVER_INSTANCE,
    auth,
    onPairRequest() { called++; return { ok: true, pending: { deviceId: "3".repeat(32), code: "123456" } }; },
    fork: () => (child = new FakeChild()),
    randomBytes: () => Buffer.alloc(16, 9),
  });
  const ready = host.start(configuration());
  child.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE });
  await Promise.resolve();
  child.emit("message", { type: "listening", address: ADDRESS, port: 4292, certHash: CERT_HASH });
  await ready;
  const value = { host, child };
  const connId = await openConnection(value, 1, ADDRESS);
  await sendFrame(value, connId, request("a".repeat(43), keyPair().spki));
  assert.equal(called, 0);
  assert.deepEqual(sentTo(child, connId).map((message) => message.type), ["auth.challenge"]);
  assert.ok(child.sent.some((message) => message.type === "conn.close" && message.connId === connId));
  host.stop();
});

async function tempState(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-pairing-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function agentOptions() {
  return {
    pinStore: {
      initialize: async () => ({ ok: true, configured: true }),
      hasPin: () => true,
      verify: async (pin) => pin === "123456" ? { ok: true }
        : { ok: false, error: "incorrect", retryAfterMs: 1_000 },
      set: async () => ({ ok: true }),
    },
    sessionPolicy: {
      initialize: async () => ({ ok: true, pinIdleMinutes: 30 }),
      getPinIdleMinutes: () => 30,
      set: async (pinIdleMinutes) => ({ ok: true, pinIdleMinutes }),
    },
    agentSocket: {
      socketPath: "/tmp/iris-remote-pairing.sock",
      channel: { canSend: () => false, send: async () => "failed" },
      start: async () => {}, stop: async () => {},
    },
    channelRuntime: { start: async () => {}, stop() {} },
    installer: { isInstalled: async () => false, install: async () => ({ ok: true, installed: true }),
      remove: async () => ({ ok: true, installed: false }) },
  };
}

test("코드 확인은 기기를 저장하고 그 키와 whois 노드로 일반 인증을 허용한다", async (t) => {
  const pair = keyPair();
  const registry = createRegistry({
    stateDir: await tempState(t), initialState: { version: 1, enabled: true, devices: [] },
  });
  let rpcOptions;
  let qrText;
  const remote = createRemoteLifecycle({
    ctx: { onShutdown() {}, visitClients() {} },
    onFeatureStateSaved: () => () => {},
    registry,
    createRpcHost(options) {
      rpcOptions = options;
      return { start: async (config) => ({ address: config.address, port: config.port }), stop: () => true,
        closeConnection: () => true };
    },
    resolveAddress: async () => ({ address: ADDRESS, executable: "/tailscale" }),
    prepareCertificate: async () => ({ keyPem: "key", certPem: "cert", certHash: CERT_HASH }),
    getServerPort: () => 4291,
    randomBytes: () => Buffer.alloc(16, 1),
    ...agentOptions(),
    pairingOptions: {
      randomBytes: (size) => Buffer.alloc(size, size === 32 ? 4 : 5),
      randomInt: () => 654_321,
      encode(text) { qrText = text; return { size: 1, data: [[true]] }; },
    },
  });
  await remote.ready;
  assert.deepEqual(remote.requestPairStart(), { ok: true });
  const qr = JSON.parse(qrText);
  const pending = rpcOptions.onPairRequest({ nodeId: NODE_ID, peerIp: PEER_IP }, request(qr.secret, pair.spki));
  assert.equal(pending.ok, true);
  assert.equal((await remote.requestPairConfirm("654321")).ok, true);

  const saved = registry.snapshot().devices[0];
  assert.equal(saved.nodeId, NODE_ID);
  assert.equal(saved.connKey, pair.spki);
  assert.deepEqual(remote.getState().devices, [{ deviceId: saved.deviceId, name: "Galaxy", addedAt: saved.addedAt }]);
  const stateText = JSON.stringify(remote.getState());
  for (const hidden of [qr.secret, "654321", pair.spki, NODE_ID]) assert.equal(stateText.includes(hidden), false, hidden);

  const connId = "8".repeat(32);
  const opened = rpcOptions.auth.open({ connId, peerIp: PEER_IP, nodeId: NODE_ID, certHash: CERT_HASH });
  const target = { domain: "iris-remote-conn/1", v: 1, serverInstance: remote.serverInstance,
    connId, deviceId: saved.deviceId, nonce: opened.challenge.nonce, certHash: CERT_HASH };
  const authenticated = rpcOptions.auth.authenticate(connId, {
    type: "auth.response", v: REMOTE_RPC_VERSION, deviceId: saved.deviceId,
    signature: sign("sha256", connectionSignatureBytes(target), {
      key: pair.privateKey, dsaEncoding: "der",
    }).toString("base64"),
  });
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.pinRequired, true);
  assert.equal((await rpcOptions.auth.submitPin(connId, {
    type: "pin.submit", v: REMOTE_RPC_VERSION, pin: "123456",
  })).ok, true);
  remote.shutdown();
});

test("원격 끄기와 기능 숨김은 진행 중 페어링을 폐기하고 이후 요청을 거부한다", async (t) => {
  for (const action of ["disable", "hide"]) {
    const registry = createRegistry({
      stateDir: await tempState(t), initialState: { version: 1, enabled: true, devices: [] },
    });
    let featureListener;
    let rpcOptions;
    let qrText;
    const remote = createRemoteLifecycle({
      ctx: { onShutdown() {}, visitClients() {} },
      onFeatureStateSaved(listener) { featureListener = listener; return () => {}; },
      registry,
      createRpcHost(options) {
        rpcOptions = options;
        return { start: async (config) => ({ address: config.address, port: config.port }), stop: () => true,
          closeConnection: () => true };
      },
      resolveAddress: async () => ({ address: ADDRESS, executable: "/tailscale" }),
      prepareCertificate: async () => ({ keyPem: "key", certPem: "cert", certHash: CERT_HASH }),
      getServerPort: () => 4291,
      randomBytes: () => Buffer.alloc(16, 1),
      ...agentOptions(),
      pairingOptions: {
        randomBytes: (size) => Buffer.alloc(size, 6), randomInt: () => 111_111,
        encode(text) { qrText = text; return { size: 1, data: [[true]] }; },
      },
    });
    await remote.ready;
    remote.requestPairStart();
    const qr = JSON.parse(qrText);
    if (action === "disable") await remote.requestDisable();
    else {
      featureListener({ hidden: ["remote"], shown: [] });
      for (let index = 0; index < 6; index++) await Promise.resolve();
    }
    assert.equal(remote.getState().pairing, null, action);
    assert.equal(rpcOptions.onPairRequest({ nodeId: NODE_ID, peerIp: PEER_IP }, request(qr.secret, keyPair().spki)).ok, false);
  }
});
