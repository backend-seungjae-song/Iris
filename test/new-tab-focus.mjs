// 사용자가 터미널 탭 줄에서 만든 새 탭으로 화면이 옮겨 가야 한다. herdr 는 focus 를 받지 않으면 이전 탭을 보여 준다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-new-tab-focus-'));
process.env.IRIS_STATE_DIR = path.join(root, 'state');
const { initWorkspaceHandlers, handleTab } = await import('../server/workspace-handlers.js');
const { initRuntimeState } = await import('../server/runtime-state.js');
const { HerdrClient } = await import('../server/herdr.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('새 탭 요청은 herdr 에 focus 를 붙여 보낸다', async () => {
  const sent = [];
  const client = new HerdrClient();
  client.call = async (method, params) => { sent.push([method, params]); return { tab_id: 'new' }; };
  let done;
  const completed = new Promise((resolve) => { done = resolve; });
  initRuntimeState({ scheduleRecompute: done });
  initWorkspaceHandlers({ herdr: client });
  handleTab({ _local: true, send: (message) => assert.fail(message) }, { type: 'tab.create', workspaceId: 'owner' });
  await completed;
  assert.deepEqual(sent[0], ['tab.create', { workspace_id: 'owner', focus: true }]);
});

test('focus 를 지정하지 않은 탭 생성은 화면을 옮기지 않는다', async () => {
  const sent = [];
  const client = new HerdrClient();
  client.call = async (method, params) => { sent.push([method, params]); return {}; };
  await client.tabCreate('owner');
  assert.deepEqual(sent[0], ['tab.create', { workspace_id: 'owner' }]);
});
