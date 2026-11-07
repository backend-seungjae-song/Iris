import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { clearKeys, joinRows, terminalDraft, undimmed } from "../server/agent-chat-draft.js";

// state-ui 시험 pane 에서 찍은 화면(ANSI 원문). 폭 49칸
const screen = (name) => fs.readFileSync(new URL(`./fixtures/terminal-draft/${name}.ansi`, import.meta.url), "utf8");
const MULTI = "짧은 첫 줄\n이 줄은 아주 길게 써서 화면 폭을 넘기면 어떻게 접혀 보이는지 확인하려고 계속 이어 쓰는 시험용 둘째 줄입니다 끝\nabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij 끝";

test("Claude Code·Codex 입력 칸의 글을 접힘과 줄바꿈을 가려 원문대로 읽는다", () => {
  for (const kind of ["claude", "codex"]) {
    assert.deepEqual(terminalDraft(screen(`${kind}-multi`), kind), { text: MULTI, lines: 6, pasted: false, cut: false }, kind);
  }
});

test("빈 입력 칸의 흐린 안내 글은 글로 보지 않는다", () => {
  assert.equal(terminalDraft(screen("codex-empty"), "codex").text, "");
  assert.equal(terminalDraft(screen("claude-empty"), "claude").text, "");
  assert.equal(undimmed("\x1b[0m›\x1b[0m \x1b[2mAsk Codex\x1b[0m글"), "› 글");
  // 색 코드 안의 2 는 흐림이 아님
  assert.equal(undimmed("\x1b[38;2;2;2;2m글\x1b[0m"), "글");
});

test("내용을 다 못 읽는 입력 칸은 표시한다: 붙여 넣은 덩어리, 위가 가려진 긴 글", () => {
  assert.deepEqual(terminalDraft(screen("claude-pasted"), "claude"), { text: "[Pasted text #6 +29 lines]", lines: 1, pasted: true, cut: false });
  const codex = terminalDraft(screen("codex-pasted"), "codex");
  assert.equal(codex.cut, true);
  assert.equal(codex.text.startsWith("L11"), true);
});

test("입력 칸이 안 보이면 null", () => {
  assert.equal(terminalDraft("그냥 출력\n$ ", "claude"), null);
  assert.equal(terminalDraft("", "codex"), null);
});

test("줄 잇기: 꽉 찬 공백 없는 줄은 붙이고, 다음 낱말이 안 들어간 줄은 공백, 아니면 줄바꿈", () => {
  assert.equal(joinRows(["abcdefgh", "ij"], 10), "abcdefghij");
  assert.equal(joinRows(["aa bb", "cccc"], 10), "aa bb cccc");
  assert.equal(joinRows(["aa", "bb"], 10), "aa\nbb");
});

test("지우는 키는 줄 수에 맞춰 Ctrl+K 뒤 Ctrl+U", () => {
  assert.equal(clearKeys(3), "\x0b".repeat(8) + "\x15".repeat(8));
  assert.equal(clearKeys(null), "\x0b".repeat(16) + "\x15".repeat(16));
});
