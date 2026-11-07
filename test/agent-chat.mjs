import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

// 업로드 시험용 요청 객체(이벤트를 내보내고 resume 을 받음)
const await_events = () => class extends EventEmitter { resume() {} };

import {
  codexToolItem, completeEnd, decodeLine, isNoiseMessage, readForward, readTailWindow,
} from "../server/agent-chat-transcript.js";
import {
  handleAgentChat, handleAgentChatFile, handleAgentChatImage, handleAgentChatUpload, imageFromRecord, initAgentChat, inputChunks,
  ANSWER_SETTLE_MS, cardChoices, isAnsweredLeftover, subagentRelayText, optionLabel, promptIdOf, readRecords, resolveSubagentFile, uploadName,
} from "../server/agent-chat.js";
import {
  LEGACY_RECIPE, MAX_TRIES, RETRY_AFTER_MS, buildName, checkDue, latestStableTag, nextBuild, parseBuildName, parseState, promote,
  recordFailure, rollback, staticTarget,
} from "../server/paseo-ui/plan.js";
import { childEnv } from "../server/paseo-ui/index.js";
import { listCommands, parseFrontmatter, rankPaths, suggestFiles } from "../server/agent-chat-tools.js";
import { parseContext } from "../server/paseo-ui/entry/iris-contexts-model.js";
import { attachmentTag, attachmentText, contextTag, cutToken, describeAttachment, dropAttachment, dropImage, expandText, findTokens, imageTag, isLongPaste, reglue, removedTokens, shrinkTag, tokenLabel, tokensToDelete } from "../server/paseo-ui/entry/iris-inline-tokens.js";
import { claudeFooter, claudeMeta, codexConfiguredModel, codexMeta, codexModeId, codexModelsFromCache } from "../server/agent-chat-meta.js";

const line = (o) => JSON.stringify(o);
const TS = "2000-01-01T00:00:00.000Z";

function bufferSource(text) {
  const buf = Buffer.from(text, "utf8");
  return { size: buf.length, readAt: (out, pos) => buf.copy(out, 0, pos, Math.min(buf.length, pos + out.length)) };
}

test("Claude: 백그라운드 셸·Monitor 알림(<task-notification>)은 버리지 않고 알림 블록으로", () => {
  const raw = "<task-notification>\n<task-id>b3</task-id>\n<status>completed</status>\n<summary>Monitor \"x\" stream ended</summary>\n<event>u30-bg-done</event>\n</task-notification>";
  const out = decodeLine("claude", line({ type: "user", uuid: "n1", timestamp: TS, message: { role: "user", content: raw } }));
  assert.deepEqual(out.map((m) => [m.role, m.blocks[0].type]), [["tool", "task-notification"]]);
  assert.equal(out[0].blocks[0].text, raw);
  assert.equal(isNoiseMessage(out[0]), false);
  const arr = decodeLine("claude", line({ type: "user", uuid: "n2", timestamp: TS, message: { role: "user", content: [{ type: "text", text: raw }] } }));
  assert.equal(arr[0].blocks[0].type, "task-notification");
});

test("Claude: 붙여넣은 글의 <pasted_content> 태그는 빼고 원문만(터미널 화면과 같게)", () => {
  const raw = "봐\n<pasted_content id=\"3a42\">\n붙인 줄\n<\\pasted_content id=\"f71e\">안<\\/pasted_content id=\"f71e\">\n</pasted_content id=\"3a42\">\n끝";
  const want = "봐\n붙인 줄\n<pasted_content id=\"f71e\">안</pasted_content id=\"f71e\">\n끝";
  const str = decodeLine("claude", line({ type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: raw } }));
  assert.equal(str[0].blocks[0].text, want);
  const arr = decodeLine("claude", line({ type: "user", uuid: "u2", timestamp: TS, message: { role: "user", content: [{ type: "text", text: raw }] } }));
  assert.equal(arr[0].blocks[0].text, want);
  const asst = decodeLine("claude", line({ type: "assistant", uuid: "a1", timestamp: TS, message: { content: [{ type: "text", text: raw }] } }));
  assert.equal(asst[0].blocks[0].text, raw, "에이전트 글은 그대로");
  // 터미널이 저장한 모양 그대로(앞 줄바꿈 둘·뒤 줄바꿈 하나): 대화 화면이 보낸 글과 짝지을 수 있게 앞뒤 줄바꿈도 뺌
  const stored = "\n\n<pasted_content id=\"a9ea\">\n첫 줄\n둘째 줄\n</pasted_content id=\"a9ea\">\n";
  const s2 = decodeLine("claude", line({ type: "user", uuid: "u3", timestamp: TS, message: { role: "user", content: stored } }));
  assert.equal(s2[0].blocks[0].text, "첫 줄\n둘째 줄");
  const plain = decodeLine("claude", line({ type: "user", uuid: "u4", timestamp: TS, message: { role: "user", content: "\n그대로\n" } }));
  assert.equal(plain[0].blocks[0].text, "\n그대로\n", "태그 없는 글은 손대지 않음");
});

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

test("Claude: 작업 중 사람이 보낸 입력(queued_command)은 사용자 글로 보이고 다른 세션·작업 알림은 빠진다", () => {
  const queued = (origin, prompt, commandMode = "prompt") => line({ type: "attachment", uuid: "q1", timestamp: TS,
    attachment: { type: "queued_command", prompt, commandMode, origin, timestamp: TS } });
  const human = decodeLine("claude", queued({ kind: "human" }, "요소 선택 꺼도 강조가 남아"));
  assert.deepEqual(human.map((m) => [m.id, m.role, m.blocks[0].text]), [["q1", "user", "요소 선택 꺼도 강조가 남아"]]);
  assert.deepEqual(decodeLine("claude", queued({ kind: "peer", name: "iris-0d" }, "<cross-session-message>x")), []);
  assert.deepEqual(decodeLine("claude", queued(null, "<task-notification>x", "task-notification")), []);
});

test("Claude: 서명에 narration 표시가 있는 thinking 은 사람에게 보인 중간 답이라 답변 글로 읽는다", () => {
  const narration = Buffer.concat([Buffer.from([8, 4, 18, 10, 10, 17, 8, 18, 24, 2, 56, 1, 66, 9]), Buffer.from("narration"), Buffer.alloc(24, 7)]).toString("base64");
  const plain = Buffer.concat([Buffer.from([8, 4, 18, 10]), Buffer.alloc(40, 3)]).toString("base64");
  const out = decodeLine("claude", line({ type: "assistant", uuid: "a9", timestamp: TS, message: { content: [
    { type: "thinking", thinking: "원인을 찾았습니다.", signature: narration },
    { type: "thinking", thinking: "속으로 생각", signature: plain },
    { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } },
  ] } }));
  assert.deepEqual(out.map((m) => m.role), ["reasoning", "assistant"]);
  assert.equal(out[0].blocks[0].text, "속으로 생각");
  assert.deepEqual(out[1].blocks.map((b) => [b.type, b.text ?? b.name]), [["text", "원인을 찾았습니다."], ["tool-call", "Bash"]]);
});

test("Codex: 끝난 도구 항목(item_completed)을 Paseo thread item 모양으로, exec 묶음은 표시만", () => {
  const lines = fs.readFileSync(new URL("./fixtures/codex-rollout/items.jsonl", import.meta.url), "utf8").split("\n");
  const msgs = lines.flatMap((l, i) => decodeLine("codex", l, `L${i}`));
  const items = msgs.flatMap((m) => m.blocks).filter((b) => b.type === "tool-item").map((b) => b.item);
  assert.deepEqual(items.map((x) => [x.type, x.id]), [["commandExecution", "exec-1"], ["fileChange", "exec-2"], ["mcpToolCall", "exec-3"], ["webSearch", "exec-4"]], "말 항목(AgentMessage)은 빼고 response_item 으로만");
  assert.deepEqual(items[0], { type: "commandExecution", id: "exec-1", status: "completed", command: ["/bin/zsh", "-lc", "touch a.txt"], cwd: "/w", aggregatedOutput: "done\n", exitCode: 0 });
  assert.equal(items[1].status, "completed", "FileChange 는 status 가 없어 끝난 것으로");
  const calls = msgs.flatMap((m) => m.blocks).filter((b) => b.type === "tool-call");
  assert.deepEqual(calls.map((b) => [b.name, !!b.wrapper]), [["exec", true], ["wait", false]]);
  assert.equal(msgs.filter((m) => m.role === "assistant" && m.blocks.some((b) => b.text === "만들었습니다")).length, 1);
  assert.equal(codexToolItem({ type: "CommandExecution" }), null, "id 없으면 버림");
  assert.equal(codexToolItem({ type: "Reasoning", id: "r" }), null);
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

test("이미지 블록은 데이터 대신 줄 위치(off)와 내용 순번(i)만 갖는다", () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const first = line({ type: "user", uuid: "u0", timestamp: TS, message: { role: "user", content: "앞줄" } });
  const second = line({ type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: [{ type: "text", text: "봐 줘" }, img] } });
  const win = readTailWindow(bufferSource(`${first}\n${second}\n`), { end: Buffer.byteLength(`${first}\n${second}\n`), want: 10, kind: "claude" });
  const blocks = win.messages.find((m) => m.id === "u1").blocks;
  assert.deepEqual(blocks[1], { type: "image", i: 1, off: Buffer.byteLength(first) + 1 });
  assert.ok(!JSON.stringify(win.messages).includes("iVBORw0KGgo"), "이미지 데이터가 메시지에 실렸다");
  const codex = decodeLine("codex", line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "이것" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] } }), "L0");
  assert.deepEqual(codex[0].blocks[1], { type: "image", i: 1 });
});

test("기록 줄에서 이미지 꺼내기: Claude base64·대기 입력·Codex data URL, 이미지가 아니면 null", () => {
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png!").toString("base64") } };
  assert.equal(imageFromRecord({ message: { content: [{ type: "text", text: "x" }, png] } }, 1).bytes.toString(), "png!");
  assert.equal(imageFromRecord({ attachment: { prompt: [png] } }, 0).mime, "image/png");
  const codex = imageFromRecord({ payload: { content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from("jpg!").toString("base64")}` }] } }, 0);
  assert.deepEqual([codex.mime, codex.bytes.toString()], ["image/jpeg", "jpg!"]);
  assert.equal(imageFromRecord({ message: { content: [{ type: "text", text: "x" }] } }, 0), null);
  assert.equal(imageFromRecord({ message: { content: [{ type: "image", source: { type: "base64", media_type: "text/html", data: "PGI+" } }] } }, 0), null);
  assert.equal(imageFromRecord(null, 0), null);
});

function fakeReq(url, headers = {}, ip = "127.0.0.1") {
  return { url, method: "GET", headers, socket: { remoteAddress: ip } };
}
function fakeRes() {
  const res = { status: 0, headers: {}, body: null, headersSent: false };
  res.writeHead = (code, h) => { res.status = code; Object.assign(res.headers, h || {}); res.headersSent = true; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b ?? null; res.done?.(); return res; };
  res.wait = () => new Promise((r) => { if (res.body !== null || res.status) r(); else res.done = r; });
  return res;
}

test("대화 이미지 주소는 같은 출처의 로컬 요청만 받고, 파일은 이미지 확장자만 읽는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achat-img-"));
  try {
    const png = path.join(dir, "a.png");
    const txt = path.join(dir, "secret.txt");
    fs.writeFileSync(png, "png!");
    fs.writeFileSync(txt, "secret");
    const same = { "sec-fetch-site": "same-origin" };
    const ok = fakeRes();
    handleAgentChatFile(fakeReq(`/agentchat-file?path=${encodeURIComponent(png)}`, same), ok);
    await ok.wait();
    assert.deepEqual([ok.status, String(ok.body)], [200, "png!"]);
    for (const [req, want] of [
      [fakeReq(`/agentchat-file?path=${encodeURIComponent(png)}`, { "sec-fetch-site": "cross-site" }), 403],
      [fakeReq(`/agentchat-file?path=${encodeURIComponent(png)}`, {}), 403],
      [fakeReq(`/agentchat-file?path=${encodeURIComponent(png)}`, same, "10.0.0.2"), 403],
      [fakeReq(`/agentchat-file?path=${encodeURIComponent(txt)}`, same), 400],
      [fakeReq(`/agentchat-file?path=a.png`, same), 400],
      [fakeReq(`/agentchat-image?pane=w1:p1&off=-1&i=0`, same), 400],
      [fakeReq(`/agentchat-image?pane=w1:p1&off=0&i=0&agent=../x`, same), 400],
      [fakeReq(`/agentchat-image?pane=w1:p1&off=0&i=0`, { "sec-fetch-site": "cross-site" }), 403],
    ]) {
      const res = fakeRes();
      (req.url.startsWith("/agentchat-file") ? handleAgentChatFile : handleAgentChatImage)(req, res);
      await res.wait();
      assert.equal(res.status, want, req.url);
    }
    // 이미지 확장자로 끝나는 링크가 다른 파일을 가리키면 거절
    const link = path.join(dir, "link.png");
    fs.symlinkSync(txt, link);
    const viaLink = fakeRes();
    handleAgentChatFile(fakeReq(`/agentchat-file?path=${encodeURIComponent(link)}`, same), viaLink);
    await viaLink.wait();
    assert.equal(viaLink.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Paseo 화면 빌드: 안정 태그만 고르고, 같은 버전·같은 Iris 재료면 다시 빌드하지 않는다", () => {
  const ls = ["a\trefs/tags/v0.15.1", "b\trefs/tags/v0.15.2", "c\trefs/tags/v0.15.2^{}", "d\trefs/tags/v0.16.0-beta.1", "e\trefs/tags/v0.9.9"].join("\n");
  assert.equal(latestStableTag(ls), "0.15.2");
  assert.equal(latestStableTag(""), null);
  const empty = parseState("not json");
  assert.deepEqual(empty, { current: null, previous: null, failed: [], checkedAt: 0 });
  const R = "aaaaaaaa1111", R2 = "bbbbbbbb2222", now = 1e12;
  assert.deepEqual(nextBuild(empty, "0.15.2", R, now), { version: "0.15.2", recipe: R });
  const built = promote(empty, { version: "0.15.2", recipe: R });
  assert.equal(nextBuild(built, "0.15.2", R, now), null);
  // Iris 진입 파일이 바뀌면(재료 해시) 같은 Paseo 버전도 다시 빌드
  assert.deepEqual(nextBuild(built, "0.15.2", R2, now), { version: "0.15.2", recipe: R2 });
  assert.equal(nextBuild(promote(empty, { version: "0.16.0", recipe: R }), "0.15.2", R, now), null);
  assert.equal(nextBuild(empty, "0.15.2", "not-hex", now), null);
  // 이전 형식({ version })은 이전 빌드 폴더 이름 그대로 현재로 읽음
  const legacy = parseState('{"version":"0.15.2","failed":["0.15.2"]}');
  assert.deepEqual(legacy.current, { version: "0.15.2", recipe: LEGACY_RECIPE });
  assert.equal(buildName("0.15.2", LEGACY_RECIPE), "0.15.2");
  assert.deepEqual(nextBuild(legacy, "0.15.2", R, now), { version: "0.15.2", recipe: R });
  assert.deepEqual(parseBuildName(buildName("0.15.2", R)), { version: "0.15.2", recipe: R });
  assert.deepEqual(parseBuildName("0.15.2"), { version: "0.15.2", recipe: LEGACY_RECIPE });
  assert.equal(parseBuildName("0.15.2.partial-12"), null);
});

test("Paseo 화면 빌드 실패: 기다렸다 다시 시도하고 3번 실패하면 멈추며, 화면을 다시 열면 기다림만 건너뛴다", () => {
  const want = { version: "0.15.2", recipe: "aaaaaaaa1111" };
  const t0 = 1e12;
  let st = recordFailure(parseState(""), want, t0);
  assert.equal(nextBuild(st, "0.15.2", want.recipe, t0 + 1000), null);
  assert.deepEqual(nextBuild(st, "0.15.2", want.recipe, t0 + RETRY_AFTER_MS[0]), want);
  assert.deepEqual(nextBuild(st, "0.15.2", want.recipe, t0 + 1000, { force: true }), want);
  st = recordFailure(st, want, t0);
  assert.equal(nextBuild(st, "0.15.2", want.recipe, t0 + RETRY_AFTER_MS[0]), null);
  assert.deepEqual(nextBuild(st, "0.15.2", want.recipe, t0 + RETRY_AFTER_MS[1]), want);
  st = recordFailure(st, want, t0);
  assert.equal(st.failed[0].count, MAX_TRIES);
  assert.equal(nextBuild(st, "0.15.2", want.recipe, t0 + 1e10, { force: true }), null);
  // 새 버전이 나오면 그것을 시도
  assert.deepEqual(nextBuild(st, "0.15.3", want.recipe, t0), { version: "0.15.3", recipe: want.recipe });
  // 성공하면 실패 기록이 지워짐
  assert.deepEqual(promote(st, want).failed, []);
  // 저장했다 다시 읽어도 같은 판단
  assert.deepEqual(parseState(JSON.stringify(st)).failed, st.failed);
});

test("Paseo 화면 빌드: 새 빌드가 화면에서 깨지면 바로 앞 빌드로 되돌리고 그 빌드는 다시 시도하지 않는다", () => {
  const a = { version: "0.15.1", recipe: "aaaaaaaa1111" }, b = { version: "0.15.2", recipe: "aaaaaaaa1111" };
  const st = promote(promote(parseState(""), a), b);
  assert.deepEqual([st.current, st.previous], [b, a]);
  const back = rollback(st, 5);
  assert.deepEqual([back.current, back.previous], [a, null]);
  assert.equal(nextBuild(back, "0.15.2", b.recipe, 5 + 1e10, { force: true }), null);
  assert.equal(rollback(back, 6), null, "되돌아갈 곳이 없으면 되돌리지 않음");
  assert.equal(rollback(promote(parseState(""), a), 1), null);
});

test("Paseo 화면 확인 기한은 저장한 마지막 확인 시각 기준", () => {
  const st = { ...parseState(""), checkedAt: 1000 };
  assert.equal(checkDue(st, 1000 + 60 * 1000), false);
  assert.equal(checkDue(st, 1000 + 6 * 60 * 60 * 1000), true);
  assert.equal(checkDue(parseState(JSON.stringify({ checkedAt: 1000 })), 1001), false);
});

test("빌드 환경 변수는 허용 목록만 넘긴다", () => {
  const env = childEnv("/bin/node-dir", { PATH: "/usr/bin", HOME: "/h", LANG: "ko_KR.UTF-8", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "y", NPM_TOKEN: "z", HTTPS_PROXY: "http://p" });
  assert.equal(env.PATH, `/bin/node-dir${path.delimiter}/usr/bin`);
  assert.equal(env.HOME, "/h");
  assert.equal(env.HTTPS_PROXY, "http://p");
  for (const k of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "NPM_TOKEN"]) assert.equal(env[k], undefined, k);
  assert.equal(env.CI, "1");
});

test("Paseo 화면 정적 경로는 빌드 폴더 밖으로 나가지 않는다", () => {
  assert.equal(staticTarget("/paseo-ui/"), "index.html");
  assert.equal(staticTarget("/paseo-ui/_expo/static/js/web/a.js"), "_expo/static/js/web/a.js");
  for (const bad of ["/paseo-ui/../x", "/paseo-ui/%2e%2e/x", "/paseo-ui/a/../../x", "/paseo-ui//etc/passwd", "/paseo-ui/%00", "/paseo-ui/%E0%A4%A"]) {
    assert.equal(staticTarget(bad), null, bad);
  }
});

test("입력창 전송: 입력 칸을 다 비우고, 여러 줄은 bracketed paste 로, Enter 는 따로", () => {
  const clear = (n) => "\x0b".repeat(n) + "\x15".repeat(n);
  assert.deepEqual(inputChunks("한 줄", 1), [clear(4), "한 줄", "\r"]);
  assert.deepEqual(inputChunks("첫째\r\n둘째"), [clear(16), "\x1b[200~첫째\n둘째\x1b[201~", "\r"]);
  assert.deepEqual(inputChunks("봐 @/u/a.pdf", 1), [clear(4), "봐 @/u/a.pdf ", "\r"], "끝 @경로 뒤 공백: 자동완성이 Enter 를 받지 않게");
  assert.deepEqual(inputChunks("@/u/a.pdf 봐", 1), [clear(4), "@/u/a.pdf 봐", "\r"], "끝이 @ 낱말이 아니면 그대로");
  assert.deepEqual(inputChunks("메일 a@b.example", 1), [clear(4), "메일 a@b.example", "\r"], "낱말 중간의 @ 는 멘션이 아님");
});

test("입력창 전송: 터미널 입력 칸에 남은 여러 줄을 다 지우고, 못 읽는 덩어리가 있으면 보내지 않는다", async () => {
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/terminal-draft/${name}.ansi`, import.meta.url), "utf8");
  const sent = [];
  let screenName = "claude-multi";
  initAgentChat({ paseoUi: false, herdr: {
    paneSendText: async (paneId, text) => { sent.push([paneId, text]); },
    paneRead: async (_pane, source, format, strip) => { assert.deepEqual([source, format, strip], ["visible", "ansi", false]); return { text: fixture(screenName) }; },
  } });
  const out = [];
  const ws = { _local: true, readyState: 1, send: (s) => out.push(JSON.parse(s)), once: () => {} };
  handleAgentChat(ws, { type: "agentchat.open", key: "k1", paneId: "w1:pA" });
  handleAgentChat(ws, { type: "agentchat.send", key: "k1", text: "새 글" });
  await new Promise((r) => setTimeout(r, 900));
  // 화면 6줄 → Ctrl+K·Ctrl+U 14번씩. 한 번만 지우면 앞 줄이 새 글과 함께 보내짐
  assert.deepEqual(sent, [["w1:pA", "\x0b".repeat(14) + "\x15".repeat(14)], ["w1:pA", "새 글"], ["w1:pA", "\r"]]);
  sent.length = 0;
  screenName = "claude-pasted";
  handleAgentChat(ws, { type: "agentchat.send", key: "k1", text: "또" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, []);
  const last = out.filter((m) => m.type === "agentchat.sent").at(-1);
  assert.equal(last.ok, false);
  assert.match(last.reason, /붙여 넣은 덩어리/);
  handleAgentChat(ws, { type: "agentchat.close", key: "k1" });
});

test("입력창 전송은 구독한 pane 에 고정: 보낸 직후 창이 다른 pane 을 봐도 Enter 까지 같은 pane 으로", async () => {
  const sent = [];
  // 화면 빌드 관리는 끔. 켜면 실제 상태 폴더를 정리하고 Paseo 를 받아 빌드함
  initAgentChat({ paseoUi: false, herdr: { paneSendText: async (paneId, text) => { sent.push([paneId, text]); } } });
  const out = [];
  const ws = { _local: true, readyState: 1, send: (s) => out.push(JSON.parse(s)), once: () => {} };
  handleAgentChat(ws, { type: "agentchat.open", key: "k1", paneId: "w1:pA" });
  handleAgentChat(ws, { type: "agentchat.send", key: "k1", text: "첫째" });
  handleAgentChat(ws, { type: "agentchat.send", key: "k1", text: "둘째" });
  // 창이 다른 pane 을 고름 — 서버 전송 대상과 관계없음
  handleAgentChat(ws, { type: "agentchat.open", key: "k2", paneId: "w1:pB" });
  await new Promise((r) => setTimeout(r, 1700));
  const clear = "\x0b".repeat(16) + "\x15".repeat(16);   // 화면을 못 읽으면 넉넉히
  assert.deepEqual(sent, [["w1:pA", clear], ["w1:pA", "첫째"], ["w1:pA", "\r"], ["w1:pA", clear], ["w1:pA", "둘째"], ["w1:pA", "\r"]]);
  assert.deepEqual(out.filter((m) => m.type === "agentchat.sent").map((m) => m.ok), [true, true]);
  handleAgentChat(ws, { type: "agentchat.send", key: "nope", text: "x" });
  assert.equal(out.at(-1).ok, false);
  // 중단은 구독한 pane 에 Esc 하나
  sent.length = 0;
  handleAgentChat(ws, { type: "agentchat.cancel", key: "k1" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, [["w1:pA", "\x1b"]]);
  handleAgentChat(ws, { type: "agentchat.close", key: "k1" });
  handleAgentChat(ws, { type: "agentchat.close", key: "k2" });
});

test("글 없이 이미지만 보낸 사용자 말도 남는다(Claude·Codex)", () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const claude = decodeLine("claude", line({ type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: [img] } }));
  assert.deepEqual(claude.map((m) => [m.role, m.blocks[0].type]), [["user", "image"]]);
  const codex = decodeLine("codex", line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] } }), "L0");
  assert.deepEqual(codex.map((m) => [m.role, m.blocks[0].type]), [["user", "image"]]);
  assert.equal(isNoiseMessage({ role: "user", blocks: [] }), true);
});

test("입력창 / 명령: 프로젝트·사용자 명령과 스킬, 내장 명령. 사용자 호출이 아닌 스킬은 뺀다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achat-cmd-"));
  try {
    const home = path.join(dir, "home"), cwd = path.join(dir, "proj"), codex = path.join(dir, "codex");
    const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
    write(path.join(home, "commands", "core", "git.md"), "---\nname: git\ndescription: 깃 작업\nargument-hint: \"[--push]\"\n---\n본문");
    write(path.join(home, "skills", "a", "SKILL.md"), "---\nname: a-skill\ndescription: 스킬\n---");
    write(path.join(home, "skills", "hidden", "SKILL.md"), "---\nname: hidden\nuser-invocable: false\ndescription: x\n---");
    write(path.join(cwd, ".claude", "commands", "help.md"), "---\ndescription: 프로젝트 help\n---");
    write(path.join(codex, "prompts", "fix.md"), "---\ndescription: 고치기\n---");
    const c = listCommands("claude", cwd, { claude: home, codex });
    const by = Object.fromEntries(c.map((x) => [x.name, x]));
    assert.deepEqual([by["core:git"].description, by["core:git"].argumentHint], ["깃 작업", "[--push]"]);
    assert.equal(by["a-skill"].kind, "skill");
    assert.equal(by.hidden, undefined);
    assert.equal(by.help.description, "프로젝트 help", "프로젝트 명령이 같은 이름의 내장보다 앞");
    assert.equal(c.filter((x) => x.name === "help").length, 1);
    assert.ok(by.compact && by.model);
    const x = listCommands("codex", cwd, { claude: home, codex });
    assert.ok(x.some((v) => v.name === "prompts:fix") && x.some((v) => v.name === "model"));
    assert.ok(!x.some((v) => v.name === "core:git"));
    assert.deepEqual(parseFrontmatter("본문만"), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("입력창 @ 파일: 이름 앞부분 일치가 먼저, 폴더도 후보, 작업 폴더가 아니면 빈 결과", async () => {
  assert.deepEqual(rankPaths(["src/x/readme.md", "README.md", "docs/read.txt", "zz/r-e-a-d.js"], "read", 10),
    ["README.md", "docs/read.txt", "src/x/readme.md", "zz/r-e-a-d.js"]);
  assert.deepEqual(rankPaths(["a/bcd.js", "q.js"], "bd", 10), ["a/bcd.js"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achat-files-"));
  try {
    fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "deep", "main.js"), "");
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "x", "main.js"), "");
    const r = await suggestFiles(dir, "main", 10);
    assert.deepEqual(r.entries.filter((e) => e.kind === "file").map((e) => e.path), ["src/deep/main.js"]);
    assert.ok((await suggestFiles(dir, "deep", 10)).directories.includes("src/deep"));
    assert.deepEqual(await suggestFiles("relative/path", "x"), { directories: [], entries: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("입력창 첨부 업로드: 같은 출처 fetch 만, 이름은 파일 이름만, 상태 폴더 아래에 저장", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achat-up-"));
  const saved = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = dir;
  try {
    assert.equal(uploadName("../../etc/passwd"), "passwd");
    // 역슬래시는 Windows 에서만 경로 구분. 다른 곳에서는 이름 글자라 _ 로 바뀜
    assert.equal(uploadName("a/b\\c:d.png"), process.platform === "win32" ? "c_d.png" : "b_c_d.png");
    assert.equal(uploadName(".."), "file");
    assert.equal(uploadName("내 화면 1.png"), "내_화면_1.png");
    const long = uploadName(`${"가".repeat(116)}.txt`);
    assert.ok(Buffer.byteLength(long) <= 255 && long.endsWith(".txt"), long);
    assert.equal(uploadName(".png"), "file.png");
    assert.equal(uploadName(""), "file");
    const post = (url, headers, body) => {
      const req = new (await_events())();
      Object.assign(req, { url, method: "POST", headers, socket: { remoteAddress: "127.0.0.1" } });
      const res = fakeRes();
      handleAgentChatUpload(req, res);
      if (body !== undefined) { req.emit("data", Buffer.from(body)); req.emit("end"); }
      return res;
    };
    const ok = post("/agentchat-upload?name=..%2Fshot.png", { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" }, "png!");
    await ok.wait();
    assert.equal(ok.status, 200);
    const { path: file, size } = JSON.parse(ok.body);
    assert.ok(file.startsWith(path.join(dir, "agentchat-uploads") + path.sep), file);
    assert.equal(path.basename(file), "shot.png");
    assert.equal(size, 4);
    assert.equal(fs.readFileSync(file, "utf8"), "png!");
    for (const h of [{ "sec-fetch-site": "cross-site" }, {}, { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" }]) {
      const r = post("/agentchat-upload?name=x", h);
      assert.equal(r.status, 403, JSON.stringify(h));
    }
    const big = post("/agentchat-upload?name=x", { "sec-fetch-site": "same-origin", "content-length": String(31 * 1024 * 1024) });
    assert.equal(big.status, 413);
  } finally {
    if (saved === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("요약·붙인 글에 ⟦ ⟧ 가 들어도 칩 글자가 깨지지 않는다(P73)", () => {
  for (const c of [
    { id: "a", no: 1, content: "⟦Iris⟧ 새 선택 #c1 · 어딘가\n내용: x\n⟦/Iris⟧" },
    { id: "b", no: 2, kind: "paste", content: "⟦옛 칩⟧ 첫 줄\n둘째\n셋째\n넷째\n다섯째\n여섯째" },
    { id: "c", no: 3, content: "[⟦괄호⟧ 제목]\n본문" },
  ]) {
    const tag = contextTag(c);
    const text = `앞 ${tag} 뒤`;
    assert.deepEqual(findTokens(text, [c]).map((t) => [t.type, t.id]), [["context", c.id]], c.id);
    assert.ok(!expandText(text, { contexts: [c] }).includes(tag), c.id);
  }
});

test("요소 선택 블록 머리 줄에서 칩의 종류·요약을 뽑는다", () => {
  const el = ["⟦Iris⟧ 요소 선택 #p1a2 · 탭 @t3  주문 · http://localhost:3000/", "소스: src/a.tsx:12", "요소: <button#buy.btn> \"구매하기\"", "선택자: #buy", "⟦/Iris⟧"].join("\n");
  assert.deepEqual(parseContext(el), { kind: "element", label: "브라우저 요소", summary: "구매하기" });
  const noText = ["⟦Iris⟧ 요소 선택 · 탭 x · http://a", "요소: <div.card>", "선택자: div.card"].join("\n");
  assert.equal(parseContext(noText).summary, "<div.card>");
  assert.equal(parseContext("⟦Iris⟧ 앱 요소 선택 #p9 · iris_remote\n위젯: IrisButton · stateful").summary, "IrisButton");
  assert.deepEqual(parseContext("[브라우저 재현 기록 · 12초 · 조작 5건]\n## 녹화된 탭"), { kind: "record", label: "조작 기록", summary: "12초 · 조작 5건" });
  assert.equal(parseContext("[사이트 지목 · 이 주소를 기억하고 활용하세요]\n주문  http://a.test/").summary, "주문 http://a.test/");
  assert.equal(parseContext("⟦Iris⟧ 브라우저 그룹 지목\n등록 구분자: z\n그룹: 작업 (g1) · 스페이스 s").summary, "작업");
  assert.equal(parseContext("⟦Iris⟧ 에뮬레이터 지목\n기기: iPhone 17 (UDID)").summary, "iPhone 17");
  assert.equal(parseContext("⟦Iris⟧ 표 셀 선택 · B3\n셀: B3").kind, "cell");
  // 모르는 형식도 칩으로. 긴 요약은 40자에서 자름
  const other = parseContext("x".repeat(80));
  assert.equal(other.kind, "other");
  assert.equal(other.summary.length, 40);
  assert.equal(parseContext("").summary, "내용");
  // 화면이 모르는 새 선택 블록: 요약은 머리 글자(⟦Iris⟧) 대신 제목
  assert.deepEqual(parseContext("⟦Iris⟧ 새 선택 #c1 · 어딘가\n내용: x\n⟦/Iris⟧"), { kind: "other", label: "붙인 내용", summary: "새 선택 #c1 · 어딘가" });
});

test("도구 결과 안 이미지는 위치(i·j)만 남기고 그 위치로 다시 꺼낸다", () => {
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("shot").toString("base64") } };
  const claude = { type: "user", uuid: "u9", timestamp: "2026-11-06T00:00:00Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "찍음" }, png] }] } };
  const [m] = decodeLine("claude", JSON.stringify(claude), "L0");
  const r = m.blocks.find((b) => b.type === "tool-result");
  assert.deepEqual(r.images, [{ i: 0, j: 1 }]);
  assert.match(r.output, /찍음/);
  assert.equal(imageFromRecord(claude, 0, 1).bytes.toString(), "shot");
  assert.equal(imageFromRecord(claude, 0, 0), null);       // 글 칸은 이미지 아님
  assert.equal(imageFromRecord(claude, 0), null);          // j 없으면 바깥 칸(tool_result) 자체라 이미지 아님
  const codex = { type: "response_item", timestamp: "2026-11-06T00:00:00Z", payload: { type: "function_call_output", call_id: "c1",
    output: [{ type: "input_text", text: "ok" }, { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("cx").toString("base64")}` }] } };
  const [cm] = decodeLine("codex", JSON.stringify(codex), "L0");
  assert.deepEqual(cm.blocks[0].images, [{ i: 0, j: 1 }]);
  assert.equal(imageFromRecord(codex, 0, 1).bytes.toString(), "cx");
  // 이미지 없는 도구 결과에는 images 칸이 없음(폰 기록 변환이 받는 모양 그대로)
  const plain = { ...claude, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "텍스트" }] } };
  assert.equal("images" in decodeLine("claude", JSON.stringify(plain), "L0")[0].blocks[0], false);
});

test("Claude 기록에서 지금 모델·effort·모드·컨텍스트 사용량을 읽는다", () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 4691, cache_read_input_tokens: 351638, output_tokens: 630 };
  const recs = [
    { type: "permission-mode", permissionMode: "default" },
    { type: "assistant", message: { model: "claude-haiku-5-5", usage: { input_tokens: 9 } } },
    { type: "api-request", params: { model: "claude-opus-5-5", output_config: { effort: "medium" } } },
    { type: "assistant", message: { model: "claude-opus-5-5", usage } },
    { type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5", usage: { input_tokens: 1 } } },   // 서브에이전트 줄은 무시
    { type: "permission-mode", permissionMode: "auto" },
    { type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0 } } },
  ];
  assert.deepEqual(claudeMeta(recs), { model: "claude-opus-5-5", effort: "medium", mode: "auto", usage: { used: 356961, max: null } });
  // iterations 가 있으면 마지막 것, compact 뒤에는 postTokens
  const it = claudeMeta([{ type: "assistant", message: { model: "m", usage: { input_tokens: 999, iterations: [{ input_tokens: 5 }, { input_tokens: 7, output_tokens: 1 }] } } }]);
  assert.equal(it.usage.used, 8);
  assert.equal(claudeMeta([...recs, { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 23013 } }]).usage.used, 23013);
  assert.deepEqual(claudeMeta([null, "x", {}]), { model: null, effort: null, mode: null, usage: null });
});

test("Codex 기록에서 지금 값을 읽고 모드는 Paseo 모드 조합으로 맞춘다", () => {
  const recs = [
    { type: "turn_context", payload: { model: "gpt-6-astra", effort: "high", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, approvals_reviewer: "auto_review" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 98415 }, total_token_usage: { total_tokens: 958057 }, model_context_window: 258400 } } },
  ];
  assert.deepEqual(codexMeta(recs), { model: "gpt-6-astra", effort: "high", mode: "auto-review", usage: { used: 98415, max: 258400 } });
  assert.equal(codexModeId("never", "danger-full-access", "user"), "full-access");
  assert.equal(codexModeId("on-request", "workspace-write", undefined), "auto");
  assert.equal(codexModeId("never", "read-only", "user"), null);   // Paseo 에 없는 조합
});

test("Claude 화면 아래줄에서 effort·모드를 읽는다", () => {
  assert.deepEqual(claudeFooter("❯ \n──────\n                ◐ medium · /effort\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 ag…"), { effort: "medium", mode: "auto" });
  assert.deepEqual(claudeFooter("● high · /effort\n  ⏸ plan mode on (shift+tab to cycle)"), { effort: "high", mode: "plan" });
  assert.deepEqual(claudeFooter("○ low · /effort\n  ? for shortcuts"), { effort: "low", mode: "default" });
  assert.deepEqual(claudeFooter("그냥 글"), { effort: null, mode: null });
  assert.equal(claudeFooter("  ⏸ manual mode on · ? for shortcuts · ← 6 agen…").mode, "default");   // Claude Code 2.1.318 기본 모드
});

test("Codex 모델 캐시를 Paseo 모델 정의 모양으로 바꾼다", () => {
  const cache = { models: [
    { slug: "gpt-6-astra", display_name: "gpt-6-astra", description: "d", default_reasoning_level: "medium", priority: 2, visibility: "list", context_window: 258400,
      supported_reasoning_levels: [{ effort: "low", description: "빠름" }, { effort: "medium", description: "" }] },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", default_reasoning_level: "xhigh", priority: 1, visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "codex-auto-review", visibility: "hide", priority: 0 },
  ] };
  const out = codexModelsFromCache(cache);
  assert.deepEqual(out.map((m) => m.id), ["gpt-6-astra", "gpt-6.1-sol"]);
  assert.equal(out[0].label, "GPT-6-astra");
  assert.equal(out[1].isDefault, true);              // 설정 없으면 priority 가 가장 작은 것
  assert.deepEqual(out[0].thinkingOptions, [{ id: "low", label: "low", description: "빠름", isDefault: false }, { id: "medium", label: "medium", isDefault: true }]);
  assert.equal(out[0].contextWindowMaxTokens, 258400);
  assert.equal(out[1].thinkingOptions.at(-1).id, "xhigh");   // 목록에 없는 기본값도 선택지로
  assert.equal(codexModelsFromCache(cache, "gpt-6-astra")[0].isDefault, true);
  assert.deepEqual(codexModelsFromCache(null), []);
  assert.equal(codexConfiguredModel('model = "gpt-6-astra"\n[profiles.x]\nmodel = "y"'), "gpt-6-astra");
  assert.equal(codexConfiguredModel('[profiles.x]\nmodel = "y"'), null);
});

test("기록 꼬리는 완전한 줄만 읽고 다음 읽을 위치를 돌려준다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achat-meta-"));
  try {
    const f = path.join(dir, "s.jsonl");
    fs.writeFileSync(f, JSON.stringify({ a: 1 }) + "\n" + JSON.stringify({ a: 2 }) + "\n{\"a\":");
    const r1 = readRecords(f, 0);
    assert.deepEqual(r1.records, [{ a: 1 }, { a: 2 }]);
    fs.appendFileSync(f, "3}\n");
    const r2 = readRecords(f, r1.end);
    assert.deepEqual(r2.records, [{ a: 3 }]);
    assert.equal(r2.end, fs.statSync(f).size);
    assert.deepEqual(readRecords(f, r2.end).records, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("권한 질문 선택지 글에서 화면 표시(❯·번호)를 뗀다", () => {
  assert.equal(optionLabel("❯ 1. Yes"), "Yes");
  assert.equal(optionLabel("  2. Yes, and don't ask again"), "Yes, and don't ask again");
  assert.equal(optionLabel("› 3) No"), "No");
  assert.equal(optionLabel("No"), "No");
});

test("Claude `!명령` 기록은 Bash 도구 호출·결과로 짝지어 보인다", () => {
  const input = { type: "user", uuid: "u1", parentUuid: "p0", timestamp: "2026-11-06T00:00:00Z", message: { role: "user", content: "<bash-input>cat sample.txt</bash-input>" } };
  const output = { type: "user", uuid: "u2", parentUuid: "u1", timestamp: "2026-11-06T00:00:01Z", message: { role: "user", content: "<bash-stdout>가나다\nabc</bash-stdout><bash-stderr></bash-stderr>" } };
  const [call] = decodeLine("claude", JSON.stringify(input), "L0");
  assert.deepEqual(call.blocks, [{ type: "tool-call", id: "bash-u1", name: "Bash", input: { command: "cat sample.txt" } }]);
  const [res] = decodeLine("claude", JSON.stringify(output), "L1");
  assert.deepEqual(res.blocks, [{ type: "tool-result", id: "bash-u1", output: "가나다\nabc", isError: false }]);
  const err = { ...output, message: { role: "user", content: "<bash-stdout></bash-stdout><bash-stderr>no such file</bash-stderr>" } };
  assert.equal(decodeLine("claude", JSON.stringify(err), "L2")[0].blocks[0].isError, true);
  // 같은 태그를 쓰는 기계 턴(isMeta)과 글 중간 태그는 바꾸지 않음
  assert.deepEqual(decodeLine("claude", JSON.stringify({ ...input, isMeta: true }), "L3"), []);
  assert.equal(decodeLine("claude", JSON.stringify({ ...input, message: { role: "user", content: "앞 글 <bash-input>ls</bash-input>" } }), "L4")[0].blocks[0].type, "text");
});

test("권한 카드: 여러 개 고르기·직접 입력은 카드로 답하지 않고, 질문 id 는 내용·회차가 다르면 다르다", () => {
  const opt = (row, text, extra = {}) => ({ row, text, selectable: true, ...extra });
  const base = { title: "Edit file", question: "Do you want to make this edit?", detail: "- a\n+ b", options: [opt(10, "1. Yes"), opt(11, "2. No")] };
  assert.deepEqual(cardChoices(base).map((o) => o.row), [10, 11]);
  assert.deepEqual(cardChoices({ ...base, multiSelect: true }), []);
  assert.deepEqual(cardChoices({ ...base, options: [opt(10, "1. Yes"), opt(12, "3. Type something", { selectable: false })] }).map((o) => o.row), [10]);
  assert.deepEqual(cardChoices(null), []);
  const sub = { paneId: "w1:p1", promptGen: 0 };
  const id = promptIdOf(sub, base);
  assert.equal(promptIdOf(sub, { ...base }), id, "같은 질문은 같은 id");
  assert.notEqual(promptIdOf(sub, { ...base, detail: "- a\n+ c" }), id, "문구가 같아도 바꾸는 내용이 다르면 다른 id");
  assert.notEqual(promptIdOf({ ...sub, promptGen: 1 }, base), id, "답한 뒤 같은 질문이 다시 오면 다른 id");
});

test("질문 카드: 답한 직후 화면에 남은 같은 질문은 새 질문으로 보지 않음(일정 시간만)", () => {
  const p = { title: "Bash", question: "진행할까요?", detail: "touch a", options: [{ text: "Yes" }, { text: "No" }] };
  const answered = { content: JSON.stringify(["Bash", "진행할까요?", "touch a", ["Yes", "No"]]), until: 1000 + ANSWER_SETTLE_MS };
  assert.equal(isAnsweredLeftover(answered, p, 1000), true, "답한 직후 같은 질문");
  assert.equal(isAnsweredLeftover(answered, p, 1000 + ANSWER_SETTLE_MS), false, "시간이 지나면 다시 물은 것");
  assert.equal(isAnsweredLeftover(answered, { ...p, detail: "touch b" }, 1000), false, "내용이 다르면 새 질문");
  assert.equal(isAnsweredLeftover(null, p, 1000), false);
});

test("글 속 칩: 이미지 칩 자리에 경로, 칩 없는 이미지·파일은 끝에(예전 [Image #N] 도 읽음)", () => {
  const ex = (t, imagePaths, attachments = []) => expandText(t, { imagePaths, attachments });
  const [i1, i2, i3] = [imageTag(1), imageTag(2), imageTag(3)];
  assert.equal(tokenLabel(i2), "이미지 2");
  assert.equal(ex(`이 ${i1} 버튼 색을 ${i2} 처럼`, ["/u/a.png", "/u/b.png"]), "이 /u/a.png 버튼 색을 /u/b.png 처럼");
  assert.equal(ex("둘 다 봐", ["/u/a.png", "/u/b.png"], ["/u/c.pdf"]), "둘 다 봐 /u/a.png /u/b.png /u/c.pdf");
  assert.equal(ex("[Image #2] 만", ["/u/a.png", "/u/b.png"]), "/u/b.png 만 /u/a.png");
  assert.equal(ex(`없는 ${i3}`, ["/u/a.png"]), `없는 ${i3} /u/a.png`);
  assert.equal(ex("", ["/u/a.png"]), "/u/a.png");
});

test("글 속 칩: 요소 칩 자리에 내용, 칩 없는 요소는 글 앞, 이름·요약이 같아도 칩끼리 구별", () => {
  const el = { id: "a", no: 1, content: "⟦Iris⟧ 요소 선택\n요소: <button#go> \"보내기\"" };
  const same = { ...el, id: "c", no: 3 };
  const paste = { id: "b", no: 2, kind: "paste", content: "줄1\n줄2\n줄3" };
  assert.equal(tokenLabel(contextTag(el)), "브라우저 요소 · 보내기");
  assert.equal(tokenLabel(contextTag(paste)), "붙인 글 · 3줄");
  assert.notEqual(contextTag(el), contextTag(same));
  assert.equal(expandText(`이 ${contextTag(el)} 고쳐`, { contexts: [el] }), `이\n${el.content}\n고쳐`);
  assert.equal(expandText("봐", { contexts: [el] }), `${el.content}\n\n봐`);
  assert.equal(expandText(contextTag(paste), { contexts: [paste] }), paste.content);
  assert.deepEqual(findTokens(contextTag(same), [el]), [], "다른 칩의 글자로는 안 잡힘");
  // 칩 자리 글자는 줄바꿈되지 않음(일반 공백 없음)
  assert.equal(/ /.test(contextTag(el)), false);
});

test("글 속 칩: 지우면 위 미리보기에서도 빼고, 뺀 이미지 뒤 번호는 당김", () => {
  const el = { id: "a", no: 1, content: "⟦Iris⟧ 요소 선택\n요소: <a>" };
  const [i1, i2, i3] = [imageTag(1), imageTag(2), imageTag(3)];
  assert.deepEqual(removedTokens(`x ${i1} ${i2} ${contextTag(el)}`, `x ${i2}`, [el]), { images: [1], attachments: [], ids: ["a"] });
  assert.deepEqual(removedTokens(`${i1} ${i1}`, i1), { images: [], attachments: [], ids: [] });
  assert.equal(dropImage(`a ${i1} b ${i2} c ${i3}`, 2), `a ${i1} b c ${i2}`);
  assert.deepEqual(cutToken(`a ${i1} b`, findTokens(`a ${i1} b`)[0]), { text: "a b", caret: 2 });
  const toks = findTokens(`a ${i1} b`);
  assert.equal(tokensToDelete(toks, toks[0].end, toks[0].end, -1).length, 1, "칩 바로 뒤 Backspace");
  assert.equal(tokensToDelete(toks, 2, 2, 1).length, 1, "칩 바로 앞 Delete");
  assert.equal(tokensToDelete(toks, 2, 2, -1).length, 0, "칩 앞 Backspace 는 앞 글자");
  assert.equal(tokensToDelete(toks, 0, 4, -1).length, 1, "선택이 칩에 걸치면 칩 전체");
});

test("글 속 칩: 이미지 아닌 첨부(파일·GitHub 항목)도 칩, 지우면 번호 당김, 보낼 때 칩 자리에 경로·내용", () => {
  const [f1, f2, f3] = [attachmentTag("a.pdf", 1), attachmentTag("notes.txt", 2), attachmentTag("#12 Fix login", 3)];
  assert.equal(tokenLabel(f1), "a.pdf");
  assert.equal(tokenLabel(f3), "#12 Fix login");
  assert.equal(/ /.test(f3), false, "칩 자리 글자는 줄바꿈되지 않음");
  const toks = findTokens(`x ${f1} ${imageTag(1)} ${f2}`);
  assert.deepEqual(toks.map((t) => [t.type, t.n]), [["attachment", 1], ["image", 1], ["attachment", 2]]);
  assert.deepEqual(removedTokens(`${f1} ${f2} ${f3}`, `${f1} ${f3}`), { images: [], attachments: [2], ids: [] });
  assert.equal(dropAttachment(`a ${f1} b ${f2} c ${f3}`, 2), `a ${f1} b c ${attachmentTag("#12 Fix login", 2)}`);
  assert.equal(expandText(`이 ${f2} 와 ${f1} 비교`, { attachments: ["/u/a.pdf", "/u/notes.txt"] }), "이 /u/notes.txt 와 /u/a.pdf 비교");
  assert.equal(expandText("봐", { imagePaths: ["/u/i.png"], attachments: ["/u/a.pdf"] }), "봐 /u/i.png /u/a.pdf", "칩 없는 첨부는 글 끝");
  // 긴 이름은 확장자가 보이게 줄임, 칩 경계 문자는 이름에서 뺌
  assert.equal(tokenLabel(attachmentTag("a-very-long-file-name-for-report-2026.pdf", 1)), "a-very-long-fil…026.pdf");
  assert.equal(findTokens(attachmentTag("x⟧y", 1)).length, 1);
});

test("첨부 칩 이름·여는 곳, 보낼 첨부의 글", () => {
  assert.deepEqual(describeAttachment({ kind: "file", attachment: { fileName: "a.pdf", path: "/s/a.pdf" } }), { label: "a.pdf", icon: "file", path: "/s/a.pdf" });
  assert.deepEqual(describeAttachment({ kind: "workspace_file", path: "src/x.ts", selection: { kind: "line_range", startLine: 3, endLine: 9 } }), { label: "x.ts:3-9", icon: "file", path: "src/x.ts" });
  assert.deepEqual(describeAttachment({ kind: "github_pr", item: { number: 12, title: "Fix login", url: "https://g/12" } }), { label: "#12 Fix login", icon: "link", url: "https://g/12" });
  assert.equal(describeAttachment(undefined).label, "첨부");
  assert.equal(attachmentText({ type: "uploaded_file", path: "/s/a.pdf", fileName: "a.pdf" }), "@/s/a.pdf");
  assert.equal(attachmentText({ type: "uploaded_file", fileName: "a.pdf" }), "", "경로 없으면 빈 글");
  assert.equal(attachmentText({ type: "text", mimeType: "text/plain", title: "x.ts", text: "Workspace file: src/x.ts" }), "Workspace file: src/x.ts");
  assert.equal(attachmentText({ type: "forge_issue", title: "Bug", url: "https://g/1" }), "Bug https://g/1");
});

test("칩 글자: 글자 사이 줄 나눔 금지 문자, 한 줄보다 긴 칩은 이름을 줄여도 같은 칩으로 읽음", () => {
  const f = attachmentTag("u36-sample-notes.txt", 2);
  assert.ok([...f].every((ch, i) => i % 2 === 0 || ch === "\ufeff"), "글자 사이마다 U+FEFF");
  const short = shrinkTag(f, 0.5);
  assert.equal(tokenLabel(short), "u36-s….txt", "확장자는 남기고 가운데를 줄임");
  assert.deepEqual(findTokens(`a ${short}`).map((t) => [t.type, t.n]), [["attachment", 2]]);
  const paste = { id: "p", no: 3, kind: "paste", content: "1\n2\n3" };
  const ps = shrinkTag(contextTag(paste), 0.5);
  assert.equal(tokenLabel(ps), "붙인 …");
  assert.deepEqual(findTokens(ps, [paste]).map((t) => t.id), ["p"], "이름을 줄여도 같은 요소");
  assert.equal(expandText(`x ${ps}`, { contexts: [paste] }), `x\n${paste.content}`);
  assert.equal(shrinkTag(imageTag(1), 0.3), null, "이미지 칩은 줄이지 않음");
  assert.equal(shrinkTag(attachmentTag("ab", 1), 0.9), null, "더 줄일 수 없으면 null");
  // U+FEFF 없는 예전 칩도 읽음
  assert.equal(findTokens("⟦\u2002\u2002이미지\u00a01\u2002\u2002⟧").length, 1);
});

test("설치 전 초안의 칩 글자: 번호가 어긋나도 이름으로 찾고, 새 형식으로 바꿈", () => {
  const el = { id: "a", no: 1, content: "⟦Iris⟧ 요소 선택\n요소: <p> \"문서 상태\"" };
  const el2 = { id: "b", no: 2, content: el.content };
  const old = (c, n) => contextTag({ ...c, no: n }).split("\ufeff").join("");
  // 번호 1·3 인 예전 글자(요소 목록은 1·2)
  const text = `${old(el, 1)} ${old(el2, 3)}`;
  assert.deepEqual(findTokens(text, [el, el2]).map((t) => t.type), ["context", "context"]);
  const up = reglue(text, [el, el2]);
  assert.ok(up.includes("\ufeff"));
  assert.equal(findTokens(up, [el, el2]).length, 2);
  assert.equal(reglue(up, [el, el2]), up, "새 형식은 그대로");
});

test("대화 선택 블록: 칩 종류 대화, 요약은 내용 첫 줄·이미지 파일 이름", async () => {
  const { chatPickBlock } = await import("../web/js/agentchat/chat-pick.js");
  const { parseContext } = await import("../server/paseo-ui/entry/iris-contexts-model.js");
  const text = chatPickBlock({ pid: "c1", where: "iris", kind: "에이전트 답 · 문단", text: "첫 줄\n둘째", image: "" });
  assert.equal(text, "⟦Iris⟧ 대화 선택 #c1 · iris\n종류: 에이전트 답 · 문단\n내용:\n첫 줄\n둘째\n⟦/Iris⟧");
  assert.deepEqual(parseContext(text), { kind: "chat", label: "대화", summary: "첫 줄" });
  assert.equal(parseContext(chatPickBlock({ pid: "c2", kind: "에이전트 답 · 이미지", text: "", image: "/s/a.png" })).summary, "a.png");
  assert.equal(parseContext(chatPickBlock({ pid: "c3", kind: "도구", text: "", image: "" })).summary, "도구");
});

test("긴 붙여넣기: 800자 넘거나 10줄 넘으면 칩", () => {
  assert.equal(isLongPaste("짧은 글"), false);
  assert.equal(isLongPaste("x".repeat(801)), true);
  assert.equal(isLongPaste(Array.from({ length: 11 }, (_, i) => i).join("\n")), true);
  assert.equal(isLongPaste(Array.from({ length: 10 }, (_, i) => i).join("\n")), false);
});

// 기본 보기(U18): 설정값·pane 별 선택·설정 화면 분류
test("기본 보기: 설정값이 없으면 대화 화면, pane 에서 고른 보기가 우선", async () => {
  const { chatFor, parseDefaultView } = await import("../web/js/agentchat/view-pref.js");
  assert.equal(parseDefaultView(null), "chat");
  assert.equal(parseDefaultView("term"), "term");
  assert.equal(parseDefaultView("bogus"), "chat");
  assert.equal(chatFor(undefined, "chat", null), true);
  assert.equal(chatFor(undefined, "term", null), false);
  assert.equal(chatFor(undefined, "term", "w1:p1"), true);
  assert.equal(chatFor("term", "chat", null), false);
  assert.equal(chatFor("chat", "term", null), true);
});

test("설정 화면: 기능이 채운 분류가 목록에 보이고 고른 값이 눌린 상태", async () => {
  const { settingsSection } = await import("../web/js/agentchat/view-pref.js");
  const { settingsMarkup } = await import("../web/js/devtool/settings-view.js");
  const sec = settingsSection("term");
  const html = settingsMarkup({ section: "agentchat", featureSections: [sec] });
  assert.match(html, /data-km-sec="agentchat"[^>]*>대화 화면/);
  assert.match(html, /data-fs-value="term" aria-pressed="true"/);
  assert.match(html, /data-fs-value="chat" aria-pressed="false"/);
  // 기능이 꺼지면 분류가 빠지고 단축키 분류로 돌아감
  const off = settingsMarkup({ section: "agentchat" });
  assert.doesNotMatch(off, /data-km-sec="agentchat"/);
  assert.match(off, /data-km-sec="keys"/);
});

// 질문 카드 버튼 id 는 선택지 순서. 화면 줄 번호를 쓰면 다시 그려진 화면에서 다른 선택지를 가리킴
test("질문 카드: 버튼 id 는 순서로 매기고 답은 순서로 찾음", async () => {
  const { actionId, answerIndex } = await import("../server/paseo-ui/entry/iris-prompt-actions.js");
  const options = [{ row: 31, role: "allow" }, { row: 32, role: "allowAlways" }, { row: 34, role: "deny" }];
  assert.equal(actionId(2), "option-2");
  assert.equal(answerIndex(options, { behavior: "deny", selectedActionId: "option-2" }), 2);
  // 예전 화면의 줄 번호가 id 로 와도 그 줄의 선택지를 고르지 않음
  assert.equal(answerIndex(options, { behavior: "deny", selectedActionId: "32" }), 2);
  assert.equal(answerIndex(options, { behavior: "allow" }), 0);
  assert.equal(answerIndex(options, { selectedActionId: "option-9" }), null);
  assert.equal(answerIndex([], { behavior: "deny" }), null);
});

test("설정 화면: 대화 표시 줄은 Paseo 채팅 설정 화면을 iframe 으로 띄움", async () => {
  const { settingsSection, CHAT_SETTINGS_URL } = await import("../web/js/agentchat/view-pref.js");
  const { settingsMarkup } = await import("../web/js/devtool/settings-view.js");
  const html = settingsMarkup({ section: "agentchat", featureSections: [settingsSection("chat", 259)] });
  assert.match(html, new RegExp(`<iframe class="km-frame" data-fs-frame="agentchat:paseoChat" src="${CHAT_SETTINGS_URL.replace(/[?]/g, "\\?")}"`));
  assert.match(html, /height:259px/);
  assert.match(settingsMarkup({ section: "agentchat", featureSections: [settingsSection("chat")] }), /height:240px/);
});

test("서브에이전트 보기에서 보낸 글: 부모에게 SendMessage 전달 부탁으로 감쌈", () => {
  const out = subagentRelayText({ agentId: "a1b2", description: "로그 정리", text: "결과만 짧게\n줄 둘" });
  assert.match(out, /^서브에이전트 a1b2\(로그 정리\)에게 SendMessage 로/);
  assert.ok(out.endsWith("\n\n결과만 짧게\n줄 둘"));
  assert.match(subagentRelayText({ agentId: "a1b2", text: "x" }), /^서브에이전트 a1b2에게/);
});

test("전달 전 보낸 글: 입력줄로 되돌아온 글 찾기, 말풍선 맨 끝으로", async () => {
  const { poppedSends, pinPendingLast } = await import("../server/paseo-ui/entry/iris-pending-sends.js");
  const sends = [{ id: "a", text: "첫 글" }, { id: "b", text: "둘째\n글" }];
  assert.deepEqual(poppedSends("첫 글\n둘째 글", sends), ["a", "b"], "여러 글이 이어 붙어 되돌아옴, 줄바꿈은 공백으로 비교");
  assert.deepEqual(poppedSends("다른 글", sends), []);
  assert.deepEqual(poppedSends("", sends), []);
  const u = (id, extra = {}) => ({ kind: "user_message", id, clientMessageId: id, text: id, ...extra });
  const t = (id) => ({ kind: "tool_call", id });
  const p = u("p");
  assert.equal(pinPendingLast([t(1), p], [], ["p"]), null, "이미 끝이면 그대로");
  const moved = pinPendingLast([t(1), p, t(2)], [], ["p"]);
  assert.deepEqual(moved.tail.map((x) => x.id), [1, 2, "p"]);
  const toHead = pinPendingLast([p, t(1)], [t(3)], ["p"]);
  assert.deepEqual([toHead.tail.map((x) => x.id), toHead.head.map((x) => x.id)], [[1], [3, "p"]], "쓰는 중인 행이 있으면 그 뒤");
  assert.equal(pinPendingLast([t(1), u("p", { messageId: "p" }), t(2)], [], ["p"]), null, "기록 행과 짝지어진 말풍선은 옮기지 않음");
  assert.equal(pinPendingLast([t(1)], [], []), null);
});

test("입력창 임시 저장: 미리보기, 칩 번호 다시 매기기, 목록 한도", async () => {
  const { isEmptyDraft, parseStashList, pushStash, renumberForRestore, stashPreview, STASH_MAX } = await import("../server/paseo-ui/entry/iris-stash-model.js");
  const el = { id: "e1", no: 3, content: "⟦Iris⟧ 요소 선택\n요소: <button> \"보내기\"\n⟦/Iris⟧" };
  const text = `이거 고쳐 ${contextTag(el)} 그리고\n둘째 줄`;
  assert.equal(stashPreview(text, [el]), `이거 고쳐 [${tokenLabel(contextTag(el))}] 그리고 둘째 줄`);
  const r = renumberForRestore(text, [el], [{ id: "x", no: 5 }]);
  assert.deepEqual(r.contexts, [{ content: el.content, no: 6 }]);
  assert.equal(r.text, `이거 고쳐 ${contextTag({ ...el, no: 6 })} 그리고\n둘째 줄`, "글 속 칩 글자가 새 번호로");
  assert.deepEqual(findTokens(r.text, [{ ...el, id: "n", no: 6 }]).map((t) => t.id), ["n"]);
  assert.equal(renumberForRestore("글만", [], []).text, "글만");
  assert.equal(isEmptyDraft("  ", [], []), true);
  assert.equal(isEmptyDraft("", [{}], []), false);
  const many = Array.from({ length: STASH_MAX }, (_, i) => ({ id: `s${i}`, at: i, contexts: [] }));
  const p = pushStash(many, { id: "new", at: 99, contexts: [] });
  assert.equal(p.list[0].id, "new");
  assert.equal(p.list.length, STASH_MAX);
  assert.deepEqual(p.dropped, [`s${STASH_MAX - 1}`]);
  assert.deepEqual(parseStashList('[{"id":"a","at":1,"contexts":[]},{"id":2}]').map((x) => x.id), ["a"]);
  assert.deepEqual(parseStashList("깨짐"), []);
});

test("중단·되감기로 되돌린 글: 같은 부모의 뒤 글이 오면 앞 글부터 그 직전까지 뺌", async () => {
  const { dropRewound } = await import("../server/paseo-ui/entry/iris-pending-sends.js");
  const u = decodeLine("claude", line({ type: "user", uuid: "u1", parentUuid: "a0", timestamp: TS, message: { role: "user", content: "되돌린 글" } }));
  assert.equal(u[0].parent, "a0", "사용자 글에 부모 줄");
  const a = decodeLine("claude", line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: TS, message: { content: [{ type: "text", text: "답" }] } }));
  assert.equal(a[0].parent, undefined, "에이전트 글에는 없음");
  const m = (id, role, parent) => ({ id, role, blocks: [{ type: "text", text: id }], ...(parent ? { parent } : {}) });
  // 보낸 직후 중단: u1 이 입력줄로 돌아가고 u2 가 같은 부모 a0
  assert.deepEqual(dropRewound([m("a0", "assistant"), m("u1", "user", "a0"), m("u2", "user", "a0"), m("a2", "assistant")]).map((x) => x.id), ["a0", "u2", "a2"]);
  // 앞 시점으로 되감기: 그 사이 줄 모두 버려진 가지
  assert.deepEqual(dropRewound([m("u0", "user", "r"), m("a0", "assistant"), m("u1", "user", "a0"), m("a1", "assistant"), m("t1", "tool"), m("u2", "user", "a0")]).map((x) => x.id), ["u0", "a0", "u2"]);
  // 보통 대화·부모 없는 글(처음·압축 요약)은 그대로
  const plain = [m("u0", "user"), m("a0", "assistant"), m("u1", "user", "a0"), m("a1", "assistant"), m("u2", "user", "a1"), m("u3", "user")];
  assert.equal(dropRewound(plain), plain);
});

test("중단 직후 입력줄로 돌아온 마지막 글 판정", async () => {
  const { rewoundLastId } = await import("../server/paseo-ui/entry/iris-pending-sends.js");
  const m = (id, role, text) => ({ id, role, blocks: [{ type: "text", text }] });
  const msgs = [m("a0", "assistant", "답"), m("u1", "user", "1부터 40까지\n세어 줘")];
  assert.equal(rewoundLastId(msgs, "1부터 40까지 세어 줘", false), "u1", "입력줄 줄바꿈은 공백으로 맞춤");
  assert.equal(rewoundLastId(msgs, "앞에 쓰던 글 1부터 40까지 세어 줘", false), "u1", "입력줄에 다른 글과 이어 붙어 있어도");
  assert.equal(rewoundLastId(msgs, "1부터 40까지 세어 줘", true), null, "일하는 중이면 아님");
  assert.equal(rewoundLastId(msgs, "", false), null, "입력줄이 비면 아님");
  assert.equal(rewoundLastId([...msgs, m("a1", "assistant", "1")], "1부터 40까지 세어 줘", false), null, "답이 뒤에 있으면 아님");
  assert.equal(rewoundLastId(msgs, "다른 글", false), null);
});
