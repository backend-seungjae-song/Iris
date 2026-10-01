import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalFeature, terminalMouseMode, terminalSelection, encodeTerminalMouse } from '../server/remote/features/terminal.js';
import { isRemoteRequest } from '../server/remote/contract/requests.js';
import { projectFeature } from '../server/remote/projection.js';
const REF = 'a'.repeat(32);
function fixture(source = { paneId: 'p' }) {
  let text = '❯ 1. first\n  2. second\n  3. third';
  let raw = '', columns = 87, rows = 44, valid = true, revision;
  let time = 1000;
  const sent = [], frames = [], timers = [], logs = [];
  const herdr = {
    paneRead: async (_pane, source) => ({ text: source === 'recent' ? raw : text, revision, truncated: false }),
    call: async () => ({ layout: { panes: [{ pane_id: 'p', rect: { width: columns, height: rows } }] } }),
    paneSendText: async (_pane, bytes) => sent.push(bytes),
  };
  const terminal = createTerminalFeature({ agents: { resolve: () => valid ? { source } : null, refresh: async () => {} },
    getHerdr: () => herdr, send: (_conn, frame) => frames.push(frame), now: () => time,
    setTimer: callback => { const value = { callback, unref() {} }; timers.push(value); return value; }, clearTimer() {},
    keyRows: { get: () => ({}), set: () => ({}) }, log: code => logs.push(code) });
  return { terminal, sent, frames, timers, logs, herdr, next: () => { time += 200; }, setText: value => { text = value; }, setRaw: value => { raw = value; }, setColumns: value => { columns = value; }, invalidate: () => { valid = false; }, setRevision: value => { revision = value; } };
}
const entry = { connId: 'phone' };
const touch = frame => ({ agent: REF, hash: frame.hash, columns: frame.columns, rows: frame.rows, row: 2 });
test('revision 없거나 고정이어도 텍스트와 pane 치수 변경을 전송', async () => {
  for (const revision of [undefined, 0, 3]) {
    const f = fixture(); f.setRevision(revision);
    const initial = await f.terminal.watch(entry, REF);
    assert.equal(initial.columns, 87); assert.equal(initial.rows, 44);
    f.setText('changed'); await f.timers.at(-1).callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.frames.at(-1).text, 'changed');
    f.setColumns(80); await f.timers.at(-1).callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.frames.at(-1).columns, 80);
    const count = f.frames.length; await f.timers.at(-1).callback();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.frames.length, count);
    f.terminal.close();
  }
});
test('현재 선택목록 행 차이만큼 화살표와 Enter 전송, 같은 행 Enter만', async () => {
  const f=fixture(); const frame=await f.terminal.watch(entry,REF);
  assert.deepEqual(await f.terminal.select(entry,{...touch(frame),row:3}),{ok:true});
  assert.equal(f.sent[0],'\x1b[B\x1b[B\r'); f.next();
  await f.terminal.select(entry,{...touch(frame),row:1}); assert.equal(f.sent[1],'\r');
  f.terminal.close();
});

test('가린 전각·한글·결합 글자·이모지도 원래 셀 폭을 유지', async () => {
  const f = fixture();
  f.setText('/\x1b[31mＡ한👩‍💻é\x1b[0m X');
  const frame = await f.terminal.watch(entry, REF);
  assert.equal(frame.text, '•\x1b[31m•••••••\x1b[0m X');
  f.terminal.close();
});
test('애매한 목록, 이전 화면, 이전 치수, 닫힌 pane, 다른 연결은 입력 없음',async()=>{
  const f=fixture(); let frame=await f.terminal.watch(entry,REF);
  f.setText('no selection\nordinary text');
  assert.equal((await f.terminal.select(entry,touch(frame))).code,'terminal-stale-screen'); f.next();
  frame=await f.terminal.watch(entry,REF);
  assert.equal((await f.terminal.select(entry,touch(frame))).code,'terminal-selection-unavailable'); f.next();
  f.setText('❯ 1. first\n  2. second'); frame=await f.terminal.watch(entry,REF);f.setColumns(80);
  assert.equal((await f.terminal.select(entry,touch(frame))).code,'terminal-stale-screen');f.next(); f.invalidate();
  assert.equal((await f.terminal.select(entry,touch(frame))).code,'forbidden');
  assert.equal((await f.terminal.select({connId:'unregistered'},touch(frame))).code,'forbidden');
  assert.equal(f.sent.length,0);f.terminal.close();
});
test('목록 표시와 한 선택 표시가 없거나 여러 목록이면 거절',()=>{
  assert.equal(terminalSelection('1. one\n2. two',2),null);
  assert.equal(terminalSelection('❯ one\n❯ two',2),null);
  assert.equal(terminalSelection('● one\n○ two',2),1);
  assert.equal(terminalSelection('❯ /skill\n○ /other',2),1);
  assert.equal(terminalSelection('❯ first\n○ second\ntext\n○ third',2),null);
  assert.equal(terminalSelection('\x1b[2H❯ first\n○ second',2),null);
  assert.equal(terminalSelection('\x1b[31m❯ first\x1b[0m\n○ second',2),1);
});
test('마우스 모드 설정 해제 순서와 SGR 형식',()=>{
  assert.equal(terminalMouseMode('\x1b[?1000h\x1b[?1006h'),true);
  assert.equal(terminalMouseMode('\x1b[?1000h\x1b[?1006h\x1b[?1000l'),false);
  assert.equal(terminalMouseMode('\x1b[?1000h\x1b[?1006h\x1b[?1006l'),false);
  assert.equal(terminalMouseMode('\x1b[?1000l\x1b[?1002;1006h'),true);
  assert.equal(terminalMouseMode('\x1b[?1002;1006h',true),false);
  assert.equal(terminalMouseMode(''),false);
  const point={column:12,row:5};
  assert.equal(encodeTerminalMouse({...point,action:'click'}),'\x1b[<0;12;5M\x1b[<0;12;5m');
  assert.equal(encodeTerminalMouse({...point,action:'context'}),'\x1b[<2;12;5M\x1b[<2;12;5m');
  assert.equal(encodeTerminalMouse({...point,action:'drag'}),'\x1b[<32;12;5M');
  assert.equal(encodeTerminalMouse({...point,action:'wheel',dy:-1}),'\x1b[<64;12;5M');
  assert.equal(encodeTerminalMouse({...point,action:'wheel',dy:1}),'\x1b[<65;12;5M');
});
test('마우스 아닌 pane, 화면변경, 범위외 좌표에는 바이트를 보내지 않음',async()=>{
  const f=fixture(); let frame=await f.terminal.watch(entry,REF);
  const point={...touch(frame),column:12,action:'click'};
  assert.equal((await f.terminal.mouse(entry,point)).code,'terminal-mouse-unavailable'); f.next();
  f.setRaw('\x1b[?1002;1006h'); frame=await f.terminal.watch(entry,REF);
  assert.equal((await f.terminal.mouse(entry,{...touch(frame),column:88,action:'click'})).code,'invalid-request');f.next();
  assert.deepEqual(await f.terminal.mouse(entry,{...touch(frame),column:12,action:'click'}),{ok:true});
  assert.equal(f.sent[0],'\x1b[<0;12;2M\x1b[<0;12;2m');
  assert.equal((await f.terminal.mouse(entry,{...touch(frame),column:12,action:'click'})).code,'busy');
  f.next();f.setRaw('\x1b[?1002;1006h\x1b[?1006l');
  assert.equal((await f.terminal.mouse(entry,{...touch(frame),column:12,action:'click'})).code,'terminal-stale-screen');
  assert.equal(f.sent.length,1);f.terminal.close();
});
test('48KiB 상한은 부분 화면 대신 사유 표시, frame projection 허용',async()=>{
  const f=fixture();f.setText('x'.repeat(49*1024));const frame=await f.terminal.watch(entry,REF);
  assert.equal(frame.error,'terminal-frame-too-large');assert.equal(frame.text,'');assert.equal(frame.truncated,false);
  assert.equal(f.logs.at(-1),'terminal-frame-too-large');
  projectFeature({type:'terminal.frame',agent:REF,...frame});f.terminal.close();
});
test('터치 요청은 해시·기하·셀 범위·모르는 키를 엄격 검사',()=>{
  const base={type:'terminal.select',rid:'touch',agent:REF,hash:'b'.repeat(64),columns:87,rows:44,row:2};
  assert.equal(isRemoteRequest(base),true);assert.equal(isRemoteRequest({...base,row:45}),false);
  assert.equal(isRemoteRequest({...base,hash:'wrong'}),false);assert.equal(isRemoteRequest({...base,extra:true}),false);
  const mouse={...base,type:'terminal.mouse',column:12,action:'wheel',dy:1};
  assert.equal(isRemoteRequest(mouse),true);assert.equal(isRemoteRequest({...mouse,column:88}),false);
  assert.equal(isRemoteRequest({...mouse,dy:0}),false);
});

test('화면 읽기 실패는 폰에도 사유 프레임으로 전달',async()=>{
  const f=fixture();await f.terminal.watch(entry,REF);
  f.herdr.paneRead=async()=>{throw new Error('private contents');};
  await f.timers.at(-1).callback();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.frames.at(-1).error,'terminal-read-unavailable');
  assert.equal(f.frames.at(-1).text,'');assert.equal(f.logs.at(-1),'terminal-read-unavailable');f.terminal.close();
});
test('최근 기록은 실제 열 수를 쓰고 48KiB·셀 상한·닫힌 pane 거절',async()=>{
  const f=fixture();f.setRaw('older\nlatest');
  assert.deepEqual(await f.terminal.scrollback(REF),{ok:true,text:'older\nlatest',columns:87,lineCount:2});
  f.setRaw('\n'.repeat(4000));assert.equal((await f.terminal.scrollback(REF)).code,'terminal-frame-too-large');
  f.setRaw('x'.repeat(49*1024));assert.equal((await f.terminal.scrollback(REF)).code,'terminal-frame-too-large');
  f.invalidate();assert.equal((await f.terminal.scrollback(REF)).code,'forbidden');f.terminal.close();
});

test('ANSI로 나뉜 경로·식별자는 화면과 기록에서 가리고 색·커서·다음 글자 위치는 보존', async () => {
  const path = '/Users/you/private-project';
  const hex = 'abcdef0123456789abcdef0123456789';
  const identifier = 'fixture-pane-session';
  const f = fixture({ paneId: 'p', sessionId: identifier });
  const source = `cwd: /Users/\x1b[31myou\x1b[0m/private-project X\n`
    + `id: ${hex.slice(0, 16)}\x1b[32m${hex.slice(16)}\x1b[0m Y\n`
    + `session: fixture-\x1b[33mpane-session\x1b[0m Z\x1b[2;3H`;
  f.herdr.paneRead = async () => ({ text: source, truncated: false });
  const frame = await f.terminal.watch(entry, REF);
  const history = await f.terminal.scrollback(REF);
  const ansi = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
  const plainSource = source.replace(ansi, '');
  for (const output of [frame.text, history.text]) {
    const plain = output.replace(ansi, '');
    for (const secret of [path, 'you', hex, identifier]) assert.equal(plain.includes(secret), false, secret);
    assert.deepEqual(output.match(ansi), source.match(ansi), '색·커서 코드는 그대로');
    assert.deepEqual(plain.split('\n').map((line) => line.search(/ [XYZ]$/)),
      plainSource.split('\n').map((line) => line.search(/ [XYZ]$/)), '뒤 글자의 셀 위치');
  }
  f.terminal.close();
});
