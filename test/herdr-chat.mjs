import assert from "node:assert/strict";
import test from "node:test";
import { watchHerdrChat } from "../server/paseo-ui/herdr-chat.mjs";

test("카탈로그 제공자의 두 패널과 같은 패널의 두 보기는 각 CLI에만 연결된다", async () => {
  const sent = [], reads = [];
  const panes = new Map(["left", "right"].map(id => [id, { terminal_id: "term-" + id, agent: "example",
    agent_status: "idle", agent_session: { kind: "id", value: id } }]));
  const herdr = {
    paneGet: async id => panes.get(id),
    paneRead: async id => { reads.push(id); return { text: id + " text" }; },
    agentSend: async (id, text) => { sent.push([id, text]); },
  };
  const open = async id => watchHerdrChat({ agent: { paneId: id, terminalId: "term-" + id, sessionUuid: id, agent: "example" },
    herdr, onFrame: frame => assert.equal(frame.timeline[0].message, id + " text"), onError: assert.fail });
  const [left, duplicate, right] = await Promise.all([open("left"), open("left"), open("right")]);
  try {
    assert.deepEqual(reads.sort(), ["left", "right"]);
    left.close();
    await duplicate.action({ type: "agentchat.send", text: "one" });
    await right.action({ type: "agentchat.send", text: "two" });
    panes.get("right").agent_session.value = "changed";
    await assert.rejects(right.action({ type: "agentchat.send", text: "wrong" }), /세션/);
    assert.deepEqual(sent, [["left", "one"], ["right", "two"]]);
  } finally { duplicate.close(); right.close(); }
});

test("Iris의 일반 대화 구독은 릴리스에 추가된 제공자를 Herdr에 연결한다", async t => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await fs.mkdtemp(join(tmpdir(), "iris-chat-adapter-"));
  const old = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = dir;
  const { initAgentChat, handleAgentChat, stopAgentChat } = await import("../server/agent-chat.js");
  const { replace, snapshot } = await import("../server/runtime-state.js");
  const previous = snapshot();
  t.after(async () => {
    await stopAgentChat();
    replace(previous);
    if (old === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = old;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = join(dir, "paseo-ui");
  const bundle = join(root, "builds", "0.17.4-aaaaaaaa");
  await fs.mkdir(bundle, { recursive: true });
  const release = join(root, "embedded", "0.17.4-aaaaaaaa");
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(join(release, "providers.json"), JSON.stringify([{ id: "example", label: "Example", herdrId: "codex-adjacent" }]));
  await fs.writeFile(join(release, "native-handoff-commands.json"), "{}");
  await fs.writeFile(join(release, "provider-overrides.json"), JSON.stringify({ example: { command: ["npx", "-y", "@vendor/example-cli@1.0", "--acp"] } }));
  await fs.writeFile(join(bundle, "terminal-commands.json"), "[]");
  await fs.writeFile(join(root, "current.json"), JSON.stringify({ current: { version: "0.17.4", recipe: "aaaaaaaa" } }));
  const identity = { agent: "codex-adjacent", terminalId: "term", paneId: "pane", sessionUuid: "session" };
  replace({ state: [identity] });
  const calls = [];
  initAgentChat({ herdr: {
    paneGet: async () => ({ agent: identity.agent, terminal_id: "term", agent_session: { kind: "id", value: "session" } }),
    paneRead: async () => ({ text: "first turn" }),
    agentSend: async (...args) => calls.push(args),
  } });
  let frame = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const ws = { _local: true, readyState: 1, send(raw) {
    const m = JSON.parse(raw);
    if (m.type === "agentchat.frame") frame.resolve(m);
    if (m.type === "agentchat.sent") reply.resolve(m);
  } };
  handleAgentChat(ws, { type: "agentchat.open", key: "k", paneId: "pane", session: "session" });
  const state = await frame.promise;
  assert.equal(state.provider, "example");
  assert.equal(state.timeline[0].message, "first turn");
  handleAgentChat(ws, { type: "agentchat.send", key: "k", text: "second turn" });
  assert.equal((await reply.promise).ok, true);
  assert.deepEqual(calls, [["pane", "second turn"]]);
  handleAgentChat(ws, { type: "agentchat.close", key: "k" });
  identity.agent = "example-cli";
  replace({ state: [identity] });
  frame = Promise.withResolvers();
  handleAgentChat(ws, { type: "agentchat.open", key: "k", paneId: "pane", session: "session" });
  assert.equal((await frame.promise).provider, "example");
  handleAgentChat(ws, { type: "agentchat.close", key: "k" });
});

test("일반 실행한 CLI가 있는 터미널은 이전 Paseo 실행 예약에 연결되지 않는다", async (t) => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { initAgentChat, handleAgentChat, stopAgentChat } = await import("../server/agent-chat.js");
  const { replace, snapshot } = await import("../server/runtime-state.js");
  const { reserveManagedPane } = await import("../server/paseo-ui/managed-pane.js");
  const old = process.env.IRIS_STATE_DIR;
  const previous = snapshot();
  const dir = await fs.mkdtemp(join(tmpdir(), "iris-chat-owner-"));
  process.env.IRIS_STATE_DIR = dir;
  t.after(async () => {
    await stopAgentChat();
    replace(previous);
    if (old === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = old;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const reservation = reserveManagedPane("pane", "gemini", "0.17.4-aaaaaaaa", dir, "terminal");
  await fs.writeFile(join(reservation.stateDir, "startup-error.json"), JSON.stringify({ message: "previous launch failed" }));
  const live = { paneId: "pane", terminalId: "terminal", agent: "agy", sessionUuid: "current", sessionFile: join(dir, "unused") };
  replace({ state: [live] });
  initAgentChat({ herdr: {}, paseoUi: false });
  let frame = Promise.withResolvers();
  const ws = { _local: true, readyState: 1, send(raw) {
    const message = JSON.parse(raw);
    if (message.type === "agentchat.frame") frame.resolve(message);
  } };
  handleAgentChat(ws, { type: "agentchat.open", key: "k", paneId: "pane", session: "current" });
  const result = await frame.promise;
  assert.equal(result.kind, "snapshot");
  assert.equal(result.source, "agy");

  handleAgentChat(ws, { type: "agentchat.close", key: "k" });
  await fs.unlink(join(reservation.stateDir, "startup-error.json"));
  replace({ state: [{ paneId: "pane", terminalId: "terminal", agent: "iris-paseo" }] });
  frame = Promise.withResolvers();
  handleAgentChat(ws, { type: "agentchat.open", key: "k", paneId: "pane" });
  replace({ state: [live] });
  const timeout = setTimeout(() => frame.reject(new Error("실행 중인 세션을 찾지 못했습니다")), 5000);
  try { assert.equal((await frame.promise).source, "agy"); }
  finally { clearTimeout(timeout); }
});
