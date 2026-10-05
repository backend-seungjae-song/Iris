import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { HerdrClient } from '../server/herdr.js';

const source = fs.readFileSync(new URL('../scripts/check-windows-update.mjs', import.meta.url), 'utf8');
const created = { type: 'workspace_created', workspace: { workspace_id: 'w2' }, root_pane: { pane_id: 'w2:p1' } };

async function runUpdate(body, response = created, setupCode = 0) {
  const requests = [];
  const writes = new Map();
  const launches = [];
  const terminal = { pid: 200, token: 'continuity-token' };
  let terminalStarted = false;
  class FixtureClient extends HerdrClient {
    async call(method, params) {
      requests.push({ method, params });
      if (method === 'workspace.create') return response;
      if (method === 'workspace.close') {
        assert.ok(params.workspace_id, 'missing field workspace_id');
        return {};
      }
      if (method === 'pane.list') return { panes: params.workspace_id
        ? [{ pane_id: `${params.workspace_id}:p1` }]
        : [{ pane_id: 'w1:p1' }, { pane_id: 'w2:p1' }] };
      if (method === 'pane.send_text') { terminalStarted = true; return {}; }
      if (method === 'pane.read') return { read: { text: `continuity:${terminal.token}:${terminal.pid}` } };
      throw new Error(`unexpected herdr method: ${method}`);
    }
  }
  const mcp = new EventEmitter();
  mcp.pid = 300; mcp.exitCode = null;
  mcp.stdout = new EventEmitter(); mcp.stderr = new EventEmitter();
  mcp.stdin = {
    write(line) {
      const request = JSON.parse(line);
      const result = request.method === 'initialize'
        ? { serverInfo: { name: 'iris-remote' } }
        : { native: { ok: true }, helperPid: 400 };
      mcp.stdout.emit('data', JSON.stringify({ id: request.id, result }) + '\n');
    },
    end() { mcp.ended = true; },
  };
  const processes = [
    { ProcessId: 100, ParentProcessId: 1, Name: 'herdr.exe', CreationDate: 'herdr-start' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', CreationDate: 'terminal-start' },
    { ProcessId: 300, ParentProcessId: 1, Name: 'Iris.exe', CreationDate: 'mcp-start' },
    { ProcessId: 400, ParentProcessId: 300, Name: 'powershell.exe', CreationDate: 'helper-start' },
  ];
  const program = body.replace(/^import .*;\r?\n/gm, '')
    .replace(/await import\(pathToFileURL\(path\.join\(unpacked, 'server', 'herdr.js'\)\)\)/, '{ HerdrClient: FixtureClient }')
    .replace(/await import\(pathToFileURL\(path\.join\(unpacked, 'server', 'herdr-session.cjs'\)\)\)/, '{ herdrSession: fixtureSession }');
  let error;
  try {
    await vm.runInNewContext(`(async () => {\n${program}\n})()`, {
      assert, path: path.win32, FixtureClient,
      fixtureSession: () => ({ name: 'test', socket: 'test-pipe' }),
      process: { platform: 'win32', cwd: () => 'C:\\checkout', env: { LOCALAPPDATA: 'C:\\local', RUNNER_TEMP: 'C:\\temp' } },
      fs: {
        mkdirSync() {}, appendFileSync() {},
        writeFileSync(file, value) { writes.set(file, value); },
        existsSync(file) { return file.endsWith('terminal.json') && terminalStarted; },
        readFileSync() { return JSON.stringify(terminal); },
      },
      randomUUID: () => terminal.token,
      windowsPowerShellEnv: () => ({}),
      execFileSync(command) { return command === 'powershell.exe' ? JSON.stringify(processes) : ''; },
      spawn(command, args) {
        launches.push({ command, args });
        if (command.endsWith('Iris.exe')) return mcp;
        const child = new EventEmitter();
        setImmediate(() => child.emit('exit', setupCode, null));
        return child;
      },
      console: { log() {} }, setTimeout,
    }, { filename: 'scripts/check-windows-update.mjs', timeout: 1000 });
  } catch (failure) { error = failure; }
  return { error, requests, writes, launches, mcp };
}

function requireWorkspace(result) {
  assert.ifError(result.error);
  const scoped = result.requests.filter(({ method }) => method === 'pane.list' || method === 'workspace.close');
  assert.deepEqual(scoped.map(({ params }) => params.workspace_id), ['w2', 'w2', 'w2']);
  for (const { method, params } of result.requests) {
    if (method === 'pane.send_text' || method === 'pane.read') assert.equal(params.pane_id, 'w2:p1');
  }
  const before = JSON.parse([...result.writes].find(([file]) => file.endsWith('before.json'))[1]);
  assert.equal(before.paneId, 'w2:p1');
  assert.equal(result.mcp.ended, true);
}

test('Windows 업데이트 검사는 herdr 0.9.3 생성 응답의 스페이스에서 pane 조회·종료를 수행한다', async () => {
  requireWorkspace(await runUpdate(source));
  requireWorkspace(await runUpdate(source, { workspace_id: 'w2' }));
});

test('Windows 업데이트 검사는 생성 ID가 없으면 다른 스페이스를 조회하기 전에 실패한다', async () => {
  const result = await runUpdate(source, { type: 'workspace_created' });
  assert.match(result.error?.message || '', /created workspace ID/);
  assert.deepEqual(result.requests.map(({ method }) => method), ['workspace.create']);
  assert.equal(result.launches.length, 0);
});

test('Windows 업데이트 실패 시에도 생성한 스페이스만 닫고 MCP 입력을 종료한다', async () => {
  const result = await runUpdate(source, created, 17);
  assert.match(result.error?.message || '', /second setup/);
  assert.equal(result.requests.at(-1).method, 'workspace.close');
  assert.equal(result.requests.at(-1).params.workspace_id, 'w2');
  assert.equal(result.mcp.ended, true);
});

test('Windows 업데이트 회귀 검사는 생성 응답·ID 검증·조회·종료 결함을 감지한다', async () => {
  const unguarded = source.replace("assert.ok(typeof workspaceId === 'string' && workspaceId.length > 0, 'created workspace ID');", '');
  assert.notEqual(unguarded, source, 'mutation applied');
  const invalid = await runUpdate(unguarded, { type: 'workspace_created' });
  assert.throws(() => assert.match(invalid.error?.message || '', /created workspace ID/));
  for (const broken of [
    source.replace('workspace?.workspace?.workspace_id || workspace?.workspace_id', 'workspace?.workspace_id'),
    source.replaceAll('herdr.paneList(workspaceId)', 'herdr.paneList(workspace.workspace_id)'),
    source.replace('herdr.workspaceClose(workspaceId)', 'herdr.workspaceClose(workspace.workspace_id)'),
  ]) {
    assert.notEqual(broken, source, 'mutation applied');
    const result = await runUpdate(broken);
    assert.throws(() => requireWorkspace(result));
  }
});
