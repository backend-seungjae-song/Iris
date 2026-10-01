import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRemoteLifecycle, remoteConnectionCloseLog } from "../server/remote/index.js";
import { createRegistry } from "../server/remote/registry.js";

const CONN_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjdktXx43iY9//Ig37NmNXA3vQDP11ZfXXFQBrWzeCocqIjitkTHWGanBj5owBs0UlykarWzY111ZRvJBHemNeg==";
const DEVICE = { deviceId: "device-1", name: "Galaxy", connKey: CONN_KEY, nodeId: "node-1", addedAt: 1_000 };

function context() {
  const shutdown = [];
  const clients = new Set();
  return {
    shutdown,
    clients,
    onShutdown(callback) { shutdown.push(callback); },
    visitClients(callback) { for (const client of clients) callback(client); },
  };
}

function featureState() {
  const listeners = new Set();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    hide() { for (const listener of listeners) listener({ hidden: ["remote"], shown: [] }); },
    count: () => listeners.size,
  };
}

function gateway(overrides = {}) {
  const state = { starts: 0, stops: 0, active: false, closed: [], configurations: [] };
  const rpcHost = {
    async start(configuration) {
      state.starts++;
      state.active = true;
      state.configurations.push(structuredClone(configuration));
      if (overrides.start) return overrides.start(configuration);
      return { address: configuration.address, port: configuration.port };
    },
    stop() {
      state.stops++;
      state.active = false;
      return overrides.stopResult ?? true;
    },
    closeConnection(connId, reason) { state.closed.push([connId, reason]); return true; },
  };
  return {
    state,
    rpcHost,
    resolveAddress: overrides.resolveAddress || (async () => ({ address: "100.64.1.2", executable: "/tailscale" })),
    prepareCertificate: overrides.prepareCertificate || (async () => ({ keyPem: "key", certPem: "cert", certHash: "2".repeat(64) })),
    getServerPort: () => 4291,
    randomBytes: () => Buffer.alloc(16, 1),
  };
}

function auth(invalidate = () => []) {
  return { invalidate, close() {}, open() {}, authenticate() {}, beginRequest() {}, endRequest() {},
    refreshExpiry: () => [], pruneExpiredTokens() {}, activeBlocks: () => [] };
}

function policy(initial = 30) {
  let minutes = initial;
  return {
    initialize: async () => ({ ok: true, pinIdleMinutes: minutes }),
    getPinIdleMinutes: () => minutes,
    async set(value) { minutes = value; return { ok: true, pinIdleMinutes: value }; },
  };
}

function pins(initial = true) {
  let configured = initial;
  return {
    initialize: async () => ({ ok: true, configured }),
    hasPin: () => configured,
    verify: async (pin) => pin === "123456" ? { ok: true }
      : { ok: false, error: "incorrect", retryAfterMs: 1_000 },
    async set(pin) {
      if (!/^\d{6,32}$/.test(pin)) return { ok: false, error: "invalid-pin" };
      configured = true;
      return { ok: true };
    },
  };
}

async function tempState(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-lifecycle-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

test("원격 연결 종료 로그는 이유 코드만 남긴다", () => {
  assert.equal(remoteConnectionCloseLog({
    type: "conn.closed", connId: "a".repeat(32), deviceId: "secret", reason: "rate-limit",
  }), "[remote] close reason=rate-limit");
  assert.equal(remoteConnectionCloseLog({
    type: "conn.closed", reason: "token=secret user=phone",
  }), "[remote] close reason=internal-error");
  assert.equal(remoteConnectionCloseLog({ type: "conn.opened", reason: "rate-limit" }), null);
});

function lifecycle({ registry, feature = featureState(), gatewayOptions = {}, authOwner = auth(),
  pinOwner = pins(), policyOwner = policy(), ctx = context() }) {
  const gatewayOwner = gateway(gatewayOptions);
  const auxiliary = { socketStarts: 0, socketStops: 0, launchStarts: 0, launchStops: 0 };
  const agentSocket = {
    socketPath: "/tmp/iris-test-agent.sock",
    channel: { canSend: () => false, send: async () => "failed" },
    async start() { auxiliary.socketStarts++; },
    async stop() { auxiliary.socketStops++; },
  };
  const channelRuntime = {
    async start() { auxiliary.launchStarts++; },
    stop() { auxiliary.launchStops++; },
  };
  const remote = createRemoteLifecycle({
    ctx,
    onFeatureStateSaved: feature.subscribe,
    registry,
    auth: authOwner,
    pinStore: pinOwner,
    sessionPolicy: policyOwner,
    agentSocket,
    channelRuntime,
    installer: { isInstalled: async () => false, install: async () => ({ ok: true, installed: true }),
      remove: async () => ({ ok: true, installed: false }) },
    ...gatewayOwner,
  });
  return { remote, feature, gateway: gatewayOwner, auxiliary, ctx };
}

test("수명 상태는 저장된 꺼짐·켜짐과 등록부 오류를 반영한다", async (t) => {
  const cases = [
    [{ version: 1, enabled: false, devices: [] }, "off"],
    [{ version: 1, enabled: true, devices: [] }, "on"],
  ];
  for (const [initialState, expected] of cases) {
    const registry = createRegistry({ stateDir: await tempState(t), initialState });
    const { remote } = lifecycle({ registry });
    await remote.ready;
    assert.equal(remote.getState().status, expected);
  }

  const stateDir = await tempState(t);
  const remoteDir = path.join(stateDir, "remote");
  await fsp.mkdir(remoteDir, { recursive: true });
  await fsp.writeFile(path.join(remoteDir, "registry.json"), JSON.stringify({ version: 1, enabled: true, devices: [] }));
  const restarted = lifecycle({ registry: createRegistry({ stateDir }) }).remote;
  await restarted.ready;
  assert.equal(restarted.getState().status, "on");

  const brokenDir = await tempState(t);
  await fsp.mkdir(path.join(brokenDir, "remote"), { recursive: true });
  await fsp.writeFile(path.join(brokenDir, "remote", "registry.json"), "{broken");
  const broken = lifecycle({ registry: createRegistry({ stateDir: brokenDir }) }).remote;
  await broken.ready;
  assert.equal(broken.getState().status, "error");
  assert.equal(broken.getState().error.action, "enable");
});

test("기능 숨김이 초기화 전에 오면 초기화 뒤 게이트웨이를 시작하지 않고 저장값을 끈다", async (t) => {
  const stateDir = await tempState(t);
  const base = createRegistry({ stateDir, initialState: { version: 1, enabled: true, devices: [] } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = { ...base, initialize: async () => { await gate; return base.initialize(); } };
  const built = lifecycle({ registry });
  built.feature.hide();
  release();
  await built.remote.ready;
  assert.equal(built.gateway.state.starts, 0);
  assert.equal(registry.snapshot().enabled, false);
  assert.equal(built.remote.getState().status, "off");
});

test("기능 숨김이 켜진 뒤 오면 세션과 게이트웨이를 닫고 등록부를 끈다", async (t) => {
  const registry = createRegistry({ stateDir: await tempState(t), initialState: { version: 1, enabled: true, devices: [] } });
  const invalidations = [];
  const built = lifecycle({ registry, authOwner: auth((scope) => { invalidations.push(scope); return ["1".repeat(32)]; }) });
  await built.remote.ready;
  built.feature.hide();
  await settle();
  assert.equal(built.gateway.state.active, false);
  assert.equal(registry.effectiveState().enabled, false);
  assert.ok(invalidations.some((scope) => scope.scope === "all"));
  assert.ok(built.gateway.state.closed.some((entry) => entry[1] === "feature-hidden"));
  assert.equal((await built.remote.requestEnable()).error, "feature-hidden");
});

test("끄기는 등록부 저장이 실패해도 먼저 세션과 게이트웨이를 닫는다", async (t) => {
  const stateDir = await tempState(t);
  let failWrite = true;
  const registry = createRegistry({
    stateDir,
    initialState: { version: 1, enabled: true, devices: [] },
    io: {
      write: async (file, data, mode) => {
        if (failWrite) throw Object.assign(new Error("injected"), { code: "EIO" });
        await fsp.writeFile(file, data, { mode });
      },
    },
  });
  const events = [];
  const built = lifecycle({ registry, authOwner: auth(() => { events.push("sessions"); return []; }) });
  await built.remote.ready;
  const originalStop = built.gateway.rpcHost.stop;
  built.gateway.rpcHost.stop = () => { events.push("gateway"); return originalStop(); };
  const result = await built.remote.requestDisable();
  assert.equal(result.ok, false);
  assert.deepEqual(events.slice(0, 2), ["sessions", "gateway"]);
  assert.equal(built.gateway.state.active, false);
  assert.equal(built.remote.getState().status, "error");
  assert.equal(built.remote.getState().error.action, "stop");
  failWrite = false;
  assert.equal((await built.remote.retryStop()).ok, true);
  assert.equal(JSON.parse(await fsp.readFile(path.join(stateDir, "remote", "registry.json"), "utf8")).enabled, false);
});

test("시작 도중 끄기는 늦은 준비 결과를 버리고 게이트웨이를 시작하지 않는다", async (t) => {
  let release;
  const address = new Promise((resolve) => { release = resolve; });
  const registry = createRegistry({ stateDir: await tempState(t), initialState: { version: 1, enabled: false, devices: [] } });
  const built = lifecycle({ registry, gatewayOptions: { resolveAddress: () => address } });
  await built.remote.ready;
  const enabling = built.remote.requestEnable();
  await Promise.resolve();
  await built.remote.requestDisable();
  release({ address: "100.64.1.2", executable: "/tailscale" });
  await enabling;
  assert.equal(built.gateway.state.starts, 0);
  assert.equal(built.gateway.state.active, false);
  assert.equal(built.remote.getState().status, "off");
});

test("켜기·끄기·켜기는 게이트웨이를 하나만 유지하고 구독을 늘리지 않는다", async (t) => {
  const registry = createRegistry({ stateDir: await tempState(t), initialState: { version: 1, enabled: false, devices: [] } });
  const built = lifecycle({ registry });
  await built.remote.ready;
  await built.remote.requestEnable();
  assert.equal(built.gateway.state.active, true);
  await built.remote.requestDisable();
  assert.equal(built.gateway.state.active, false);
  await built.remote.requestEnable();
  assert.equal(built.gateway.state.active, true);
  assert.equal(built.gateway.state.starts, 2);
  assert.equal(built.auxiliary.socketStarts, 2);
  assert.equal(built.auxiliary.launchStarts, 2);
  assert.ok(built.auxiliary.socketStops >= 1);
  assert.ok(built.auxiliary.launchStops >= 1);
  assert.equal(built.feature.count(), 1);
});

test("기기 폐기는 저장을 기다리지 않고 그 기기의 세션을 닫는다", async (t) => {
  const stateDir = await tempState(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createRegistry({
    stateDir,
    initialState: { version: 1, enabled: true, devices: [DEVICE] },
    io: { write: async (file, data, mode) => { started(); await gate; await fsp.writeFile(file, data, { mode }); } },
  });
  const built = lifecycle({
    registry,
    authOwner: auth((scope) => scope.scope === "device" ? ["7".repeat(32)] : []),
  });
  await built.remote.ready;
  const removing = built.remote.removeDevice(DEVICE.deviceId);
  await waiting;
  assert.deepEqual(registry.effectiveState().devices, []);
  assert.deepEqual(built.gateway.state.closed, [["7".repeat(32), "device-removed"]]);
  release();
  assert.equal((await removing).ok, true);
});

test("종료는 세션과 게이트웨이를 닫고 저장된 enabled를 유지한 뒤 정상 종료를 표시한다", async (t) => {
  const stateDir = await tempState(t);
  const registry = createRegistry({ stateDir, initialState: { version: 1, enabled: true, devices: [] } });
  const events = [];
  const built = lifecycle({ registry, authOwner: auth(() => { events.push("sessions"); return []; }) });
  await built.remote.ready;
  const originalStop = built.gateway.rpcHost.stop;
  built.gateway.rpcHost.stop = () => { events.push("gateway"); return originalStop(); };
  assert.equal(built.remote.shutdown(), true);
  assert.deepEqual(events.slice(-2), ["sessions", "gateway"]);
  assert.equal(registry.snapshot().enabled, true);
  assert.equal(built.remote.getState().cleanShutdownRecorded, true);
});

test("PIN이 없으면 켜기를 거부하고 PIN 변경은 기존 연결을 모두 닫는다", async (t) => {
  const registry = createRegistry({
    stateDir: await tempState(t), initialState: { version: 1, enabled: false, devices: [] },
  });
  const invalidations = [];
  const built = lifecycle({
    registry,
    pinOwner: pins(false),
    authOwner: auth((scope) => { invalidations.push(scope); return ["9".repeat(32)]; }),
  });
  await built.remote.ready;
  assert.equal(built.remote.getState().pinConfigured, false);
  assert.deepEqual(await built.remote.requestEnable(), { ok: false, error: "pin-required" });
  assert.deepEqual(await built.remote.setAccessPin("123456", "654321"), { ok: false, error: "pin-mismatch" });
  assert.deepEqual(await built.remote.setAccessPin("123456", "123456"), { ok: true, configured: true, resumed: false });
  assert.deepEqual(invalidations.at(-1), { scope: "all" });
  assert.ok(built.gateway.state.closed.some((entry) => entry[1] === "pin-changed"));
  assert.equal((await built.remote.requestEnable()).ok, true);
});

test("PIN 기한 변경은 연결된 세션에 바로 적용하고 공개 상태를 갱신한다", async (t) => {
  const registry = createRegistry({
    stateDir: await tempState(t), initialState: { version: 1, enabled: true, devices: [DEVICE] },
  });
  const refreshed = [];
  const authOwner = auth();
  authOwner.refreshExpiry = () => { refreshed.push(20); return ["8".repeat(32)]; };
  const policyOwner = policy();
  authOwner.pruneExpiredTokens = () => { refreshed.push(`prune@${policyOwner.getPinIdleMinutes()}`); };
  const built = lifecycle({ registry, authOwner, policyOwner });
  await built.remote.ready;
  assert.equal(built.remote.getState().pinIdleMinutes, 30);
  assert.deepEqual(await built.remote.setPinIdleMinutes(20), {
    ok: true, pinIdleMinutes: 20, expired: 1,
  });
  assert.deepEqual(refreshed, ["prune@30", 20]);
  assert.deepEqual(built.gateway.state.closed.at(-1), ["8".repeat(32), "idle-timeout"]);
  assert.equal(built.remote.getState().pinIdleMinutes, 20);
});

test("저장된 공유가 켜져 있으면 첫 PIN 저장 뒤 바로 다시 시작한다", async (t) => {
  const registry = createRegistry({
    stateDir: await tempState(t), initialState: { version: 1, enabled: true, devices: [DEVICE] },
  });
  const built = lifecycle({ registry, pinOwner: pins(false) });
  await built.remote.ready;
  assert.equal(built.gateway.state.starts, 1);
  assert.equal(built.gateway.state.configurations[0].availability, "pin-required");
  assert.equal(built.remote.getState().status, "off");
  assert.equal(built.remote.getState().pausedForPin, true);
  assert.deepEqual(await built.remote.setAccessPin("123456", "123456"), {
    ok: true, configured: true, resumed: true,
  });
  assert.equal(built.gateway.state.starts, 2);
  assert.equal(built.gateway.state.configurations[1].availability, "enabled");
  assert.equal(built.remote.getState().status, "on");
});

test("등록 기기가 있고 공유가 꺼져 있으면 사유 안내 전용 수신만 시작한다", async (t) => {
  const registry = createRegistry({
    stateDir: await tempState(t), initialState: { version: 1, enabled: false, devices: [DEVICE] },
  });
  const built = lifecycle({ registry });
  await built.remote.ready;
  assert.equal(built.remote.getState().status, "off");
  assert.equal(built.gateway.state.configurations.at(-1).availability, "sharing-disabled");
  assert.equal(built.auxiliary.socketStarts, 0);
  assert.equal(built.auxiliary.launchStarts, 0);
});

test("상태 알림은 인증된 로컬 UI 연결에만 전송한다", async (t) => {
  const ctx = context();
  const sockets = [
    { _local: true, _ui: true, readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } },
    { _local: true, _ui: false, readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } },
    { _local: false, _ui: true, readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } },
  ];
  sockets.forEach((socket) => ctx.clients.add(socket));
  const registry = createRegistry({ stateDir: await tempState(t), initialState: { version: 1, enabled: false, devices: [] } });
  const built = lifecycle({ registry, ctx });
  await built.remote.ready;
  assert.ok(sockets[0].sent.some((message) => message.type === "remote.state"));
  assert.equal(sockets[1].sent.length, 0);
  assert.equal(sockets[2].sent.length, 0);
});
