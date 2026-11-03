import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBrowserFeature } from '../server/remote/features/browser.js';
import { isRemoteRequest } from '../server/remote/contract/requests.js';
import { projectFeature } from '../server/remote/projection.js';
const { createCaptureCommands } = createRequire(import.meta.url)('../native/electron/cdp-cmd-capture.cjs');
const jpeg = () => Buffer.from([255,216,255,192,0,17,8,2,88,3,32,3,1,17,0,2,17,0,3,17,0,255,217]);
function fixture(extra = {}) {
  const sent = [], timers = [], calls = [], logs = [];
  let clock = 100;
  const browser = createBrowserFeature({ browserState: () => ({ tabsBySpace: { work: [{ id: 'one' }] } }),
    tabMeta: () => ({ wc: 42 }), cdpReady: () => true, agents: {}, messages: {},
    requestCdp: async (cmd, args) => {
      calls.push({ cmd, args }); clock += 10;
      return cmd === 'remoteframe' ? { ok: true, jpeg: jpeg().toString('base64'), captureMs: 8, conversionMs: 0 }
        : cmd === 'eval' ? { ok: true, value: { width: 800, height: 600 } } : { ok: true };
    }, now: () => clock, execFile: () => { throw new Error('변환 호출 금지'); },
    send: (_id, frame) => { sent.push(frame); clock += 2; }, log: line => logs.push(line), frameLogEvery: 2,
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); }, ...extra,
  });
  const tab = browser.catalog().tabs[0].ref;
  return { browser, tab, sent, timers, calls, logs, request: { type: 'browser.frame.fast', tab, width: 1080, fps: 20, desktop: false },
    async poll() { const timer = timers.shift(); clock += timer.delay; timer.callback(); await new Promise(resolve => setTimeout(resolve, 20)); } };
}
test('packet67 메모리 JPEG·중복 억제·입력 직후 같은 화면 재전송·집계 로그', async () => {
  const f = fixture();
  try {
    await f.browser.watchFrame({ connId: 'phone' }, f.request);
    assert.equal(f.calls[0].cmd, 'remoteframe');
    projectFeature(f.sent[0]);
    await f.poll();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.logs, ['[remote] browser-frame ms=8/0/1']);
    await f.browser.history({ connId: 'phone' }, { tab: f.tab, action: 'reload' });
    assert.equal(f.timers[0].delay, 0);
    await f.poll();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].seq, 2);
  } finally { f.browser.close(); }
});
test('packet67 캡처 예외·미완료·상한 초과 뒤 재예약과 복구', async () => {
  for (const fail of [() => { throw new Error('private URL'); }, () => new Promise(() => {}),
    () => ({ bytes: Buffer.alloc(384 * 1024 + 1), width: 800, height: 600 })]) {
    let failing = true;
    const f = fixture({ captureTimeoutMs: 5, captureFrame: async () => failing ? fail() : { bytes: jpeg(), width: 800, height: 600 } });
    try {
      assert.deepEqual(await f.browser.watchFrame({ connId: 'phone' }, f.request), { ok: true });
      assert.equal(f.sent[0].type, 'browser.frame.status'); projectFeature(f.sent[0]);
      assert.equal(f.timers.length, 1);
      failing = false; await f.poll();
      assert.equal(f.sent.at(-1).error, null); projectFeature(f.sent.at(-1));
      assert.equal(f.sent.at(-2).type, 'browser.frame');
      assert.equal(f.timers.length, 1);
    } finally { f.browser.close(); }
  }
});
test('packet67 조회 중 입력은 다음 즉시 프레임으로 합침·캡처 중복 금지', async () => {
  let resolve, reading = false;
  const f = fixture({ captureFrame: () => {
    assert.equal(reading, false); reading = true;
    return new Promise(done => { resolve = value => { reading = false; done(value); }; });
  } });
  try {
    const watching = f.browser.watchFrame({ connId: 'phone' }, f.request);
    await new Promise(done => setImmediate(done));
    resolve({ bytes: jpeg(), width: 800, height: 600 }); await watching;
    f.timers.shift().callback(); await new Promise(done => setImmediate(done));
    await f.browser.history({ connId: 'phone' }, { tab: f.tab, action: 'reload' });
    assert.equal(f.timers.length, 0);
    resolve({ bytes: jpeg(), width: 800, height: 600 }); await new Promise(done => setImmediate(done));
    assert.equal(f.timers[0].delay, 0);
  } finally { f.browser.close(); }
});
test('packet67 가로 휠 계약·한도·CSS 좌표·즉시 프레임', async () => {
  const f = fixture();
  try {
    const request = { type: 'browser.wheel', rid: 'one', tab: f.tab, x: 540, y: 300, width: 1080, height: 600, dx: 200, dy: 0 };
    assert.equal(isRemoteRequest(request), true);
    assert.equal(isRemoteRequest({ ...request, dx: 20001 }), false);
    assert.equal(isRemoteRequest({ ...request, dx: 0 }), false);
    await f.browser.watchFrame({ connId: 'phone' }, f.request);
    await f.browser.wheel({ connId: 'phone' }, request);
    assert.deepEqual(f.calls.at(-1), { cmd: 'remotewheel', args: { x: 400, y: 300, dx: 200, dy: 0 } });
    assert.equal(f.timers[0].delay, 0);
    assert.equal(isRemoteRequest({ ...f.request, rid: 'one' }), true);
    assert.equal(isRemoteRequest({ ...f.request, rid: 'one', fps: 21 }), false);
    assert.equal(isRemoteRequest({ ...f.request, type: 'browser.frame.watch', rid: 'one' }), false);
  } finally { f.browser.close(); }
});
test('packet67 native 화면 스트림은 켜 둔 최신 프레임을 바로 주고 크기 초과 시 품질을 낮춤', async () => {
  const holds = [], sent = [], listeners = [];
  const dbg = { on: (_n, fn) => listeners.push(fn), off: (_n, fn) => listeners.splice(listeners.indexOf(fn), 1),
    sendCommand: async (cmd, args) => { sent.push({ cmd, args }); return {}; } };
  const emit = bytes => listeners.slice().forEach(fn => fn({}, 'Page.screencastFrame', { sessionId: 1, data: bytes.toString('base64') }));
  const commands = createCaptureCommands({ captureHold: async (...args) => { holds.push(args); return true; } });
  const wc = { id: 42, debugger: dbg };
  const calls = [];
  const send = async cmd => { calls.push(cmd); return {}; };
  const first = commands.remoteframe(send, wc, { width: 1600 });
  await new Promise(r => setImmediate(r));
  emit(jpeg());
  const result = await first;
  assert.equal(result.jpeg, jpeg().toString('base64'));
  const start = sent.find(c => c.cmd === 'Page.startScreencast');
  assert.equal(start.args.format, 'jpeg');
  assert.equal(start.args.maxWidth, 1600);
  assert.deepEqual(holds, [[42, true]]);
  const again = await commands.remoteframe(send, wc, { width: 1600 });
  assert.equal(again.jpeg, result.jpeg);
  assert.equal(sent.filter(c => c.cmd === 'Page.startScreencast').length, 1);
  emit(Buffer.alloc(384 * 1024 + 1));
  await assert.rejects(commands.remoteframe(send, wc, { width: 1600 }), /too-large/);
  assert.deepEqual(holds.at(-1), [42, false]);
  const retry = commands.remoteframe(send, wc, { width: 1600 });
  await new Promise(r => setImmediate(r));
  emit(jpeg());
  await retry;
  assert.equal(sent.filter(c => c.cmd === 'Page.startScreencast').at(-1).args.quality, 40);
  const wheel = [];
  await commands.remotewheel(async (...args) => wheel.push(args), { id: 42 }, { x: 10, y: 20, dx: 60, dy: -80 });
  assert.deepEqual(wheel[0], ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 20, deltaX: 60, deltaY: -80 }]);
});
test('packet67 native 화면 스트림은 100ms 이상 지난 요청마다 screencast 를 다시 시작해 현재 화면을 받음', async () => {
  const sent = [], listeners = [];
  const dbg = { on: (_n, fn) => listeners.push(fn), off: (_n, fn) => listeners.splice(listeners.indexOf(fn), 1),
    sendCommand: async (cmd, args) => { sent.push({ cmd, args }); return {}; } };
  const emit = bytes => listeners.slice().forEach(fn => fn({}, 'Page.screencastFrame', { sessionId: 1, data: bytes.toString('base64') }));
  const commands = createCaptureCommands({ captureHold: async () => true });
  const wc = { id: 43, debugger: dbg };
  const send = async () => ({});
  const first = commands.remoteframe(send, wc, { width: 800 });
  await new Promise(r => setImmediate(r));
  emit(Buffer.from('old-frame'));
  assert.equal((await first).jpeg, Buffer.from('old-frame').toString('base64'));
  await new Promise(r => setTimeout(r, 130));
  const second = commands.remoteframe(send, wc, { width: 800 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.filter(c => c.cmd === 'Page.startScreencast').length, 2);
  assert.equal(sent.filter(c => c.cmd === 'Page.stopScreencast').length, 1);
  emit(Buffer.from('new-frame'));
  assert.equal((await second).jpeg, Buffer.from('new-frame').toString('base64'));
  commands.stop?.(43);
});
