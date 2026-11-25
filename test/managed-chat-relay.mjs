import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { connectManagedChat } from "../server/paseo-ui/managed-chat-relay.js";

test("managed relay passes permission responses and blocks other agents and daemon actions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iris-relay-"));
  const socketPath = path.join(dir, "provider.sock");
  const server = createServer();
  const upstream = new WebSocketServer({ server, path: "/ws" });
  server.listen(socketPath);
  await once(server, "listening");
  const received = [];
  upstream.on("connection", (ws) => ws.on("message", (data) => {
    received.push(JSON.parse(data));
    ws.send(data.toString());
  }));
  const results = [];
  let markOpen, markMessage;
  const opened = new Promise((resolve) => { markOpen = resolve; });
  const answer = new Promise((resolve) => { markMessage = resolve; });
  const permissions = new Map([
    ["cancel_agent_request", "workspace.write"], ["shutdown_server_request", "daemon.manage"],
    ["agent_permission_response", ["workspace.write", "hub.execute"]],
    ["future_agent_read", "workspace.read"], ["future_agent_write", "workspace.write"],
  ]);
  const relay = connectManagedChat({ socketPath, agentId: "chosen", clientNamespace: "window" }, (type) => permissions.get(type), (event) => {
    results.push(event);
    if (event.event === "open") markOpen();
    if (event.event === "message" && event.data.includes("agent_permission_response")) markMessage();
  });
  try {
    await opened;
    const send = (type, fields) => relay.send({ data: JSON.stringify({ type: "session", message: { type, ...fields } }) });
    relay.send({ data: JSON.stringify({ type: "hello", clientId: "upstream-client", capabilities: { binary_chunking_v1: true } }) });
    send("cancel_agent_request", { agentId: "other", requestId: "foreign" });
    send("shutdown_server_request", { requestId: "shutdown" });
    send("future_agent_read", { agentId: "chosen", requestId: "read" });
    send("future_agent_write", { agentId: "chosen", requestId: "write" });
    send("future_agent_write", { agentId: "chosen", sourceAgentId: "other", requestId: "wrong-sender" });
    send("future_agent_write", { requestId: "unbound" });
    send("unknown", { agentId: "chosen", requestId: "unknown" });
    send("agent_permission_response", { agentId: "chosen", requestId: "question", response: { behavior: "allow", updatedInput: { answers: { A: "One" } } } });
    await answer;
    assert.deepEqual(received.map((frame) => frame.type === "hello" ? frame.type : frame.message.type), ["hello", "future_agent_read", "future_agent_write", "agent_permission_response"]);
    assert.equal(received[0].capabilities.binary_chunking_v1, false);
    assert.match(received[0].clientId, /^iris_[0-9a-f]{32}$/);
    assert.equal(received.at(-1).message.response.updatedInput.answers.A, "One");
    const rejected = results.filter((event) => event.event === "message").map((event) => JSON.parse(event.data).message?.payload?.requestId);
    assert.ok(rejected.includes("foreign"));
    assert.ok(rejected.includes("shutdown"));
    assert.ok(rejected.includes("wrong-sender"));
    assert.ok(rejected.includes("unbound"));
    assert.ok(rejected.includes("unknown"));

    const hello = async (clientNamespace) => {
      const pane = { socketPath, agentId: "chosen", clientNamespace };
      let connection;
      try {
        return await new Promise((resolve) => {
          connection = connectManagedChat(pane, (type) => permissions.get(type), (event) => {
            if (event.event === "open") connection.send({ data: JSON.stringify({ type: "hello", clientId: "upstream-client" }) });
            if (event.event === "message") resolve(JSON.parse(event.data).clientId);
          });
        });
      } finally { connection?.close(); }
    };
    relay.close();
    assert.equal(await hello("window"), received[0].clientId);
    assert.notEqual(await hello("other-window"), received[0].clientId);
  } finally {
    relay.close();
    for (const ws of upstream.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
