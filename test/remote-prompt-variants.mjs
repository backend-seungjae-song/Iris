import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractPrompt, optionRole } from '../server/remote/features/prompts.js';
import { projectTerminalQuestions } from '../server/remote/projection.js';

const frame = text => ({ text, hash: createHash('sha256').update(text).digest('hex'), columns: 100, rows: 40 });
// 사용자 기억과 Codex 실행 파일 문자열 기반 모양, 실제 화면 기록은 아님
const screens = {
  codexCommand: ["Would you like to run the following command?\n\n  $ touch example.txt\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with touch (p)\n  3. No, and tell Codex what to do differently (esc)",
    'command', ['allow', 'allowAlways', 'deny']],
  claudeBash: ["╭──────────────╮\n│ Bash command │\n│   pnpm install:app │\n╰──────────────╯\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for pnpm install:app commands in /x\n   3. No, and tell Claude what to do differently (esc)",
    'command', ['allow', 'allowAlways', 'deny']],
  codexEdit: ["Would you like to make the following edits?\n\n  src/a.js (+2 -1)\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for these files (a)\n  3. No, and tell Codex what to do differently (esc)",
    'edit', ['allow', 'allowAlways', 'deny']],
  mcpTool: ['Allow the iris-mcp MCP server to run tool "browser_goto"?\n\n› 1. Allow this request and continue\n  2. Allow for this session\n  3. Always allow\n  4. Decline this request and continue\n  5. Cancel this tool call',
    'tool', ['allow', 'allowAlways', 'allowAlways', 'deny', 'deny']],
  plan: ["Ready to code?\n\n Here is Claude's plan:\n  step one\n\n ❯ 1. Yes, and bypass permissions\n   2. Yes, manually approve edits\n   3. No, keep planning",
    'plan', ['allow', 'allow', 'deny']],
  choice: ['어떤 색?\n ❯ 1. 파랑\n   2. 빨강\n   3. Other (write an answer)', 'choice', ['choice', 'choice', 'text']],
};
for (const [name, [text, variant, roles]] of Object.entries(screens)) {
  test(`프롬프트 종류·선택지 역할: ${name}`, () => {
    const prompt = extractPrompt(frame(text));
    assert.equal(prompt.variant, variant);
    assert.deepEqual(prompt.options.map(o => o.role), roles);
    assert.ok(prompt.title.length > 0);
  });
}
test('명령 승인은 제목과 상세 명령을 나눔', () => {
  const prompt = extractPrompt(frame(screens.claudeBash[0]));
  assert.equal(prompt.title, 'Do you want to proceed?');
  assert.match(prompt.detail, /pnpm install:app/);
  assert.doesNotMatch(prompt.detail, /[╭╰]/);
});
test('거절이 항상 허용보다 먼저 판정됨', () => {
  assert.equal(optionRole("No, and don't ask again"), 'deny');
  assert.equal(optionRole('Always allow'), 'allowAlways');
  assert.equal(optionRole('Yes'), 'allow');
});
test('새 필드를 포함한 화면 본문이 투영 검사를 통과함', () => {
  const prompt = extractPrompt(frame(screens.codexCommand[0]));
  const request = { ref: 'b'.repeat(32), agent: 'a'.repeat(32), kind: 'terminal-prompt', createdAt: 1, expiresAt: 2,
    body: { questions: [{ question: prompt.question, header: '터미널 질문', multiSelect: false,
      options: prompt.options.map(o => ({ label: o.text, description: '' })) }], screen: prompt } };
  assert.equal(projectTerminalQuestions([request]).questions.length, 1);
});

// 실제 Claude AskUserQuestion 화면(2026-10-09 herdr 읽기): 탭 줄, 옵션 사이 설명, 구분선 뒤 마지막 옵션
const realClaude = [
  "───────────────────────────────────────────────────────────────────",
  "←  ☐ 분할 동작  ☐ 새 탭 위…  ✔ Submit  →",
  "",
  "│ 브라우저 탭에서 '오른쪽으로 분할'을 누르면 탭을 옮길까요,",
  "│ 복제할까요? (텍스트 파일은 VS Code 처럼 같은 파일을 양쪽에",
  "│ 엽니다)",
  "",
  "❯ 1. 이동 (Recommended)",
  "     그 탭이 오른쪽 칸으로 옮겨집니다. 페이지는 다시 읽지 않고",
  "  2. 복제",
  "     같은 주소의 새 탭이 오른쪽에 생깁니다.",
  "  3. Type something.",
  "───────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");
test('실제 Claude 질문 화면: 설명 줄·구분선 뒤 항목·탭 줄 처리', () => {
  const prompt = extractPrompt(frame(realClaude));
  assert.equal(prompt.options.length, 4);
  assert.match(prompt.title, /^브라우저 탭에서 .*엽니다\)$/);
  assert.match(prompt.options[0].description, /오른쪽 칸/);
  assert.equal(prompt.steps, 2);
  assert.equal(prompt.step, 1);
  const answered = extractPrompt(frame(realClaude.replace('☐ 분할 동작', '☒ 분할 동작')));
  assert.equal(answered.step, 2);
  assert.deepEqual(prompt.options.map(o => o.role), ['choice', 'choice', 'text', 'chat']);
  assert.deepEqual(prompt.options.map(o => o.selectable), [true, true, false, true]);
});
test('앞선 메시지의 번호 목록은 질문 목록에 섞이지 않음', () => {
  const text = "  1. 이전 항목\n  2. 이전 항목 둘\n\n  아래 질문입니다\n" + realClaude;
  const prompt = extractPrompt(frame(text));
  assert.equal(prompt.options.length, 4);
});

// Claude 다중 질문 마지막 확인 화면, 문구는 Claude Code 동작 기억 기반(L3)이며 실제 화면 기록은 아님
test('다중 질문 마지막 제출 확인 화면은 review 종류와 제출·취소 역할', () => {
  const text = "←  ☒ 분할 동작  ☒ 새 탭 위…  ✔ Submit  →\n\nReview your answers\n\n ● 어떻게 분할?\n   → 이동\n ● 새 탭 위치?\n   → 오른쪽\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel";
  const prompt = extractPrompt(frame(text));
  assert.equal(prompt.variant, 'review');
  assert.deepEqual(prompt.options.map(o => o.role), ['allow', 'deny']);
  assert.equal(prompt.steps, 2);
});
