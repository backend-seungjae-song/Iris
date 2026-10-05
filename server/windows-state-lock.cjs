const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { windowsPowerShellEnv } = require('./windows-powershell.cjs');

function windowsServerPidState(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  const query = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($null -eq $p) { 'null' } else { $p | Select-Object CommandLine | ConvertTo-Json -Compress }`;
  try {
    const result = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, env: windowsPowerShellEnv(),
    }).trim());
    if (result === null) return 'stale';
    if (typeof result.CommandLine !== 'string' || !result.CommandLine.trim()) return 'unknown';
    const command = result.CommandLine.replaceAll('\\', '/');
    return command.includes('server/index.js') ? 'active' : 'stale';
  } catch { return 'unknown'; }
}

// 설치기의 읽기 전용 잠금 확인
function inspectWindowsStateLock(lockPath, { read = fs.readFileSync, pidState = windowsServerPidState } = {}) {
  let content;
  try { content = read(lockPath, 'utf8').trim(); }
  catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unknown' }; }
  const pid = Number(content);
  if (!/^\d+$/.test(content) || !Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown' };
  return { status: pidState(pid), pid };
}

module.exports = { windowsServerPidState, inspectWindowsStateLock };

if (require.main === module) {
  const result = process.platform === 'win32' && process.argv[2]
    ? inspectWindowsStateLock(process.argv[2]) : { status: 'unknown' };
  console.log(JSON.stringify(result));
  process.exitCode = ['absent', 'stale'].includes(result.status) ? 0 : result.status === 'active' ? 1 : 2;
}
