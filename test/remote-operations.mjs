import assert from "node:assert/strict";
import test from "node:test";

import { createAgentStore } from "../server/remote/agents.js";
import { createMessageBridge } from "../server/remote/messaging.js";
import { createTerminalFeature } from "../server/remote/features/terminal.js";
import { installFeatureOperations } from "../server/remote/ops/features.js";
import { createMessageOperation } from "../server/remote/ops/message.js";
import { createStopOperation } from "../server/remote/ops/stop.js";
import { createWatchOperation } from "../server/remote/ops/watch.js";
import { createRequestStore } from "../server/remote/requests.js";

function setupAgents() {
  let listener = null;
  const runtime = { state: [
    { paneId: "secret-pane", workspaceId: "secret-space", tabLabel: "작업", agent: "codex", status: "working",
      tabId: "tab-two", sessionUuid: "11111111-1111-4111-8111-111111111111", sessionFile: "/private/transcript.jsonl" },
    { paneId: "idle-pane", parentPaneId: "secret-pane", workspaceId: "secret-space", tabId: "tab-one",
      agent: "claude", status: "idle", sessionUuid: "22222222-2222-4222-8222-222222222222" },
  ], workspaces: [{ id: "secret-space", label: "표시 이름", folder: "/private/project" }],
  tabs: { "secret-space": [{ tabId: "tab-two" }, { tabId: "tab-one" }] } };
  let random = 1;
  const agents = createAgentStore({ getSnapshot: () => runtime, subscribeSnapshot(fn) { listener = fn; return () => {}; },
    randomBytes: (size) => Buffer.alloc(size, random++) });
  return { agents, runtime, changed: () => listener() };
}

test("에이전트 투영은 ref를 고정하고 pane·경로·세션 UUID를 내보내지 않는다", () => {
  const { agents, changed } = setupAgents();
  const first = agents.list();
  changed();
  const second = agents.list();
  assert.equal(first[0].ref, second[0].ref);
  assert.equal(first[0].name, "작업");
  assert.equal(first[0].sessionOrder, 0);
  assert.equal(first[1].sessionOrder, 1);
  assert.equal(first[1].parent, first[0].ref);
  assert.equal(first[0].spaceRef, first[1].spaceRef);
  const encoded = JSON.stringify(first);
  for (const secret of ["secret-pane", "secret-space", "/private/project", "/private/transcript.jsonl",
    "11111111-1111-4111-8111-111111111111"]) assert.equal(encoded.includes(secret), false, secret);
  agents.close();
});

test("에이전트 투영은 스페이스와 탭 순서대로 세션 순서를 매긴다", () => {
  let random = 40;
  const runtime = {
    state: [
      { paneId: "later-space", workspaceId: "space-two", tabId: "tab-z", tabLabel: "셋째" },
      { paneId: "later-tab", workspaceId: "space-one", tabId: "tab-b", tabLabel: "둘째" },
      { paneId: "first-tab", workspaceId: "space-one", tabId: "tab-a", tabLabel: "첫째" },
    ],
    workspaces: [{ id: "space-one", label: "하나" }, { id: "space-two", label: "둘" }],
    tabs: {
      "space-one": [{ tabId: "tab-a" }, { tabId: "tab-b" }],
      "space-two": [{ tabId: "tab-z" }],
    },
  };
  const agents = createAgentStore({
    getSnapshot: () => runtime,
    randomBytes: (size) => Buffer.alloc(size, random++),
  });
  const projected = agents.list();
  assert.deepEqual(projected.map((agent) => agent.name), ["첫째", "둘째", "셋째"]);
  assert.deepEqual(projected.map((agent) => agent.spaceOrder), [0, 0, 1]);
  assert.deepEqual(projected.map((agent) => agent.sessionOrder), [0, 1, 0]);
  agents.close();
});

test("중지는 working Claude·Codex pane에 Esc 한 번만 보낸다", async () => {
  const { agents } = setupAgents();
  const calls = [];
  const stop = createStopOperation({ agents, getHerdr: () => ({ paneSendText: async (...args) => calls.push(args) }) });
  const [working, idle] = agents.list();
  assert.deepEqual(await stop({}, { rid: "s1", agent: working.ref }), { type: "agent.stop.result", rid: "s1", result: "sent" });
  assert.deepEqual(calls, [["secret-pane", "\x1b"]]);
  assert.deepEqual(await stop({}, { rid: "s2", agent: idle.ref }), { type: "agent.stop.result", rid: "s2", result: "not-working" });
  assert.equal(calls.length, 1);
  assert.equal((await stop({}, { rid: "s3", agent: "f".repeat(32) })).error.code, "forbidden");
  agents.close();
});

test("Codex 메시지는 셸 없이 정해진 argv와 10초 제한을 쓴다", async () => {
  const calls = [];
  const messages = createMessageBridge({ execFile(file, args, options, callback) {
    calls.push({ file, args, options }); callback(null, "", "");
  } });
  const { agents } = setupAgents();
  const send = createMessageOperation({ agents, messages });
  const result = await send({}, { rid: "m1", agent: agents.list()[0].ref, text: "본문; $(touch no)" });
  assert.deepEqual(result, { type: "agent.message.result", rid: "m1", result: "sent" });
  assert.deepEqual(calls[0], { file: "codex", args: ["queue", "--thread",
    "11111111-1111-4111-8111-111111111111", "--message", "본문; $(touch no)"],
  options: { timeout: 10_000, maxBuffer: 64 * 1024 } });
  agents.close();
});

test("채널 없는 Claude 메시지는 CR 본문을 붙여넣고 마지막 Enter 한 번으로 제출한다", async () => {
  const { agents } = setupAgents();
  const calls = [];
  const refreshed = [];
  const send = createMessageOperation({
    agents,
    messages: createMessageBridge({
      getHerdr: () => ({ paneSendText: async (...args) => calls.push(args) }),
    }),
    transcripts: { refreshAgent: (agent) => refreshed.push(agent) },
  });
  assert.deepEqual(await send({}, { rid: "m2", agent: agents.list()[1].ref, text: "first\r/exit" }),
    { type: "agent.message.result", rid: "m2", result: "sent" });
  assert.deepEqual(calls, [["idle-pane", "\x1b[200~first\n/exit\x1b[201~\r"]]);
  assert.deepEqual(refreshed, [agents.list()[1].ref]);
  agents.close();
});

test("같은 pane의 세션 UUID가 바뀌면 이전 ref로 대화와 터미널 입력을 거부한다", async () => {
  const { agents, runtime, changed } = setupAgents();
  const oldRef = agents.list()[1].ref;
  runtime.state[1].sessionUuid = "33333333-3333-4333-8333-333333333333";
  changed();
  assert.notEqual(agents.list()[1].ref, oldRef);

  const calls = [];
  const getHerdr = () => ({ paneSendText: async (...args) => calls.push(args) });
  const send = createMessageOperation({ agents, messages: createMessageBridge({ getHerdr }) });
  assert.equal((await send({}, { rid: "stale-message", agent: oldRef, text: "본문" })).error.code, "forbidden");

  const terminal = createTerminalFeature({ agents, getHerdr, send() {},
    setTimer: () => ({ unref() {} }), clearTimer() {},
    keyRows: { get: () => ({ keys: [], defaults: [], macShortcuts: [] }), set: () => ({}) } });
  const table = new Map();
  installFeatureOperations(table, { terminal, browser: {}, source: {} });
  assert.equal((await table.get("terminal.input")({ connId: "phone" },
    { rid: "stale-input", agent: oldRef, text: "pwd" })).error.code, "forbidden");
  assert.equal((await table.get("terminal.key")({}, { rid: "stale-key", agent: oldRef, key: "Enter",
    modifiers: { ctrl: false, alt: false, shift: false, cmd: false } })).error.code, "forbidden");
  assert.deepEqual(calls, []);
  terminal.close();
  agents.close();
});

test("pane 입력 직전 세션 UUID가 바뀌면 입력을 취소한다", async () => {
  const messageFixture = setupAgents();
  const messageRef = messageFixture.agents.list()[1].ref;
  const messageCalls = [];
  let messageSwapped = false;
  const messageHerdr = () => {
    if (!messageSwapped) {
      messageSwapped = true;
      messageFixture.runtime.state[1].sessionUuid = "44444444-4444-4444-8444-444444444444";
      messageFixture.changed();
    }
    return { paneSendText: async (...args) => messageCalls.push(args) };
  };
  const send = createMessageOperation({ agents: messageFixture.agents,
    messages: createMessageBridge({ getHerdr: messageHerdr }) });
  assert.equal((await send({}, { rid: "message-race", agent: messageRef, text: "본문" })).error.code, "forbidden");
  assert.deepEqual(messageCalls, []);
  messageFixture.agents.close();

  const terminalFixture = setupAgents();
  const terminalRef = terminalFixture.agents.list()[1].ref;
  const terminalCalls = [];
  let terminalSwapped = false;
  const terminal = createTerminalFeature({ agents: terminalFixture.agents, getHerdr: () => {
    if (!terminalSwapped) {
      terminalSwapped = true;
      terminalFixture.runtime.state[1].sessionUuid = "55555555-5555-4555-8555-555555555555";
      terminalFixture.changed();
    }
    return { paneSendText: async (...args) => terminalCalls.push(args) };
  }, send() {}, setTimer: () => ({ unref() {} }), clearTimer() {},
  keyRows: { get: () => ({ keys: [], defaults: [], macShortcuts: [] }), set: () => ({}) } });
  const table = new Map();
  installFeatureOperations(table, { terminal, browser: {}, source: {} });
  assert.equal((await table.get("terminal.input")({ connId: "phone" },
    { rid: "input-race", agent: terminalRef, text: "pwd" })).error.code, "forbidden");
  assert.deepEqual(terminalCalls, []);
  terminal.close();
  terminalFixture.agents.close();
});

test("Claude 채널 쓰기 완료는 sent로 투영한다", async () => {
  const { agents } = setupAgents();
  const messages = createMessageBridge();
  const claude = agents.list()[1];
  const unregister = messages.registerClaudeMessageChannel({
    canSend: (source) => source.paneId === "idle-pane",
    send: async (_source, text) => text === "본문" ? "sent" : "failed",
  });
  const send = createMessageOperation({ agents, messages });
  assert.deepEqual(await send({}, { rid: "m3", agent: claude.ref, text: "본문" }),
    { type: "agent.message.result", rid: "m3", result: "sent" });
  unregister();
  agents.close();
});

test("watch는 최초 목록을 보내고 500ms 안의 변경을 한 번에 합친다", () => {
  let time = 0;
  const timers = [];
  const { agents, runtime, changed } = setupAgents();
  let random = 20;
  const requests = createRequestStore({ randomBytes: (size) => Buffer.alloc(size, random++),
    setTimer: () => ({ unref() {} }), clearTimer() {} });
  const sent = [];
  const watch = createWatchOperation({ agents, requests, send: (_connId, value) => sent.push(value), now: () => time,
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimer() {} });
  const initial = watch.handle({ connId: "c" }, { rid: "w1" });
  assert.deepEqual(initial.map((value) => value.type), ["agents", "requests"]);
  assert.equal(watch.handle({ connId: "c" }, { rid: "w2" }).error.code, "invalid-request");
  runtime.state[0].status = "idle";
  changed();
  requests.add({ agent: agents.list()[0].ref, kind: "claude-permission", createdAt: 1, expiresAt: 10,
    body: { tool: "Read", description: "", input: "x" } }, async () => "delivered");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 500);
  time = 500;
  timers[0].fn();
  assert.deepEqual(sent.map((value) => value.type), ["agents", "requests"]);
  watch.close();
  requests.close();
  agents.close();
});

test("로컬 Codex에는 daemon 여부와 관계없이 pane으로 한 번만 전송한다", async () => {
  const { agents } = setupAgents();
  const calls = [];
  let fail = false;
  const messages = createMessageBridge({
    execFile() { assert.fail("로컬 pane 메시지를 공유 daemon으로 보내면 안 된다"); },
    getHerdr: () => ({ paneSendText: async (...args) => {
      calls.push(args);
      if (fail) throw Error("응답을 받기 전에 소켓이 닫힘");
    } }),
  });
  const send = createMessageOperation({ agents, messages });
  const agent = agents.list()[0].ref;
  assert.equal((await send({}, { rid: "local-one", agent, text: "첫째\r\n둘째" })).result, "sent");
  assert.deepEqual(calls, [["secret-pane", "\x1b[200~첫째\n둘째\x1b[201~\r"]]);
  fail = true;
  assert.equal((await send({}, { rid: "local-two", agent, text: "다음" })).result, "failed");
  assert.equal(calls.length, 2);
  agents.close();
});

test("Codex도 전송 직전 대화가 바뀌면 이전 ref의 입력을 취소한다", async () => {
  const { agents, runtime, changed } = setupAgents();
  const ref = agents.list()[0].ref;
  const calls = [];
  const messages = createMessageBridge({ getHerdr: () => {
    runtime.state[0].sessionUuid = "44444444-4444-4444-8444-444444444444";
    changed();
    return { paneSendText: async (...args) => calls.push(args) };
  } });
  const send = createMessageOperation({ agents, messages });
  assert.equal((await send({}, { rid: "local-race", agent: ref, text: "본문" })).error.code, "forbidden");
  assert.deepEqual(calls, []);
  agents.close();
});

test("snapshot이 오래됐어도 Codex 종료나 native 대화 변경 뒤에는 입력하지 않는다", async () => {
  const { agents } = setupAgents();
  const calls = [];
  let pane = {};
  const messages = createMessageBridge({ getHerdr: () => ({
    paneGet: async () => pane,
    paneSendText: async (...args) => calls.push(args),
  }) });
  const send = createMessageOperation({ agents, messages });
  const agent = agents.list()[0].ref;
  assert.equal((await send({}, { rid: "exited", agent, text: "본문" })).error.code, "forbidden");
  pane = { agent: "codex", agent_session: { kind: "id", value: "44444444-4444-4444-8444-444444444444" } };
  assert.equal((await send({}, { rid: "switched", agent, text: "본문" })).error.code, "forbidden");
  assert.deepEqual(calls, []);
  pane.agent_session.value = "11111111-1111-4111-8111-111111111111";
  assert.equal((await send({}, { rid: "current", agent, text: "본문" })).result, "sent");
  assert.deepEqual(calls, [["secret-pane", "\x1b[200~본문\x1b[201~\r"]]);
  agents.close();
});
