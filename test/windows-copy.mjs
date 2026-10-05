import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyTreeSync, copyTreeWindowsSync } from '../server/copy-tree.cjs';
import { handleFsOp } from '../server/fs-handlers.js';
import { initRuntimeState, replace, snapshot } from '../server/runtime-state.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-copy-')));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const source = path.join(directory, "checkout O'Brien ! & [1] $; 한글");
  const destination = path.join(directory, "local O'Brien ! & [1] $; 한글");
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', '문서.txt'), 'original');
  return { directory, source, destination };
}
const recursive = { recursive: true };
const noClobber = { recursive: true, force: false, errorOnExist: true };

for (const [label, name] of [['ascii', 'plain'], ['unicode', '한글'], ['symbols', "O'Brien ! & [1] $;"], ['combined', "O'Brien ! & [1] $; 한글"]]) {
  for (const operation of ['cpSync', 'copyFileSync']) {
    test(`Windows 네이티브 복사 진단: ${operation} ${label}`, { skip: process.platform !== 'win32' }, (t) => {
      const { directory } = fixture(t);
      const evidence = process.env.IRIS_WINDOWS_TEST_TRACE_DIR || path.join(root, 'evidence', 'windows-tests');
      fs.mkdirSync(evidence, { recursive: true });
      const receipt = path.join(evidence, `copy-probe-${process.pid}-${operation}-${label}.json`);
      const started = { operation, label, name, node: process.version, executable: process.execPath, directory, time: new Date().toISOString() };
      fs.writeFileSync(receipt, JSON.stringify({ ...started, event: 'child:start' }, null, 2));
      const result = spawnSync(process.execPath, [
        '--report-on-fatalerror', '--report-exclude-env', `--report-directory=${evidence}`,
        fileURLToPath(new URL('./lib/windows-copy-probe.cjs', import.meta.url)), operation, directory, name,
      ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
      const record = { ...started, event: 'child:exit', status: result.status,
        statusHex: result.status === null ? null : `0x${(result.status >>> 0).toString(16).padStart(8, '0')}`,
        signal: result.signal, error: result.error ? { code: result.error.code, message: result.error.message } : null,
        stdout: result.stdout, stderr: result.stderr };
      fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
      t.diagnostic(JSON.stringify(record));
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      // Node 22 Windows cpSync 의 한글 경로 fail-fast(0xC0000409, CI 실측) → 앱은 copy-tree 사용
      if (operation === 'cpSync' && /[^\x00-\x7f]/.test(name)) {
        assert.equal(result.status, 0xC0000409, `cpSync 한글 경로 결함 재현 안 됨, copy-tree 분기 재검토: ${receipt}`);
        return;
      }
      assert.equal(result.status, 0, `네이티브 복사 실패: ${receipt}`);
      assert.match(result.stdout, /"event":"verified"/);
    });
  }
}

test('Windows 재귀 복사는 특수문자·한글 경로와 필터를 보존한다', (t) => {
  const { source, destination } = fixture(t);
  fs.mkdirSync(path.join(source, 'skip'));
  fs.writeFileSync(path.join(source, 'skip', 'secret'), 'excluded');
  const visited = [];
  t.mock.method(fs, 'cpSync', () => { throw new Error('native cpSync 호출'); });
  copyTreeWindowsSync(source, destination, { ...recursive, filter: (from, to) => {
    visited.push([from, to]);
    return path.basename(from) !== 'skip';
  } });
  assert.equal(fs.readFileSync(path.join(destination, 'nested', '문서.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(destination, 'skip')), false);
  assert.deepEqual(visited[0], [source, destination]);
  assert.throws(() => copyTreeWindowsSync(source, destination, { filter: () => Promise.resolve(true) }), /동기/);
});

test('Windows 복사는 force와 errorOnExist 조합별로 기존 파일을 보존하거나 교체한다', (t) => {
  const { source, destination } = fixture(t);
  copyTreeWindowsSync(source, destination, recursive);
  const target = path.join(destination, 'nested', '문서.txt');
  for (const force of [false, true]) for (const errorOnExist of [false, true]) {
    fs.writeFileSync(target, 'existing');
    const run = () => copyTreeWindowsSync(source, destination, { recursive: true, force, errorOnExist });
    if (!force && errorOnExist) assert.throws(run, { code: 'ERR_FS_CP_EEXIST' });
    else run();
    assert.equal(fs.readFileSync(target, 'utf8'), force ? 'original' : 'existing');
    assert.equal(fs.readFileSync(path.join(source, 'nested', '문서.txt'), 'utf8'), 'original');
  }
});

test('Windows 복사는 재귀 옵션·자기 복사·하위 복사·파일 형식 충돌을 거절한다', (t) => {
  const { source, destination, directory } = fixture(t);
  const file = path.join(source, 'nested', '문서.txt');
  assert.throws(() => copyTreeWindowsSync(source, destination), { code: 'ERR_FS_EISDIR' });
  assert.throws(() => copyTreeWindowsSync(source, source, recursive), { code: 'ERR_FS_CP_EINVAL' });
  assert.throws(() => copyTreeWindowsSync(source, path.join(source, 'child'), recursive), { code: 'ERR_FS_CP_EINVAL' });
  assert.equal(fs.existsSync(path.join(source, 'child')), false);
  fs.linkSync(file, path.join(directory, 'hardlink'));
  assert.throws(() => copyTreeWindowsSync(file, path.join(directory, 'hardlink')), { code: 'ERR_FS_CP_EINVAL' });
  fs.writeFileSync(destination, 'keep');
  assert.throws(() => copyTreeWindowsSync(source, destination, recursive), { code: 'ERR_FS_CP_DIR_TO_NON_DIR' });
  assert.throws(() => copyTreeWindowsSync(file, source, recursive), { code: 'ERR_FS_CP_NON_DIR_TO_DIR' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
});

test('Windows 복사는 디렉터리 링크를 순회하지 않고 링크 대상으로 보존한다', (t) => {
  const { source, destination, directory } = fixture(t);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'outside');
  fs.symlinkSync(outside, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  copyTreeWindowsSync(source, destination, recursive);
  const copied = path.join(destination, 'link');
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(copied), fs.realpathSync(outside));
  assert.throws(() => copyTreeWindowsSync(source, destination, noClobber), { code: 'ERR_FS_CP_EEXIST' });
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  fs.symlinkSync(source, path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyTreeWindowsSync(source, path.join(directory, 'alias', 'child'), recursive), { code: 'ERR_FS_CP_EINVAL' });
  assert.equal(fs.existsSync(path.join(source, 'child')), false);
});

test('Windows 복사 구현은 상대·끊어진 파일 링크와 링크 충돌을 처리한다', (t) => {
  const { source, destination } = fixture(t);
  try { fs.symlinkSync('nested/문서.txt', path.join(source, 'relative'), 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows 파일 심볼릭 링크 권한 없음'); return;
  }
  fs.symlinkSync('missing', path.join(source, 'dangling'), 'file');
  copyTreeWindowsSync(source, destination, recursive);
  for (const name of ['relative', 'dangling']) {
    assert.equal(fs.lstatSync(path.join(destination, name)).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(destination, name)), path.resolve(source, name === 'relative' ? 'nested/문서.txt' : 'missing'));
  }
  const originalLink = fs.readlinkSync(path.join(destination, 'relative'));
  copyTreeWindowsSync(path.join(source, 'dangling'), path.join(destination, 'relative'), { force: false });
  assert.equal(fs.readlinkSync(path.join(destination, 'relative')), originalLink);
  assert.throws(() => copyTreeWindowsSync(path.join(source, 'dangling'), path.join(destination, 'relative'), noClobber), { code: 'ERR_FS_CP_EEXIST' });
  copyTreeWindowsSync(path.join(source, 'dangling'), path.join(destination, 'relative'));
  assert.equal(fs.readlinkSync(path.join(destination, 'relative')), path.join(source, 'missing'));
});

test('플랫폼 공용 복사는 macOS의 fs.cpSync 인자를 그대로 전달하고 Windows에서만 우회한다', (t) => {
  const { source, destination } = fixture(t);
  const options = { ...recursive };
  const original = fs.cpSync;
  let calls = 0;
  t.mock.method(fs, 'cpSync', (...args) => {
    calls++;
    assert.notEqual(process.platform, 'win32');
    assert.deepEqual(args, [source, destination, options]);
    assert.equal(args[2], options);
    return original(...args);
  });
  copyTreeSync(source, destination, options);
  assert.equal(calls, process.platform === 'win32' ? 0 : 1);
  assert.equal(fs.readFileSync(path.join(destination, 'nested', '문서.txt'), 'utf8'), 'original');
});

test('탐색기 폴더 복사는 사본을 만들고 기존 목적지의 파일을 덮어쓰지 않는다', async (t) => {
  const { source, directory } = fixture(t);
  const previous = snapshot();
  initRuntimeState({ scheduleRecompute() {} });
  replace({ allowedRoots: [directory] });
  t.after(() => replace(previous));
  let reply;
  const ws = { _local: true, send: text => { reply = JSON.parse(text); } };
  const request = { op: 'copy', src: source, destDir: directory, name: '사본' };
  await handleFsOp(ws, request);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.newPath, path.join(directory, '사본'));
  const copied = path.join(reply.newPath, 'nested', '문서.txt');
  fs.writeFileSync(copied, 'keep');
  await handleFsOp(ws, request);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /이미 있습니다/);
  assert.equal(fs.readFileSync(copied, 'utf8'), 'keep');
});

test('탐색기 사전 확인 뒤 나타난 파일도 errorOnExist로 덮어쓰기를 거절한다', async (t) => {
  const { source, directory } = fixture(t);
  const previous = snapshot();
  initRuntimeState({ scheduleRecompute() {} });
  replace({ allowedRoots: [directory] });
  t.after(() => replace(previous));
  const destination = path.join(directory, '사본.txt');
  const original = fs.lstatSync;
  let inserted = false;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === destination && !inserted) {
      inserted = true;
      fs.writeFileSync(destination, 'concurrent');
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    }
    return original(file, ...args);
  });
  let reply;
  await handleFsOp({ _local: true, send: text => { reply = JSON.parse(text); } }, {
    op: 'copy', src: path.join(source, 'nested', '문서.txt'), destDir: directory, name: '사본.txt',
  });
  assert.equal(inserted, true);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /EEXIST/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent');
});
