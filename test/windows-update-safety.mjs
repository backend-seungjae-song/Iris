import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sliceBetween } from '../bin/slice-anchor.mjs';
import { windowsServerPidState, inspectWindowsStateLock } from '../server/windows-state-lock.cjs';
import { cleanupBackups, validateBackup } from '../scripts/windows-update-backup.cjs';

function fixture(t) {
  const parent = new URL('../.working/windows-r8/safety-tests/', import.meta.url);
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fileURLToPath(parent), 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const directory = path.join(root, 'Iris');
  const backup = directory + '.old-' + 'a'.repeat(32);
  fs.mkdirSync(directory); fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'Iris.exe'), 'previous');
  return { root, directory, backup };
}

test('Windows 잠금은 서버·죽은 PID·재사용된 MCP PID·조회 불가를 구별한다', () => {
  const query = (response) => (_exe, args, options) => {
    assert.match(args.at(-1), /ProcessId=764/);
    assert.match(args.at(-1), /ErrorActionPreference='Stop'/);
    assert.ok(options.windowsHide);
    assert.equal(options.timeout, 10000);
    return JSON.stringify(response);
  };
  for (const command of ['Iris.exe C:\\Iris\\server\\index.js', 'node C:/Iris/server/index.js']) {
    assert.equal(windowsServerPidState(764, query({ CommandLine: command })), 'active');
  }
  assert.equal(windowsServerPidState(764, query(null)), 'stale');
  assert.equal(windowsServerPidState(764, query({ CommandLine: 'Iris.exe C:\\Iris\\bin\\iris-mcp.mjs' })), 'stale');
  for (const run of [query({ CommandLine: null }), () => '', () => { throw new Error('CIM failure'); }]) {
    assert.equal(windowsServerPidState(764, run), 'unknown');
  }
  assert.equal(windowsServerPidState(-1, () => { throw new Error('must not query'); }), 'unknown');
});

test('setup 잠금 확인은 stale 파일을 보존하고 읽기·조회 실패를 허용하지 않는다', (t) => {
  const { root } = fixture(t);
  const lock = path.join(root, 'server.lock');
  assert.equal(inspectWindowsStateLock(lock).status, 'absent');
  fs.writeFileSync(lock, '764');
  for (const status of ['active', 'stale', 'unknown']) {
    assert.deepEqual(inspectWindowsStateLock(lock, { pidState: (pid) => { assert.equal(pid, 764); return status; } }), { status, pid: 764 });
    assert.equal(fs.readFileSync(lock, 'utf8'), '764');
  }
  assert.equal(inspectWindowsStateLock(lock, { read: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }).status, 'unknown');
  for (const bad of ['', '0', '-1', 'garbage']) {
    fs.writeFileSync(lock, bad);
    assert.equal(inspectWindowsStateLock(lock).status, 'unknown');
  }
});

test('Windows 서버도 setup과 같은 소유자 판정으로 active·unknown 잠금을 유지한다', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const body = sliceBetween(source, 'function pidIsThisServer(', '\nfunction claimStateDir(');
  for (const status of ['active', 'unknown', 'stale']) {
    const result = vm.runInNewContext(`${body}\npidIsThisServer(764)`, {
      process: { platform: 'win32' }, windowsServerPidState: () => status,
    });
    assert.equal(result, status !== 'stale');
  }
  for (const command of ['node /iris/server/index.js', 'node /iris/bin/iris-mcp.mjs']) {
    const result = vm.runInNewContext(`${body}\npidIsThisServer(764)`, {
      process: { platform: 'darwin' }, commandLineOf: () => command,
      windowsServerPidState: () => { throw new Error('Windows query on macOS'); },
    });
    assert.equal(result, command.includes('server/index.js'));
  }
});

test('Windows CIM·잠금 CLI는 실제 소유 PID 종료 전후를 구별하며 잠금을 삭제하지 않는다', { skip: process.platform !== 'win32' }, async (t) => {
  const { root } = fixture(t);
  const folder = path.join(root, 'server'); fs.mkdirSync(folder);
  const entry = path.join(folder, 'index.js');
  fs.writeFileSync(entry, "process.send('ready'); setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  t.after(() => child.kill());
  await once(child, 'message');
  const lock = path.join(root, 'server.lock'); fs.writeFileSync(lock, String(child.pid));
  const cli = fileURLToPath(new URL('../server/windows-state-lock.cjs', import.meta.url));
  const probe = () => spawnSync(process.execPath, [cli, lock], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(probe().status, 1);
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.equal(probe().status, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(child.pid));
});

test('준비된 앱의 사용하지 않는 이전 백업만 삭제한다', (t) => {
  const { directory, backup } = fixture(t);
  const result = cleanupBackups(directory, backup, [], []);
  assert.equal(result[0].status, 'removed');
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(directory), true);
});

test('이전 프로세스·MCP 경로 참조는 보존하고 종료 후 다음 정리에서 삭제한다', (t) => {
  const { directory, backup } = fixture(t);
  const previous = [{ ProcessId: 7, CreationDate: 'original' }];
  assert.equal(cleanupBackups(directory, backup, previous, previous)[0].status, 'in-use');
  const current = [{ ProcessId: 8, CreationDate: 'new', CommandLine: `node "${backup}/bin/iris-mcp.mjs"` }];
  assert.equal(cleanupBackups(directory, null, [], current)[0].status, 'in-use');
  assert.equal(cleanupBackups(directory, null, [], [{ ProcessId: 7, CreationDate: 'reused' }])[0].status, 'removed');
});

test('경로 검증 실패는 설치 폴더·외부 폴더·잘못된 .old 폴더를 삭제하지 않는다', (t) => {
  const { root, directory, backup } = fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const invalid = directory + '.old-invalid'; fs.mkdirSync(invalid);
  const nested = path.join(directory, path.basename(backup)); fs.mkdirSync(nested);
  for (const target of [directory, outside, invalid, nested, 'relative.old-' + 'a'.repeat(32)]) {
    assert.throws(() => cleanupBackups(directory, target, [], []));
    if (path.isAbsolute(target)) assert.ok(fs.existsSync(target));
  }
  assert.throws(() => cleanupBackups('relative', null, [], []));
  assert.ok(fs.existsSync(backup));
});

test('소유 기록 없는 이전 폴더와 링크·junction 대상은 보존한다', (t) => {
  const { root, directory, backup } = fixture(t);
  assert.equal(cleanupBackups(directory, null, [], [])[0].status, 'retained');
  const external = path.join(root, 'external'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'data');
  const link = path.join(backup, 'junction');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateBackup(directory, backup), /링크/);
  assert.throws(() => cleanupBackups(directory, backup, [], []), /링크/);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'data');
  assert.ok(fs.existsSync(backup));
});
