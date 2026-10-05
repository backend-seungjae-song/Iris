import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { windowsPowerShellEnv } from '../server/windows-powershell.cjs';
import { createWinNative } from '../server/win-native.cjs';
import { createTailscaleSetup } from '../server/remote/tailscale-setup.js';

const require = createRequire(import.meta.url);
const contaminated = { SystemRoot: 'D:\\Windows', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'C:\\custom', KEEP: 'value' };
const expected = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';

test('Windows PowerShell 자식은 부모 모듈 경로만 교체하고 부모 환경을 보존한다', () => {
  const before = { ...contaminated };
  const env = windowsPowerShellEnv(contaminated);
  assert.equal(env.PSModulePath, expected);
  assert.equal(env.KEEP, 'value');
  assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === 'psmodulepath'), ['PSModulePath']);
  assert.deepEqual(contaminated, before);
  assert.equal(windowsPowerShellEnv({ systemroot: 'E:\\OS' }).PSModulePath, 'E:\\OS\\System32\\WindowsPowerShell\\v1.0\\Modules');
});

test('동기·비동기 ACL 호출은 PowerShell 7 모듈 경로를 상속하지 않는다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ps-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../server/remote/windows-private.cjs', import.meta.url), 'utf8'), {
    module, Buffer, process: { platform: 'win32', env: contaminated },
    require(name) {
      if (name === 'node:child_process') return {
        execFileSync: (...args) => calls.push(args),
        execFile: (...args) => { calls.push(args.slice(0, 3)); args.at(-1)(null); },
      };
      if (name === '../windows-powershell.cjs') return { windowsPowerShellEnv: () => windowsPowerShellEnv(contaminated) };
      return require(name);
    },
  });
  module.exports.privatePath(dir);
  await module.exports.privatePathAsync(dir);
  assert.equal(calls.length, 2);
  for (const [file, , options] of calls) {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.env.PSModulePath, expected);
    assert.equal(options.env.IRIS_PRIVATE_PATH, dir);
  }
});

test('네이티브 도우미도 Windows PowerShell 기본 모듈 경로를 받는다', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  let env;
  const client = createWinNative({ platform: 'win32', spawnImpl: (_file, _args, options) => { env = options.env; return child; } });
  const result = client.request({ op: 'windows' });
  client.stop(); await result;
  assert.deepEqual(env, windowsPowerShellEnv());
});

test('Windows 서비스 시작은 관리자 PowerShell 안에서도 모듈 경로를 지정한다', async () => {
  let calls = 0;
  const setup = createTailscaleSetup({ platform: 'win32', findExecutable: async () => 'C:\\Tailscale\\tailscale.exe',
    execFile: async (file, args, options) => {
      calls++;
      assert.equal(file, 'powershell.exe');
      assert.deepEqual(options.env, windowsPowerShellEnv());
      const outer = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const encoded = outer.match(/'-EncodedCommand','([^']+)'/)[1];
      const inner = Buffer.from(encoded, 'base64').toString('utf16le');
      assert.match(inner, /\$env:PSModulePath=\[IO.Path\]::Combine\(\$PSHOME,'Modules'\)/);
      assert.match(inner, /Start-Service -Name Tailscale/);
      return { stdout: '' };
    },
  });
  assert.deepEqual(await setup.start(), { ok: true });
  assert.equal(calls, 1);
});

test('PowerShell 7 환경에서 ACL 생성·재사용과 CIM 조회를 실행한다', { skip: process.platform !== 'win32', timeout: 60000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ps7-acl-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const probe = path.join(dir, 'probe.cjs');
  const helper = require.resolve('../server/remote/windows-private.cjs');
  const environment = require.resolve('../server/windows-powershell.cjs');
  fs.writeFileSync(probe, `
    const { privatePath, privatePathAsync } = require(${JSON.stringify(helper)});
    const { windowsPowerShellEnv } = require(${JSON.stringify(environment)});
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const folder = ${JSON.stringify(dir)};
    const file = require('node:path').join(folder, "private's file");
    fs.writeFileSync(file, 'private');
    (async () => {
      privatePath(folder); privatePath(file); await privatePathAsync(file);
      const command = '$ErrorActionPreference="Stop"; $a=[IO.File]::GetAccessControl($env:IRIS_TEST_ACL); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(!$a.AreAccessRulesProtected){throw "inheritance"}; foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw "other user"}}; if(!(Get-CimInstance Win32_Process -Filter "ProcessId=' + process.pid + '")){throw "process missing"}';
      execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {env:{...windowsPowerShellEnv(),IRIS_TEST_ACL:file}});
    })().catch(e => {console.error(e); process.exitCode=1;});
  `);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  // pwsh → Node → Windows PowerShell 환경 상속
  const script = `$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); & ${quote(process.execPath)} ${quote(probe)}; exit $LASTEXITCODE`;
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 55000, windowsHide: true, stdio: 'pipe' });
});
