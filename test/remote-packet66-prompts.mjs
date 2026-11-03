import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompt, createPromptStore } from '../server/remote/features/prompts.js';
import { projectTerminalQuestions } from '../server/remote/projection.js';
const ref = 'a'.repeat(32), other = 'b'.repeat(32);
const frame = text => ({ text, hash: 'c'.repeat(64), columns: 80, rows: 24 });
const fixtures = {
  codex: 'Choose a direction\n\n› 1. Continue\n  2. Cancel',
  claude: 'Allow this action?\n❯ 1. Yes\n  2. No',
  symbols: 'Trust this folder?\n❯ Trust\n○ Cancel',
};
test('66 화면 모양별 선택 추출과 추측 거절', () => {
  for (const text of Object.values(fixtures)) {
    const p = extractPrompt(frame(text));
    assert.equal(p.options.length, 2); assert.equal(p.selectedRow, p.options[0].row);
  }
  for (const text of ['No choices', 'Question\n1. Yes\n2. No', 'Question\n❯ Yes\n❯ No', 'Question\n❯ Yes\ntext\n○ No', '\x1b[2H'+fixtures.codex]) assert.equal(extractPrompt(frame(text)), null);
  assert.equal(extractPrompt(frame('Question\n› 1. Continue\n  2. Other')).options[1].selectable, false);
  const multi = extractPrompt(frame('Select multiple, space to toggle\n❯ Yes\n○ No'));
  assert.equal(multi.multiSelect, true);
  assert.equal(multi.options.every(o => o.selectable), true);
});
test('66 감지 중복·pane 분리·해결·재등장 금지·기존 요청 제외', async () => {
  let state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }, { ref: other, question: true, source: { paneId: 'p2' } }];
  let requests = [], saved = [], reads = 0;
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => requests }, terminalQuestions: { list: () => saved },
    terminal: { readPrompt: async a => { reads++; return frame(a.ref === ref ? fixtures.codex : fixtures.claude); } },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  assert.deepEqual(store.list(), []); await store.poll(); assert.equal(reads, 0);
  store.start('phone'); await new Promise(r => setImmediate(r));
  assert.equal(store.list().length, 2); const original = store.list()[0].ref;
  projectTerminalQuestions(store.list()); await store.poll(); assert.equal(store.list()[0].ref, original);
  requests = [{ agent: ref }]; await store.poll(); assert.equal(store.list().length, 1);
  saved = [{ agent: other }]; await store.poll(); assert.equal(store.list().length, 1);
  requests = []; saved = []; await store.poll(); assert.equal(store.list().length, 1);
  state = []; await store.poll(); assert.equal(store.list().length, 0); store.close();
});

test('66 CRLF·SGR·긴 본문·실제 일반 입력 화면은 질문 제외', () => {
  assert.ok(extractPrompt(frame('\x1b[1m' + fixtures.codex.replaceAll('\n','\r\n') + '\x1b[0m')));
  assert.equal(extractPrompt(frame('› Ask Codex to do anything\n? for shortcuts')), null);
  assert.equal(extractPrompt(frame('x'.repeat(3000)+'\n❯ 1. Yes\n  2. No')).question.length, 1000);
});

import { createTerminalFeature } from '../server/remote/features/terminal.js';
test('66 선택은 pane·해시·치수 검증 후 한 번만 전송', async () => {
  let text = fixtures.codex, width = 80, valid = true;
  const sent = [], logs = [];
  const terminal = createTerminalFeature({
    agents: { resolve: () => valid ? { ref, source: { paneId: 'p1' } } : null, refresh: async () => {} },
    getHerdr: () => ({ paneRead: async (_p, source) => ({ text: source === 'visible' ? text : '' }),
      call: async () => ({ panes: [{ pane_id: 'p1', rect: { width, height: 24 } }] }),
      paneSendText: async (pane, bytes) => sent.push({ pane, bytes }) }),
    send() {}, setTimer: () => ({ unref() {} }), clearTimer() {}, log: s => logs.push(s),
    keyRows: { get() {}, set() {} },
  });
  let screen = await terminal.watch({ connId: 'phone' }, ref);
  terminal.markPrompt(ref, screen.hash);
  const selection = { agent: ref, hash: screen.hash, columns: 80, rows: 24, row: 4 };
  assert.equal((await terminal.select({ connId: 'wrong' }, selection)).ok, false);
  text += '\nchanged';
  assert.equal((await terminal.select({ connId: 'phone' }, selection)).code, 'terminal-stale-screen');
  await terminal.watch({ connId: 'phone' }, ref);
  width = 81;
  assert.equal((await terminal.select({ connId: 'phone' }, selection)).ok, false);
  width = 80; text = fixtures.codex;
  screen = await terminal.watch({ connId: 'second' }, ref);
  terminal.markPrompt(ref, screen.hash);
  assert.equal((await terminal.select({ connId: 'second' }, selection)).ok, true);
  assert.deepEqual(sent, [{ pane: 'p1', bytes: '\x1b[B\r' }]);
  await terminal.watch({ connId: 'third' }, ref);
  assert.equal((await terminal.select({ connId: 'third' }, selection)).code, 'terminal-stale-screen');
  valid = false;
  assert.equal((await terminal.select({ connId: 'third' }, selection)).ok, false);
  assert.equal(sent.length, 1); terminal.close();
});

import { createWatchOperation } from '../server/remote/ops/watch.js';
import { isRemoteRequest } from '../server/remote/contract/requests.js';
test('66 이전 앱에는 새 종류 미전송, 선택 구독만 전달', () => {
  const screen = extractPrompt(frame(fixtures.codex));
  const request = { ref: other, agent: ref, kind: 'terminal-prompt', createdAt: 1, expiresAt: 2,
    body: { questions: [{ question: screen.question, header: '질문', multiSelect: false,
      options: screen.options.map(o => ({ label: o.text, description: '' })) }], screen } };
  const store = { list: () => [], subscribe: () => () => {} };
  const watch = createWatchOperation({ agents: store, requests: store, terminalQuestions: { ...store, list: () => [request] }, send() {} });
  const base = { type: 'session.watch', rid: 'watch' };
  assert.ok(isRemoteRequest({ ...base, prompts: true }));
  assert.equal(isRemoteRequest({ ...base, prompts: 'true' }), false);
  assert.deepEqual(watch.handle({ connId: 'old' }, base).at(-1).questions, []);
  assert.equal(watch.handle({ connId: 'new' }, { ...base, prompts: true }).at(-1).questions[0].kind, 'terminal-prompt');
  watch.close();
});

test('66 화면 해시가 바뀌어도 같은 질문은 식별자 유지, 일시 판독 실패는 질문 유지', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }];
  let current = { text: fixtures.codex + '\n(1s)', hash: '1'.repeat(64), columns: 80, rows: 24 };
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async () => current },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  const first = store.list()[0].ref;
  current = { text: fixtures.codex + '\n(2s)', hash: '2'.repeat(64), columns: 80, rows: 24 }; await store.poll();
  assert.equal(store.list()[0].ref, first);
  current = { text: 'Choose a direction\n› 1. Continue\n  2. Cancel\n❯ stray', hash: '3'.repeat(64), columns: 80, rows: 24 }; await store.poll();
  assert.equal(store.list().length, 1); assert.ok(store.list()[0].body.screen);
  store.close();
});

test('66 한 세션 화면이 바뀌어도 질문 목록 순서와 생성 시각은 유지', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }, { ref: other, status: 'blocked', source: { paneId: 'p2' } }];
  const screens = { [ref]: 1, [other]: 1 };
  const read = a => ({ text: `${a.ref === ref ? 'A' : 'B'}${screens[a.ref]}?\n\n❯ 1. 가\n  2. 나`, hash: String(screens[a.ref]).repeat(64), columns: 80, rows: 24 });
  let time = 100;
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async a => read(a) }, now: () => time++,
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  const first = store.list().map(r => [r.agent, r.createdAt]);
  assert.deepEqual(first.map(x => x[0]), [ref, other]);
  screens[ref] = 2; await store.poll(); await store.poll();
  assert.deepEqual(store.list().map(r => [r.agent, r.createdAt]), first);
  store.close();
});

test('66 화면 읽기 실패 프레임은 기존 질문과 선택 화면을 지우지 않음', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }];
  let current = { text: fixtures.codex, hash: '1'.repeat(64), columns: 80, rows: 24 };
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async () => current },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  assert.ok(store.list()[0].body.screen);
  current = { text: '', hash: '2'.repeat(64), columns: 80, rows: 24, error: 'terminal-read-timeout' }; await store.poll();
  assert.equal(store.list().length, 1); assert.ok(store.list()[0].body.screen);
  store.close();
});

test('66 읽기 실패 뒤 같은 화면이 돌아오면 다시 질문으로 인식', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }];
  const good = { text: fixtures.codex, hash: '1'.repeat(64), columns: 80, rows: 24 };
  let current = good;
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async () => current },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  current = { text: '', hash: '2'.repeat(64), columns: 80, rows: 24, error: 'terminal-read-timeout' }; await store.poll();
  current = good; await store.poll(); await store.poll();
  assert.equal(store.list().length, 1); assert.ok(store.list()[0].body.screen);
  store.close();
});

test("제출 확인 화면은 질문·답 쌍 목록과 제출 물음으로 나눔", async () => {
  const text = [
    "←  ☒ 분할 동작  ☒ 새 탭 위치 ✔ Submit  →", "", "Review your answers", "",
    " │ ● 브라우저 탭에서 '오른쪽으로 분할'을 누르면 탭을 옮길까요,",
    " │   복제할까요?", "   → 이동 (Recommended)",
    " ● 스플릿 중에 어느 칸에 열까요?", "   → 같은 종류 칸 (Recommended)", "",
    "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel", ""].join("\n");
  const { extractPrompt } = await import("../server/remote/features/prompts.js");
  const p = extractPrompt({ text, hash: "a".repeat(64), columns: 100, rows: 40 });
  assert.equal(p.variant, "review");
  assert.equal(p.title, "Ready to submit your answers?");
  assert.equal(p.detail, "1. 브라우저 탭에서 '오른쪽으로 분할'을 누르면 탭을 옮길까요, 복제할까요?\n   → 이동 (Recommended)\n2. 스플릿 중에 어느 칸에 열까요?\n   → 같은 종류 칸 (Recommended)");
});

test('66 체크 전환으로 화면이 이전 상태로 돌아와도 질문이 계속 보임', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }];
  const screen = (mark, hash) => ({ text: `무엇인가요?\n\n❯ 1. [${mark}] 가\n  2. [ ] 나\n     Submit`, hash: hash.repeat(64), columns: 80, rows: 24 });
  let current = screen(' ', 'a');
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async () => current },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  assert.ok(store.list()[0].body.screen);
  current = screen('✔', 'b'); await store.poll(); await store.poll();
  assert.ok(store.list()[0].body.screen);
  // 체크를 해제해 처음 화면으로 복귀
  current = screen(' ', 'a'); await store.poll(); await store.poll();
  assert.equal(store.list().length, 1); assert.ok(store.list()[0].body.screen);
  assert.equal(store.list()[0].body.screen.options.length, 3);
  store.close();
});

test('인식했던 질문은 선택지가 한두 번 안 보여도 유지되고, 답한 뒤에는 빈 카드 없이 닫힌다', async () => {
  const state = [{ ref, status: 'blocked', source: { paneId: 'p1' } }];
  const asking = { text: '무엇인가요?\n\n❯ 1. [ ] 가\n  2. [ ] 나\n     Submit', hash: 'a'.repeat(64), columns: 80, rows: 24 };
  let current = asking, n = 0;
  const store = createPromptStore({ agents: { list: () => state, resolve: r => state.find(a => a.ref === r) },
    requests: { list: () => [] }, terminalQuestions: { list: () => [] },
    terminal: { readPrompt: async () => current },
    setTimer: () => ({ unref() {} }), clearTimer() {}, log() {} });
  store.start('phone'); await new Promise(r => setImmediate(r));
  const first = store.list()[0].ref;
  // 다시 그리는 중간 프레임 두 번
  for (const text of ['', 'Thinking...']) { current = { ...asking, text, hash: String(++n).repeat(64).slice(0, 64) }; await store.poll(); assert.equal(store.list()[0]?.ref, first); }
  current = asking; await store.poll(); assert.equal(store.list()[0].ref, first);
  // 답한 뒤: 3번 연속 선택지 없음 → 닫히고, 같은 대기 상태에서 다른 프레임이 와도 빈 카드가 생기지 않음
  for (let i = 0; i < 3; i++) { current = { ...asking, text: `Working ${i}`, hash: String(i + 5).repeat(64).slice(0, 64) }; await store.poll(); }
  assert.equal(store.list().length, 0);
  current = { ...asking, text: 'Working more', hash: 'e'.repeat(64) }; await store.poll(); await store.poll();
  assert.equal(store.list().length, 0);
  store.close();
});
