import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { attachQuestionState } from "../server/agent-question.js";

// 기록 폴더 두 곳(Claude projects, Codex sessions)을 임시 폴더로 옮겨 실제 사용자 기록을 읽지 않는다.
function homes(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-question-"));
  const prev = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(path.join(root, "claude", "projects", "p"), { recursive: true });
  fs.mkdirSync(path.join(root, "codex", "sessions", "d"), { recursive: true });
  t.after(() => {
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", prev.claude], ["CODEX_HOME", prev.codex]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  return {
    root,
    claude(records) { const f = path.join(root, "claude", "projects", "p", `s${n++}.jsonl`); write(f, records); return f; },
    codex(records) { const f = path.join(root, "codex", "sessions", "d", `r${n++}.jsonl`); write(f, records); return f; },
  };
}
const write = (f, records) => fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const cUser = (text) => ({ type: "user", message: { role: "user", content: text } });
const cToolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const cSay = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const cTool = () => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
const xUser = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const xSay = (text) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const xCall = () => ({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" } });

const claudeAgent = (file, status = "done") => ({ agent: "claude", status, transcriptFile: file });
const codexAgent = (file, status = "idle") => ({ agent: "codex", status, sessionFile: file });
const judgeOne = (agent) => attachQuestionState([agent])[0].question;

test("Claude: 마지막 답이 물음표로 끝나면 질문, 마침표면 아니다", (t) => {
  const h = homes(t);
  assert.equal(judgeOne(claudeAgent(h.claude([cUser("고쳐 줘"), cSay("고쳤습니다.\n이대로 커밋할까요?")]))), true);
  assert.equal(judgeOne(claudeAgent(h.claude([cUser("고쳐 줘"), cSay("고쳤습니다.")]))), false);
});

test("Claude: 물음표 뒤 닫는 괄호·강조·전각 물음표를 허용하고 빈 줄은 건너뛴다", (t) => {
  const h = homes(t);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("정리했습니다.\n\n**어느 쪽으로 할까요?**\n\n")]))), true);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("(A 로 갈까요?)")]))), true);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("진행할까요？")]))), true);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("왜 그런가? 원인은 캐시다.")]))), false);
});

test("Claude: 질문 뒤에 사용자가 말했으면 질문이 아니다", (t) => {
  const h = homes(t);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("이대로 할까요?"), cUser("응")]))), false);
});

test("Claude: 도구 호출만 있는 마지막 레코드와 도구 결과는 건너뛰고 그 전 텍스트로 판정한다", (t) => {
  const h = homes(t);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("이대로 할까요?"), cTool(), cToolResult(), cTool()]))), true);
  assert.equal(judgeOne(claudeAgent(h.claude([cSay("끝났습니다."), cTool()]))), false);
});

test("Codex: 마지막 assistant 메시지로 판정하고 사용자 메시지가 뒤에 있으면 아니다", (t) => {
  const h = homes(t);
  assert.equal(judgeOne(codexAgent(h.codex([xUser("해 줘"), xSay("테스트를 더 넣을까요?"), xCall()]))), true);
  assert.equal(judgeOne(codexAgent(h.codex([xUser("해 줘"), xSay("완료했습니다.")]))), false);
  assert.equal(judgeOne(codexAgent(h.codex([xSay("테스트를 더 넣을까요?"), xUser("아니")]))), false);
});

test("done·idle 이 아니면 읽지 않고 false, 허용 폴더 밖 파일도 false", (t) => {
  const h = homes(t);
  const f = h.claude([cSay("할까요?")]);
  assert.equal(judgeOne(claudeAgent(f, "working")), false);
  assert.equal(judgeOne(claudeAgent(f, "blocked")), false);
  const outside = path.join(h.root, "elsewhere.jsonl");
  write(outside, [cSay("할까요?")]);
  assert.equal(judgeOne(claudeAgent(outside)), false);
  const link = path.join(h.root, "claude", "projects", "p", "link.jsonl");
  fs.symlinkSync(outside, link);
  assert.equal(judgeOne(claudeAgent(link)), false, "허용 폴더 안의 심볼릭 링크가 밖을 가리키면 읽지 않는다");
});

test("파일이 바뀌면 캐시를 쓰지 않고 다시 판정한다", (t) => {
  const h = homes(t);
  const f = h.claude([cSay("할까요?")]);
  assert.equal(judgeOne(claudeAgent(f)), true);
  fs.appendFileSync(f, JSON.stringify(cUser("응")) + "\n");
  assert.equal(judgeOne(claudeAgent(f)), false);
});

test("64KB 보다 긴 기록은 끝만 읽고, 잘린 첫 줄은 버린다", (t) => {
  const h = homes(t);
  const filler = Array.from({ length: 40 }, () => cSay("x".repeat(4000) + "?"));
  const f = h.claude([...filler, cUser("다음"), cSay("다 됐습니다. 배포할까요?")]);
  assert.ok(fs.statSync(f).size > 64 * 1024);
  assert.equal(judgeOne(claudeAgent(f)), true);
});
