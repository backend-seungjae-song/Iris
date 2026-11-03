import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostIdentityAuthority } from "../server/mcp-host/identity.js";
import { createIpcClient } from "../server/mcp-worker/ipc-client.js";
import { createMcpWorkerSupervisor } from "../server/mcp-worker/supervisor.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("현재 세대의 등록 구독 이벤트만 worker IPC로 전달한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iris-f6b-events-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const children = [];
  let pid = 40_000;
  const spawnWorker = (_entry, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.connected = true;
    child.sent = [];
    child.send = (message, callback) => {
      child.sent.push(message);
      callback?.();
      const result = () => queueMicrotask(() => child.emit("message", {
        protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
        type: `${message.type}.result`,
        requestId: message.requestId,
        ok: true,
        output: {},
      }));
      if (message.type === "worker.authorized") queueMicrotask(() => child.emit("message", {
        protocol: 1,
        workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
        type: "worker.ready",
        pid: child.pid,
        deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      }));
      if (["worker.accept", "worker.stopAccepting", "worker.drain", "worker.request"].includes(message.type)) result();
      if (message.type === "worker.shutdown") {
        result();
        queueMicrotask(() => {
          child.connected = false;
          child.emit("exit", 0, null);
        });
      }
    };
    child.kill = () => {
      child.connected = false;
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    };
    child.disconnect = child.kill;
    children.push(child);
    queueMicrotask(() => child.emit("message", {
      protocol: 1,
      workerGeneration: options.env.IRIS_MCP_WORKER_GENERATION,
      type: "worker.hello",
      pid: child.pid,
      deployId: options.env.IRIS_MCP_WORKER_DEPLOY_ID,
      token: options.env.IRIS_MCP_WORKER_TOKEN,
    }));
    return child;
  };
  const supervisor = createMcpWorkerSupervisor({
    stateDir,
    bundleId: "bundle",
    spawnWorker,
    identityAuthority: createHostIdentityAuthority(),
    hostDispatcher: generation => ({
      dispatch: async message => ({
        protocol: 1,
        type: "host.response",
        requestId: message.requestId,
        workerGeneration: generation,
        ok: true,
        output: { subscribed: true, subscriptionId: message.input.relay.args.subscriptionId },
      }),
      waitForIdle: async () => {},
    }),
    relay: { accept: () => ({ ok: true }), retire: () => ({ ok: true }) },
    log: { info() {} },
  });
  await supervisor.start();
  const generation = supervisor.status().workerGeneration;
  const child = children.at(-1);
  child.emit("message", {
    protocol: 1,
    type: "host.request",
    requestId: "subscribe-1",
    workerGeneration: generation,
    commandId: `${generation}/subscribe`,
    callId: 1,
    operation: "browser.executeWithDialog",
    input: { relay: { command: "cdp.subscribe", args: { subscriptionId: "sub-1" } } },
  });
  await tick();

  assert.equal(supervisor.relayEvent({ workerGeneration: generation, subscriptionId: "sub-1", eventSeq: 1,
    method: "Runtime.consoleAPICalled", params: {} }), true);
  assert.equal(supervisor.relayEvent({ workerGeneration: generation, subscriptionId: "sub-1", eventSeq: 1,
    method: "Runtime.consoleAPICalled", params: {} }), false);
  assert.equal(supervisor.relayEvent({ workerGeneration: generation, subscriptionId: "missing", eventSeq: 2 }), false);
  assert.equal(supervisor.relayEvent({ workerGeneration: "old:1", subscriptionId: "sub-1", eventSeq: 2 }), false);
  assert.deepEqual(child.sent.filter(message => message.type === "relay.event").map(message => message.event.eventSeq), [1]);

  await supervisor.reloadSource();
  assert.equal(supervisor.relayEvent({ workerGeneration: generation, subscriptionId: "sub-1", eventSeq: 2 }), false);
  await supervisor.shutdown();
});

test("IPC client는 relay 이벤트를 응답과 분리해 구독자에게 전달한다", () => {
  const events = new EventEmitter();
  const ipc = createIpcClient({ workerGeneration: "boot:1", send: () => {}, events });
  const received = [];
  const unsubscribe = ipc.onRelayEvent(event => received.push(event));

  events.emit("message", { protocol: 1, workerGeneration: "boot:1", type: "relay.event",
    event: { workerGeneration: "boot:1", subscriptionId: "sub-1", eventSeq: 1 } });
  events.emit("message", { protocol: 1, workerGeneration: "old:1", type: "relay.event",
    event: { workerGeneration: "old:1", subscriptionId: "sub-1", eventSeq: 2 } });
  unsubscribe();

  assert.deepEqual(received.map(event => event.eventSeq), [1]);
  ipc.close();
});
