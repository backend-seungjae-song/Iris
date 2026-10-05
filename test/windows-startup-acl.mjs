import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const helperFile = new URL('../server/remote/windows-private.cjs', import.meta.url);
const registryFile = new URL('../server/remote/registry.js', import.meta.url);
const helperRequire = createRequire(helperFile);

function fixture(t, { platform = 'win32', fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-startup-acl-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const calls = [], responsive = [];
  const childSource = `setTimeout(() => process.exit(${fail ? 1 : 0}), 100)`;
  function begin(file, args, options) {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.timeout, 15000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.IRIS_PRIVATE_PATH, path.join(dir, 'remote'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/);
    assert.match(script, /ReparsePoint/);
    calls.push(script);
    const probe = { completed: false, answered: false };
    setTimeout(() => { if (!probe.completed) probe.answered = true; }, 20);
    return () => { probe.completed = true; responsive.push(probe.answered); };
  }
  const childProcess = {
    execFile(file, args, options, callback) {
      const finish = begin(file, args, options);
      return execFile(process.execPath, ['-e', childSource], { timeout: 5000 }, (error) => {
        finish(); callback(error);
      });
    },
    execFileSync(file, args, options) {
      const finish = begin(file, args, options);
      try { return execFileSync(process.execPath, ['-e', childSource], { timeout: 5000 }); }
      finally { finish(); }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(helperFile, 'utf8'), {
    module, Buffer, process: { platform, env: {} },
    require(name) {
      if (name === 'node:child_process') return childProcess;
      if (name === 'node:fs') return fs;
      if (name === '../windows-powershell.cjs') return helperRequire(name);
      throw new Error(name);
    },
  }, { filename: helperFile.pathname });
  const source = fs.readFileSync(registryFile, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const createRegistry = vm.runInNewContext(source + '\ncreateRegistry', {
    ...module.exports, createPublicKey, fs, fsp, path, structuredClone, Buffer,
    stateHome: () => dir, process: { platform, pid: process.pid },
  }, { filename: registryFile.pathname });
  return { dir, createRegistry, calls, responsive, helper: module.exports };
}

test('Windows 재시작의 저장된 registry ACL 적용 중에도 이벤트 루프가 응답한다', async (t) => {
  const f = fixture(t);
  assert.equal((await f.createRegistry().initialize()).ok, true);
  f.calls.length = 0; f.responsive.length = 0;
  const restored = f.createRegistry();
  const result = await restored.initialize();
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.responsive, [true], '저장된 상태의 ACL 적용 중 타이머 응답');
  assert.equal(restored.snapshot().enabled, false);
});

test('Windows ACL 실패는 상태 생성을 중단한다', async (t) => {
  const f = fixture(t, { fail: true });
  const result = await f.createRegistry().initialize();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'registry-invalid');
  assert.equal(fs.existsSync(path.join(f.dir, 'remote', 'registry.json')), false);
});

test('Windows 동기 종료 저장도 같은 ACL을 적용한다', async (t) => {
  const f = fixture(t);
  const registry = f.createRegistry();
  assert.equal((await registry.initialize()).ok, true);
  f.calls.length = 0;
  assert.equal(registry.markCleanShutdownSync(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'remote', 'clean-shutdown'), 'utf8'), 'clean\n');
});

test('macOS registry 초기화·종료는 PowerShell을 호출하지 않는다', async (t) => {
  const f = fixture(t, { platform: 'darwin' });
  // Windows 호스트의 디렉터리 fsync 제한
  const syncs = [];
  const registry = f.createRegistry({ io: {
    fsyncDir: async (directory) => { syncs.push(directory); },
    fsyncDirSync: (directory) => { syncs.push(directory); },
  } });
  assert.equal((await registry.initialize()).ok, true);
  assert.equal(registry.markCleanShutdownSync(), true);
  assert.deepEqual(syncs, [path.join(f.dir, 'remote'), path.join(f.dir, 'remote')]);
  await f.helper.privatePathAsync(path.join(f.dir, 'remote'));
  f.helper.privatePath(path.join(f.dir, 'remote'));
  assert.deepEqual(f.calls, []);
});

test('Windows 비동기 ACL도 심볼릭 링크를 거부한다', async (t) => {
  const f = fixture(t);
  const link = path.join(f.dir, 'link');
  fs.symlinkSync(f.dir, link, 'junction');
  await assert.rejects(f.helper.privatePathAsync(link), /symlink rejected/);
  assert.deepEqual(f.calls, []);
});
