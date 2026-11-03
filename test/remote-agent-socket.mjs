import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSocketServer, validQuestions } from "../server/remote/agent-socket.js";
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
    hasPhoneSessions: () => true,
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

test("69 질문은 동기 요청 없이 보관하고 hook 종료 뒤 유지한다", async (t) => {
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
  assert.deepEqual(await client.next(), { type: "question.none" });
  assert.equal(built.requests.list().length, 0);
  assert.equal(built.server.questions.list().length, 1);
  client.socket.destroy();
  await until(() => built.server.connectionCount() === 0);
  assert.equal(built.server.questions.list().length, 1);
  assert.equal(validQuestions([...questions, { ...questions[0] }]), false, "질문 원문 중복");
  assert.equal(validQuestions([{ ...questions[0], options: [{ label: "a, b", description: "" }] }]), false);
  assert.equal(validQuestions([{ question: "생략?", header: "생략", options: [{ label: "예" }] }]), true);
  assert.equal(validQuestions([{ question: "미리보기?", header: "미리", options: [{ label: "예", description: "", preview: "```\nx\n```" }] }]), true);
  assert.equal(validQuestions([{ question: "미리보기?", header: "미리", options: [{ label: "예", preview: 3 }] }]), false);
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

const terminalTestQuestions = [{ question: '어느 색?', header: '색', options: [{ label: '파랑', preview: 'terminal only' }] }];
async function ask(built) {
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: 'question-hook', v: 1, paneId: 'known-pane', cliSession: 'session' });
  await client.next();
  client.send({ type: 'question', questions: terminalTestQuestions });
  return client;
}

test('packet63 폰 없음 즉시 터미널 전달·재표시·상태 해제 삭제', async (t) => {
  const logs = [];
  const built = await setup(t, { hasPhoneSessions: () => false, log: (line) => logs.push(line) });
  if (!built) return;
  built.source.question = true;
  const client = await ask(built);
  assert.deepEqual(await client.next(), { type: 'question.none' });
  assert.equal(built.requests.list().length, 0);
  assert.equal(built.server.questions.list().length, 1);
  assert.deepEqual(built.server.questions.list()[0].body.questions[0].options, [{ label: '파랑', description: '' }]);
  assert.deepEqual(logs, ['[remote] question reason=retained']);
  client.socket.destroy();
  await until(() => built.server.connectionCount() === 0);
  assert.equal(built.server.questions.list().length, 1, 'hook 종료 뒤 재연결용 보관');
  built.source.question = false;
  assert.deepEqual(built.server.questions.list(), []);
});

test('69 폰 연결과 무관한 보관·새 질문 교체·세션·기한 삭제', async t => {
  let clock = 0;
  const built = await setup(t, { now: () => clock, log() {} });
  if (!built) return;
  built.source.question = true;
  const first = await ask(built); await first.next(); first.socket.destroy();
  const old = built.server.questions.list()[0].ref;
  const next = await ask(built); await next.next(); next.socket.destroy();
  assert.equal(built.requests.list().length, 0);
  assert.equal(built.server.questions.list().length, 1);
  assert.notEqual(built.server.questions.list()[0].ref, old);
  built.source.sessionUuid = 'other';
  assert.deepEqual(built.server.questions.list(), []);
  delete built.source.sessionUuid;
  const last = await ask(built); await last.next(); last.socket.destroy();
  clock = 86400001;
  assert.deepEqual(built.server.questions.list(), []);
});

test('packet63 다른 pane 보관 분리·세션 종료 알림·거절 사유 내용 없는 로그', async (t) => {
  const logs = [];
  const sources = new Map(['known-pane', 'second-pane'].map((paneId, index) => [paneId,
    { ref: index ? 'b'.repeat(32) : AGENT, kind: 'claude', status: 'blocked', source: { paneId, sessionUuid: 'session' } }]));
  let changed;
  const built = await setup(t, { hasPhoneSessions: () => false, log: (line) => logs.push(line),
    agents: { resolvePane: (paneId) => sources.get(paneId), subscribe(fn) { changed = fn; } } });
  if (!built) return;
  const first = await ask(built);
  await first.next();
  const second = lineClient(built.socketPath);
  await second.ready;
  second.send({ role: 'question-hook', v: 1, paneId: 'second-pane', cliSession: 'session' });
  await second.next();
  second.send({ type: 'question', questions: [{ ...terminalTestQuestions[0], question: '다른 질문?' }] });
  await second.next();
  assert.deepEqual(built.server.questions.list().map((q) => [q.agent, q.body.questions[0].question]),
    [[AGENT, '어느 색?'], ['b'.repeat(32), '다른 질문?']]);
  let notifications = 0;
  built.server.questions.subscribe(() => notifications++);
  sources.delete('known-pane'); changed();
  assert.equal(notifications, 1);
  assert.equal(built.server.questions.list()[0].agent, 'b'.repeat(32));
  second.send({ type: 'question', questions: [], path: '/private/path' });
  await second.next();
  assert.deepEqual(built.server.questions.list(), [], '거절된 새 질문도 이전 질문 제거');
  assert.equal(logs.at(-1), '[remote] question reason=validation-rejected');
  assert.equal(logs.some((line) => line.includes('/private') || line.includes('다른 질문')), false);
});

test('packet63 원격 꺼짐 사유와 등록 기기 없음 사유', async (t) => {
  for (const [reason, overrides] of [['remote-disabled', { isRemoteEnabled: () => false }], ['no-device', { hasRegisteredDevices: () => false }]]) {
    const logs = [];
    const built = await setup(t, { ...overrides, log: (line) => logs.push(line) });
    if (!built) return;
    const client = await ask(built);
    assert.deepEqual(await client.next(), { type: 'question.none' });
    assert.deepEqual(logs, [`[remote] question reason=${reason}`]);
  }
});

test('packet63 보관 개수·전체 크기 상한과 원격 요청 원문 폐기', async (t) => {
  const sources = new Map();
  const built = await setup(t, { hasPhoneSessions: () => false, log() {},
    agents: { resolvePane: (paneId) => sources.get(paneId) } });
  if (!built) return;
  async function add(index, large = false) {
    const paneId = `pane-${index}`;
    sources.set(paneId, { ref: index.toString(16).padStart(32, '0'), kind: 'claude', status: 'blocked',
      source: { paneId, sessionUuid: 'session' } });
    const client = lineClient(built.socketPath);
    await client.ready;
    client.send({ role: 'question-hook', v: 1, paneId, cliSession: 'session' });
    await client.next();
    client.send({ type: 'question', questions: [{ question: large ? 'q'.repeat(8000) : '질문?', header: '확인',
      options: [{ label: '예', description: large ? 'd'.repeat(4000) : '' }] }] });
    await client.next();
    client.socket.destroy();
  }
  for (let index = 1; index <= 4; index++) await add(index, true);
  assert.equal(built.server.questions.list().length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(built.server.questions.list())) <= 32 * 1024);
  for (let index = 5; index <= 38; index++) await add(index);
  assert.equal(built.server.questions.list().length, 32);
});

 test('69 질문 제어문자 제거·빈 선택지 거절·삭제 사유 코드', async t => {
  const logs = [];
  const built = await setup(t, { log: line => logs.push(line) });
  if (!built) return;
  built.source.question = true;
  const client = await ask(built); await client.next();
  client.send({ type: 'question', questions: [{ question: '색?\u0007', header: '색\u001b',
    options: [{ label: '파랑\u0000', description: '설명\u0001' }] }] });
  await client.next();
  assert.deepEqual(built.server.questions.list()[0].body.questions[0], { question: '색?', header: '색',
    multiSelect: false, options: [{ label: '파랑', description: '설명' }] });
  built.source.question = false;
  assert.deepEqual(built.server.questions.list(), []);
  assert.equal(logs.at(-1), '[remote] question reason=computer-answered');
  client.send({ type: 'question', questions: [{ question: '색?', header: '색', options: [{ label: '\u0000' }] }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(built.server.questions.list(), []);
  assert.equal(logs.at(-1), '[remote] question reason=validation-rejected');
  client.socket.destroy();
});

test("승인 hook hint 는 에이전트별로 보관하고 형식이 틀리거나 다른 에이전트면 버린다", async (t) => {
  const built = await setup(t);
  if (!built) return;
  const client = lineClient(built.socketPath);
  await client.ready;
  client.send({ role: "question-hook", v: 1, paneId: "known-pane", cliSession: "session" });
  await client.next();
  client.send({ type: "hint", tool: "Bash", target: "echo a", extra: 1 });
  client.send({ type: "hint", tool: "", target: "x" });
  client.send({ type: "hint", tool: "Bash", target: "x".repeat(301) });
  client.send({ type: "hint", tool: "Edit", target: "/p/a.js" });
  await until(() => built.server.questions.hint(AGENT));
  const found = built.server.questions.hint(AGENT);
  assert.deepEqual(found, { tool: "Edit", target: "/p/a.js" });
  assert.equal(built.server.questions.hint("other-agent"), null);
});
