import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createCodexAppServerProcess } from "../server/paseo-ui/codex-shared-transport.mjs";

test("Paseo 연결을 닫아도 같은 Codex 서버의 다른 연결에서 스레드를 계속 조회", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iris-codex-"));
  const socketPath = path.join(dir, "c");
  const server = createServer();
  const endpoint = new WebSocketServer({ server });
  endpoint.on("connection", (ws) => ws.on("message", (data) => {
    const { id } = JSON.parse(data);
    ws.send(JSON.stringify({ id, result: { data: ["thread-A", "thread-B"] } }));
  }));
  server.listen(socketPath);
  await once(server, "listening");
  const processPort = createCodexAppServerProcess({ socketPath });
  const first = processPort.spawn();
  const second = processPort.spawn();
  try {
    async function query(child, id) {
      const result = once(child.stdout, "data");
      child.stdin.write(`{"id":${id},"method":"thread/loaded/list",`);
      child.stdin.write('"params":{}}\n');
      const [data] = await result;
      return JSON.parse(data);
    }
    assert.deepEqual(await query(first, 1), { id: 1, result: { data: ["thread-A", "thread-B"] } });
    const exit = once(first, "exit");
    first.stdin.end();
    assert.equal((await exit)[0], 0);
    assert.deepEqual(await query(second, 2), { id: 2, result: { data: ["thread-A", "thread-B"] } });
  } finally {
    first.kill();
    second.kill();
    for (const ws of endpoint.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { force: true, recursive: true });
  }
});

test("닫힌 Codex 소켓의 동기 send 실패는 요청 타이머와 대기 항목을 남기지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iris-codex-"));
  const socketPath = path.join(dir, "c");
  const server = createServer();
  const endpoint = new WebSocketServer({ server });
  endpoint.on("connection", () => {});
  server.listen(socketPath);
  await once(server, "listening");
  const processPort = createCodexAppServerProcess({ socketPath });
  const child = processPort.spawn();
  await once(endpoint, "connection");
  child.kill();
  await once(child, "exit");
  const started = Date.now();
  await assert.rejects(processPort.request("thread/read", { threadId: "thread-A" }), /WebSocket|socket|연결/);
  assert.ok(Date.now() - started < 500);
  for (const ws of endpoint.clients) ws.terminate();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { force: true, recursive: true });
});
