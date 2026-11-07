import assert from "node:assert/strict";
import test from "node:test";

import { chunkMessages, fitMessage } from "../server/remote/features/chat-frames.js";
import { createPaseoFeature } from "../server/remote/features/paseo.js";
import { isRemoteRequest } from "../server/remote/contract/requests.js";

const HOME = ["", "Users", "mac-user"].join("/");
const CONN = "c".repeat(32);
const AGENT = "a".repeat(32);

const message = (id, text, role = "assistant") => ({ id, role, ts: 1, blocks: [{ type: "text", text }] });
const size = (value) => Buffer.byteLength(JSON.stringify(value));

test("큰 메시지는 상한 안으로 잘라 표시하고 묶음은 상한을 넘지 않는다", () => {
  const big = message("m1", "가".repeat(100_000));
  const fitted = fitMessage(big, 8_000);
  assert.ok(size(fitted) <= 8_000);
  assert.match(fitted.blocks[0].text, /잘림/);
  assert.equal(fitMessage(message("m2", "짧음"), 8_000).blocks[0].text, "짧음");
  const groups = chunkMessages(Array.from({ length: 50 }, (_, i) => message(`m${i}`, "나".repeat(1_000))), 10_000);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat().map((m) => m.id), Array.from({ length: 50 }, (_, i) => `m${i}`));
  for (const group of groups) assert.ok(size(group) <= 10_000);
  const crowded = { id: "x", role: "assistant", ts: 1, blocks: Array.from({ length: 400 }, () => ({ type: "text", text: "z".repeat(200) })) };
  assert.ok(size(fitMessage(crowded, 4_000)) <= 4_000);
});

function fixture(overrides = {}) {
  const sent = [];
  const handled = [];
  const panes = [];
  const grants = [];
  let ui = { phase: "building", version: null, url: null, message: "빌드 중" };
  const timers = [];
  const backend = {
    handle(ws, msg) { handled.push({ ws, msg }); },
    uiStatus: () => ui,
  };
  const feature = createPaseoFeature({
    chatBackend: backend,
    paseoGrant: (grant) => { grants.push(grant); return true; },
    paseoPane: (pane) => { panes.push(pane); return true; },
    getServerPort: () => 4271,
    send: (connId, projected) => sent.push({ connId, projected }),
    agents: { resolve: (ref) => (ref === AGENT ? { source: { paneId: "w1:p2" } } : null) },
    setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    ...overrides,
  });
  return { feature, sent, handled, panes, grants, timers, backend, setUi: (next) => { ui = next; } };
}

test("티켓은 Iris 서버 포트로 등록된다", async () => {
  const f = fixture();
  const result = await f.feature.open({ connId: CONN, nodeId: "n1" });
  assert.equal(result.ok, true);
  assert.match(result.ticket, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.grants[0], { connId: CONN, ticket: result.ticket, nodeId: "n1", port: 4271 });
});

test("백엔드나 등록 함수가 없으면 능력이 없다", async () => {
  const f = fixture({ chatBackend: undefined });
  assert.equal(f.feature.available(), false);
  assert.equal((await f.feature.open({ connId: CONN, nodeId: "n1" })).code, "unavailable");
  assert.equal(f.feature.chatOpen({ connId: CONN }, { agent: AGENT }).code, "unavailable");
});

test("chat.open 은 pane id 대신 임의 key 를 주고 가짜 로컬 연결로 대화를 연다", () => {
  const f = fixture();
  const result = f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  assert.equal(result.ok, true);
  assert.match(result.key, /^[0-9a-f]{32}$/);
  assert.notEqual(result.key, "w1:p2");
  assert.deepEqual(f.panes[0], { connId: CONN, token: result.key, paneId: "w1:p2" });
  const open = f.handled.at(-1);
  assert.deepEqual(open.msg, { type: "agentchat.open", key: result.key, paneId: "w1:p2" });
  assert.equal(open.ws._local, true);
  assert.equal(open.ws.readyState, 1);
  assert.equal(f.sent.some((entry) => entry.projected.type === "chat.ui" && entry.projected.phase === "building"), true);
  assert.equal(f.feature.chatOpen({ connId: CONN }, { agent: "b".repeat(32) }).code, "forbidden");
});

test("대화 프레임은 원격 프레임으로 나뉘어 가고 이전 대화는 뒤쪽 묶음부터 간다", () => {
  const f = fixture();
  const { key } = f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  const ws = f.handled[0].ws;
  const messages = Array.from({ length: 120 }, (_, i) => message(`m${i}`, "다".repeat(2_000)));
  ws.send(JSON.stringify({ type: "agentchat.frame", key, kind: "snapshot", messages, hasOlder: true }));
  const frames = f.sent.filter((e) => e.projected.type === "chat.frame").map((e) => e.projected);
  assert.ok(frames.length > 1);
  assert.equal(frames[0].kind, "snapshot");
  assert.equal(frames[0].hasOlder, true);
  assert.ok(frames.slice(1).every((frame) => frame.kind === "append" && frame.hasOlder === undefined));
  assert.deepEqual(frames.flatMap((frame) => frame.messages.map((m) => m.id)), messages.map((m) => m.id));
  for (const frame of frames) assert.ok(size(frame) < 60 * 1024);

  f.sent.length = 0;
  ws.send(JSON.stringify({ type: "agentchat.older", key, messages, hasOlder: false }));
  const older = f.sent.map((e) => e.projected).filter((e) => e.type === "chat.older");
  assert.ok(older.length > 1);
  assert.deepEqual(older.reverse().flatMap((frame) => frame.messages.map((m) => m.id)), messages.map((m) => m.id));

  f.sent.length = 0;
  ws.send(JSON.stringify({ type: "agentchat.frame", key, kind: "missing", reason: "기록 없음" }));
  assert.deepEqual(f.sent[0].projected, { type: "chat.frame", key, kind: "missing", reason: "기록 없음" });
  f.sent.length = 0;
  ws.send(JSON.stringify({ type: "agentchat.frame", key: "d".repeat(32), kind: "append", messages }));
  assert.equal(f.sent.length, 0);
});

test("남의 key 는 older·close 를 못 하고 close 는 구독을 닫는다", () => {
  const f = fixture();
  const { key } = f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  assert.equal(f.feature.chatOlder({ connId: "e".repeat(32) }, { key }).code, "forbidden");
  assert.equal(f.feature.chatOlder({ connId: CONN }, { key }).ok, true);
  assert.deepEqual(f.handled.at(-1).msg, { type: "agentchat.older", key });
  assert.equal(f.feature.chatClose({ connId: CONN }, { key }).ok, true);
  assert.deepEqual(f.handled.at(-1).msg, { type: "agentchat.close", key });
  assert.equal(f.feature.chatOlder({ connId: CONN }, { key }).code, "forbidden");
});

test("연결이 닫히면 열린 대화를 모두 닫고 타이머를 멈춘다", () => {
  const f = fixture();
  const a = f.feature.chatOpen({ connId: CONN }, { agent: AGENT }).key;
  const b = f.feature.chatOpen({ connId: CONN }, { agent: AGENT }).key;
  f.feature.closeConnection(CONN);
  const closed = f.handled.filter((h) => h.msg.type === "agentchat.close").map((h) => h.msg.key).sort();
  assert.deepEqual(closed, [a, b].sort());
  assert.equal(f.timers[0].cleared, true);
  const ws = f.handled[0].ws;
  f.sent.length = 0;
  ws.send(JSON.stringify({ type: "agentchat.frame", key: a, kind: "append", messages: [message("m", "x")] }));
  assert.equal(f.sent.length, 0);
});

test("연결마다 열 수 있는 대화는 4개까지", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) assert.equal(f.feature.chatOpen({ connId: CONN }, { agent: AGENT }).ok, true);
  assert.equal(f.feature.chatOpen({ connId: CONN }, { agent: AGENT }).code, "forbidden");
});

test("화면 상태는 바뀔 때만 알린다", () => {
  const f = fixture();
  f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  const uis = () => f.sent.filter((e) => e.projected.type === "chat.ui");
  assert.equal(uis().length, 1);
  f.timers[0].fn();
  assert.equal(uis().length, 1);
  f.setUi({ phase: "ready", version: "v0.1.2", url: "/paseo-ui/?v=v0.1.2", message: "" });
  f.timers[0].fn();
  assert.equal(uis().length, 2);
  assert.deepEqual(uis()[1].projected, { type: "chat.ui", phase: "ready", version: "v0.1.2", url: "/paseo-ui/?v=v0.1.2", message: "" });
});

test("요청 모양 검사", () => {
  assert.equal(isRemoteRequest({ type: "chat.open", rid: "1", agent: AGENT }), true);
  assert.equal(isRemoteRequest({ type: "chat.open", rid: "1", agent: "w1:p2" }), false);
  assert.equal(isRemoteRequest({ type: "chat.older", rid: "1", key: AGENT }), true);
  assert.equal(isRemoteRequest({ type: "chat.close", rid: "1", key: AGENT, extra: 1 }), false);
  assert.equal(isRemoteRequest({ type: "paseo.open", rid: "1" }), true);
});

test("reasoning 역할과 ts 가 null 인 메시지도 폰으로 간다", () => {
  const f = fixture();
  const { key } = f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  const ws = f.handled[0].ws;
  const messages = [
    { id: "r1", role: "reasoning", ts: null, blocks: [{ type: "text", text: "생각" }] },
    { id: "t1", role: "assistant", ts: 5, blocks: [{ type: "tool-call", id: null, name: "Bash", input: { cmd: "ls" } }] },
  ];
  ws.send(JSON.stringify({ type: "agentchat.frame", key, kind: "snapshot", messages, hasOlder: false }));
  const frame = f.sent.map((e) => e.projected).find((e) => e.type === "chat.frame");
  assert.deepEqual(frame.messages.map((m) => m.role), ["reasoning", "assistant"]);
  assert.equal(frame.messages[0].ts, null);
});

test("본문의 Mac 경로와 세션 식별자는 가려서 보내고 구조 이름은 그대로 둔다", () => {
  const f = fixture();
  const { key } = f.feature.chatOpen({ connId: CONN }, { agent: AGENT });
  const ws = f.handled[0].ws;
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const messages = [{ id: "m1", role: "assistant", ts: 1, blocks: [
    { type: "text", text: `파일 ${HOME}/secret/app.js 와 세션 ${uuid}` },
    { type: "tool-call", id: "call_1", name: "Read", input: { file_path: `${HOME}/secret/app.js` } },
    { type: "image", off: 12, i: 0 },
  ] }];
  ws.send(JSON.stringify({ type: "agentchat.frame", key, kind: "snapshot", messages, hasOlder: false }));
  const text = JSON.stringify(f.sent.map((e) => e.projected).find((e) => e.type === "chat.frame"));
  assert.equal(text.includes(HOME), false);
  assert.equal(text.includes(uuid), false);
  assert.match(text, /\[Mac 경로\]/);
  assert.match(text, /\[내부 식별자\]/);
  const blocks = JSON.parse(text).messages[0].blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["text", "tool-call", "image"]);
  assert.equal(blocks[1].name, "Read");
  assert.deepEqual(blocks[2], { type: "image", off: 12, i: 0 });
});
