import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentStore } from '../server/remote/agents.js';
import { createWatchOperation } from '../server/remote/ops/watch.js';
import { isRemoteRequest } from '../server/remote/contract/requests.js';
import { isOperationProjection } from '../server/remote/contract/projection.js';

const ref = 'a'.repeat(32);
const question = { ref, agent: ref, kind: 'claude-question', createdAt: 1, expiresAt: 86400001,
  body: { questions: [{ question: '계속?', header: '확인', multiSelect: false, options: [{ label: '예', description: '' }] }] } };

test('packet63 session.watch 재연결·재호출은 터미널 질문 재전송, 기존 watch는 기존 응답만', () => {
  let notify;
  let questions = [question];
  const agents = createAgentStore();
  const timers = [];
  const sent = [];
  const watch = createWatchOperation({ agents, requests: { list: () => [], subscribe: () => () => {} },
    terminalQuestions: { list: () => questions, subscribe(fn) { notify = fn; return () => {}; } },
    send: (conn, value) => sent.push({ conn, value }), now: () => 1000,
    setTimer(fn) { timers.push(fn); return { unref() {} }; }, clearTimer() {} });
  assert.equal(isRemoteRequest({ type: 'session.watch', rid: 'one' }), true);
  assert.equal(isRemoteRequest({ type: 'session.watch', rid: 'one', extra: true }), false);
  assert.deepEqual(watch.handle({ connId: 'old' }, { type: 'watch', rid: 'old' }).map((v) => v.type), ['agents', 'requests']);
  for (const connId of ['phone', 'phone', 'reconnected']) {
    const values = watch.handle({ connId }, { type: 'session.watch', rid: 'new' });
    assert.deepEqual(values[2], { type: 'terminal.questions', questions: [question] });
    assert.equal(isOperationProjection(values[2]), true);
  }
  questions = []; notify();
  for (const fire of timers) fire();
  assert.deepEqual(sent.filter((s) => s.value.type === 'terminal.questions').map((s) => s.conn), ['phone', 'reconnected']);
  assert.deepEqual(sent.find((s) => s.conn === 'phone').value.questions, []);
  assert.equal(isOperationProjection({ type: 'terminal.questions', questions: [{ ...question, paneId: 'private' }] }), false);
  watch.close(); agents.close();
});
