// Antigravity(agy) 실행 argv · 세션 ID 추출 · 대화 기록 디코딩 · 도구 짝짓기 · 초안 · 메타 · 명령 목록 검증
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { agentArgv } from "../server/agent-launch.js";
import { reportAgentSessionPath } from "../server/agent-session-path.js";
import { agySessionFromPath, agyTranscriptPath, extractAgyConversationId } from "../server/agy-session.js";
import { terminalDraft } from "../server/agent-chat-draft.js";
import { agyDefaultModels, agyFooter, agyMeta } from "../server/agent-chat-meta.js";
import { openAgyAskAfter, pendingAgyQuestion } from "../server/agent-chat-question.js";
import { listCommands } from "../server/agent-chat-tools.js";
import { decodeLine, readForward, readTailWindow } from "../server/agent-chat-transcript.js";

test("agy 와 antigravity 실행·재개 명령을 만든다", () => {
  assert.deepEqual(agentArgv("agy"), ["agy"]);
  assert.deepEqual(agentArgv("agy", { resumeSession: "038e24dd-6576-47ca-b06b-cf33696c9627" }),
    ["agy", "--conversation", "038e24dd-6576-47ca-b06b-cf33696c9627"]);
  assert.deepEqual(agentArgv("antigravity"), ["agy"]);
});

test("presence 잠금 파일과 brain 경로에서 대화 UUID 를 추출한다", () => {
  assert.equal(
    extractAgyConversationId("/tmp/iris-fixture-home/.gemini/antigravity-cli/presence/038e24dd-6576-47ca-b06b-cf33696c9627.lock"),
    "038e24dd-6576-47ca-b06b-cf33696c9627",
  );
  assert.equal(
    extractAgyConversationId("/tmp/iris-fixture-home/.gemini/antigravity-cli/brain/038e24dd-6576-47ca-b06b-cf33696c9627/scratch"),
    "038e24dd-6576-47ca-b06b-cf33696c9627",
  );
  assert.equal(extractAgyConversationId("/tmp/iris-fixture-home/.gemini/antigravity-cli/cache"), null);
});

test("Antigravity transcript.jsonl 줄을 대화 메시지로 변환하고 표준 도구 카드로 매핑한다", () => {
  const user = decodeLine("agy", JSON.stringify({
    step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-23T19:18:34Z",
    content: "<USER_REQUEST>\n안녕\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>",
  }), "L0");
  assert.equal(user.length, 1);
  assert.equal(user[0].role, "user");
  assert.equal(user[0].blocks[0].text, "안녕");

  const plan = decodeLine("agy", JSON.stringify({
    step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-23T19:18:35Z",
    model: "gemini-4-neon-medium", thinking: "생각 중", content: "답변",
    tool_calls: [{ name: "run_command", args: { CommandLine: "\"ls -la\"", toolSummary: "\"목록 확인\"" } }],
  }), "L1");
  assert.equal(plan.length, 2);
  assert.equal(plan[0].role, "reasoning");
  assert.equal(plan[0].blocks[0].text, "생각 중");
  assert.equal(plan[1].role, "assistant");
  assert.equal(plan[1].blocks[0].text, "답변");
  assert.equal(plan[1].blocks[1].type, "tool-call");
  assert.equal(plan[1].blocks[1].name, "Bash");
  assert.deepEqual(plan[1].blocks[1].input, { command: "ls -la", description: "목록 확인" });

  const tool = decodeLine("agy", JSON.stringify({
    step_index: 2, source: "MODEL", type: "GENERIC", created_at: "2026-11-23T19:18:36Z",
    content: "Command exited with code 0.\n\nok",
  }), "L2");
  assert.equal(tool.length, 1);
  assert.equal(tool[0].role, "tool");
  assert.equal(tool[0].blocks[0].isError, false);

  const sys = decodeLine("agy", JSON.stringify({
    step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "reminder",
  }), "L3");
  assert.equal(sys.length, 0);
});

test("readTailWindow 와 readForward 가 Antigravity 도구 호출과 결과를 순서대로 짝짓는다", () => {
  const initialLines = [
    JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\n질문\n</USER_REQUEST>" }),
    JSON.stringify({
      step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE",
      tool_calls: [
        { name: "read_file", args: { Path: "\"/a/b.js\"", StartLine: 10, EndLine: 20 } },
        { name: "edit_file", args: { Path: "\"/a/b.js\"", Target: "\"old\"", Replacement: "\"new\"" } },
      ],
    }),
    JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", content: "Showing lines 10-20" }),
  ];
  const buf1 = Buffer.from(initialLines.join("\n") + "\n", "utf8");
  const queue = [];
  const win = readTailWindow({
    size: buf1.length,
    readAt: (b, p) => buf1.copy(b, 0, p, p + b.length),
  }, { end: buf1.length, want: 20, kind: "agy", pendingToolIds: queue });

  assert.equal(win.messages[1].blocks[0].name, "Read");
  assert.deepEqual(win.messages[1].blocks[0].input, { file_path: "/a/b.js", offset: 10, limit: 11 });
  assert.equal(win.messages[1].blocks[1].name, "Edit");
  assert.equal(win.messages[2].blocks[0].id, "s1:tc0");
  assert.deepEqual(queue, ["s1:tc1"]);

  const appended = Buffer.from(JSON.stringify({ step_index: 3, source: "MODEL", type: "GENERIC", content: "Made 1 replacement" }) + "\n", "utf8");
  const buf2 = Buffer.concat([buf1, appended]);
  const fwd = readForward({
    size: buf2.length,
    readAt: (b, p) => buf2.copy(b, 0, p, p + b.length),
  }, buf1.length, "agy", queue);
  assert.equal(fwd.messages.length, 1);
  assert.equal(fwd.messages[0].blocks[0].id, "s1:tc1");
  assert.deepEqual(queue, []);
});

test("agyMeta 는 마지막 PLANNER_RESPONSE 에서 모델·effort 와 컨텍스트 사용량을 읽는다", () => {
  const meta = agyMeta([
    { type: "USER_INPUT", content: "hi" },
    { type: "PLANNER_RESPONSE", model: "gemini-4-neon-medium", input_tokens: 1000, cache_read_tokens: 500, output_tokens: 200 },
  ]);
  assert.equal(meta.model, "gemini-4-neon");
  assert.equal(meta.effort, "medium");
  assert.deepEqual(meta.usage, { used: 1700, max: 1_000_000 });
});

test("agyDefaultModels 는 agy 프로바이더용 모델·effort 목록을 만든다", () => {
  const models = agyDefaultModels();
  const neon = models.find((m) => m.id === "gemini-4-neon");
  assert.ok(neon);
  assert.equal(neon.provider, "agy");
  assert.equal(neon.isDefault, true);
  assert.equal(neon.contextWindowMaxTokens, 1_000_000);
  assert.deepEqual(neon.thinkingOptions.map((o) => o.id), ["low", "medium", "high", "xhigh"]);
  assert.equal(neon.defaultThinkingOptionId, "medium");
});

test("pendingAgyQuestion 과 openAgyAskAfter 는 미응답 ask_question 을 추출하고 응답 뒤 비운다", () => {
  const askRec = {
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [{
      name: "ask_question",
      args: {
        questions: JSON.stringify([{
          question: "어느 쪽으로 진행할까요?",
          is_multi_select: false,
          options: ["계속 진행", "중단"],
        }]),
      },
    }],
  };
  const askLine = JSON.stringify(askRec);
  const pending = pendingAgyQuestion([askLine]);
  assert.deepEqual(pending, {
    toolUseId: "s5:tc0",
    questions: [{
      question: "어느 쪽으로 진행할까요?",
      header: "어느 쪽으로 진행할까요?",
      multiSelect: false,
      options: [
        { label: "계속 진행", description: "" },
        { label: "중단", description: "" },
      ],
    }],
  });
  assert.equal(openAgyAskAfter(null, [askRec]), "s5:tc0");

  const answerRec = { step_index: 6, source: "MODEL", type: "GENERIC", content: "User selected: 계속 진행" };
  assert.equal(pendingAgyQuestion([askLine, JSON.stringify(answerRec)]), null);
  assert.equal(openAgyAskAfter("s5:tc0", [answerRec]), null);
});

test("agy 터미널 입력 칸과 하단 상태줄에서 초안·모드·effort 를 읽는다", () => {
  const screen = [
    "  이전 출력",
    "──────────────────────────────────────────────────",
    "> 안녕하세요",
    "──────────────────────────────────────────────────",
    "? for shortcuts   auto · Orchestrator · Gemini 4 Neon · medium",
  ].join("\n");
  assert.deepEqual(terminalDraft(screen, "agy"), { text: "안녕하세요", lines: 1, pasted: false, cut: false });
  assert.deepEqual(agyFooter(screen), { effort: "medium", mode: "auto" });
  assert.deepEqual(agyFooter("? for shortcuts   plan · Gemini 4 Neon · high"), { effort: "high", mode: "plan" });
});

test("agy 입력 칸 구분선 깨짐·placeholder 회색 글자는 터미널 출력으로 새지 않는다", () => {
  const withCorruptedRule = [
    "──────────────────────────────────────────────────",
    "> 이전 사용자 질문",
    "──────────────────────────────────────────────────",
    "● Running command...",
    "───────────────────\ufffd──────────────────────────────",
    "\x1b[0m\x1b[38;2;138;180;248m>\x1b[0m",
    "──────────────────────────────────────────────────",
    "esc to cancel   auto · Orchestrator · Gemini 4 Neon · medium",
  ].join("\n");
  assert.equal(terminalDraft(withCorruptedRule, "agy")?.text, "");

  const withPlaceholder = [
    "──────────────────────────────────────────────────",
    "\x1b[0m\x1b[38;2;138;180;248m>\x1b[0m \x1b[38;2;154;160;166mAsk anything...\x1b[0m",
    "──────────────────────────────────────────────────",
    "? for shortcuts   auto · Orchestrator · Gemini 4 Neon · medium",
  ].join("\n");
  assert.equal(terminalDraft(withPlaceholder, "agy")?.text, "");

  const withTypedInput = [
    "──────────────────────────────────────────────────",
    "\x1b[0m\x1b[38;2;138;180;248m>\x1b[0m \x1b[38;2;232;234;237m실제 입력\x1b[0m",
    "──────────────────────────────────────────────────",
    "? for shortcuts   auto · Orchestrator · Gemini 4 Neon · medium",
  ].join("\n");
  assert.equal(terminalDraft(withTypedInput, "agy")?.text, "실제 입력");
});

test("listCommands('agy') 는 프로젝트·글로벌 .agents/skills 와 agy 내장 명령을 반환한다", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cmd-"));
  try {
    const projSkill = path.join(tmp, "proj", ".agents", "skills", "local-skill");
    const globalSkill = path.join(tmp, "cfg", "skills", "global-skill");
    fs.mkdirSync(projSkill, { recursive: true });
    fs.mkdirSync(globalSkill, { recursive: true });
    fs.writeFileSync(path.join(projSkill, "SKILL.md"), "---\nname: local-skill\ndescription: 프로젝트 스킬\n---\n");
    fs.writeFileSync(path.join(globalSkill, "SKILL.md"), "---\nname: global-skill\ndescription: 글로벌 스킬\n---\n");

    const cmds = listCommands("agy", path.join(tmp, "proj"), { agyConfig: path.join(tmp, "cfg") });
    const names = cmds.map((c) => c.name);
    assert.ok(names.includes("local-skill"));
    assert.ok(names.includes("global-skill"));
    assert.ok(names.includes("mode"));
    assert.ok(names.includes("skills"));
    assert.ok(!names.includes("hooks"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agyTranscriptPath 와 agySessionFromPath 는 축약 transcript.jsonl 보다 원문 transcript_full.jsonl 을 우선한다", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-full-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-state-"));
  try {
    const brain = path.join(tmp, "brain");
    const uuid = "038e24dd-6576-47ca-b06b-cf33696c9627";
    const logs = path.join(brain, uuid, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const compact = path.join(logs, "transcript.jsonl");
    fs.writeFileSync(compact, "{}\n");

    const opts = { agyRoot: brain, stateDir };
    assert.equal(agyTranscriptPath(uuid, opts), fs.realpathSync(compact));
    assert.equal(agySessionFromPath(compact, uuid, opts).file, fs.realpathSync(compact));

    const full = path.join(logs, "transcript_full.jsonl");
    fs.writeFileSync(full, "{}\n");
    assert.equal(reportAgentSessionPath({ agent: "agy", paneId: "test-pane", sessionId: uuid, transcriptPath: full }, opts)?.file, fs.realpathSync(full));
    assert.equal(agyTranscriptPath(uuid, opts), fs.realpathSync(full));
    assert.equal(agySessionFromPath(compact, uuid, opts).file, fs.realpathSync(full));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
