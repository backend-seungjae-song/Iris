import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";
import { EventEmitter, once } from "node:events";

import WebSocket from "ws";

import { prepareGatewayCertificate } from "../server/remote/certificate.js";
import { REMOTE_RPC_VERSION } from "../server/remote/contract/ipc.js";
import { isAllowedListenAddress } from "../server/remote/gateway/address.js";
import { createGateway } from "../server/remote/gateway/server.js";
import { createWhoisResolver } from "../server/remote/gateway/whois.js";

const SERVER_INSTANCE = "1".repeat(32);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function eventually(check, timeout = 1_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    function inspect() {
      const result = check();
      if (result) return resolve(result);
      if (Date.now() - started >= timeout) return reject(new Error("condition timed out"));
      setTimeout(inspect, 5);
    }
    inspect();
  });
}

function closed(socket) {
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.on("error", () => {});
  });
}

async function gatewayFixture(t, options = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-gateway-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const certificate = await prepareGatewayCertificate({ stateDir });
  let port;
  try {
    port = await freePort();
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox denied 127.0.0.1 listen with EPERM");
      return null;
    }
    throw error;
  }
  const sent = [];
  const failures = [];
  const gateway = createGateway({
    allowListenAddress: (address) => address === "127.0.0.1",
    whoisResolver: options.whoisResolver || { resolve: async () => "node-stable-id" },
    preauthLifetimeMs: options.preauthLifetimeMs,
    globalLimit: options.globalLimit,
    perIpLimit: options.perIpLimit,
    sendIpc(message, callback) {
      sent.push(structuredClone(message));
      queueMicrotask(() => callback?.(null));
      return true;
    },
    onFatal: (error) => failures.push(error),
  });
  try {
    await gateway.start({
      type: "configure",
      v: REMOTE_RPC_VERSION,
      serverInstance: SERVER_INSTANCE,
      address: "127.0.0.1",
      port,
      keyPem: certificate.keyPem,
      certPem: certificate.certPem,
      certHash: certificate.certHash,
      tailscalePath: "/tailscale",
      ...(options.availability ? { availability: options.availability } : {}),
    });
  } catch (error) {
    gateway.stop();
    if (error?.code === "EPERM") {
      t.skip("sandbox denied gateway 127.0.0.1 listen with EPERM");
      return null;
    }
    throw error;
  }
  t.after(() => gateway.stop());
  return { gateway, sent, failures, port, certificate };
}

test("상태 안내 전용 수신은 인증 전에 공개 사유만 보내고 호스트 연결을 만들지 않는다", async (t) => {
  const fixture = await gatewayFixture(t, { availability: "pin-required" });
  if (!fixture) return;
  const socket = new WebSocket(`wss://127.0.0.1:${fixture.port}`, { rejectUnauthorized: false });
  const message = once(socket, "message");
  const closing = closed(socket);
  await once(socket, "open");
  const [value] = await message;
  assert.deepEqual(JSON.parse(String(value)), {
    type: "service.status", v: REMOTE_RPC_VERSION, reason: "pin-required",
  });
  await closing;
  assert.equal(fixture.sent.some((entry) => entry.type === "conn.open"), false);
});

async function connect(fixture) {
  const openIndex = fixture.sent.filter((message) => message.type === "conn.open").length;
  const socket = new WebSocket(`wss://127.0.0.1:${fixture.port}`, { rejectUnauthorized: false });
  await once(socket, "open");
  const opened = await eventually(() => fixture.sent.filter((message) => message.type === "conn.open")[openIndex]);
  const connId = opened.gwSeq.toString(16).padStart(32, "0");
  assert.equal(fixture.gateway.receive({ type: "conn.accept", gwSeq: opened.gwSeq, connId }), true);
  return { socket, opened, connId };
}

test("운영 수신 주소 검사는 wildcard·loopback·IPv6를 거부한다", () => {
  assert.equal(isAllowedListenAddress("100.64.1.2"), true);
  assert.equal(isAllowedListenAddress("0.0.0.0"), false);
  assert.equal(isAllowedListenAddress("127.0.0.1"), false);
  assert.equal(isAllowedListenAddress("::1"), false);
});

test("whois는 동시 두 건만 실행하고 성공을 IP별 60초 보관한다", async () => {
  const releases = [];
  let time = 0;
  let calls = 0;
  const resolver = createWhoisResolver({
    executable: "/tailscale",
    now: () => time,
    execFile: async (_file, args) => {
      calls++;
      return new Promise((resolve) => releases.push(() => resolve({ stdout: JSON.stringify({
        Node: { StableID: `node-${args.at(-1)}`, Addresses: [`${args.at(-1)}/32`] },
      }) })));
    },
  });
  const first = resolver.resolve("100.64.0.1");
  const second = resolver.resolve("100.64.0.2");
  const third = resolver.resolve("100.64.0.3");
  assert.deepEqual(resolver.status(), { active: 2, queued: 1, cached: 0 });
  releases.shift()();
  assert.equal(await first, "node-100.64.0.1");
  await eventually(() => releases.length === 2);
  assert.equal(resolver.status().active, 2);
  releases.shift()();
  releases.shift()();
  await Promise.all([second, third]);
  assert.equal(await resolver.resolve("100.64.0.1"), "node-100.64.0.1");
  assert.equal(calls, 3);
  time = 60_001;
  const expired = resolver.resolve("100.64.0.1");
  releases.shift()();
  await expired;
  assert.equal(calls, 4);
});

test("whois 실패·시간 초과·주소 불일치는 연결 판정 실패가 된다", async () => {
  await assert.rejects(createWhoisResolver({
    executable: "/tailscale", execFile: async () => { throw new Error("service down"); },
  }).resolve("100.64.0.1"), /service down/);
  await assert.rejects(createWhoisResolver({
    executable: "/tailscale", execFile: async () => ({ stdout: JSON.stringify({ Node: { StableID: "node", Addresses: ["100.64.0.2/32"] } }) }),
  }).resolve("100.64.0.1"), /address-mismatch/);

  const timers = [];
  const resolver = createWhoisResolver({
    executable: "/tailscale",
    execFile: () => new Promise(() => {}),
    setTimer(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  const pending = resolver.resolve("100.64.0.1");
  timers[0].fn();
  await assert.rejects(pending, /whois-timeout/);
});

test("게이트웨이는 전체 연결 수와 WS 송신 대기량을 실제 연결 상태에 적용한다", async () => {
  class FakeServer extends EventEmitter {
    listen(port, address) { this.bound = { port, address }; queueMicrotask(() => this.emit("listening")); }
    address() { return this.bound; }
    close() {}
  }
  class FakeSocket extends EventEmitter {
    constructor(address) { super(); this.remoteAddress = address; this.destroyed = false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  class FakeWebSocket extends EventEmitter {
    constructor(socket) { super(); this._socket = socket; this.bufferedAmount = 0; this.sent = []; }
    send(value, callback) { this.sent.push(value); callback?.(null); }
    terminate() { this.emit("close"); this._socket.destroy(); }
  }
  let server;
  let websocketServer;
  class FakeWebSocketServer {
    constructor() { this.opened = []; websocketServer = this; }
    handleUpgrade(_request, socket, _head, callback) {
      this.last = new FakeWebSocket(socket);
      this.opened.push(this.last);
      callback(this.last);
    }
    close() {}
  }
  const sent = [];
  const gateway = createGateway({
    allowListenAddress: () => true,
    globalLimit: 2,
    whoisResolver: { resolve: async (ip) => `node-${ip}` },
    createHttpsServer: () => (server = new FakeServer()),
    WebSocketServer: FakeWebSocketServer,
    sendIpc(message, callback) { sent.push(structuredClone(message)); callback?.(null); return true; },
  });
  await gateway.start({
    type: "configure", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE,
    address: "100.64.1.2", port: 4292, keyPem: "key", certPem: "cert",
    certHash: "2".repeat(64), tailscalePath: "/tailscale",
  });
  const sockets = ["100.64.0.1", "100.64.0.2", "100.64.0.3"].map((address) => new FakeSocket(address));
  for (const socket of sockets) {
    server.emit("secureConnection", socket);
    if (!socket.destroyed) server.emit("upgrade", {}, socket, Buffer.alloc(0));
  }
  await eventually(() => sent.filter((message) => message.type === "conn.open").length === 2);
  assert.equal(sockets[2].destroyed, true);
  const openedMessages = sent.filter((message) => message.type === "conn.open");
  const firstConnId = "3".repeat(32);
  gateway.receive({ type: "conn.accept", gwSeq: openedMessages[0].gwSeq, connId: firstConnId });
  websocketServer.opened[0].emit("message", Buffer.from("\\".repeat(40_000)), false);
  assert.equal(websocketServer.opened[0]._socket.destroyed, true);
  assert.equal(websocketServer.opened[1]._socket.destroyed, false);
  assert.ok(sent.some((message) => message.type === "conn.close" && message.connId === firstConnId
    && message.reason === "ipc-message-too-large"));
  const opened = openedMessages.at(-1);
  const connId = "4".repeat(32);
  gateway.receive({ type: "conn.accept", gwSeq: opened.gwSeq, connId });
  websocketServer.last.bufferedAmount = 1024 * 1024;
  assert.equal(gateway.receive({ type: "conn.send", connId, payload: "x" }), false);
  assert.ok(sent.some((message) => message.type === "conn.close" && message.reason === "ws-backpressure"));
  gateway.stop();
  assert.equal(gateway.status().connections, 0);
});

test("게이트웨이는 인증 뒤 평균 초당 10개와 짧은 30개 몰림을 받고 지속 남용을 닫는다", async () => {
  class FakeServer extends EventEmitter {
    listen(port, address) { this.bound = { port, address }; queueMicrotask(() => this.emit("listening")); }
    address() { return this.bound; }
    close() {}
  }
  class FakeSocket extends EventEmitter {
    constructor(address) { super(); this.remoteAddress = address; this.destroyed = false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  class FakeWebSocket extends EventEmitter {
    constructor(socket) { super(); this._socket = socket; this.bufferedAmount = 0; }
    send(_value, callback) { callback?.(null); }
    terminate() { this.emit("close"); this._socket.destroy(); }
  }
  let server;
  let websocketServer;
  class FakeWebSocketServer {
    constructor() { this.opened = []; websocketServer = this; }
    handleUpgrade(_request, socket, _head, callback) {
      const ws = new FakeWebSocket(socket);
      this.opened.push(ws);
      callback(ws);
    }
    close() {}
  }
  let time = 1_000;
  const sent = [];
  const gateway = createGateway({
    allowListenAddress: () => true,
    now: () => time,
    whoisResolver: { resolve: async (ip) => `node-${ip}` },
    createHttpsServer: () => (server = new FakeServer()),
    WebSocketServer: FakeWebSocketServer,
    sendIpc(message, callback) { sent.push(structuredClone(message)); callback?.(null); return true; },
  });
  await gateway.start({
    type: "configure", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE,
    address: "100.64.1.2", port: 4292, keyPem: "key", certPem: "cert",
    certHash: "2".repeat(64), tailscalePath: "/tailscale",
  });

  const authenticatedSocket = new FakeSocket("100.64.0.1");
  server.emit("secureConnection", authenticatedSocket);
  server.emit("upgrade", {}, authenticatedSocket, Buffer.alloc(0));
  await eventually(() => sent.some((message) => message.type === "conn.open"));
  const opened = sent.find((message) => message.type === "conn.open");
  const connId = "3".repeat(32);
  gateway.receive({ type: "conn.accept", gwSeq: opened.gwSeq, connId });
  gateway.receive({ type: "conn.authenticated", connId });
  for (let index = 0; index < 20; index++) websocketServer.opened[0].emit("message", Buffer.from(`m${index}`), false);
  assert.equal(authenticatedSocket.destroyed, false);
  for (let index = 20; index < 30; index++) websocketServer.opened[0].emit("message", Buffer.from(`m${index}`), false);
  assert.equal(authenticatedSocket.destroyed, false);
  websocketServer.opened[0].emit("message", Buffer.from("sustained-abuse"), false);
  assert.equal(authenticatedSocket.destroyed, true);
  assert.ok(sent.some((message) => message.type === "conn.close" && message.reason === "rate-limit"));

  const blockedUntil = time + (30 * 60_000);
  gateway.receive({ type: "ip.block", peerIp: "100.64.0.2", blockedUntil });
  const blocked = new FakeSocket("100.64.0.2");
  server.emit("secureConnection", blocked);
  assert.equal(blocked.destroyed, true);
  time = blockedUntil;
  const released = new FakeSocket("100.64.0.2");
  server.emit("secureConnection", released);
  assert.equal(released.destroyed, false);
  gateway.stop();
});

test("실제 TLS+WS 연결은 whois 뒤 conn.open만 만들고 프레임을 IPC로 넘긴다", async (t) => {
  const fixture = await gatewayFixture(t);
  if (!fixture) return;
  const { socket, connId } = await connect(fixture);
  const received = [];
  socket.on("message", (value) => received.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, []);
  socket.send("hello");
  const frame = await eventually(() => fixture.sent.find((message) => message.type === "conn.frame"));
  assert.deepEqual(frame, { type: "conn.frame", connId, payload: "hello" });
  socket.close();
  await closed(socket);
  assert.equal(fixture.failures.length, 0);
});

test("whois 실패 연결은 conn.open 없이 거부된다", async (t) => {
  const fixture = await gatewayFixture(t, { whoisResolver: { resolve: async () => { throw new Error("denied"); } } });
  if (!fixture) return;
  const socket = new WebSocket(`wss://127.0.0.1:${fixture.port}`, { rejectUnauthorized: false });
  await closed(socket);
  assert.equal(fixture.sent.some((message) => message.type === "conn.open"), false);
});

test("인증 전 IP당 연결 수와 초당 프레임 수를 제한한다", async (t) => {
  const fixture = await gatewayFixture(t);
  if (!fixture) return;
  const sockets = [];
  for (let index = 0; index < 4; index++) sockets.push((await connect(fixture)).socket);
  const fifth = new WebSocket(`wss://127.0.0.1:${fixture.port}`, { rejectUnauthorized: false });
  await closed(fifth);
  assert.equal(fixture.gateway.status().sockets, 4);
  for (const socket of sockets) socket.terminate();

  await eventually(() => fixture.gateway.status().sockets === 0);
  const connection = await connect(fixture);
  for (let index = 0; index < 6; index++) connection.socket.send(`frame-${index}`);
  await closed(connection.socket);
  assert.ok(fixture.sent.some((message) => message.type === "conn.close" && message.reason === "rate-limit"));
});

test("인증 전 수명과 64 KiB 프레임 상한을 넘으면 연결을 닫는다", async (t) => {
  const lifetime = await gatewayFixture(t, { preauthLifetimeMs: 40 });
  if (!lifetime) return;
  const first = await connect(lifetime);
  await closed(first.socket);
  assert.ok(lifetime.sent.some((message) => message.type === "conn.close" && message.reason === "authentication-timeout"));

  lifetime.gateway.stop();
  const frameFixture = await gatewayFixture(t);
  if (!frameFixture) return;
  const second = await connect(frameFixture);
  second.socket.send("x".repeat((64 * 1024) + 1));
  await closed(second.socket);
  assert.equal(frameFixture.gateway.status().connections, 0);
});
