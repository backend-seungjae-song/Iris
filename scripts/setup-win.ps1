$SetupArguments = @($args)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$check = $false; $yes = $false; $appOnly = $false
foreach ($argument in $SetupArguments) {
  switch ($argument.ToLowerInvariant()) {
    '--check' { $check = $true }
    '--yes' { $yes = $true }
    '-y' { $yes = $true }
    '--app-only' { $appOnly = $true }
    { $_ -in '--help','-h' } { Write-Host '사용: setup.cmd [--yes] [--check]'; exit 0 }
    default { [Console]::Error.WriteLine("모르는 옵션: $argument"); exit 2 }
  }
}
function Find-Tool([string]$name) { Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Confirm-Step([string]$message) {
  if ($yes) { return $true }
  if ([Console]::IsInputRedirected) { return $false }
  return (Read-Host "$message [y/N]") -match '^[yY]$'
}
function Refresh-Path {
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:PATH
}
function Invoke-Tool([string]$command, [string[]]$toolArgs, [switch]$capture) {
  $tool = Find-Tool $command
  if ($tool.CommandType -eq 'Application' -and $tool.Source -match '\.(cmd|bat)$') {
    # cmd 재해석 방지: 인용된 환경 변수로 경로·인자 전달
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $env:ComSpec
    $start.UseShellExecute = $false
    $start.EnvironmentVariables['IRIS_SETUP_BATCH_COMMAND'] = $tool.Source
    $parts = @('"%IRIS_SETUP_BATCH_COMMAND%"')
    for ($index = 0; $index -lt $toolArgs.Count; $index++) {
      if ($toolArgs[$index] -match '["\x00-\x1f]') { throw 'cmd 인자에 큰따옴표·제어 문자를 사용할 수 없습니다.' }
      if ($toolArgs[$index] -eq '') { $parts += '""'; continue }
      $name = "IRIS_SETUP_BATCH_ARG_$index"
      # Node shim의 닫는 인용부호 앞 역슬래시
      $start.EnvironmentVariables[$name] = $toolArgs[$index] -replace '(\\+)$', '$1$1'
      $parts += '"%' + $name + '%"'
    }
    $start.Arguments = '/d /v:off /s /c "' + ($parts -join ' ') + '"'
    $start.RedirectStandardOutput = [bool]$capture
    $start.RedirectStandardError = [bool]$capture
    if ($capture) {
      $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
      $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
      [void]$process.Start()
      if ($capture) {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
      }
      $process.WaitForExit()
      $output = ''
      if ($capture) { $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult() }
      return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output }
    } finally { $process.Dispose() }
  }
  if ($capture) {
    $previousPreference = $ErrorActionPreference
    $previousEncoding = [Console]::OutputEncoding
    $ErrorActionPreference = 'Continue'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    try { $output = & $command @toolArgs 2>&1 | Out-String; $exitCode = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference; [Console]::OutputEncoding = $previousEncoding }
  } else { & $command @toolArgs | Out-Host; $exitCode = $LASTEXITCODE; $output = '' }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}
function Run-Tool([string]$command, [string[]]$toolArgs) {
  Write-Host "  > $command $($toolArgs -join ' ')"
  $result = Invoke-Tool $command $toolArgs
  if ($result.ExitCode -ne 0) { throw "$command 실패: 종료 코드 $($result.ExitCode)" }
}
function Node-Ready {
  if (!(Find-Tool node)) { return $false }
  try {
    $version = & node --version
    if ($LASTEXITCODE -ne 0) { return $false }
    return ([string]$version).Trim() -match '^v(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' -and [int]$Matches[1] -ge 22
  } catch { return $false }
}
function Pnpm-Ready {
  if (!(Find-Tool pnpm)) { return $false }
  try {
    $result = Invoke-Tool pnpm @('-v') -capture
    if ($result.ExitCode -ne 0) { return $false }
    return [version]($result.Output.Trim()) -ge [version]'9.2.0'
  } catch { return $false }
}
function Install-Winget([string]$id) {
  if (!(Find-Tool winget)) { Write-Warning 'winget가 없습니다. 필요한 도구를 설치한 뒤 다시 실행하세요.'; return }
  if (Confirm-Step "winget로 $id 설치를 진행할까요?") {
    Run-Tool winget @('install','--id',$id,'--exact','--accept-source-agreements','--accept-package-agreements')
    Refresh-Path
  }
}
function Agent-Mcp([string]$runtime) {
  if (!(Find-Tool $runtime)) { Write-Host "  INFO $runtime CLI 없음 (선택 도구)"; return $true }
  $result = Invoke-Tool $runtime @('mcp','get','iris-mcp') -capture
  $out = $result.Output; $getCode = $result.ExitCode
  $found = $getCode -eq 0 -and $out -match '(?m)^iris-mcp\s*:?(\r?\n|$)'
  if ($found -and $out -notmatch 'iris-mcp\.mjs') { Write-Warning "$runtime의 iris-mcp 이름을 다른 서버가 사용합니다. 기존 설정을 보존합니다."; return $false }
  if ($found -and $out -match [regex]::Escape($mcpPath)) { Write-Host "  OK $runtime Iris MCP"; return $true }
  if (!$found) {
    $list = (Invoke-Tool $runtime @('mcp','list') -capture).Output
    if ($list -match [regex]::Escape($mcpPath)) { Write-Host "  OK $runtime Iris MCP (등록된 이름 유지)"; return $true }
  }
  if ($check) { Write-Warning "$runtime Iris MCP 등록이 없거나 현재 checkout과 다릅니다."; return $false }
  if (!(Confirm-Step "$runtime 사용자 설정에 Iris MCP를 등록할까요?")) { Write-Host "  INFO $runtime MCP 등록을 건너뜁니다."; return $true }
  # Iris MCP 항목만 갱신
  if ($found) { Run-Tool $runtime @('mcp','remove','iris-mcp') }
  if ($runtime -eq 'claude') { Run-Tool $runtime @('mcp','add','--scope','user','iris-mcp','--','node',$mcpPath) }
  else { Run-Tool $runtime @('mcp','add','iris-mcp','--','node',$mcpPath) }
  return $true
}
function Get-InstalledProcesses([string]$exe) {
  $directory = (Split-Path $exe).TrimEnd('\\') + '\'
  $herdrDirectory = (Join-Path $directory 'resources\herdr') + '\'
  $snapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop)
  $protected = New-Object 'System.Collections.Generic.HashSet[int]'
  $appRoots = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($item in $snapshot) {
    $path = ([string]$item.ExecutablePath).Replace('/','\')
    $command = ([string]$item.CommandLine).Replace('/','\')
    if ($path -eq $exe -and $command -notmatch '(?:--type=|\\(?:server\\index\.js|server\\remote\\channel\\iris-channel\.mjs|bin\\iris-mcp\.mjs)(?:[\s"]|$))') {
      [void]$appRoots.Add([int]$item.ProcessId)
    }
    if ($path.StartsWith($herdrDirectory, [StringComparison]::OrdinalIgnoreCase) -or $command.IndexOf($herdrDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $command -match '\\(?:server\\remote\\channel\\iris-channel|bin\\iris-mcp)\.mjs(?:[\s"]|$)') {
      [void]$protected.Add([int]$item.ProcessId)
    }
  }
  # 터미널·MCP 자식 프로세스
  do {
    $added = $false
    foreach ($item in $snapshot) {
      if (!$appRoots.Contains([int]$item.ProcessId) -and $protected.Contains([int]$item.ParentProcessId) -and $protected.Add([int]$item.ProcessId)) { $added = $true }
    }
  } while ($added)
  @($snapshot | Where-Object {
    $path = ([string]$_.ExecutablePath).Replace('/','\')
    $command = ([string]$_.CommandLine).Replace('/','\')
    !$protected.Contains([int]$_.ProcessId) -and (($path -and $path.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase)) -or $command.IndexOf($directory, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or (!$path -and $_.Name -eq 'Iris.exe'))
  })
}
function Test-StateLockHeld([string]$stateLock) {
  $result = Invoke-Tool node @((Join-Path $root 'server\windows-state-lock.cjs'),$stateLock) -capture
  if ($result.ExitCode -notin 0,1) { throw "server.lock 소유자 확인 실패: $($result.Output.Trim())" }
  return $result.ExitCode -eq 1
}
function Stop-InstalledApp([string]$exe, [string]$stateLock, [int]$timeoutMs = 90000) {
  foreach ($item in @(Get-InstalledProcesses $exe)) {
    $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  do {
    $remaining = @(Get-InstalledProcesses $exe)
    $locked = Test-StateLockHeld $stateLock
    if ($remaining.Count -eq 0 -and !$locked) { return }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Iris 앱·서버 종료 또는 server.lock 해제를 확인하지 못했습니다. 프로세스: $($remaining.ProcessId -join ', '), 잠금: $locked ($stateLock). 설치하지 않습니다."
    }
    Start-Sleep -Milliseconds 250
  } while ($true)
}
function Assert-InstalledAppRunning([string]$exe) {
  $main = @(Get-InstalledProcesses $exe | Where-Object {
    $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '(?:--type=|[\\/]server[\\/]index\.js)'
  })
  if (!$main.Count) { throw '새 Iris 앱이 서버 준비 중에 종료되었습니다.' }
}
function Install-WindowsApp([string]$exe, [string]$installerPath, [string]$stateLock) {
  $directory = Split-Path $exe
  $backup = $null
  $hadPrevious = Test-Path -LiteralPath $exe
  $staged = $null
  if ($hadPrevious) {
    $unpacked = Join-Path $root 'dist\win-unpacked'
    if (!(Test-Path -LiteralPath (Join-Path $unpacked 'Iris.exe'))) { throw 'dist\win-unpacked\Iris.exe가 없습니다.' }
    $staged = $directory + '.new-' + [Guid]::NewGuid().ToString('N')
    # 기존 제거 프로그램·바로가기 등록 유지
    Copy-Item -LiteralPath $unpacked -Destination $staged -Recurse
    foreach ($name in @('Uninstall Iris.exe','uninstallerIcon.ico')) {
      $file = Join-Path $directory $name
      if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $staged $name) }
    }
  }
  Stop-InstalledApp $exe $stateLock
  if (Test-Path -LiteralPath $directory) {
    $backup = $directory + '.old-' + [Guid]::NewGuid().ToString('N')
    # 실행 중인 herdr 경로 보존
    try { Move-Item -LiteralPath $directory -Destination $backup }
    catch {
      $failure = $_.Exception.Message
      try {
        if ($hadPrevious) {
          Start-Process -FilePath $exe
          Run-Tool node @((Join-Path $root 'scripts\wait-installed-server.cjs'))
          Assert-InstalledAppRunning $exe
        }
      } catch { throw "이전 앱 백업 실패: $failure / 기존 앱 다시 실행 실패: $($_.Exception.Message). 기존 앱: $directory, 미완성 백업: $backup" }
      throw "이전 앱 백업 실패: $failure. 기존 앱 유지: $directory, 백업: $backup"
    }
  }
  try {
    # 경로 교체 전 살아 있는 이전 프로세스
    $previousProcesses = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop | Where-Object {
      $prefix = $directory.TrimEnd('\') + '\'
      $oldPrefix = if ($backup) { $backup.TrimEnd('\') + '\' } else { $prefix }
      $path = ([string]$_.ExecutablePath).Replace('/','\')
      $command = ([string]$_.CommandLine).Replace('/','\')
      $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $command.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $path.StartsWith($oldPrefix, [StringComparison]::OrdinalIgnoreCase) -or $command.IndexOf($oldPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($staged) {
      Move-Item -LiteralPath $staged -Destination $directory
    } else {
      Write-Host "사용자 계정에 설치합니다: $installerPath"
      $installer = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
      if ($installer.ExitCode -ne 0) { throw "Iris 설치 실패: 종료 코드 $($installer.ExitCode)" }
    }
    if (!(Test-Path -LiteralPath $exe)) { throw "설치된 Iris.exe가 없습니다: $exe" }
    Run-Tool (Join-Path $directory 'resources\herdr\herdr.exe') @('--version')
    Start-Process -FilePath $exe
    Run-Tool node @((Join-Path $root 'scripts\wait-installed-server.cjs'))
    Assert-InstalledAppRunning $exe
  } catch {
    $failure = $_.Exception.Message
    $failed = $directory + '.failed-' + [Guid]::NewGuid().ToString('N')
    try {
      Stop-InstalledApp $exe $stateLock
      # 실패한 설치본 보존
      if (Test-Path -LiteralPath $directory) { Move-Item -LiteralPath $directory -Destination $failed }
      elseif ($staged -and (Test-Path -LiteralPath $staged)) { Move-Item -LiteralPath $staged -Destination $failed }
      if ($backup) {
        Move-Item -LiteralPath $backup -Destination $directory
        $backup = $null
        if ($hadPrevious) {
          Start-Process -FilePath $exe
          Run-Tool node @((Join-Path $root 'scripts\wait-installed-server.cjs'))
          Assert-InstalledAppRunning $exe
        }
      }
    } catch {
      throw "$failure / 이전 앱 복구 실패: $($_.Exception.Message). 이전 앱: $backup, 실패한 설치본: $failed, 설치 폴더: $directory"
    }
    if ($hadPrevious) { throw "$failure / 이전 앱 복구 완료: $directory, 실패한 설치본: $failed" }
    throw "$failure / 실패한 설치본 보존: $failed"
  }
  try {
    $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop)
    $creationDate = @{Name='CreationDate';Expression={ if ($_.CreationDate) { ([DateTime]$_.CreationDate).ToUniversalTime().Ticks.ToString() } }}
    $inputJson = ConvertTo-Json -Depth 4 -Compress -InputObject @{
      previousProcesses = @($previousProcesses | Select-Object ProcessId,$creationDate)
      processes = @($processes | Select-Object ProcessId,$creationDate,ExecutablePath,CommandLine)
    }
    $previousEncoding = $OutputEncoding
    try {
      $OutputEncoding = [Text.UTF8Encoding]::new($false)
      $result = $inputJson | & node (Join-Path $root 'scripts\windows-update-backup.cjs') $directory $backup
      if ($LASTEXITCODE -ne 0) { throw '이전 앱 백업 정리 실패' }
      foreach ($item in ($result | ConvertFrom-Json)) {
        if ($item.status -eq 'removed') { Write-Host "이전 앱 백업 정리: $($item.path)" }
        else { Write-Host "이전 앱 백업 보존: $($item.path) ($($item.status)) $($item.reason)" }
      }
    } finally { $OutputEncoding = $previousEncoding }
  } catch { Write-Warning "새 앱은 준비되었습니다. 이전 앱 백업 정리 실패: $($_.Exception.Message)" }
}
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Iris\Iris.exe'
$mcpPath = Join-Path $root 'bin\iris-mcp.mjs'
Write-Host 'Iris Windows 설치'
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 이상이 필요합니다.' }
$ok = $true
if (!(Find-Tool git) -and !$check) { Install-Winget 'Git.Git' }
if (Find-Tool git) { Write-Host '  OK Git' } else { Write-Warning 'Git 없음'; $ok = $false }
if (!(Node-Ready) -and !$check) { Install-Winget 'OpenJS.NodeJS.LTS' }
if (Node-Ready) { Write-Host '  OK Node.js 22 이상' } else { Write-Warning 'Node.js 22 이상 필요: https://nodejs.org'; $ok = $false }
# Program Files 쓰기 실패 시 사용자 prefix
$pnpmHome = Join-Path $env:LOCALAPPDATA 'Iris\pnpm'
if (Test-Path -LiteralPath (Join-Path $pnpmHome 'pnpm.cmd')) { $env:PATH = $pnpmHome + ';' + $env:PATH }
if (!(Pnpm-Ready) -and !$check -and (Node-Ready)) {
  if (Find-Tool corepack) {
    try { Run-Tool corepack @('enable','pnpm') }
    catch { Write-Warning 'corepack enable 실패. 사용자 계정 설치를 확인합니다.' }
    Refresh-Path
  }
  if (!(Pnpm-Ready) -and (Confirm-Step '사용자 계정에 pnpm 9.12.2를 설치할까요?')) {
    Run-Tool npm @('install','--global','--prefix',$pnpmHome,'pnpm@9.12.2')
    $userPath = [string][Environment]::GetEnvironmentVariable('Path','User')
    if ($pnpmHome -notin @($userPath -split ';')) {
      [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $pnpmHome).TrimStart(';'), 'User')
    }
    $env:PATH = $pnpmHome + ';' + $env:PATH
  }
}
if (Pnpm-Ready) { Write-Host '  OK pnpm 9.2 이상' } else { Write-Warning 'pnpm 9.2 이상 필요'; $ok = $false }
if ($check) {
  if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules')) -or !(Test-Path -LiteralPath (Join-Path $root 'web\vendor'))) { Write-Warning 'pnpm install 필요'; $ok = $false }
  if (!(Test-Path -LiteralPath $exe)) { Write-Warning "설치된 Iris 없음: $exe"; $ok = $false }
  $herdr = Find-Tool herdr
  if (!$herdr) { $herdr = Join-Path (Split-Path $exe) 'resources\herdr\herdr.exe' }
  try { & $herdr --version; if ($LASTEXITCODE -ne 0) { $ok = $false } } catch { Write-Warning 'herdr 없음'; $ok = $false }
  if ((Node-Ready) -and (Test-Path -LiteralPath $exe)) {
    & node (Join-Path $root 'scripts\install-agent-context.mjs') --app $exe --check
    if ($LASTEXITCODE -ne 0) { $ok = $false }
    foreach ($runtime in @('claude','codex')) { if (!(Agent-Mcp $runtime)) { $ok = $false } }
  }
  if (!$ok) { exit 1 }; exit 0
}
if (!$ok) { throw '필요한 도구를 설치한 뒤 setup.cmd를 다시 실행하세요.' }
Run-Tool pnpm @('install','--frozen-lockfile')
Write-Host '앱을 켜 둔 채 새 Windows 앱을 빌드합니다. herdr를 함께 준비합니다.'
Run-Tool pnpm @('dist:win')
$setup = Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter 'Iris Setup *.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$setup) { throw 'dist에 Iris Setup exe가 없습니다.' }
# 설치본 전용 포트·상태
foreach ($name in @('IRIS_PORT','IRIS_STATE_DIR','PORT','REMOTE','HOST','ELECTRON_RUN_AS_NODE')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$state = Invoke-Tool node @('-e', "process.stdout.write(require('./server/state-home.cjs').stateHome())") -capture
if ($state.ExitCode -ne 0 -or !$state.Output.Trim()) { throw '설치 앱 상태 폴더를 확인하지 못했습니다.' }
$stateLock = Join-Path $state.Output.Trim() 'server.lock'
Install-WindowsApp $exe $setup.FullName $stateLock
if (!$appOnly) { foreach ($runtime in @('claude','codex')) { if (!(Agent-Mcp $runtime)) { $ok = $false } } }
$contextArgs = @((Join-Path $root 'scripts\install-agent-context.mjs'),'--app',$exe)
if (!$appOnly -and (Confirm-Step 'Claude Code와 Codex에 세션 기록·지목 등록 훅을 추가할까요?')) { $contextArgs += '--hooks' }
Run-Tool node $contextArgs
Write-Host "설치 완료: $exe"
Write-Host 'Codex 훅을 추가했다면 Codex의 /hooks에서 Iris 훅을 신뢰하세요.'
if (!$ok) { exit 1 }
