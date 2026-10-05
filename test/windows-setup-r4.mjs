import assert from 'node:assert/strict';
import { execFileSync as executeFileSync } from 'node:child_process';
import fs from 'node:fs';
import { copyTreeSync } from '../server/copy-tree.cjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import nativeTest from 'node:test';
import { devCommand } from '../scripts/run-dev.mjs';
import { buildReport } from '../bin/mcp/report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const traceDirectory = process.env.IRIS_WINDOWS_TEST_TRACE_DIR;
let activeTest;
let childSequence = 0;
function trace(event, details = {}) {
  if (process.platform !== 'win32' && !traceDirectory) return;
  const record = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, test: activeTest, event, ...details }) + '\n';
  if (traceDirectory) {
    fs.mkdirSync(traceDirectory, { recursive: true });
    fs.appendFileSync(path.join(traceDirectory, `setup-r4-${process.pid}.jsonl`), record);
  }
  fs.writeSync(2, record);
}
function test(name, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return nativeTest(name, options, (t) => {
    activeTest = name;
    trace('test:start', { node: process.version, executable: process.execPath });
    try {
      const result = callback(t);
      trace('test:return');
      return result;
    } catch (error) {
      trace('test:throw', { message: error.message, stack: error.stack });
      throw error;
    } finally {
      t.after(() => trace('test:cleanup'));
    }
  });
}
function execFileSync(command, args, options) {
  const call = ++childSequence;
  trace('child:start', { call, command, args, timeout: options?.timeout, inputBytes: Buffer.byteLength(options?.input || '') });
  try {
    const result = executeFileSync(command, args, options);
    trace('child:return', { call, status: 0 });
    return result;
  } catch (error) {
    trace('child:throw', { call, status: error.status, signal: error.signal, code: error.code,
      stdout: String(error.stdout || ''), stderr: String(error.stderr || '') });
    throw error;
  }
}
function copyFileSync(source, destination) {
  trace('copyFile:start', { source, destination });
  fs.copyFileSync(source, destination);
  trace('copyFile:return', { source, destination });
}
function scratch(t) {
  const parent = path.join(root, '.working', 'windows-r4', 'setup-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => {
    trace('scratch:cleanup:start', { directory: dir });
    fs.rmSync(dir, { recursive: true });
    trace('scratch:cleanup:return', { directory: dir });
  });
  return dir;
}
function windowsInstaller() {
  const file = path.join(root, 'scripts', 'install-agent-context.mjs');
  const body = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../scripts/install-agent-context.mjs', import.meta.url).href));
  return vm.runInNewContext(body + '\ninstallAgentContext', { fs, os, path, parseArgs, fileURLToPath, Buffer,
    process: { platform: 'win32', env: {}, argv: [] } }, { filename: file });
}
function windowsFixture(t) {
  const home = scratch(t);
  const app = path.join(home, "App with spaces O'Brien $() &", 'Iris.exe');
  const unpacked = path.join(path.dirname(app), 'resources', 'app.asar.unpacked');
  const required = ['bin/agent-context.mjs','bin/iris-session.mjs','bin/agent-run.mjs','server/agent-lineage.js','server/agent-session-path.js','server/codex-session.js','server/env.cjs','server/herdr-session.cjs','server/herdr.js','server/prompt-targets.js','server/state-home.cjs'];
  for (const rel of required) { const file = path.join(unpacked, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  fs.writeFileSync(path.join(unpacked, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(app, '', { mode: 0o755 });
  const codexHome = path.join(home, 'codex'); const claudeHome = path.join(home, 'claude');
  for (const [agent, file] of [[codexHome,'hooks.json'],[claudeHome,'settings.json']]) {
    fs.mkdirSync(agent); fs.writeFileSync(path.join(agent,file), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'personal' }] }] } }));
  }
  return { home, app, unpacked, codexHome, claudeHome };
}

test('개발 명령은 서버·앱·seed에서 같은 전용 상태 폴더를 쓰고 앱은 Node 모드를 제거한다', () => {
  for (const mode of ['server','app','seed']) {
    const result = devCommand(mode, { platform:'win32', home: '/temporary/profile', electronPath: 'C:\\Program Files\\Electron\\electron.exe', env: { ELECTRON_RUN_AS_NODE: '1', IRIS_PORT: '4271', IRIS_STATE_DIR: '/installed' } });
    assert.equal(result.env.IRIS_PORT, '4291');
    assert.equal(result.env.IRIS_STATE_DIR, path.join('/temporary/profile', '.iris-dev'));
    assert.equal(result.command, mode === 'app' ? 'C:\\Program Files\\Electron\\electron.exe' : process.execPath);
    if (mode === 'app') assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
    if (mode === 'server') assert.equal(result.env.PORT, '4291');
  }
  assert.throws(() => devCommand('typo'), /모르는/);
});

test('macOS 개발 앱의 Node 모드와 seed의 기존 포트 환경은 유지한다', () => {
  const source = { ELECTRON_RUN_AS_NODE:'1',IRIS_PORT:'4271' };
  const app = devCommand('app',{platform:'darwin',env:source,home:'/temporary/profile',electronPath:'/Electron'});
  assert.equal(app.env.ELECTRON_RUN_AS_NODE,'1'); assert.equal(app.env.IRIS_PORT,'4291');
  const seed = devCommand('seed',{platform:'darwin',env:source,home:'/temporary/profile'});
  assert.equal(seed.env.IRIS_PORT,'4271');
  assert.equal(devCommand('seed',{platform:'darwin',env:{},home:'/temporary/profile'}).env.IRIS_PORT,undefined);
});

test('Windows agent 설치는 exe 경로·PowerShell 경로 인용·관리 훅 재실행을 처리한다', (t) => {
  const f = windowsFixture(t); const install = windowsInstaller();
  const result = install({ appPath: f.app, codexHome: f.codexHome, claudeHome: f.claudeHome, addHooks: true });
  assert.equal(result.changed.length, 2);
  for (const [agent,file] of [[f.codexHome,'hooks.json'],[f.claudeHome,'settings.json']]) {
    const config = JSON.parse(fs.readFileSync(path.join(agent,file), 'utf8'));
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'personal');
    const command = config.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /^powershell.exe .* -EncodedCommand [\w+/=]+$/);
    const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes("O''Brien $() &"));
    assert.match(script, /^\$env:PSModulePath=\[IO.Path\]::Combine\(\$PSHOME,'Modules'\);/);
    assert.match(script, /Remove-Item Env:IRIS_STATE_DIR,Env:IRIS_PORT/);
    assert.match(script, /IRIS_AGENT_CONTEXT_PROMPT_TARGETS='1'/);
    assert.match(script, /exit \$LASTEXITCODE/);
    const skill = fs.readFileSync(path.join(agent,'skills','iris-agent-context','SKILL.md'), 'utf8');
    assert.match(skill, /```powershell/); assert.match(skill, /Ctrl\+Shift\+W/);
  }
  const again = install({ appPath: f.app, codexHome: f.codexHome, claudeHome: f.claudeHome, addHooks: true });
  assert.equal(again.changed.length, 0); assert.equal(again.hookChanged.length, 0);
  const checked = install({ appPath: f.app, codexHome: f.codexHome, claudeHome: f.claudeHome, check: true });
  assert.equal(checked.hookMissing.length, 0);
});

test('Windows agent 훅은 stdin·환경·인자·종료 코드를 실제 PowerShell에 전달한다', { skip: process.platform !== 'win32' }, (t) => {
  const f = windowsFixture(t); copyFileSync(process.execPath, f.app);
  fs.writeFileSync(path.join(f.unpacked,'bin','agent-context.mjs'), `process.stdin.setEncoding('utf8'); let text=''; process.stdin.on('data',x=>text+=x); process.stdin.on('end',()=>{console.log(JSON.stringify({text,args:process.argv.slice(2),runtime:process.env.IRIS_AGENT_CONTEXT_RUNTIME,marker:process.env.IRIS_AGENT_CONTEXT_PROMPT_TARGETS,state:process.env.IRIS_STATE_DIR,port:process.env.IRIS_PORT})); process.exitCode=17;});`);
  windowsInstaller()({ appPath: f.app, codexHome: f.codexHome, claudeHome: f.claudeHome, addHooks: true });
  const command = JSON.parse(fs.readFileSync(path.join(f.codexHome,'hooks.json'),'utf8')).hooks.SessionStart[0].hooks[0].command;
  let failure;
  try { execFileSync('powershell.exe', command.split(' ').slice(1), { input:'hook input', encoding:'utf8', env: {...process.env, IRIS_STATE_DIR: 'installed', IRIS_PORT: '4291'}, timeout:10000 }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status,17);
  assert.deepEqual(JSON.parse(failure.stdout.trim()), {text:'hook input',args:['prompt-targets','--runtime','codex'],runtime:'codex',marker:'1'});
});

test('Windows setup는 공개 옵션을 받고 잘못된 옵션에서 설치 전에 실패한다', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(root,'scripts','setup-win.ps1');
  assert.match(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'--help'],{encoding:'utf8'}), /setup.cmd/);
  assert.throws(()=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'--unknown'],{stdio:'pipe'}));
});

test('Windows setup --yes는 빌드·사용자 설치·agent 연결·실행 순서를 완료한다', { skip: process.platform !== 'win32' }, (t) => {
  const home = scratch(t); const repo = path.join(home,"checkout O'Brien ! & [1] $; 한글");
  const local = path.join(home,"local O'Brien ! & [1] $; 한글"); const app = path.join(local,'Programs','Iris','Iris.exe');
  fs.mkdirSync(path.join(repo,'scripts'),{recursive:true}); fs.mkdirSync(path.join(repo,'dist'),{recursive:true});
  copyFileSync(path.join(root,'scripts','setup-win.ps1'),path.join(repo,'scripts','setup-win.ps1'));
  fs.writeFileSync(path.join(repo,'dist','Iris Setup 0.1.0.exe'),'installer fixture');
  fs.mkdirSync(path.join(repo,'server'));
  for (const rel of ['server/windows-state-lock.cjs','server/windows-powershell.cjs','scripts/windows-update-backup.cjs']) copyFileSync(path.join(root,rel),path.join(repo,rel));
  fs.writeFileSync(path.join(repo,'server','state-home.cjs'), `exports.stateHome = () => ${JSON.stringify(path.join(home,'state'))};`);
  fs.mkdirSync(path.dirname(app),{recursive:true}); copyFileSync(process.execPath,app);
  const herdr = path.join(path.dirname(app),'resources','herdr','herdr.exe');
  fs.mkdirSync(path.dirname(herdr),{recursive:true}); copyFileSync(process.execPath,herdr);
  trace('copyTree:start');
  copyTreeSync(path.dirname(app), path.join(repo,'dist','win-unpacked'), { recursive: true });
  trace('copyTree:return');
  const log = path.join(home,'steps.jsonl'); const q = (s) => `'${s.replaceAll("'","''")}'`;
  const wrapper = path.join(home,'fixture.ps1');
  fs.writeFileSync(wrapper, `\uFEFF
$env:LOCALAPPDATA=${q(local)}
$global:stepsFile=${q(log)}
$global:realNode=${q(process.execPath)}
function Record($kind,$values) { Add-Content -LiteralPath $global:stepsFile -Encoding UTF8 -Value (ConvertTo-Json -Compress -InputObject @{kind=$kind;values=@($values)}) }
function git { $global:LASTEXITCODE=0 }
function node { if ($args[0] -in '--version','-p','-e' -or $args[0] -match 'windows-(state-lock|update-backup)\\.cjs$') { if ($args[0] -match 'update-backup') { $input | & $global:realNode @args } else { & $global:realNode @args }; return }; Record 'node' $args; $global:LASTEXITCODE=0 }
function winget { throw 'Existing Node 22+ must not invoke winget' }
function pnpm { if ($args[0] -eq '-v') { '9.12.2' } else { Record 'pnpm' $args }; $global:LASTEXITCODE=0 }
function codex { if ($args[1] -in 'get','list') { $global:LASTEXITCODE=1 } else {Record 'codex' $args; $global:LASTEXITCODE=0} }
function claude { if ($args[1] -in 'get','list') { $global:LASTEXITCODE=1 } else {Record 'claude' $args; $global:LASTEXITCODE=0} }
function Get-Process { @() }
function Get-CimInstance { if ($global:appStarted) { [pscustomobject]@{ExecutablePath=${q(app)};CommandLine=${q(app)};ProcessId=123;Name='Iris.exe'} } }
function Start-Process { param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru) if ($FilePath -eq ${q(app)}) {$global:appStarted=$true}; Record 'start' @($FilePath,$ArgumentList); if ($PassThru) { [pscustomobject]@{ExitCode=0} } }
function Invoke-RestMethod { @{ok=$true} }
& ${q(path.join(repo,'scripts','setup-win.ps1'))} --yes
`, 'utf8');
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',wrapper],{encoding:'utf8',timeout:30000});
  const steps = fs.readFileSync(log,'utf8').trim().split(/\r?\n/).map((line)=>JSON.parse(line.replace(/^\uFEFF/,'')));
  const kinds = steps.map((v)=>v.kind);
  assert.deepEqual(kinds,['pnpm','pnpm','start','node','claude','codex','node']);
  assert.deepEqual(steps[0].values,['install','--frozen-lockfile']);
  assert.deepEqual(steps[1].values,['dist:win']);
  assert.ok(steps.at(-1).values.includes('--hooks'));
  assert.equal(steps[2].values[0],app);
  assert.match(steps[3].values[0],/wait-installed-server\.cjs$/);
});

test('Windows MCP 보고서는 PNG 크기를 줄이고 원본·투명도를 보존한다', { skip: process.platform !== 'win32' }, (t) => {
  const dir = scratch(t); const source = path.join(dir,'wide.png');
  const quoted = source.replaceAll("'","''");
  execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap(3200,1600); try {$b.SetPixel(0,0,[System.Drawing.Color]::FromArgb(0,0,0,0)); $b.Save('${quoted}',[System.Drawing.Imaging.ImageFormat]::Png)} finally {$b.Dispose()}`]);
  const before = fs.readFileSync(source);
  const oldState = process.env.IRIS_STATE_DIR; process.env.IRIS_STATE_DIR = path.join(dir,'state');
  t.after(()=>{ if(oldState === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR=oldState; });
  trace('report:start');
  const result = buildReport({runId:'windows-png',kind:'handoff',title:'PNG',steps:[{name:'장면',after:source}],out:path.join(dir,'report.html')});
  trace('report:return');
  const html=fs.readFileSync(result.path,'utf8');
  const embedded=Buffer.from(html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)[1],'base64');
  assert.equal(embedded.readUInt32BE(16),1600); assert.equal(embedded.readUInt32BE(20),800);
  assert.deepEqual(fs.readFileSync(source),before);
  const resized = path.join(dir,'embedded.png'); fs.writeFileSync(resized,embedded);
  const alpha = execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.Drawing; $b=[System.Drawing.Bitmap]::FromFile('${resized.replaceAll("'","''")}'); try {$b.GetPixel(0,0).A} finally {$b.Dispose()}`],{encoding:'utf8'});
  assert.equal(Number(alpha.trim()),0);
});
