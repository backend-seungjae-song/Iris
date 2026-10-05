param([Parameter(Mandatory=$true)][string]$Directory, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  # setup 전용 빈 설치 폴더
  if (!$Uninstall -and (Test-Path -LiteralPath (Join-Path $Directory 'Iris.exe'))) {
    throw 'setup.cmd로 업데이트하세요. 기존 설치 폴더를 덮어쓰지 않습니다.'
  }
  $prefix = $Directory.TrimEnd('\') + '\'
  $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop | Where-Object {
    $path = ([string]$_.ExecutablePath).Replace('/','\')
    $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($processes.Count) { throw "설치 폴더에 실행 중인 프로세스가 있습니다: $($processes.ProcessId -join ', ')" }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
exit 0
