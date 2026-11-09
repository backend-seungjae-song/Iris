import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { pendingQuestion, questionAnswers, questionKeys, reviewKeys, showsQuestion, splitMultiSelectAnswer } from "../server/agent-chat-question.js";
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
