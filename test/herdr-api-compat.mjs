import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import { HerdrClient } from "../server/herdr.js";

test("agent message uses the Herdr prompt method without waiting for completion", async () => {
  const client = new HerdrClient();
  const calls = [];
  client.call = async (method, params) => { calls.push({ method, params }); return { type: "agent_prompted" }; };
  await client.agentSend("w1:p1", "hello");
  assert.deepEqual(calls, [{ method: "agent.prompt", params: { target: "w1:p1", text: "hello" } }]);
});

test("subscription covers Herdr navigation and structural changes outside Iris", async (t) => {
  const originalConnect = net.connect;
  let request;
  net.connect = (_path, connected) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = (raw) => { request = JSON.parse(String(raw)); return true; };
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(connected);
    return socket;
  };
  t.after(() => { net.connect = originalConnect; });
  const client = new HerdrClient();
  client.paneList = async () => [];
  client._openSubSocket([]);
  await new Promise((resolve) => setImmediate(resolve));
  client.subSock.destroy();
  assert.equal(request.method, "events.subscribe");
  const types = new Set(request.params.subscriptions.map((s) => s.type));
  for (const type of [
    "workspace.focused", "workspace.moved", "workspace.reordered",
    "tab.focused", "tab.renamed", "tab.moved", "pane.moved",
  ]) assert.ok(types.has(type), `missing ${type}`);
});

test("RPC 응답 뒤에는 타이머 때문에 프로세스가 5초 더 남지 않는다", async () => {
  const { spawnSync } = await import("node:child_process");
  const source = `
    import net from 'node:net';
    import { EventEmitter } from 'node:events';
    import { HerdrClient } from ${JSON.stringify(new URL("../server/herdr.js", import.meta.url).href)};
    net.connect = (_path, ready) => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from('{"result":{"ok":true}}\\n')));
      queueMicrotask(ready);
      return socket;
    };
    await new HerdrClient().call('probe');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 1500, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test("응답 없이 닫힌 RPC 연결은 즉시 실패한다", async (t) => {
  const original = net.connect;
  net.connect = (_path, ready) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.write = () => queueMicrotask(() => socket.emit("end"));
    queueMicrotask(ready);
    return socket;
  };
  t.after(() => { net.connect = original; });
  await assert.rejects(new HerdrClient().call("probe"), /herdr closed: probe/);
});
