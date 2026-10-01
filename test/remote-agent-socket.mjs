import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSocketServer, shouldWaitForQuestion, validQuestions } from "../server/remote/agent-socket.js";
import { createRequestStore } from "../server/remote/requests.js";

const AGENT = "a".repeat(32);

function lineClient(socketPath) {
  const socket = net.createConnection(socketPath);
  let buffer = "";
  const waiting = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.shift()?.(value);
    }
  });
  return {
    socket,
    send(value) { socket.write(`${JSON.stringify(value)}\n`); },
    next() { return new Promise((resolve) => waiting.push(resolve)); },
    ready: new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject)),
  };
}

// 소켓 전달은 이벤트 루프 몇 바퀴 뒤
async function until(ready, limitMs = 2_000) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > limitMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-agent-socket-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, "remote", "agent.sock");
  let random = 1;
  const requests = createRequestStore({
    randomBytes: (size) => Buffer.alloc(size, random++),
    agentRefForPane: (paneId) => paneId === "known-pane" ? AGENT : null,
  });
  const source = { paneId: "known-pane", agent: "claude", tabLabel: "Claude" };
  const server = createAgentSocketServer({
    socketPath,
    agents: { resolvePane: (paneId) => paneId === source.paneId ? { ref: AGENT, kind: "claude", source } : null },
    requests,
    isRemoteEnabled: () => true,
    hasRegisteredDevices: () => true,
    ...overrides,
  });
  try { await server.start(); }
  catch (cause) {
    requests.close();
    if (cause?.code === "EPERM") { t.skip("샌드박스가 Unix 소켓 listen을 막음"); return null; }
    throw cause;
  }
  t.after(async () => { await server.stop(); requests.close(); });
  return { root, socketPath, requests, server, source };
}

test("에이전트 소켓은 폴더 0700·소켓 0600으로 열고 모르는 pane hello를 닫는다", async (t) => {
  const built = await setup(t);
  if (!built) return;
  assert.equal((await fsp.stat(path.dirname(built.socketPath))).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(built.socketPath)).mode & 0o777, 0o600);
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: "channel", v: 1, paneId: "unknown", cliSession: "session" });
  await new Promise((resolve) => client.socket.once("close", resolve));
  assert.equal(built.server.connectionCount(), 0);
});

test("허용 요청은 request_id 가 같아도 최신 요청의 답만 돌려준다", async (t) => {
  const built = await setup(t);
  if (!built) return;
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: "channel", v: 1, paneId: "known-pane", cliSession: "session" });
  assert.equal((await client.next()).type, "hello.ok");
  client.send({ type: "permission_request", requestId: "same", seq: 1, tool: "Read", description: "읽기", input: "a" });
  await until(() => built.requests.list().length === 1);
  const first = built.requests.list()[0];
  client.send({ type: "permission_request", requestId: "same", seq: 2, tool: "Write", description: "쓰기", input: "b" });
  await until(() => built.requests.list().some((entry) => entry.body.tool === "Write"));
  const second = built.requests.list().find((entry) => entry.body.tool === "Write");
  assert.equal(await built.requests.answer(first.ref, { behavior: "allow" }), "expired");
  const answer = built.requests.answer(second.ref, { behavior: "deny" });
  assert.deepEqual(await client.next(), { type: "permission_verdict", requestId: "same", seq: 2, behavior: "deny" });
  assert.equal(await answer, "delivered");
});

test("질문은 형식을 검사하고 먼저 온 Mac 답을 hook에 전달한다", async (t) => {
  const built = await setup(t);
  if (!built) return;
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: "question-hook", v: 1, paneId: "known-pane", cliSession: "session" });
  await client.next();
  const questions = [{ question: "색?", header: "색", multiSelect: true, options: [
    { label: "빨강", description: "" }, { label: "파랑", description: "" },
  ] }];
  client.send({ type: "question", questions });
  await until(() => built.requests.list().length === 1);
  const pending = built.requests.list()[0];
  const answer = built.requests.answer(pending.ref, { answers: [{ labels: ["파랑", "빨강"] }] });
  assert.deepEqual(await client.next(), { type: "question.answer", answers: [{ labels: ["파랑", "빨강"] }] });
  assert.equal(await answer, "delivered");
  assert.equal(validQuestions([...questions, { ...questions[0] }]), false, "질문 원문 중복");
  assert.equal(validQuestions([{ ...questions[0], options: [{ label: "a, b", description: "" }] }]), false);
  assert.equal(validQuestions([{ question: "생략?", header: "생략", options: [{ label: "예" }] }]), true);
});

test("등록 기기가 없거나 원격을 끄면 질문 hook을 결정 없이 즉시 푼다", async (t) => {
  const built = await setup(t, { hasRegisteredDevices: () => false });
  if (!built) return;
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: "question-hook", v: 1, paneId: "known-pane", cliSession: "session" });
  await client.next();
  client.send({ type: "question", questions: [{ question: "계속?", header: "확인", multiSelect: false,
    options: [{ label: "예", description: "" }] }] });
  assert.deepEqual(await client.next(), { type: "question.none" });
});

test("남은 경로가 소켓이 아니면 지우지 않고 시작을 거부한다", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-agent-stale-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const socketPath = path.join(remote, "agent.sock");
  await fsp.mkdir(remote);
  await fsp.writeFile(socketPath, "keep");
  const server = createAgentSocketServer({ socketPath, agents: { resolvePane: () => null },
    requests: { cancel() {} } });
  await assert.rejects(server.start(), { code: "EACCES" });
  assert.equal(await fsp.readFile(socketPath, "utf8"), "keep");
});

test("질문 대기는 형식·원격 상태·등록 기기를 모두 요구한다", () => {
  const questions = [{ question: "계속?", header: "확인", multiSelect: false,
    options: [{ label: "예", description: "" }] }];
  assert.equal(shouldWaitForQuestion(questions, true, 1), true);
  assert.equal(shouldWaitForQuestion(questions, false, 1), false);
  assert.equal(shouldWaitForQuestion(questions, true, 0), false);
  assert.equal(shouldWaitForQuestion([], true, 1), false);
});
