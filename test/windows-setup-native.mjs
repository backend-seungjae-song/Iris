import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'scripts/setup-win.ps1'), 'utf8').replace(/\r\n/g, '\n');
const q = (value) => `'${value.replaceAll("'", "''")}'`;
function functionSource(name, body = source) {
  const start = body.indexOf(`function ${name}`);
  assert.notEqual(start, -1, name);
  const end = body.indexOf('\n}', start);
  assert.notEqual(end, -1, name);
  return body.slice(start, end + 2);
}
function versionContract(body) {
  const ready = functionSource('Node-Ready', body);
  assert.match(ready, /& node --version\b/);
  assert.doesNotMatch(ready, /& node -(?:p|e)\b/);
  assert.match(ready, /\$LASTEXITCODE -ne 0/);
  assert.match(ready, /\[int\]\$Matches\[1\] -ge 22/);
}
function scratch(t) {
  const parent = path.join(root, '.working/windows-r5/setup-native-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/windows-update-backup.cjs'), path.join(dir, 'scripts/windows-update-backup.cjs'));
  return dir;
}
function runPowerShell(t, shell, body) {
  const file = path.join(scratch(t), 'probe.ps1');
  fs.writeFileSync(file, '\uFEFF' + body, 'utf8');
  return execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}

test('Node 준비 검사는 네이티브 따옴표 전달과 무관한 버전 명령을 사용한다', () => {
  versionContract(source);
  assert.match(execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim(), /^v\d+\.\d+\.\d+/);
  const broken = source.replace(/& node --version/, '& node -p \'process.versions.node.split(".")[0]\'');
  assert.throws(() => versionContract(broken), /--version/);
  assert.throws(() => versionContract(source.replace('if ($LASTEXITCODE -ne 0) { return $false }', '')), /LASTEXITCODE/);
});

test('Windows setup는 UTF8 BOM·리터럴 경로·cmd 지연 확장 차단을 유지한다', () => {
  for (const file of ['scripts/setup-win.ps1', 'scripts/windows-install-guard.ps1', 'server/win-native-helper.ps1', 'server/remote/windows-frame.ps1', 'bin/mcp/report-resize.ps1', 'test/windows-native-fixture.ps1']) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (/[^\x00-\x7f]/.test(bytes.toString('utf8').replace(/^\uFEFF/, ''))) {
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
    }
  }
  for (const file of ['scripts/setup-win.ps1', 'scripts/windows-install-guard.ps1']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/, file);
    assert.match(text, /\$OutputEncoding = \[Console\]::OutputEncoding/, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'setup.cmd'), 'utf8'), /[^\x00-\x7f]/);
  assert.match(source, /Resolve-Path -LiteralPath/);
  assert.match(fs.readFileSync(path.join(root, 'setup.cmd'), 'utf8'), /setlocal DisableDelayedExpansion/i);
});

test('Windows CI herdr 탐침은 성공 응답만 통과시키고 오류·비정상 응답·시간 초과를 거부한다', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows.yml'), 'utf8').replace(/\r\n/g, '\n');
  const probe = workflow.match(/const net = require\("net"\)[\s\S]+?(?=\n\s*'@)/)?.[0];
  assert.ok(probe);
  for (const [event, payload, expected] of [
    ['data', '{"id":"1","result":{"workspaces":[]}}\n', 0],
    ['data', '{"workspaces":[]}\n', 0],
    ['data', '{"id":"1","error":{"message":"denied"}}\n', 1],
    ['data', '{"result":{}}\n', 1],
    ['data', 'invalid\n', 1],
    ['error', new Error('connection failed'), 1],
    ['timeout', null, 1],
  ]) {
    const socket = new EventEmitter(); socket.write = () => {};
    const exits = []; let connected; let timeout;
    vm.runInNewContext(probe, {
      require(name) {
        if (name === 'net') return { connect(_address, callback) { connected = callback; return socket; } };
        if (name === 'path') return path;
        return { herdrSession: () => ({ socket: 'fixture' }), herdrEndpoint: () => 'fixture' };
      },
      process: { argv: ['node', 'probe.cjs', root], env: {}, exit: (code) => exits.push(code) },
      console: { log() {}, error() {} },
      setTimeout: (callback) => { timeout = callback; },
    });
    connected();
    if (event === 'timeout') timeout(); else socket.emit(event, payload);
    assert.deepEqual(exits, [expected], `${event}: ${payload}`);
  }
});

for (const [shell, mode] of [['powershell.exe', 'default'], ['pwsh.exe', 'default'], ['pwsh.exe', 'Legacy']]) {
  test(`${shell} ${mode}: 실제 Node 22 이상은 winget 설치 분기를 건너뛴다`, { skip: process.platform !== 'win32' }, (t) => {
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
${mode === 'Legacy' ? "$PSNativeCommandArgumentPassing = 'Legacy'" : ''}
function Find-Tool([string]$name) { Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
${functionSource('Node-Ready')}
function Install-Winget { throw 'unexpected winget install' }
$check = $false
if (!(Node-Ready) -and !$check) { Install-Winget 'OpenJS.NodeJS.LTS' }
if (!(Node-Ready)) { throw 'Node 22+ rejected' }
`);
  });

  test(`${shell} ${mode}: 오래된 Node·비정상 출력·실패 종료 코드는 준비 실패로 판정한다`, { skip: process.platform !== 'win32' }, (t) => {
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
function Find-Tool { [pscustomobject]@{ CommandType = 'Function' } }
${functionSource('Invoke-Tool')}
${functionSource('Node-Ready')}
${functionSource('Pnpm-Ready')}
function node { $global:LASTEXITCODE = $global:versionExit; $global:versionText }
function pnpm { $global:LASTEXITCODE = $global:versionExit; $global:versionText }
foreach ($case in @(@{text='v21.9.0';code=0},@{text='invalid';code=0},@{text='v22.1.0';code=1},@{text='v22.1.0 warning';code=0})) {
  $global:versionText=$case.text; $global:versionExit=$case.code
  if (Node-Ready) { throw "accepted invalid Node: $($case.text) $($case.code)" }
}
foreach ($text in @('v22.0.0','v24.0.0','v22.1.0-rc.1')) {
  $global:versionText=$text; $global:versionExit=0
  if (!(Node-Ready)) { throw "rejected Node: $text" }
}
$global:versionText='9.12.2'; $global:versionExit=1
if (Pnpm-Ready) { throw 'accepted failed pnpm' }
$global:versionExit=0
if (!(Pnpm-Ready)) { throw 'rejected pnpm 9.12.2' }
`);
  });

  test(`${shell} ${mode}: cmd 인자는 특수문자·빈 문자열·실패 코드와 함께 보존된다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    const tools = path.join(dir, "tool&[1]!%TEMP%'한글");
    fs.mkdirSync(tools);
    const command = path.join(tools, 'record.cmd');
    const recorder = path.join(dir, 'record.cjs');
    const record = path.join(dir, 'args.json');
    fs.writeFileSync(recorder, `require('node:fs').writeFileSync(process.env.IRIS_ARG_RECORD, JSON.stringify(process.argv.slice(2))); process.stdout.write('한글'+'o'.repeat(131072)); process.stderr.write('e'.repeat(131072)); process.exitCode=17;`);
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\nexit /b %errorlevel%\r\n`);
    const args = ['', 'plain&name', 'space & name', "O'Brien", '%TEMP%', '!PATH!', '(x)[1]$;한글', 'C:\\folder\\file.mjs', 'C:\\trailing\\', 'C:\\space folder\\\\'];
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
${mode === 'Legacy' ? "$PSNativeCommandArgumentPassing = 'Legacy'" : ''}
$env:IRIS_ARG_RECORD=${q(record)}
function Find-Tool([string]$name) { Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
${functionSource('Invoke-Tool')}
${functionSource('Run-Tool')}
$result = Invoke-Tool ${q(command)} @(${args.map(q).join(',')}) -capture
if ($result.ExitCode -ne 17 -or $result.Output.Length -ne 262146 -or !$result.Output.StartsWith('한글')) { throw 'capture or exit code lost' }
$rejected = $false
try { Invoke-Tool ${q(command)} @('invalid"quote') -capture } catch { $rejected = $true }
if (!$rejected) { throw 'cmd quote accepted' }
`);
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), args);
  });
}

test('setup.cmd는 공백·한글·[]·!·&·괄호·작은따옴표 경로에서 도움말을 실행한다', { skip: process.platform !== 'win32' }, (t) => {
  const repo = path.join(scratch(t), "한글 Space O'Brien ! & (square)[1] $; 100%");
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'setup.cmd'), path.join(repo, 'setup.cmd'));
  fs.copyFileSync(path.join(root, 'scripts/setup-win.ps1'), path.join(repo, 'scripts/setup-win.ps1'));
  for (const [mode, command] of [['/v:on', 'setup.cmd --help'], ['/v:off', `""${path.join(repo, 'setup.cmd')}" --help"`]]) {
    const output = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', mode, '/s', '/c', command], {
      cwd: repo, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 30000,
    });
    assert.match(output, /사용: setup.cmd \[--yes\] \[--check\]/);
  }
});

function updateContract(body) {
  const guard = functionSource('Stop-InstalledApp', body);
  assert.match(guard, /Get-InstalledProcesses \$exe/);
  assert.match(guard, /Test-StateLockHeld \$stateLock/);
  assert.match(functionSource('Test-StateLockHeld', body), /server\\windows-state-lock\.cjs/);
  assert.match(guard, /\$remaining\.Count -eq 0 -and !\$locked/);
  assert.doesNotMatch(guard, /Stop-Process|Remove-Item/);
  const transaction = functionSource('Install-WindowsApp', body);
  const close = transaction.indexOf('Stop-InstalledApp $exe $stateLock');
  const staging = transaction.indexOf('Copy-Item -LiteralPath $unpacked');
  const backup = transaction.indexOf('Move-Item -LiteralPath $directory');
  const install = transaction.indexOf('Start-Process -FilePath $installerPath');
  const health = transaction.indexOf('scripts\\wait-installed-server.cjs', install);
  const cleanup = transaction.indexOf('scripts\\windows-update-backup.cjs');
  const snapshot = transaction.indexOf('$previousProcesses = @(Get-CimInstance');
  const publish = transaction.indexOf('Move-Item -LiteralPath $staged -Destination $directory');
  assert.ok(backup < snapshot && snapshot < publish);
  assert.ok(staging >= 0 && staging < close && close < backup && backup < install && install < health && health < cleanup);
  assert.match(transaction, /if \(\$staged\) \{\s+Move-Item -LiteralPath \$staged -Destination \$directory\s+\} else \{/);
  assert.match(transaction, /previousProcesses = @\(\$previousProcesses/);
  assert.match(transaction, /Move-Item -LiteralPath \$directory -Destination \$failed/);
  assert.match(transaction, /Move-Item -LiteralPath \$backup -Destination \$directory/);
  assert.match(transaction, /Assert-InstalledAppRunning \$exe/);
  assert.doesNotMatch(transaction, /Remove-Item[^\n]*-Force/);
}

test('Windows 교체는 종료·잠금 해제·백업·건강 확인 순서와 실패본 보존을 요구한다', () => {
  updateContract(source);
  assert.match(source, /require\('\.\/server\/state-home\.cjs'\)\.stateHome\(\)/);
  for (const broken of [
    source.replace('$remaining.Count -eq 0 -and !$locked', '$remaining.Count -eq 0'),
    source.replace('Move-Item -LiteralPath $directory -Destination $backup', 'Copy-Item -LiteralPath $directory -Destination $backup'),
    source.replace('Move-Item -LiteralPath $backup -Destination $directory', ''),
    source.replace('scripts\\windows-update-backup.cjs', 'missing-helper.cjs'),
    source.replace('Test-StateLockHeld $stateLock', 'Test-Path -LiteralPath $stateLock'),
    source.replace('if ($staged) {', 'if ($false) {'),
  ]) assert.throws(() => updateContract(broken));
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: 종료 검사는 renderer·서버·잠금을 기다리고 herdr·MCP·다른 앱을 유지한다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
${functionSource('Get-InstalledProcesses')}
${functionSource('Stop-InstalledApp')}
${functionSource('Test-StateLockHeld')}
${functionSource('Invoke-Tool')}
function Find-Tool([string]$name) { Get-Command $name }
$root = ${q(root)}
${functionSource('Assert-InstalledAppRunning')}
$exe = 'C:\\Fixture\\Iris\\Iris.exe'
$server = 'C:\\Fixture\\Iris\\resources\\app.asar.unpacked\\server\\index.js'
$global:snapshot = @(
  [pscustomobject]@{ProcessId=1;ParentProcessId=7;Name='Iris.exe';ExecutablePath=$exe;CommandLine=$exe},
  [pscustomobject]@{ProcessId=2;Name='Iris.exe';ExecutablePath=$exe;CommandLine=($exe+' --type=renderer')},
  [pscustomobject]@{ProcessId=3;ParentProcessId=1;Name='node.exe';ExecutablePath='C:\\Tools\\node.exe';CommandLine=('node '+$server)},
  [pscustomobject]@{ProcessId=4;Name='Iris.exe';ExecutablePath=$exe;CommandLine=($exe+' C:\\Fixture\\Iris\\resources\\app.asar.unpacked\\server\\remote\\channel\\iris-channel.mjs')},
  [pscustomobject]@{ProcessId=5;Name='herdr.exe';ExecutablePath='C:\\Fixture\\Iris\\resources\\herdr\\herdr.exe';CommandLine='herdr daemon'},
  [pscustomobject]@{ProcessId=6;Name='Iris.exe';ExecutablePath='C:\\Other\\Iris.exe';CommandLine='C:\\Other\\Iris.exe'},
  [pscustomobject]@{ProcessId=7;ParentProcessId=5;Name='powershell.exe';ExecutablePath='C:\\Windows\\powershell.exe';CommandLine='powershell'},
  [pscustomobject]@{ProcessId=8;Name='OpenConsole.exe';ExecutablePath='C:\\Fixture\\Iris\\resources\\herdr\\conpty\\OpenConsole.exe';CommandLine='conpty'},
  [pscustomobject]@{ProcessId=9;ParentProcessId=3;Name='powershell.exe';ExecutablePath='C:\\Windows\\powershell.exe';CommandLine='powershell -File C:\\Fixture\\Iris\\resources\\app.asar.unpacked\\server\\win-native-helper.ps1'},
  [pscustomobject]@{ProcessId=10;ParentProcessId=4;Name='powershell.exe';ExecutablePath='C:\\Windows\\powershell.exe';CommandLine='powershell -File C:\\Fixture\\Iris\\resources\\app.asar.unpacked\\server\\win-native-helper.ps1'},
  [pscustomobject]@{ProcessId=11;ParentProcessId=10;Name='node.exe';ExecutablePath='C:\\Tools\\node.exe';CommandLine='node C:\\Fixture\\Iris\\resources\\helper.js'}
)
function Get-CimInstance { $global:snapshot }
function Get-Process { $null }
$ids = @(Get-InstalledProcesses $exe).ProcessId -join ','
if ($ids -ne '1,2,3,9') { throw "wrong installed processes: $ids" }
Assert-InstalledAppRunning $exe
$global:snapshot = @($global:snapshot | Where-Object {$_.ProcessId -ne 1})
$rejected = $false
try { Assert-InstalledAppRunning $exe } catch { $rejected = $true }
if (!$rejected) { throw 'renderer or server accepted as main app' }
$lock = Join-Path ${q(dir)} 'server.lock'
Set-Content -LiteralPath $lock -Value '999999'
$rejected = $false
try { Stop-InstalledApp $exe $lock 0 } catch { $rejected = $true }
if (!$rejected -or !(Test-Path -LiteralPath $lock)) { throw 'active processes or lock accepted/removed' }
$global:snapshot = @($global:snapshot | Where-Object {$_.ProcessId -in 4,5,6,8})
Stop-InstalledApp $exe $lock 0
if (!(Test-Path -LiteralPath $lock)) { throw 'stale lock removed' }
Set-Content -LiteralPath $lock -Value 'invalid'
$rejected = $false
try { Stop-InstalledApp $exe $lock 0 } catch { $rejected = $true }
if (!$rejected) { throw 'unknown lock accepted' }
Remove-Item -LiteralPath $lock
$global:snapshot = @([pscustomobject]@{ProcessId=2;Name='Iris.exe';ExecutablePath=$exe;CommandLine=($exe+' --type=renderer')})
$rejected = $false
try { Stop-InstalledApp $exe $lock 0 } catch { $rejected = $true }
if (!$rejected) { throw 'renderer accepted without a lock' }
$global:snapshot = @()
Stop-InstalledApp $exe $lock 0
$global:snapshot = @([pscustomobject]@{ProcessId=7;Name='Iris.exe';ExecutablePath=$null;CommandLine=$null})
$rejected = $false
try { Stop-InstalledApp $exe $lock 0 } catch { $rejected = $true }
if (!$rejected) { throw 'unknown Iris process accepted' }
`);
  });

  test(`${shell}: 업데이트는 NSIS를 건너뛰고 터미널 파일·제거 등록·복구를 보존한다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
${functionSource('Install-WindowsApp')}
$root = ${q(dir)}
$base = ${q(dir)}
$unpacked = Join-Path $root 'dist\\win-unpacked'
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
Set-Content -LiteralPath (Join-Path $unpacked 'Iris.exe') -Value 'new'
function Stop-InstalledApp { $global:events += 'stop'; $global:stopped=$true }
function Get-CimInstance {
  if ($global:mode -eq 'late-mcp' -and !$global:stopped) { return }
  if ($global:runningCalls -gt 0 -and $global:mode -notin 'persistent','external-mcp','late-mcp') { return }
  if ($global:mode -in 'external-mcp','late-mcp') { [pscustomobject]@{ProcessId=123;CreationDate=[datetime]'2026-10-06T00:00:00Z';ExecutablePath='C:\\Tools\\node.exe';CommandLine=('node '+(Join-Path (Split-Path $global:exe) 'resources\\app.asar.unpacked\\bin\\iris-mcp.mjs'))} }
  else { [pscustomobject]@{ProcessId=123;CreationDate=[datetime]'2026-10-06T00:00:00Z';ExecutablePath=(Join-Path (Split-Path $global:exe) 'resources\\herdr\\herdr.exe')} }
}
function Get-Process { if ($global:mode -in 'persistent','external-mcp') { [pscustomobject]@{Id=123} } }
function Start-Process {
  param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru)
  if ($PassThru) {
    $global:events += 'installer'
    New-Item -ItemType Directory -Path (Split-Path $global:exe) -Force | Out-Null
    Set-Content -LiteralPath $global:exe -Value 'new'
    return [pscustomobject]@{ExitCode=$(if ($global:mode -eq 'fresh-fail') {17} else {0})}
  }
  $global:events += 'start'
}
function Run-Tool($command,$toolArgs) {
  if ($command -eq 'node') {
    $global:events += 'health'; $global:healthCalls++
    if ($global:mode -eq 'health-fail' -and $global:healthCalls -eq 1) { throw 'fixture unhealthy' }
  } else { $global:events += 'herdr' }
}
function Assert-InstalledAppRunning {
  $global:events += 'running'; $global:runningCalls++
  if ($global:mode -eq 'app-exit' -and $global:runningCalls -eq 1) { throw 'fixture app exited' }
}
foreach ($mode in @('success','persistent','external-mcp','late-mcp','health-fail','app-exit','fresh','fresh-fail')) {
  $global:mode=$mode; $global:events=@(); $global:healthCalls=0; $global:runningCalls=0; $global:stopped=$false
  $caseDir = Join-Path $base $mode
  $directory = Join-Path $caseDir 'Iris'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $global:exe = Join-Path $directory 'Iris.exe'
  if ($mode -notin 'fresh','fresh-fail') {
    Set-Content -LiteralPath $global:exe -Value 'old'
    Set-Content -LiteralPath (Join-Path $directory 'Uninstall Iris.exe') -Value 'uninstaller'
    New-Item -ItemType Directory -Path (Join-Path $directory 'resources\\herdr') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $directory 'resources\\herdr\\herdr.exe') -Value 'old-herdr'
  }
  $caught=$null
  try { Install-WindowsApp $global:exe 'fixture-installer.exe' (Join-Path $caseDir 'server.lock') } catch {$caught=$_.Exception.Message}
  $failed = @(Get-ChildItem -LiteralPath $caseDir -Directory -Filter 'Iris.failed-*')
  $backups = @(Get-ChildItem -LiteralPath $caseDir -Directory -Filter 'Iris.old-*')
  if ($mode -in 'success','persistent','external-mcp','late-mcp','fresh') {
    if ($caught -or (Get-Content -LiteralPath $global:exe) -ne 'new' -or $failed.Count) { throw "new app failed: $mode $caught" }
    if ($mode -eq 'fresh') {
      if (($global:events -join ',') -ne 'stop,installer,herdr,start,health,running') { throw 'fresh install skipped NSIS' }
    } else {
      if (($global:events -join ',') -ne 'stop,herdr,start,health,running') { throw 'update invoked NSIS' }
      if ((Get-Content -LiteralPath (Join-Path $directory 'Uninstall Iris.exe')) -ne 'uninstaller') { throw 'uninstaller lost' }
      if ($mode -in 'persistent','external-mcp','late-mcp') {
        if ($backups.Count -ne 1 -or (Get-Content -LiteralPath (Join-Path $backups[0].FullName 'resources\\herdr\\herdr.exe')) -ne 'old-herdr') { throw 'running runtime files deleted' }
        $marker = Get-Content -LiteralPath (Join-Path $backups[0].FullName '.iris-update-processes.json') -Raw | ConvertFrom-Json
        if ($marker.processes[0].CreationDate -ne ([datetime]'2026-10-06T00:00:00Z').ToUniversalTime().Ticks.ToString()) { throw 'process creation time encoding differs' }
      } elseif ($backups.Count) { throw 'idle backup retained' }
    }
  } else {
    if (!$caught -or $failed.Count -ne 1 -or (Get-Content -LiteralPath (Join-Path $failed[0].FullName 'Iris.exe')) -ne 'new') { throw "failed install not preserved: $mode $caught" }
    if ($mode -eq 'fresh-fail') {
      if (Test-Path -LiteralPath $global:exe) { throw 'failed fresh app retained' }
    } elseif ((Get-Content -LiteralPath $global:exe) -ne 'old' -or $backups.Count) { throw "previous app not restored: $mode" }
  }
}
`);
  });
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: 잠긴 이전 폴더는 덮어쓰거나 프로세스를 종료하지 않는다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    runPowerShell(t, shell, `
$ErrorActionPreference = 'Stop'
${functionSource('Install-WindowsApp')}
$root = ${q(dir)}
$unpacked = Join-Path $root 'dist\\win-unpacked'
$directory = Join-Path $root 'Iris'
New-Item -ItemType Directory -Path $unpacked,$directory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $unpacked 'Iris.exe') -Value 'new'
$exe = Join-Path $directory 'Iris.exe'
Set-Content -LiteralPath $exe -Value 'old'
$global:starts=0
function Get-CimInstance { @() }
function Stop-InstalledApp {}
function Move-Item { throw 'fixture locked directory' }
function Start-Process {
  param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru)
  if ($PassThru) { throw 'installer invoked during locked update' }
  $global:starts++
}
function Run-Tool {}
function Assert-InstalledAppRunning {}
$caught=$null
try { Install-WindowsApp $exe 'fixture-installer.exe' (Join-Path $root 'server.lock') } catch {$caught=$_.Exception.Message}
if (!$caught -or $global:starts -ne 1 -or (Get-Content -LiteralPath $exe) -ne 'old') { throw 'locked directory modified or original app not reopened' }
`);
  });
}

test('Windows NSIS는 기존 설치·프로세스를 종료하지 않고 setup 업데이트를 요구한다', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(config.build.nsis.include, 'scripts/windows-installer.nsh');
  const include = fs.readFileSync(path.join(root, config.build.nsis.include), 'utf8');
  assert.match(include, /!macro customCheckAppRunning/);
  assert.match(include, /windows-install-guard\.ps1/);
  assert.doesNotMatch(include, /KILL_PROCESS|CHECK_APP_RUNNING|taskkill|Stop-Process|uninstallOldVersion/);
  const guard = fs.readFileSync(path.join(root, 'scripts/windows-install-guard.ps1'), 'utf8');
  assert.match(guard, /Test-Path -LiteralPath.*Iris\.exe/);
  assert.match(guard, /Get-CimInstance Win32_Process/);
  assert.match(guard, /exit 2/);
  assert.doesNotMatch(guard, /Stop-Process|Remove-Item|CloseMainWindow/);
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: NSIS 준비 검사는 최초 설치·기존 설치·사용하지 않는 제거를 구분한다`, { skip: process.platform !== 'win32' }, (t) => {
    const directory = scratch(t);
    const guard = path.join(root, 'scripts', 'windows-install-guard.ps1');
    const args = ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guard,'-Directory',directory];
    execFileSync(shell, args, { encoding:'utf8', timeout:15000, windowsHide:true });
    fs.writeFileSync(path.join(directory, 'Iris.exe'), 'existing');
    assert.throws(() => execFileSync(shell, args, { encoding:'utf8', stdio:'pipe', timeout:15000, windowsHide:true }), error => {
      assert.equal(error.status, 2);
      assert.match(error.stderr, /setup.cmd로 업데이트하세요\./);
      assert.match(error.stderr, /기존 설치 폴더를 덮어쓰지 않습니다\./);
      t.diagnostic(`${shell}: setup.cmd로 업데이트하세요. 기존 설치 폴더를 덮어쓰지 않습니다.`);
      return true;
    });
    execFileSync(shell, [...args, '-Uninstall'], { encoding:'utf8', timeout:15000, windowsHide:true });
  });
}

function assertSetupOutput(result, expected, status) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr?.toString('utf8'));
  const output = new TextDecoder('utf-8', { fatal: true }).decode(status === 0 ? result.stdout : result.stderr);
  assert.ok(output.includes(expected), output);
}
function setupProcess(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'pipe', timeout: 15000, windowsHide: true, ...options });
}
const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

test('Windows setup 오류는 stderr 출력 후 종료 코드 2를 유지한다', () => {
  assert.match(source, /default \{ \[Console\]::Error\.WriteLine\("모르는 옵션: \$argument"\); exit 2 \}/);
  const guard = fs.readFileSync(path.join(root, 'scripts/windows-install-guard.ps1'), 'utf8');
  assert.match(guard, /catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 2 \}/);
});

test('setup.cmd는 도움말 0·모르는 옵션 2와 UTF-8 한국어를 전달한다', { skip: process.platform !== 'win32' }, () => {
  for (const [argument, expected, status] of [
    ['--help', '사용: setup.cmd [--yes] [--check]', 0],
    ['--unknown', '모르는 옵션: --unknown', 2],
  ]) {
    const command = `""${path.join(root, 'setup.cmd')}" ${argument}"`;
    assertSetupOutput(setupProcess(process.env.ComSpec, ['/d', '/v:off', '/s', '/c', command], {
      windowsVerbatimArguments: true,
    }), expected, status);
  }
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: setup 도움말·오류는 -File 호출과 ASCII 콘솔에서 종료 코드·UTF-8 한국어를 유지한다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'Iris.exe'), 'existing');
    for (const [file, args, expected, status] of [
      ['scripts/setup-win.ps1', ['--help'], '사용: setup.cmd [--yes] [--check]', 0],
      ['scripts/setup-win.ps1', ['--unknown'], '모르는 옵션: --unknown', 2],
      ['scripts/windows-install-guard.ps1', ['-Directory', dir], 'setup.cmd로 업데이트하세요.', 2],
    ]) {
      const original = path.join(root, file);
      assertSetupOutput(setupProcess(shell, [...shellArgs, original, ...args]), expected, status);
      const text = fs.readFileSync(original, 'utf8');
      // param 위치·-File 호출 보존
      const ascii = text.replace("$ErrorActionPreference = 'Stop'", `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::ASCII
$OutputEncoding = [Text.Encoding]::ASCII`);
      assert.notEqual(ascii, text);
      const fixture = path.join(dir, file);
      fs.writeFileSync(fixture, ascii);
      assertSetupOutput(setupProcess(shell, [...shellArgs, fixture, ...args]), expected, status);
      t.diagnostic(`${shell}: ${file} ${args[0]} → ${status}: ${expected}`);
      const broken = ascii
        .replace('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)', '')
        .replace('$OutputEncoding = [Console]::OutputEncoding', '');
      assert.notEqual(broken, ascii);
      fs.writeFileSync(fixture, broken);
      const result = setupProcess(shell, [...shellArgs, fixture, ...args]);
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, status, result.stderr?.toString('utf8'));
      const output = status === 0 ? result.stdout : result.stderr;
      assert.ok(!output.toString('utf8').includes(expected), '출력 인코딩 누락을 감지하지 못함');
    }
  });

  test(`${shell}: Stop 래퍼에서도 setup 오류가 종료 코드 2를 유지한다`, { skip: process.platform !== 'win32' }, (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'Iris.exe'), 'existing');
    for (const [file, args, expected, current, previous] of [
      ['scripts/setup-win.ps1', ['--unknown'], '모르는 옵션: --unknown',
        '[Console]::Error.WriteLine("모르는 옵션: $argument")', 'Write-Error "모르는 옵션: $argument"'],
      // 가드의 이전 Write-Error -ErrorAction Continue 경로도 2 유지(CI 실측), 결함 재현 대상 아님
      ['scripts/windows-install-guard.ps1', ['-Directory', dir], 'setup.cmd로 업데이트하세요.', null, null],
    ]) {
      const fixture = path.join(dir, file);
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      fs.writeFileSync(fixture, text);
      const wrapper = path.join(dir, 'stop.ps1');
      fs.writeFileSync(wrapper, '\uFEFF' + `$ErrorActionPreference = 'Stop'
& ${q(fixture)} ${args.map((arg) => /^-[A-Za-z]+$/.test(arg) ? arg : q(arg)).join(' ')}
exit $LASTEXITCODE
`);
      assertSetupOutput(setupProcess(shell, [...shellArgs, wrapper]), expected, 2);
      if (!previous) continue;
      const broken = text.replace(current, previous);
      assert.notEqual(broken, text);
      fs.writeFileSync(fixture, broken);
      // Write-Error 출력은 콘솔 폭에서 줄바꿈되어 문구 대조 제외, 종료 코드만 비교
      const old = setupProcess(shell, [...shellArgs, wrapper]);
      assert.ifError(old.error);
      assert.equal(old.status, 1, '이전 Write-Error 경로의 종료 코드 1을 감지하지 못함');
    }
  });
}
