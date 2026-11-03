import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { qaPendingReactions } from '../server/qa-reaction.js';
import { validateQaDeclaration } from '../server/qa-list-review.js';
import { calculateAffectedRows } from '../server/qa-fix.js';
import { qaRowContract } from './qa-fixtures.mjs';
import { fixture } from './qa-fix5.test.mjs';

test('9차 #5 결함에 연결된 reaction의 K1만 판단 대기에서 제외', () => {
  const events = [
    { seq: 10, event: { kind: 'reaction', detail: { candidates: [
      { id: 'missing', code: 'K1' }, { id: 'error', code: 'K2' },
    ] } } },
    { seq: 11, event: { kind: 'reaction', detail: { candidates: [{ id: 'other', code: 'K1' }] } } },
    { seq: 12, event: { kind: 'defect', detail: { failureSeq: 10 } } },
  ];
  assert.deepEqual(qaPendingReactions(events).map(item => item.id), ['error', 'other']);
});

test('9차 #5 defectSeq가 있는 미분류·문제 후보는 판단 대기가 아님', () => {
  const events = [
    { seq: 1, event: { kind: 'reaction', detail: { candidates: [
      { id: 'unclassified', code: 'K2', defectSeq: 8 },
      { id: 'classified', code: 'K2', class: '문제', defectSeq: 9 },
      { id: 'pending', code: 'K2', class: '문제' },
      { id: 'linked', code: 'K2' },
    ] } } },
    { seq: 2, event: { kind: 'unexpected_defect', detail: { id: 'linked', defectSeq: 10 } } },
  ];
  assert.deepEqual(qaPendingReactions(events).map(item => item.id), ['pending']);
});

test('9차 #8 qa-name8 제품 이름을 포함한 수정을 허용', async t => {
  const f = await fixture(t);
  execFileSync('git', ['-C', f.repo, 'checkout', '-b', 'fix/product-name'], { stdio: 'pipe' });
  const commit = f.commit("localStorage.setItem('qa-name8', 'saved');");
  const receipt = await f.fix({ commit });
  assert.equal(receipt.event.kind, 'fix');
  assert.equal(receipt.event.detail.commit, commit);
});

for (const marker of ["process.env.NODE_ENV==='test'", 'if (QA_MODE) {}', 'window.__QA__', 'isTest']) {
  test(`9차 #8 테스트 표식 거부: ${marker}`, async t => {
    const f = await fixture(t);
    execFileSync('git', ['-C', f.repo, 'checkout', '-b', 'fix/test-marker'], { stdio: 'pipe' });
    const commit = f.commit(marker);
    await assert.rejects(f.fix({ commit }), /제품 코드에 테스트 실행 여부 분기를 추가할 수 없습니다/);
  });
}

test('9차 #9 읽기 항목의 consumers 보존·경로 검사·영향 계산', () => {
  const consumers = ['server/qa-fix.js:1', { source: 'server/qa-reaction.js:1' }];
  const declared = validateQaDeclaration({ ...qaRowContract(), consumers }, { repo: process.cwd() });
  assert.equal(declared.dataChanging, false);
  assert.deepEqual(declared.consumers, consumers);
  const events = [{ seq: 1, event: { kind: 'row', rowId: 'read-only', rowData: declared } }];
  assert.deepEqual(calculateAffectedRows(events, ['server/qa-fix.js']), ['read-only']);
  assert.deepEqual(calculateAffectedRows(events, ['server/qa-reaction.js']), ['read-only']);
  assert.deepEqual(calculateAffectedRows(events, ['server/qa-report.js']), []);
  for (const invalid of ['missing-file.js:1', 'server/qa-fix.js:999999', { source: '미확인', attempts: [] }]) {
    assert.throws(() => validateQaDeclaration({ ...qaRowContract(), consumers: [invalid] }, { repo: process.cwd() }), /declare.consumers\[0\]/);
  }
});
