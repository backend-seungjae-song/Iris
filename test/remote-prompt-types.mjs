import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPrompt, createPromptStore } from '../server/remote/features/prompts.js';

// 실제 Claude·Codex 화면(가짜 세션에서 캡처)을 유형별로 고정
const read = name => fs.readFileSync(new URL(`./fixtures/remote-prompts/${name}.txt`, import.meta.url), 'utf8');
const prompt = name => extractPrompt({ text: read(name), hash: 'a'.repeat(64), columns: 100, rows: 60 });
const labels = p => p.options.map(o => o.text.replace(/^[›❯]?\s*\d*\.?\s*/, ''));

test('Claude Bash 명령: 상자 장식 제거, 줄바꿈된 선택지 이음', () => {
  const p = prompt('01-bash');
  assert.equal(p.variant, 'command');
  assert.equal(p.title, 'Do you want to proceed?');
  assert.doesNotMatch(p.detail, /╌|Tip:/);
  assert.match(p.detail, /mkdir -p out && echo hi/);
  assert.match(labels(p)[1], /always allow access to \/Users\/you\/.*mobile-remote\/fake-sessions\/proj\/out from this project$/);
  assert.equal(p.options[1].description, '');
  assert.deepEqual(p.options.map(o => o.role), ['allow', 'allowAlways', 'allow', 'deny']);
});

test('Claude 파일 수정·생성', () => {
  const edit = prompt('02-edit');
  assert.equal(edit.variant, 'edit');
  assert.match(edit.detail, /-line one\n1 \+line 1/);
  assert.match(labels(edit)[1], /^Yes, and switch to accept edits .*\(shift\+tab\)$/);
  assert.equal(prompt('03-create').title, 'Do you want to create new.md?');
});

test('Claude WebFetch', () => {
  const p = prompt('04-fetch');
  assert.match(p.detail, /url: https:\/\/example\.com\//);
  assert.deepEqual(p.options.map(o => o.role), ['allow', 'allowAlways', 'deny']);
});

test('Claude 질문: 단일·다중(Submit 줄)·둘 이상·제출 확인', () => {
  const single = prompt('05-ask-single');
  assert.equal(single.variant, 'choice');
  assert.equal(single.options[0].description, '옵션 A를 선택합니다.');
  const multi = prompt('06-ask-multi');
  assert.equal(multi.multiSelect, true);
  assert.deepEqual(multi.options.map(o => o.text.replace(/^[›❯]?\s*\d*\.?\s*/, '')), ['항목 X', '항목 Y', '항목 Z', 'Type something', 'Submit', 'Chat about this']);
  assert.equal(multi.options[3].description, '');
  const q2 = prompt('09-two-q2');
  assert.deepEqual([q2.step, q2.steps], [2, 2]);
  const review = prompt('10-two-review');
  assert.equal(review.variant, 'review');
  assert.match(review.detail, /^1\. .*색을 고르세요\.\n {3}→ 빨강\n2\. .*\n {3}→ 고양이$/);
  const empty = prompt('07-review-unanswered');
  assert.equal(empty.title, 'Ready to submit your answers?');
  assert.equal(empty.detail, '⚠ You have not answered all questions');
});

test('Claude 계획 모드: 제목 이음, 본문, 키 안내 제외', () => {
  const p = prompt('11-plan');
  assert.equal(p.variant, 'plan');
  assert.equal(p.title, 'Claude has written up a plan and is ready to execute. Would you like to proceed?');
  assert.match(p.detail, /^도구 동작 테스트 세션 계획/);
  assert.doesNotMatch(p.detail, /Here is Claude|↓/);
  assert.equal(p.options[2].description, '');
});

test('Codex 명령·패치 승인: 기록 제외, 키 힌트 제외', () => {
  const exec = prompt('20-codex-exec');
  assert.equal(exec.title, 'Would you like to run the following command?');
  assert.doesNotMatch(exec.detail, /OpenAI Codex|테스트 세션입니다/);
  assert.match(exec.detail, /\$ mkdir -p out2 && echo x > out2\/b\.txt/);
  assert.equal(exec.options[2].description, '');
  assert.match(exec.options[1].text, /commands that start with `mkdir -p out2 && echo x > out2\/b\.txt` \(p\)$/);
  const patch = prompt('21-codex-patch');
  assert.match(patch.detail, /Destination:\n.*mobile-remote\/fake-sessions\/proj\/notes\.txt$/);
});

test('Codex 질문: 단계, 2열 선택지, 키 안내 제외', () => {
  const p = prompt('23-codex-ask2-q1');
  assert.equal(p.title, '메모를 어디에 저장하도록 계획할까요?');
  assert.deepEqual([p.step, p.steps], [1, 2]);
  assert.equal(p.options[0].text.replace(/^[›❯]?\s*\d*\.?\s*/, ''), '현재 브라우저 (Recommended)');
  assert.match(p.options[0].description, /^로그인 없이 같은 브라우저에서/);
  assert.equal(p.options[3].text.replace(/^\d+\.\s*/, ''), 'None of the above');
  assert.doesNotMatch(p.options[3].description, /enter to submit|esc to interrupt/i);
});

test('Codex 구현 확인: 계획 본문과 2열 선택지', () => {
  const p = prompt('24-codex-implement');
  assert.equal(p.variant, 'plan');
  assert.match(p.detail, /^## 구현/);
  assert.equal(p.options[0].text.replace(/^[›❯]?\s*\d*\.?\s*/, ''), 'Yes, implement this plan');
  assert.equal(p.options[0].description, 'Switch to Default and start coding');
  assert.deepEqual(p.options.map(o => o.role), ['allow', 'allow', 'deny']);
});

test('Claude 웹 검색·여러 줄 Bash', () => {
  const search = prompt('12-websearch');
  assert.match(search.detail, /search the web for: anthropic claude code/);
  assert.deepEqual(search.options.map(o => o.role), ['allow', 'deny']);
  const loop = prompt('13-bash-multiline');
  assert.equal(loop.variant, 'command');
  assert.match(loop.detail, /for i in 1 2 3; do\n\s*echo \$i\ndone/);
  assert.doesNotMatch(loop.detail, /Tip:|╌/);
});

test('승인 훅의 도구 이름·대상은 승인 화면에만 붙고 질문 화면에는 붙지 않는다', async () => {
  const run = async (fixture, hint) => {
    const state = [{ ref: 'r1', status: 'blocked', source: { paneId: 'p1' } }];
    const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
      requests: { list: () => [] }, terminalQuestions: { list: () => [], hint: () => hint },
      terminal: { readPrompt: async () => ({ text: read(fixture), hash: 'b'.repeat(64), columns: 100, rows: 60 }) },
      setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
    store.start('phone'); await new Promise(r => setImmediate(r));
    const screen = store.list()[0].body.screen; store.close(); return screen;
  };
  const hint = { tool: 'Bash', target: 'mkdir -p out && echo hi' };
  const bash = await run('01-bash', hint);
  assert.equal(bash.tool, 'Bash');
  assert.equal(bash.target, hint.target);
  assert.equal('tool' in await run('01-bash', null), false);
  assert.equal('tool' in await run('05-ask-single', hint), false);
  assert.equal('target' in await run('11-plan', { tool: 'ExitPlanMode', target: '' }), false);
});

test('긴 질문: 하단 키 안내가 둘째 줄로 접혀도 마지막 선택지 설명에 섞이지 않는다', () => {
  const p = prompt('30-long-ask');
  assert.equal(p.options.at(-1).text, '4. Chat about this');
  assert.equal(p.options.at(-1).description, '');
  assert.match(p.title, /^원인을 찾으려면 .* 진행할까요\?$/);
});

test('질문 본문이 화면 위로 밀려나면 훅이 받은 질문 원문으로 인식하고, 원문이 없으면 인식하지 않는다', () => {
  const lines = read('30-long-ask').split('\n');
  const text = lines.slice(lines.findIndex(l => /^❯ 1\./.test(l))).join('\n');
  const frame = { text, hash: 'a'.repeat(64), columns: 40, rows: 60 };
  assert.equal(extractPrompt(frame), null);
  const p = extractPrompt(frame, '지금 설치해도 될까요?');
  assert.equal(p.question, '지금 설치해도 될까요?');
  assert.equal(p.options.length, 4);
});

test('선택 목록이 없는 화면은 카드를 만들지 않고, 목록이 있으나 해석 못 하면 카드를 남긴다', async () => {
  const run = async text => {
    const state = [{ ref: 'r1', status: 'blocked', source: { paneId: 'p1' } }];
    const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
      requests: { list: () => [] }, terminalQuestions: { list: () => [], hint: () => null },
      terminal: { readPrompt: async () => ({ text, hash: 'c'.repeat(64), columns: 100, rows: 40 }) },
      setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
    store.start('phone'); await new Promise(r => setImmediate(r));
    const count = store.list().length; store.close(); return count;
  };
  assert.equal(await run('메모리 최적화 방향을 이렇게 잡았는데 지금 진행할까요?\n\n❯ \n'), 0);
  assert.equal(await run('무엇인가요?\n  1. 가\n  2. 나\n'), 1);
});
