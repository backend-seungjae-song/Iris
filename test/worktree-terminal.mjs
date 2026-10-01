import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 상태 파일은 임시 폴더에 격리하고 Herdr 호출만 대체한다.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-worktree-terminal-'));
process.env.IRIS_STATE_DIR = path.join(root, 'state');
const { initWorkspaceHandlers, handleTab } = await import('../server/workspace-handlers.js');
const { initRuntimeState } = await import('../server/runtime-state.js');
const { agentArgv, shellCommand } = await import('../server/agent-launch.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('워크트리 터미널과 세션은 지정 폴더로 이동하고 실행한다', async () => {
  const cwd = path.join(root, "work tree ' $(false)");
  fs.mkdirSync(cwd);
  for (const launch of ['', 'codex', 'claude']) {
    const calls = [];
    let done;
    const completed = new Promise(resolve => { done = resolve; });
    initRuntimeState({ scheduleRecompute: done });
    initWorkspaceHandlers({ herdr: {
      tabCreate: async id => { calls.push(['create', id]); return { tab_id: 'new' }; },
      paneList: async () => [{ tab_id: 'old', pane_id: 'old-pane' }, { tab_id: 'new', pane_id: 'new-pane' }],
      paneRead: async () => ({ text: '$ ' }),
      paneSendText: async (...args) => calls.push(['send', ...args]),
    } });
    handleTab({ _local: true, send: message => assert.fail(message) }, { type: 'tab.create', workspaceId: 'owner', cwd, launch });
    await completed;
    assert.deepEqual(calls[0], ['create', 'owner']);
    const command = shellCommand(['cd', '--', cwd]);
    assert.deepEqual(calls[1], ['send', 'new-pane', command + (launch ? ' && ' + shellCommand(agentArgv(launch)) : '') + '\r']);
    assert.equal(execFileSync('/bin/zsh', ['-c', command + ' && pwd -P'], { encoding: 'utf8' }).trim(), fs.realpathSync(cwd));
    fs.rmdirSync(cwd);
    assert.throws(() => execFileSync('/bin/zsh', ['-c', command + ' && echo unexpected'], { stdio: 'pipe' }));
    fs.mkdirSync(cwd);
  }
});

test('없는 경로·잘못된 경로와 원격 생성은 탭을 만들기 전에 거부한다', () => {
  let created = 0;
  initWorkspaceHandlers({ herdr: { tabCreate: () => { created++; return Promise.resolve({}); } } });
  for (const cwd of ['', 'relative', root + '/missing', root + '\ncommand', 123]) {
    const errors = [];
    handleTab({ _local: true, send: message => errors.push(JSON.parse(message)) }, { type: 'tab.create', cwd });
    assert.equal(errors[0]?.type, 'control-error');
  }
  handleTab({ _local: false, send() {} }, { type: 'tab.create', cwd: root });
  assert.equal(created, 0);
});

test('생성 직후 pane 정보가 늦게 오면 새 탭만 찾아 실행하고 끝내 없으면 오류를 알린다', async () => {
  for (const appears of [true, false]) {
    let reads=0, completed;
    const done=new Promise(resolve=>{completed=resolve;});
    const calls=[], errors=[];
    initRuntimeState({scheduleRecompute:completed});
    initWorkspaceHandlers({herdr:{
      tabCreate:async()=>({tab_id:'new-tab'}),
      paneList:async()=>{reads++;return appears && reads>1 ? [{tab_id:'new-tab',pane_id:'new-pane'}] : [{tab_id:'old-tab',pane_id:'old-pane'}];},
      paneRead:async()=>({text:'$ '}),
      paneSendText:async(...args)=>calls.push(args),
    }});
    handleTab({_local:true,send:message=>errors.push(JSON.parse(message))},{type:'tab.create',workspaceId:'owner',cwd:root});
    await done;
    if(appears){ assert.equal(reads,2);assert.equal(calls[0][0],'new-pane');assert.equal(errors.length,0); }
    else { assert.equal(reads,10);assert.equal(calls.length,0);assert.match(errors[0].message,/새 탭의 터미널/); }
  }
});
