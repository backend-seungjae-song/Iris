import assert from "node:assert/strict";
import test from "node:test";

import {
  completeEnd, decodeLine, isNoiseMessage, readForward, readTailWindow,
} from "../server/agent-chat-transcript.js";
import { resolveSubagentFile } from "../server/agent-chat.js";
import { diffFromCall, foldTurns, pairTools, summarizeRun } from "../web/js/agentchat/fold.js";
import { ptyChunks } from "../web/js/agentchat/boot.js";

const line = (o) => JSON.stringify(o);
const TS = "2000-01-01T00:00:00.000Z";

function bufferSource(text) {
  const buf = Buffer.from(text, "utf8");
  return { size: buf.length, readAt: (out, pos) => buf.copy(out, 0, pos, Math.min(buf.length, pos + out.length)) };
}

test("Claude: 사용자 글·도구 호출·결과·생각을 역할별로 나눈다", () => {
  const user = decodeLine("claude", line({ type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: "파일을 읽어 줘" } }));
  assert.deepEqual(user.map((m) => [m.role, m.blocks[0].text]), [["user", "파일을 읽어 줘"]]);

  const asst = decodeLine("claude", line({ type: "assistant", uuid: "a1", timestamp: TS, message: { content: [
    { type: "thinking", thinking: "먼저 경로를 본다" },
    { type: "text", text: "읽겠습니다" },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/w/a.js" } },
  ] } }));
  assert.deepEqual(asst.map((m) => m.role), ["reasoning", "assistant"]);
  assert.deepEqual(asst[1].blocks.map((b) => b.type), ["text", "tool-call"]);
  assert.equal(asst[1].blocks[1].id, "toolu_1");

  const result = decodeLine("claude", line({ type: "user", uuid: "u2", isMeta: false, message: { content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "const a = 1" }], is_error: true },
  ] } }));
  assert.equal(result.length, 1);
  assert.equal(result[0].role, "tool");
  assert.deepEqual(result[0].blocks[0], { type: "tool-result", id: "toolu_1", output: "const a = 1", isError: true });
});

test("Claude: 서명만 남은 빈 생각과 기계가 쓴 사용자 턴은 버린다", () => {
  assert.deepEqual(decodeLine("claude", line({ type: "assistant", uuid: "a", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } })), []);
  assert.deepEqual(decodeLine("claude", line({ type: "user", uuid: "m", isMeta: true, message: { content: "<command-caveat>" } })), []);
  for (const text of ["<system-reminder>x</system-reminder>", "<command-name>/clear</command-name>", "[Request interrupted by user]",
    "This session is being continued from a previous conversation", "<local-command-stdout>ok</local-command-stdout>"]) {
    assert.deepEqual(decodeLine("claude", line({ type: "user", uuid: "n", message: { content: text } })), [], text);
  }
  // 도구 결과가 들어 있으면 메타 턴이어도 결과는 남긴다.
  const meta = decodeLine("claude", line({ type: "user", uuid: "k", isCompactSummary: true, message: { content: [
    { type: "text", text: "요약" }, { type: "tool_result", tool_use_id: "t", content: "ok" },
  ] } }));
  assert.deepEqual(meta.map((m) => m.role), ["tool"]);
  // 모르는 줄과 깨진 줄은 예외 없이 버린다.
  assert.deepEqual(decodeLine("claude", "{not json"), []);
  assert.deepEqual(decodeLine("claude", line({ type: "attachment", attachment: {} })), []);
});

test("Codex: response_item 만 읽어 같은 말이 두 번 나오지 않는다", () => {
  const recs = [
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "지침" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "테스트를 고쳐 줘" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "테스트를 고쳐 줘" } },
    { type: "event_msg", payload: { type: "agent_message", message: "고치겠습니다" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "고치겠습니다" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "zz" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "원인 찾기" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{\"cmd\":\"npm test\"}" } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n-a\n+b\n" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "1 passed" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "Done" }] } },
    { type: "event_msg", payload: { type: "turn_aborted" } },
    { type: "event_msg", payload: { type: "token_count" } },
  ];
  const msgs = recs.flatMap((r, i) => decodeLine("codex", line({ timestamp: TS, ...r }), `L${i}`));
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "reasoning", "assistant", "assistant", "tool", "tool", "system"]);
  assert.equal(msgs.filter((m) => m.role === "user").length, 1);
  assert.equal(msgs.filter((m) => m.blocks.some((b) => b.text === "고치겠습니다")).length, 1);
  assert.deepEqual(msgs[3].blocks[0].input, { cmd: "npm test" });
  assert.equal(msgs[4].blocks[0].input, "*** Begin Patch\n-a\n+b\n");
  assert.equal(msgs[6].blocks[0].output, "Done");
});

test("잡음 판정은 사용자·시스템 글에만 걸린다", () => {
  assert.equal(isNoiseMessage({ role: "assistant", blocks: [{ type: "text", text: "<system-reminder>" }] }), false);
  assert.equal(isNoiseMessage({ role: "user", blocks: [{ type: "text", text: "<task>진짜 요청</task>" }] }), false);
  assert.equal(isNoiseMessage({ role: "user", blocks: [{ type: "text", text: "  <task-notification>" }] }), true);
});

function transcript(n, { partial = false } = {}) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += line({ type: "user", uuid: `u${i}`, message: { content: `메시지 ${i}` } }) + "\n";
    out += line({ type: "attachment", uuid: `x${i}` }) + "\n";   // 메시지가 되지 않는 줄
  }
  if (partial) out += "{\"type\":\"user\",\"uuid\":\"half";
  return out;
}

test("끝에서 거꾸로 읽고, 이전 읽기는 그 앞에서 이어진다", () => {
  const src = bufferSource(transcript(500, { partial: true }));
  const end = completeEnd(src);
  assert.ok(end < src.size, "쓰는 중인 마지막 줄은 첫 창에 넣지 않는다");
  const win = readTailWindow(src, { end, want: 300, kind: "claude" });
  assert.equal(win.messages.length, 300);
  assert.equal(win.messages[0].id, "u200");
  assert.equal(win.messages.at(-1).id, "u499");
  assert.equal(win.hasOlder, true);
  const older = readTailWindow(src, { end: win.start, want: 200, kind: "claude" });
  assert.deepEqual([older.messages[0].id, older.messages.at(-1).id, older.messages.length], ["u0", "u199", 200]);
  assert.equal(older.hasOlder, false);
  assert.equal(older.start, 0);
});

test("이어 읽기는 완성된 줄까지만 읽고 다음 위치를 돌려준다", () => {
  const head = transcript(2);
  const tail = line({ type: "user", uuid: "new", message: { content: "새 메시지" } });
  const src = bufferSource(head + tail);        // 마지막 줄에 \n 이 아직 없다
  const first = readForward(src, 0, "claude");
  assert.deepEqual(first.messages.map((m) => m.id), ["u0", "u1"]);
  assert.equal(first.end, Buffer.byteLength(head));
  const done = bufferSource(head + tail + "\n");
  const next = readForward(done, first.end, "claude");
  assert.deepEqual(next.messages.map((m) => m.id), ["new"]);
  assert.equal(next.end, done.size);
});

test("한 조각보다 긴 줄과 여러 바이트 글자도 줄 경계를 지킨다", () => {
  const big = "가".repeat(40000);              // 120KB, 64KB 조각 둘에 걸친다
  const text = line({ type: "user", uuid: "a", message: { content: "앞" } }) + "\n"
    + line({ type: "user", uuid: "b", message: { content: big } }) + "\n";
  const src = bufferSource(text);
  const win = readTailWindow(src, { end: src.size, want: 1, kind: "claude" });
  assert.deepEqual(win.messages.map((m) => m.id), ["b"]);
  assert.ok(win.messages[0].blocks[0].text.startsWith("가가"));
  const rest = readTailWindow(src, { end: win.start, want: 5, kind: "claude" });
  assert.deepEqual(rest.messages.map((m) => m.id), ["a"]);
});

test("서브에이전트 파일은 id 로만 만들고 폴더 밖·잘못된 id 는 거절한다", () => {
  const rec = { dir: "/nonexistent-root/proj/session" };
  for (const bad of ["../../etc/passwd", "a/b", "", "a b", "x".repeat(81)]) {
    assert.equal(resolveSubagentFile(rec, bad, "/nonexistent-root"), null, bad);
  }
  // 올바른 모양이어도 실제 파일이 기록 폴더 안에 없으면 null 이다.
  assert.equal(resolveSubagentFile(rec, "a6f9e3a9d9c848dd4", "/nonexistent-root"), null);
  assert.equal(resolveSubagentFile(null, "abc", "/nonexistent-root"), null);
});

test("턴 묶기: 연속한 에이전트 쪽 메시지는 한 턴이고 도구는 한 묶음이 된다", () => {
  const msgs = [
    { id: "u", role: "user", blocks: [{ type: "text", text: "해 줘" }] },
    { id: "r", role: "reasoning", blocks: [{ type: "text", text: "생각" }] },
    { id: "a1", role: "assistant", blocks: [{ type: "text", text: "보겠습니다" }] },
    { id: "a2", role: "assistant", blocks: [{ type: "tool-call", id: "t1", name: "Read", input: { file_path: "/w/src/foo.ts" } }] },
    { id: "t", role: "tool", blocks: [{ type: "tool-result", id: "t1", output: "ok" }] },
    { id: "a3", role: "assistant", blocks: [{ type: "tool-call", id: "t2", name: "Bash", input: { command: "npm test -- --watch=false --reporter dot" } }] },
    { id: "a4", role: "assistant", blocks: [{ type: "text", text: "끝" }] },
    { id: "u2", role: "user", blocks: [{ type: "text", text: "고마워" }] },
  ];
  const turns = foldTurns(msgs);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(turns[1].segments.map((s) => s.kind), ["reasoning", "text", "tools", "text"]);
  const run = turns[1].segments[2];
  assert.equal(run.blocks.length, 3);
  const sum = summarizeRun(run.blocks);
  assert.equal(sum.count, 2);
  assert.equal(sum.text, "Read foo.ts · Bash npm test -- --watch=false --");
});

test("도구 짝짓기: id 가 있으면 id 로, 없으면 도착 순서로", () => {
  const pairs = pairTools([
    { type: "tool-call", id: "a", name: "A" }, { type: "tool-call", id: "b", name: "B" },
    { type: "tool-result", id: "b", output: "B!" }, { type: "tool-result", id: "a", output: "A!" },
  ]);
  assert.deepEqual(pairs.map((p) => [p.call.name, p.result.output]), [["A", "A!"], ["B", "B!"]]);
  const fifo = pairTools([
    { type: "tool-call", name: "X" }, { type: "tool-call", name: "Y" },
    { type: "tool-result", output: "1" }, { type: "tool-result", output: "2" },
  ]);
  assert.deepEqual(fifo.map((p) => [p.call.name, p.result.output]), [["X", "1"], ["Y", "2"]]);
  assert.equal(summarizeRun([{ type: "tool-call", name: "exec", input: 'const r = await tools.exec_command({cmd:"pwd",max_output_tokens:100});' }]).text, "exec pwd");
  assert.equal(summarizeRun([1, 2, 3, 4].map((i) => ({ type: "tool-call", name: `T${i}`, input: null }))).text, "T1 · T2 · T3 · …");
});

test("편집 도구 입력은 diff 줄이 된다", () => {
  const d = diffFromCall({ name: "Edit", input: { file_path: "/w/a.js", old_string: "a\nb", new_string: "c" } });
  assert.deepEqual(d.map((l) => l.kind), ["meta", "del", "del", "add"]);
  assert.equal(diffFromCall({ name: "Read", input: { file_path: "/w/a.js" } }), null);
  const p = diffFromCall({ name: "apply_patch", input: "*** Update File: a\n-x\n+y\n" });
  assert.deepEqual(p.map((l) => l.kind), ["meta", "del", "add"]);
});

test("입력창 전송: 줄을 비우고, 여러 줄은 bracketed paste 로, Enter 는 따로", () => {
  assert.deepEqual(ptyChunks("한 줄"), ["\x15", "한 줄", "\r"]);
  assert.deepEqual(ptyChunks("첫째\r\n둘째"), ["\x15", "\x1b[200~첫째\n둘째\x1b[201~", "\r"]);
});
