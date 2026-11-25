import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { codexQuestionKeys, openAskAfter, pendingCodexQuestion, pendingQuestion, pendingToolInput, questionAnswers, questionKeys, reviewKeys, showsQuestion, splitMultiSelectAnswer } from "../server/agent-chat-question.js";
import { extractPrompt } from "../server/remote/features/prompts.js";

// 시험 pane 에서 찍은 Claude Code AskUserQuestion 화면(폭 49칸)
const frame = (name) => {
  const text = fs.readFileSync(new URL(`./fixtures/ask-question/${name}.txt`, import.meta.url), "utf8");
  return extractPrompt({ text, columns: 49, rows: 40, hash: crypto.createHash("sha256").update(text).digest("hex") });
};
const COLOR = { question: "무슨 색?", header: "색", multiSelect: false, options: [{ label: "빨강", description: "붉은색" }, { label: "파랑", description: "푸른색" }] };
const FRUIT = { question: "무슨 과일?", header: "과일", multiSelect: true, options: [{ label: "사과", description: "" }, { label: "배", description: "" }, { label: "귤", description: "" }] };
const line = (o) => JSON.stringify(o);
const ask = (id, questions) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] } });

test("기록 끝의 답 없는 AskUserQuestion 을 찾고, 답이 오거나 사람 말이 나오면 없다", () => {
  const q = ask("toolu_1", [COLOR]);
  assert.deepEqual(pendingQuestion([q]), { toolUseId: "toolu_1", questions: [COLOR] });
  const result = line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "answered" }] } });
  assert.equal(pendingQuestion([q, result]), null);
  assert.equal(pendingQuestion([q, line({ type: "user", message: { content: "다음 말" } })]), null);
  // 모양이 틀린 입력은 질문 카드로 보이지 않음
  assert.equal(pendingQuestion([ask("toolu_2", [{ question: "x", options: [{}] }])]), null);
  assert.equal(pendingQuestion(["깨진 줄"]), null);
});

test("Paseo 카드 답을 질문마다 고른 선택지·직접 입력으로 바꾼다", () => {
  assert.deepEqual(questionAnswers([COLOR, FRUIT], { 색: "파랑", 과일: "사과, 귤, 수박" }).answers,
    [{ labels: ["파랑"], text: null }, { labels: ["사과", "귤"], text: "수박" }]);
  assert.deepEqual(questionAnswers([COLOR], { "무슨 색?": "보라" }).answers, [{ labels: [], text: "보라" }]);
  assert.equal(questionAnswers([COLOR, FRUIT], { 색: "파랑" }).error, "모든 질문에 답해 주세요");
  assert.deepEqual(splitMultiSelectAnswer("a, b, c", ["a", "a, b"]), { selected: ["a, b"], custom: "c" });
});

test("단일 선택: 줄을 옮겨 Enter, 직접 입력은 Type something 줄에서 글을 쓰고 Enter", () => {
  const p = frame("ask-q1");
  assert.equal(showsQuestion(p, COLOR), true);
  assert.equal(showsQuestion(p, FRUIT), false);
  assert.deepEqual(questionKeys(p, COLOR, { labels: ["빨강"], text: null }), { chunks: ["\r"] });
  assert.deepEqual(questionKeys(p, COLOR, { labels: ["파랑"], text: null }), { chunks: ["\x1b[B", "\r"] });
  assert.deepEqual(questionKeys(p, COLOR, { labels: [], text: "보라" }), { chunks: ["\x1b[B\x1b[B", "보라", "\r"] });
  assert.match(questionKeys(p, COLOR, { labels: ["초록"], text: null }).error, /초록/);
});

test("여러 개 고르기: 줄마다 Space, 직접 입력 글, Submit 줄에서 Enter", () => {
  const p = frame("ask-q2");
  assert.equal(showsQuestion(p, FRUIT), true);
  assert.deepEqual(questionKeys(p, FRUIT, { labels: ["사과", "귤"], text: null }), { chunks: [" ", "\x1b[B\x1b[B", " ", "\x1b[B\x1b[B", "\r"] });
  assert.deepEqual(questionKeys(p, FRUIT, { labels: ["배"], text: "수박" }), { chunks: ["\x1b[B", " ", "\x1b[B\x1b[B", "수박", "\x1b[B", "\r"] });
});

test("질문이 여럿인 카드의 여러 개 고르기: 끝 줄이 Next 여도 거기서 Enter", () => {
  const p = frame("ask-q2-next");
  assert.equal(showsQuestion(p, FRUIT), true);
  assert.equal(showsQuestion(p, COLOR), false, "앞 질문(색)은 이미 답해져 화면에 없음");
  assert.deepEqual(questionKeys(p, FRUIT, { labels: ["사과", "귤"], text: null }), { chunks: [" ", "\x1b[B\x1b[B", " ", "\x1b[B\x1b[B", "\r"] });
});

test("화면보다 긴 질문: 화면에 보이는 끝부분이 기록 질문의 끝이면 같은 질문", () => {
  // 40줄 질문. 터미널에는 14번 줄부터 보이고 화면 해석은 선택지 위 마지막 8줄만 읽음
  const long = ["긴질문시작", ...Array.from({ length: 40 }, (_, i) => `${i + 1}번 이것은 긴 질문의 ${i + 1}번째 줄입니다`), "긴질문끝"].join("\n");
  const LONG = { question: long, header: long, multiSelect: false, options: [1, 2, 3, 4].map((n) => ({ label: `선택지 ${n}`, description: "" })) };
  const p = extractPrompt({ ...(() => { const text = fs.readFileSync(new URL("./fixtures/ask-question/ask-long.txt", import.meta.url), "utf8"); return { text, hash: crypto.createHash("sha256").update(text).digest("hex") }; })(), columns: 54, rows: 44 });
  assert.equal(showsQuestion(p, LONG), true);
  assert.equal(showsQuestion(p, { ...LONG, question: long.replace("40번째", "마흔번째") }), false, "끝부분이 다르면 다른 질문");
  assert.equal(showsQuestion(p, COLOR), false);
  assert.deepEqual(questionKeys(p, LONG, { labels: ["선택지 2"], text: null }), { chunks: ["\x1b[B", "\r"] });
});

test("확인 화면은 Submit answers 에서 Enter, 다른 화면이면 null", () => {
  assert.deepEqual(reviewKeys(frame("ask-review")), ["\r"]);
  assert.equal(reviewKeys(frame("ask-q1")), null);
  assert.equal(showsQuestion(frame("ask-review"), COLOR), false);
});

// 2026-11-10 사용자: 미리보기(preview) 있는 질문에 대화 화면으로 답하면 오류
// - 미리보기 화면은 선택지가 왼쪽 좁은 칸이라 "설정 값 따라가기 (Recommended)" 가 두 줄로 접혀 첫 줄만 선택지 글로 읽힘
test("미리보기 질문: 접혀 첫 줄만 보이는 선택지도 번호와 글 앞부분으로 찾는다", () => {
  const input = JSON.parse(fs.readFileSync(new URL("./fixtures/ask-question/ask-preview.json", import.meta.url), "utf8")).questions[0];
  const text = fs.readFileSync(new URL("./fixtures/ask-question/ask-preview.txt", import.meta.url), "utf8");
  const p = extractPrompt({ text, columns: 106, rows: 44, hash: crypto.createHash("sha256").update(text).digest("hex") });
  const q = { ...input, options: input.options.map((o) => ({ label: o.label, description: o.description })) };
  assert.equal(showsQuestion(p, q), true);
  assert.deepEqual(questionKeys(p, q, { labels: ["설정 값 따라가기 (Recommended)"], text: null }), { chunks: ["\r"] });
  assert.deepEqual(questionKeys(p, q, { labels: ["이번 범위 밖"], text: null }), { chunks: ["\x1b[B\x1b[B", "\r"] });
  // 번호가 같아도 글 앞부분이 다르면 다른 선택지
  const other = { ...q, options: [{ label: "다른 선택지 (Recommended)", description: "" }, ...q.options.slice(1)] };
  assert.equal(questionKeys(p, other, { labels: ["다른 선택지 (Recommended)"], text: null }).error, '선택지 "다른 선택지 (Recommended)" 를 찾지 못했습니다');
});

// Codex request_user_input: 시험 pane 에서 찍은 화면(폭 140칸)과 같은 모양의 rollout 기록
const SEASON = { id: "favorite_season", header: "좋아하는 계절", question: "좋아하는 계절은 무엇인가요?", options: [{ label: "봄", description: "봄을 선택합니다." }, { label: "여름", description: "여름을 선택합니다." }] };
const HUE = { id: "favorite_color", header: "좋아하는 색", question: "좋아하는 색은 무엇인가요?", options: ["빨강", "파랑", "초록"].map((l) => ({ label: l, description: `${l}을 선택합니다.` })) };
const codexCall = (callId, questions) => line({ type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: callId, arguments: JSON.stringify({ questions }) } });
const asCard = (q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options });
const codexFrame = (name) => {
  const text = fs.readFileSync(new URL(`./fixtures/ask-question/${name}.txt`, import.meta.url), "utf8");
  return extractPrompt({ text, columns: 140, rows: 40, hash: crypto.createHash("sha256").update(text).digest("hex") });
};

test("Codex 기록 끝의 답 없는 request_user_input 을 찾고, 답이 오거나 사람 말이 나오면 없다", () => {
  const call = codexCall("call_1", [HUE, SEASON]);
  assert.deepEqual(pendingCodexQuestion([call]), { toolUseId: "call_1", questions: [asCard(HUE), asCard(SEASON)] });
  const output = line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "{}" } });
  assert.equal(pendingCodexQuestion([call, output]), null);
  assert.equal(pendingCodexQuestion([call, line({ type: "response_item", payload: { type: "message", role: "user", content: [] } })]), null);
  // 재지 않은 모양(여러 개 고르기·선택지 없음)은 질문 카드로 보이지 않음
  assert.equal(pendingCodexQuestion([codexCall("call_2", [{ ...HUE, multiSelect: true }])]), null);
  assert.equal(pendingCodexQuestion([codexCall("call_3", [{ ...HUE, options: [] }])]), null);
  assert.equal(pendingCodexQuestion([line({ type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: "c", arguments: "{깨짐" } })]), null);
});

test("Codex 질문 화면: Question n/m 줄을 빼고 같은 질문으로 본다", () => {
  assert.equal(showsQuestion(codexFrame("codex-q1"), HUE), true);
  assert.equal(showsQuestion(codexFrame("codex-q1"), SEASON), false);
  assert.equal(showsQuestion(codexFrame("codex-q2"), SEASON), true);
});

test("Codex 키: 선택지는 줄 이동 + Enter, 직접 입력은 None of the above 에서 Tab + 글 + Enter", () => {
  assert.deepEqual(codexQuestionKeys(codexFrame("codex-q1"), HUE, { labels: ["초록"], text: null }), { chunks: ["\x1b[B\x1b[B", "\r"] });
  assert.deepEqual(codexQuestionKeys(codexFrame("codex-q1"), HUE, { labels: [], text: "보라색" }), { chunks: ["\x1b[B\x1b[B\x1b[B", "\t", "보라색", "\r"] });
  assert.deepEqual(codexQuestionKeys(codexFrame("codex-q2"), SEASON, { labels: ["봄"], text: null }), { chunks: ["\r"] });
  assert.equal(codexQuestionKeys(codexFrame("codex-q2"), SEASON, { labels: ["가을"], text: null }).error, '선택지 "가을" 를 찾지 못했습니다');
});

test("AskUserQuestion 선택지의 미리보기(preview)를 질문 카드에 넘긴다", () => {
  const input = JSON.parse(fs.readFileSync(new URL("./fixtures/ask-question/ask-preview.json", import.meta.url), "utf8"));
  const got = pendingQuestion([ask("toolu_p", input.questions)]);
  assert.deepEqual(got.questions[0].options.map((o) => o.preview), input.questions[0].options.map((o) => o.preview || undefined));
});

const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const turn = (...content) => line({ type: "assistant", message: { content } });
const done = (id) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

test("승인 화면 위가 잘렸을 때 쓸, 기록 끝의 결과 없는 도구 호출 하나의 입력을 글로 만든다", () => {
  const jql = "project = TEST\nAND labels = theta\nORDER BY created DESC";
  assert.equal(pendingToolInput([turn(use("t1", "mcp__jira__jira_search", { jql, limit: 1 }))]),
    "mcp__jira__jira_search\njql:\n  project = TEST\n  AND labels = theta\n  ORDER BY created DESC\nlimit: 1");
  // 결과가 온 호출은 끝난 것, 사람 말이 나오면 그 앞은 끝난 것
  assert.equal(pendingToolInput([turn(use("t1", "Bash", { command: "ls" })), done("t1")]), null);
  assert.equal(pendingToolInput([turn(use("t1", "Bash", { command: "ls" })), line({ type: "user", message: { content: "다음 말" } })]), null);
  // 결과 없는 호출이 둘 이상이면 어느 것을 묻는지 알 수 없어 쓰지 않음
  assert.equal(pendingToolInput([turn(use("t1", "Bash", { command: "a" }), use("t2", "Bash", { command: "b" }))]), null);
  // 앞의 것이 끝났으면 남은 하나
  assert.equal(pendingToolInput([turn(use("t1", "Bash", { command: "a" }), use("t2", "Write", { file_path: "/x", content: "y" })), done("t1")]),
    "Write\nfile_path: /x\ncontent: y");
  // 객체 값은 JSON 한 줄
  assert.equal(pendingToolInput([turn(use("t1", "X", { opts: { a: 1 } }))]), 'X\nopts: {"a":1}');
  assert.equal(pendingToolInput(["깨진 줄"]), null);
});

test("새 기록 묶음을 이어 받으며 답 없는 AskUserQuestion 을 추적한다(herdr 가 blocked 를 놓쳐도 카드를 띄우는 근거)", () => {
  const rec = (s) => JSON.parse(s);
  let open = openAskAfter(null, [rec(ask("toolu_1", [COLOR]))]);
  assert.equal(open, "toolu_1");
  // 다른 기록이 와도 답이 오기 전까지 유지
  open = openAskAfter(open, [rec(turn(use("t2", "Bash", { command: "ls" })))]);
  assert.equal(open, "toolu_1");
  // 그 질문의 답(tool_result)이 오면 없음
  open = openAskAfter(open, [rec(done("toolu_1"))]);
  assert.equal(open, null);
  // 사람 말이 나오면 앞 질문은 끝난 것
  open = openAskAfter(openAskAfter(null, [rec(ask("toolu_3", [COLOR]))]), [{ type: "user", message: { content: "다음 말" } }]);
  assert.equal(open, null);
  // 다른 도구의 결과는 질문을 끝내지 않음
  assert.equal(openAskAfter("toolu_4", [rec(done("t9"))]), "toolu_4");
});
