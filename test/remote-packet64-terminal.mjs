import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalFeature } from '../server/remote/features/terminal.js';
import { projectFeature } from '../server/remote/projection.js';
const REF = 'a'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let visible = 'first', recent = 'first', clock = 0;
  const frames = [], timers = [], logs = [];
  const herdr = {
    paneRead: async (_pane, source) => ({ text: source === 'visible' ? visible : recent, revision: 0 }),
    call: async () => ({ panes: [{ pane_id: 'p', rect: { width: 80, height: 24 } }] }),
    paneSendText: async () => {},
  };
  const terminal = createTerminalFeature({ getHerdr: () => herdr,
    agents: { resolve: () => ({ source: { paneId: 'p' } }) },
    send: (_conn, frame) => frames.push(frame), log: line => logs.push(line),
    keyRows: {}, readTimeoutMs: 10, now: () => clock,
    setTimer: callback => { timers.push(callback); return { unref() {} }; }, clearTimer() {},
  });
  return { terminal, herdr, frames, logs, timers, set: (v, r = v) => { visible = v; recent = r; },
    async poll() { clock += 1000; timers.pop()(); await new Promise(resolve => setTimeout(resolve, 25)); await tick(); } };
}
for (const stage of ['visible', 'recent', 'layout']) {
  test(`packet64 ${stage} 읽기 미완료: 제한 시간 사유 뒤 다음 poll 복구`, async () => {
    const f = fixture(); const originalRead = f.herdr.paneRead, originalCall = f.herdr.call;
    try {
      await f.terminal.watch({ connId: 'phone' }, REF);
      f.herdr.paneRead = (...args) => args[1] === stage ? new Promise(() => {}) : originalRead(...args);
      if (stage === 'layout') f.herdr.call = () => new Promise(() => {});
      await f.poll();
      assert.equal(f.frames.at(-1).error, 'terminal-read-timeout');
      assert.deepEqual(f.logs, ['terminal-read reason=terminal-read-timeout']);
      projectFeature(f.frames.at(-1));
      f.herdr.paneRead = originalRead; f.herdr.call = originalCall;
      f.set('recovered'); await f.poll();
      assert.equal(f.frames.at(-1).text, 'recovered');
      assert.equal(f.frames.at(-1).error, undefined);
    } finally { f.terminal.close(); }
  });
}
test('packet64 첫 읽기 제한 시간 이후에도 구독 poll 유지', async () => {
  const f = fixture(); const read = f.herdr.paneRead;
  try {
    f.herdr.paneRead = () => new Promise(() => {});
    const first = await f.terminal.watch({ connId: 'phone' }, REF);
    assert.equal(first.error, 'terminal-read-timeout');
    f.herdr.paneRead = read; f.set('second'); await f.poll();
    assert.equal(f.frames.at(-1).text, 'second');
  } finally { f.terminal.close(); }
});
test('packet64 visible 고정·recent 반복 변경: 사유 표시, visible 복구 시 해제', async () => {
  const f = fixture();
  try {
    await f.terminal.watch({ connId: 'phone' }, REF);
    for (let n = 1; n <= 3; n++) { f.set('first', `new ${n}`); await f.poll(); }
    assert.equal(f.frames.at(-1).error, 'terminal-screen-stale');
    assert.equal(f.frames.at(-1).text, 'first');
    assert.equal(f.logs.at(-1), 'terminal-read reason=terminal-screen-stale');
    projectFeature(f.frames.at(-1));
    f.set('live'); await f.poll();
    assert.equal(f.frames.at(-1).text, 'live');
    assert.equal(f.frames.at(-1).error, undefined);
  } finally { f.terminal.close(); }
});
test('packet64 조용한 pane과 한 번 늦은 recent 조회는 중단으로 판단하지 않음', async () => {
  const f = fixture();
  try {
    await f.terminal.watch({ connId: 'phone' }, REF);
    await f.poll(); f.set('first', 'recent changed'); await f.poll(); await f.poll(); await f.poll();
    assert.equal(f.frames.length, 0); assert.equal(f.logs.length, 0);
    f.set('next'); await f.poll();
    assert.equal(f.frames.at(-1).text, 'next');
  } finally { f.terminal.close(); }
});
test('packet64 layout 예외에도 visible 내용과 크기 실패 사유 전달·다음 poll 복구', async () => {
  const f = fixture(); const call = f.herdr.call;
  try {
    f.herdr.call = async () => { throw new Error('private'); };
    const first = await f.terminal.watch({ connId: 'phone' }, REF);
    assert.equal(first.text, 'first'); assert.equal(first.error, 'terminal-layout-unavailable');
    f.herdr.call = call; f.set('live'); await f.poll();
    assert.equal(f.frames.at(-1).error, undefined);
  } finally { f.terminal.close(); }
});

test('packet64 입력 직후 refresh와 poll 겹침 이후에도 주기 조회 유지', async () => {
  const f = fixture(); const original = f.herdr.paneRead;
  let resume;
  try {
    await f.terminal.watch({ connId: 'phone' }, REF);
    f.herdr.paneRead = (_pane, source) => source === 'visible'
      ? new Promise(resolve => { resume = resolve; }) : original(_pane, source);
    const submitted = f.terminal.submit({ connId: 'phone' }, REF, 'hello');
    await tick();
    assert.equal(typeof resume, 'function');
    f.timers.pop()(); await tick();
    assert.equal(f.timers.length, 1, '읽는 중인 poll도 다음 poll 예약');
    resume({ text: 'after input' }); await submitted;
    f.herdr.paneRead = original; f.set('next output'); await f.poll();
    assert.equal(f.frames.at(-1).text, 'next output');
  } finally { f.terminal.close(); }
});
