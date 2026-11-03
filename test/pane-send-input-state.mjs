// 보내기 전에 상대 입력창을 비었다고 볼지 판정한다. 화면은 herdr 0.9.3 의 `pane read --ansi`
// 결과를 그대로 옮겼다(Claude Code 2026-10, Codex 0.164.0).
import assert from "node:assert/strict";
import test from "node:test";
import { echoCount, inputState, plainText } from "../bin/iris-pane-send.mjs";

const GREY_RULE = "\x1b[0m\x1b[38;2;136;136;136m" + "─".repeat(78) + "\x1b[0m";
const FOOT = "  \x1b[0m\x1b[38;2;255;204;0m⏵⏵ auto mode on\x1b[0m\x1b[38;2;153;153;153m (shift+tab to cycle)\x1b[0m";
const OLD_PROMPT = "\x1b[0m\x1b[38;2;153;153;153m\x1b[48;2;55;55;55m❯\x1b[0m\x1b[48;2;55;55;55m \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;55;55;55m지난 질문\x1b[0m";
const claude = (...box) => [OLD_PROMPT, "⏺ 답", GREY_RULE, ...box, GREY_RULE, FOOT].join("\r\n");

const CODEX_FOOT = "  \x1b[0m\x1b[38;2;246;226;183mGPT-6-Astra medium\x1b[0m\x1b[38;2;123;139;150m · \x1b[0m";
const BG = "\x1b[48;2;37;46;53m";
const codex = (...box) => [
  "• 지난 답", `\x1b[0m${BG}${" ".repeat(80)}\x1b[0m`, ...box, `\x1b[0m${BG}${" ".repeat(80)}\x1b[0m`, CODEX_FOOT,
].join("\r\n");

test("Claude 빈 입력창", () => {
  assert.equal(inputState(claude("❯ "), "claude").state, "empty");
});

test("Claude 흐린 안내 문구는 빈 입력창이다", () => {
  const r = inputState(claude('❯ \x1b[0m\x1b[2mTry "fix typecheck errors"\x1b[0m'), "claude");
  assert.equal(r.state, "empty");
  assert.equal(r.hint, 'Try "fix typecheck errors"');
});

test("Claude 일반 글자는 사람이 쓴 글이다", () => {
  const r = inputState(claude("❯ 카톡 카드 잘 옴. 통과."), "claude");
  assert.deepEqual([r.state, r.draft], ["draft", "카톡 카드 잘 옴. 통과."]);
});

test("Claude 여러 줄 초안과 위쪽 가로줄 안의 글", () => {
  // 위쪽 가로줄에 링크가 들어가면 ─ 가 하나만 남는다(w3M:p43 화면).
  const top = "\x1b[0m\x1b[38;2;136;136;136m file:///Users/x/.working/example-task… ─\x1b[0m";
  const screen = [OLD_PROMPT, top, "❯ 첫 줄", "  둘째 줄", GREY_RULE, FOOT].join("\r\n");
  assert.deepEqual(inputState(screen, "claude"), { state: "draft", draft: "첫 줄 둘째 줄", hint: "" });
});

test("Codex 흐린 안내 문구는 빈 입력창이다", () => {
  const line = `\x1b[0m\x1b[1m${BG}›\x1b[0m${BG} \x1b[0m\x1b[2m${BG}Ask Codex to do anything\x1b[0m${BG}          \x1b[0m`;
  const r = inputState(codex(line), "codex");
  assert.equal(r.state, "empty");
  assert.equal(r.hint, "Ask Codex to do anything");
});

test("Codex 일반 글자는 사람이 쓴 글이다", () => {
  const line = `\x1b[0m\x1b[1m${BG}›\x1b[0m${BG} 이거 먼저 봐줘\x1b[0m`;
  assert.equal(inputState(codex(line), "codex").state, "draft");
});

test("입력창이 없으면 판정하지 않는다", () => {
  assert.equal(inputState("Compacting conversation…\r\n", "claude").state, "unknown");
  assert.equal(inputState(claude("❯ "), "gemini").state, "unknown");
});

test("흐림은 22 나 0 으로 꺼지고, 색 지정 숫자 안의 2 는 흐림이 아니다", () => {
  assert.equal(plainText("a\x1b[2mb\x1b[22mc"), "ac");
  assert.equal(plainText("\x1b[38;2;2;2;2m글"), "글");
  assert.equal(plainText("\x1b[2;3m흐림\x1b[0m보임"), "보임");
});

test("보낸 글의 첫 줄은 입력창 위에 보일 때만 센다", () => {
  const text = "총괄입니다. 설치 끝났습니다.\n둘째 줄";
  // 붙여넣기가 접힌 채 입력창에 남은 화면: 대화 기록에는 아직 없음
  assert.equal(echoCount(claude("❯ [Pasted text #17 +15 lines]"), "claude", text), 0);
  // 제출된 화면: 줄바꿈 위치가 달라도 셈
  const sent = [OLD_PROMPT, "⏺ 답", "❯ 총괄입니다. 설치", "  끝났습니다.", "  둘째 줄", GREY_RULE, "❯ ", GREY_RULE, FOOT].join("\r\n");
  assert.equal(echoCount(sent, "claude", text), 1);
  assert.equal(echoCount(sent, "claude", "\n\n"), 0);
});
