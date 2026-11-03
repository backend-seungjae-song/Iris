import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractPrompt, createPromptStore } from '../server/remote/features/prompts.js';
import { projectTerminalQuestions } from '../server/remote/projection.js';
const ref = 'a'.repeat(32);
const frame = text => ({ text, hash: createHash('sha256').update(text).digest('hex'), columns: 100, rows: 30 });
// L3 사용자 기억 기반 승인 모양, 실제 화면 기록 없음
const approvals = {
  claude: "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for this command\n  3. No, and tell Claude what to do differently (esc)",
  codex: "Would you like to run the following command?\n\n$ touch example.txt\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with touch (p)\n  3. No, and tell Codex what to do differently (esc)",
};
test('69 Claude·Codex 시스템 승인 모양 추출', () => {
  for (const text of Object.values(approvals)) {
    const p = extractPrompt(frame(text));
    assert.equal(p.options.length, 3);
    assert.ok(p.options.every(o => o.selectable));
    assert.match(p.options[0].text, /Yes/);
    assert.match(p.options[2].text, /No/);
  }
});
function setup({ saved = [], text = 'Unknown permission layout', error = false } = {}) {
  let state = [{ ref, status: 'blocked', source: { paneId: 'p' } }];
  const logs = [], dismissed = [], marks = [];
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => saved,
      dismiss(r, reason) { dismissed.push([r, reason]); saved = saved.filter(q => q.ref !== r); } },
    terminal: { readPrompt: async () => error ? { error: 'unavailable' } : frame(text), markPrompt: (...args) => marks.push(args) },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log: code => logs.push(code) });
  return { store, logs, dismissed, marks, state: value => state = value, text: value => text = value };
}
test('69 해석 실패·읽기 실패에도 행동 가능한 무내용 카드와 상태 해제 삭제', async () => {
  for (const error of [false, true]) {
    const built = setup({ error, text: approvals.claude.replace('❯ ', '') }); built.store.start('phone');
    await new Promise(r => setImmediate(r));
    const cards = built.store.list();
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].body, { questions: [], screen: null });
    projectTerminalQuestions(cards);
    assert.equal(built.marks.length, 0);
    built.state([]); await built.store.poll();
    assert.equal(built.store.list().length, 0); built.store.close();
  }
});
const question = multi => ({ ref: 'b'.repeat(32), agent: ref, body: { questions: [{ question: '색?', header: '색',
  multiSelect: multi, options: [{ label: '파랑', description: '설명' }, { label: '빨강', description: '' }] }] } });
test('69 구조화 질문·설명 유지, 단일 선택 연결·컴퓨터 화면 답 뒤 삭제', async () => {
  const saved = question(false);
  const built = setup({ saved: [saved], text: '색?\n❯ 1. 파랑\n  2. 빨강\n  3. Other' });
  built.store.start('phone'); await new Promise(r => setImmediate(r));
  const card = built.store.list()[0];
  assert.deepEqual(card.body.questions, saved.body.questions);
  assert.deepEqual(card.body.screen.options.map(o => o.selectable), [true, true, false]);
  projectTerminalQuestions([card]);
  built.text('Answered, working'); await built.store.poll();
  // 화면을 다시 그리는 중간 프레임일 수 있어 3번 연속 선택지가 안 보일 때만 닫음
  assert.deepEqual(built.dismissed, []); assert.equal(built.store.list().length, 1);
  await built.store.poll(); await built.store.poll();
  assert.deepEqual(built.dismissed, [[saved.ref, 'computer-answered']]);
  assert.equal(built.store.list().length, 0);
  built.state([]); await built.store.poll(); assert.equal(built.store.list().length, 0);
  built.store.close();
});
test('69 폰 연결 전에 컴퓨터에서 답한 보관 질문은 재연결 뒤 카드로 나오지 않음', async () => {
  const saved = question(false);
  const built = setup({ saved: [saved], text: 'Answered, working on it' });
  built.store.start('phone'); await new Promise(r => setImmediate(r));
  assert.deepEqual(built.dismissed, [[saved.ref, 'computer-answered']]);
  assert.equal(built.store.list().length, 0);
  built.store.close();
});
test('69 선택 가능 여부는 저장 질문과 무관하게 화면 기준', async () => {
  for (const saved of [question(true), { ...question(false), body: { questions: [question(false).body.questions[0],
    { ...question(false).body.questions[0], question: '다음?' }] } }, question(false)]) {
    const built = setup({ saved: [saved], text: saved.body.questions.length === 1 && !saved.body.questions[0].multiSelect
      ? approvals.claude : '색?\n❯ 1. 파랑\n  2. 빨강' });
    built.store.start('phone'); await new Promise(r => setImmediate(r));
    assert.ok(built.store.list()[0].body.screen.options.every(o => o.selectable)); built.store.close();
  }
});
test('69 체크 상자 화면은 다중 선택으로 읽고 체크 상태를 전달', () => {
  const p = extractPrompt(frame('색을 고르세요\n❯ 1. [x] 파랑\n  2. [ ] 빨강\n  3. [ ] 노랑'));
  assert.equal(p.multiSelect, true);
  assert.deepEqual(p.options.map(o => o.checked), [true, false, false]);
  assert.ok(p.options.every(o => o.selectable));
  assert.doesNotMatch(p.options[0].text, /\[x\]/);
});

import { createWatchOperation } from '../server/remote/ops/watch.js';
import { isRemoteRequest } from '../server/remote/contract/requests.js';
test('69 이전 앱은 screen:null 제외, 새 앱만 명시 구독', () => {
  const item = { ref, agent: ref, kind: 'terminal-prompt', createdAt: 1, expiresAt: 2,
    body: { questions: [], screen: null } };
  const empty = { list: () => [], subscribe: () => () => {} };
  const watch = createWatchOperation({ agents: empty, requests: empty,
    terminalQuestions: { ...empty, list: () => [item] }, send() {} });
  const base = { type: 'session.watch', rid: 'x', prompts: true };
  assert.equal(isRemoteRequest({ ...base, promptFallback: true }), true);
  assert.equal(isRemoteRequest({ ...base, promptFallback: 'true' }), false);
  assert.deepEqual(watch.handle({ connId: 'old' }, base).at(-1).questions, []);
  assert.equal(watch.handle({ connId: 'new' }, { ...base, promptFallback: true }).at(-1).questions.length, 1);
  watch.close();
});

test('herdr 가 대기로 보고하지 않아도 훅이 받은 질문은 화면을 읽어 선택지를 붙이고 확인 표시를 남긴다', async () => {
  const saved = question(false);
  const touched = [];
  let state = [{ ref, status: 'idle', source: { paneId: 'p' } }];
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [saved], touch: r => touched.push(r), dismiss() {} },
    terminal: { readPrompt: async () => frame('색?\n\n❯ 1. 파랑\n     설명\n  2. 빨강\n  3. Chat about this'), markPrompt() {} },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  const cards = store.list();
  assert.equal(cards.length, 1);
  assert.ok(cards[0].body.screen, '선택지 화면이 붙음');
  assert.deepEqual(touched, [ref]);
  // 질문 기록이 사라지면(답함) 대기 상태가 아니므로 카드도 사라짐
  saved.agent = 'none'; await store.poll();
  assert.equal(store.list().length, 0);
  store.close();
});
