import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareQaEntryNavigation } from '../server/browser-commands.js';

// 크기 확인 테스트가 아니면 페이지 크기를 바꾸지 않음(사용자 2026-10-29). 크기는 qa_viewport 로만
test('QA entry opens the destination without changing the viewport', async () => {
  const calls = [];
  const result = await prepareQaEntryNavigation({
    createBlank: async () => ({ ok: true, data: { tabId: 'qa-1', url: 'about:blank' } }),
    getWc: (id) => ({ id }),
    cdp: async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, data: {} }; },
    url: 'http://127.0.0.1:4397/round8/',
  });
  assert.equal(result.data.url, 'http://127.0.0.1:4397/round8/');
  assert.deepEqual(calls.map(({ cmd }) => cmd), ['qa-mode', 'goto']);
});

test('qa-mode failure prevents destination navigation', async () => {
  const calls = [];
  const result = await prepareQaEntryNavigation({
    createBlank: async () => ({ ok: true, data: { tabId: 'qa-1' } }),
    getWc: () => ({ id: 1 }),
    cdp: async (cmd) => { calls.push(cmd); return cmd === 'qa-mode' ? { ok: false, error: 'mode failed' } : { ok: true }; },
    url: 'http://127.0.0.1:4397/round8/',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['qa-mode']);
});

test('QA entry keeps the blank tab where the session opened it', async () => {
  const calls = [];
  const result = await prepareQaEntryNavigation({
    createBlank: async () => ({ ok: true, data: { tabId: 'qa-1', space: 'sp' } }),
    getWc: () => 11,
    isolate: async () => { throw new Error('별도 창으로 옮기면 안 됨'); },
    cdp: async (cmd, _args, wc) => { calls.push([cmd, wc]); return { ok: true, data: {} }; },
    url: 'http://127.0.0.1:4397/round8/',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.qaWindow, undefined);
  assert.equal(result.data.qaWindowNote, undefined);
  assert.deepEqual(calls, [['qa-mode', 11], ['goto', 11]]);
});
