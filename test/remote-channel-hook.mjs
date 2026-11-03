import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptedPermissionVerdict } from "../server/remote/channel/protocol.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANNEL = path.join(ROOT, "server/remote/channel/iris-channel.mjs");
const HOOK = path.join(ROOT, "server/remote/hooks/ask-question.mjs");

function jsonLines(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line) onLine(JSON.parse(line));
    }
  });
}

async function fakeSocket(t, onMessage) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-channel-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, "agent.sock");
  const server = net.createServer((socket) => jsonLines(socket, (value) => onMessage(socket, value)));
  try { await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject)); }
  catch (cause) {
    if (cause?.code === "EPERM") { t.skip("샌드박스가 Unix 소켓 listen을 막음"); return null; }
    throw cause;
  }
  t.after(() => server.close());
  return socketPath;
}

test("채널 서버는 MCP 초기화·허용 relay·메시지 알림을 stdio로 전달한다", async (t) => {
  const received = [];
  let agentSocket;
  const socketPath = await fakeSocket(t, (socket, value) => {
    received.push(value);
    agentSocket = socket;
  });
  if (!socketPath) return;
  const child = spawn(process.execPath, [CHANNEL, socketPath], {
    env: { ...process.env, HERDR_PANE_ID: "pane", CLAUDE_CODE_SESSION_ID: "session" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const output = [];
  jsonLines(child.stdout, (value) => output.push(value));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  while (!output.length || !agentSocket) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output[0].result.capabilities.experimental, { "claude/channel": {}, "claude/channel/permission": {} });
  assert.equal("tools" in output[0].result.capabilities, false);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel/permission_request",
    params: { request_id: "abcde", tool_name: "Bash", description: "실행", input_preview: "pwd" } })}\n`);
  while (!received.some((value) => value.type === "permission_request")) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.find((value) => value.type === "permission_request").seq, 1);
  agentSocket.write(`${JSON.stringify({ type: "permission_verdict", requestId: "abcde", seq: 1, behavior: "allow" })}\n`);
  agentSocket.write(`${JSON.stringify({ type: "message", msgId: "m1", content: "휴대폰 메시지" })}\n`);
  while (!output.some((value) => value.method === "notifications/claude/channel")) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(output.some((value) => value.method === "notifications/claude/channel/permission"
    && value.params.request_id === "abcde" && value.params.behavior === "allow"));
  assert.deepEqual(output.find((value) => value.method === "notifications/claude/channel").params,
    { content: "휴대폰 메시지", meta: { sender: "iris_phone", msg_id: "m1" } });
  while (!received.some((value) => value.type === "message_written")) await new Promise((resolve) => setImmediate(resolve));
});

test("채널 서버는 소켓 연결이 없어도 도구 없는 MCP capability를 초기화한다", async (t) => {
  const child = spawn(process.execPath, [CHANNEL, path.join(os.tmpdir(), "missing-iris-channel.sock")], {
    env: { ...process.env, HERDR_PANE_ID: "pane", CLAUDE_CODE_SESSION_ID: "session" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const output = [];
  jsonLines(child.stdout, (value) => output.push(value));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  while (!output.length) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output[0].result.capabilities, {
    experimental: { "claude/channel": {}, "claude/channel/permission": {} },
  });
});

test("69 질문 hook은 서버 응답 없이 빈 출력으로 즉시 끝난다", async (t) => {
  const questions = [
    { question: "하나?", header: "하나", multiSelect: false, options: [{ label: "A", description: "" }] },
    { question: "여러 개?", header: "여러", multiSelect: true, options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
    { question: "직접?", header: "직접", multiSelect: false, options: [{ label: "Z", description: "" }] },
  ];
  const received = [];
  const socketPath = await fakeSocket(t, (_socket, value) => received.push(value));
  if (!socketPath) return;
  const child = spawn(process.execPath, [HOOK, socketPath], {
    env: { ...process.env, HERDR_PANE_ID: "pane", CLAUDE_CODE_SESSION_ID: "session" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = Date.now();
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions } }));
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  assert.equal(stdout, "");
  assert.ok(Date.now() - started < 700);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(received.find(v => v.type === 'question').questions, questions);

});

test("질문 hook은 소켓 실패와 대상 아닌 입력에서 빈 출력으로 끝난다", async () => {
  for (const input of [
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } },
  ]) {
    const child = spawn(process.execPath, [HOOK, path.join(os.tmpdir(), "missing-iris-agent.sock")], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify(input));
    assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
    assert.equal(stdout, "");
  }
});

test("채널 verdict는 가장 최근 request_id와 순번이 모두 일치할 때만 만든다", () => {
  const latest = { requestId: "new", seq: 2 };
  assert.deepEqual(acceptedPermissionVerdict(latest, {
    type: "permission_verdict", requestId: "new", seq: 2, behavior: "allow",
  }), { request_id: "new", behavior: "allow" });
  assert.equal(acceptedPermissionVerdict(latest, {
    type: "permission_verdict", requestId: "old", seq: 2, behavior: "deny",
  }), null);
  // 같은 request_id 를 재사용한 이전 요청의 답
  assert.equal(acceptedPermissionVerdict(latest, {
    type: "permission_verdict", requestId: "new", seq: 1, behavior: "allow",
  }), null);
  assert.equal(acceptedPermissionVerdict(null, {
    type: "permission_verdict", requestId: "new", seq: 2, behavior: "allow",
  }), null);
});


test('69 서버 부재에도 수백 ms 이내 빈 출력 종료', async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK, path.join(os.tmpdir(), 'absent-69.sock')], {
    env: { ...process.env, HERDR_PANE_ID: 'pane' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '계속?', header: '확인', options: [{ label: '예' }] }] } }));
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  assert.equal(stdout, ''); assert.ok(Date.now() - started < 700);
});

test("승인 hook은 도구 이름·대상을 hint 로 보내고 빈 출력으로 끝난다", async (t) => {
  const received = [];
  const socketPath = await fakeSocket(t, (_socket, value) => received.push(value));
  if (!socketPath) return;
  const run = async input => {
    const child = spawn(process.execPath, [HOOK, socketPath], {
      env: { ...process.env, HERDR_PANE_ID: "pane", CLAUDE_CODE_SESSION_ID: "session" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stdin.end(JSON.stringify(input));
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 0);
    assert.equal(stdout, "");
  };
  await run({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo a\n  && echo b", description: "x" } });
  await run({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: { file_path: "/p/a.js", old_string: "1", new_string: "2" } });
  await run({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "계획" } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const hints = received.filter(value => value.type === "hint");
  assert.deepEqual(hints, [
    { type: "hint", tool: "Bash", target: "echo a && echo b" },
    { type: "hint", tool: "Edit", target: "/p/a.js" },
    { type: "hint", tool: "ExitPlanMode", target: "" },
  ]);
});
