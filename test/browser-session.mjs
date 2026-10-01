import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionResolver, chooseCodexResumePane } from '../bin/iris-session.mjs';

const resumedId = '11111111-1111-4111-8111-111111111111';
test('등록이 없는 공유 daemon의 resume ID를 실행 중인 TUI와 대조한다', async () => {
  const agents = [{ pane_id: 'w2:p2', agent: 'codex' }];
  const infos = [{ process_info: { foreground_processes: [{ argv: ['codex', 'resume', resumedId] }] } }];
  assert.equal(chooseCodexResumePane(agents, infos, resumedId), 'w2:p2');
  assert.equal(chooseCodexResumePane(agents, infos, '22222222-2222-4222-8222-222222222222'), null);
  assert.equal(chooseCodexResumePane([...agents, { ...agents[0], pane_id: 'other' }], [...infos, ...infos], resumedId), null);
  assert.equal(chooseCodexResumePane([{ ...agents[0], agent_session: { value: 'new-thread' } }], infos, resumedId), null);
  assert.equal(chooseCodexResumePane(agents, [{ foreground_processes: [{ argv: ['claude', 'resume', resumedId] }] }], resumedId), null);
  const resolve = createSessionResolver({ env: { CODEX_THREAD_ID: resumedId }, ancestry: async () => [],
    call: async (method) => method === 'agent.list' ? { agents } : infos[0] });
  assert.equal(await resolve(), 'w2:p2');
});

test('CODEX_SESSION_ID만 전달돼도 등록 ID를 조회한다', async () => {
  assert.equal(await fixture({ CODEX_SESSION_ID: 'current-thread' }).resolve(), 'w2:p2');
});

function fixture(env = {}) {
  const state = {
    agents: [
      { pane_id: 'w1:p1', agent: 'codex', agent_session: { kind: 'id', value: 'old-thread' } },
      { pane_id: 'w2:p2', agent: 'codex', agent_session: { kind: 'id', value: 'current-thread' } },
    ],
    ancestors: [900, 200], calls: [],
  };
  const resolve = createSessionResolver({ env, ancestry: async () => state.ancestors,
    call: async (method, params) => {
      state.calls.push(method);
      if (method === 'agent.list') return { agents: state.agents };
      if (method === 'pane.list') return { panes: state.agents };
      if (method === 'pane.process_info') return { process_info: {
        shell_pid: params.pane_id === 'w1:p1' ? 100 : 200,
      } };
      throw new Error(method);
    },
  });
  return { state, resolve };
}

test('공유 daemon의 오래된 pane보다 현재 대화 ID를 사용한다', async () => {
  const { resolve, state } = fixture({ HERDR_PANE_ID: 'w1:p1', CODEX_THREAD_ID: 'current-thread' });
  state.ancestors = [900, 800];
  assert.equal(await resolve(), 'w2:p2');
});

test('환경 pane이 없어도 현재 프로세스가 속한 pane을 찾는다', async () => {
  const { resolve } = fixture({ HERDR_PANE_ID: 'deleted-pane' });
  assert.equal(await resolve(), 'w2:p2');
});

test('다른 대화의 환경 pane을 소유 증거 없이 사용하지 않는다', async () => {
  const { state, resolve } = fixture({ HERDR_PANE_ID: 'w1:p1', CODEX_THREAD_ID: 'unregistered' });
  state.ancestors = [900, 800];
  assert.equal(await resolve(), null);
});

test('동일 대화가 여러 pane에 등록되면 선택하지 않는다', async () => {
  const { state, resolve } = fixture({ CODEX_THREAD_ID: 'current-thread' });
  state.agents[0].agent_session.value = 'current-thread';
  assert.equal(await resolve(), null);
});

test('다음 호출은 이동한 pane을 다시 조회한다', async () => {
  const { state, resolve } = fixture({ CODEX_THREAD_ID: 'current-thread' });
  assert.equal(await resolve(), 'w2:p2');
  state.agents[1].pane_id = 'w3:p3';
  assert.equal(await resolve(), 'w3:p3');
  state.agents = [];
  assert.equal(await resolve(), null);
});

test('명시적 지정은 존재하는 pane만 허용한다', async () => {
  assert.equal(await fixture({ IRIS_SESSION: 'w1:p1', CODEX_THREAD_ID: 'current-thread' }).resolve(), 'w1:p1');
  assert.equal(await fixture({ IRIS_SESSION: 'deleted-pane' }).resolve(), null);
});

test('동시 요청은 조회를 공유하고 이후 요청은 다시 조회한다', async () => {
  const { resolve, state } = fixture({ CODEX_THREAD_ID: 'current-thread' });
  assert.deepEqual(await Promise.all([resolve(), resolve(), resolve()]), ['w2:p2', 'w2:p2', 'w2:p2']);
  assert.equal(state.calls.filter(c => c === 'agent.list').length, 1);
  await resolve();
  assert.equal(state.calls.filter(c => c === 'agent.list').length, 2);
});

test('herdr 연결 실패 시 임의의 pane을 반환하지 않는다', async () => {
  const resolve = createSessionResolver({ env: { HERDR_PANE_ID: 'w1:p1' }, call: async () => { throw Error('offline'); } });
  assert.equal(await resolve(), null);
});
