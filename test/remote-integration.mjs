import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { createConnectionAuth } from "../server/remote/auth.js";
import { prepareGatewayCertificate } from "../server/remote/certificate.js";
import { connectionSignatureBytes } from "../server/remote/contract/connection.js";
import { REMOTE_RPC_VERSION } from "../server/remote/contract/ipc.js";
import { createGateway } from "../server/remote/gateway/server.js";
import { createRemoteRpcHost } from "../server/remote/rpc-host.js";

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

function messageReader(socket) {
  const queued = [];
  const waiting = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(String(raw));
    const resolve = waiting.shift();
    if (resolve) resolve(value);
    else queued.push(value);
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
}

test("실제 TLS+WS에서 챌린지·서명·caps·오류 뒤 중지가 연결을 없앤다", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-integration-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  let port;
  try {
    port = await freePort();
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox denied 127.0.0.1 listen with EPERM");
      return;
    }
    throw error;
  }
  const certificate = await prepareGatewayCertificate({ stateDir });
  const connectionKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const device = {
    deviceId: "3".repeat(32),
    name: "Galaxy",
    connKey: connectionKey.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    nodeId: "node-stable-id",
    addedAt: 1_000,
  };
  const serverInstance = "1".repeat(32);
  let host;
  const auth = createConnectionAuth({
    serverInstance,
    getCertificateHash: () => certificate.certHash,
    getDevice: (deviceId) => deviceId === device.deviceId ? structuredClone(device) : null,
    isRemoteEnabled: () => true,
    verifyPin: async (pin) => pin === "123456" ? { ok: true }
      : { ok: false, error: "incorrect", retryAfterMs: 1_000 },
    onExpire: (connId, reason) => host?.closeConnection(connId, reason),
  });

  class GatewayChild extends EventEmitter {
    constructor() {
      super();
      this.connected = true;
      this.gateway = null;
      queueMicrotask(() => this.emit("message", { type: "hello", v: REMOTE_RPC_VERSION, serverInstance }));
    }

    send(message, callback) {
      queueMicrotask(() => {
        if (message.type === "configure") {
          this.gateway = createGateway({
            allowListenAddress: (address) => address === "127.0.0.1",
            whoisResolver: { resolve: async () => device.nodeId },
            sendIpc: (value, done) => {
              queueMicrotask(() => this.emit("message", value));
              queueMicrotask(() => done?.(null));
              return true;
            },
            onFatal: (error) => this.emit("error", error),
          });
          void this.gateway.start(message).catch((error) => this.emit("error", error));
        } else {
          this.gateway?.receive(message);
        }
        callback?.(null);
      });
      return true;
    }

    kill() {
      this.connected = false;
      this.gateway?.stop();
      return true;
    }
  }

  host = createRemoteRpcHost({
    serverInstance,
    auth,
    fork: () => new GatewayChild(),
  });
  try {
    await host.start({
      type: "configure",
      v: REMOTE_RPC_VERSION,
      serverInstance,
      address: "127.0.0.1",
      port,
      keyPem: certificate.keyPem,
      certPem: certificate.certPem,
      certHash: certificate.certHash,
      tailscalePath: "/tailscale",
    });
  } catch (error) {
    host.stop();
    if (error?.code === "EPERM") {
      t.skip("sandbox denied gateway 127.0.0.1 listen with EPERM");
      return;
    }
    throw error;
  }
  t.after(() => host.stop());

  const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  const read = messageReader(socket);
  await once(socket, "open");
  const challenge = await read();
  assert.equal(challenge.type, "auth.challenge");
  const target = {
    domain: "iris-remote-conn/1",
    v: 1,
    serverInstance,
    connId: challenge.connId,
    deviceId: device.deviceId,
    nonce: challenge.nonce,
    certHash: certificate.certHash,
  };
  socket.send(JSON.stringify({
    type: "auth.response",
    v: REMOTE_RPC_VERSION,
    deviceId: device.deviceId,
    signature: sign("sha256", connectionSignatureBytes(target), {
      key: connectionKey.privateKey, dsaEncoding: "der",
    }).toString("base64"),
  }));
  assert.deepEqual(await read(), { type: "pin.required", v: REMOTE_RPC_VERSION });
  socket.send(JSON.stringify({ type: "pin.submit", v: REMOTE_RPC_VERSION, pin: "123456" }));
  const authOk = await read();
  assert.equal(authOk.type, "auth.ok");
  assert.equal(authOk.v, REMOTE_RPC_VERSION);
  assert.match(authOk.resumeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authOk.pinIdleMinutes, 30);
  socket.send(JSON.stringify({ type: "caps.get" }));
  const caps = await read();
  assert.equal(caps.type, "caps");
  assert.equal(caps.remoteRpc, REMOTE_RPC_VERSION);
  for (const request of ["caps.get", "ping", "watch", "transcript.page", "transcript.watch", "agent.stop",
    "agent.message", "request.answer", "browser.tabs", "browser.profiles", "browser.bookmarks"]) {
    assert.equal(caps.requests.includes(request), true, request);
  }
  assert.equal(caps.requests.includes("terminal.watch"), false);
  assert.equal(caps.requests.includes("browser.frame.watch"), false);
  socket.send(JSON.stringify({ type: "unknown" }));
  assert.deepEqual(await read(), { type: "error", error: { code: "unsupported-request" } });

  const closed = once(socket, "close");
  host.stop();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("connection did not close within one second")), 1_000)),
  ]);
  assert.equal(host.status().connections, 0);
});
